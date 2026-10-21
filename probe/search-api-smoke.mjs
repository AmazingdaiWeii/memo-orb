/**
 * DeepSeek 原生 Search / Fetch API 冒烟探针
 *
 * 验的是「她的眼睛」这条链路的第一环：用**现成的** DeepSeek key 能不能调通
 *   POST https://api.deepseek.com/v1/tools/search
 *   POST https://api.deepseek.com/v1/tools/fetch
 *
 * 官方文档：https://api-docs.deepseek.com/guides/search/
 * 这一步不碰产品代码，只证明「不需要第三方搜索 key」这个前提成立。
 *
 * 跑法：node probe/search-api-smoke.mjs
 * 产物：无（只看 stdout 的 PASS/FAIL 与耗时）
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = process.env.ORB_DATA ? resolve(process.env.ORB_DATA) : resolve(ROOT, 'data')
const AUTH = resolve(DATA, 'providers', 'auth.json')

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) {
    pass += 1
    console.log(`  ✅ ${label}${extra ? ' — ' + extra : ''}`)
  } else {
    fail += 1
    console.log(`  ❌ ${label}${extra ? ' — ' + extra : ''}`)
  }
}

function readKey() {
  const j = JSON.parse(readFileSync(AUTH, 'utf8'))
  const provs = j.providers ?? {}
  const pick =
    provs.deepseek ??
    Object.values(provs).find((p) => String(p?.base_url ?? '').includes('api.deepseek.com'))
  if (!pick) throw new Error('auth.json 里没有指向 api.deepseek.com 的 provider')
  const key = pick?.auth?.key
  if (!key) throw new Error('provider 没有 auth.key')
  return { key, baseUrl: String(pick.base_url || 'https://api.deepseek.com/v1').replace(/\/+$/, '') }
}

async function postJson(url, key, body, timeoutMs = 30_000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON 由调用方判 */
    }
    return { status: res.status, json, text, ms: Date.now() - t0 }
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  console.log('=== DeepSeek Search / Fetch 冒烟 ===')
  console.log(`auth : ${AUTH}`)
  if (!readKey) throw new Error('unreachable')
  const { key, baseUrl } = readKey()
  // 只露 baseUrl 与前 6 位，避免把 key 打进日志
  console.log(`base : ${baseUrl}  key=${key.slice(0, 6)}… (${key.length} 字符)`)
  // /v1 已经在 baseUrl 里；tools 端点在 baseUrl 之下
  const searchUrl = `${baseUrl}/tools/search`
  const fetchUrl = `${baseUrl}/tools/fetch`

  console.log('\n[1] search：中文查询 + count=3')
  const s = await postJson(searchUrl, key, {
    query: 'DeepSeek V4.1 Flash 1017 发布',
    count: 3,
    need_content: false,
  })
  ok(s.status === 200, 'HTTP 200', `status=${s.status} ${s.ms}ms`)
  if (s.status !== 200) {
    console.log('  响应：', String(s.text).slice(0, 400))
    return
  }
  const results = s.json?.results
  ok(Array.isArray(results), 'results 是数组', `count=${results?.length}`)
  ok((results?.length ?? 0) > 0, '至少一条结果')
  const first = results?.[0] ?? {}
  ok(typeof first.title === 'string' && first.title.length > 0, 'title 非空', first.title)
  ok(typeof first.url === 'string' && /^https?:\/\//.test(first.url), 'url 合法', first.url)
  ok(typeof first.summary === 'string' && first.summary.length > 0, 'summary 非空', `${first.summary?.length ?? 0} 字`)
  ok(first.content === '', 'need_content=false 时 content 为空串')
  console.log(`  前三条：`)
  for (const r of results.slice(0, 3)) {
    console.log(`   · [${r.rerank_score ?? '?'}] ${r.title}\n     ${r.url}  (authority=${r.authority}, date=${r.date ?? 'null'})`)
  }

  console.log('\n[2] search：site: 操作符 + need_content=true')
  const s2 = await postJson(searchUrl, key, {
    query: 'api docs site:api-docs.deepseek.com',
    count: 2,
    need_content: true,
  })
  ok(s2.status === 200, 'HTTP 200', `status=${s2.status} ${s2.ms}ms`)
  const r2 = s2.json?.results ?? []
  ok(r2.length > 0, '有结果', `count=${r2.length}`)
  const withContent = r2.filter((r) => typeof r.content === 'string' && r.content.length > 0)
  ok(withContent.length > 0, 'need_content=true 时至少一条带正文', `最长 ${Math.max(0, ...r2.map((r) => r.content?.length ?? 0))} 字`)

  console.log('\n[3] fetch：抓第一条结果的正文')
  const f = await postJson(fetchUrl, key, { url: first.url }, 40_000)
  ok(f.status === 200, 'HTTP 200', `status=${f.status} ${f.ms}ms`)
  if (f.status === 200) {
    ok(typeof f.json?.title === 'string', 'title 字段存在', f.json?.title ?? '(空)')
    ok(typeof f.json?.content === 'string' && f.json.content.length > 200, 'content 是 Markdown 且够长', `${f.json?.content?.length ?? 0} 字`)
    console.log(`  正文前 200 字：\n  ${String(f.json.content).slice(0, 200).replace(/\n/g, '\n  ')}`)
  } else {
    console.log('  响应：', String(f.text).slice(0, 400))
    console.log('  （404 表示该站点拿不到可提取正文，不代表接口不通）')
  }

  console.log('\n[4] 错误路径：count 越界必须 400')
  const bad = await postJson(searchUrl, key, { query: 'x', count: 99 })
  ok(bad.status === 400, 'count=99 → 400', `status=${bad.status} code=${bad.json?.error?.code}`)
  ok(!!bad.json?.error?.message, '错误体带 message', String(bad.json?.error?.message).slice(0, 80))

  console.log('\n[5] 错误路径：空 query 必须 400')
  const bad2 = await postJson(searchUrl, key, { query: '   ' })
  ok(bad2.status === 400, '空白 query → 400', `status=${bad2.status}`)

  console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('探针异常：', err?.stack ?? err)
  process.exit(1)
})
