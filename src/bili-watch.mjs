/**
 * bili-watch.mjs —— 「认真看 B 站视频」的组合层：认片 → 取直链 → 取关键帧。
 *
 * 为什么单独一层：三段能力分住在三个文件里，各有各的加载约束——
 *   - `bili-media.mjs`  纯 Node（fetch 两个 API），探针可直接 import；
 *   - `kfdecode.mjs`    一进门就 `import { app, BrowserWindow } from 'electron'`，
 *                       **只能在 Electron 主进程里载**，所以这里用动态 import；
 *   - 登录态           `bili-auth.mjs` 的 `cookieHeader()`，由宿主以 `getCookie` 注入。
 *
 * 于是本文件是唯一知道「先 view 再 playurl 再 decode」顺序的地方，brain 只跟它说话。
 *
 * 三条纪律（都有代价，别改）：
 *   1. 直链不缓存：URL 里带 deadline，过期后 `<video>` 静默失败；每次 watch 都重新 playurl。
 *   2. 取帧前必须 `pickReachableUrl`：playurl 的头号 baseUrl 常是 mcdn 节点，本机实测
 *      会 10s 连接超时（备用 upos 镜像能通）；不先探一下就会白等一场超时。
 *   3. 帧数硬上限 8：关键帧是整张原生分辨率图，一次扔太多会把模型上下文灌爆。
 */

import { fetchView, fetchPlayurl, pickReachableUrl, QUALITY_LABEL } from './bili-media.mjs'
import { pickTrack, checkTimeline, subsToText } from './bili-subtitle.mjs'

/** 一次最多给模型看几张图（图片走 user 消息，成本按张算）。 */
export const MAX_FRAMES = 8

/** 没指定看法、也没给帧数时：只回元信息（最便宜）。 */
export const DEFAULT_FRAMES = 6

/** 缺省输出尺寸上限：再大对「看清字幕/画面」没增益，只是白烧 token。 */
export const DEFAULT_MAX_OUT = { w: 960, h: 540 }

/** 字幕正文直接塞进工具结果的字数上限；超了落盘 + 只给前若干行。 */
export const MAX_SUB_CHARS = 12000
/** 落盘时先给模型看多少行（它能自己 read_file 续读）。 */
export const SUB_PREVIEW_LINES = 120

/**
 * 三档看法（2026-10-21 用户拍板：不做菜单让用户选，交给她按余额自己决定；
 * 2026-10-22 补「轻松看」—— 只读字幕，不取一张图）。
 *
 * 为什么不是设计文档里的「雪碧图 A 档」：A 档（160×90）确实更省字节，但它省的是**下载**，
 * 而真正烧钱的是**视觉 token**（与像素数成正比）。按 480×270 出两帧，字节量与 A 档的
 * 六格雪碧图同一量级，文字却清楚得多 —— 同样的钱看到更多东西。
 *
 * 所以：
 *   - 「轻松看」= 0 帧，只把字幕读下来（B 站自带 AI 字幕，覆盖约八成热门片，
 *     **几乎不花钱**：字幕是纯文本，比一张图便宜一个数量级）；
 *   - 「快速看」= 少取两帧 + 缩到 480×270；
 *   - 「认真看」= 多取几帧 + 原生上限。
 * 三者共用同一条取帧/取字幕链路，没有第二套代码路径，也就没有第二套 bug。
 */
export const WATCH_MODES = {
  subtitle: { frames: 0, maxOut: DEFAULT_MAX_OUT, label: '轻松看（读字幕）', subtitles: true },
  quick: { frames: 2, maxOut: { w: 480, h: 270 }, label: '快速看' },
  thorough: { frames: 5, maxOut: { w: 960, h: 540 }, label: '认真看' },
}

/** 把 `args.mode` 认成合法档位名（认不出给空串，交给调用方走默认）。 */
export function parseWatchMode(input) {
  const s = String(input ?? '').trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(WATCH_MODES, s) ? s : ''
}

/**
 * 从各种写法的输入里抠出 BV 号。
 * 支持 `BV1xx411c7mD`、`https://www.bilibili.com/video/BV1xx411c7mD?p=2`、`av80433022`、纯数字。
 * 认不出时两个字段都是 `null`（不是空串 —— 调用方用 `!ref.bvid && !ref.aid` 判空，两者等价，
 * 但空串会顺着 `fetchView({bvid:''})` 一路拼进 URL，变成 `?bvid=` 这种半坏请求）。
 *
 * @param {string} input
 * @returns {{bvid: string|null, aid: number|null}}
 */
export function parseVideoRef(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return { bvid: null, aid: null }
  const bv = raw.match(/BV[0-9A-Za-z]{10}/)
  if (bv) return { bvid: bv[0], aid: null }
  const av = raw.match(/(?:^|\/|av)(\d{3,})/i)
  if (av) return { bvid: null, aid: Number(av[1]) }
  return { bvid: null, aid: null }
}

/** 从 URL 里读 `?p=2`（分 P）；没写就用 fallback（缺省 1）。 */
export function parsePage(input, fallback = 1) {
  const m = String(input ?? '').match(/[?&]p=(\d{1,3})/)
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) && n >= 1 ? n : fallback
}

/**
 * 秒数列表：接受 [12, 30.5] 或 "12,30.5"；过滤非有限值与负数。
 *
 * ★ 必须先把空 token 剔掉再 `Number()`：`Number('')`、`Number(null)`、`Number([])` 都是 0，
 *   而 0 是一个合法秒数。不做这一步的话 `parseTimes(undefined)` 会返回 `[0]`，
 *   于是「只要元信息」的分支被 `times.length` 骗过去，白跑一趟取帧（实测踩过）。
 */
export function parseTimes(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,，\s]+/)
  const out = []
  for (const v of raw) {
    if (v === null || v === undefined) continue
    if (typeof v === 'string' && v.trim() === '') continue
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) out.push(n)
    if (out.length >= MAX_FRAMES) break
  }
  return out
}

/** 把 480P 说成「清晰 480P」这种，优先用接口给的中文名。 */
function qualityText(play) {
  const label = play?.qualityLabel || QUALITY_LABEL[play?.quality] || ''
  return play?.quality ? `${label}（${play.quality}）` : label
}

/**
 * 造一个 watch 函数。
 *
 * @param {object} o
 * @param {() => string} [o.getCookie] 返回 `SESSDATA=…; bili_jct=…` 这样的串（可空）
 * @param {() => object|Promise<object>} [o.getAccount]
 *        登录身份快照 `{loggedIn, uname, mid, vip}`。**必须给**，理由见 watch() 里那段注释：
 *        不给的话模型只能凭画质猜自己有没有登录，实测会猜错并如实告诉用户「没登录你的账号」。
 * @param {Function} [o.log]
 * @param {Function} [o.fetchImpl] 探针可注入假 fetch
 * @param {boolean} [o.probeReachable] 是否先探直链可达（默认 true）
 * @param {object} [o.subtitles] `createBiliSubtitle()` 的实例（取字幕轨/下字幕）
 * @param {Function} [o.saveSubtitle] `(relPath, text) => Promise<{ok, path}>`，长字幕落盘用
 * @returns {{watch: Function, describe: Function}}
 */
export function createBiliWatch({
  getCookie = () => '',
  getAccount = () => null,
  log = () => {},
  fetchImpl,
  probeReachable = true,
  subtitles = null,
  saveSubtitle = null,
} = {}) {
  async function cookie() {
    try {
      return String((await getCookie()) ?? '')
    } catch {
      return ''
    }
  }

  /**
   * 当前登录身份。取不到就当成「未登录」——这是保守方向：
   * 说没登录最多让用户去扫码，说已登录但其实是匿名的才会让她说错话。
   *
   * `verified` = 这份身份**刚向 B 站问过**（nav.isLogin），不是本地文件里的旧值。
   * 用户 2026-10-21 的原话是「它怎么知道自己登录没登录」——答案就是这个字段：
   * 问接口，而不是信一张截图或一句写死的话。
   */
  async function account() {
    let a = null
    try {
      a = await getAccount()
    } catch {
      a = null
    }
    if (!a || typeof a !== 'object') return { loggedIn: false, uname: '', mid: 0, vip: false, verified: false }
    return {
      loggedIn: a.loggedIn === true,
      uname: String(a.uname || ''),
      mid: Number(a.mid || 0),
      vip: a.vip === true,
      verified: a.verified === true,
    }
  }

  /**
   * 一行说清「用谁的身份在看」，并解释画质为什么停在这一档。
   *
   * ★ 为什么要专门处理「说是登录了、却只给到 480P」：`status()` 默认不联网复核，
   *   登录态过期时它仍会回 `loggedIn:true`。这时 playurl 会静默降级成匿名画质 ——
   *   如果正文还一口咬定「用的是你的账号」，就又变成了「说错话」。
   *   所以这里对不上就给一句可执行的提示，而不是让她猜。
   */
  function accountLine(acc, qualityLabel, play) {
    const q = Number(play?.quality || 0)
    const accept = Array.isArray(play?.acceptQuality) ? play.acceptQuality : []
    const couldBeHigher = accept.some((x) => Number(x) > q)
    const looksAnonymous = q > 0 && q <= 32 && couldBeHigher
    // 说清这份身份是「问过 B 站」还是「本地文件里的旧值」——两者可信度不同，别混着说。
    const how = acc.verified ? '刚问过 B 站 nav.isLogin' : '读本地登录态文件，未复核'
    // 「这一趟拿到了什么」：字幕档不取画面，画质无从谈起（别写成「实际给到 ?」）。
    const what = qualityLabel ? `本条实际给到 ${qualityLabel}` : '这一趟不取画面（只读字幕）'

    if (!acc.loggedIn) {
      return `身份：**未登录**（${how}）。匿名最高 480P；要高清/大会员画质，让用户点球上的「设置」扫码登录。`
    }
    const who = acc.uname ? `${acc.uname}${acc.mid ? `（uid ${acc.mid}）` : ''}` : '已登录'
    const tier = acc.vip ? '大会员' : '普通账号'
    const base = `身份：${who} · ${tier}（${how}）—— 这就是用户本人的 B 站账号，${what}。`
    return looksAnonymous
      ? `${base}（这条只到 480P，但接口说有更高档位 —— 多半是登录态过期了，让用户去「设置」里重新扫一次码。）`
      : base
  }

  /**
   * 取一条视频的字幕（「轻松看」的底座）。**永不抛**。
   *
   * 归属校验两道，缺一不可（详见 `bili-subtitle.mjs` 头部注释）：
   *   ① 轨道 URL 里编码的 aid/cid 必须等于这条视频（`verified`）；
   *   ② 核对不了的（新版裸哈希）用**时间轴**兜底：末条远超时长 ⇒ 不是这条的。
   *
   * 长字幕（> MAX_SUB_CHARS）不整段塞进工具结果 —— 落盘到工作区，只贴前若干行，
   * 她需要哪一段自己 `read_file`。这样做的好处：一次「轻松看」通常只花几百 token。
   *
   * @returns {{ok: boolean, summary: string, body: string, tail: string, meta: object}}
   */
  async function readSubtitles(view) {
    if (!subtitles) {
      return { ok: false, summary: '', body: '', tail: '', meta: { ok: false, reason: 'unsupported', error: '这个环境没接上字幕能力' } }
    }
    const t0 = Date.now()
    const tr = await subtitles.tracks({ aid: view.aid, cid: view.cid })
    if (!tr.ok) {
      const why =
        tr.reason === 'all-foreign'
          ? 'B 站把**别的视频**的字幕当成了这条的（服务端错配），这一趟取不到'
          : '这条视频没有字幕轨（B 站只对部分视频提供 AI 字幕）'
      return { ok: false, summary: `没拿到字幕 —— ${why}`, body: '', tail: '', meta: { ok: false, reason: tr.reason, error: tr.error, stats: tr.stats } }
    }
    // 不能盲取第一条：同一个视频两次请求的轨道顺序会变
    const track = pickTrack(tr.tracks)
    if (!track) {
      return { ok: false, summary: '字幕轨都不可用（接口说有，但地址是空的）', body: '', tail: '', meta: { ok: false, reason: 'no-usable-track' } }
    }
    const dl = await subtitles.download(track.url)
    if (!dl.ok) {
      return { ok: false, summary: `字幕下载失败 —— ${dl.error}`, body: '', tail: '', meta: { ok: false, reason: 'download', error: dl.error } }
    }
    const tl = checkTimeline(dl.lines, view.duration)
    if (tl.verdict === 'way-over') {
      return {
        ok: false,
        summary: `拿到的字幕时间轴到 ${Math.round(tl.lastTs)}s，远超视频时长 ${view.duration}s —— 不是这条视频的字幕，已丢弃`,
        body: '',
        tail: '',
        meta: { ok: false, reason: 'timeline-mismatch', lastTs: tl.lastTs, duration: tl.duration },
      }
    }

    const text = subsToText(dl.lines)
    const kind = Number(track.ai) === 0 ? '人工字幕' : 'AI 字幕'
    const verifiedText = tr.verified ? '已核对归属' : '裸哈希地址，按时间轴核对'
    let body = text
    let tail = ''
    const all = text.split('\n')
    if (text.length > MAX_SUB_CHARS) {
      body = all.slice(0, SUB_PREVIEW_LINES).join('\n')
      let saved = ''
      if (typeof saveSubtitle === 'function') {
        const rel = `bili/${view.bvid}-p${view.page || 1}.txt`
        try {
          const r = await saveSubtitle(rel, text)
          if (r?.ok) saved = r.path || rel
        } catch {
          /* 落盘失败不影响她已经拿到的正文 */
        }
      }
      tail = saved
        ? `（字幕共 ${all.length} 行 / ${text.length} 字，太长没全贴 —— 上面是前 ${SUB_PREVIEW_LINES} 行；全文已存进工作区 \`${saved}\`，要哪一段用 read_file 读。）`
        : `（字幕共 ${all.length} 行 / ${text.length} 字，太长只贴了前 ${SUB_PREVIEW_LINES} 行。）`
    }
    const summary =
      `${track.lan || '?'}${track.lanDoc ? `（${track.lanDoc}）` : ''} · ${kind} · ` +
      `${dl.lines.length} 行 / ${text.length} 字 · ${verifiedText}` +
      (tl.verdict === 'slightly-over' ? ` · 末尾比时长多 ${Math.round(tl.lastTs - tl.duration)}s（可接受）` : '')
    log(`[bili] 字幕 aid=${view.aid} cid=${view.cid} → ${dl.lines.length} 行 / ${text.length} 字（${tr.source}，verified=${tr.verified}，${Date.now() - t0}ms）`)
    return {
      ok: true,
      summary,
      body,
      tail,
      meta: {
        ok: true,
        lan: track.lan,
        lanDoc: track.lanDoc,
        ai: track.ai,
        verified: tr.verified,
        source: tr.source,
        lines: dl.lines.length,
        chars: text.length,
        timeline: tl.verdict,
        savedTo: tail && tail.includes('工作区') ? true : false,
        stats: tr.stats,
        elapsedMs: Date.now() - t0,
      },
    }
  }

  /**
   * 看一条视频。
   *
   * 三档都走这一个入口：
   *   · `mode:'subtitle'`（轻松看）—— 不取画面，只读字幕，最省；
   *   · `frames: 0` 且不要字幕 —— 只回元信息（也便宜，但比字幕档信息少）；
   *   · `frames > 0` —— 取关键帧，可选顺带读字幕（`subtitles:true`）。
   *
   * 永不抛：失败折成 `{ok:false, text}`，好让 brain 直接把 text 当工具结果。
   *
   * @param {object} args
   * @param {string} args.url        BV 号 / av 号 / 整条链接
   * @param {number} [args.page]     分 P（不给就从 URL 的 ?p= 读，再不然 1）
   * @param {'subtitle'|'quick'|'thorough'} [args.mode] 看法档位：subtitle=只读字幕 / quick=省（2 帧 480×270）/ thorough=看清（5 帧）
   * @param {boolean} [args.subtitles] 顺带把字幕也读下来（任意档位可叠加；subtitle 档自动为 true）
   * @param {number} [args.frames]   取几帧（0 = 不取，上限 8）。给了就压过 mode 的默认帧数
   * @param {number[]|string} [args.times] 指定秒数（给了就按这些点吸附到最近关键帧）
   * @param {{w:number,h:number}} [args.maxOut]
   * @param {number} [args.quality]  指定画质 id（默认让接口挑最优）
   */
  async function watch(args = {}) {
    const ref = parseVideoRef(args.url)
    if (!ref.bvid && !ref.aid) {
      return { ok: false, text: `看不懂这条视频地址：「${String(args.url ?? '')}」。给 BV 号或整条 bilibili 链接。` }
    }
    const mode = parseWatchMode(args.mode)
    // 分 P 的优先级：模型显式给的 `page` > URL 里的 `?p=` > 1。
    // 反过来的话，模型从一条带 `?p=3` 的链接里说「看第 5 P」会被链接里的 3 悄悄盖掉。
    const askedPage = Number(args.page)
    const page = Number.isFinite(askedPage) && askedPage >= 1 ? Math.floor(askedPage) : parsePage(args.url, 1)
    const cookieHeader = await cookie()
    const acc = await account()

    const view = await fetchView({ bvid: ref.bvid, aid: ref.aid, page, cookieHeader, fetchImpl })
    if (!view.ok) return { ok: false, text: `认片失败：${view.error}` }

    // 「轻松看」= 只读字幕，**连 playurl 都不打**（省一次往返，也不需要画质）。
    // 叠加档（quick/thorough + subtitles:true）才两个都要。
    const subtitleOnly = mode === 'subtitle'
    const wantSubs = subtitleOnly || args.subtitles === true

    const play = subtitleOnly
      ? null
      : await fetchPlayurl({
          bvid: view.bvid,
          aid: view.aid,
          cid: view.cid,
          cookieHeader,
          quality: args.quality,
          fetchImpl,
        })
    if (play && !play.ok) return { ok: false, text: `取播放地址失败：${play.error}` }

    const head = [
      `《${view.title}》${view.pages?.length > 1 ? ` · P${view.page} ${view.pageTitle}` : ''}`,
      play
        ? `时长 ${view.duration}s · ${qualityText(play)} · ${play.video?.width ?? '?'}×${play.video?.height ?? '?'} · ${play.video?.codec ?? '?'}`
        : `时长 ${view.duration}s · 没取画面（轻松看档：只读字幕）`,
      subtitleOnly ? accountLine(acc, '', null) : accountLine(acc, qualityText(play), play),
      `aid ${view.aid} / cid ${view.cid}`,
    ]

    const want = (() => {
      // 帧数的优先级：显式 `frames`（含 0 = 只看元信息）> `mode` 档位 > 0（只回元信息）。
      // ★ 必须判 `undefined` 而不是 `Number(x) || 0`：`frames:0` 是合法且重要的取值，
      //   用 `||` 会把「我要只看元信息」悄悄升级成「取 5 帧」。
      // ★ 字幕档强制 0：那一档的卖点就是「一张图都不取」。
      if (subtitleOnly) return 0
      const raw = args.frames
      if (raw !== undefined && raw !== null && String(raw).trim() !== '' && Number.isFinite(Number(raw))) {
        return Math.min(Math.max(Number(raw), 0), MAX_FRAMES)
      }
      const preset = WATCH_MODES[mode]
      return preset ? preset.frames : 0
    })()
    const maxOut = args.maxOut ?? (WATCH_MODES[mode]?.maxOut || DEFAULT_MAX_OUT)
    const times = parseTimes(args.times)
    const meta = {
      ok: true,
      title: view.title,
      duration: view.duration,
      page: view.page,
      pageTitle: view.pageTitle,
      aid: view.aid,
      bvid: view.bvid,
      cid: view.cid,
      quality: play?.quality ?? null,
      qualityLabel: play ? qualityText(play) : '',
      width: play?.video?.width ?? null,
      height: play?.video?.height ?? null,
      codec: play?.video?.codec ?? '',
      /** 这次用的是谁的身份 —— 让模型说话有据可依，不再靠猜。 */
      account: acc,
      frames: [],
      stats: null,
    }

    // 字幕（字幕档 = 主线；其它档 = 按 `subtitles:true` 叠加）
    let sub = null
    if (wantSubs) {
      sub = await readSubtitles(view)
      meta.subtitles = sub.meta
    }

    if (subtitleOnly) {
      meta.mode = 'subtitle'
      const text = [
        ...head,
        '',
        sub.summary,
        sub.body,
        sub.tail,
        '',
        sub.ok
          ? '以上是这条视频字幕的全部内容（带时间轴）。要画面就用 mode:"quick"；这只是读字，不等于看了画面。'
          : '这一趟只有字幕这一条路，字幕没取到就没有别的可说了 —— 别编内容。',
      ]
        .filter((x) => x !== undefined && x !== null && x !== '')
        .join('\n')
      return { ok: sub.ok, text, meta }
    }

    if (want === 0 && !times.length) {
      meta.mode = 'meta-only'
      const subTail = sub ? ['', sub.summary, sub.body, sub.tail] : []
      return {
        ok: true,
        text: [
          ...head,
          '（没要帧，只看了元信息 —— 这是最省的一档。要看画面：mode:"quick" 两帧 480×270 最便宜，mode:"thorough" 看清细节；有字幕的片子可以 mode:"subtitle" 只读字幕。）',
          ...subTail,
        ].join('\n'),
        meta,
      }
    }

    // 老片只有 durl（整段 mp4），不走稀疏取帧；先把话说清楚。
    if (play.dash === false) {
      return {
        ok: true,
        text: `${head.join('\n')}\n这条是老片（durl 整段流），没有 DASH 分片，取帧需要降级用雪碧图路线。`,
        meta,
      }
    }

    // ★ pickReachableUrl 返回 `{ok, url}`，不是裸字符串（这里曾经把它当字符串用，
    //   结果把 `[object Object]` 一路喂进 extractKeyframes，报「mediaUrl 不是 http(s) 地址」）。
    const reach = await pickReachableUrl(play.video, { cookieHeader, fetchImpl, log })
    if (!reach.ok || !reach.url) {
      return { ok: false, text: `直链都连不上（${reach.error || '无候选'}），稍后再试。` }
    }
    const mediaUrl = reach.url

    let extractKeyframes
    try {
      // 只有这里需要 Electron 上下文；纯 Node 探针走到 `frames:0` 为止不会触发。
      ;({ extractKeyframes } = await import('./kfdecode.mjs'))
    } catch (err) {
      return {
        ok: false,
        text: `取帧模块没载进来（本进程不是 Electron 主进程？）：${String(err?.message || err)}`,
      }
    }

    const t0 = Date.now()
    const got = await extractKeyframes({
      mediaUrl,
      count: want || DEFAULT_FRAMES,
      times: times.length ? times : undefined,
      maxOut,
      cookieHeader,
      log,
    })
    if (!got.ok) return { ok: false, text: `取帧失败：${got.error}` }

    const images = []
    const lines = []
    for (const f of got.frames ?? []) {
      const comma = String(f.dataUrl ?? '').indexOf(',')
      if (comma < 0) continue
      images.push({ mimeType: 'image/jpeg', data: f.dataUrl.slice(comma + 1) })
      lines.push(`- ${Number(f.t).toFixed(2)}s（${f.w}×${f.h}，${Math.round((f.bytes ?? 0) / 1024)}KB）`)
      meta.frames.push({ t: f.t, w: f.w, h: f.h, bytes: f.bytes })
    }
    meta.stats = { ...(got.stats ?? {}), elapsedMs: Date.now() - t0 }

    const s = got.stats ?? {}
    const ratio = Number.isFinite(s.ratio) ? `${(s.ratio * 100).toFixed(1)}%` : '?'
    // 把「这一趟花了多少画面」明写出来：她后面要跟用户解释成本，自己也得有账。
    const shape = `${images.length} 帧 @ ${maxOut.w}×${maxOut.h} 上限`
    const modeLine = mode
      ? `看法：${WATCH_MODES[mode].label}（${shape}）—— 想更省就 subtitle / quick / frames:0，想看清就 thorough。`
      : `看法：按你指定的（${shape}）。`
    const text = [
      ...head,
      modeLine,
      `取了 ${images.length} 张关键帧（只下了整片的 ${ratio}，${((s.bytes ?? 0) / 1048576).toFixed(2)}MB）：`,
      ...lines,
      '画面已作为图片附在下面（同一条消息里，最多 8 张）。',
      ...(sub ? ['', `字幕：${sub.summary}`, sub.body, sub.tail] : []),
    ].join('\n')

    meta.mode = mode || 'custom'
    meta.maxOut = maxOut
    return { ok: true, text, images, meta }
  }

  function describe() {
    return {
      frames: DEFAULT_FRAMES,
      maxFrames: MAX_FRAMES,
      maxOut: DEFAULT_MAX_OUT,
      modes: Object.fromEntries(
        Object.entries(WATCH_MODES).map(([k, v]) => [
          k,
          { frames: v.frames, maxOut: v.maxOut, label: v.label, subtitles: v.subtitles === true },
        ]),
      ),
      /** 字幕能力有没有接上（没接上时 subtitle 档会如实说「取不到」） */
      subtitles: subtitles ? subtitles.describe() : null,
      maxSubChars: MAX_SUB_CHARS,
      probeReachable,
    }
  }

  return { watch, describe }
}
