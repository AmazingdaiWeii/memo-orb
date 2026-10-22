/**
 * bili-subtitle.mjs —— 取 B 站字幕（「轻松看」那一档的底座）。
 *
 * 为什么不自己从头摸：这套坑在 BiliMini（pywebview 版）里已经踩完了，
 * 桌面 `BiliMini_项目交付/README_给下一个AI.md` 与 `regression/probe_subtitle_*.py`
 * 留了完整取证。三条**必须照抄**的结论：
 *
 *   ① **老的 `x/player/v2` 会返回别人的字幕。**
 *      实测（2026-10-22，本项目真实账号）：连发 8 次，8 次拿到的 `subtitle_url`
 *      里的 aid/cid 全不是被请求的那条，而且能反查出另一条真实视频
 *      （e.g. 请求「深海猎捕之王」，回来的是「最贵订单！叫代驾去新疆」的字幕），
 *      还有 3~5 次干脆返回 0 条轨道。**并发重试也救不了**（BiliMini 当年靠并发碰运气，
 *      我们这边 8/8 全错）。这不是网络抖动，是服务端对未签名请求给了错数据。
 *
 *   ② **正解是 `x/player/wbi/v2`（要 WBI 签名）。** 换成签名请求后同一条视频
 *      立刻变成 `own=true`，正文时间轴也落在时长内。见 `src/wbi.mjs`。
 *
 *   ③ **归属必须核对，不能只看「有没有轨道」。**
 *      核对两道：
 *        · URL 里的 aid/cid（`/prod/<15位aid><11位cid><32位hex>`）必须等于被请求的；
 *        · 核对不了的（新版是**裸哈希**，没有 aid/cid 前缀）就用时间轴兜底：
 *          末条时间戳远超视频时长 ⇒ 一定是别人的。
 *      另外**不能盲取第一条**：同一个视频两次请求返回的轨道顺序会变。
 *
 * 边界：本文件**不碰缓存、不碰落盘、不碰 prompt**，只负责
 * 「给 aid+cid → 一串已核验的字幕行」。落盘与截断由 `bili-watch.mjs` 决定。
 */

import { API_HOST, biliHeaders, MEDIA_UA } from './bili-const.mjs'

/** AI 字幕 CDN 路径里编码了归属：`/bfs/ai_subtitle/prod/<15位aid><11位cid><32位hex>`。 */
export const SUB_ID_RE = /\/prod\/(\d{15})(\d{11})([0-9a-f]{32})/

/** 一次最多并发几个 `player/v2`（只在没有签名能力时用）。 */
export const BATCH_SIZE = 6
/** 最多几批（最坏 30 次请求）。 */
export const MAX_BATCHES = 5

/** `//host/path` → `https://host/path`；认不出的原样返回。 */
export function normalizeSubUrl(url) {
  const u = String(url || '').trim()
  if (!u) return ''
  if (u.startsWith('//')) return `https:${u}`
  if (/^https?:/i.test(u)) return u
  return u
}

/**
 * 从字幕 URL 里读它属于哪个视频。
 *
 * ★ 前导零必须归一成十进制（`000000031312075` → `31312075`）。
 *   CDN 路径里的 aid/cid 是**定长补零**的（15 位 / 11 位），而老视频的 aid 只有 8 位；
 *   直接拿字符串比，会把「自己的字幕」判成「别人的」，结果一条都用不了
 *   （探针 `bili-subtitle-unit` S1a/S2 就是钉这条：第一版真踩了）。
 *
 * @returns {{aid: string, cid: string}|null} 认不出（裸哈希/异常格式）返回 null
 */
export function trackIdentity(url) {
  const clean = normalizeSubUrl(url).split('?')[0]
  const m = SUB_ID_RE.exec(clean)
  if (!m) return null
  return { aid: String(Number(m[1])), cid: String(Number(m[2])) }
}

/** 两侧都归一成十进制再比（aid 可能是数字也可能是字符串）。 */
function sameId(a, b) {
  const x = Number(a)
  const y = Number(b)
  if (Number.isFinite(x) && Number.isFinite(y)) return x === y
  return String(a) === String(b)
}

/** 把接口给的一条轨道归一成内部形状。 */
function normTrack(s) {
  return {
    lan: String(s?.lan || ''),
    lanDoc: String(s?.lan_doc || ''),
    ai: Number(s?.ai_status || 0),
    url: normalizeSubUrl(s?.subtitle_url),
  }
}

/**
 * 挑一条最合适的字幕轨：人工中文 > AI 中文 > 人工其它 > AI 其它。
 *
 * ★ 不能盲取第一条 —— 实测同一个视频两次请求的轨道顺序会变（BiliMini 也记了这条）。
 */
export function pickTrack(tracks = []) {
  const score = (t) => {
    const lan = String(t?.lan || '').toLowerCase()
    let s = 0
    if (Number(t?.ai || 0) === 0) s += 100 // 人工字幕优先
    if (lan.startsWith('zh') || lan.startsWith('ai-zh')) s += 50
    return s
  }
  let best = null
  for (const t of tracks) {
    if (!t?.url) continue
    if (!best || score(t) > score(best)) best = t
  }
  return best
}

/**
 * 把轨道列表按「能不能证明是自己的」分成三堆。
 * @returns {{own: object[], foreign: object[], bare: object[]}}
 */
export function splitTracks(tracks, aid, cid) {
  const own = []
  const foreign = []
  const bare = []
  for (const t of tracks || []) {
    if (!t?.url) continue
    const id = trackIdentity(t.url)
    if (!id) bare.push(t)
    else if (sameId(id.aid, aid) && sameId(id.cid, cid)) own.push(t)
    else foreign.push(t)
  }
  return { own, foreign, bare }
}

/** 秒 → `[mm:ss]` / `[h:mm:ss]`。 */
export function fmtClock(sec) {
  const n = Math.max(0, Math.floor(Number(sec) || 0))
  const h = Math.floor(n / 3600)
  const m = Math.floor((n % 3600) / 60)
  const s = n % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/** 字幕行 → 带时间轴的纯文本。 */
export function subsToText(lines = []) {
  return lines.map((l) => `[${fmtClock(l.t)}] ${l.text}`).join('\n')
}

/**
 * 时间轴归属校验（最后一道防线，专治「裸哈希没法核对归属」）。
 *
 * @returns {{verdict: 'ok'|'slightly-over'|'way-over'|'unknown', lastTs: number, duration: number}}
 */
export function checkTimeline(lines, duration) {
  const dur = Number(duration) || 0
  let lastTs = 0
  for (const l of lines || []) {
    const t = Number(l?.t) || 0
    if (t > lastTs) lastTs = t
  }
  if (!dur) return { verdict: 'unknown', lastTs, duration: dur }
  if (lastTs > dur + 60) return { verdict: 'way-over', lastTs, duration: dur }
  if (lastTs > dur + 10) return { verdict: 'slightly-over', lastTs, duration: dur }
  return { verdict: 'ok', lastTs, duration: dur }
}

/**
 * 造一个字幕取用器。
 *
 * @param {object} o
 * @param {() => string|Promise<string>} [o.getCookie]
 * @param {(params: object) => Promise<string>} [o.sign] WBI 签名器（`createWbi().sign`）。
 *        给了才有 `player/wbi/v2` 这条正路；不给就只剩老接口碰运气。
 * @param {Function} [o.fetchImpl]
 * @param {Function} [o.log]
 * @param {number} [o.timeoutMs]
 */
export function createBiliSubtitle({ getCookie = () => '', sign = null, fetchImpl = fetch, log = () => {}, timeoutMs = 12_000 } = {}) {
  async function cookie() {
    try {
      return String((await getCookie()) || '')
    } catch {
      return ''
    }
  }

  async function getJson(url, ck) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, {
        headers: biliHeaders({ cookie: ck, referer: 'https://www.bilibili.com' }),
        signal: ctrl.signal,
      })
      const text = await res.text()
      try {
        return JSON.parse(text)
      } catch {
        return { code: 'NON-JSON', message: `返回的不是 JSON（HTTP ${res.status}）` }
      }
    } catch (err) {
      const aborted = err?.name === 'AbortError'
      return { code: 'FETCH-FAIL', message: aborted ? `请求超时（${timeoutMs}ms）` : String(err?.message || err) }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 从一杯 player/v2 的响应里把轨道取出来并分类。 */
  function classify(json, aid, cid) {
    if (!json || json.code !== 0) return { tracks: [], split: { own: [], foreign: [], bare: [] }, code: json?.code }
    const raw = ((json.data || {}).subtitle || {}).subtitles || []
    const tracks = raw.map(normTrack).filter((t) => t.url)
    return { tracks, split: splitTracks(tracks, aid, cid), code: 0 }
  }

  /**
   * 取字幕轨。永不抛。
   *
   * 返回的 `tracks` 已经是「能证明是自己的」或「核对不了但时间轴待验」的，
   * **不会被别人的字幕污染**；真的一条都没有时才 `ok:false`，并用
   * `reason` 区分 `no-subtitle`（本来就没有）与 `all-foreign`（有，但全是别人的）。
   */
  async function tracks({ aid, cid } = {}) {
    if (!aid || !cid) return { ok: false, reason: 'bad-args', error: '缺 aid / cid' }
    const ck = await cookie()
    const stats = { attempts: 0, batches: 0, own: 0, foreign: 0, bare: 0 }

    // ── 正路：WBI 签名接口。一次就够，实测 own=true ─────────────────────
    if (typeof sign === 'function') {
      const q = await sign({ aid, cid })
      if (q) {
        const json = await getJson(`${API_HOST}/x/player/wbi/v2?${q}`, ck)
        stats.attempts += 1
        const { tracks: list, split } = classify(json, aid, cid)
        if (list.length) {
          stats.own = split.own.length
          stats.foreign = split.foreign.length
          stats.bare = split.bare.length
          const usable = split.own.length ? split.own : split.bare
          if (usable.length) {
            log(`[bili-sub] wbi 接口 aid=${aid} cid=${cid} → 轨道 ${list.length}（自己 ${split.own.length} / 别人 ${split.foreign.length} / 待验 ${split.bare.length}）`)
            return {
              ok: true,
              tracks: usable,
              verified: split.own.length > 0,
              source: 'wbi',
              stats,
            }
          }
          // 全是别人的 —— 签名接口按说不该这样，但真发生了就别用
          log(`[bili-sub] wbi 接口只给了别人的字幕（${split.foreign.length} 条），不用`)
        } else if (json?.code === 0) {
          // 签名接口明确说「没有字幕轨」—— 那就是真没有，别再拿老接口的脏数据凑数
          log(`[bili-sub] wbi 接口 aid=${aid} cid=${cid} → 0 轨道（判定：这条没有字幕）`)
          return { ok: false, reason: 'no-subtitle', error: '这条视频没有字幕轨', stats }
        }
      } else {
        log('[bili-sub] 拿不到 WBI 签名，降级走老的 player/v2（结果需要严格核对）')
      }
    }

    // ── 兜底：老接口，小批量并发 + 抖动重试 ─────────────────────────────
    //
    // 为什么必须并发：错配是「按连接/边缘分流」的，串行重试会一直落在同一个坏节点上
    // （BiliMini 实测：串行 25 次一条都没拿到，并发 8 个一次就中）。我们这边实测
    // 并发 8 次仍然全错 —— 所以这条兜底本身不保证成功，只是**没有签名能力时**的
    // 最后努力；拿到的东西照样要过归属核对。
    let sawAnyTrack = false
    let best = null
    const stop = MAX_BATCHES
    for (let b = 1; b <= stop; b += 1) {
      stats.batches = b
      const jobs = Array.from({ length: BATCH_SIZE }, async () => {
        stats.attempts += 1
        const json = await getJson(`${API_HOST}/x/player/v2?aid=${aid}&cid=${cid}`, ck)
        return classify(json, aid, cid)
      })
      const results = await Promise.all(jobs)
      for (const r of results) {
        if (r.tracks.length) sawAnyTrack = true
        if (r.split.own.length && !best) best = { tracks: r.split.own, verified: true }
        if (!best && r.split.bare.length) best = { tracks: r.split.bare, verified: false }
      }
      if (best) break
      if (b < stop) {
        // 抖动：让下一批落到不同边缘
        const wait = 200 + Math.floor(Math.random() * 400)
        await new Promise((r) => setTimeout(r, wait))
      }
    }

    if (best) {
      log(`[bili-sub] 老接口 aid=${aid} cid=${cid} → 用了 ${best.tracks.length} 条（verified=${best.verified}），共 ${stats.attempts} 次请求`)
      return { ok: true, tracks: best.tracks, verified: best.verified, source: 'player-v2', stats }
    }
    return {
      ok: false,
      reason: sawAnyTrack ? 'all-foreign' : 'no-subtitle',
      error: sawAnyTrack ? 'B 站只返回了别的视频的字幕（服务端错配），这一趟取不到' : '这条视频没有字幕轨',
      stats,
    }
  }

  /**
   * 下字幕正文。
   *
   * ★ 必须在**主进程/Node 侧**下，不能在渲染层用 fetch：字幕 CDN 的 CORS 会拦死页面内请求。
   *   实测 CDN 只认 URL 里的 `auth_key`（不带 cookie / Referer 也 200），
   *   但带上是白带的便宜保险。
   */
  async function download(url) {
    const u = normalizeSubUrl(url)
    if (!u) return { ok: false, error: '字幕地址是空的' }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), Math.max(timeoutMs, 20_000))
    try {
      const res = await fetchImpl(u, {
        headers: { 'User-Agent': MEDIA_UA, Referer: 'https://www.bilibili.com/' },
        signal: ctrl.signal,
      })
      const text = await res.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        return { ok: false, error: `字幕不是 JSON（HTTP ${res.status}）` }
      }
      const body = Array.isArray(json?.body) ? json.body : []
      const lines = []
      for (const b of body) {
        const t = Number(b?.from)
        const s = String(b?.content || '').trim()
        if (!s) continue
        lines.push({ t: Number.isFinite(t) ? t : 0, text: s })
      }
      if (!lines.length) return { ok: false, error: '字幕轨是空的（可能只是占位轨）' }
      return { ok: true, lines, bytes: text.length }
    } catch (err) {
      const aborted = err?.name === 'AbortError'
      return { ok: false, error: aborted ? `下字幕超时` : String(err?.message || err) }
    } finally {
      clearTimeout(timer)
    }
  }

  function describe() {
    return { hasSigner: typeof sign === 'function', batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES, timeoutMs }
  }

  return { tracks, download, describe }
}
