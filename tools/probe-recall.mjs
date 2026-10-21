/**
 * probe-recall —— 回放一次真实会话，判断「记不住」是模型的锅还是接线的锅。
 *
 * 做法：从 `_sandbox-data/conversations/<b64>/` 读回冻结快照 + messages.jsonl，
 * 用**裸 llm.stream** 重放最后一问（不经 brain、不经 smoke 的累加器），
 * 分两个变体打印原始输出：
 *   A. 只有冻结系统前缀 + 历史（没有漂移块）—— 复现「旧记忆为空」的情形
 *   B. 在用户这句话后面补上真实漂移块（<memory_update>）—— 复现本轮实际发出的东西
 *
 * 用法：
 *   node tools/probe-recall.mjs
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const SANDBOX = process.env.ORB_DATA || join(ROOT, '_sandbox-data')
process.env.ORB_DATA = SANDBOX
mkdirSync(SANDBOX, { recursive: true })

const { createLLM } = await import('../src/llm.mjs')

// 上一次冒烟留下的会话（base64('conversation:smoke-20261019140503')）
const CONV = process.argv[2] || 'Y29udmVyc2F0aW9uOnNtb2tlLTIwMjYxMDE5MTQwNTAz'
const DIR = join(SANDBOX, 'conversations', CONV)

function readAuth() {
  const p = join(homedir(), '.legacy', 'lc-local-backend', 'providers', 'auth.json')
  const raw = JSON.parse(readFileSync(p, 'utf8'))
  const prov = raw.providers?.deepseek || raw.providers?.['openai-compatible']
  return { baseUrl: prov.base_url.replace(/\/+$/, ''), apiKey: prov.auth.key }
}

function readModel() {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
  return String(cfg.model || 'deepseek/deepseek-flash').split('/').pop() || 'deepseek-flash'
}

function loadSession() {
  const sys = JSON.parse(readFileSync(join(DIR, 'system.json'), 'utf8'))
  const rows = readFileSync(join(DIR, 'messages.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
  const msgs = rows.map((r) => ({ role: r.message.role, content: r.message.content[0].text }))
  return { sys, msgs }
}

async function ask(llm, messages, label) {
  let text = ''
  let usage = null
  console.log(`\n── ${label} ── 消息 ${messages.length} 条，system ${messages[0].content.length} 字`)
  for await (const ev of llm.stream({ messages, tools: [] })) {
    if (ev.type === 'content') text += ev.text
    if (ev.type === 'done') usage = ev.usage
  }
  console.log(`原始输出（${text.length} 字）：\n${text}`)
  if (usage) console.log(`usage prompt=${usage.promptTokens} hit=${usage.cacheHitTokens} miss=${usage.cacheMissTokens} out=${usage.completionTokens}`)
  return text
}

const { sys, msgs } = loadSession()
console.log(`会话 ${CONV}：${msgs.length} 条消息，快照 hash=${sys.hash}`)
console.log('历史：')
msgs.forEach((m, i) => console.log(`  [${i}] ${m.role} ${m.content.length} 字：${m.content.slice(0, 60).replace(/\n/g, ' ⏎ ')}`))

const auth = readAuth()
const llm = createLLM({ baseUrl: auth.baseUrl, apiKey: auth.apiKey, model: readModel(), timeoutMs: 120000 })

// 最后一问 = 最后一条 user；历史只到它之前（去掉它自己的回答）
const lastUserIdx = msgs.map((m) => m.role).lastIndexOf('user')
const history = msgs.slice(0, lastUserIdx)
const question = msgs[lastUserIdx]

// 记忆仓里现在的 MEMORY.md（漂移块要用的正是它）
const memDir = join(SANDBOX, 'memfs', 'orb-smoke-20261019140503', 'memory', 'MEMORY.md')
const memText = existsSync(memDir) ? readFileSync(memDir, 'utf8') : ''

const base = [{ role: 'system', content: sys.content }, ...history]
await ask(llm, [...base, question], 'A. 冻结前缀 + 历史（无漂移块）')

const drift = `\n\n---\n\n## 记忆更新（刚刚落盘）\n\n<memory_update path="MEMORY.md">\n${memText}\n</memory_update>`
await ask(llm, [...base, { role: 'user', content: question.content + drift }], 'B. 同一前缀，尾部补漂移块（本轮实际形态）')
