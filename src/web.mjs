/**
 * web.mjs · 她的眼睛（联网检索与取正文）
 *
 * 2026-10-19 事实核对：《1017》= DeepSeek-V4.1-Flash-1017，API 名仍是 `deepseek-flash`，
 * 并且开放了**独立的** Search / Fetch 端点（不是 `chat/completions` 内建检索）：
 *   POST {base}/tools/search   { query, count, need_content, ori_question, localization }
 *   POST {base}/tools/fetch    { url }
 * 已实测：`probe/search-api-smoke.mjs` 16 PASS / 0 FAIL（见 docs/陪伴型助手_…_设计_2026-10-19.md §4.1）。
 *
 * 所以「她能不能联网」的分界线是：orb 有没有这段代码，而不是模型有没有联网能力。
 *
 * 三条取舍，写在这里免得以后推翻：
 *   1. **默认不取 content。** 每条结果的 `summary`（600–800 字）本来就是给模型读的；
 *      一次搜 5 条若都带全文，等于把上下文灌爆。要细节让她再 `fetch_url`。
 *   2. **失败返回 `{ok:false}` 不抛。** 工具层要能对用户说「网没查到」而不是把回合炸掉。
 *   3. **401 与 402 的文案必须不同。** 一个是 key 配错、一个是没钱，混在一起排障就会瞎猜。
 */

/** 单条结果给模型看的正文上限（`summary` 本身 600–800 字，这只是兜底）。 */
export const MAX_SUMMARY_CHARS = 900

/** `fetch_url` 交给模型的正文上限（18693 字的官方 changelog 实测会整篇返回，必须截）。 */
export const MAX_PAGE_CHARS = 40_000

/** 默认条数。官方允许 1–50，默认 10；我们要省上下文，取 5。 */
export const DEFAULT_COUNT = 5

/** 会被 SSRF 打到的地址：本地回环、私有网段、链路本地。 */
const PRIVATE_HOST_RE =
  /^(localhost|.*\.local|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|\[?fe80:.*)$/i

/**
 * 把上游错误翻译成一句能直接给她看的话。
 *
 * @param {number} status
 * @param {any} json  上游 JSON（可能为 null）
 * @returns {string}
 */
function describeError(status, json) {
  const detail = json?.error?.message ?? json?.message ?? ''
  const tail = detail ? `（${String(detail).slice(0, 160)}）` : ''
  switch (status) {
    case 400:
      return `请求参数不对${tail}`
    case 401:
      return `API key 无效——这是配置问题，不是网络问题${tail}`
    case 402:
      return `账户余额不足，搜索按成功请求计费（$0.75/千次）${tail}`
    case 403:
      return `这个地址被上游策略拒绝了（取正文时常见）${tail}`
    case 404:
      return `这个页面拿不到可提取的正文${tail}`
    case 408:
      return `上游超时${tail}`
    case 413:
      return `请求体太大${tail}`
    case 429:
      return `调用太频繁（QPS 限 100），缓一下再试${tail}`
    default:
      if (status >= 500) return `上游出错了（HTTP ${status}），不是我们的问题${tail}`
      return `请求失败（HTTP ${status}）${tail}`
  }
}

/**
 * 私有网段拦截：`fetch_url` 是模型挑的 URL，不挡就能读本机/内网服务。
 * 只挡 hostname，不做 DNS 解析后的二次校验（Node 的 fetch 不给那一步的钩子）；
 * 这是「够用」而不是「严密」，真要严密得走自定义 dispatcher。
 *
 * @param {string} raw
 * @returns {string|null} 不合法时返回错误文案
 */
export function checkUrl(raw) {
  let u
  try {
    u = new URL(String(raw ?? ''))
  } catch {
    return `不是合法网址：${String(raw ?? '').slice(0, 120)}`
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `只支持 http/https，别的一律不抓（${u.protocol}）`
  }
  if (PRIVATE_HOST_RE.test(u.hostname)) {
    return `不抓内网与本机地址（${u.hostname}）`
  }
  if (String(raw).length > 8192) return '网址太长（上限 8192 字符）'
  return null
}

/**
 * 创建 web 服务。
 *
 * @param {object} o
 * @param {{baseUrl: string, apiKey: string, source?: string}} o.auth  readProviderAuth() 的返回值
 * @param {Function} [o.log]
 */
export function createWeb({ auth, log = () => {} }) {
  const base = String(auth?.baseUrl ?? '').replace(/\/+$/, '')
  const key = String(auth?.apiKey ?? '')
  if (!base) throw new Error('createWeb：缺 baseUrl')
  if (!key) throw new Error('createWeb：缺 apiKey')

  /**
   * 一次 POST。**永不抛**（除编程错误），失败折成 `{ok:false, error}`。
   *
   * @param {string} endpoint  如 `/tools/search`
   * @param {object} body
   * @param {number} timeoutMs
   */
  async function post(endpoint, body, timeoutMs) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    const t0 = Date.now()
    try {
      const res = await fetch(`${base}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      const text = await res.text()
      let json = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        // 非 JSON（网关错误页）——下面按状态码处理，原文进日志
        log(`[web] ${endpoint} 返回非 JSON（${res.status}，${text.length}B）`)
      }
      const ms = Date.now() - t0
      if (!res.ok) {
        const error = describeError(res.status, json)
        log(`[web] ${endpoint} 失败 status=${res.status} ${ms}ms ${error}`)
        return { ok: false, error, status: res.status, ms }
      }
      return { ok: true, json, status: res.status, ms }
    } catch (err) {
      const ms = Date.now() - t0
      const aborted = err?.name === 'AbortError'
      const error = aborted
        ? `等太久了（${Math.round(timeoutMs / 1000)} 秒没回应），可能网断了`
        : `请求发不出去：${err?.message ?? err}`
      log(`[web] ${endpoint} 异常 ${ms}ms ${error}`)
      return { ok: false, error, status: 0, ms }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 检索。
   *
   * @param {string} query  1–128 字；支持 `site:` / `-site:` / `-词` / `"短语"` / `lang:zh,en` / `after:` / `before:`
   * @param {{count?: number, needContent?: boolean, oriQuestion?: string, timeoutMs?: number}} [o]
   */
  async function search(query, { count = DEFAULT_COUNT, needContent = false, oriQuestion, timeoutMs = 15_000 } = {}) {
    const q = String(query ?? '').trim()
    // 参数层就挡掉的失败也要带 ms，否则日志里会打出 `失败 undefinedms`（探针实测踩到）。
    if (!q) return { ok: false, error: '检索词是空的', ms: 0 }
    if (q.length > 128) return { ok: false, error: `检索词太长（${q.length} 字，上限 128）`, ms: 0 }
    const n = Math.max(1, Math.min(50, Number(count) || DEFAULT_COUNT))

    const body = { query: q, count: n }
    if (needContent) body.need_content = true
    if (oriQuestion) body.ori_question = String(oriQuestion).slice(0, 512)

    const r = await post('/tools/search', body, timeoutMs)
    if (!r.ok) return { ok: false, error: r.error, status: r.status, ms: r.ms }

    const raw = r.json?.results
    if (!Array.isArray(raw)) {
      return { ok: false, error: '上游返回里没有 results 数组', ms: r.ms }
    }
    const results = raw.map((it) => {
      const summary = String(it?.summary ?? '')
      return {
        title: String(it?.title ?? ''),
        url: String(it?.url ?? ''),
        summary:
          summary.length > MAX_SUMMARY_CHARS ? summary.slice(0, MAX_SUMMARY_CHARS) + '…（截断）' : summary,
        snippet: String(it?.snippet ?? ''),
        date: it?.date ?? null,
        authority: typeof it?.authority === 'number' ? it.authority : null,
        score: typeof it?.rerank_score === 'number' ? Number(it.rerank_score.toFixed(2)) : null,
        site: String(it?.site_name ?? ''),
      }
    })
    log(`[web] search "${q.slice(0, 30)}" → ${results.length} 条 ${r.ms}ms`)
    return { ok: true, query: q, results, ms: r.ms }
  }

  /**
   * 取一个网页的正文（Markdown）。
   *
   * @param {string} url
   * @param {{timeoutMs?: number}} [o]
   */
  async function fetchPage(url, { timeoutMs = 20_000 } = {}) {
    const bad = checkUrl(url)
    if (bad) return { ok: false, error: bad, ms: 0 }

    const r = await post('/tools/fetch', { url: String(url) }, timeoutMs)
    if (!r.ok) return { ok: false, error: r.error, status: r.status, ms: r.ms }

    let content = String(r.json?.content ?? '')
    const truncated = content.length > MAX_PAGE_CHARS
    if (truncated) content = content.slice(0, MAX_PAGE_CHARS) + '\n\n…（正文太长，后面截掉了）'
    log(`[web] fetch ${String(url).slice(0, 60)} → ${content.length} 字 ${r.ms}ms`)
    return {
      ok: true,
      url: String(url),
      title: String(r.json?.title ?? ''),
      content,
      truncated,
      ms: r.ms,
    }
  }

  return { base, search, fetchPage }
}
