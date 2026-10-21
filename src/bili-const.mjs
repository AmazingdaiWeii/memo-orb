/**
 * bili-const.mjs —— B 站相关的常量，单独一个文件。
 *
 * 为什么要拆出来：`kfdecode.mjs` 一进门就 `import { app, BrowserWindow } from 'electron'`，
 * 普通 Node 进程（探针、单元测试）根本 import 不了它。而登录、playurl 这些活必须在
 * 纯 Node 里也能跑（否则每验一次都要拉起整个 Electron）。常量放这里，两边都能引，
 * 又不会把 UA / Referer 抄两份而漂移。
 *
 * ★ 这两个头是 B 站防盗链的硬要求：**缺任何一个都是 403**。
 *   `Referer` 必须是 https://www.bilibili.com（不带路径也行，带路径也行）；
 *   `User-Agent` 必须是浏览器 UA —— Node 默认的 `node` UA 会被 CDN 直接挡。
 */

/** 浏览器 UA。B 站 CDN 按 UA 判断，非浏览器 UA 直接 403。 */
export const MEDIA_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 媒体 / 接口请求的 Referer。缺了它 403，这是防盗链的核心。 */
export const MEDIA_REFERER = 'https://www.bilibili.com'

/** Web 接口的 Origin（扫码登录的 passport 接口对来源比较敏感）。 */
export const BILI_ORIGIN = 'https://www.bilibili.com'

/** 扫码登录用的 passport 主机。**和 api.bilibili.com 不是一台**，别混。 */
export const PASSPORT_HOST = 'https://passport.bilibili.com'

/** 业务接口主机（playurl / nav / view 都在这儿）。 */
export const API_HOST = 'https://api.bilibili.com'

/** 扫码登录的固定来源标记。缺了它部分账号会回 -400。 */
export const QR_SOURCE = 'main-fe-header'

/**
 * playurl 请求头。`Cookie` 由调用方按需补。
 *
 * ⚠️ 不要加 `Accept-Encoding: gzip` —— 取媒体分片时要的是 identity，
 *   带 gzip 会让 CDN 对 `Range` 请求也压一遍，字节偏移全错（取帧那份文档 §6 第 5 条）。
 */
export function biliHeaders({ cookie = '', referer = MEDIA_REFERER } = {}) {
  const h = {
    'User-Agent': MEDIA_UA,
    Referer: referer,
    Origin: BILI_ORIGIN,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  }
  if (cookie) h.Cookie = cookie
  return h
}

/**
 * 从 playurl 的 `dash.video[]` 里挑一条最好的。
 *
 * 排序口径（取帧文档 §10.3 实测）：先看清晰度 id，再看编码 —— **优先 avc1**，
 * 因为 Chromium 的 `<video>` 对 avc1 支持最稳，hev1/av01 在部分机器上直接黑屏
 * 或 `loadedmetadata` 卡死，而我们要的就是「浏览器自己解得了」。
 */
export const QUALITY_RANK = [127, 126, 125, 120, 116, 112, 80, 74, 64, 32, 16, 6]
export const CODEC_RANK = { avc1: 0, hev1: 1, hvc1: 1, av01: 2 }

/** 给一条 dash 流打分，越小越好。 */
export function scoreDashVideo(stream) {
  const id = Number(stream?.id) || 0
  const q = QUALITY_RANK.indexOf(id)
  const qualityScore = q === -1 ? QUALITY_RANK.length + 1 : q
  const codec = String(stream?.codecs || '').toLowerCase()
  let codecScore = 3
  for (const [prefix, rank] of Object.entries(CODEC_RANK)) {
    if (codec.startsWith(prefix)) {
      codecScore = rank
      break
    }
  }
  return { qualityScore, codecScore, id }
}
