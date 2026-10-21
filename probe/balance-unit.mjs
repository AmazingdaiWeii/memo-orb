#!/usr/bin/env node
/**
 * balance-unit.mjs —— 余额模块的单元体检（纯 Node，不打真网）。
 *
 * 守的是四件事：
 *   ① URL 归一化：`https://api.deepseek.com/v1` → 根上的 `/user/balance`（带 /v1 会 404）；
 *   ② 解析：`balance_infos` 里优先取 CNY，数字要转成 number 而不是字符串；
 *   ③ 降级：404/401（中转站没有这条接口）要标 `unsupported`，**不许抛、不许编数**；
 *   ④ 缓存：5 分钟内不重复请求；`force:true` 才绕过；
 *   ⑤ 每轮那行文案：余额低于阈值才带提醒，查不到就返回空串（宁可不提）。
 *
 * 跑法：`node probe/balance-unit.mjs`
 */

import { balanceUrl, formatMoney, createBalance } from '../src/balance.mjs'

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`PASS ${name}${extra ? '  ' + extra : ''}`) } else {
    fail += 1; failures.push(name); console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`)
  }
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)}`)

// ───────────────────────── 1. URL ─────────────────────────
eq('1.1 带 /v1 的 baseUrl 去掉 /v1', balanceUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/user/balance')
eq('1.2 不带 /v1 也照样拼', balanceUrl('https://api.deepseek.com'), 'https://api.deepseek.com/user/balance')
eq('1.3 结尾多个斜杠吃掉', balanceUrl('https://api.deepseek.com/v1///'), 'https://api.deepseek.com/user/balance')
eq('1.4 空 baseUrl 返回空串（不硬拼一个坏 URL）', balanceUrl(''), '')

// ───────────────────────── 2. 金额格式化 ─────────────────────────
eq('2.1 CNY 用 ¥', formatMoney(8.62, 'CNY'), '¥8.62')
eq('2.2 USD 用 $', formatMoney(3, 'USD'), '$3.00')
eq('2.3 非法值给空串（不能显示 ¥NaN）', formatMoney('abc'), '')
eq('2.4 字符串数字照样能用', formatMoney('12.5', 'CNY'), '¥12.50')

// ───────────────────────── 3. 正常响应 ─────────────────────────
function fakeFetch(responses) {
  let i = 0
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url, auth: opts?.headers?.Authorization })
    const r = responses[Math.min(i, responses.length - 1)]
    i += 1
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    }
  }
  fn.calls = calls
  return fn
}

const GOOD = {
  status: 200,
  body: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '8.62', granted_balance: '0.00', topped_up_balance: '8.62' }] },
}

{
  const f = fakeFetch([GOOD])
  const b = createBalance({ getAuth: () => ({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test' }), fetchImpl: f })
  const s = await b.snapshot()
  ok('3.1 解析成功', s.ok === true)
  eq('3.2 数字转成 number（不是字符串）', [s.total, s.granted, s.toppedUp], [8.62, 0, 8.62])
  eq('3.3 币种', s.currency, 'CNY')
  ok('3.4 请求带 Bearer 头', f.calls[0].auth === 'Bearer sk-test')
  ok('3.5 打到根上的 /user/balance', /^https:\/\/api\.deepseek\.com\/user\/balance$/.test(f.calls[0].url), f.calls[0].url)
}

// ───────────────────────── 4. 缓存 ─────────────────────────
{
  const f = fakeFetch([GOOD])
  const b = createBalance({ getAuth: () => ({ baseUrl: 'https://api.deepseek.com', apiKey: 'k' }), fetchImpl: f })
  await b.snapshot()
  await b.snapshot()
  eq('4.1 5 分钟内只请求一次', f.calls.length, 1)
  await b.snapshot({ force: true })
  eq('4.2 force 会真的再请求一次', f.calls.length, 2)
}

// ───────────────────────── 5. 降级 ─────────────────────────
{
  for (const status of [404, 401, 403]) {
    const b = createBalance({ getAuth: () => ({ baseUrl: 'https://api.mojito.com/v1', apiKey: 'k' }), fetchImpl: fakeFetch([{ status, body: 'nope' }]) })
    const s = await b.snapshot()
    ok(`5.${status} HTTP ${status} 标成 unsupported 且不抛`, s.ok === false && s.unsupported === true, JSON.stringify(s).slice(0, 90))
  }
  const b2 = createBalance({ getAuth: () => ({ baseUrl: 'https://x.com', apiKey: 'k' }), fetchImpl: async () => { throw new Error('ECONNRESET') } })
  const s2 = await b2.snapshot()
  ok('5.4 网络炸了也不抛', s2.ok === false && /ECONNRESET/.test(String(s2.error)))

  const b3 = createBalance({ getAuth: () => ({ baseUrl: 'https://x.com', apiKey: '' }) })
  const s3 = await b3.snapshot()
  ok('5.5 没配 key 直接说查不了（不发请求）', s3.ok === false && /key/.test(String(s3.error)))

  const b4 = createBalance({ getAuth: () => { throw new Error('没有 auth.json') }, fetchImpl: fakeFetch([GOOD]) })
  const s4 = await b4.snapshot()
  ok('5.6 getAuth 抛错也不崩', s4.ok === false && /auth\.json/.test(String(s4.error)))
}

// ───────────────────────── 6. 每轮那行文案 ─────────────────────────
{
  const rich = createBalance({
    getAuth: () => ({ baseUrl: 'https://api.deepseek.com', apiKey: 'k' }),
    fetchImpl: fakeFetch([{ status: 200, body: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '88.00' }] } }]),
    warnBelow: 5,
  })
  const line = await rich.turnLine()
  ok('6.1 余额充足：只报数，不带催款', /¥88\.00/.test(line) && !/低于/.test(line), line)

  const poor = createBalance({
    getAuth: () => ({ baseUrl: 'https://api.deepseek.com', apiKey: 'k' }),
    fetchImpl: fakeFetch([GOOD]),
    warnBelow: 5,
  })
  const line2 = await poor.turnLine()
  ok('6.2 余额低于阈值：带上「已低于」提醒', /¥8\.62/.test(line2) && /低于/.test(line2) === false, line2)
  // 8.62 > 5，所以上面不该带提醒；下面用一个更低的余额验证提醒真的会出现
  const veryPoor = createBalance({
    getAuth: () => ({ baseUrl: 'https://api.deepseek.com', apiKey: 'k' }),
    fetchImpl: fakeFetch([{ status: 200, body: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '0.80' }] } }]),
    warnBelow: 5,
  })
  const line3 = await veryPoor.turnLine()
  ok('6.3 真的低了才提醒（¥0.80 < ¥5）', /¥0\.80/.test(line3) && /低于/.test(line3), line3)

  const broken = createBalance({ getAuth: () => ({ baseUrl: 'https://x.com', apiKey: 'k' }), fetchImpl: fakeFetch([{ status: 404, body: '' }]) })
  const line4 = await broken.turnLine()
  ok('6.4 查不到就返回空串（宁可不提，绝不编数）', line4 === '', JSON.stringify(line4))
}

// ───────────────────────── 7. describe ─────────────────────────
{
  const b = createBalance({ getAuth: () => ({ baseUrl: 'https://api.deepseek.com', apiKey: 'k' }), fetchImpl: fakeFetch([GOOD]) })
  ok('7.1 还没查时描述明确', /还没查过/.test(b.describe()))
  await b.snapshot()
  ok('7.2 查过之后描述带金额', /¥8\.62/.test(b.describe()), b.describe())
}

console.log('')
console.log(`balance-unit: ${pass} PASS / ${fail} FAIL`)
if (fail) {
  console.log('失败项：' + failures.join(' | '))
  process.exitCode = 1
}
