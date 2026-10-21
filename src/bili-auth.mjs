/**
 * bili-auth.mjs —— B 站**扫码**登录（不做账号密码）。
 *
 * 形态：设置抽屉里点「扫码登录」→ 宿主去 passport 要一张二维码 →
 * 抽屉里画出二维码 → 用户用 B 站手机客户端「扫一扫」并确认 → 轮询拿到
 * SESSDATA / bili_jct / DedeUserID → 落 `data/bili-auth.json` → 立刻调 nav
 * 取昵称头像确认这串 cookie 真的能用。
 *
 * 三条纪律（都是踩过或算得出来的）：
 *   1. **cookie 一律不写日志、不进返回值以外的字符串**。日志只记 mid / uname。
 *   2. 凭据文件必须进 `data/policy.json` 的 `read.deny`（`**\/bili-auth.json`），
 *      否则 agent 的 read_file 就能把登录态读走。
 *   3. 本模块**不 import electron**：playurl、取帧、探针都要能在纯 Node 里跑。
 *      二维码自己画（`./qr.mjs`），不走任何第三方服务 —— 那是把一次性登录凭据送外人。
 *
 * 接口约定：`createBiliAuth({dataRoot, log, now, fetchImpl})` 返回
 *   { status, start, poll, logout, cookieHeader, describe, file }
 * 所有方法**永不抛**：失败走 `{ ok:false, error }`，界面据此写状态栏。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { qrSvg } from './qr.mjs'
import { API_HOST, MEDIA_REFERER, PASSPORT_HOST, QR_SOURCE, biliHeaders } from './bili-const.mjs'

/** 凭据文件名（在 dataRoot 下）。 */
export const BILI_AUTH_FILE = 'bili-auth.json'

/** 二维码有效期。B 站给 180 秒，超时后 poll 回 86038。 */
export const QR_TTL_MS = 180_000

/** 登录态自己给的保守寿命。B 站 SESSDATA 实际约半年，到期后 poll/nav 会报 -101。 */
export const SESSION_MAX_AGE_MS = 180 * 24 * 3600 * 1000

/** 单个请求的上限。passport 偶尔很慢，超过这个就当网络问题。 */
const REQUEST_TIMEOUT_MS = 10_000

/** poll 回来的业务码 → 界面状态。 */
export const POLL_STATES = {
  0: 'confirmed',
  86101: 'waiting',
  86090: 'scanned',
  86038: 'expired',
}

/** 登录 cookie 只需要这几个键（其余是埋点/风控用的，带上反而容易过期不一致）。 */
const COOKIE_KEYS = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function readJsonSafe(file, log) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    const broken = `${file}.broken-${Date.now()}`
    try {
      renameSync(file, broken)
    } catch {
      /* 改名失败就算了，下面返回 null */
    }
    log?.(`[bili] ${file} 解析失败（${err.message}），已改名 ${broken}，这次当未登录`)
    return null
  }
}

/** 写用 tmp + rename，和 wechat.mjs / schedule.mjs 同一套 —— 用户在盘上能看见、能手改。 */
function writeJsonAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/** 把 Set-Cookie 数组压成 `k=v; k=v`。 */
function cookieFromSetCookie(headers) {
  const pairs = new Map()
  for (const raw of headers) {
    const first = String(raw).split(';')[0]
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    if (!COOKIE_KEYS.includes(name)) continue
    pairs.set(name, first.slice(eq + 1).trim())
  }
  return pairs
}

/**
 * 成功那一跳的 `data.url` 里带着全套 cookie 的明文 query，比 Set-Cookie 好解析
 * （实测登录成功时两者都在，这里两个都收，url 优先）。
 */
function cookieFromLoginUrl(rawUrl) {
  const pairs = new Map()
  if (!rawUrl) return pairs
  let u
  try {
    u = new URL(rawUrl)
  } catch {
    return pairs
  }
  for (const key of COOKIE_KEYS) {
    const v = u.searchParams.get(key)
    if (v) pairs.set(key, v)
  }
  return pairs
}

function joinCookie(pairs) {
  return COOKIE_KEYS.filter((k) => pairs.has(k))
    .map((k) => `${k}=${pairs.get(k)}`)
    .join('; ')
}

/**
 * 把「登录成功那一跳」的 `data.url` 与 `Set-Cookie` 合成一整串 Cookie 头。
 *
 * 单独导出是为了能在纯 Node 里对拍（真登录要人扫二维码，探针没法自动跑完）。
 * `url` 里的 query 优先 —— 实测它与 Set-Cookie 一致，但前者不需要处理 Path/Expires 之类的尾巴。
 */
export function parseLoginCookie(rawUrl, setCookieList = []) {
  const pairs = new Map([...cookieFromLoginUrl(rawUrl), ...cookieFromSetCookie(setCookieList)])
  return joinCookie(pairs)
}

// ---------------------------------------------------------------------------
// 主对象
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {string} o.dataRoot       凭据落地目录（与 wechat.json / providers/ 同一个根）
 * @param {(msg: string) => void} [o.log]
 * @param {() => number} [o.now]
 * @param {typeof fetch} [o.fetchImpl]
 */
export function createBiliAuth(o = {}) {
  const dataRoot = o.dataRoot
  if (!dataRoot) throw new Error('createBiliAuth 需要 dataRoot')
  const log = typeof o.log === 'function' ? o.log : () => {}
  const now = typeof o.now === 'function' ? o.now : Date.now
  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : fetch

  const file = join(dataRoot, BILI_AUTH_FILE)
  let creds = null
  let loaded = false

  function load() {
    if (loaded) return creds
    loaded = true
    const raw = readJsonSafe(file, log)
    if (!raw || typeof raw !== 'object') return (creds = null)
    const cookie = typeof raw.cookie === 'string' ? raw.cookie.trim() : ''
    if (!cookie) return (creds = null)
    creds = {
      savedAt: Number(raw.savedAt) || 0,
      expiresAt: Number(raw.expiresAt) || 0,
      mid: String(raw.mid || ''),
      uname: String(raw.uname || ''),
      avatar: String(raw.avatar || ''),
      vip: !!raw.vip,
      cookie,
    }
    return creds
  }

  function reload() {
    loaded = false
    return load()
  }

  async function request(url, extra = {}) {
    const headers = biliHeaders({ cookie: extra.cookie || '' })
    if (extra.referer) headers.Referer = extra.referer
    const res = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(extra.timeoutMs ?? REQUEST_TIMEOUT_MS),
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error(`接口返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`)
    }
    return { json, res }
  }

  /** 用当前 cookie 问一次 nav：code 0 且 isLogin 才算真的登录着。 */
  async function fetchNav(cookie) {
    const { json } = await request(`${API_HOST}/x/web-interface/nav`, { cookie })
    const d = json?.data
    if (json?.code !== 0 || !d?.isLogin) return { ok: false, error: json?.message || '未登录' }
    return {
      ok: true,
      mid: String(d.mid ?? ''),
      uname: String(d.uname ?? ''),
      avatar: String(d.face ?? ''),
      vip: !!d.vipStatus,
    }
  }

  function snapshot(extra = {}) {
    const c = load()
    const t = now()
    const savedAt = c?.savedAt || 0
    const expiresAt = c?.expiresAt || (savedAt ? savedAt + SESSION_MAX_AGE_MS : 0)
    const expired = !!c && expiresAt > 0 && t > expiresAt
    const loggedIn = !!c && !expired
    return {
      ok: true,
      file,
      loggedIn,
      mid: c?.mid || '',
      uname: c?.uname || '',
      avatar: c?.avatar || '',
      vip: !!c?.vip,
      savedAt,
      expiresAt,
      expired,
      description: loggedIn
        ? `已登录：${c.uname || '（未取到昵称）'}${c.mid ? `（UID ${c.mid}）` : ''}`
        : expired
          ? '登录已过期，重新扫一次即可'
          : `未登录（扫码成功后写入 ${file}）`,
      ...extra,
    }
  }

  /**
   * 当前登录态。`verify:true` 会额外问一次 nav 确认 cookie 还有效
   *（抽屉打开时用；每轮对话都调就别开，白多一次网络）。
   */
  async function status(opts = {}) {
    try {
      const base = snapshot()
      if (!base.loggedIn || opts.verify !== true) return base
      const nav = await fetchNav(load().cookie)
      if (!nav.ok) {
        return { ...base, loggedIn: false, stale: true, description: '登录态已失效，重新扫一次即可', error: nav.error }
      }
      // nav 能通就顺手刷新昵称/头像：用户可能改过名。
      if (nav.uname !== creds.uname || nav.avatar !== creds.avatar || nav.mid !== creds.mid) {
        creds = { ...creds, mid: nav.mid || creds.mid, uname: nav.uname || creds.uname, avatar: nav.avatar || creds.avatar, vip: nav.vip }
        writeJsonAtomic(file, serialize(creds))
      }
      return { ...snapshot(), loggedIn: true, stale: false }
    } catch (err) {
      return { ...snapshot(), ok: false, error: String(err?.message || err) }
    }
  }

  function serialize(c) {
    return {
      savedAt: c.savedAt,
      expiresAt: c.expiresAt,
      mid: c.mid,
      uname: c.uname,
      avatar: c.avatar,
      vip: !!c.vip,
      cookie: c.cookie,
    }
  }

  /**
   * 取一张新二维码。返回 `{ok, qrcodeKey, url, svg, expiresAt}`。
   * `svg` 直接塞进抽屉（`./qr.mjs` 画的，零依赖、不涉及任何第三方图床）。
   */
  async function start() {
    try {
      const { json } = await request(
        `${PASSPORT_HOST}/x/passport-login/web/qrcode/generate?source=${encodeURIComponent(QR_SOURCE)}`,
      )
      if (json?.code !== 0 || !json?.data?.url || !json?.data?.qrcode_key) {
        return { ok: false, error: json?.message || `取二维码失败（code ${json?.code}）` }
      }
      const url = String(json.data.url)
      const qrcodeKey = String(json.data.qrcode_key)
      const svg = qrSvg(url, { scale: 5, margin: 2, dark: '#111111', light: '#ffffff' })
      log('[bili] 已取到登录二维码（180 秒内有效）')
      return { ok: true, qrcodeKey, url, svg, expiresAt: now() + QR_TTL_MS }
    } catch (err) {
      return { ok: false, error: `取二维码失败：${String(err?.message || err)}` }
    }
  }

  /**
   * 轮询一次。成功时落盘并返回用户信息；失败不抛。
   *
   * 注意：**成功那一刻 `data.url` 里的 cookie 就是最终登录态**，不要再去
   * `session.cookies` 捞 —— Electron 的 cookie jar 要等一次页面导航才会同步。
   */
  async function poll(qrcodeKey) {
    if (!qrcodeKey) return { ok: false, error: '缺少 qrcodeKey' }
    try {
      const { json, res } = await request(
        `${PASSPORT_HOST}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}&source=${encodeURIComponent(QR_SOURCE)}`,
      )
      if (json?.code !== 0) {
        return { ok: false, state: 'error', error: json?.message || `poll 失败（code ${json?.code}）` }
      }
      const data = json.data || {}
      const state = POLL_STATES[data.code] ?? 'error'
      if (state === 'waiting') return { ok: true, state }
      if (state === 'scanned') return { ok: true, state }
      if (state === 'expired') return { ok: true, state, message: data.message || '二维码已失效' }
      if (state !== 'confirmed') {
        return { ok: false, state: 'error', error: data.message || `未知状态码 ${data.code}` }
      }

      const pairs = new Map([...cookieFromLoginUrl(data.url), ...cookieFromSetCookie(res.headers.getSetCookie?.() ?? [])])
      const cookie = joinCookie(pairs)
      if (!cookie || !pairs.has('SESSDATA')) {
        return { ok: false, state: 'error', error: '登录成功但没拿到 SESSDATA（B 站改了返回格式？）' }
      }

      let nav = { ok: false }
      try {
        nav = await fetchNav(cookie)
      } catch (err) {
        log(`[bili] 登录成功但 nav 校验失败（照存）：${String(err?.message || err)}`)
      }

      const savedAt = now()
      creds = {
        savedAt,
        expiresAt: savedAt + SESSION_MAX_AGE_MS,
        mid: nav.ok ? nav.mid : String(pairs.get('DedeUserID') || ''),
        uname: nav.ok ? nav.uname : '',
        avatar: nav.ok ? nav.avatar : '',
        vip: nav.ok ? nav.vip : false,
        cookie,
      }
      writeJsonAtomic(file, serialize(creds))
      loaded = true
      // 日志只说「谁登录了」，不出现 cookie 的任何片段。
      log(`[bili] 扫码登录成功：${creds.uname || '（昵称未取到）'} UID ${creds.mid || '?'} → ${file}`)
      return { ok: true, state: 'confirmed', user: { mid: creds.mid, uname: creds.uname, avatar: creds.avatar, vip: creds.vip }, savedAt }
    } catch (err) {
      return { ok: false, state: 'error', error: `轮询失败：${String(err?.message || err)}` }
    }
  }

  /** 退出登录：删掉本地凭据（B 站那边的 session 由用户自己在客户端管理）。 */
  async function logout() {
    try {
      if (existsSync(file)) unlinkSync(file)
    } catch (err) {
      return { ok: false, error: `删除凭据失败：${String(err?.message || err)}` }
    }
    creds = null
    loaded = true
    log(`[bili] 已退出登录（删除 ${file}）`)
    return { ok: true }
  }

  /** 给媒体/接口用的 `Cookie` 头。未登录或已过期一律空串。 */
  function cookieHeader() {
    const s = snapshot()
    if (!s.loggedIn) return ''
    return load()?.cookie || ''
  }

  function describe() {
    return snapshot().description
  }

  return { file, status, start, poll, logout, cookieHeader, describe, reload }
}

/** 供 playurl 等模块直接用的 Referer（避免各处再 import 一次常量）。 */
export const BILI_REFERER = MEDIA_REFERER
