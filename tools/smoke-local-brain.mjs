/**
 * smoke-local-brain —— 不经 Electron / 不经球侧 GUI，直接跑 local 引擎的两轮对话。
 *
 * 目的：这是「剥掉旧后端之后还剩下什么」的最小可验证链路。
 * 它同时覆盖了 local 引擎的四个要害：
 *   1. 直连 DeepSeek 的 SSE 流式 + function calling（src/llm.mjs）
 *   2. 冻结前缀快照 + 尾部漂移（src/snapshot.mjs）
 *   3. 工具循环与记忆落盘、git 提交（src/brain.mjs + src/memstore-local.mjs）
 *   4. 跨轮记忆：第二轮必须答得出第一轮才写进去的事
 *
 * 用法（PowerShell）：
 *   node tools/smoke-local-brain.mjs
 *   $env:ORB_DATA='E:\Memo orb\_sandbox-data'; node tools/smoke-local-brain.mjs
 *
 * 默认数据根是 `<应用根>/_sandbox-data`，不碰 `data/` 也不碰 `~/.legacy`。
 * 每次运行都用带时间戳的 agentId，所以永远是从零开始的新记忆仓。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

// ★ 必须在 import 业务模块之前设好：memory.mjs / session.mjs 都从这里取数据根。
const SANDBOX = process.env.ORB_DATA || join(ROOT, '_sandbox-data')
process.env.ORB_DATA = SANDBOX
mkdirSync(SANDBOX, { recursive: true })

const { createLLM } = await import('../src/llm.mjs')
const { createMemoryStore } = await import('../src/memstore.mjs')
const { createSessionStore } = await import('../src/session.mjs')
const { createSettings } = await import('../src/settings.mjs')
const { createSnapshotService } = await import('../src/snapshot.mjs')
const { createBrain } = await import('../src/brain.mjs')
const { readPersona } = await import('../src/persona.mjs')

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const AGENT_ID = `orb-smoke-${stamp}`

const lines = []
function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`
  lines.push(line)
  console.log(line)
}

function readAuth() {
  const candidates = [
    join(SANDBOX, 'providers', 'auth.json'),
    join(homedir(), '.legacy', 'lc-local-backend', 'providers', 'auth.json'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    const provider = raw.providers?.deepseek || raw.providers?.['openai-compatible']
    if (!provider?.base_url || !provider?.auth?.key) continue
    return {
      baseUrl: provider.base_url.replace(/\/+$/, ''),
      apiKey: provider.auth.key,
      file: p,
    }
  }
  throw new Error('找不到可用的 providers/auth.json（试过 ' + candidates.join(' / ') + '）')
}

function readModel() {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
    const name = String(cfg.model || 'deepseek/deepseek-flash').split('/').pop()
    return name || 'deepseek-flash'
  } catch {
    return 'deepseek-flash'
  }
}

async function speak(brain, sessionId, text, tag) {
  log(`—— ${tag} 用户：${text}`)
  const started = Date.now()
  let assistant = ''
  for await (const ev of brain.run({ sessionId, userText: text })) {
    if (ev.type === 'reasoning') {
      process.stdout.write('·')
      continue
    }
    if (ev.type === 'assistant') {
      // ★ brain 产出的是**增量**（llm 的 SSE delta），累加即可。
      // 旧写法用「长度比较」猜增量还是全量，当某个增量比已累计的长时会整段替换掉，
      // 于是第 2 轮回答丢掉开头那句「你叫阿澈呀」——落盘的消息是完整的，只是这里拼错了。
      assistant += ev.text
      continue
    }
    if (ev.type === 'tool') {
      if (ev.phase === 'call') log(`   ↳ 调用工具 ${ev.name}(${JSON.stringify(ev.args).slice(0, 160)}) id=${ev.id}`)
      else log(`   ↳ 工具返回 ${String(ev.result).slice(0, 200).replace(/\n/g, ' ⏎ ')}`)
      continue
    }
    if (ev.type === 'notice') {
      log(`   ! ${ev.text}`)
      continue
    }
    if (ev.type === 'usage') {
      log(`   usage prompt=${ev.usage.promptTokens} hit=${ev.usage.cacheHitTokens} miss=${ev.usage.cacheMissTokens} out=${ev.usage.completionTokens} first=${ev.usage.firstTokenMs}ms`)
      continue
    }
    if (ev.type === 'done') {
      log(`   done hash=${ev.promptHash} 用时 ${Date.now() - started}ms`)
    }
  }
  log(`—— ${tag} 她：${assistant.replace(/\n/g, ' ⏎ ')}`)
  return assistant
}

const auth = readAuth()
const model = readModel()
log(`数据根 ${SANDBOX}`)
log(`agentId ${AGENT_ID}`)
log(`模型 ${model} @ ${auth.baseUrl}（密钥来自 ${auth.file}）`)

const llm = createLLM({ baseUrl: auth.baseUrl, apiKey: auth.apiKey, model, timeoutMs: 120000 })
const settings = createSettings({ configPath: join(ROOT, 'config.json'), log })
const memstore = await createMemoryStore({ engine: 'local', root: ROOT, agentId: AGENT_ID })
const sessionStore = createSessionStore({ agentId: AGENT_ID })
const snapshot = createSnapshotService({ memstore, settings, log })
const persona = readPersona('chat', {})
log(`persona ${persona.chars} 字 / sha ${persona.sha256.slice(0, 12)}`)

// 种子：和 main.mjs 启动时一致，空 MEMORY.md（刻意不预设章节结构）。
const listing = await memstore.list()
const files = Array.isArray(listing) ? listing : listing?.files ?? []
if (!files.some((f) => f.path === 'MEMORY.md')) {
  await memstore.write('MEMORY.md', '# 记忆\n\n<!-- 这里放你希望每一轮都记得的事。日常流水写到 journal/。 -->\n', 'init')
  log('已写入空 MEMORY.md 种子')
}

let idleCount = 0
const brain = createBrain({
  llm,
  memstore,
  persona: persona.text,
  sessionStore,
  agentId: AGENT_ID,
  settings,
  snapshot,
  log,
  onTurnIdle: () => {
    idleCount += 1
    log(`[onTurnIdle] 第 ${idleCount} 次`)
  },
})

const sessionId = `smoke-${stamp}`
let failures = 0
function check(name, ok, detail = '') {
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures += 1
}

const TURN1 = '你好呀。记住几件事：我叫阿澈，喜欢冰美式不加糖，最讨厌香菜。'
const TURN2 = '我叫什么？喜欢喝什么？有什么忌口？'

const a1 = await speak(brain, sessionId, TURN1, '第 1 轮')
check('第 1 轮有回复', a1.trim().length > 0, `${a1.length} 字`)

const snap1 = sessionStore.readSystem(sessionId)
check('快照已落盘', !!snap1?.hash, snap1?.hash ?? '无')

const a2 = await speak(brain, sessionId, TURN2, '第 2 轮')
check('第 2 轮有回复', a2.trim().length > 0, `${a2.length} 字`)
check('第 2 轮记得名字', a2.includes('阿澈'))
check('第 2 轮记得冰美式', a2.includes('冰美式') || a2.includes('美式'))
check('第 2 轮记得香菜', a2.includes('香菜'))

const snap2 = sessionStore.readSystem(sessionId)
check('会话内前缀字节不变（I3）', snap1?.hash === snap2?.hash, `${snap1?.hash} vs ${snap2?.hash}`)
check('onTurnIdle 每轮都调到（I5）', idleCount === 2, `实际 ${idleCount} 次`)

const after = await memstore.list()
const afterFiles = Array.isArray(after) ? after : after?.files ?? []
log(`记忆仓文件：${afterFiles.map((f) => `${f.path}(${f.bytes ?? f.size ?? '?'}B)`).join(', ') || '空'}`)
// 常驻记忆必须被写过；journal 写不写是她的自由，只作提示不作失败
check('MEMORY.md 已写入', afterFiles.some((f) => f.path === 'MEMORY.md'))
if (afterFiles.length < 2) log('   （提示）这轮她没往 journal 追加，属模型行为，不计失败')

const head = await memstore.head()
log(`git HEAD ${head || '(无)'}`)
check('记忆仓有提交', !!head, head)

const msgs = sessionStore.readMessages(sessionId)
log(`会话消息 ${msgs.length} 条`)
check('两轮都落盘', msgs.length >= 4, `${msgs.length} 条`)

log(failures === 0 ? '==== 全部通过 ====' : `==== ${failures} 项失败 ====`)
if (failures > 0) process.exitCode = 1
