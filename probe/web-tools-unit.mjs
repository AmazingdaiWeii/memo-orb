/**
 * probe/web-tools-unit.mjs · 联网工具接线自检（无头、真 key、真查询）
 *
 * 验的是什么（P1 的四条硬要求）：
 *   1. 有 web 时 `brain.tools` 里有 search_web / fetch_url，没 web 时**一个都没有** ——
 *      工具列表与指南正文必须由同一个布尔量驱动，否则她会去调一个不存在的工具。
 *   2. 真查一次能拿到 results，真抓一页能拿到正文（走的是 brain.run 的完整工具循环，
 *      不是直接调 web.mjs —— 要验的是「接线」，不是「函数本身」）。
 *   3. 联网工具**不走审批**：全程 approve 调用次数必须是 0。
 *      （工作区文件工具才弹卡；把联网也塞进审批会让她每次查资料都等你点一下。）
 *   4. 没网时调用 search_web 得到的是「联网没接上」，不是异常，也不是静默成功。
 *   5. `fetch_url` 挡住内网地址（本机服务不能被模型随手读）。
 *
 * 跑法：`node probe\web-tools-unit.mjs`
 * 沙箱：`_sandbox-web-tools/`（每次跑前清空，不碰真实记忆仓）
 */

import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SANDBOX = join(ROOT, '_sandbox-web-tools')
const AGENT = 'web-tools-probe'

// ★ 必须在 import src/* 之前设：memory.mjs / session.mjs 都按 env 算数据根。
process.env.ORB_DATA = SANDBOX
process.env.ORB_LEGACY_DATA = SANDBOX

rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(SANDBOX, { recursive: true })

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const { createBrain } = await import('../src/brain.mjs')
const { createMemoryStore } = await import('../src/memstore.mjs')
const { createSettings } = await import('../src/settings.mjs')
const { createSnapshotService, GUIDE_VERSION } = await import('../src/snapshot.mjs')
const { createSessionStore } = await import('../src/session.mjs')
const { createWeb } = await import('../src/web.mjs')

// ── 凭据：直接读真 auth.json（沙箱里没有 providers/，不靠 readProviderAuth）──
const authJson = JSON.parse(readFileSync(join(ROOT, 'data', 'providers', 'auth.json'), 'utf8'))
const provider = authJson.providers?.deepseek ?? authJson.providers?.['openai-compatible']
const auth = { baseUrl: provider.base_url, apiKey: provider.auth.key }
check('读到真凭据', Boolean(auth.apiKey) && auth.apiKey.startsWith('sk-'), `${auth.baseUrl} key=${auth.apiKey.slice(0, 6)}…`)

const logs = []
const log = (m) => {
  logs.push(String(m))
  console.log(`  · ${m}`)
}

/**
 * 假 LLM：按脚本一轮一轮吐事件。
 * @param {Array<Array<object>>} script 每轮的 [{type:'tool_call'|'content', ...}]
 */
function fakeLLM(script) {
  let round = 0
  return {
    lastTools: null,
    async* stream({ tools }) {
      this.lastTools = tools
      const events = script[round++] ?? [{ type: 'content', text: '（没有更多脚本了）' }]
      for (const e of events) yield e
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    },
  }
}

/** 把 brain.run 的事件跑干，返回所有 tool 结果事件 */
async function drain(brain, sessionId, userText) {
  const toolResults = []
  const text = []
  for await (const ev of brain.run({ sessionId, userText })) {
    if (ev.type === 'tool' && ev.phase === 'result') toolResults.push(ev)
    if (ev.type === 'assistant' && ev.text) text.push(ev.text)
  }
  return { toolResults, text: text.join('') }
}

const memstore = await createMemoryStore({ engine: 'local', root: ROOT, agentId: AGENT })
const settings = createSettings({ configPath: join(SANDBOX, 'config.json'), log })
const snapshot = createSnapshotService({ memstore, settings, log })
const sessionStore = createSessionStore({ agentId: AGENT })
const web = createWeb({ auth, log })
check('createWeb 建起来了', Boolean(web) && typeof web.search === 'function')

// ── 场景 A：有网 ──────────────────────────────────────────
let approveCalls = 0
const approve = async () => {
  approveCalls += 1
  return { approved: true }
}

const brain = createBrain({
  llm: fakeLLM([
    [{ type: 'tool_call', id: 'c1', name: 'search_web', args: { query: 'DeepSeek 1017 模型 发布时间', count: 3 } }],
    [{ type: 'tool_call', id: 'c2', name: 'fetch_url', args: { url: 'https://api-docs.deepseek.com/updates' } }],
    [{ type: 'tool_call', id: 'c3', name: 'fetch_url', args: { url: 'http://127.0.0.1:9877/health' } }],
    [{ type: 'content', text: '查到了：1017 是 DeepSeek-V4.1-Flash-1017。' }],
  ]),
  memstore,
  persona: '你是球。',
  sessionStore,
  agentId: AGENT,
  settings,
  snapshot,
  log,
  approve,
  web,
})

const names = brain.tools.map((t) => t.function?.name)
check('工具列表含 search_web', names.includes('search_web'), names.join(','))
check('工具列表含 fetch_url', names.includes('fetch_url'))
check(
  'search_web 的 schema 描述了用法',
  String(brain.tools.find((t) => t.function?.name === 'search_web')?.function?.description ?? '').includes('site:'),
)

const A = await drain(brain, 'probe-web', '帮我查一下 1017 是什么模型')
const [r1, r2, r3] = A.toolResults.map((r) => ({ name: r.name, json: JSON.parse(r.result) }))

// 1) search
check('search_web 走完整工具循环拿到结果', r1?.json?.ok === true, `${r1?.json?.results?.length ?? 0} 条 ${r1?.json?.ms ?? '?'}ms`)
check('search_web 每条都有 url/title', (r1?.json?.results ?? []).every((it) => /^https?:\/\//.test(it.url) && it.title), r1?.json?.results?.[0]?.title ?? '')
// 上限 900 字 + 截断后缀 '…（截断）' 5 字符 ⇒ 实际最长 905（suffix 也算长度，别把上限当总长）
check('search_web 的 summary 被裁到 900 字内（含 5 字符截断后缀，故 ≤905）', (r1?.json?.results ?? []).every((it) => it.summary.length <= 905), `最长 ${Math.max(0, ...(r1?.json?.results ?? []).map((i) => i.summary.length))} 字`)

// 2) fetch
check('fetch_url 拿到正文', r2?.json?.ok === true, `${r2?.json?.content?.length ?? 0} 字 ${r2?.json?.ms ?? '?'}ms title=${r2?.json?.title ?? ''}`)
check('fetch_url 正文非空且是 Markdown 样文本', (r2?.json?.content?.length ?? 0) > 200 && String(r2?.json?.content).includes('#'))

// 3) 内网拦截
check('fetch_url 挡住本机地址', r3?.json?.ok === false && /内网|本机/.test(String(r3?.json?.error)), r3?.json?.error ?? '')

// 4) 回合收口
check('回合正文正常产出', A.text.includes('1017'), A.text.slice(0, 60))
check('联网全程没弹审批', approveCalls === 0, `approve 调用 ${approveCalls} 次`)

// 5) 指南与 schema 同源
const snapWeb = await snapshot.capture({ persona: '你是球。', toolSchemas: brain.tools, web: true })
check('有网时指南含「你的眼睛（联网）」', snapWeb.content.includes('## 你的眼睛（联网）'))
check('指南版本号 = GUIDE_VERSION', snapWeb.guideVersion === GUIDE_VERSION, `guideVersion=${snapWeb.guideVersion}`)

// ── 场景 B：没网 ──────────────────────────────────────────
let approveB = 0
const brainNoWeb = createBrain({
  llm: fakeLLM([
    [{ type: 'tool_call', id: 'n1', name: 'search_web', args: { query: '随便查点什么' } }],
    [{ type: 'content', text: '我这会儿查不了。' }],
  ]),
  memstore,
  persona: '你是球。',
  sessionStore,
  agentId: AGENT,
  settings,
  snapshot,
  log,
  approve: async () => {
    approveB += 1
    return { approved: true }
  },
  web: null,
})

const namesB = brainNoWeb.tools.map((t) => t.function?.name)
check('没网时工具列表里没有 search_web', !namesB.includes('search_web'), namesB.join(','))
check('没网时工具列表里没有 fetch_url', !namesB.includes('fetch_url'))

const B = await drain(brainNoWeb, 'probe-noweb', '查一下')
const bJson = JSON.parse(B.toolResults[0]?.result ?? '{}')
check('没网时调用被明确拒绝', bJson?.ok === false && /联网没接上/.test(String(bJson?.error)), bJson?.error ?? '')
check('没网时也没弹审批', approveB === 0)

const snapNoWeb = await snapshot.capture({ persona: '你是球。', toolSchemas: brainNoWeb.tools, web: false })
check('没网时指南不提眼睛', !snapNoWeb.content.includes('## 你的眼睛（联网）'))
check('没网时指南明说连不上网', snapNoWeb.content.includes('联网，你都做不到'))
check(
  '有网/没网两份 system prompt 的 hash 不同',
  snapWeb.hash !== snapNoWeb.hash,
  `${snapWeb.hash.slice(0, 12)}… vs ${snapNoWeb.hash.slice(0, 12)}…`,
)

// ── 汇总 ────────────────────────────────────────────────
const pass = results.filter((r) => r.ok).length
const fail = results.length - pass
console.log(`\n===== ${pass} PASS / ${fail} FAIL（共 ${results.length} 条）=====`)
if (fail > 0) {
  for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ ${r.name} ${r.detail}`)
  process.exit(1)
}
process.exit(0)
