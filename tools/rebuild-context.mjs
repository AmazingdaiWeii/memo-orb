/**
 * rebuild-context —— 手动重渲染某个会话的冻结前缀（`system.json`）。
 *
 * 为什么需要它：
 *   1. 验收 A6 要求「压缩之后上下文能重建」——这个脚本就是那个入口；
 *   2. 记忆仓被外部改动过（手工编辑、git 合并、从备份恢复）后，希望立刻生效；
 *   3. 快照里混进了坏文本（比如残留的 `<memory_update>`），想重来一份。
 *
 * 语义（重要）：
 *   - **保留** `boundaryMsgId` 与 `summary`：重建的是「冻结前缀里的记忆部分」，
 *     不是「把压缩白做一遍」。要丢掉摘要请显式加 `--drop-summary`。
 *   - 重建会**改变 promptHash**（记忆变了，前缀当然变），这是管理员操作，不是运行期行为。
 *     运行期的常态是「前缀不变、改动只从尾部 `<memory_update>` 进」（I3/I4）。
 *   - 只动 `system.json`，**不碰 messages.jsonl 一行**（I1）。
 *
 * 用法：
 *   node tools/rebuild-context.mjs                        # 列出可选会话
 *   node tools/rebuild-context.mjs --session local-orb-1  # 预览重建（不写盘）
 *   node tools/rebuild-context.mjs --session local-orb-1 --write
 *   node tools/rebuild-context.mjs --session x --data "E:\Memo orb\_sandbox-data" --write
 *
 * 参数：
 *   --session <id>     会话 id（不带会话 id 时列出该 agent 的会话）
 *   --agent <id>       agentId，缺省读 config.json 的 agents.chat / agentId
 *   --data <dir>       数据根，缺省 $env:ORB_DATA，再缺省 `<应用根>/data`
 *   --mode <chat>      persona 档位（只有 chat；'work' 已退役）
 *   --write            真的写盘（缺省只预览）
 *   --drop-summary     丢弃压缩摘要（默认保留）
 *   --force            会话还没有快照时也造一份
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

// ── 参数 ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
function arg(name, fallback = null) {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const flag = (name) => argv.includes(`--${name}`)

const DATA_DIR = typeof arg('data') === 'string' ? resolve(arg('data')) : null
// ★ 必须在 import 业务模块之前设好：memory.mjs / session.mjs 都从这里取数据根。
if (DATA_DIR) process.env.ORB_DATA = DATA_DIR

const { dataRoot } = await import('../src/memory.mjs')
const { createMemoryStore } = await import('../src/memstore.mjs')
const { createSessionStore } = await import('../src/session.mjs')
const { createSettings } = await import('../src/settings.mjs')
const { createSnapshotService, hashPrompt } = await import('../src/snapshot.mjs')
const { estimateContextTokens } = await import('../src/compact.mjs')
const { createBrain } = await import('../src/brain.mjs')
const { readPersona } = await import('../src/persona.mjs')

const lines = []
function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`
  lines.push(line)
  console.log(line)
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

const cfg = readConfig()
const agentId = String(arg('agent') || cfg.agents?.chat?.id || cfg.agents?.chat || cfg.agentId || '')
if (!agentId) {
  console.error('找不到 agentId：请用 --agent 指定，或在 config.json 里配 agentId')
  process.exit(2)
}
const mode = String(arg('mode') || 'chat')

const root = dataRoot()
log(`数据根 ${root}`)
log(`agentId ${agentId}`)

const sessionStore = createSessionStore({ agentId })
const sessionId = typeof arg('session') === 'string' ? arg('session') : null

// ── 没给会话：列出这个 agent 的会话 ──────────────────────────────────
function decodeDirName(name) {
  try {
    const text = Buffer.from(name + '=='.slice(0, (4 - (name.length % 4)) % 4), 'base64').toString('utf8')
    return text.startsWith('conversation:') ? text.slice('conversation:'.length) : null
  } catch {
    return null
  }
}

if (!sessionId) {
  const convDir = join(root, 'conversations')
  if (!existsSync(convDir)) {
    log('还没有任何会话')
    process.exit(0)
  }
  const rows = []
  for (const name of readdirSync(convDir)) {
    const id = decodeDirName(name)
    if (!id) continue
    const meta = sessionStore.getMeta(id)
    if (!meta) continue
    if (meta.agent_id && meta.agent_id !== agentId) continue
    const msgs = sessionStore.readMessages(id)
    const snap = sessionStore.readSystem(id)
    rows.push({ id, msgs: msgs.length, hash: snap?.hash ?? '(无快照)', updated: meta.last_message_at || '' })
  }
  if (!rows.length) {
    log('这个 agent 下没有会话')
    process.exit(0)
  }
  log(`共 ${rows.length} 个会话（用 --session <id> 选中一个）：`)
  for (const r of rows) {
    log(`  ${r.id}  消息 ${r.msgs} 条  ${String(r.hash).slice(0, 20)}  ${r.updated}`)
  }
  process.exit(0)
}

// ── 重建 ─────────────────────────────────────────────────────────────
const old = sessionStore.readSystem(sessionId)
const history = sessionStore.readMessages(sessionId)
if (!sessionStore.exists(sessionId) && !history.length) {
  console.error(`会话 ${sessionId} 不存在（没有 conversation.json，也没有消息）`)
  process.exit(2)
}
if (!old && !flag('force')) {
  console.error(`会话 ${sessionId} 还没有快照；下一轮对话会自动生成。要现在造一份加 --force`)
  process.exit(2)
}

const persona = readPersona(mode, {})
const memstore = await createMemoryStore({ engine: 'local', root: ROOT, agentId })
const settings = createSettings({ configPath: join(ROOT, 'config.json'), log })
const snapshot = createSnapshotService({ memstore, settings, log })

// 工具清单必须和 brain 实际用的一致：hash = sha256(content + 工具 schema)，
// 用别的清单算出来的 hash 和运行期对不上（虽然不影响发请求，但会误导排查）。
const brain = createBrain({
  llm: { stream() { throw new Error('rebuild-context: 这里不该发起模型请求') } },
  memstore,
  persona: persona.text,
  sessionStore,
  agentId,
  settings,
  snapshot,
  log: () => {},
})

const dropSummary = flag('drop-summary')
const summary = dropSummary ? '' : old?.summary ?? ''
const boundaryMsgId = dropSummary ? null : old?.boundaryMsgId ?? null

const fresh = await snapshot.capture({ persona: persona.text, toolSchemas: brain.tools })
const content = summary ? `${fresh.content}\n\n---\n\n## 更早的对话摘要\n\n${summary}` : fresh.content
const next = {
  ...fresh,
  content,
  hash: hashPrompt(content, brain.tools),
  boundaryMsgId,
  summary,
}

const windowed = boundaryMsgId
  ? history.slice(Math.max(0, history.findIndex((m) => m.id === boundaryMsgId) + 1))
  : history
const est = estimateContextTokens({ systemText: content, messages: windowed })

log('—— 重建结果 ——')
log(`promptHash  ${old?.hash ?? '(无旧快照)'}  →  ${next.hash}`)
log(`前缀大小    ${old?.content ? Buffer.byteLength(old.content, 'utf8') : 0} B  →  ${Buffer.byteLength(content, 'utf8')} B`)
log(`persona     ${persona.mode} 档 ${persona.chars} 字 / sha ${persona.sha256.slice(0, 12)}`)
log(`记忆 commit ${next.memfsCommit || '(无)'}`)
log(`改动文件    ${Object.keys(next.fileHashes || {}).length} 个`)
log(`压缩边界    ${boundaryMsgId || '(无)'}${summary ? `，摘要 ${summary.length} 字` : '，无摘要'}`)
log(`视窗消息    ${windowed.length} 条 / 共 ${history.length} 条（messages.jsonl 一行未删）`)
log(`上下文估算  ${est} token（预算 ${settings.get().contextBudgetTokens}）`)

if (!flag('write')) {
  log('（预览模式，未写盘。确认无误后加 --write）')
  process.exit(0)
}

sessionStore.writeSystem(sessionId, next)
log(`已写入 ${join(root, 'conversations', '<会话目录>', 'system.json')}`)
log('提示：这是管理员操作，会改变缓存前缀；下一轮对话的缓存命中率会暂时掉到 0，之后重新稳定。')
