/**
 * probe/bili-subtitle-unit.mjs · 「轻松看（读字幕）」的纯函数级自检（**不联网、不需要登录**）
 *
 * 为什么要有这一支：字幕这条链最容易出的不是崩溃，而是**静默拿错数据**——
 * B 站老接口会把别的视频的字幕当成这条的还回来（实测 8/8 全错）。所以断言的重点
 * 不是「能拿到字幕」，而是「错的东西一定不许被采用」。
 *
 * 验的九件事：
 *   S1  `trackIdentity` 能从 CDN 路径里解出 aid/cid；裸哈希必须返回 null（不是猜一个）。
 *   S2  轨道分流：自己的 / 别人的 / 核对不了的，三堆不许混。
 *   S3  **反向对照**：只有「别人的」时，一条都不许采用（判 all-foreign，不是「成功」）。
 *   S4  `pickTrack` 人工中文优先，且**不是**取列表第一条（顺序是变的）。
 *   S5  时间轴兜底：末条远超时长 ⇒ way-over（裸哈希唯一的归属判据）。
 *   S6  `subsToText` 的时间轴格式（`[m:ss]` 与 `[h:mm:ss]`）。
 *   S7  `signQuery` 按 key 升序、剔掉 `!'()*`、带 `wts` 与 `w_rid`。
 *   S8  `createBiliSubtitle` 走的是 **`player/wbi/v2`**（带签名），不是老的 `player/v2`。
 *   S9  `bili_watch({mode:'subtitle'})` **一次 playurl 都不打**（那一档的卖点就是不取画面），
 *       且字幕会出现在工具结果正文里；`quick` 档不传 subtitles 时不会去读字幕。
 *
 * 跑法：`node probe\bili-subtitle-unit.mjs`
 */
import {
  trackIdentity,
  splitTracks,
  pickTrack,
  checkTimeline,
  subsToText,
  normalizeSubUrl,
  createBiliSubtitle,
} from '../src/bili-subtitle.mjs'
import { signQuery, mixinKeyOf } from '../src/wbi.mjs'
import { createBiliWatch, WATCH_MODES, parseWatchMode } from '../src/bili-watch.mjs'
import { renderSystemText } from '../src/snapshot.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── S1 归属解码 ───────────────────────────────────────────────────────────
const AID = 31312075
const CID = 54713960
const ownUrl = `//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/${String(AID).padStart(15, '0')}${String(CID).padStart(11, '0')}${'a'.repeat(32)}?auth_key=1-2-3`
const otherUrl = `//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/${String(999999).padStart(15, '0')}${String(888888).padStart(11, '0')}${'b'.repeat(32)}?auth_key=1`
const bareUrl = `//aisubtitle.hdslb.com/bfs/subtitle/abc123def456.json?auth_key=1`

check('S1a 能从 CDN 路径解出 aid/cid', trackIdentity(ownUrl)?.aid === String(AID) && trackIdentity(ownUrl)?.cid === String(CID), JSON.stringify(trackIdentity(ownUrl)))
check('S1b 裸哈希必须返回 null（不许猜一个归属）', trackIdentity(bareUrl) === null, String(trackIdentity(bareUrl)))
check('S1c `//` 开头会补成 https', normalizeSubUrl(ownUrl).startsWith('https://'), normalizeSubUrl(ownUrl).slice(0, 24))

// ── S2 分流 ───────────────────────────────────────────────────────────────
const split = splitTracks(
  [
    { lan: 'ai-zh', url: ownUrl },
    { lan: 'ai-en', url: otherUrl },
    { lan: 'zh-Hans', url: bareUrl },
  ],
  AID,
  CID,
)
check('S2 自己的/别人的/核对不了的分成三堆，不混', split.own.length === 1 && split.foreign.length === 1 && split.bare.length === 1, JSON.stringify({ own: split.own.length, foreign: split.foreign.length, bare: split.bare.length }))

// ── S3 反向对照：全是别人的 ⇒ 不许当成成功 ────────────────────────────────
const onlyForeign = splitTracks([{ lan: 'ai-zh', url: otherUrl }], AID, CID)
check('S3 只有别人的字幕时 own 必须是空的（这是「静默拿错数据」的最后一道闸）', onlyForeign.own.length === 0 && onlyForeign.foreign.length === 1)

// ── S4 挑轨 ───────────────────────────────────────────────────────────────
const shuffled = [
  { lan: 'ai-en', ai: 2, url: bareUrl },
  { lan: 'zh-CN', ai: 0, url: `${ownUrl}&x=1` }, // 人工中文
  { lan: 'ai-zh', ai: 2, url: `${ownUrl}&x=2` },
]
check('S4 pickTrack 取人工中文，不是列表第一条（顺序会变）', pickTrack(shuffled)?.lan === 'zh-CN', pickTrack(shuffled)?.lan)

// ── S5 时间轴兜底 ─────────────────────────────────────────────────────────
const linesShort = subsToTextSample()
function subsToTextSample() {
  return [
    { t: 0, text: 'a' },
    { t: 200, text: 'b' },
  ]
}
check('S5a 末条在时长内 ⇒ ok', checkTimeline(linesShort, 228).verdict === 'ok', JSON.stringify(checkTimeline(linesShort, 228)))
check('S5b 末条超出 60s 以上 ⇒ way-over（裸哈希唯一的判据）', checkTimeline([{ t: 0, text: 'a' }, { t: 900, text: 'b' }], 228).verdict === 'way-over')
check('S5c 只超一点点 ⇒ slightly-over（可用但要提示）', checkTimeline([{ t: 0, text: 'a' }, { t: 250, text: 'b' }], 228).verdict === 'slightly-over')

// ── S6 文本格式 ───────────────────────────────────────────────────────────
check('S6a 一分钟内是 [m:ss]', subsToText([{ t: 65, text: 'x' }]) === '[1:05] x', subsToText([{ t: 65, text: 'x' }]))
check('S6b 超过一小时是 [h:mm:ss]', subsToText([{ t: 3725, text: 'y' }]) === '[1:02:05] y', subsToText([{ t: 3725, text: 'y' }]))

// ── S7 签名 ───────────────────────────────────────────────────────────────
const mk = mixinKeyOf('0123456789abcdefghijklmnopqrstuv', 'ZYXWVUTSRQPONMLKJIHGFEDCBA98765')
const q = signQuery({ cid: 2, aid: 1 }, mk, 1700000000000)
check('S7a 参数按 key 升序（aid 在 cid 前）', q.startsWith('aid=1&cid=2'), q)
check('S7b 带 wts 与 w_rid（32 位 hex）', /&wts=1700000000&w_rid=[0-9a-f]{32}$/.test(q), q)
const q2 = signQuery({ msg: "a!b'c(d)e*f" }, mk, 1700000000000)
check("S7c 值里的 `!'()*` 被剔掉", q2.includes('msg=abcdef'), q2)

// ── 假 fetch：按 URL 路由 ─────────────────────────────────────────────────
const calls = []
function fakeFetch(url) {
  calls.push(String(url))
  const u = String(url)
  let body = { code: 0, data: {} }
  if (u.includes('/x/web-interface/view')) {
    body = {
      code: 0,
      data: {
        aid: AID,
        bvid: 'BV1rW411d7o4',
        cid: CID,
        title: '噪音海洋',
        duration: 228,
        pages: [{ cid: CID, part: '正片', duration: 228 }],
      },
    }
  } else if (u.includes('/x/player/wbi/v2')) {
    body = {
      code: 0,
      data: { subtitle: { subtitles: [{ lan: 'ai-zh', lan_doc: '中文', ai_status: 2, subtitle_url: ownUrl }] } },
    }
  } else if (u.includes('/x/player/v2')) {
    // 老接口：故意返回「别人的字幕」——模拟真实 bug
    body = {
      code: 0,
      data: { subtitle: { subtitles: [{ lan: 'ai-zh', lan_doc: '中文', ai_status: 2, subtitle_url: otherUrl }] } },
    }
  } else if (u.includes('aisubtitle.hdslb.com')) {
    body = { body: [{ from: 0, to: 3, content: '第一句' }, { from: 3, to: 7, content: '第二句' }] }
  } else if (u.includes('/x/player/playurl')) {
    body = { code: -1, message: '这一档不该打 playurl' }
  }
  return Promise.resolve({
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  })
}

// ── S8 走的是签名接口 ────────────────────────────────────────────────────
calls.length = 0
const subs = createBiliSubtitle({ getCookie: () => 'SESSDATA=x', sign: async () => 'aid=1&cid=2&wts=1&w_rid=abc', fetchImpl: fakeFetch, log: () => {} })
const tr = await subs.tracks({ aid: AID, cid: CID })
check('S8a 签名可用时只打 `player/wbi/v2`，一次就够', calls.length === 1 && calls[0].includes('/x/player/wbi/v2'), calls.join(' | '))
check('S8b 签名结果被判定为「已核对归属」', tr.ok === true && tr.verified === true && tr.source === 'wbi', JSON.stringify({ ok: tr.ok, verified: tr.verified, source: tr.source }))

// 反向对照：没有签名器时走老接口，而老接口给的全是别人的 ⇒ 必须判 all-foreign，不许采用
calls.length = 0
const subsNoSign = createBiliSubtitle({ getCookie: () => 'SESSDATA=x', sign: null, fetchImpl: fakeFetch, log: () => {} })
const tr2 = await subsNoSign.tracks({ aid: AID, cid: CID })
check(
  'S8c 反向对照：没有签名、老接口只给别人的字幕 ⇒ 必须 ok:false / all-foreign（不许把别人的字幕当真）',
  tr2.ok === false && tr2.reason === 'all-foreign',
  JSON.stringify({ ok: tr2.ok, reason: tr2.reason, attempts: tr2.stats?.attempts }),
)

// ── S9 watch 集成 ─────────────────────────────────────────────────────────
calls.length = 0
const bili = createBiliWatch({
  getCookie: () => 'SESSDATA=x',
  getAccount: async () => ({ loggedIn: true, uname: 'probe', mid: 1, vip: false, verified: true }),
  fetchImpl: fakeFetch,
  subtitles: subs,
  log: () => {},
})
const r = await bili.watch({ url: 'BV1rW411d7o4', mode: 'subtitle' })
const touchedPlayurl = calls.some((u) => u.includes('/x/player/playurl'))
check('S9a mode:subtitle 一次 playurl 都不打（这一档就是不取画面）', !touchedPlayurl, calls.map((u) => u.replace(/^https:\/\/[^/]+/, '')).join(' | '))
check('S9b 字幕正文进到了工具结果里（带时间轴）', r.ok === true && /\[0:00\] 第一句/.test(r.text), r.ok ? '正文含 [0:00] 第一句' : r.text.slice(0, 80))
check('S9c 元信息里标了「没取画面」而不是画质', /没取画面/.test(r.text) && r.meta.quality === null, String(r.meta.quality))

calls.length = 0
const r2 = await bili.watch({ url: 'BV1rW411d7o4', mode: 'quick' })
check('S9d quick 档不传 subtitles 时**不去读字幕**（别偷偷多花一次请求）', !calls.some((u) => u.includes('/x/player/wbi/v2')), calls.length + ' 次请求')

// ── 档位表本身 ───────────────────────────────────────────────────────────
check('S10a 三档都在，subtitle 档 0 帧', WATCH_MODES.subtitle?.frames === 0 && WATCH_MODES.quick?.frames === 2 && WATCH_MODES.thorough?.frames === 5)
check('S10b `parseWatchMode("subtitle")` 认得（大小写/空格容错）', parseWatchMode('  SUBTITLE ') === 'subtitle', String(parseWatchMode('  SUBTITLE ')))

// ── S11 指南真的要能渲染出来（历史教训：工具给了、指南没提 ⇒ 她照样说做不到） ──
const sysText = renderSystemText({
  persona: '你是球。',
  memoryText: '记忆',
  indexLines: [],
  web: false,
  bili: true,
  balance: false,
})
check('S11a system prompt 正文里有「轻松看」这一档', /轻松看/.test(sysText) && /mode:"subtitle"/.test(sysText))
check('S11b 正文里点明「字幕是文字稿，不等于画面」', /字幕是文字稿/.test(sysText))
check('S11c 正文里写了长字幕会落盘到工作区（否则她不知道去哪续读）', /bili\/<BV号>/.test(sysText))

console.log('')
console.log(`汇总：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
