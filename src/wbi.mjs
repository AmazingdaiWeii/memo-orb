/**
 * wbi.mjs —— B 站 web 端的 WBI 签名（`w_rid` / `wts`）。
 *
 * 为什么需要它：B 站把一部分 web 接口升级到了 `/x/.../wbi/...` 这条路，
 * 请求必须带签过名的参数，否则服务端**不报错、只是给你错的数据**。
 * 最典型的就是字幕：老的 `x/player/v2` 对未签名请求会返回**别人视频的字幕**
 * （实测 8/8 全错，且 URL 里的 aid/cid 自洽到能反查出另一条真实视频），
 * 换成 `x/player/wbi/v2` 签名请求后立刻变成 `own=true`（2026-10-22 实测）。
 *
 * 算法（B 站前端那张定表，别改）：
 *   1. `nav` 接口的 `wbi_img.img_url` / `sub_url` 各取文件名（去掉目录与后缀）当 key；
 *   2. `orig = imgKey + subKey`，按 `MIXIN_TAB` 的 64 个下标重排，取前 32 位 = `mixin_key`；
 *   3. 参数按 key 升序拼 `k=v&…`（值里 `!'()*` 要剔掉），末尾追加 `wts`；
 *   4. `w_rid = md5(query + mixin_key)`，最终 query = `query&w_rid=…`。
 *
 * 三条纪律：
 *   - **key 要缓存**（默认 6 小时）：每天变一次，每发一个请求都去问 nav 是白烧一次往返。
 *   - **拿不到 key 不许抛**：返回空串，调用方降级走老接口 —— 签名是加分项，不是前提。
 *   - **不用 `URLSearchParams` 排序**：它按插入顺序输出，必须自己 sort 后再拼。
 */

import { createHash } from 'node:crypto'
import { API_HOST, biliHeaders } from './bili-const.mjs'

/** B 站前端的 WBI 混入表（64 个下标，官方代码里写死的那张）。 */
export const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
]

/** 从 img_url / sub_url 里抠 key（取文件名去后缀）。 */
export function keyFromUrl(url) {
  return String(url || '').split('/').pop().split('.')[0] || ''
}

/** 由两个 key 算 mixin_key（32 位）。单独导出，便于探针用固定 key 断言。 */
export function mixinKeyOf(imgKey, subKey, tab = MIXIN_TAB) {
  return tab.map((i) => (imgKey + subKey)[i]).join('').slice(0, 32)
}

/**
 * 把一个参数对象签成可直接拼到 URL 后面的 query。
 *
 * @param {object} params
 * @param {string} mixinKey
 * @param {number} [nowMs] 注入时钟（探针要可复现）
 * @returns {string}
 */
export function signQuery(params, mixinKey, nowMs = Date.now()) {
  const all = { ...params, wts: Math.floor(nowMs / 1000) }
  const query = Object.keys(all)
    .sort()
    .map((k) => {
      // 值是对象/数组的一律按字符串化处理 —— B 站只收标量
      const v = String(all[k] ?? '').replace(/[!'()*]/g, '')
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
    })
    .join('&')
  const hash = createHash('md5').update(query + mixinKey).digest('hex')
  return `${query}&w_rid=${hash}`
}

/**
 * 造一个签名器。key 有缓存，失败不抛。
 *
 * @param {object} o
 * @param {() => string|Promise<string>} [o.getCookie]
 * @param {Function} [o.fetchImpl]
 * @param {Function} [o.log]
 * @param {number} [o.ttlMs] key 缓存时长（默认 6 小时）
 * @param {() => number} [o.now] 注入时钟
 */
export function createWbi({ getCookie = () => '', fetchImpl = fetch, log = () => {}, ttlMs = 6 * 3600 * 1000, now = Date.now } = {}) {
  let cache = { mixinKey: '', at: 0 }

  async function loadMixinKey() {
    if (cache.mixinKey && now() - cache.at < ttlMs) return cache.mixinKey
    let ck = ''
    try {
      ck = String((await getCookie()) || '')
    } catch {
      ck = ''
    }
    try {
      const res = await fetchImpl(`${API_HOST}/x/web-interface/nav`, {
        headers: biliHeaders({ cookie: ck, referer: 'https://www.bilibili.com' }),
      })
      const json = await res.json()
      const imgKey = keyFromUrl(json?.data?.wbi_img?.img_url)
      const subKey = keyFromUrl(json?.data?.wbi_img?.sub_url)
      if (!imgKey || !subKey) {
        log('[wbi] nav 里没有 wbi_img，这一轮走不了签名接口')
        return ''
      }
      cache = { mixinKey: mixinKeyOf(imgKey, subKey), at: now() }
      log(`[wbi] 拿到 mixin key（${cache.mixinKey.slice(0, 8)}…），缓存 ${Math.round(ttlMs / 60000)} 分钟`)
      return cache.mixinKey
    } catch (err) {
      log(`[wbi] 取签名 key 失败（${String(err?.message || err)}），先走未签名接口`)
      return ''
    }
  }

  /** 签一段 query；拿不到 key 就返回空串（调用方据此判断要不要用签名接口）。 */
  async function sign(params) {
    const mixinKey = await loadMixinKey()
    if (!mixinKey) return ''
    return signQuery(params, mixinKey, now())
  }

  /** 只读调试信息（探针/日志用，不含 key 全文）。 */
  function describe() {
    return { hasKey: Boolean(cache.mixinKey), keyPrefix: cache.mixinKey.slice(0, 8), at: cache.at }
  }

  return { sign, describe }
}
