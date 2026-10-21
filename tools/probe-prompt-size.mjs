/**
 * probe-prompt-size —— 用假 LLM 截获 brain 真正发出去的 messages，量一下体积。
 *
 * 目的：真实 API 返回的 prompt_tokens 与「按字符估」差得太远时，
 * 靠这个探针就能看出是 system 太长、历史太长，还是工具 schema 太长。
 * 不联网、不写记忆（memstore 用内存假实现）。
 */

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

const { createBrain } = await import('../src/brain.mjs')
const { readPersona } = await import('../src/persona.mjs')
const { estimateTokens } = await import('../src/settings.mjs')

const submissions = []
const stubLlm = {
  async *stream({ messages, tools }) {
    submissions.push({ messages, tools })
    yield { type: 'content', id: 'a1', text: '收到。' }
    yield { type: 'done', stopReason: 'stop', usage: null }
  },
}

const files = new Map([
  ['MEMORY.md', '# 记忆\n\n## 关于他\n- 名字：阿澈\n- 爱喝冰美式，不加糖\n- 最讨厌香菜\n'],
])
const stubMemstore = {
  async list() {
    return { files: [...files.keys()].map((p) => ({ path: p, bytes: files.get(p).length })) }
  },
  async read(p) {
    return files.get(p) ?? ''
  },
  async write(p, c) {
    files.set(p, c)
    return { sha: 'stub' }
  },
  async search() {
    return []
  },
  async appendJournal({ text }) {
    return { path: 'journal/x.md', sha: 'stub', bytes: text.length }
  },
  async digests() {
    return { 'MEMORY.md': 'deadbeef' }
  },
  async head() {
    return 'stubhead'
  },
}

const systemTexts = []
const stubSnapshot = {
  async capture({ persona }) {
    const content = `${persona}\n\n---\n\n## 长期记忆\n\n${files.get('MEMORY.md')}`
    systemTexts.push(content)
    return { hash: 'h1', content, memfsCommit: 'stubhead', fileHashes: { 'MEMORY.md': 'deadbeef' }, frozenAt: new Date().toISOString() }
  },
  async drift() {
    return { changed: [], text: '', bytes: 0, overflow: false }
  },
}

const settings = {
  get: () => ({ contextBudgetTokens: 24000, modelContextTokens: 1000000, compactMode: 'off', keepRecentMessages: 12, memorySoftLimitBytes: 4096, memoryUpdateMaxBytes: 3072 }),
  estimateTokens,
}

const sessions = new Map()
// ★ 会话存储是**同步**接口（session.mjs 用 readFileSync/writeFileSync），
//   这里必须照抄同步语义：写成 async 会让 brain 的 `await` 把 null 展开成空。
const stubSessions = {
  readSystem(id) {
    return sessions.get(id)?.system ?? null
  },
  writeSystem(id, snap) {
    const cur = sessions.get(id) ?? {}
    sessions.set(id, { ...cur, system: snap })
  },
  readMessages(id) {
    return sessions.get(id)?.messages ?? []
  },
  appendMessage(id, msg) {
    const cur = sessions.get(id) ?? { messages: [] }
    cur.messages.push(msg)
    sessions.set(id, cur)
  },
  create(id) {
    sessions.set(id, { messages: [] })
  },
  exists(id) {
    return sessions.has(id)
  },
}

const persona = readPersona('chat', {}).text
const brain = createBrain({
  llm: stubLlm,
  memstore: stubMemstore,
  persona,
  sessionStore: stubSessions,
  agentId: 'probe',
  settings,
  snapshot: stubSnapshot,
  log: (m) => console.log('[log]', m),
  onTurnIdle: () => {},
})

async function turn(text) {
  for await (const _ of brain.run({ sessionId: 'probe-session', userText: text })) {
    /* 只为截获请求 */
  }
}

await turn('你好，我叫阿澈，喜欢冰美式不加糖，讨厌香菜。')
await turn('我叫什么？喜欢喝什么？有什么忌口？')

const last = submissions.slice(-1)[0]
const sysChars = last.messages.filter((m) => m.role === 'system').map((m) => m.content.length)
const toolChars = JSON.stringify(last.tools ?? []).length
const bodyChars = JSON.stringify(last.messages).length
console.log('—— 最后一次请求 ——')
console.log('消息条数', last.messages.length, '角色', last.messages.map((m) => m.role).join(','))
console.log('system 字数', sysChars, '≈', Math.ceil(sysChars[0] / 1.8), 'token')
console.log('工具 schema 字数', toolChars, '≈', Math.ceil(toolChars / 1.8), 'token')
console.log('整包 JSON 字数', bodyChars, '≈', estimateTokens('x'.repeat(bodyChars)), 'token')
for (const [i, m] of last.messages.entries()) {
  const s = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  console.log(`  [${i}] ${m.role} ${s.length} 字  ${s.slice(0, 60).replace(/\n/g, ' ⏎ ')}`)
}
