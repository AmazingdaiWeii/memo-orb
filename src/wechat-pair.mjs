/**
 * 微信扫码配对（iLink / ClawBot）—— 纯逻辑层，不碰 Electron、不写盘。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 * 原来配对靠 DSH（DeepSeek Harness）上的 `dsh-omni-bridge` 插件：那个插件里有一页
 * 「扫码登录」，扫完把 botToken / botId / userId 写进 `~/.dsh/omni-bridge-config.json`，
 * 本程序首次启动再把它迁过来。**这条链对没有装 DSH 的用户是断的** ——
 * 开源版默认用户没 DSH，他们打开设置只会看到三个空框，不知道 token 从哪来。
 *
 * 所以这里把插件里那两个接口原样搬过来，让「怎么拿到 token」变成程序里的一步。
 *
 * ── 协议（取证自 dsh-omni-bridge 0.3.0 的 lib/index.js:944-945）───────
 *
 *   GET {host}/ilink/bot/get_bot_qrcode?bot_type=3
 *     → { ret:0, qrcode:"<32位hex>", qrcode_img_content:"https://liteapp.weixin.qq.com/q/…" }
 *
 *   GET {host}/ilink/bot/get_qrcode_status?qrcode=<qrcode>
 *     头：iLink-App-ClientVersion: 1
 *     → { ret:0, status:"expired" }                       没扫 / 过期
 *     → { ret:0, status:"…", bot_token, ilink_bot_id, ilink_user_id, baseurl }   配好了
 *
 * ★ **`qrcode_img_content` 是一个短链，不是图片、不是 base64**（2026-10-22 实测）。
 *   所以二维码要我们自己画：把这个短链整串编码成 QR，微信扫开就是配对页。
 *   本项目的 `src/qr.mjs` 已经在给 B 站扫码画图，直接复用，不引依赖。
 *
 * ★ **判定「配好了」只看 `bot_token` 非不空**，不看 `status` 的字符串值。
 *   理由：`status` 的取值域没有文档（实测见过 `expired`；未扫码时接口可能回**空 body**），
 *   拿它做判断等于把成败押在一个猜出来的枚举上。而 `bot_token` 有就是有 —— 这是数据，不是约定。
 *   同理：**已知只有 `expired` 算失败**，其余一切（空 body / 未知 status / 网络抖动）都算 `waiting`，
 *   让前端继续等。宁可多轮一次，也不要因为一个没见过的 status 就把用户的扫码作废。
 *
 * ★ 本模块**不落盘、不重启桥**。配对成功只是把凭据交回去，写 `data/wechat.json`
 *   与重建桥归 `main.mjs`（那里才知道 bridge 实例在哪）。
 */

import { qrSvg } from './qr.mjs'

/** 配对服务。与 `wechat.mjs` 的 `DEFAULT_BASE_URL` 同一个域，但这是**配对**入口，不是收发入口。 */
export const PAIR_HOST = 'https://ilinkai.weixin.qq.com'

/** 机器人类型。3 = 个人微信 ClawBot（抄现成实现的取值）。 */
export const QR_BOT_TYPE = 3

/** 二维码有效期。实测过期后接口回 `status:"expired"`，前端据此提示「重新获取」。 */
export const QR_TTL_MS = 5 * 60 * 1000

/** 查状态要带这个头，抄现成实现。缺了可能拿不到结果。 */
export const PAIR_HEADERS = { 'iLink-App-ClientVersion': '1' }

/** 单次 HTTP 超时。配对接口都在国内，15s 足够；卡住不如让用户重点一次。 */
const HTTP_TIMEOUT_MS = 15_000

/**
 * @param {object} deps
 * @param {Function} [deps.fetchImpl] 注入用（探针替身），默认全局 fetch
 * @param {Function} [deps.log]
 * @param {Function} [deps.now]
 */
export function createWechatPair({ fetchImpl, log = () => {}, now = Date.now } = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (...a) => fetch(...a)

  async function getJson(url, headers) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS)
    try {
      const res = await doFetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'orb-desktop', ...headers },
        signal: ctrl.signal,
      })
      const text = await res.text()
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
      // 未扫码时接口可能回空 body（实测）。空不算错，交给调用方当 waiting。
      if (text.trim() === '') return { ok: true, json: {} }
      try {
        return { ok: true, json: JSON.parse(text) }
      } catch {
        return { ok: false, error: '返回不是 JSON' }
      }
    } catch (err) {
      const msg = err?.name === 'AbortError' ? '请求超时' : String(err?.message ?? err)
      return { ok: false, error: msg }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 取一张新二维码。
   * @returns {Promise<{ok:true, qrcodeKey:string, url:string, svg:string, expiresAt:number}
   *                  | {ok:false, error:string}>}
   */
  async function start() {
    const r = await getJson(`${PAIR_HOST}/ilink/bot/get_bot_qrcode?bot_type=${QR_BOT_TYPE}`)
    if (!r.ok) return { ok: false, error: r.error }
    const j = r.json ?? {}
    if (j.ret !== undefined && j.ret !== 0) return { ok: false, error: `ret=${j.ret}` }
    const qrcodeKey = String(j.qrcode ?? '').trim()
    if (qrcodeKey === '') return { ok: false, error: '接口没给 qrcode' }
    // qrcode_img_content 是短链；万一将来换成 data: 图片，也照原样交给前端。
    const url = String(j.qrcode_img_content ?? '').trim()
    if (url === '') return { ok: false, error: '接口没给二维码内容' }

    let svg = ''
    if (/^https?:\/\//i.test(url)) {
      svg = qrSvg(url, { scale: 5, margin: 2, dark: '#111111', light: '#ffffff' })
    }
    log(`[wechat] 配对二维码已生成（${qrcodeKey.slice(0, 8)}…，有效期 ${Math.round(QR_TTL_MS / 1000)}s）`)
    return { ok: true, qrcodeKey, url, svg, expiresAt: now() + QR_TTL_MS }
  }

  /**
   * 查一次状态。**前端每 2 秒调一次**，直到 confirmed / expired。
   *
   * @returns {Promise<{ok:true, state:'waiting'|'scanned'|'confirmed'|'expired',
   *                    creds?:{botToken:string,botId:string,userId:string,baseUrl:string}}
   *                  | {ok:false, error:string, state?:string}>}
   */
  async function poll(qrcodeKey) {
    const key = String(qrcodeKey ?? '').trim()
    if (key === '') return { ok: false, error: '缺少 qrcode', state: 'error' }

    const r = await getJson(
      `${PAIR_HOST}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(key)}`,
      PAIR_HEADERS
    )
    if (!r.ok) return { ok: false, error: r.error, state: 'error' }

    const j = r.json ?? {}
    const botToken = String(j.bot_token ?? '').trim()

    // ① 有 token 就是成了 —— 唯一可信的成功判据（理由见文件头）
    if (botToken !== '') {
      const creds = {
        botToken,
        botId: String(j.ilink_bot_id ?? j.bot_id ?? ''),
        userId: String(j.ilink_user_id ?? ''),
        baseUrl: String(j.baseurl ?? ''),
      }
      log(`[wechat] 配对成功（配对 id=${creds.botId || '未给'}，主人=${creds.userId || '未知'}）`)
      return { ok: true, state: 'confirmed', creds }
    }

    const status = String(j.status ?? '').trim()
    // ② 唯一已知的失败态。别的都不许当失败 —— 见文件头那条「宁可多轮一次」。
    if (status === 'expired') return { ok: true, state: 'expired' }
    if (status === 'scanned' || status === 'scaned') return { ok: true, state: 'scanned' }
    return { ok: true, state: 'waiting' }
  }

  return { start, poll, describe: () => `配对：${PAIR_HOST}（bot_type=${QR_BOT_TYPE}）` }
}
