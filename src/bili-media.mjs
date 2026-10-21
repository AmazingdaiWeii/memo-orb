/**
 * bili-media.mjs —— B 站「看视频」的两件事：认片（view）与拿直链（playurl）。
 *
 * 为什么不塞进 kfdecode.mjs：那个文件一进门就 `import { app } from 'electron'`，
 * 纯 Node 探针 import 不了；而「取直链」只需要 fetch + 两个 API，可单独测。
 * 边界很清楚：本文件**不碰解码**，只负责把 `bvid` 变成一条能喂给 `<video>` 的 URL。
 *
 * ★ 三条实测约束（来自 docs/B站认真看_取帧第三条路_原生分辨率_2026-10-21.md）：
 *   1. 媒体直链必须同时带 `Referer: https://www.bilibili.com` 与浏览器 UA，缺一个 403；
 *   2. 直链有时效（URL 里带 deadline），**每次取帧都要重新 playurl**，不能缓存 url；
 *   3. 未登录（无 cookie）时 playurl 最高只给 480P，`accept_quality` 里没有 720P+。
 *
 * 所以 `getMediaUrl()` 每次都重新请求；缓存的是 `view`（aid/cid/title 这类稳定信息）。
 */

import { API_HOST, biliHeaders, QUALITY_RANK, CODEC_RANK, scoreDashVideo } from './bili-const.mjs'

/** 画质 id → 人话。playurl 的 `accept_description` 给的是中文名，这里只做兜底。 */
export const QUALITY_LABEL = {
  127: '8K',
  126: '杜比视界',
  125: 'HDR',
  120: '4K',
  116: '1080P60',
  112: '1080P+',
  80: '1080P',
  74: '720P60',
  64: '720P',
  32: '480P',
  16: '360P',
  6: '240P',
}

function qs(params) {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    usp.set(k, String(v))
  }
  return usp.toString()
}

async function getJson(url, { cookieHeader = '', fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      headers: biliHeaders({ cookie: cookieHeader, referer: 'https://www.bilibili.com' }),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      return { ok: false, error: `返回的不是 JSON（HTTP ${res.status}）`, status: res.status }
    }
    if (json?.code !== 0) {
      return { ok: false, error: json?.message || `接口返回 code ${json?.code}`, code: json?.code, status: res.status }
    }
    return { ok: true, data: json.data ?? json.result ?? {}, status: res.status }
  } catch (err) {
    const aborted = err?.name === 'AbortError'
    return { ok: false, error: aborted ? `请求超时（${timeoutMs}ms）` : String(err?.message || err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 认片：bvid/aid → `{aid, bvid, cid, title, duration, pages}`。
 *
 * `page` 是分 P 序号（1 起）。不传就用第 1 P。**多 P 视频的 cid 必须从 pages 里取**，
 * 直接用 `data.cid` 拿到的是第一 P，后面几 P 会取错片子。
 */
export async function fetchView({ bvid = '', aid = 0, page = 1, cookieHeader = '', fetchImpl = fetch } = {}) {
  if (!bvid && !aid) return { ok: false, error: '至少给 bvid 或 aid' }
  const url = `${API_HOST}/x/web-interface/view?${qs({ bvid, aid: aid || undefined })}`
  const r = await getJson(url, { cookieHeader, fetchImpl })
  if (!r.ok) return r
  const d = r.data
  const pages = Array.isArray(d.pages) ? d.pages : []
  const idx = Math.max(1, Number(page) || 1) - 1
  const picked = pages[idx] || null
  const cid = Number(picked?.cid || d.cid || 0)
  if (!cid) return { ok: false, error: '这个视频没有 cid（可能是番剧/课程，走的是另一套接口）' }
  return {
    ok: true,
    aid: Number(d.aid || aid || 0),
    bvid: String(d.bvid || bvid || ''),
    cid,
    title: String(d.title || ''),
    duration: Number(d.duration || 0),
    page: idx + 1,
    pageTitle: String(picked?.part || ''),
    pages: pages.map((p, i) => ({ page: i + 1, cid: Number(p.cid || 0), part: String(p.part || ''), duration: Number(p.duration || 0) })),
  }
}

/**
 * 拿直链。返回 `{ok, video:{url,width,height,codec,quality,bandwidth}, audio:{url,...}, quality, acceptQuality}`。
 *
 * 排序规则来自 bili-const 的 `scoreDashVideo`：先画质档位（127 最高），再编码偏好
 * （avc1 最容易解，Chromium 对 hevc 支持看平台），最后带宽。**不按 bandwidth 单一排序** ——
 * 实测有些片子 1080P 的码率比 4K 还高，按码率排会挑错档。
 */
export async function fetchPlayurl({
  bvid = '',
  cid = 0,
  aid = 0,
  cookieHeader = '',
  quality = 0,
  fnval = 4048,
  fetchImpl = fetch,
} = {}) {
  if (!cid) return { ok: false, error: '缺少 cid' }
  if (!bvid && !aid) return { ok: false, error: '至少给 bvid 或 aid' }
  const url = `${API_HOST}/x/player/playurl?${qs({
    cid,
    bvid,
    // ★ 参数名是 `avid` 不是 `aid`。写成 aid 时接口回 `code:-400 请求错误`，
    //   看起来像风控、其实是参数名错（2026-10-21 实测踩到）。
    avid: aid || undefined,
    fourk: 1,
    fnver: 0,
    fnval,
    qn: quality || undefined,
  })}`
  const r = await getJson(url, { cookieHeader, fetchImpl })
  if (!r.ok) return r
  const d = r.data
  const dash = d.dash
  if (!dash || !Array.isArray(dash.video) || dash.video.length === 0) {
    // 老片/番剧可能只给 durl（整段 flv/mp4）。取帧那条路走不通，但播放能用。
    const durl = Array.isArray(d.durl) ? d.durl : []
    if (durl.length > 0) {
      return {
        ok: true,
        dash: false,
        durlUrls: durl.map((x) => String(x.url || '')).filter(Boolean),
        quality: Number(d.quality || 0),
        acceptQuality: Array.isArray(d.accept_quality) ? d.accept_quality : [],
        acceptDescription: Array.isArray(d.accept_description) ? d.accept_description : [],
      }
    }
    return { ok: false, error: 'playurl 没给 dash.video（可能需要登录 / 大会员 / 地域限制）' }
  }

  const videos = dash.video.slice().sort((a, b) => {
    const sa = scoreDashVideo(a)
    const sb = scoreDashVideo(b)
    if (sa.qualityScore !== sb.qualityScore) return sa.qualityScore - sb.qualityScore
    if (sa.codecScore !== sb.codecScore) return sa.codecScore - sb.codecScore
    return Number(b.bandwidth || 0) - Number(a.bandwidth || 0)
  })
  const best = videos[0]
  const audios = Array.isArray(dash.audio) ? dash.audio.slice().sort((a, b) => Number(b.bandwidth || 0) - Number(a.bandwidth || 0)) : []
  const bestAudio = audios[0] || null

  const shape = (v) =>
    v
      ? {
          url: String(v.baseUrl || v.base_url || ''),
          backupUrls: Array.isArray(v.backupUrl || v.backup_url) ? v.backupUrl || v.backup_url : [],
          quality: Number(v.id || 0),
          codec: String(v.codecs || ''),
          width: Number(v.width || 0),
          height: Number(v.height || 0),
          bandwidth: Number(v.bandwidth || 0),
          mimeType: String(v.mimeType || v.mime_type || ''),
          frameRate: String(v.frameRate || v.frame_rate || ''),
        }
      : null

  // ★ 画质一律以**实际挑中那条轨道**的 id 为准，不能用 `d.quality`。
  //   `d.quality` 是服务端的「默认档」，与我们按 scoreDashVideo 挑出来的 best 可以不同：
  //   实测 BV1GJ411x7h7 登录后 `d.quality=64`（720P）但 dash.video 里有 id=80（1080P），
  //   挑中的是 1920×1080 那条。用 d.quality 会报成「720P，1920×1080」——
  //   自相矛盾，而且她会照着这句转告用户。（2026-10-21 实测踩到）
  const actualQuality = Number(best.id || d.quality || 0)
  const acceptQuality = Array.isArray(d.accept_quality) ? d.accept_quality : []
  const acceptDescription = Array.isArray(d.accept_description) ? d.accept_description : []
  const idx = acceptQuality.indexOf(actualQuality)

  return {
    ok: true,
    dash: true,
    video: shape(best),
    audio: shape(bestAudio),
    quality: actualQuality,
    /** 服务端默认档（与我们实际挑中的可能不同，排障时有用）。 */
    defaultQuality: Number(d.quality || 0),
    acceptQuality,
    acceptDescription,
    qualityLabel: (idx >= 0 ? acceptDescription[idx] : '') || QUALITY_LABEL[actualQuality] || '',
  }
}

/**
 * 探一条媒体直链是不是真能用（取前 64KB 看状态码）。
 *
 * 为什么必须有这步：playurl 给的第一条 `baseUrl` 常常是 mcdn/边缘节点，**本机实测出现过
 * 连接超时（`UND_ERR_CONNECT_TIMEOUT` 到 `*.mcdn.bilivideo.cn:8082`）**，而 `backupUrl`
 * 里的 `upos-sz-mirror*` 能通。不探直接塞给 `<video>`，用户看到的是「一直转圈」，
 * 而不是一个能解释的错。
 */
export async function pickReachableUrl(video, { cookieHeader = '', fetchImpl = fetch, timeoutMs = 8_000, log = () => {} } = {}) {
  const candidates = [video?.url, ...(video?.backupUrls || [])].filter(Boolean)
  let lastErr = ''
  for (const url of candidates) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, {
        headers: { ...biliHeaders({ cookie: cookieHeader, referer: 'https://www.bilibili.com' }), range: 'bytes=0-65535' },
        signal: ctrl.signal,
      })
      if (res.status === 200 || res.status === 206) {
        try {
          await res.arrayBuffer()
        } catch {
          /* 读不完无所谓，状态码已经说明它活着 */
        }
        return { ok: true, url }
      }
      lastErr = `HTTP ${res.status}`
      log(`[bili] 直链不可用（${lastErr}），换备用线路`)
    } catch (err) {
      lastErr = err?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : String(err?.message || err)
      log(`[bili] 直链不可用（${lastErr}），换备用线路`)
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, error: `没有可用的媒体线路（最后错误：${lastErr || '无候选'}）` }
}

/**
 * 给 `kfdecode.extractForVideo({aid,cid,getMediaUrl})` 用的配套件 —— 那个函数只认
 * `getMediaUrl({aid,cid}) => Promise<string>`，cookie / 画质档位这些细节由这里兜住。
 *
 * ```js
 * const media = createMediaResolver({ getCookie: () => bili.cookieHeader() })
 * const frames = await extractForVideo({ aid, cid, getMediaUrl: media.getMediaUrl })
 * ```
 */
export function createMediaResolver({ getCookie = () => '', fetchImpl = fetch, log = () => {}, probeReachable = true } = {}) {
  /** @type {(p:{aid?:number,cid:number,bvid?:string})=>Promise<string>} */
  async function getMediaUrl({ aid = 0, cid = 0, bvid = '' } = {}) {
    const cookieHeader = String(getCookie() || '')
    const r = await fetchPlayurl({ aid, bvid, cid, cookieHeader, fetchImpl })
    if (!r.ok) {
      log(`[bili] 取直链失败：${r.error}`)
      throw new Error(r.error)
    }
    if (!r.dash || !r.video?.url) {
      throw new Error(r.dash === false ? '这个视频只有整段流（durl），没有 DASH 分片，取不到关键帧' : '直链为空')
    }
    log(`[bili] 直链 ${r.video.width}x${r.video.height} ${r.video.codec} ${QUALITY_LABEL[r.video.quality] || r.video.quality}`)
    if (!probeReachable) return r.video.url
    const reach = await pickReachableUrl(r.video, { cookieHeader, fetchImpl, log })
    if (!reach.ok) throw new Error(reach.error)
    return reach.url
  }

  return { getMediaUrl, fetchPlayurl, fetchView }
}

/** 便于探针/工具直接用的组合：bvid → 一条可播的直链（视频轨）。 */
export async function resolveByBvid({ bvid, page = 1, cookieHeader = '', fetchImpl = fetch } = {}) {
  const view = await fetchView({ bvid, page, cookieHeader, fetchImpl })
  if (!view.ok) return view
  const play = await fetchPlayurl({ bvid: view.bvid, cid: view.cid, cookieHeader, fetchImpl })
  if (!play.ok) return { ...play, view }
  return { ok: true, view, play, mediaUrl: play.video?.url || '' }
}
