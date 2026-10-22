#!/usr/bin/env node
/**
 * 微信扫码配对 · 纯逻辑单测（不打网络）。
 *
 * 守的是 `src/wechat-pair.mjs` 里那几条「看起来像小事、错了就很难查」的判断：
 *   · 成功判据**只看 `bot_token`**，不猜 `status` 的字符串值（取值域没有文档）；
 *   · 已知只有 `expired` 算失败 —— 空 body / 没见过的 status 一律当 `waiting`，
 *     否则用户正在扫码时因为一个没见过的枚举值，码就白扫了；
 *   · `qrcode_img_content` 是**短链**（2026-10-22 实测），要自己画成二维码；
 *   · botId 兼容 `ilink_bot_id` / `bot_id` 两种键名。
 *
 * 跑法：node probe/wechat-pair-unit.mjs
 */
import { createWechatPair, PAIR_HOST, QR_BOT_TYPE, PAIR_HEADERS } from '../src/wechat-pair.mjs'

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`PASS ${name}`)
    return
  }
  failed += 1
  console.log(`FAIL ${name}${detail ? `  —— ${detail}` : ''}`)
}

/** 造一个假 fetch：handler 回 `{ status?, body? }` 或直接 throw。 */
function fakeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, opts) => {
    const u = String(url)
    calls.push({ url: u, opts })
    const r = handler(u, opts)
    if (r instanceof Error) throw r
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => r.body ?? '',
    }
  }
  return { fetchImpl, calls }
}

const json = (obj) => ({ body: JSON.stringify(obj) })

/* ── 1. start：正常路径 ─────────────────────────────────────────────── */
{
  const { fetchImpl, calls } = fakeFetch(() =>
    json({ ret: 0, qrcode: 'abc123def456', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/XXXX?qrcode=abc123def456&bot_type=3' })
  )
  const pair = createWechatPair({ fetchImpl })
  const r = await pair.start()

  check('1a start 成功：拿回 qrcodeKey', r.ok === true && r.qrcodeKey === 'abc123def456', JSON.stringify(r).slice(0, 200))
  check('1b start 成功：带回短链 url', r.ok === true && /liteapp\.weixin\.qq\.com/.test(r.url), r.url)
  check(
    '1c ★ qrcode_img_content 是短链 ⇒ 自己画成 SVG（不是当成图片地址塞给 img）',
    r.ok === true && typeof r.svg === 'string' && r.svg.startsWith('<svg') && r.svg.includes('</svg>'),
    String(r.svg).slice(0, 80)
  )
  check('1d 带回有效期 expiresAt', r.ok === true && Number.isFinite(r.expiresAt) && r.expiresAt > Date.now())
  check(
    '1e 打的是 get_bot_qrcode?bot_type=3',
    calls.length === 1 && calls[0].url === `${PAIR_HOST}/ilink/bot/get_bot_qrcode?bot_type=${QR_BOT_TYPE}`,
    calls[0]?.url
  )
}

/* ── 2. start：各种失败都要是 ok:false + 人话 error ─────────────────── */
{
  const cases = [
    ['2a ret!=0 → 失败', { ret: 5 }, /ret=5/],
    ['2b 缺 qrcode → 失败', { ret: 0, qrcode_img_content: 'https://x/y' }, /qrcode/],
    ['2c 缺 qrcode_img_content → 失败', { ret: 0, qrcode: 'abc' }, /二维码内容/],
  ]
  for (const [name, body, re] of cases) {
    const { fetchImpl } = fakeFetch(() => json(body))
    const r = await createWechatPair({ fetchImpl }).start()
    check(name, r.ok === false && re.test(String(r.error)), JSON.stringify(r))
  }

  const { fetchImpl: boom } = fakeFetch(() => new Error('ECONNREFUSED'))
  const r = await createWechatPair({ fetchImpl: boom }).start()
  check('2d 网络异常 → 失败且 error 是人话', r.ok === false && /ECONNREFUSED/.test(String(r.error)), JSON.stringify(r))

  const { fetchImpl: http500 } = fakeFetch(() => ({ status: 502, body: '' }))
  const r2 = await createWechatPair({ fetchImpl: http500 }).start()
  check('2e HTTP 502 → 失败且 error 带状态码', r2.ok === false && /502/.test(String(r2.error)), JSON.stringify(r2))
}

/* ── 3. poll：成功判据 ─────────────────────────────────────────────── */
{
  const { fetchImpl, calls } = fakeFetch(() =>
    json({
      ret: 0,
      status: 'confirmed',
      bot_token: 'tok_abc',
      ilink_bot_id: 'bot_42',
      ilink_user_id: 'user_7',
      baseurl: 'https://ilinkai.weixin.qq.com',
    })
  )
  const r = await createWechatPair({ fetchImpl }).poll('abc123')

  check('3a poll 拿到 bot_token ⇒ confirmed', r.ok === true && r.state === 'confirmed', JSON.stringify(r))
  check(
    '3b creds 四个字段齐全（botToken/botId/userId/baseUrl）',
    r.creds?.botToken === 'tok_abc' && r.creds?.botId === 'bot_42' && r.creds?.userId === 'user_7' && r.creds?.baseUrl === 'https://ilinkai.weixin.qq.com',
    JSON.stringify(r.creds)
  )
  check(
    '3c 查状态带 iLink-App-ClientVersion 头（抄现成实现，缺了可能拿不到结果）',
    calls[0]?.opts?.headers?.['iLink-App-ClientVersion'] === PAIR_HEADERS['iLink-App-ClientVersion'],
    JSON.stringify(calls[0]?.opts?.headers)
  )
  check(
    '3d qrcode 被 URL 编码进查询串',
    calls[0]?.url === `${PAIR_HOST}/ilink/bot/get_qrcode_status?qrcode=abc123`,
    calls[0]?.url
  )
}

/* ── 4. ★ 反向对照：没有 token 时，status 说什么都不算成 ────────────── */
{
  const { fetchImpl } = fakeFetch(() => json({ ret: 0, status: 'confirmed' }))
  const r = await createWechatPair({ fetchImpl }).poll('abc')
  check(
    '4a ★ 只有 status="confirmed" 但没有 bot_token ⇒ **不是** confirmed（判据是 token，不是字符串）',
    r.ok === true && r.state !== 'confirmed',
    JSON.stringify(r)
  )

  const { fetchImpl: f2 } = fakeFetch(() => json({ ret: 0, status: 'scanned' }))
  const r2 = await createWechatPair({ fetchImpl: f2 }).poll('abc')
  check('4b 中间态 scanned → state=scanned（界面能提示「在手机上点确认」）', r2.state === 'scanned', JSON.stringify(r2))
}

/* ── 5. ★ 空 body / 未知 status 一律 waiting（绝不能把用户的码作废） ── */
{
  const variants = [
    ['5a ★ 空 body（实测未扫码时会这样）⇒ waiting', ''],
    ['5b 未知 status ⇒ waiting', JSON.stringify({ ret: 0, status: 'whatever_new_enum' })],
    ['5c 只有 ret ⇒ waiting', JSON.stringify({ ret: 0 })],
  ]
  for (const [name, body] of variants) {
    const { fetchImpl } = fakeFetch(() => ({ body }))
    const r = await createWechatPair({ fetchImpl }).poll('abc')
    check(name, r.ok === true && r.state === 'waiting', JSON.stringify(r))
  }

  const { fetchImpl } = fakeFetch(() => json({ ret: 0, status: 'expired' }))
  const r = await createWechatPair({ fetchImpl }).poll('abc')
  check('5d 唯一已知的失败态 expired', r.ok === true && r.state === 'expired', JSON.stringify(r))
}

/* ── 6. poll 的失败分支 ────────────────────────────────────────────── */
{
  const { fetchImpl: http500 } = fakeFetch(() => ({ status: 500, body: '' }))
  const r = await createWechatPair({ fetchImpl: http500 }).poll('abc')
  check('6a HTTP 500 ⇒ ok:false + state:error（前端据此停轮询）', r.ok === false && r.state === 'error', JSON.stringify(r))

  const { fetchImpl: badJson } = fakeFetch(() => ({ body: '<html>502</html>' }))
  const r2 = await createWechatPair({ fetchImpl: badJson }).poll('abc')
  check('6b 返回不是 JSON ⇒ ok:false', r2.ok === false, JSON.stringify(r2))

  const { fetchImpl: noKey } = fakeFetch(() => json({ ret: 0 }))
  const r3 = await createWechatPair({ fetchImpl: noKey }).poll('')
  check('6c 空 qrcodeKey ⇒ 直接拒绝，不发请求', r3.ok === false && /qrcode/.test(String(r3.error)), JSON.stringify(r3))
}

/* ── 7. botId 键名兼容 ─────────────────────────────────────────────── */
{
  const { fetchImpl } = fakeFetch(() => json({ ret: 0, bot_token: 'tok', bot_id: 'legacy_id', ilink_user_id: 'u1' }))
  const r = await createWechatPair({ fetchImpl }).poll('abc')
  check('7a botId 兼容 `bot_id`（老键名）', r.creds?.botId === 'legacy_id', JSON.stringify(r.creds))
}

/* ── 8. describe ───────────────────────────────────────────────────── */
{
  const pair = createWechatPair({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' }) })
  check('8a describe 说清打哪个 host', /ilinkai\.weixin\.qq\.com/.test(pair.describe()), pair.describe())
}

console.log('='.repeat(60))
console.log(`通过 ${passed} / 失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
