/**
 * bili-actions.mjs —— 对一条视频做「点赞 / 投币 / 收藏 / 发评论」。
 *
 * ★ 为什么不需要挂一个网页（用户 2026-10-21 问的）：
 *   这四个动作都是 B 站 OpenAPI 上的普通 POST，鉴权就是登录时那份 cookie +
 *   `csrf`（= cookie 里的 `bili_jct`）。我们已经有 cookie 了，所以直接发请求就行 ——
 *   **零额外窗口、零常驻页面、零渲染进程**，不会因为「点了赞」就把资源吊着。
 *   （唯一要页面的事是「看见画面」，那已经由 kfdecode 的临时窗口做完就销毁。）
 *
 * ★ 三条纪律：
 *   1. **不在未登录时假装成功**：没 cookie / 没 csrf 一律返回 `{ok:false}`，不试探；
 *   2. **失败要带 B 站的 code/message**：`-101` 是没登录、`65006` 是重复投币、
 *      `-111` 是 csrf 失效 —— 这三个的处置方式完全不同，吞掉就查不动；
 *   3. **cookie 不进日志、不进返回值**。日志只记 action + aid + code。
 *
 * 这些接口会**真的改动用户账号**（点赞会出现在他的动态里、评论是公开的），
 * 所以只在用户亲手点按钮时才调用，绝不自动触发。
 */

import { API_HOST, biliHeaders } from './bili-const.mjs'

/** 从 cookie 串里抠 `bili_jct`（B 站所有写接口都要它当 csrf）。 */
export function csrfFromCookie(cookie = '') {
  const m = String(cookie || '').match(/(?:^|;\s*)bili_jct=([^;]+)/)
  return m ? m[1] : ''
}

/** 从 cookie 串里抠 `DedeUserID`（收藏夹列表要用 up_mid）。 */
export function midFromCookie(cookie = '') {
  const m = String(cookie || '').match(/(?:^|;\s*)DedeUserID=(\d+)/)
  return m ? Number(m[1]) : 0
}

/**
 * B 站写接口的常见错误码 → 人话。
 * 不认识的码就把原始 message 抛出去（比自己编一句强）。
 */
export function explainCode(code, message = '') {
  const map = {
    '-101': '账号没登录（或登录态过期），去「设置」里重新扫码',
    '-111': 'csrf 校验失败（bili_jct 过期），重新扫码登录',
    '-400': '请求参数不对',
    '-403': 'B 站拒绝了这个操作（权限或风控）',
    65004: '已经取消过赞了',
    65006: '这条已经投过币了',
    34005: '超过投币上限了（同一条视频最多两枚）',
    34003: '短时间内投币太多，被限流了',
    34004: '不能给自己的稿件投币',
    10003: '分区不存在或稿件不可用',
  }
  const key = String(code)
  if (map[key]) return map[key]
  return message && message !== '0' ? `${message}（code ${code}）` : `接口返回 code ${code}`
}

/**
 * @param {object} o
 * @param {() => string|Promise<string>} o.getCookie 返回整条 cookie 串
 * @param {Function} [o.fetchImpl]
 * @param {Function} [o.log]
 * @param {number} [o.timeoutMs]
 */
export function createBiliActions({ getCookie, fetchImpl = fetch, log = () => {}, timeoutMs = 12000 } = {}) {
  if (typeof getCookie !== 'function') throw new Error('createBiliActions 需要 getCookie')

  async function cookie() {
    try {
      return String((await getCookie()) || '')
    } catch {
      return ''
    }
  }

  /** 统一 POST。`form` 会被 URL 编码（B 站这批老接口只认 form，不认 JSON）。 */
  async function post(path, form, { ck } = {}) {
    const body = new URLSearchParams()
    for (const [k, v] of Object.entries(form)) {
      if (v === undefined || v === null) continue
      body.set(k, String(v))
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(`${API_HOST}${path}`, {
        method: 'POST',
        headers: {
          ...biliHeaders({ cookie: ck, referer: 'https://www.bilibili.com' }),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: ctrl.signal,
      })
      const text = await res.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        return { ok: false, error: `返回的不是 JSON（HTTP ${res.status}）` }
      }
      if (json?.code !== 0) {
        return { ok: false, code: json?.code, error: explainCode(json?.code, json?.message), raw: json?.message }
      }
      return { ok: true, data: json?.data ?? {} }
    } catch (err) {
      const aborted = err?.name === 'AbortError'
      return { ok: false, error: aborted ? `请求超时（${timeoutMs}ms）` : String(err?.message || err) }
    } finally {
      clearTimeout(timer)
    }
  }

  /** GET 版（拿收藏夹列表用）。 */
  async function get(path, { ck } = {}) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(`${API_HOST}${path}`, {
        headers: biliHeaders({ cookie: ck, referer: 'https://www.bilibili.com' }),
        signal: ctrl.signal,
      })
      const json = JSON.parse(await res.text())
      if (json?.code !== 0) return { ok: false, code: json?.code, error: explainCode(json?.code, json?.message) }
      return { ok: true, data: json?.data ?? {} }
    } catch (err) {
      const aborted = err?.name === 'AbortError'
      return { ok: false, error: aborted ? `请求超时（${timeoutMs}ms）` : String(err?.message || err) }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 登录态前置检查：没这两样就别发请求（省一次注定失败的往返）。 */
  async function guard() {
    const ck = await cookie()
    const csrf = csrfFromCookie(ck)
    if (!ck) return { ok: false, error: '还没登录 B 站，去「设置」里扫码登录后再点' }
    if (!csrf) return { ok: false, error: '登录态里缺 bili_jct（csrf），重新扫码登录一次' }
    return { ok: true, ck, csrf }
  }

  /** 点赞。`undo:true` 取消赞（同一接口 `like:2`）。 */
  async function like({ aid, undo = false } = {}) {
    if (!aid) return { ok: false, error: '缺 aid' }
    const g = await guard()
    if (!g.ok) return g
    const r = await post('/x/web-interface/archive/like', { aid, like: undo ? 2 : 1, csrf: g.csrf }, { ck: g.ck })
    log(`[bili-act] like aid=${aid} undo=${undo} → ${r.ok ? 'ok' : r.code || r.error}`)
    return r
  }

  /** 投币。`count` 只允许 1 或 2（B 站上限）。 */
  async function coin({ aid, count = 1 } = {}) {
    if (!aid) return { ok: false, error: '缺 aid' }
    const n = Number(count) === 2 ? 2 : 1
    const g = await guard()
    if (!g.ok) return g
    // select_like:0 —— 投币时顺手点赞是 B 站默认行为，这里明确不要（点赞有单独按钮，别偷偷做）
    const r = await post('/x/web-interface/coin/add', { aid, multiply: n, select_like: 0, csrf: g.csrf }, { ck: g.ck })
    log(`[bili-act] coin aid=${aid} x${n} → ${r.ok ? 'ok' : r.code || r.error}`)
    return r
  }

  /** 取「默认收藏夹」的 id（第一次收藏时自动建的那个）。 */
  async function defaultFavId({ mid, ck }) {
    const r = await get(`/x/v3/fav/folder/created/list-all?up_mid=${mid}`, { ck })
    if (!r.ok) return r
    const list = Array.isArray(r.data?.list) ? r.data.list : []
    if (!list.length) return { ok: false, error: '这个账号还没有收藏夹（去 B 站建一个再用）' }
    // B 站默认收藏夹的 title 就是「默认收藏夹」；退一步取 id 最小的那个。
    const def = list.find((f) => /默认/.test(String(f.title || ''))) ?? list.slice().sort((a, b) => Number(a.id) - Number(b.id))[0]
    return { ok: true, id: Number(def.id), title: String(def.title || '') }
  }

  /** 收藏到默认收藏夹。 */
  async function fav({ aid } = {}) {
    if (!aid) return { ok: false, error: '缺 aid' }
    const g = await guard()
    if (!g.ok) return g
    const mid = midFromCookie(g.ck)
    if (!mid) return { ok: false, error: '登录态里缺 DedeUserID，重新扫码登录一次' }
    const folder = await defaultFavId({ mid, ck: g.ck })
    if (!folder.ok) return folder
    const r = await post(
      '/x/v3/fav/resource/deal',
      { rid: aid, type: 2, add_media_ids: folder.id, csrf: g.csrf },
      { ck: g.ck },
    )
    log(`[bili-act] fav aid=${aid} → 「${folder.title}」 ${r.ok ? 'ok' : r.code || r.error}`)
    return r.ok ? { ...r, folder: folder.title } : r
  }

  /**
   * 发评论。★ 这是**公开发言**（会出现在视频评论区，署用户的账号），
   * 所以上层必须先让用户看清文本再点发送，绝不能自动调用。
   */
  async function comment({ aid, message } = {}) {
    const text = String(message || '').trim()
    if (!aid) return { ok: false, error: '缺 aid' }
    if (!text) return { ok: false, error: '内容是空的' }
    if (text.length > 1000) return { ok: false, error: 'B 站评论最多 1000 字' }
    const g = await guard()
    if (!g.ok) return g
    const r = await post('/x/v2/reply/add', { oid: aid, type: 1, message: text, csrf: g.csrf }, { ck: g.ck })
    // ★ 只记长度，不记正文：评论内容可能带用户的私人信息，日志没必要留。
    log(`[bili-act] comment aid=${aid} len=${text.length} → ${r.ok ? 'ok' : r.code || r.error}`)
    return r
  }

  return { like, coin, fav, comment, defaultFavId }
}
