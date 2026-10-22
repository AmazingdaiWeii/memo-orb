/**
 * 无头新建 agent —— 出厂化之后、用户还没说过话时，先把 agent 建出来并把人格烤进 system。
 *
 * 为什么需要它：
 *   `ensureRuntime()`（src/main.mjs:1944）是**唯一**会建 agent 的生产路径，
 *   而它只在用户发出第一条消息时才走（`drainTurns` 是唯一调用者）。
 *   于是「出厂化之后」有个空窗：agent 还不存在，任何校验（persona 指纹、
 *   agent json 结构）都做不了，只能干等用户先说一句话。
 *   本脚本把这段空窗补上 —— **用产品自己的 `startRuntime()`**，参数与
 *   `ensureRuntime()` 的新建分支逐条对齐，不另造一套协议。
 *
 * ★ 与 ensureRuntime 的对齐清单（改 main.mjs 时这里要同步看）：
 *     agentId        : null                       ← 传了就是复用，不传才新建
 *     model          : config.model
 *     name           : agentNameFor(mode)         = config.agentName ?? 'Orb'
 *     description    : agentDescriptionFor(mode)  = '闲聊模式：陪伴向'
 *     system         : personaFor(mode)           ← 人格在这一刻烤进去
 *     conversationId : null                       ⇒ create_conversation
 *     permission     : config.permission
 *
 * ⚠️ 只建**空会话**，不发用户消息 ⇒ 记忆是真空的，不会留下「你好」这种测试残留。
 *
 * 用法：
 *   node tools/create-agent.mjs                 # 建 agent（只有闲聊态一档）
 *   node tools/create-agent.mjs --dry-run       # 只算指纹，不建
 *
 * 建完把 agent id 写回 config.json（agents.<mode> + agentId 兼容别名），
 * 与 `rememberAgent()` 的落盘口径一致。已存在时拒绝覆盖，除非 --force。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LegacyConnection, startLegacyServer, startRuntime } from '../src/legacy-engine.mjs'
import { MODES, ROOT, readPersona } from '../src/persona.mjs'

const CONFIG = join(ROOT, 'config.json')
const LEGACY_JS = join(ROOT, 'node_modules', '@legacy-ai', 'legacy-code', 'legacy.js')

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const force = argv.includes('--force')
const mi = argv.indexOf('--mode')
const mode = mi >= 0 ? argv[mi + 1] : 'chat'

// 2026-10-19 断脐后本工程零 npm 依赖，这个工具只在 engine=legacy 的老路径下还有意义。
if (!dryRun && !existsSync(LEGACY_JS)) {
  console.error('这个工具要给旧后端建 agent，但本工程已剥离旧后端（零依赖，node_modules 已删除）。')
  console.error('现役引擎是 local：agentId 直接写 config.json（agentId / agents.chat），数据在 data/ 下，不需要建 agent。')
  console.error('真要回到旧后端：先 npm install @legacy-ai/legacy-code，再把 config.json 的 engine 改回 legacy。')
  process.exit(2)
}

if (!MODES.includes(mode)) {
  console.error(`--mode 只能是 ${MODES.join(' / ')}`)
  process.exit(2)
}

const config = JSON.parse(readFileSync(CONFIG, 'utf8'))
const persona = readPersona(mode)

console.log(`=== 无头新建 agent · mode=${mode}${dryRun ? '  (DRY RUN)' : ''} ===`)
console.log(`  模型   : ${config.model}`)
console.log(`  名字   : ${config.agentName ?? 'Orb'}`)
console.log(`  persona: ${persona.chars} 字符 · ${persona.sha256.slice(0, 16)}`)

const existing = config.agents?.chat ?? config.agentId
if (existing && !force) {
  console.error(`\n❌ config.json 里已经有 ${mode} 的 agent（${existing}）。`)
  console.error('   本脚本只用于「出厂后首次建 agent」。要重建请先 --apply 出厂化，')
  console.error('   或确认后加 --force。')
  process.exit(1)
}

if (dryRun) {
  console.log('\n(DRY RUN：未建 agent、未写 config)')
  process.exit(0)
}

// ---------------------------------------------------------------- 起后端
console.log('\n=== 启动旧后端服务端 ===')
const { child, wsUrl } = await startLegacyServer({ legacyJs: LEGACY_JS, cwd: ROOT })
console.log(`  就绪：${wsUrl}`)

const conn = new LegacyConnection(wsUrl)
await conn.connect()
console.log('  已连接')

try {
  console.log('\n=== 建 agent（这一步可能要 8~40 秒）===')
  const { runtime, agent, created } = await startRuntime(conn, {
    agentId: null,
    model: config.model,
    name: config.agentName ?? 'Orb',
    description: '闲聊模式：陪伴向',
    system: persona.text,
    conversationId: null,
    permission: config.permission,
  })

  const agentId = agent?.id ?? runtime?.agent_id
  if (!agentId) throw new Error('后端没回 agent id')

  console.log(`  ✅ 已建 agent ${agentId}`)
  console.log(`     conversation = ${runtime?.conversation_id ?? '(无)'}`)
  console.log(`     created      = ${JSON.stringify(created ?? null).slice(0, 120)}`)

  // ------------------------------------------------------------ 落盘
  if (!config.agents) config.agents = {}
  config.agents[mode] = agentId
  if (mode === 'chat') config.agentId = agentId   // 兼容别名保持一致
  writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8' })
  console.log(`\n  已写入 config.json：agents.${mode} = ${agentId}`)

  console.log('\n下一步：重启 orb 生效（persona 已写进 config，启动时整篇注入 system）')
} finally {
  try { conn.close() } catch { /* noop */ }
  try { child.kill() } catch { /* noop */ }
}
process.exit(0)
