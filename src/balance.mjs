/**
 * balance.mjs —— 「用户账户里还有多少钱」。
 *
 * 为什么单独一层：这笔钱决定了**她该怎么花**。
 * 看一条视频要花视觉 token（一帧 480×270 与一帧原生 853×480 差一个数量级），
 * 余额见底时她自己该收敛成「少取两帧、先看元信息」，而不是照旧全速跑。
 * 这件事没有任何菜单可以替她判断（用户 2026-10-21 明确：不要菜单，交给她决定），
 * 所以钱必须先到她眼前。
 *
 * 接口：DeepSeek 的 `GET {base}/user/balance`（Bearer 同一个 key），
 * 实测返回 `{is_available, balance_infos:[{currency,total_balance,granted_balance,topped_up_balance}]}`。
 * 其它 OpenAI 兼容中转站大多没有这条（404/401）——**查不到就说查不到，不许猜**。
 *
 * 三条纪律：
 *   1. 默认 5 分钟内复用上次结果：每轮都问一次纯属浪费，余额也不是秒级变的；
 *   2. 永不抛：查不到折成 `{ok:false, error}`，绝不能因为「问不到钱」把对话卡住；
 *   3. 密钥不出本模块：只发 Authorization 头，不写日志、不进返回值。
 */

/** 余额多久算新鲜（毫秒）。 */
export const DEFAULT_TTL = 5 * 60 * 1000

/** 低于这个数就值得提醒用户（元，可在 config.json 用 balanceWarnBelow 覆盖）。 */
export const DEFAULT_WARN_BELOW = 5

/**
 * `https://api.deepseek.com/v1` → `https://api.deepseek.com`
 * 余额端点挂在**根**上，不在 /v1 下面（带上 /v1 会 404）。
 */
export function balanceUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) return ''
  return `${base.replace(/\/v1$/i, '')}/user/balance`
}

/** `8.62` → `¥8.62`；拿不到就给空串（别显示 `¥undefined`）。 */
export function formatMoney(amount, currency = 'CNY') {
  const n = Number(amount)
  if (!Number.isFinite(n)) return ''
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `
  return `${symbol}${n.toFixed(2)}`
}

/** `21:47` 这种，只用于「什么时候查的」。 */
function clock(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * @param {object} o
 * @param {() => {baseUrl:string, apiKey:string, provider?:string}} o.getAuth 现读凭据（改配置后立刻生效）
 * @param {Function} [o.fetchImpl]
 * @param {Function} [o.log]
 * @param {number} [o.ttlMs]
 * @param {number} [o.warnBelow] 低于这个数就在文案里加提醒
 * @param {number} [o.timeoutMs]
 */
export function createBalance({
  getAuth,
  fetchImpl = fetch,
  log = () => {},
  ttlMs = DEFAULT_TTL,
  warnBelow = DEFAULT_WARN_BELOW,
  timeoutMs = 8000,
} = {}) {
  if (typeof getAuth !== 'function') throw new Error('createBalance 需要 getAuth')

  /** @type {{ok:boolean, available?:boolean, currency?:string, total?:number, granted?:number, toppedUp?:number, checkedAt?:number, error?:string, unsupported?:boolean}|null} */
  let cache = null

  async function query() {
    let auth = null
    try {
      auth = getAuth()
    } catch (err) {
      return { ok: false, error: `读不到 API 配置：${String(err?.message || err)}` }
    }
    const apiKey = String(auth?.apiKey || '')
    if (!apiKey) return { ok: false, error: '还没配 API key，查不了余额' }
    const url = balanceUrl(auth?.baseUrl)
    if (!url) return { ok: false, error: '没有 baseUrl，查不了余额' }

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: ctrl.signal,
      })
      const text = await res.text()
      if (res.status === 404 || res.status === 401 || res.status === 403) {
        // 中转站基本都这样：这条端点根本不存在，或 key 不接受它。
        return { ok: false, unsupported: true, error: `这个服务商没有余额接口（HTTP ${res.status}）` }
      }
      if (!res.ok) return { ok: false, error: `余额接口返回 HTTP ${res.status}` }
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        return { ok: false, error: '余额接口返回的不是 JSON' }
      }
      const list = Array.isArray(json?.balance_infos) ? json.balance_infos : []
      const info = list.find((x) => x?.currency === 'CNY') ?? list[0] ?? null
      if (!info) return { ok: false, error: '余额接口没给 balance_infos' }
      return {
        ok: true,
        available: json?.is_available === true,
        currency: String(info.currency || 'CNY'),
        total: Number(info.total_balance),
        granted: Number(info.granted_balance),
        toppedUp: Number(info.topped_up_balance),
        checkedAt: Date.now(),
      }
    } catch (err) {
      const aborted = err?.name === 'AbortError'
      return { ok: false, error: aborted ? `查余额超时（${timeoutMs}ms）` : String(err?.message || err) }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 拿快照（带缓存）。`force:true` 绕过缓存。 */
  async function snapshot({ force = false } = {}) {
    if (!force && cache && cache.checkedAt && Date.now() - cache.checkedAt < ttlMs) return cache
    const r = await query()
    cache = r.ok ? { ...r } : { ...r, checkedAt: Date.now() }
    if (r.ok) {
      log(`[balance] ${formatMoney(r.total, r.currency)}（${r.available ? '可用' : '不可用'}）`)
    } else if (r.unsupported) {
      log(`[balance] ${r.error} —— 当它没有这个能力，别猜`)
    } else {
      log(`[balance] 查询失败：${r.error}`)
    }
    return cache
  }

  /** 给「每轮一句话」用的短句。查不到就返回空串（宁可不提，也不许瞎说）。 */
  async function turnLine() {
    const s = await snapshot()
    if (!s?.ok) return ''
    const money = formatMoney(s.total, s.currency)
    const low = s.total < warnBelow
    return low
      ? `（账户余额 ${money}（${clock(s.checkedAt)} 查的）—— 已低于 ${formatMoney(warnBelow, s.currency)}，贵的事先掂量，必要时主动提醒他。）`
      : `（账户余额 ${money}（${clock(s.checkedAt)} 查的）。）`
  }

  function describe() {
    if (!cache) return '余额：还没查过'
    if (cache.ok) return `余额 ${formatMoney(cache.total, cache.currency)}`
    return `余额：查不到（${cache.error}）`
  }

  return { snapshot, turnLine, describe, warnBelow }
}
