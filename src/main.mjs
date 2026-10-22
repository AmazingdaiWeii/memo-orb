/**
 * Orb 独立客户端 —— Electron 主进程入口。
 *
 * 结构（一个进程里干两件事）：
 *   1. 当 Host：起球的控制 socket、拉旧后端 App Server、把两边协议对翻译
 *   2. 当球：动态 import 上游 dsh-orb 的 helper（它建窗口、画球、发一条 socket）
 *
 * 顺序很重要：helper 在模块顶层读 ORB_SOCKET / TOKEN，读不到就直接 exit(1)。
 * 所以必须先把 socket 起来、把环境变量设好，再 import 它。
 */

import { app } from 'electron'
import { createServer } from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startLegacyServer, LegacyConnection, startRuntime } from './legacy-engine.mjs'
import { readPersona } from './persona.mjs'
import { listConversations, readConversationBlocks, readMessageImages, renameConversation, deleteConversation, exportConversation } from './history.mjs'
import { createLockStore } from './lock.mjs'
import { createLockFlow } from './lock-flow.mjs'
import { isBlockedMemoryPath, listMemory, readMemoryFile, revisionAt, searchMemory, splitSections } from './memory.mjs'
import { createArchiver, isArchivable } from './archive.mjs'
import {
  ABOUT_INDEX_CONTENT,
  ABOUT_INDEX_PATH,
  CHECK_INTERVAL_MS,
  IMPRESSION_PATH,
  IMPRESSION_SEED,
  PLACEHOLDER_CRON,
  TASK_DESC,
  TASK_NAME,
  TIMEZONE,
  buildImpressionPrompt,
  dueState,
  ensureFrontmatter,
  formatAgo,
  frontmatterProblem,
  isPlaceholder,
  latestCommitTime,
  normalizeEveryHours,
  pickTask,
  summarizeTask,
} from './impression.mjs'
import { DEFAULT_MOOD, THINKING_MOOD, assetFor, extractMood, isSafeAssetSrc } from './mood.mjs'
import { PROVIDERS as TTS_PROVIDERS, createTts, describeTtsState, loadTtsConfig, saveTtsConfig, ttsConfigPath } from './tts/index.mjs'
import { createSpeechQueue } from './tts/speech.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const HELPER_MAIN = join(ROOT, 'helper', 'lib', 'main.js')
const LEGACY_JS = join(ROOT, 'node_modules', '@legacy-ai', 'legacy-code', 'legacy.js')
const CONFIG_PATH = join(ROOT, 'config.json')
const LOCK_PATH = join(ROOT, 'locks.json')
const LOGS = join(ROOT, 'logs')
const LOG_FILE = join(LOGS, 'orb.log')

mkdirSync(LOGS, { recursive: true })

/**
 * 让渲染层在**没有用户手势**的情况下也能出声（语音播报的前提）。
 *
 * 背景：Chromium 的 autoplay 策略默认是 `document-user-activation-required` ——
 * 页面必须被点过才能 `Audio.play()`，否则返回 `NotAllowedError` 并被静默拒绝。
 * 她的话是在**后台**到点的（回合结束、闹钟到点），没有任何点击动作，
 * 不加这一条的话表现就是「开关开着、日志里有合成日志、但一点声音都没有」——
 * 最难查的一类（播放调用报了 reject，但没人看 console）。
 *
 * 必须在 app ready 之前调用，所以放在模块顶层。
 */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const stamp = () => new Date().toISOString().slice(11, 19)
function log(msg) {
  const line = `[${stamp()}] ${msg}`
  console.log(line)
  try {
    appendFileSync(LOG_FILE, `${line}\n`, 'utf8')
  } catch {}
}
function logRaw(label, value) {
  log(`${label} ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

// ---------------------------------------------------------------- 对话隐私锁
// 状态层在 src/lock.mjs（凭证怎么存、考验怎么算），流程在 src/lock-flow.mjs
// （什么时候锁、锁住时给球看什么）。这里只做一件事：把两边的依赖接上。
// 设计依据：docs/对话加密_落地方案.md
// ⚠️ 数据层零改动 —— 门禁只发生在「host 把历史推给球」这一层，
//    conversations/<id>/messages.jsonl 始终明文，legacy 续聊与记忆反射完全不受影响。
//
// ⚠️⚠️ 这段的位置**不能提前**：两个构造函数都可能调 log()，而 log() 里用了 `stamp`。
//    `stamp` 是 const 箭头函数，声明前处于 TDZ —— 放在它上面会让整个 orb 起不来：
//    `ReferenceError: Cannot access 'stamp' before initialization`（实测踩过）。
//    函数声明会提升，const 不会。
const lock = createLockStore({ path: LOCK_PATH, log })
const lockFlow = createLockFlow({
  lock,
  send,
  refreshHistory: sendHistory,
  openConversation,
  readConversationBlocks,
  log,
})
// 布防闲置锁（方案 §4.1）。模块初始化时就起 —— 它只依赖「最后一次说话的时间」，
// 不依赖旧后端就绪；首次触发最早也要 idleTimeoutMin 分钟之后，不会误伤启动。
// 定时器 unref 过，不会把进程钉住。
lockFlow.startIdleWatch()

// ---------------------------------------------------------------- 配置

const DEFAULT_CONFIG = {
  model: 'openai-compatible/deepseek-flash',
  // ★ 引擎选择：'legacy' = 原旧后端后端（默认，行为不变）；'local' = 新自建引擎
  // 不加进 normalizeModeConfig() 的迁移判据 —— 那一套只管双模式。
  engine: 'legacy',
  agentName: 'Orb',
  theme: 'dark',
  locale: 'zh',
  agentId: null,
  // 双模式：`agentId` 保留为「闲聊态」的兼容别名，`agents` 才是真源（见 resolveAgentId）
  mode: 'chat',
  agents: {},
  // 记忆中心：印象总结的频率（24 / 168 / 0=关）。只在**内存里**补默认值，
  // 不写进 `normalizeModeConfig` 的迁移判据 —— 那一套只管双模式。
  impression: { everyHours: 24 },
  /**
   * 主对话（用户 m02698）：`mode -> sessionId`，**只写一次**（pin-once）。
   *
   * 口径是用户拍板的：「主对话固定不变 —— 点『新对话』只新建、不夺指针；
   * 每次打开软件默认回到它」。所以这里只由 ensureRuntime（真的新建了一条）
   * 或「还没有主对话时的第一次新建」写入，别处一律不许改。
   *
   * ⚠️ 必须存在 config.json，**不能**塞进 `logs/window-state.json`：那个文件
   *    由 helper 整文件覆写（`src/window-state.ts`），host 只读不写。
   */
  mainConversations: {},
  /**
   * 是否允许从宿主 `~/.dsh/omni-bridge-config.json` 搬一次微信凭据（**默认关**）。
   *
   * 2026-10-22 事故：出厂包里 exe 在用户机器上首启时，搬家逻辑把这台机器
   * 宿主的微信 bot 凭据写进了 `data/wechat.json`，设置页显示「已连接」。
   * 现在只有显式 `true` 才搬 —— 开发机在 config.json 里自己开。
   */
  adoptHostWechatCreds: false,
}

/**
 * 读配置，**同时**返回磁盘原始值（raw）与补齐默认值后的对象（merged）。
 *
 * ⚠️ 为什么非要 raw 不可：`normalizeModeConfig()` 要判断「这份配置是不是老版本留下的、
 * 需不需要迁移」。若拿 merged 判断，`DEFAULT_CONFIG` 里已经带着 `mode:'chat'` / `agents:{}`，
 * 老配置被默认值补齐之后就**看起来已经是最新的** —— 迁移分支永远不触发，也就永远不落盘。
 * 踩过：探针故意把 `mode` 从 config.json 删掉（模拟老用户升级），host 该迁移却静默跳过，
 * 跑完 `mode` 还是没写回磁盘。
 */
function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8')
    return { raw: { ...DEFAULT_CONFIG }, merged: { ...DEFAULT_CONFIG } }
  }
  try {
    // ★ 必须剥 BOM：PowerShell 的 `Set-Content -Encoding UTF8`（Windows PowerShell 5.1）
    //   会写成 **带 BOM** 的 UTF-8，而 `JSON.parse` 遇到 \uFEFF 直接抛
    //   `Unexpected token`。症状极隐蔽 —— 用户手改的 model/legacyUrl/permission
    //   **全部静默失效**，只在日志里留一行「解析失败」，而没人会去看那行。
    //   build.ps1 生成的出厂 config.json 正是这种带 BOM 的文件（已实测）。
    //   这里无条件剥掉，任何来源的 BOM 都能吃。
    const text = readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')
    const raw = JSON.parse(text)
    return { raw, merged: { ...DEFAULT_CONFIG, ...raw } }
  } catch (err) {
    log(`config.json 解析失败，用默认值: ${err.message}`)
    return { raw: {}, merged: { ...DEFAULT_CONFIG } }
  }
}

const { raw: rawConfig, merged: config } = loadConfig()
log(`orb 启动，root=${ROOT}`)
log(`模型 = ${config.model}`)

/**
 * 唯一一处配置落盘口。
 *
 *⚠️ 任何会改变「下次启动行为」的字段都必须走这里。踩过的坑：
 * `config.agentId = runtime.agent_id` 只在内存赋值、不落盘 → 每次启动都新建
 * 一个 agent，记忆全丢，本地还堆积 37 个叫 Orb 的僵尸（实测）。
 */
function saveConfig() {
  try {
    writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  } catch (err) {
    log(`config.json 写入失败: ${err.message}`)
  }
}

// ---------------------------------------------------------------- 双模式（方案 §2 / §4）

/** 可用模式。顺序即 UI 里的展示顺序。 */
const MODES = ['chat']
// 2026-10-22 工作态退役：只剩闲聊态一档人格，'work' 会被 MODES 守卫拒掉。

/**
 * 当前模式。**只有 switchMode() 能改它** —— 别处一律不许直接赋值。
 * 持久化在 `config.mode`：用户上次在哪，重启就回哪。
 */
let mode = 'chat'

/** sessionId -> mode。由 sendHistory / pickConversation 填充，避免「点开历史会话才发现走错 agent」。 */
const convOwnerCache = new Map()

/** 冷启动期间挂起的切模式请求（旧后端要十几秒才就绪）。 */
let pendingSwitch = null

/**
 * agent id 的**唯一**入口。
 *
 * P5（2026-10-19 用户裁定）之后**只有一个 agent、一份记忆**：模式只剩人格（chat / work），
 * 不再各带一个 memfs 记忆仓。所以这里**忽略参数** —— 签名留着只是为了让 40 多处
 * `resolveAgentId(currentMode)` 调用点不用改。
 *
 * ⚠️ 别处一律不许直接读 `config.agentId` / `config.agents.*`：单点是单点，
 *    散出去以后想再收就收不回来了。
 *
 * 兼容读取顺序：`agentId` 是正主；`agents.chat` / `agents.work` 是双模式时代的遗留，
 * 只在 `agentId` 缺失时兜底（normalizeModeConfig 会顺手把它们清掉）。
 */
function resolveAgentId(/* legacyMode：旧调用点会传「模式」，P5 后一律忽略 */) {
  return config.agentId ?? config.agents?.chat ?? config.agents?.work ?? null
}

/**
 * 记住这个 agent。发现是新的才写盘（幂等，别每次切都写）。
 *
 * P5 之后**不再按模式分 agent** —— 以前切到工作态会现造一个 `orb-work` 记忆仓，
 * 结果用户在两边的印象/约定互不可见；现在一律只有一个 agentId。
 */
function rememberAgent(agentId) {
  if (!agentId || config.agentId === agentId) return false
  config.agentId = agentId
  saveConfig()
  return true
}

/** agent 的名字（双模式退役后只有一档；参数留着只为不改 40 多处调用点）。 */
function agentNameFor(/* forMode：已无用 */) {
  return config.agentName ?? 'Orb'
}

function agentDescriptionFor(/* forMode：双模式退役后已无用，兼容保留 */) {
  return '闲聊模式：陪伴向'
}

/**
 * 取 persona 文本（**建 agent 那一刻**写进 system）。
 *
 * ⚠️ 失败返回 undefined 而不是抛 —— persona 文档被改坏时，宁可建一个没有 system 的
 *    agent（之后还能补跑 `tools/create-agent.mjs`），也不要连 agent 都建不出来。
 * ⚠️ persona 的**权威**注入口是 `tools/create-agent.mjs`（它把 persona.text 烤进 system）。
 *    这里只是「建的那一刻别让它空着」。
 */
function personaFor(forMode) {
  try {
    return readPersona(forMode).text
  } catch (err) {
    log(`读 ${forMode} persona 失败，这次建 agent 不带 system: ${err.message}`)
    return undefined
  }
}

/** 把当前模式推给球。启动就绪后、每次切会话/切模式都要推。 */
function sendMode() {
  send({ type: 'mode', mode, agentId: resolveAgentId() })
}

/**
 * 扫会话列表判断这条会话属于哪个模式。查不到返回 null。
 *
 * ★ P5（2026-10-19）：**local 下模式不再划分会话归属** —— 只有一份记忆、一份会话列表，
 *   同一条对话在闲聊态和工作态都能打开（差别只是她此刻的人格）。所以本地直接返回 null，
 *   让 openConversation 就地打开，而不是「先切模式再打开」把人绕一圈。
 *  旧后端引擎（两个真 agent）保持原语义。
 */
function sniffConversationMode(sessionId) {
  if (config.engine === 'local') return null
  for (const m of MODES) {
    const agentId = resolveAgentId(m)
    if (!agentId) continue
    try {
      if (listConversations(agentId).some((it) => it.sessionId === sessionId)) {
        convOwnerCache.set(sessionId, m)
        return m
      }
    } catch { /* 读盘失败当没有，交给调用方兜底 */ }
  }
  return null
}

/**
 * 挑一条要落过去的会话。
 *   open === 'new'        → null（新建）
 *   open === <sessionId>  → 那条（**并校验它真的属于这个模式**）
 *   open 省略             → 该模式最近一条；一条都没有就 null（新建）
 */
function pickConversation(forMode, open) {
  if (open === 'new') return null
  let items = []
  const agentId = resolveAgentId(forMode)
  if (agentId) {
    try {
      items = listConversations(agentId)
      // 顺手把归属记下来，省掉以后一次全量的双 agent 扫描
      // （P5 之后本地不分归属，只在旧后端引擎下记）
      if (config.engine !== 'local') for (const it of items) convOwnerCache.set(it.sessionId, forMode)
    } catch (err) {
      log(`读 ${forMode} 会话列表失败: ${err.message}`)
    }
  }
  if (typeof open === 'string' && open !== '') {
    const hit = items.find((it) => it.sessionId === open)
    if (hit) return hit.sessionId
    // 指定了一条不属于本模式的会话 → 宁可不切，也别把消息发给错的 agent
    log(`会话 ${open} 不在 ${forMode} 模式里，改为落最近一条`)
  }
  return items[0]?.sessionId ?? null
}

// ---------------------------------------------------------------- 主对话（用户 m02698）
// ⚠️ 这张表只服务旧后端引擎：local 下会话 id 是固定的 `local-<agentId>`（一个 agent 一条
//    长会话，靠压缩控视窗），根本没有「挂回哪条主对话」这件事 —— 切模式也不换会话。

/** 该模式记下的主对话 id（没记、记为非法值 → null）。 */
function mainConversationOf(forMode) {
  const pinned = config.mainConversations?.[forMode]
  return typeof pinned === 'string' && pinned !== '' ? pinned : null
}

/** 记下主对话。**幂等**，只有真的变了才写盘。 */
function rememberMainConversation(forMode, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  if (mainConversationOf(forMode) === sessionId) return false
  if (!config.mainConversations || typeof config.mainConversations !== 'object') config.mainConversations = {}
  config.mainConversations[forMode] = sessionId
  saveConfig()
  log(`主对话（${forMode}）= ${sessionId}（已记入 config.json）`)
  return true
}

/**
 * 「还没有主对话就认领这条」——专供「新对话」用。
 *
 * 用户口径是「新对话不夺指针」，所以这里**只在空位时写**；已经有主对话时
 * 一律不动它。没有这一条的话，一个从没让 ensureRuntime 建过会话的用户
 * （比如第一件事就是点「新对话」）会永远没有主对话，下次启动又白新建一条。
 */
function claimMainConversationIfEmpty(forMode, sessionId) {
  if (mainConversationOf(forMode)) return false
  return rememberMainConversation(forMode, sessionId)
}

/**
 * 主对话此刻还在不在？
 *
 * 会话是磁盘上的目录（`~/.legacy/lc-local-backend/conversations/`），用户在
 *旧后端界面里删过、或换个 agent 之后，记下的 id 就会指向不存在的东西。
 * 拿它去 `startRuntime` 的后果没实测过（见勘察报告遗留项），所以这里**先校验**：
 * 不在列表里就当没有主对话，走新建 —— 宁可重开一条，也别让球卡在「切不过去」。
 */
function liveMainConversation(forMode) {
  const pinned = mainConversationOf(forMode)
  if (!pinned) return null
  const agentId = resolveAgentId(forMode)
  if (!agentId) return null
  try {
    if (listConversations(agentId).some((it) => it.sessionId === pinned)) return pinned
  } catch (err) {
    log(`校验主对话 ${pinned} 失败（当作没有）: ${err.message}`)
    return null
  }
  log(`主对话 ${pinned} 已不在 ${forMode} 模式里（被删过？），这次改为新建`)
  return null
}

/**
 * config 归一化：老配置（只有 agentId、没有 agents）在这里升级；
 * 双模式时代的 `agents: {chat, work}` 在这里**收拢成单个 agentId**（P5）。
 *
 * 为什么要真的删掉 `agents`：留着就会有人（人或代码）再按模式读它，
 * 于是「两份记忆」的错觉又长回来。记忆只该有一份。
 */
function normalizeModeConfig() {
  let changed = false
  // ⚠️ 判据一律用**磁盘原始值** rawConfig，不是补过默认值的 config（理由见 loadConfig 注释）
  if (rawConfig.agents && typeof rawConfig.agents === 'object') {
    // 双模式 → 单 agent：优先留 chat（它就是用户日常在用的那份记忆），没有再退 work
    const kept = config.agentId ?? rawConfig.agents.chat ?? rawConfig.agents.work ?? null
    if (kept) config.agentId = kept
    delete config.agents
    changed = true
    log(`config.json 已收拢为单个 agent（P5）：agentId=${kept ?? '(无)'}，模式只剩人格不再分记忆仓`)
  }
  // 主对话表的形状（值可以是空对象，不需要迁移判定）
  if (!config.mainConversations || typeof config.mainConversations !== 'object') { config.mainConversations = {}; changed = true }
  if (!MODES.includes(rawConfig.mode)) { config.mode = 'chat'; changed = true }
  if (changed) saveConfig()
  mode = config.mode
  return changed
}
if (normalizeModeConfig()) log(`config.json 已归一（P5 单 agent）：mode=${mode} agentId=${config.agentId ?? '(无)'}`)

// ---------------------------------------------------------------- 与球之间的状态

const token = randomBytes(32).toString('hex')
let ballSocket = null
let ballAuthed = false

/** key -> { kind, text, running, response?, usage?, detail? } */
const blocks = new Map()
const order = []
/**
 * 本轮 assistant 块的起点（order 里的下标）。
 * 每个回合开始时重置 —— 用来界定「哪些 assistant 属于本轮」，
 * 避免在收尾时误伤历史轮次的 response 标记（见 markTurnResponse）。
 */
let turnAssistantFrom = 0

let runtime = null
let runtimePromise = null
/** 闹钟的 30 秒心跳；只起一次（runtime 重建/切模式都不该再起一个）。 */
let reminderTicker = null
/** 微信桥（传输层）与它的会话侧；同 reminderTicker，全进程只起一次。 */
let wechatBridge = null
let wechatFront = null
/**
 * 建微信桥（没有才建）。
 *
 * 抽成函数是为了「设置」抽屉：用户改了 token / 开关之后要把桥**拆了重建**
 * （旧的长轮询还攥着旧 token，不重建等于没改）。桥本身不持有 brain ——
 * 回合走 runWechatTurn，它会自己 ensureRuntime()。
 */
async function ensureWechatBridge() {
  if (wechatBridge) return wechatBridge
  const { createWechatBridge, createWechatFront } = await import('./wechat.mjs')
  const bridge = createWechatBridge({
    dataRoot: settingsDataRoot(),
    log,
    adoptHostCreds: config.adoptHostWechatCreds === true,
    onMessage: (item) => (wechatFront ? wechatFront.receive(item) : Promise.resolve('dropped')),
  })
  const front = createWechatFront({
    bridge,
    runTurn: runWechatTurn,
    approval: approvalBroker,
    log,
  })
  wechatBridge = bridge
  wechatFront = front
  log(`[wechat] ${bridge.describe()} 凭据=${bridge.credsFile}`)
  return bridge
}

/** 微信设置的对外快照（「设置」抽屉读它）。token 只回给本机渲染层，不进日志。 */
async function wechatSettingsSnapshot() {
  const { createWechatCreds, describeCreds } = await import('./wechat.mjs')
  const store = createWechatCreds({ dataRoot: settingsDataRoot(), log, adoptHostCreds: config.adoptHostWechatCreds === true })
  const creds = store.load()
  return {
    ok: true,
    file: store.file,
    enabled: creds.enabled,
    botToken: creds.botToken,
    baseUrl: creds.baseUrl,
    description: describeCreds(creds),
    running: Boolean(wechatBridge),
    adoptHostCreds: config.adoptHostWechatCreds === true,
    stats: wechatBridge ? wechatBridge.stats() : null,
  }
}

/**
 * 存微信设置并重启桥。
 *
 * 为什么一定要重启：轮询是 70 秒的长请求，旧循环里拿着旧 token，
 * 光改盘上的 json 不会让已经在跑的循环换凭据。
 */
async function applyWechatSettings(patch) {
  const { createWechatCreds, describeCreds } = await import('./wechat.mjs')
  const store = createWechatCreds({ dataRoot: settingsDataRoot(), log, adoptHostCreds: config.adoptHostWechatCreds === true })
  const next = store.save(patch ?? {})
  if (wechatBridge) {
    try {
      await wechatBridge.stop()
    } catch (err) {
      log(`[wechat] 停旧桥失败（继续重建）: ${err?.message || err}`)
    }
  }
  wechatBridge = null
  wechatFront = null
  const bridge = await ensureWechatBridge()
  const started = bridge.start()
  log(`[wechat] 设置已保存：${describeCreds(next)}；重启桥 ${started.started ? 'ok' : `跳过（${started.reason}）`}`)
  return { ok: true, data: await wechatSettingsSnapshot() }
}

/** 数据根（与 ensureRuntime 同一套规则；设置面板可能早于 runtime 打开）。 */
function settingsDataRoot() {
  return process.env.ORB_DATA || join(ROOT, 'data')
}

/**
 * 微信扫码配对（**开源版必需**）。
 *
 * 为什么不能只靠 DSH：原来 token 是从 `~/.dsh/omni-bridge-config.json` 迁过来的，
 * 那是 `dsh-omni-bridge` 插件扫码配对的产物。**开源版默认用户没装 DSH** ——
 * 对他们来说设置页只有三个空框，且没有任何途径把框填上。所以把插件里那两个
 * 配对接口搬到 `src/wechat-pair.mjs`，这里只负责「配好之后落盘 + 重启桥」。
 *
 * ⚠️ 配对成功的判据只有 `bot_token` 非空（见 wechat-pair.mjs 文件头），
 *    成功后立刻走 `applyWechatSettings` —— 它会把 `enabled` 打开并重建桥，
 *    用户扫完码不用再点一次「保存」。
 */
let wechatPair = null
async function getWechatPair() {
  if (wechatPair) return wechatPair
  const { createWechatPair } = await import('./wechat-pair.mjs')
  wechatPair = createWechatPair({ log })
  return wechatPair
}

/**
 * 配对成功的「已处理」记忆 + 串行锁。
 *
 * ★ 2026-10-22 用户实测 bug：**手机扫码配对成功了，界面上却是红字「配对失败：请求超时」**，
 *   重新打开设置页才看到配对成功。根因是并发轮询：
 *
 *     t=0  前端 poll #1 → 服务端回 confirmed（带 bot_token）
 *          → 主进程开始写盘 + 拆桥重建（几百毫秒到几秒）
 *     t=2  前端的 2 秒定时器**还在跑**（它拿不到结果就不能停）→ poll #2
 *          → 服务端对**已消费**的 qrcode 可能挂住不回 → 本地 15s 超时
 *     t=?  poll #1 先回来 → 界面显示「配对成功」
 *     之后 poll #2 的超时回来 → 把红字盖在成功提示上
 *
 *   两处一起改才治本：
 *     ① 同一张码**处理过就短路**，不再打服务端（这里）；
 *     ② 渲染层丢掉「过期请求」的结果（`api-config.js` 的 `startWechatPoll`）。
 *   只改一处仍然会偶发：①保证不再发第二次，②保证已经发出去的那次回来也不算数。
 */
let wechatPairDoneKey = ''
let wechatPairDoneResult = null
/** 把 poll 串行化：两个并发的 poll 不会同时走「confirmed → 重建桥」。 */
let wechatPairChain = Promise.resolve()
function wechatPairSerialize(fn) {
  const next = wechatPairChain.then(fn, fn)
  wechatPairChain = next.then(
    () => {},
    () => {}
  )
  return next
}

async function pairWechat(action, qrcodeKey) {
  const pair = await getWechatPair()
  if (action === 'start') {
    const r = await pair.start()
    if (!r.ok) log(`[wechat] 取配对二维码失败：${r.error}`)
    return r
  }
  if (action !== 'poll') return { ok: false, error: `未知动作 ${action}`, state: 'error' }

  const key = String(qrcodeKey ?? '')
  return wechatPairSerialize(async () => {
    // ① 这张码已经配好过 —— 直接把上次的结果再回一遍，**一个字节都不再打服务端**。
    if (key !== '' && key === wechatPairDoneKey && wechatPairDoneResult) {
      log('[wechat] 这张码已配对完成，重复的 poll 直接回上一次结果（不打服务端）')
      return wechatPairDoneResult
    }

    const r = await pair.poll(key)
    if (!r.ok || r.state !== 'confirmed' || !r.creds) return r

    const saved = await applyWechatSettings({
      enabled: true,
      botToken: r.creds.botToken,
      botId: r.creds.botId,
      userId: r.creds.userId,
      // 空的 baseUrl 不要覆盖盘上已有的（save 里也挡了一层，这里表意更清楚）
      ...(r.creds.baseUrl ? { baseUrl: r.creds.baseUrl } : {}),
    })
    // ⚠️ 不把 botToken 回给渲染层 —— 配对成功的界面只需要「配对到谁」。
    wechatPairDoneKey = key
    wechatPairDoneResult = {
      ok: true,
      state: 'confirmed',
      creds: { botId: r.creds.botId, userId: r.creds.userId },
      data: saved.data,
    }
    return wechatPairDoneResult
  })
}

/**
 * 「设置」抽屉的读快照 —— 一次给全两段：模型/密钥 + 微信。
 *
 * 读密钥失败**不抛**：面板必须还能用来把密钥改对。原因放进 `error`，
 * 抽屉状态栏显示它，其余字段给空串（`describeProviderAuth` 就是为此存在的）。
 */
async function apiConfigSnapshot() {
  const { describeProviderAuth } = await import('./providers.mjs')
  const auth = describeProviderAuth({ modelName: config.model, log })
  const wechat = await wechatSettingsSnapshot()
  const budget = Number(config.contextBudgetTokens)
  return {
    ok: true,
    model: config.model ?? '',
    provider: auth.provider,
    providerLabel: auth.provider,
    baseUrl: auth.baseUrl,
    apiKey: auth.apiKey,
    configPath: CONFIG_PATH,
    authPath: auth.file ?? '',
    // null ⇒ 渲染层显示空值 + 占位「留空 = 出厂 24 000」
    contextBudgetTokens: Number.isFinite(budget) ? Math.round(budget) : null,
    // 空串 ⇒ 渲染层下拉落到出厂档（max）；settings.mjs 每轮读，存完下一轮生效。
    reasoningEffort: typeof config.reasoningEffort === 'string' ? config.reasoningEffort : '',
    wechat: {
      file: wechat.file,
      enabled: wechat.enabled,
      botToken: wechat.botToken,
      baseUrl: wechat.baseUrl,
      description: wechat.description,
    },
    // B 站登录态：只读文件、不联网。要联网复核（nav）走 ipc 'orb:bili-status'。
    bili: await biliSnapshot(),
    error: auth.error ?? '',
  }
}

/**
 * 存「设置」抽屉的改动。只写用户真的动过的键（渲染层算好 patch 再发过来），三段各管各的：
 *   · `model` / `contextBudgetTokens` → 项目根 `config.json`（settings 每轮按 mtime 重读 ⇒ 下一轮生效）；
 *   · `baseUrl` / `apiKey` → `<dataRoot>/providers/auth.json`（tmp + rename 原子写）；
 *   · `wechat.*` → `<dataRoot>/wechat.json`，并**立刻重建桥**。
 *
 * 任一段失败不连坐：其余段照写，失败原因并进快照的 `error`，面板仍拿到最新值。
 */
async function applyApiConfig(patch = {}) {
  const { writeProviderAuth } = await import('./providers.mjs')
  const notes = []
  const errors = []
  let configChanged = false

  if (typeof patch.model === 'string' && patch.model.trim() !== '' && patch.model.trim() !== config.model) {
    config.model = patch.model.trim()
    configChanged = true
    notes.push(`模型 → ${config.model}`)
  }

  if (patch.contextBudgetTokens === null) {
    if ('contextBudgetTokens' in config) {
      delete config.contextBudgetTokens
      configChanged = true
      notes.push('压缩阈值已清回出厂')
    }
  } else if (Number.isInteger(patch.contextBudgetTokens)) {
    if (config.contextBudgetTokens !== patch.contextBudgetTokens) {
      config.contextBudgetTokens = patch.contextBudgetTokens
      configChanged = true
      notes.push(`压缩阈值 → ${patch.contextBudgetTokens}`)
    }
  }

  if (patch.reasoningEffort === null) {
    if ('reasoningEffort' in config) {
      delete config.reasoningEffort
      configChanged = true
      notes.push('推理等级已清回出厂（max）')
    }
  } else if (typeof patch.reasoningEffort === 'string' && patch.reasoningEffort !== '') {
    // 合法档位集合从 settings.mjs 取，避免两个文件各写一份而漂移。
    const { EFFORT_VALUES } = await import('./settings.mjs')
    const wanted = patch.reasoningEffort.trim().toLowerCase()
    if (EFFORT_VALUES.includes(wanted)) {
      if (config.reasoningEffort !== wanted) {
        config.reasoningEffort = wanted
        configChanged = true
        notes.push(`推理等级 → ${wanted}`)
      }
    } else {
      errors.push(`推理等级 ${wanted} 不合法（可用：${EFFORT_VALUES.join('/')}）`)
    }
  }

  if (configChanged) {
    saveConfig()
    notes.push('config.json 已保存（下一轮生效）')
  }

  const baseUrl = typeof patch.baseUrl === 'string' ? patch.baseUrl.trim() : undefined
  const apiKey = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : undefined
  if (apiKey === '') {
    // 空密钥写进去等于让应用彻底不通，宁可不动并说清楚。
    notes.push('密钥留空，未改动')
  }
  if ((baseUrl !== undefined && baseUrl !== '') || (apiKey !== undefined && apiKey !== '')) {
    try {
      const written = writeProviderAuth({
        modelName: config.model,
        baseUrl: baseUrl || undefined,
        apiKey: apiKey || undefined,
        log,
      })
      notes.push(`密钥 → ${written.file}（${written.provider}）`)
    } catch (err) {
      errors.push(`密钥写入失败：${err?.message || err}`)
    }
  }

  if (patch.wechat && typeof patch.wechat === 'object') {
    try {
      await applyWechatSettings(patch.wechat)
      notes.push('微信设置已保存，桥已重启')
    } catch (err) {
      errors.push(`微信设置失败：${err?.message || err}`)
    }
  }

  const data = await apiConfigSnapshot()
  if (errors.length > 0) data.error = [data.error, ...errors].filter(Boolean).join('；')
  return { ok: true, data, note: notes.join('；') }
}

/**
 * B 站扫码登录（「设置」抽屉的第三段）。
 *
 * 为什么单列一个模块：扫码要打 passport 域名、要缓存二维码 key、要把 SESSDATA
 * 落到 `data/bili-auth.json` —— 这些都不该塞进 main.mjs 的 5000 行里。真源在
 * `src/bili-auth.mjs`，本文件只负责「按需构造一次 + 暴露 4 个 IPC」。
 *
 * 懒构造：`ensureRuntime()` 之前用户就可能打开设置抽屉（这时函数还没往下跑），
 * 所以 dataRoot 用 `settingsDataRoot()` 现算，而不是读 runtime 里的变量。
 */
let biliAuth = null
async function ensureBiliAuth() {
  if (biliAuth) return biliAuth
  const { createBiliAuth } = await import('./bili-auth.mjs')
  biliAuth = createBiliAuth({ dataRoot: settingsDataRoot(), log })
  return biliAuth
}

/**
 * 「看过的视频」账本。在 `ensureRuntime()` 里装配，但 IPC 是在 `boot()` 里注册的
 * （两个函数不同作用域），所以这里留一个模块级句柄给 IPC 用 —— handler 是懒执行的，
 * 读的时候账本早建好了。不这么做的话 IPC 里会 `ReferenceError`。
 */
let biliHistoryStore = null

/** 点赞/投币/收藏/评论的执行器（在 `ensureRuntime()` 里装配，IPC 在 `boot()` 里用）。 */
let biliActionsRef = null

/** 只用来写「喜欢理由 / 想对作者说的话」的短文案模型（关闭思考，快且便宜）。 */
let noteLlmRef = null

/**
 * 点赞 / 投币 / 收藏 —— **抽屉里的按钮**和**她替他点**共用这一份实现。
 *
 * 为什么抽出来（2026-10-22 用户原话：「如果说框架内直接引用投币功能模块是非法访问，
 * 那么能否让 agent 自己去执行投币，也就是说，这里的这几个功能，实际上它是一个待办事项？」）：
 *
 * 实测结论是**接口本身没问题** —— 用他真实账号投过一枚：余额 711.6 → 710.6，
 * `archive/coins` 从 0 变 1。留在日志里的那条 `-401 非法访问` 是 B 站对**特定稿件**的拒绝：
 *   · 换 aid 稳定复现（同一 aid 连发三次都是同一个码，不同 aid 会出现 34003 而不是 -401）；
 *   · 换 csrf / WBI 签名 / 请求形态（query 版、bvid 版、手机 UA）/ 补 buvid3 · buvid4 都没用；
 *   · 故意写错 csrf 会得到 -111，说明请求早就过了鉴权层。
 * 所以这里做的**不是绕风控**，而是把同一件事也交到她手上：他一句话，她就能替他点；
 * 真被拒时，她能拿到 B 站给的码并如实说出来 —— 而不是按钮灰一下、什么动静都没有。
 *
 * @param {{bvid?: string, cid?: number, action?: string, count?: number}} o
 * @returns {Promise<{ok: boolean, [k: string]: any}>} 永不抛
 */
async function runBiliAct({ bvid = '', cid = 0, action = '', count } = {}) {
  if (!biliHistoryStore || !biliActionsRef) return { ok: false, error: 'B 站通道没接上' }
  const bv = String(bvid || '').trim()
  if (!bv) return { ok: false, error: '缺 bvid（要哪一条？）' }
  // 她手上通常只有 BV 号 —— cid 从账本里补。
  let cidNum = Number(cid) || 0
  if (!cidNum) {
    const hit = biliHistoryStore.list({ limit: 200 }).find((x) => String(x.bvid) === bv)
    cidNum = Number(hit?.cid) || 0
  }
  const item = biliHistoryStore.get(bv, cidNum)
  if (!item) return { ok: false, error: '账本里没有这条视频（先在抽屉里点开它看一遍，或者用 bili_watch 看一次再操作）' }

  // 收藏/评论要的是 aid；老条目可能没存 aid，这里兜底用 bvid 反查一次。
  let aid = Number(item.aid || 0)
  if (!aid) {
    try {
      const { fetchView } = await import('./bili-media.mjs')
      const v = await fetchView({ bvid: bv, page: item.page || 1 })
      if (v.ok) aid = Number(v.aid || 0)
    } catch {
      /* 下面会报「缺 aid」 */
    }
  }

  if (action === 'like') {
    const r = await biliActionsRef.like({ aid })
    if (!r.ok) return r
    // 先落「喜欢」这件事本身；理由/想说的话由 `orb:bili-compose` 随后补
    // （写作要一两秒，别让按钮等它）。
    // ★ `by:'user'`：这是**用户**让他点的，不代表她的品味 ⇒ 不进「我喜欢的」栏。
    const m = biliHistoryStore.markLiked(bv, cidNum, { by: 'user' })
    return { ok: true, item: m.item, message: '赞过了' }
  }
  if (action === 'coin') {
    // 已经投过就别再扣——B 站会回 65006，但先本地挡一次省一趟往返
    if (Number(item.actions?.coin) > 0) return { ok: false, error: '这条已经投过币了' }
    const r = await biliActionsRef.coin({ aid, count })
    if (!r.ok) return r
    const s = biliHistoryStore.setAction(bv, cidNum, { coin: Number(count) === 2 ? 2 : 1 })
    return { ok: true, item: s.item, message: '投过币了' }
  }
  if (action === 'fav') {
    if (item.actions?.fav === true) return { ok: false, error: '这条已经收藏过了' }
    const r = await biliActionsRef.fav({ aid })
    if (!r.ok) return r
    const s = biliHistoryStore.setAction(bv, cidNum, { fav: true })
    return { ok: true, item: s.item, message: `收藏到「${r.folder || '默认收藏夹'}」了` }
  }
  return { ok: false, error: `不认识的动作：${action || '(空)'}` }
}

/**
 * 让她为一条视频写两段话：为什么喜欢、想对作者说什么。
 *
 * 走的是**独立的短文案实例**（`noteLlmRef`，reasoningEffort=off）：
 * 用主模型那套 max 思考写这两百字，要等半分钟、还白烧思考 token，不值当。
 * 只产出 JSON，解析失败时把原文兜回 comment（宁可让她多写一句，也不要丢内容）。
 */async function composeLikeNote(item) {
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  const times = Array.isArray(item.frameTimes) && item.frameTimes.length
    ? item.frameTimes.map(clock).join('、')
    : '（没取画面，只看了元信息）'
  const prompt = [
    '你刚在 B 站看完一条视频，用户点了「喜欢」。请写两段中文，只输出 JSON，不要任何解释或代码块：',
    '{"reason":"你为什么喜欢它（第一人称，1~2 句，具体到你看过的画面/它给你的感觉，不要空泛夸奖）","comment":"想对 UP 主说的一句话（40 字以内，像真人留言，别用客套模板，别堆 emoji）"}',
    '',
    `视频：《${item.title}》${item.pageTitle ? ` · ${item.pageTitle}` : ''}`,
    `时长 ${item.duration || '?'} 秒，画质 ${item.qualityLabel || '?'}，你看过的时间点：${times}`,
  ].join('\n')

  let text = ''
  for await (const ev of noteLlmRef.stream({ messages: [{ role: 'user', content: prompt }] })) {
    if (ev.type === 'content' && typeof ev.text === 'string') text += ev.text
  }
  const raw = String(text || '').trim()
  try {
    // 容忍模型包一层 ```json ``` 或前后多一句话
    const m = raw.match(/\{[\s\S]*\}/)
    const j = JSON.parse(m ? m[0] : raw)
    return {
      reason: String(j.reason || '').trim(),
      comment: String(j.comment || '').trim(),
    }
  } catch {
    return { reason: raw.slice(0, 200), comment: '' }
  }
}

/**
 * 看完一条视频后，让她写一句「这视频大概讲了什么」（界面上的**概览**）。
 *
 * 为什么要单独生成，而不是让她在回复里顺口说一句：
 *   界面要的是**每条视频下面都能放的一句话**，得落在账本上、还得能在
 *   「看过的视频」抽屉里逐条读出来。聊天回复是流水，捞不回来。
 *
 * ★ 用的是**真实取到的关键帧**（`r.images`），不是标题复读 ——
 *   所以老条目（没取过帧）只能给一个基于元信息的弱版本（见 `composeSummary`）。
 * ★ 走同一个短文案实例（reasoning off），一两句话的事不烧思考 token。
 */
async function summarizeVideo(r) {
  if (!noteLlmRef) return ''
  const images = Array.isArray(r?.images) ? r.images.filter((im) => im && im.data) : []
  if (!images.length) return '' // 没画面就没法总结内容，别拿标题硬凑
  const meta = r.meta || {}
  const title = String(meta.title || '')
  const parts = [
    {
      type: 'text',
      text: [
        `你刚在 B 站看完这条视频：${title}${meta.pageTitle ? ` · ${meta.pageTitle}` : ''}（时长 ${Math.round(Number(meta.duration || 0))} 秒）。`,
        '下面是你取到的关键帧。',
        '请写 1~2 句中文，说清楚**这个视频大概是什么内容 / 在讲什么**（客观描述，不要复述标题，不要写"我无法判断"）。',
        '直接给正文，不要标题、不要引号、不要解释、不要客套。看不清的地方就别提。',
      ].join('\n'),
    },
    ...images.slice(0, 6).map((im) => ({
      type: 'image_url',
      image_url: { url: `data:${im.mimeType || 'image/jpeg'};base64,${im.data}` },
    })),
  ]
  let text = ''
  try {
    for await (const ev of noteLlmRef.stream({ messages: [{ role: 'user', content: parts }] })) {
      if (ev.type === 'content' && typeof ev.text === 'string') text += ev.text
    }
  } catch (err) {
    log(`[bili] 写概览失败：${err?.message || err}`)
    return ''
  }
  return cleanSummary(text)
}

/**
 * 手动补一条概览（老条目 / 只看了元信息的那条）。
 *
 * ⚠️ 这一版**没有画面**，只能依据标题、时长和她自己写下的理由/评论。
 *   所以 prompt 里明确禁止编造画面细节 —— 宁可写「只看了标题，不知道具体讲了什么」，
 *   也不要造一段她没看过的东西（那是在骗用户）。
 */
async function composeSummary(item) {
  if (!noteLlmRef) return ''
  const note = item?.liked && typeof item.liked === 'object' ? item.liked : {}
  const lines = [
    `一条 B 站视频：${item?.title || ''}${item?.pageTitle ? ` · ${item.pageTitle}` : ''}`,
    `时长 ${Math.round(Number(item?.duration || 0))} 秒。`,
  ]
  if (note.reason) lines.push(`你之前说喜欢它是因为：${String(note.reason).slice(0, 200)}`)
  if (note.comment) lines.push(`你当时想说：${String(note.comment).slice(0, 200)}`)
  const text = [
    ...lines,
    '请用 1~2 句中文写这条视频的「概览」：它大概是什么内容。',
    '⚠️ 你**没有看过这条视频的画面**，所以只写从上面这些信息能确定的；',
    '不确定就直接说「只看了标题，不清楚具体讲了什么」，**不要编造画面里的情节**。',
    '直接给正文，不要标题、不要引号、不要解释。',
  ].join('\n')
  let out = ''
  try {
    for await (const ev of noteLlmRef.stream({ messages: [{ role: 'user', content: text }] })) {
      if (ev.type === 'content' && typeof ev.text === 'string') out += ev.text
    }
  } catch (err) {
    log(`[bili] 补写概览失败：${err?.message || err}`)
    return ''
  }
  return cleanSummary(out)
}

/** 概览只留正文：去掉模型爱加的引号/标题/前后废话，截到 240 字。 */
function cleanSummary(text) {
  let s = String(text || '').trim()
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '')
  s = s.replace(/^["「『]/, '').replace(/["」』]$/, '')
  s = s.replace(/^(概览|概述|总结)[:：]\s*/, '')
  s = s.replace(/\s+/g, ' ').trim()
  return s.slice(0, 240)
}

/** 设置抽屉要的 B 站块。读文件，不联网（`verify:true` 才问一次 nav）。 */
async function biliSnapshot(opts = {}) {
  try {
    const bili = await ensureBiliAuth()
    return await bili.status(opts)
  } catch (err) {
    return {
      ok: false,
      loggedIn: false,
      file: '',
      description: 'B 站登录模块加载失败',
      error: String(err?.message || err),
    }
  }
}
/**
 * 本次 ensureRuntime 挂回的主对话（null = 新建）。
 *
 * 只用来在 runtime 就绪后区分两种情况：挂回已有的那条要**补一次历史回放**
 * （否则界面上是空的，用户以为记忆丢了），新建的那条要写进 config.json。
 */
let resumedMainConversation = null
let legacy = null
let legacyReady = false
let turnRunning = false
let userSeq = 0
/**
 * 本进程的唯一标记，混进 client_message_id 里。
 *
 * 目的是让 `u-<会话>-<序号>-<RUN_TOKEN>` 跨进程唯一 —— 见 onUserPrompt 里的
 * 踩坑记录：切到历史会话后沿用 u-1 会和该会话里已有的 otid 撞车，消息被旧后端静默丢弃。
 */
const RUN_TOKEN = randomBytes(4).toString('hex')
let lastAssistantKey = null
/**
 * 块 key 的会话作用域。旧后端的 message id 形如 `ui-msg-4`，序号是
 * **conversation 内**的，两个 conversation 会产出同名key → 互相覆盖
 * （见 待办事项.md P0-1 根因 B）。加上会话前缀即可隔开。
 */
let blockScope = 'pending'
/** ORB_LEGACY_TALLY=1 时统计各类旧后端消息条数（排障用，平时不填）。 */
const legacyTally = {}
/**
 *旧后端未就绪时用户点的「切到某条历史会话」，先存这儿，就绪后补做。
 *
 * 踩过：冷启动要十几秒，这个窗口里点历史对话会静默失败（球上毫无反应），
 * 用户只会以为功能坏了。取最后一条 —— 连点多次时用户最后一次意图才是最终的。
 */
let pendingOpen = null
/**
 * 回合队列。旧后端一个 runtime 同时只能跑一个回合，用户在回合进行中再发
 * 消息时不能直接 `input` 出去（会与正在跑的回合交织）。
 * 这里的 policy 是**排队**：等当前回合 stop_reason 到了再发下一条。
 */
const turnQueue = []
/** 是否有一条已经 `input` 出去但还没收到 stop_reason（回合进行中）。 */
let turnInFlight = false
/**
 * ★ 当前 local 会话 id（2026-10-19 用户要求：历史对话要能真的切过去）。
 *
 * P5 时 local 被写死成一条长会话 `local-<agentId>`，点别的会话一律丢弃；
 * 现在放开成多会话。实现上**不重建 runtime** —— brain.run 本来就按 sessionId
 * 取会话文件（不存在就现建，见 `src/brain.mjs` 的 `run()`），所以「切会话」
 * 只是把当前会话 id 换掉，brain / 记忆仓 / 人格 / 工具全都不用动。
 */
let localSessionId = null
/** 把当前会话切到 sessionId（local 专用，只改 id 和作用域）。 */
function setLocalSession(sessionId) {
  if (!sessionId) return
  if (runtime) runtime.conversation_id = sessionId
  localSessionId = sessionId
  blockScope = sessionId
}
/** 当前 local 会话 id：runtime 还没建时退到模块变量。 */
function currentLocalSession() {
  return runtime?.conversation_id ?? localSessionId ?? ''
}

/**
 * 审批通道（local 引擎专用）。
 *
 * 历史病根：旧后端模式下 `case 'control_request'` 只打一行日志就 `break`，
 * 从不回复 ⇒旧后端的 loop 永远在等 approval ⇒ 回合不结束、对话永久卡住，
 * 用户看到的就是「确认框弹不出来，还卡住进度」。local 引擎不再有那条路，
 * 改为复用球侧现成的提问卡协议（`question` → `orb:question` → 卡片），
 * broker 保证**每一条路径都会 resolve**（超时/断线/取消都算拒绝），
 * 所以「等审批」不再可能变成「挂住回合」。
 */
let approvalBroker = null

function send(obj) {
  if (!ballSocket || !ballAuthed) return
  if (process.env.ORB_TRACE === '1') {
    const preview = JSON.stringify(obj)
    log(`-> 球 ${obj.type} ${preview.length > 200 ? `${preview.slice(0, 200)}…` : preview}`)
  }
  ballSocket.write(`${JSON.stringify(obj)}\n`)
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * 语音播报（2026-10-22）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 分工（三处，别混）：
 *   · `src/tts/*`           文字 → 音频字节（只取，不播）
 *   · `src/tts/speech.mjs`  切句 / 清洗 / 排队 / 保序 / 打断（本文件下面这套）
 *   · 渲染层 `shell.js`     `new Audio(blobUrl)` 真出声
 *
 * 为什么播放在渲染层而不是主进程：主进程没有音频输出能力。Electron 的
 * `Audio` 是 DOM API，只有渲染进程有。所以音频必须「主进程合成 → IPC 传字节 →
 * 渲染层播」。
 *
 * ★ mp3 **不落盘**（用户 2026-10-22 明确要求「即用即抛」）：
 *   整条链路只在内存里走一趟，播完 `revokeObjectURL()` 就还给系统。
 *   磁盘上不会因为说话多出一个文件 —— 这是默认行为，不是可选项。
 *
 * ★ `enabled` 默认 false。开源出去以后若默认开、还带着作者的 key，
 *   每个下载的人都花作者的钱（`defaultTtsConfig()` 里那条注释）。
 */
const ttsState = {
  /**
   * 当前生效的配置（tts.json 的快照）。
   *
   * ★ 必须显式传 `settingsDataRoot()`，**不能**让 `loadTtsConfig()` 用默认值：
   *   `memory.mjs` 的 `dataRoot()` 在 `process.env.ORB_DATA` 没设时回落到
   *   `~/.legacy/lc-local-backend`，而 `ORB_DATA` 要等 runtime 起来（L3009）才设 ——
   *   模块初始化这个时间点上它还是空的。踩这个坑的表现是「设置页里显示没配」
   *   而 `data/providers/tts.json` 明明写着。
   */
  cfg: loadTtsConfig(settingsDataRoot()),
  /** 当前适配器实例；配置一改就重建 */
  tts: null,
  /** 最近一次失败原因，给设置页显示（不带密钥） */
  lastError: '',
}

function buildTts() {
  try {
    ttsState.tts = createTts(ttsState.cfg, { log })
    return ttsState.tts
  } catch (err) {
    ttsState.tts = null
    ttsState.lastError = `TTS 适配器创建失败：${err?.message || err}`
    log(`[tts] ${ttsState.lastError}`)
    return null
  }
}

/** 给 UI / 日志的状态快照。**不许带密钥原文**。 */
function speechState() {
  const d = ttsState.tts ? ttsState.tts.describe() : null
  const cred = d ? (d.provider === 'volcano' ? (d.hasAppPair || d.hasApiKey) : d.hasKey) : false
  // 复刻音色没填 speaker 的话，能合成但不是「她」—— 仍算可用，由设置页去提示
  const ready = Boolean(cred)
  return {
    type: 'speech-state',
    enabled: ttsState.cfg.enabled === true,
    ready,
    provider: d?.provider ?? ttsState.cfg.provider,
    providerLabel: d?.providerLabel ?? '',
    variant: d?.activeVariant ?? ttsState.cfg.volcano?.variant ?? '',
    speaker: d?.speaker ?? '',
    description: describeTtsState(d ? { ...d, enabled: ttsState.cfg.enabled === true } : null),
    lastError: ttsState.lastError,
  }
}

function pushSpeechState() {
  send(speechState())
  return speechState()
}

/**
 * 播报队列。
 *
 * `speak` 做成闭包而不是直接传 `ttsState.tts.speak`：配置改了要重建实例，
 * 把方法绑定在创建时的话，改完 key 得重启才能生效（第 N 次「改了没反应」）。
 */
const speech = createSpeechQueue({
  enabled: ttsState.cfg.enabled === true,
  speak: async (text) => {
    const tts = ttsState.tts ?? buildTts()
    if (!tts) return { ok: false, error: ttsState.lastError || 'TTS 没配好' }
    const r = await tts.speak(text)
    if (!r.ok) ttsState.lastError = r.error ?? '合成失败'
    return r
  },
  emit: (payload) => send(payload),
  log,
  onFail: (e) => noteSpeechFail(e),
})

buildTts()

/**
 * 嗓子的状态通道（2026-10-22 用户报：「她不知道自己有没有嗓子」）。
 *
 * 三条硬事实决定了必须显式告诉她：
 *  1. 话是**宿主**念的（她的字 → 分段 → 云端合成 → 渲染层播放），不是她自己出声；
 *  2. 合成结果**不回流模型** —— 成功她看不见，失败她也看不见；
 *  3. 失败只写日志（第 1 次与每第 5 次），她那边一片安静。
 * 于是她默认「我说的话他当然听见了」——没配 key 时也这么说。
 *
 * 这一行每轮附在她消息尾部（不落盘，同时间/余额行口径）：
 *  - 关着 → 明确「只出文字」；
 *  - 开着但没配好 → 明确「不会出声」+ 原因（这是她最需要知道的那一种）；
 *  - 可用 → 「可用」；上一轮有句子合成失败 → 追加一行「那句他可能没听见」，**报一次即清**。
 */
const voiceNote = { lastFail: '', count: 0 }

function noteSpeechFail(e) {
  voiceNote.count += 1
  voiceNote.lastFail = String(e?.error || '没有音频')
}

const voice = {
  turnLine() {
    const s = speechState()
    if (!s.enabled) return '语音：播报关着 —— 你这轮的话只以文字出现，不会被念出来。'
    if (!s.ready) {
      return `语音：开关开着但没配好（${s.lastError || '缺凭据'}）—— 你写的话不会出声，他看到的就是文字，别以为他听见了。`
    }
    const bits = [`语音：${s.providerLabel || s.provider || 'TTS'}${s.speaker ? ` · 音色 ${s.speaker}` : ''} · 可用`]
    if (voiceNote.lastFail) {
      bits.push(`刚才有 ${voiceNote.count} 句没合成出来（${voiceNote.lastFail}），那几句他可能没听见`)
      voiceNote.lastFail = ''
      voiceNote.count = 0
    }
    return bits.join('；')
  },
}

/** 改完配置/开关后统一刷新：重建适配器 → 同步开关 → 推状态给球。 */
function refreshTts() {
  ttsState.cfg = loadTtsConfig(settingsDataRoot())
  ttsState.lastError = ''
  buildTts()
  speech.setEnabled(ttsState.cfg.enabled === true)
  return pushSpeechState()
}

/**
 * 设置页用快照。字段形状与 `data/providers/tts.json` 一一对应，
 * 渲染层据此填表；`providers` 给下拉用（字段清单只在 index.mjs 定义一次）。
 */
function ttsSnapshot() {
  const cfg = ttsState.cfg ?? loadTtsConfig(settingsDataRoot())
  return {
    ok: true,
    file: ttsConfigPath(settingsDataRoot()),
    enabled: cfg.enabled === true,
    provider: cfg.provider,
    providers: Object.values(TTS_PROVIDERS).map((p) => ({
      id: p.id,
      label: p.label,
      fields: p.fields,
      note: p.note,
    })),
    volcano: { ...cfg.volcano },
    openai: { ...cfg.openai },
    state: speechState(),
  }
}

/**
 * 存语音设置。
 *
 * 只接受设置页真的动过的段（渲染层算好 patch 再发），未知键一律忽略 ——
 * 这条与 `orb:api-config-set` 同一套纪律：白名单会静默丢字段，
 * 但**全量透传**会让渲染层有能力覆盖它不该碰的东西（比如 variant 探测结果）。
 */
function applyTtsPatch(patch = {}) {
  const p = patch && typeof patch === 'object' ? patch : {}
  const next = {
    ...ttsState.cfg,
    volcano: { ...ttsState.cfg.volcano },
    openai: { ...ttsState.cfg.openai },
  }
  const notes = []

  if (typeof p.provider === 'string' && TTS_PROVIDERS[p.provider]) {
    if (next.provider !== p.provider) {
      next.provider = p.provider
      notes.push(`服务商 → ${p.provider}`)
    }
  }
  if (typeof p.enabled === 'boolean' && next.enabled !== p.enabled) {
    next.enabled = p.enabled
    notes.push(`播报 → ${p.enabled ? '开' : '关'}`)
  }
  const str = (v) => (typeof v === 'string' ? v.trim() : undefined)
  for (const field of ['appId', 'accessKey', 'apiKey', 'speaker', 'variant']) {
    const v = str(p.volcano?.[field])
    if (v === undefined) continue
    if (next.volcano[field] !== v) {
      next.volcano[field] = v
      // 密钥不回显在提示里，只说「改了」
      notes.push(field === 'apiKey' || field === 'accessKey' ? `${field} 已更新` : `volcano.${field} → ${v}`)
    }
  }
  for (const field of ['baseUrl', 'apiKey', 'model', 'voice', 'format']) {
    const v = str(p.openai?.[field])
    if (v === undefined) continue
    if (next.openai[field] !== v) {
      next.openai[field] = v
      notes.push(field === 'apiKey' ? 'openai.apiKey 已更新' : `openai.${field} → ${v}`)
    }
  }

  if (notes.length === 0) return { ok: true, note: '没有改动。', data: ttsSnapshot() }

  try {
    const written = saveTtsConfig(next, settingsDataRoot())
    ttsState.cfg = { ...written, enabled: written.enabled === true }
    ttsState.lastError = ''
    buildTts()
    speech.setEnabled(ttsState.cfg.enabled === true)
    pushSpeechState()
    log(`[tts] 配置已保存：${notes.join('、')}`)
    return { ok: true, note: notes.join('、'), data: ttsSnapshot() }
  } catch (err) {
    const msg = `写入失败：${err?.message || err}`
    log(`[tts] ${msg}`)
    return { ok: false, error: msg }
  }
}

/**
 * 「让她的声音替她说这句」—— 给闹钟这类**已经有完整句子**的场景用。
 * 与正文流式那条路互不影响（那条走 feed/finish）。
 */
function speakOutLoud(text) {
  speech.say(text)
}

function setTurn(running, statusText) {
  if (turnRunning !== running) {
    turnRunning = running
    send({ type: 'turn', running })
    // 情绪跟着回合状态走：开回合 = 思考态，收回合 = 她在这轮正文里声明的情绪
    // （没说就回到上一个落定的情绪，**不是** idle —— 见 `settledMood` 的注释）。
    // 挂在这里而不是各个调用点 —— setTurn 是全程唯一的回合状态收口
    //（文件里那 7 处调用），改一处就全覆盖。
    if (running) {
      turnMood = null
      sendMood(THINKING_MOOD, '回合开始')
      // 新回合开始 = 上一轮的话立刻闭嘴。
      // 不打断的话，她一边「思考」一边还在念上一轮的句子，听起来像两个人在说话。
      speech.stop('新回合')
    } else {
      sendMood(turnMood ?? settledMood, '回合结束')
    }
  }
  if (statusText !== undefined) send({ type: 'status', text: statusText })
}

/**
 * 块 key 统一收口。
 *
 *旧后端的 message id 形如 `ui-msg-4`，序号 `N` 是**conversation 内**的编号，
 * 两个 conversation 各自从 1 开始 → 会产出同名 key。而球的 block 协议是
 * 「同一个 key 反复覆盖」，于是两个会话的内容互相覆盖（待办事项.md 根因 B）。
 *
 * 所以所有由 delta id派生的 key 都加 `blockScope`（= conversation_id）前缀。
 * 注意：putBlock / dropBlock / resetTranscript / send 都走这里，改一处即可。
 */
const key = (rawKey) => `${blockScope}|${rawKey}`

/**
 * 用已有的**完整 key**（blocks 里存的那种，已带前缀）重发一次更新。
 *
 * settle() / stop_reason 收尾时走这里 —— 不能用 putBlock：
 * 那些地方拿到的是 blocks 的 key（已带前缀），再进 putBlock 会被二次加前缀，
 * 变成 `conv|conv|r:...` 这种废key（实测踩过）。
 */
function resend(k, kind, text, running, extra = {}) {
  const previous = blocks.get(k)
  const record = { kind, text, running }
  // 沿用上一版带的 usage / detail / response，除非这次显式给了新的。
  // response 必须沿用 —— 它是「本轮最终答案」的标记，跨轮次保留，
  // 每轮收尾时由 markTurnResponse() 统一处理（见 待办事项.md 坑 5）。
  if (previous?.usage) record.usage = previous.usage
  if (previous?.detail) record.detail = previous.detail
  if (previous?.response !== undefined) record.response = previous.response
  if (extra.usage) record.usage = extra.usage
  if (extra.detail) record.detail = extra.detail
  if (extra.response !== undefined) record.response = extra.response
  // 用户块的图片回显元数据（onUserPrompt 给，见 L2007）也要落进 record ——
  // 球重连时会按 order 重推块（L628），不存就退化成「这条消息本来就没图」。
  if (extra.imageCount) record.imageCount = extra.imageCount
  if (extra.imageNames) record.imageNames = extra.imageNames
  blocks.set(k, record)
  send({ type: 'block', key: k, kind, text, running, ...extra })
}

function putBlock(rawKey, kind, text, running, extra = {}) {
  const k = key(rawKey)
  if (!blocks.has(k)) {
    resend(k, kind, text, running, extra)
    order.push(k)
    log(`新块 ${k} (${kind})`)
    return
  }
  resend(k, kind, text, running, extra)
}

/**
 * 闹钟到点：宿主自己把话播出去（不跑模型）。
 *
 * 三件事，顺序别换：
 *  1. 先上屏 —— 到点了她的话要立刻出现在球上，别等落盘回来才显示；
 *  2. 再进会话 —— 不落盘的话，下一轮模型不知道自己说过这句，
 *     用户追问「你刚才提醒我什么」她会当面否认（真机踩过同类的「凭空否认」）；
 *  3. 只播一次 —— firedAt 在 takeDue 里已经先写盘了，这里就算失败也只丢这一句，
 *     不会重启后又响一遍。
 */
function speakReminder(item) {
  const text = String(item?.text ?? '').trim()
  if (!text) return
  // 迟到太久（>6h）的不播：早上八点突然补一句「该睡觉了」比不说更糟。
  // takeDue 已经把 firedAt 记上了，所以这条不会再被捞出来。
  if (item?.silent) {
    log(`闹钟迟到太久，只记账不打扰（${item.id}）: ${text}`)
    return
  }

  // 两条路各自独立：手机和桌面不是同一条会话，任何一边失败都不该拖住另一边。
  const channel = item?.channel === 'wechat' ? 'wechat' : item?.channel === 'desktop' ? 'desktop' : 'all'
  const toPhone = channel !== 'desktop'
  const toDesk = channel !== 'wechat'

  // 微信先发：它不依赖球侧会话（刚开机、还没点开她的时候桌面这条路是断的，
  // 但手机上照样该响）。异步不 await —— 到点这一下不该卡在网络上。
  if (toPhone && wechatBridge) {
    void wechatBridge
      .send({ text })
      .then((r) => {
        if (r && r.ok === false) log(`闹钟没发到微信（${r.error || '未知原因'}）: ${text}`)
        else log(`闹钟发到微信 ${item.id}: ${text}`)
      })
      .catch((err) => log(`闹钟发微信失败（${err.message}）: ${text}`))
  } else if (toPhone) {
    log(`闹钟到了但微信桥没接上，只走桌面（${item.id}）: ${text}`)
  }

  if (!toDesk) {
    log(`闹钟只发微信（${item.id}）: ${text}`)
    return
  }
  const rt = runtime
  if (!rt) {
    // 闹钟是宿主级的，可以比会话先存在（比如刚开机、还没点开她就到点了）。
    // 微信那条路上面已经发过了，这里只记账。
    log(`闹钟到点但还没有会话，只记账不播${toPhone ? '（微信已发）' : ''}：${text}`)
    return
  }
  putBlock(`a:rem-${item.id}`, 'assistant', text, false)
  // 到点这句话是**已经完整的**（不是流式），走 say() 一次性切句排队。
  // 不吃 `enabled` 之外的开关：闹钟是她自己设的，到点该响就得响。
  speakOutLoud(text)
  try {
    rt.brain.sessionStore.appendMessage(rt.conversation_id, { role: 'assistant', text })
  } catch (err) {
    log(`闹钟没能落进会话（已经上屏了）: ${err.message}`)
  }
  log(`闹钟播出 ${item.id}: ${text}`)
}

/**
 * 微信来的一句话 → 跑一轮 → 回一句话。
 *
 * 三条口径：
 *  1. **会话另起一条** `local-<agentId>#wechat`：记忆共用（memfs 只有一份），
 *     但桌面正在聊的话题不该被手机插进来，反过来也是。
 *  2. **不上球**：这一轮不 putBlock。球上显示的是桌面这条会话，手机那边的对话
 *     突然冒到屏幕上会让人以为她在自言自语（而且 blockScope 是桌面会话的）。
 *  3. **只要正文**：mood 标记要剥掉（`resolveMoodText(raw,false).text`），
 *     微信里没有球可以染情绪，把 `(mood:...)` 直接发出去他会看到乱码。
 *     （标记形态只有这一种，别再写成 `[[mood:...]]` 那种说法 —— 那会让人以为
 *      微信链路另有一套正则，实际两条链路走的是同一份 `src/mood.mjs`。）
 */
async function runWechatTurn({ text }) {
  const rt = await ensureRuntime()
  if (rt.engine !== 'local') throw new Error('当前引擎不是 local，微信桥只接了本地引擎')
  const sessionId = `local-${rt.agent_id}#wechat`
  log(`[wechat] 回合开始 conv=${sessionId}`)
  let raw = ''
  let usage = null
  for await (const ev of rt.brain.run({ sessionId, userText: text })) {
    if (ev.type === 'assistant') raw += ev.text
    else if (ev.type === 'done') usage = ev.usage || null
  }
  const out = resolveMoodText(raw, false).text
  log(`[wechat] 回合结束 conv=${sessionId} 回 ${out.length} 字${usage ? ` tokens=${usage.totalTokens ?? '?'}` : ''}`)
  return out
}

function dropBlock(rawKey) {
  const k = key(rawKey)
  blocks.delete(k)
  rawAssistant.delete(k)
  const i = order.indexOf(k)
  if (i >= 0) order.splice(i, 1)
  send({ type: 'block-drop', key: k })
}

function resetTranscript() {
  blocks.clear()
  order.length = 0
  lastAssistantKey = null
  turnAssistantFrom = 0
  rawAssistant.clear()
  turnMood = null
  settledMood = DEFAULT_MOOD
  send({ type: 'reset' })
  // 切会话等于换了个人在说话，情绪也回到待机 —— 否则会顶着一个上一会话留下的
  // 「难过」表情开新对话。
  sendMood(DEFAULT_MOOD, '切会话')
}

/**
 * 回合收尾：给本轮的最终答案打上 `response: true`，并把本轮其它 assistant 降级。
 *
 * 球按 user 块切分turn，折叠时每个 turn 里**只有带 `data-response` 的 assistant
 * 才显示**（`helper/assets/chat.css:171`）。所以：
 *
 * - 本轮最后一条 assistant →打 response: true（折叠时可见）
 * - 本轮其余 assistant → 不带 response（折叠时隐藏进「过程」）
 * - **历史轮次的块一律不碰** ← 这条是实测踩出来的
 *
 * 曾经的 bug：这里遍历 `blocks` 里全部 assistant 重发不带 response 的版本，
 * 把前面每轮打好的标记全擦了。现象是发出第 2 条消息后第 1 轮正文整块消失，
 * 只剩「用时 6秒」表头（表头是 turn 级别的，不受data-response 影响）。
 *
 * 修法：用 turnAssistantFrom 界定「本轮」的 assistant 范围，只在 [from, end] 里动。
 */
function markTurnResponse() {
  const finalKey = lastAssistantKey
  if (!finalKey || blocks.get(finalKey)?.kind !== 'assistant') {
    // 本轮没有 assistant 正文（比如只走了 reasoning + tool），
    // 不打标记 —— 球的折叠态会全部隐藏，符合「本轮没有最终答案」的语义。
    return
  }
  const end = order.indexOf(finalKey)
  if (end < 0) return
  for (let i = turnAssistantFrom; i <= end; i += 1) {
    const k = order[i]
    const rec = blocks.get(k)
    if (rec?.kind !== 'assistant') continue
    if (k === finalKey) {
      resend(k, 'assistant', rec.text, false, { response: true })
    } else if (rec.response) {
      // 本轮非最终答案：显式降级（球的 toggleAttribute 是按值切换的，
      // 不重发的话上一个状态会留着）
      resend(k, 'assistant', rec.text, false)
    }
  }
  // 回合收尾顺手处理隐私锁的「约暗号」意图：把约定指针钉到本轮最终答复上。
  // 方案 §6：软锁**零凭证存储** —— 只记「约定发生在哪条消息」，暗号原文本来就在
  // messages.jsonl 里躺着，落盘再多存一份既没用又多一个泄露面。
  lockFlow.pinAgreement(finalKey)
}

// ---------------------------------------------------------------- 情绪（装饰 GIF）

/**
 * 当前正在显示的情绪。
 *
 * 初值刻意用 `null` 而不是 `'idle'` —— `sendMood` 靠「和 currentMood 相同就不重发」
 * 去重，若初值就是 idle，那么冷启动那条 idle 会被判成「无事发生」而永远推不出去，
 * 球侧就一直停在它自己的默认图上。
 */
let currentMood = null

/** 缺素材的情绪只提醒一次（开源版不附带情绪 GIF，见 sendMood 里的存在性检查）。 */
const missingDecoWarned = new Set()

/** 本回合她自己在正文里声明的情绪（`(mood:xxx)`）；`null` = 本回合没说。 */
let turnMood = null

/**
 * 最近一次**落定**的情绪（待测清单 §2.4）。
 *
 * 「无情绪标记的普通回复 → 不误切，**保持当前动画**」—— 若回合没声明情绪就回落到 idle，
 * 那她本来在「开心」、回一句普通的话表情就被抹成待机，那不叫保持。
 * 所以记一个落定值：回合结束没声明时回到它。
 *
 * ⚠️ `thinking` **不进**这个值 —— 它是回合状态驱动的临时态，
 *    不是一个「她现在的情绪」，落定下来会导致她永远停在思考脸。
 */
let settledMood = DEFAULT_MOOD

/**
 * 每个 assistant 块的**原始**正文（含标记）。
 *
 * 球的块里只存「给用户看的文本」，而我们要在两个时刻从原始文本**重算**
 * 「该显示什么」：流式过程中（先把没闭合的标记尾巴扣住）和回合收尾（松手做最终一遍）。
 * 只留一份显示文本就没法重算，所以原始文本得单独存。
 */
const rawAssistant = new Map()

/**
 * 流式过程中，标记可能**只收到一半**（`(mood:hap`）就已经推给球了。
 *
 * ⚠️ 不扣住的话，用户会看到 `(mood:hap)` 明晃晃挂在那儿，直到回合结束才消失 ——
 * 标记是给程序看的，漏出来就是 bug。token 流是按 token 切的，`(mood:happy)`
 * 必然被切成好几段，所以这**一定**会发生，不是理论风险。
 *
 * ⚠️⚠️ 值域必须和 `src/mood.mjs` 的 `MARKER_SRC` **同步**（连上限都同一个数，现为 48）。
 *      2026-10-22 放宽 MARKER 让它收中文逗号时，这里差点漏改 ——
 *      漏改的表现是：完整标记能剥，但流式那几秒会闪出 `（mood:开心，`。
 *      守这条的是 `probe/mood-stream-marker.mjs`（逐字符喂真实样本，断言任何时刻都不泄漏）。
 */
const MARKER_TAIL = /[（(]\s*m(?:o(?:o(?:d)?)?)?\s*(?:[:：]\s*[^()（）\n]{0,48})?$/i

/**
 * 她忘了写右括号时，正文末尾会留一个 `(mood:xxx`。
 * 整条消息都结束了，就按标记处理 —— 只认**完整写了 `mood:` 再加值**的形态，
 * 免得把正文末尾一个孤零零的 `(` 吃掉。
 *
 * 值域同 `MARKER_SRC`（收中文逗号，上限 48），理由见 `MARKER_TAIL` 上面那段。
 */
const UNCLOSED_MARKER = /[（(]\s*mood\s*[:：]\s*[^()（）\n]{1,48}\s*$/i

/** 末尾那段还没闭合、可能是标记开头的字符串（没有就返回空串）。 */
function heldMarkerTail(raw) {
  const at = Math.max(raw.lastIndexOf('('), raw.lastIndexOf('（'))
  if (at < 0) return ''
  const tail = raw.slice(at)
  if (/[)）]/.test(tail)) return '' // 已经闭合，交给 extractMood 处理
  return MARKER_TAIL.test(tail) ? tail : ''
}

/**
 * 原始正文 → 「该给用户看什么」+「该显示哪个情绪」。
 *
 * @param {string} raw 累积的原始正文
 * @param {boolean} streaming 流式中（扣住半截标记）还是收尾（松手，做最终剥离）
 */
function resolveMoodText(raw, streaming) {
  const held = streaming ? heldMarkerTail(raw) : ''
  const body = held ? raw.slice(0, raw.length - held.length) : raw
  const parsed = extractMood(body)
  let text = parsed.text
  if (!streaming) {
    const unclosed = UNCLOSED_MARKER.exec(text)
    if (unclosed) text = text.slice(0, unclosed.index).replace(/[ \t]+$/, '')
  }
  return { text, mood: parsed.mood, found: parsed.found, raw: parsed.raw }
}

/**
 * 她已经写了情绪标记，但 `coerceMood()` 认不出这个说法 —— **必须留痕**。
 *
 * 2026-10-22 用户报障「情绪 GIF 只有思考和开心」的真凶就是这里**太安静**：
 * 认不出的标记被 `extractMood()` 剥掉（用户看不见），`mood` 是 `null`
 * （`if (mood) sendMood(...)` 直接跳过），于是**正文干净、表情不动、日志一个字没有**。
 * 从外面看就是「贴纸没变」，看不出任何异常 —— 典型的静默退化。
 *
 * 只留痕、不改变行为（认不出仍然只剥不认，这是 `mood.mjs` 定的契约）。
 * 同一个词只报一次，免得流式每个 delta 刷一屏。
 * ⚠️ 看到这条日志的正确动作：把那个词补进 `src/mood.mjs` 的 ALIASES，
 *    然后跑 `node probe/mood-alias-audit.mjs` 确认命中率。
 */
const unknownMoods = new Set()
function noteUnknownMood(raw) {
  const word = typeof raw === 'string' ? raw.trim() : ''
  if (word === '') return
  const k = word.toLowerCase()
  if (unknownMoods.has(k)) return
  unknownMoods.add(k)
  log(`情绪标记认不出：(${word}) —— 已剥掉标记但表情没变，该补进 mood.mjs 的 ALIASES`)
}

/**
 * 把「现在该显示哪个情绪」推给球。
 *
 * ⚠️ 用的是**专用类型 `deco`，不是 `avatar`**。
 * `功能落地_交接文档.md` §4 当时写的是 `send({type:'avatar', kind:'preset', src})`，
 * 但那是「装饰层落在哪儿」还没定的阶段写的。后来 `deco-plan/CONFIG.md`（用户已确认）
 * 定死了：装饰层在**面板左下角、z-index 0、对话文字之上**。
 * 而 `avatar` 通道在球侧落到 `#ball-gif` —— 那是**球的脸**，同时还是拖窗口的把手
 * （`#ball { cursor: grab }`）。拿它挂情绪，等于她一开口球的脸就被换掉，
 * 还会踩到项目铁律「球的视觉不许改」。
 * 未知类型球侧是**静默忽略**的（`helper/lib/main.js` 的分发末尾没有兜底分支），
 * 所以现在发 `deco` 是安全的空操作，等 UI 助手把渲染接上即可。
 */
function sendMood(mood, why = '', force = false) {
  const asset = assetFor(mood)
  if (!isSafeAssetSrc(asset.src)) {
    // 球侧那条正则会**静默丢弃**不合规的 src —— 那种最难查，所以在出站前就拦下并写日志。
    log(`情绪 src 不合规，已拦截：${asset.src}`)
    return
  }
  // ★ 开源版不附带情绪素材（原素材未获授权，已移除）。缺文件就静默跳过：
  //   推一个 404 给渲染层只会得到一张裂图，不如让她保持当前表情。
  //   用户把自己画的 gif 放进 helper/assets/deco/ 即可恢复，文件名见 mood.mjs 的 MOODS。
  if (!existsSync(join(ROOT, 'helper', 'assets', asset.src))) {
    if (!missingDecoWarned.has(asset.src)) {
      missingDecoWarned.add(asset.src)
      log(`情绪素材缺失，已跳过：${asset.src}（放进 helper/assets/deco/ 可恢复）`)
    }
    return
  }
  if (!force && asset.mood === currentMood) return
  currentMood = asset.mood
  // 落定值只在「真的表达了一个情绪」时更新；thinking 是回合驱动的临时态（理由见其声明处）。
  if (asset.mood !== THINKING_MOOD) settledMood = asset.mood
  log(`情绪 → ${asset.mood}（${why || '未说明'}）`)
  send({ type: 'deco', mood: asset.mood, src: asset.src, opacity: asset.opacity, speed: asset.speed })
}

// ---------------------------------------------------------------- 球的控制 socket

function handleHello(message) {
  const given = Buffer.from(String(message.token ?? ''))
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const ballServer = createServer((socket) => {
  log('球连上了 socket')
  let authed = false
  let buf = ''
  const authTimer = setTimeout(() => {
    if (!authed) socket.destroy()
  }, 5000)
  authTimer.unref()

  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buf += chunk
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const part of parts) {
      if (!part.trim()) continue
      let msg
      try {
        msg = JSON.parse(part)
      } catch {
        log('球发来非法 JSON')
        continue
      }
      if (!authed) {
        if (msg.type !== 'hello' || !handleHello(msg)) {
          log('球的 hello 鉴权失败，断开')
          socket.destroy()
          return
        }
        authed = true
        ballAuthed = true
        ballSocket = socket
        clearTimeout(authTimer)
        log('球鉴权通过')
        send({ type: 'session', sessionId: runtime?.conversation_id ?? 'pending' })
        send({ type: 'turn', running: turnRunning })
        send({ type: 'appearance', theme: config.theme, locale: config.locale })
        // 模式也补推：P5 之后模式不再分记忆仓，只决定「用哪张人格说话」，
        // 球侧却仍要按它显示当前形态。以前只在切换时推，重开软件后球就不知道
        // 自己现在是闲聊还是工作态 —— 而他上次是工作态的话，界面上会错一整天。
        sendMode()
        // 冷启动补一屏：此刻若内存里还没有块（刚开机），把当前会话的历史盘回球上，
        // 否则他开机点开面板看到的是一片空白（见 replayCurrentLocalIfBlank）。
        replayCurrentLocalIfBlank()
        for (const k of order) {
          const rec = blocks.get(k)
          if (!rec) continue
          // 图片回显元数据一并补推：球手上没有这份状态（重连后本地缩略图已丢），
          // 至少让它能画「图片 ×N」占位，而不是当这条消息没带过图。
          send({
            type: 'block', key: k, kind: rec.kind, text: rec.text, running: rec.running,
            ...(rec.imageCount ? { imageCount: rec.imageCount, imageNames: rec.imageNames } : {}),
          })
        }
        // 情绪也要补推 —— 球是重开的，它手上没有任何情绪状态。`force` 不能省：
        // 重连前后 currentMood 没变，不加 force 会被去重逻辑吃掉。
        sendMood(currentMood ?? DEFAULT_MOOD, '球重连', true)
        // 播报开关的状态也要补推：球是重开的，它手上没有这个状态，
        // 不推的话头像旁那个开关会一直是「关」的样子（而实际上开着）。
        pushSpeechState()
        // ⚠️ 本地引擎（config.engine === 'local'）下 `legacyReady` **永远是 false** ——
        //   旧后端 2026-10-19 就断了，没有任何人会去把它置真（原因见 switchMode 那段同款注释）。
        //   这里原来只判 `!legacyReady`，于是**每次冷启动、球一重连**就显示
        //   「正在启动旧后端…」—— 那时旧后端根本不存在，用户只会莫名其妙
        //   （2026-10-21 深夜用户发现并报上来）。
        if (config.engine !== 'local' && !legacyReady) setTurn(false, '正在启动旧后端…')
        else setTurn(false)

        // 自测抓手：自动模拟用户说话，用来在没人点窗口的情况下验证整条链路。
        // ORB_SELFTEST 支持用 `|||` 分隔多条 —— 这是专门用来复现
        // 「第二次输入后 UI 卡住」那个bug的：第一条刚发出去就发第二条，
        // 逼出ensureRuntime 的并发窗口（见 待办事项.md P0-1）。
        // ORB_SELFTEST_GAP 控制两条之间的间隔毫秒。
        const selftest = process.env.ORB_SELFTEST
        if (selftest) {
          const list = selftest.split('|||').map((s) => s.trim()).filter(Boolean)
          const gap = Number(process.env.ORB_SELFTEST_GAP ?? '3000')
          const delay = Number(process.env.ORB_SELFTEST_DELAY ?? '4000')
          log(`自测已启用：${list.length} 条，${delay}ms 后开始，每条间隔 ${gap}ms`)
          list.forEach((text, i) => {
            setTimeout(() => void onUserPrompt(text), delay + i * gap)
          })
        }
        continue
      }
      onBallMessage(msg)
    }
  })
  socket.on('close', () => {
    log('球的 socket 关闭')
    if (ballSocket === socket) {
      ballSocket = null
      ballAuthed = false
      // 界面没了，挂在卡片上的审批不可能再被回答 —— 立刻按拒绝收口，
      // 否则这一轮会一直等在那儿（这正是历史上「卡住对话进度」的形态）。
      approvalBroker?.abort('球断线了')
    }
  })
  socket.on('error', (err) => log(`球的 socket 错误: ${err.message}`))
})

// 球的权限档位（Claude Code 风格）→旧后端的 DevicePermissionMode。
// 与 legacy-engine.mjs 的 PERMISSION_MODES 保持一致，这里另存一份是为了球中途切换时不必再起 runtime。
const BALL_PERMISSION_MODES = {
  'read-only': 'strict',
  'workspace-write': 'acceptEdits',
  'danger-full-access': 'unrestricted',
}

/**
 * 记忆中心要读哪个 agent 的记忆仓库。
 *
 * ⚠️ 单独收一个入口，**不要在调用点直接写 `config.agentId`** ——
 *    双模式（见 `豆包式双模式_落地方案.md`）落地后，工作/闲聊各有一个 agent、
 *    各有一个记忆仓库；那时只需要改这一处（改成 `resolveAgentId(currentMode)`），
 *    四个 `memory:*` 分支一行都不用动。
 */
function memoryAgentId() {
  return resolveAgentId() ?? ''
}

/**
 * 取记忆内容：**协议优先，直读磁盘兜底**。
 *
 * ⚠️ 为什么优先走协议（差点白写一套）：
 *   `node_modules/…/protocol_v2.d.ts` 里本来就有一整套记忆 API ——
 *   `list_memory` / `memory_history` / `memory_file_at_ref` / `read_memory_file` /
 *   `write_memory_file` / `delete_memory_file` / `memory_commit_diff` / `enable_memfs`。
 *   实测（`probe/memory-protocol-probe.mjs`）**全部可用，且不启 runtime 就能用**
 *   （这些命令都显式带 `agent_id`）。它比我直读磁盘强的地方：
 *     · 知道 `is_system` / `description` / `kind` / `mime_type`（frontmatter 与图片）
 *     · `memory_file_at_ref` 能读**任意 git SHA** 下的文件 → 精确溯源/回滚预览
 *     · `memory_commit_diff` 给真 diff
 *     · `write_memory_file` / `delete_memory_file` **自带 commit** ——
 *       二期做编辑时必须用它，自己拼 git 提交会和反射 worker 抢锁
 *
 * ⚠️ 为什么还留磁盘兜底：旧后端冷启动要十几秒，这期间用户点开记忆中心不能是空的。
 *    兜底只服务「列出来看看」，编辑类操作一律不兜底。
 *
 * @returns {Promise<object>} 统一的 `{source, files, commits, head, ...}`
 */
async function memoryListing(agentId) {
  if (legacy && legacyReady) {
    try {
      const [list, hist] = await Promise.all([
        legacy.request('list_memory', { agent_id: agentId }, 15_000),
        legacy.request('memory_history', { agent_id: agentId, limit: 40 }, 15_000),
      ])
      if (list?.success === true) {
        const files = (list.entries ?? []).map((e) => {
          const rel = String(e.relative_path ?? '')
          const parsed = splitSections(e.content ?? '')
          return {
            path: rel,
            name: rel.slice(rel.lastIndexOf('/') + 1),
            isSystem: e.is_system === true,
            description: e.description ?? null,
            kind: e.kind ?? 'markdown',
            mimeType: e.mime_type ?? null,
            // ⚠️ 协议的 `size` 是**字符数**不是字节数（实测：MEMORY.md 报 956，
            //    磁盘上 2180 字节 —— 中文 3 字节/字，正好对上）。
            //    这里统一成真字节数，否则面板显示的体积和直读磁盘那一档对不上。
            bytes: e.kind === 'image'
              ? (e.size ?? 0)
              : Buffer.byteLength(e.content ?? '', 'utf8'),
            title: parsed.title,
            preamble: parsed.preamble,
            sections: parsed.sections,
          }
        })
        const commits = (hist?.commits ?? []).map((c) => ({
          hash: c.sha,
          short: String(c.sha ?? '').slice(0, 7),
          date: c.timestamp,
          actor: c.author_name ?? null,
          subject: c.message,
        }))
        return {
          agentId,
          source: 'protocol',
          memfsEnabled: list.memfs_enabled === true,
          initialized: list.memfs_initialized === true,
          total: list.total ?? files.length,
          files,
          commits,
          head: commits[0] ?? null,
          totalBytes: files.reduce((n, f) => n + (f.bytes || 0), 0),
        }
      }
    } catch (err) {
      log(`记忆：协议读取失败，退回直读磁盘（${err.message}）`)
    }
  }
  const disk = listMemory(agentId, log)
  return {
    source: 'disk',
    memfsEnabled: disk.git,
    initialized: disk.exists,
    total: disk.files.length,
    ...disk,
  }
}

/**
 * 记忆列表的缓存。
 *
 * ⚠️ 为什么必须有缓存（实测数据，不是猜的）：
 *   `probe/memory-list-latency.mjs` 实测同一个进程内连发 4 次 `list_memory`：
 *   **5014ms / 1839ms / 1542ms / 1673ms** —— 不是「第二次就快了」，
 *   而是**每次都要 1.5~1.8 秒**，冷启动那次多付约 3 秒。
 *   对照：`read_memory_file` 只用 **5ms**（拿单文件），`memory_history` 300~500ms。
 *   也就是说 `list_memory` 贵在「把每个文件的内容全量带回来」，是命令本身的性质。
 *
 *   一个 2 秒的空面板是不能接受的。所以：
 *     · 启动就绪后**预取**一次 → 用户第一次点开是热的；
 *     · 之后 60 秒内复用缓存 → 反复开关面板不再等；
 *     · **每轮对话结束就失效** → 记忆可能刚被反射写过，不能让面板显示旧内容。
 *   球侧契约：收到 `loading:true` 先渲染骨架，别显示「没有记忆」——
 *   首次最坏约 5 秒，那期间空手是什么都没有。
 */
const MEMORY_CACHE_TTL_MS = 60_000
let memoryCache = null

function invalidateMemoryCache(reason) {
  if (!memoryCache) return
  memoryCache = null
  log(`记忆缓存失效（${reason}）`)
}

/** 带缓存的取列表。**总是立刻返回**（要么缓存、要么现取），不会两条都发。 */
async function memoryListingCached(agentId) {
  const now = Date.now()
  if (memoryCache && memoryCache.agentId === agentId && now - memoryCache.at < MEMORY_CACHE_TTL_MS) {
    return { ...memoryCache.data, cached: true, ageMs: now - memoryCache.at }
  }
  const data = await memoryListing(agentId)
  memoryCache = { at: Date.now(), agentId, data }
  return { ...data, cached: false, ageMs: 0 }
}

/** 启动预取：把最贵的那一次（冷启动约 5 秒）挪到用户点开面板之前。 */
async function prefetchMemory() {
  const agentId = memoryAgentId()
  if (agentId === '') return
  const t0 = Date.now()
  try {
    const data = await memoryListing(agentId)
    memoryCache = { at: Date.now(), agentId, data }
    log(`记忆已预取（${data.source}，${data.files.length} 文件，${Date.now() - t0}ms）`)
  } catch (err) {
    log(`记忆预取失败（不影响使用，点开时会重试）：${err.message}`)
  }
}


// ---------------------------------------------------------------- 记忆中心 · 印象总结
//
// 用户定义（原话）：「提供一个入口，该入口中的内容是**定期会以自然语言总结 agent 对用户的
// 印象**，它是一个**定时任务**，暂定一天一次总结，入口 UI 在**右键菜单**中。」
//
// 机制（详见 `记忆中心_落地方案.md` §〇；两条 cron 探针各 11/11 实测过）：
//
//   · 任务体**落盘成旧后端 cron** —— 可见、可暂停、有 run log、可诊断，
//     比自己 `setInterval` + 自己造「往 agent 塞 prompt」要稳。
//   · 但 cron 表达式只是个**占位**，不指望它自己到点跑：
//     触发条件是「表达式匹配当前这一分钟」，**没有 catch-up** ——
//     凌晨没开机这天就彻底不跑，且不补。所以建好立刻 `cron_pause`，
//     **时机完全由 host 判定**，到点了手动 `cron_trigger`
//     （实测对 paused 任务有效，且 `cron_trigger` 不依赖调度器租约 →
//       别的旧后端进程占着也不影响，消掉了「两个旧后端抢调度器」的风险）。
//   · 到期基准取「印象文件最后一次 commit 时间」，**不取 `last_run_at`** ——
//     后者只说明**尝试过**，不说明**成功**（queued 之后回合仍可能失败）。
//
// ★ 格式约束（这一条是踩出来的，见 `src/impression.mjs` 文件头）：
//   `about/印象.md` **必须**带 frontmatter，否则旧后端装的 git 钩子会拒掉 commit；
//   而钩子校验的是**整棵索引树**，所以一旦它以非法形态进了索引，
//   **之后所有记忆写入全部失败**，等于把记忆仓锁死，现象只是「记忆好像不更新了」。
//   两道保险：① 建种子时就用合法样板；② 读回来发现不合法就 host 侧修回去。

let impressionBusy = false
/** 定时检查的句柄。声明在 `startImpressionTimer()` 之前 —— `let` 有 TDZ，别踩。 */
let impressionTimer = null
/** 最近一次触发的时刻。用来防「触发失败 → 每 20 分钟又触发一次」的热循环。 */
let impressionLastTriggerAt = 0
const IMPRESSION_RETRY_FLOOR_MS = 30 * 60 * 1000

/**
 * 非强制检查的最小间隔。
 * ⚠️ 必须有：`onLoopIdle()` **每一轮结束都会来一次**，而一次检查要发两条协议请求
 *    （`read_memory_file` + `memory_history`，后者实测 300~500ms）。
 *    不节流就是每一轮对话都白跑一次，纯浪费。
 *    `force:true`（用户点「现在重新总结一次」）不受这个限制。
 */
let impressionLastCheckAt = 0
const IMPRESSION_CHECK_FLOOR_MS = 10 * 60 * 1000

/** 频率（三档：24 / 168 / 0=关）。 */
function impressionEveryHours() {
  return normalizeEveryHours(config.impression?.everyHours)
}

/** 改频率并落盘。返回收敛后的值。 */
function setImpressionEveryHours(v) {
  const hours = normalizeEveryHours(v)
  config.impression = { ...(config.impression ?? {}), everyHours: hours }
  saveConfig()
  return hours
}

const impSleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ★ 记忆内核实例（T3.4 口③）：懒加载，根据 config.engine 选 legacy/local 实现。
// 默认 'legacy' 时 memstore-legacy 只是对 legacy.request 的薄封装，行为零变化。
let _memstore = null
async function getMemstore() {
  if (_memstore) return _memstore
  const { createMemoryStore } = await import('./memstore.mjs')
  const engine = config.engine === 'local' ? 'local' : 'legacy'
  _memstore = await createMemoryStore({
    engine,
    root: ROOT,
    agentId: resolveAgentId() || 'local-agent',
    legacy: engine === 'legacy' ? legacy : undefined,
  })
  return _memstore
}

/** 读一个记忆文件。`null` = 不存在（**不是**错误）；`''` = 存在但是空的。 */
async function readMemoryText(agentId, path) {
  try {
    const store = await getMemstore()
    const content = await store.read(path)
    return content // memstore.read 不存在时返回 null，与原路一致
  } catch (err) {
    log(`记忆中心：读 ${path} 异常（memstore）${err.message}`)
    // 回退原路。⚠️ local 下 `legacy` 是 null，没有「原路」可回 ——
    //    不加这道闸会稳稳抛一个 `Cannot read properties of null (reading 'request')`，
    //    日志里看着像产品坏了，其实只是兜底路径不该被走。
    if (!legacy || !legacyReady) return null
    try {
      const r = await legacy.request('read_memory_file', { agent_id: agentId, path }, 15_000)
      if (r?.success === true) return String(r.content ?? '')
      const err = String(r?.error ?? '')
      if (/ENOENT|no such file/i.test(err)) return null
      log(`记忆中心：读 ${path} 失败（回退）${err.slice(0, 200)}`)
      return null
    } catch (err2) {
      log(`记忆中心：读 ${path} 异常（回退）${err2.message}`)
      return null
    }
  }
}

/**
 * 写一个记忆文件（`write_memory_file` 自带 `git add` + commit）。
 * ⚠️ 超时给到 60 秒：旧后端起后端时会重装 hooks，实测撞上过一次 20 秒才回来。
 * @returns {Promise<boolean>} 是否真的写成功（可能是被记忆校验拒了）
 */
async function writeMemoryText(agentId, path, content) {
  try {
    const store = await getMemstore()
    await store.write(path, content)
    return true
  } catch (err) {
    log(`记忆中心：写 ${path} 异常（memstore）${err.message}`)
    // 回退原路。local 下没有 legacy 可回（理由同 `readMemoryText`）。
    if (!legacy || !legacyReady) return false
    try {
      const r = await legacy.request('write_memory_file', { agent_id: agentId, path, content }, 60_000)
      if (r?.success === true) return true
      log(`记忆中心：写 ${path} 被拒（回退）${String(r?.error ?? '').replace(/\s+/g, ' ').slice(0, 300)}`)
      return false
    } catch (err2) {
      log(`记忆中心：写 ${path} 异常（回退）${err2.message}`)
      return false
    }
  }
}

/**
 * 记忆归档器（host 兜底把她在回合里写的记忆提交进 git）。
 *
 * ★ 为什么必须兜底：**本地后端的 system prompt 只认「已提交」的 revision**
 *   （实测 `coreMemory` ≡ `HEAD:MEMORY.md` 的 git blob，去掉 `<deferred-memory>` 后逐字节相同）。
 *   而她改完文件**不保证**紧接着有 commit —— 印象那条路径实测留下过 2058 秒的脏改动，
 *   表现为「她写了新记忆，但她自己的上下文看不见」。
 *
 * ★ 归档之后**不需要**额外触发重编译：commit 让 revision 前进，
 *   下一轮 `getOrCompileSystemPrompt()` 自己会发现并注入 `<memory_update>` 块。
 *   详细推导见 `src/archive.mjs` 的文件头。
 *
 * 依赖注入而不是直接 import：归档器要读文件与发协议，但单测（`probe/archive-test.mjs`）
 * 要能全换成假的、不起旧后端。
 */
const archiver = createArchiver({
  log,
  request: (type, payload, timeoutMs) => legacy.request(type, payload, timeoutMs),
  readMemoryFile,
  listMemory,
})

/**
 * 跑一轮归档。**fire-and-forget，失败不外抛** —— 归档是后台兜底，
 * 绝不能因为 git 出问题就把回合或面板搞挂。
 */
function archiveMemory(reason, { force = false } = {}) {
  if (!legacy || !legacyReady) return
  const agentId = memoryAgentId()
  if (agentId === '') return
  void archiver.run(agentId, { reason, force }).then((r) => {
    if (r.committed > 0) log(`归档：本轮提交 ${r.committed} 个文件（${reason}）`)
  }).catch((err) => log(`归档：异常 ${err.message}`))
}

/**
 * 印象文件的现状：`{ text, hasFile, seededOnly, lastCommitAt, fileUpdatedAt }`。
 *
 * `lastCommitAt` = 这个文件最后一次进 git 的时间（喂给「历史版本」）。
 * `fileUpdatedAt` = 文件 mtime，**「她上一次动笔」的真相**。
 * 两者会差得很远 —— 原因见 `touchedAtOf()` 的注释。
 */
async function impressionFileState(agentId) {
  const text = await readMemoryText(agentId, IMPRESSION_PATH)
  const hasFile = text !== null
  let lastCommitAt = null
  if (hasFile && config.engine === 'local') {
    /**
     * local：commit 时间直接从**记忆仓自己的 git log** 读（`memstore.commitList`），
     * 不走 `memory_history` —— 那个是旧后端的协议，local 下必然抛错，
     * 只会把 `lastCommitAt` 白发成 null（面板「最后更新于」就只能靠 mtime）。
     */
    try {
      const store = await getMemstore()
      lastCommitAt = latestCommitTime(await store.commitList({ path: IMPRESSION_PATH, limit: 20 }))
    } catch (err) {
      log(`记忆中心：读印象提交历史失败（按「不知道多久没跑」处理）${err.message}`)
    }
  } else if (hasFile) {
    try {
      // 探针实测：`memory_history` **支持 `file_path` 过滤**（查不存在的文件返回空数组），
      // 所以「这个文件最后一次 commit 是什么时候」是拿得到的，不用自己解析 git 对象。
      // ⚠️ 超时给到 30 秒（别的读只用 15 秒）：实测撞出过 `memory_history 超时（15000ms）` ——
      //    那一刻她正在写记忆，git 索引在争用。超时的后果是 lastCommitAt 变 null →
      //    被当成「不知道多久没跑」→ 倾向于再跑一次（有 30 分钟冷却兜着，不会热循环）。
      const h = await legacy.request('memory_history',
        { agent_id: agentId, file_path: IMPRESSION_PATH, limit: 20 }, 30_000)
      lastCommitAt = latestCommitTime(h?.commits)
    } catch (err) {
      log(`记忆中心：读印象历史失败（按「不知道多久没跑」处理）${err.message}`)
    }
  }
  // ⚠️ mtime 放在**最后**读，不要提到函数开头。上面查 `memory_history` 最长要等 30 秒，
  //    先读的话「最后更新于」可能比文件的真实状态旧半分钟 —— 而她完全可能在这 30 秒里
  //    又写了一次（写盘与查询是并行的）。放在 return 前读 = 发这条消息那一刻的最新事实。
  const mtimeMs = readMemoryFile(agentId, IMPRESSION_PATH)?.mtimeMs ?? null
  const fileUpdatedAt = mtimeMs === null ? null : new Date(mtimeMs).toISOString()
  return { text, hasFile, seededOnly: hasFile && isPlaceholder(text), lastCommitAt, fileUpdatedAt }
}

/**
 * 「这份印象最后一次真的被改动」是什么时候 —— 取 commit 时间与正文 mtime 里**较晚**的那个。
 *
 * ⚠️ 为什么不能只看 commit：**「改文件」和「提交」没有绑在一起。**
 *    记忆仓里其实两种提交都有（`.git/config` 的默认身份是 `user.name = Orb`）：
 *      · `旧后端 Agent` 的提交 = **她自己**的记忆工具提交，消息是她写的
 *        （reflog 里有「记录用户信息与我自己的处境」「persona v2.0:…」等实例）；
 *      · `Orb` 的提交 = host 走 `write_memory_file`（建种子 / 建索引 / 修 frontmatter），
 *        标题固定是 `Update memory file <path>`。
 *    但**改完文件之后不保证紧接着有提交** —— 实测（2026-10-07）印象那条路径改完，
 *    记忆仓留着脏改动 ≥19 分钟、没有任何新 commit。
 *
 *    所以这里取**两者较晚**，两种情况都对：
 *      · 她提交了 → 等价于 commit 时间；
 *      · 她没提交 → 退化成 mtime（正确反映「她刚写过」）。
 *    **代码因此不需要断定她「会不会提交」**，也不会出现「刚看她总结完、界面却说几天前」。
 *
 *    反过来说，只认 commit 的版本在脏仓时会**反复触发**（永远觉得「上次是几天前」）。
 */
function touchedAtOf(st) {
  const c = st.lastCommitAt ? Date.parse(st.lastCommitAt) : NaN
  const f = st.fileUpdatedAt ? Date.parse(st.fileUpdatedAt) : NaN
  const best = Math.max(Number.isFinite(c) ? c : -Infinity, Number.isFinite(f) ? f : -Infinity)
  return Number.isFinite(best) ? new Date(best).toISOString() : null
}

/**
 * 确保 `about/MEMORY.md`（子目录索引）和印象文件的种子存在。
 *
 * ⚠️ 顺序不能反：MemFS v2 要求**每个祖先目录都有 `MEMORY.md`**，
 *   没有 `about/MEMORY.md` 的话 `about/印象.md` 本身就是非法的，写了也会被拒。
 */
async function ensureImpressionFiles(agentId) {
  const idx = await readMemoryText(agentId, ABOUT_INDEX_PATH)
  if (idx === null) {
    log(`记忆中心：建子目录索引 ${ABOUT_INDEX_PATH}`)
    await writeMemoryText(agentId, ABOUT_INDEX_PATH, ABOUT_INDEX_CONTENT)
  }

  const cur = await readMemoryText(agentId, IMPRESSION_PATH)
  if (cur === null) {
    log(`记忆中心：建印象文件种子 ${IMPRESSION_PATH}`)
    await writeMemoryText(agentId, IMPRESSION_PATH, IMPRESSION_SEED)
    return
  }

  // ★ 她某次写崩了（没带 frontmatter）→ 整棵树校验过不去 → 之后所有记忆写入全失败。
  //   这里把文件修回合法形态，把记忆仓解锁。不修的话现象只是「记忆不更新了」，根本查不出来。
  const problem = frontmatterProblem(cur)
  if (problem !== null) {
    log(`★ 记忆中心：${IMPRESSION_PATH} 的 frontmatter 不合法（${problem}）→ host 侧修复，否则整个记忆仓都会被锁死`)
    await writeMemoryText(agentId, IMPRESSION_PATH, ensureFrontmatter(cur))
  }
}

/** 按 name 找回我们那条 cron 任务（不把 taskId 存进 config —— 少一处会对不上的状态）。 */
async function findImpressionTask() {
  // local 没有 cron 这个东西：印象整理由宿主直接跑一轮对话（见 `runImpressionLocal`）。
  if (config.engine === 'local') return null
  const r = await legacy.request('cron_list', {}, 20_000)
  return pickTask(r?.tasks)
}

/**
 * 确保 cron 任务存在、处于 paused、且 prompt 是最新措辞。
 * @returns {Promise<object|null>} 任务对象
 */
async function ensureImpressionCron(agentId) {
  let task = null
  try {
    task = await findImpressionTask()
  } catch (err) {
    log(`记忆中心：读 cron 列表失败 ${err.message}`)
    return null
  }

  const wantPrompt = buildImpressionPrompt()

  if (!task) {
    let added = null
    try {
      added = await legacy.request('cron_add', {
        agent_id: agentId,
        conversation_id: 'new',       // 每次新开会话，不污染她的日常对话
        name: TASK_NAME,
        description: TASK_DESC,
        cron: PLACEHOLDER_CRON,       // 占位，不指望它自己到点跑（没有 catch-up）
        timezone: TIMEZONE,
        recurring: true,
        prompt: wantPrompt,
      }, 30_000)
    } catch (err) {
      log(`记忆中心：cron_add 异常 ${err.message}`)
      return null
    }
    task = added?.task ?? null
    if (!task?.id) {
      log(`记忆中心：cron_add 失败 ${JSON.stringify(added).slice(0, 200)}`)
      return null
    }
    log(`记忆中心：已建 cron 任务 ${task.id}`)
    await legacy.request('cron_pause', { task_id: task.id }, 20_000).catch(() => null)
    return task
  }

  // 已存在 → 确保是 paused，防止它真的在凌晨 4 点乱跑
  if (task.status === 'active') {
    await legacy.request('cron_pause', { task_id: task.id }, 20_000).catch(() => null)
    log(`记忆中心：任务 ${task.id} 是 active，已暂停（时机交给 host）`)
  }

  // 措辞改过 → 同步一次。只在真的不一样时才写，避免每次启动都动 crons.json。
  if (typeof task.prompt === 'string' && task.prompt !== wantPrompt) {
    await legacy.request('cron_update',
      { task_id: task.id, prompt: wantPrompt, description: TASK_DESC }, 20_000).catch(() => null)
    log(`记忆中心：任务 ${task.id} 的 prompt 已同步到最新措辞`)
  }
  return task
}

/**
 * 本地引擎的「印象整理」：不走 cron，宿主直接让她跑一个隔离回合。
 *
 * ⚠️ 为什么在**独立会话**里跑（`local-<agentId>#impression`）：
 *    这件事原本交给旧后端时用的是 `conversation_id:'new'` —— 它是她自己的独处时间。
 *    混进用户正在看的会话里会变成「她突然自言自语一大段」，还会把日常对话的上下文冲掉。
 *
 * ⚠️ 这一轮**不往球上推**：她写完文件、面板自己刷新（`followUpImpressionUpdate`）。
 *    真推过去就是凭空在界面上说话。
 *
 * ⚠️ 判「成没成」只认**文件正文变了没有**，不认她说了什么 ——
 *    她完全可能嘴上说「写好了」而工具调用被记忆校验拒掉（frontmatter 写错就会）。
 *
 * @param {string} agentId
 * @param {{reason?:string, before?:string|null, followUp?:boolean}} o
 */
async function runImpressionLocal(agentId, { reason = 'timer', before = null, followUp = true } = {}) {
  const brain = runtime?.brain
  if (!brain) return { ok: false, error: '本地引擎还没起来' }

  const sessionId = `local-${agentId}#impression`
  impressionBusy = true
  impressionLastTriggerAt = Date.now()
  log(`记忆中心：本地直跑印象整理（${reason}）会话=${sessionId}`)
  try {
    let text = ''
    let toolCount = 0
    const prompt = buildImpressionPrompt({ toolName: 'write_memory' })
    for await (const ev of brain.run({ sessionId, userText: prompt })) {
      if (ev.type === 'assistant') text += ev.text
      else if (ev.type === 'tool') toolCount += 1
    }
    const after = readMemoryFile(agentId, IMPRESSION_PATH)?.content ?? null
    const changed = after !== null && after !== before
    if (!changed) {
      log(`记忆中心：本地印象跑完但 ${IMPRESSION_PATH} 没变（工具 ${toolCount} 次，正文 ${text.length} 字）`)
      return { ok: false, error: '她这一轮没有重写印象文件' }
    }
    log(`记忆中心：本地印象已更新（${after.length} 字符，工具 ${toolCount} 次）`)
    if (followUp) followUpImpressionUpdate(agentId, before)
    return { ok: true, local: true, taskId: null }
  } catch (err) {
    log(`记忆中心：本地印象异常 ${err.message}`)
    return { ok: false, error: err.message }
  } finally {
    impressionBusy = false
  }
}

/**
 * 到点了就踢一脚。
 *
 * @param {string} reason 'ready' | 'timer' | 'idle' | 'manual' | 'schedule'
 * @param {{force?: boolean}} [opts] `force:true` = 用户在面板上点了「现在重新总结一次」，无视到期判定
 */
async function maybeRunImpression(reason = 'timer', { force = false, followUp = true } = {}) {
  //旧后端引擎要等它连上；local 引擎压根没这个东西，不能拿它当闸门（原来就是在这里假死的）。
  const isLocal = config.engine === 'local'
  if (!isLocal && (!legacy || !legacyReady)) return { ok: false, error: '旧后端还没就绪' }
  const agentId = memoryAgentId()
  if (agentId === '') return { ok: false, error: '还没有 agent' }
  if (impressionBusy) return { ok: false, error: '上一次触发还在进行中' }

  const everyHours = impressionEveryHours()
  if (!force && everyHours === 0) return { ok: false, error: '已关闭自动总结' }

  // 条件 B：不许和用户自己的对话抢队列。
  // 真撞上也不会丢消息（旧后端会排队），但会在用户说话中间插一段她的自言自语，很难看。
  if (turnInFlight || turnQueue.length > 0) {
    log(`记忆中心：${reason} 检查时她正忙（inFlight=${turnInFlight} 队列=${turnQueue.length}），这一轮跳过`)
    return { ok: false, error: '她正在忙' }
  }

  /**
   * 节流（理由见 `IMPRESSION_CHECK_FLOOR_MS`）。放在读文件之前 —— 省的就是那两条请求。
   *
   * ⚠️ 这里**只判断、不记账**，记账放到底下 runtime 检查通过之后。原因：
   *   冷启动第一次调用（`onLegacyReady` → 'ready'）必然还没有 runtime，会直接放弃；
   *   若在这里就把时间戳记上，接下来 10 分钟的 `idle` 全都会被节流掉 ——
   *   用户的第一次印象要拖到 20 分钟后的定时器才跑，违背「装上就立刻跑第一次」。
   */
  if (!force && impressionLastCheckAt > 0
    && Date.now() - impressionLastCheckAt < IMPRESSION_CHECK_FLOOR_MS) {
    return { ok: false, error: '刚检查过', throttled: true }
  }

  const st = await impressionFileState(agentId)
  const due = dueState({
    // 传 `touchedAtOf` 而不是 `st.lastCommitAt` —— 理由见 `touchedAtOf()` 的注释
    // （commit 时间可能比正文旧很多，用它判「多久没总结」会一直重复触发）。
    hasFile: st.hasFile, lastCommitAt: touchedAtOf(st),
    seededOnly: st.seededOnly, everyHours,
  })

  if (!force) {
    if (!due.due) {
      log(`记忆中心：还不到时候（${due.reason}，名义下次 ${due.nominalAt}）`)
      return { ok: false, error: '还不到时候', due }
    }
    // 防热循环：上次踢了但文件一直没更新（回合失败 / 写盘被拒），别每 20 分钟又踢一次
    const since = Date.now() - impressionLastTriggerAt
    if (impressionLastTriggerAt > 0 && since < IMPRESSION_RETRY_FLOOR_MS) {
      log(`记忆中心：${Math.round(since / 60000)} 分钟前刚触发过、文件还没更新，先压一压`)
      return { ok: false, error: '刚触发过，稍后重试', due }
    }
  }

  /**
   * ⚠️旧后端下 `fireCronTask()` 第一件事是 `getActiveRuntime()`，为 null 直接记 `runtime_unavailable`
   *    —— **失败且不补跑**。所以必须有活 runtime。
   *
   *   旧后端时**故意不调 `ensureRuntime()`**：那会顺手 `send({ type:'session' })` 把用户的当前
   *    会话切走 —— 等于为了跑一个后台任务去动用户正在看的东西。
   *    宁可这一轮不跑，等下一次检查（≤20 分钟）时 runtime 已经在用了。
   *
   * ⚠️ local 例外：会话 id 是固定的（`local-<agentId>`，一个 agent 一条长会话），
   *    `ensureRuntime()` 推的那条 `session` 就是用户本来就在看的那条，不会切走任何东西；
   *    不建的话，用户刚开软件、还没说话就点「现在重新总结一次」会得到「还没有 runtime」。
   */
  if (!runtime) {
    if (!isLocal) {
      log('记忆中心：还没有 runtime（用户还没开始任何会话），等下一轮')
      return { ok: false, error: '还没有 runtime' }
    }
    try {
      await ensureRuntime()
    } catch (err) {
      log(`记忆中心：本地引擎没起来（${err.message}）`)
      return { ok: false, error: err.message }
    }
  }

  // 到这里才算「一次有效检查」—— 记下来，接下来 10 分钟内不再重复读盘。
  // （放在 runtime 检查之后而不是之前，理由见上面那段注释。）
  if (!force) impressionLastCheckAt = Date.now()

  // local：没有 cron 可踢 —— 直接让她跑一轮（跑完就知道成没成，不用再轮询 cron 状态）。
  if (isLocal) return runImpressionLocal(agentId, { reason, before: st.text, followUp })

  const task = await ensureImpressionCron(agentId)
  if (!task?.id) return { ok: false, error: '定时任务不可用' }

  impressionBusy = true
  impressionLastTriggerAt = Date.now()
  log(`记忆中心：触发印象整理（${reason}）task=${task.id}`)
  try {
    const r = await legacy.request('cron_trigger', { task_id: task.id }, 30_000)
    if (r?.success === true) {
      log(`记忆中心：已入队（任务 ${task.id}）`)
      // 自动触发这条路**没人**会去重推面板 —— 补上，否则用户开着面板时
      // 她明明刚写完，面板还停在旧内容上，看起来像「点了没反应」。
      // ⚠️ 不 await：这一等最长 3 分钟，而这里是 onLoopIdle / onLegacyReady 的链路。
      if (followUp) followUpImpressionUpdate(agentId, st.text)
      return { ok: true, taskId: task.id }
    }
    const error = String(r?.error ?? JSON.stringify(r).slice(0, 200))
    // 「Cron scheduler is not running」是已知会出现的（见方案 §0.3），要能**说清楚**而不是静默
    log(`记忆中心：cron_trigger 失败 ${error}`)
    return { ok: false, error }
  } catch (err) {
    log(`记忆中心：cron_trigger 异常 ${err.message}`)
    return { ok: false, error: err.message }
  } finally {
    impressionBusy = false
  }
}

/**
 * 触发之后轮询等文件真的更新。
 * 不能立刻回读 —— 她要先跑完一个回合、写完盘、commit 上，10~60 秒很正常。
 * 验收清单要求「点重新总结 → 1 分钟内面板刷新」，所以这个等待必须有。
 *
 * ⚠️ 判「变没变」用**磁盘直读**（`readMemoryFile`，5ms、零协议请求），
 *    不要在这轮里反复发 `memory_history` —— 她此刻正在写盘，git 本来就争用，
 *    实测撞出过 15 秒超时。真正的权威读数留给最后那一次 `sendImpression()`。
 */
async function waitImpressionUpdated(agentId, beforeText, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    await impSleep(5000)
    const now = readMemoryFile(agentId, IMPRESSION_PATH)?.content ?? null
    if (now !== null && now !== beforeText) return true
  }
  return false
}

/**
 * 触发成功之后，**后台**等她写完盘，再把新面板推给 UI。
 *
 * 由调用方 `void` 掉，**绝不 await**：这一等最长 3 分钟，而调用点是
 * `onLoopIdle`（回合收尾链路）和 `onLegacyReady`，await 会把界面卡住。
 *
 * ⚠️ **曾经这里还多等一步「等 commit 落地」，已经删掉。**
 *    当时的假设是「写盘之后紧接着就会 commit」——**不成立**：实测印象那条路径改完文件后
 *    十几分钟都没有新 commit。而「最后更新于」现在取的是正文 mtime（理由见 `touchedAtOf()`），
 *    本来就不需要等 commit。
 *    等一个不一定来的东西，只会让面板白晚 90 秒、最后还是带着旧的时间戳。
 *
 * @param {string|null} beforeText 触发前的正文（判断「她到底写了没」）
 */
let impressionFollowUpInFlight = false
function followUpImpressionUpdate(agentId, beforeText) {
  if (impressionFollowUpInFlight) return
  // 面板没开着就没人需要刷新 —— 直接省掉一次最长 3 分钟的轮询。
  if (!impressionPanelOpen) return
  impressionFollowUpInFlight = true
  void (async () => {
    try {
      const wrote = await waitImpressionUpdated(agentId, beforeText)
      if (!wrote) {
        log('记忆中心：等印象正文更新超时（她可能还在跑，或写盘被记忆校验拒了）')
        return
      }
      log('记忆中心：印象已更新，面板自动刷新')
      await sendImpression()
    } catch (err) {
      log(`记忆中心：自动刷新面板失败 ${err.message}`)
    } finally {
      impressionFollowUpInFlight = false
    }
  })()
}

/**
 * 初始化（建骨架 / 建任务）的**进行中 promise**。
 *
 * ⚠️ 面板读文件前**必须**等它。冷启动那几秒骨架还在写 —— 每个文件都要 `git add` + commit，
 *    实测要几秒到几十秒。不等就会读到「文件不存在」→ 面板显示「还没总结过 / 空正文」，
 *    而且**再也不会自动纠正**（没有第二次推送）。
 *    踩过：wire 探针第一次拿到 `exists:false` / `seededOnly:false`，而同一时刻磁盘上
 *    文件明明已经建好了 —— 纯粹是面板跑在了写入前面。
 */
let impressionEnsurePromise = null

/** 面板有没有被打开过。骨架建完后据此补推一次，避免冷启动那几秒的空面板永久停住。 */
let impressionPanelOpen = false

/** 把印象面板要的全套数据推给球。 */
async function sendImpression() {
  const agentId = memoryAgentId()
  if (agentId === '') {
    send({ type: 'impression', ok: false, error: '还没有 agent', text: null })
    return
  }
  // ⚠️ 等骨架写完再读（理由见 `impressionEnsurePromise` 的注释）
  if (impressionEnsurePromise) {
    try { await impressionEnsurePromise } catch { /* 内部已记日志，这里只是别让它冒泡 */ }
  }
  send({ type: 'impression', loading: true, agentId })

  const everyHours = impressionEveryHours()
  try {
    const st = await impressionFileState(agentId)
    // 与 `maybeRunImpression()` 里那处保持一致：判「该不该跑」也用 `touchedAtOf`。
    // ⚠️ 这里若还用 `st.lastCommitAt`，面板会**自相矛盾** ——
    //    标题写「2 分钟前更新」（mtime），底下却按几天前的 commit 说「还不到时候」。
    const due = dueState({
      hasFile: st.hasFile, lastCommitAt: touchedAtOf(st),
      seededOnly: st.seededOnly, everyHours,
    })

    // 任务信息缺了不算失败 —— 正文能出来才是面板的主体
    let task = null
    try { task = summarizeTask(await findImpressionTask()) } catch { /* 忽略 */ }

    const problem = st.hasFile ? frontmatterProblem(st.text) : null
    // 「最后更新于」= 她上一次动笔（正文 mtime / commit 里较晚的那个），**不是** commit 时间。
    // 理由见 `touchedAtOf()`：改文件和提交没绑在一起，只看 commit 会显示成旧的。
    const touchedAt = touchedAtOf(st)
    const committedMs = st.lastCommitAt ? Date.parse(st.lastCommitAt) : NaN
    const touchedMs = touchedAt ? Date.parse(touchedAt) : NaN
    // 正文比最后一次 commit 新 → 这一版还没进「历史版本」。面板可以据此说一句人话，
    // 而不是让用户纳闷「为什么历史里少一版」。
    const historyStale = Number.isFinite(committedMs) && Number.isFinite(touchedMs)
      ? touchedMs > committedMs + 2000
      : false
    send({
      type: 'impression',
      agentId,
      ok: true,
      exists: st.hasFile,
      seededOnly: st.seededOnly,
      text: st.text,
      updatedAt: touchedAt,
      updatedAgo: Number.isFinite(touchedMs) ? formatAgo(Date.now() - touchedMs) : '还没总结过',
      committedAt: st.lastCommitAt,
      historyStale,
      everyHours,
      scheduleLabel: everyHours === 0 ? '已关闭' : (everyHours === 168 ? '每周一次' : '每天一次'),
      nextDueAt: due.nominalAt,
      dueNow: due.due,
      reason: due.reason,
      // 她写的东西格式不对 → 面板要说人话，别让用户看到 'missing-frontmatter'
      lastError: problem !== null
        ? '印象文件格式不合法，已尝试自动修复'
        : (task?.lastError ?? null),
    })
  } catch (err) {
    log(`记忆中心：读印象失败 ${err.message}`)
    send({ type: 'impression', agentId, ok: false, error: err.message, text: null })
  }
}

/** 初始化 + 顺带查一次要不要跑。整条链路失败都不该影响聊天。 */
async function ensureImpression(reason = 'ready') {
  const agentId = memoryAgentId()
  if (agentId === '') return

  const job = (async () => {
    await ensureImpressionFiles(agentId)
    // local 没有 cron 这个东西（印象由宿主直跑，见 `runImpressionLocal`），别去走旧后端协议。
    if (config.engine !== 'local') await ensureImpressionCron(agentId)
  })()
  // 让面板能等到它；失败也要 resolve，别把面板一起拖死
  impressionEnsurePromise = job.catch(() => {})

  try {
    await job
  } catch (err) {
    log(`记忆中心：初始化失败（不影响聊天）${err.message}`)
  }

  // 骨架建完 → 面板如果已经开着，补推一次。
  // 否则用户在最开始那几秒打开面板，会永远停在「还没总结过 / 空正文」上。
  if (impressionPanelOpen) void sendImpression()

  await maybeRunImpression(reason)
}

function startImpressionTimer() {
  if (impressionTimer) return
  impressionTimer = setInterval(() => { void maybeRunImpression('timer') }, CHECK_INTERVAL_MS)
  log(`记忆中心：定时检查已启动（每 ${CHECK_INTERVAL_MS / 60_000} 分钟一次）`)
}

function onBallMessage(msg) {
  // 用户在球上切权限档位：记下来（写回 config.json 持久化）+ 立刻作用到当前 runtime
  if (msg.type === 'permission') {
    const preset = typeof msg.preset === 'string' ? msg.preset : ''
    if (!preset) return
    log(`权限档位切到 ${preset} → ${BALL_PERMISSION_MODES[preset] ?? preset}`)
    config.permission = preset
    saveConfig()
    if (legacy && runtime) {
      legacy.send('change_device_state', {
        runtime,
        payload: { mode: BALL_PERMISSION_MODES[preset] ?? 'unrestricted' },
      })
    }
    return
  }

  switch (msg.type) {
    case 'prompt':
      void onUserPrompt(String(msg.text ?? ''), msg.attachments)
      break
    case 'stop':
      log('用户点了停止')
      turnQueue.length = 0 // 排队的还没发出去，直接丢掉，别再自动续发
      turnInFlight = false
      if (legacy && runtime) {
        legacy.send('abort_message', { runtime })
      }
      setTurn(false, '')
      break
    case 'new':
      void onNewConversation()
      break
    case 'history':
      sendHistory()
      break
    /**
     * 球点了历史回放里的「图片 ×N」占位 → 按需回传那一张（P2-4 补）。
     *
     * ⚠️ 只能「点了再取」：磁盘上的图是完整 base64，跟着块走会经 innerHTML 级
     *    渲染把面板卡死（见 onUserPrompt 里 imageCount 的注释）。所以走独立回包，
     *    不进 blocks、不进 order。key 形如 `local-conv-114|u:ui-msg-322`。
     */
    case 'image-request': {
      const key = typeof msg.key === 'string' ? msg.key : ''
      const bar = key.indexOf('|')
      const convId = bar > 0 ? key.slice(0, bar) : (runtime?.conversation_id ?? '')
      const rawKey = bar > 0 ? key.slice(bar + 1) : key
      const messageId = rawKey.startsWith('u:') ? rawKey.slice(2) : ''
      // 单张图 base64 超过这个长度就不回传了（防一条几十 MB 的 socket 行把两侧卡住）
      const IMAGE_ECHO_MAX_CHARS = 4_000_000
      const images = messageId === '' ? null : readMessageImages(convId, messageId)
      if (!images || images.length === 0) {
        log(`图片回取：${key} 没找到（conv=${convId} msg=${messageId}）`)
        send({ type: 'image-data', key, images: [] })
        break
      }
      const out = []
      let skipped = 0
      for (const img of images) {
        if (img.data.length > IMAGE_ECHO_MAX_CHARS) {
          skipped += 1
          continue
        }
        out.push({ mimeType: img.mimeType, dataURL: `data:${img.mimeType};base64,${img.data}` })
      }
      log(`图片回取：${key} 命中 ${images.length} 张 → 回传 ${out.length} 张${skipped > 0 ? `，跳过超大 ${skipped} 张` : ''}`)
      send({ type: 'image-data', key, images: out, skipped })
      break
    }
    // ---------------------------------------------------------------- 双模式（方案 §2 / §5）
    // 球的来信：
    //   { type:'switch-mode', mode:'chat' }  切模式（'work' 已退役，传了会被忽略）
    //   { type:'new-session', mode? }               在指定模式（缺省=当前）新建会话
    // host 的回信：
    //   { type:'mode', mode, agentId }              启动就绪后 / 每次切会话、切模式都推
    //
    // ⚠️ `switch-mode` 是**用户显式意图**，不参与隐私锁门禁 —— 它不打开任何被锁的会话。
    //    真要落到一条被强锁的会话上时，switchMode 里没有闸门，靠的是「两种模式各自
    //    的会话列表」：被锁的会话依然在列表里，open 才会过 gateOpen。这里不额外拦。
    case 'switch-mode': {
      const target = String(msg.mode ?? '')
      if (!MODES.includes(target)) {
        log(`球的 switch-mode 带了未知模式 ${JSON.stringify(target)}，忽略`)
        break
      }
      void switchMode(target)
      break
    }
    case 'new-session': {
      const target = MODES.includes(msg.mode) ? msg.mode : mode
      void onNewConversation(target)
      break
    }
    // ---------------------------------------------------------------- 隐私锁
    // 球的来信（方案 §9.2）：
    //   { type:'unlock', input, convId? }  对暗号 / 输密码（先软后强，见 lock-flow）
    //   { type:'lock-now' }                手动上锁
    // host 的回信（形状定义在 lock-flow.mjs）：
    //   { type:'lock', state:'locked'|'unlocked', kind:'soft'|'strong', convId?, attemptsLeft?, hasAgreement? }
    //   { type:'lock-feedback', ok:boolean, kind?, attemptsLeft?, message? }
    //   { type:'soft-agreement', state:'none' }  用户取消了暗号 → 供鲸鱼娘在后续对话里读到
    case 'unlock':
    case 'lock-now':
      lockFlow.handleBallMessage(msg)
      break
    // ---------------------------------------------------------------- 记忆中心（方案 §3）
    // 球的来信：
    //   { type:'memory:list' }                       列记忆（协议优先，磁盘兜底）
    //   { type:'memory:read', path }                 读单个文件原文
    //   { type:'memory:search', query }              全文搜索
    //   { type:'memory:revision-at', at }            时刻 → 那一刻生效的是哪一版
    //   { type:'memory:file-at-ref', path, ref }     精确读某个 git SHA 下的文件（回滚预览）
    //   { type:'memory:commit-diff', sha }           某次 commit 的 diff
    // host 的回信：
    //   { type:'memory', source:'protocol'|'disk', files, commits, head, ... }
    //   { type:'memory:file', path, ok, content, source }
    //   { type:'memory:search-result', query, hits }
    //   { type:'memory:revision' | 'memory:file-at-ref' | 'memory:commit-diff', ... }
    //
    // ⚠️ 一律走 memoryAgentId()，不要直接读 config.agentId —— 双模式下记忆按 agent 分开。
    // ⚠️ `memory:read` 的 path 来自球，**必须先过 isBlockedMemoryPath**：
    //    协议自己只挡「逃出仓库根」，`.git/config` 它是放行的（实测拿到 319 字节）。
    case 'memory:list': {
      void (async () => {
        const t0 = Date.now()
        const agentId = memoryAgentId()
        const cachedNow = memoryCache && memoryCache.agentId === agentId
          && Date.now() - memoryCache.at < MEMORY_CACHE_TTL_MS
        // ⚠️ 冷的时候**先发一条 loading**：实测首次要 3~5 秒，
        //    球上必须有骨架态，否则用户看到的是一块空白，会当成「没有记忆」。
        if (!cachedNow) send({ type: 'memory', loading: true, agentId })
        const m = await memoryListingCached(agentId)
        const ms = Date.now() - t0
        log(`记忆中心(${m.source}${m.cached ? '·缓存' : ''})：${m.files.length} 文件 / `
          + `${m.commits.length} 条 commit / ${m.totalBytes} 字节，耗时 ${ms}ms`)
        send({ type: 'memory', ...m })
      })()
      break
    }
    case 'memory:read': {
      const path = String(msg.path ?? '')
      void (async () => {
        if (isBlockedMemoryPath(path)) {
          log(`记忆：拒绝读取可疑路径 ${JSON.stringify(path)}`)
          send({ type: 'memory:file', path, ok: false, content: '', source: 'guard' })
          return
        }
        const agentId = memoryAgentId()
        if (legacy && legacyReady) {
          try {
            const r = await legacy.request('read_memory_file', { agent_id: agentId, path }, 15_000)
            send({ type: 'memory:file', path, ok: r?.success === true,
              content: r?.content ?? '', source: 'protocol' })
            return
          } catch (err) {
            log(`记忆：协议读文件失败，退回直读磁盘（${err.message}）`)
          }
        }
        const f = readMemoryFile(agentId, path)
        send({ type: 'memory:file', path, ok: Boolean(f), content: f?.content ?? '', source: 'disk' })
      })()
      break
    }
    case 'memory:search': {
      // 协议里**没有**搜索命令（`memory_search` / `search_memory` 都无响应，实测）。
      // 所以这一条只能本机直读 —— 记忆仓就一个文件，够用。
      const hits = searchMemory(memoryAgentId(), msg.query ?? '')
      send({ type: 'memory:search-result', query: String(msg.query ?? ''), hits })
      break
    }
    case 'memory:revision-at': {
      // 协议答不了「某时刻生效的是哪一版」，它只认 git SHA。所以这一条用本机时间线推算。
      send({
        type: 'memory:revision',
        at: String(msg.at ?? ''),
        commit: revisionAt(memoryAgentId(), msg.at),
      })
      break
    }
    case 'memory:file-at-ref': {
      const path = String(msg.path ?? '')
      const ref = String(msg.ref ?? '')
      if (isBlockedMemoryPath(path)) {
        send({ type: 'memory:file-at-ref', path, ref, ok: false, content: null, error: 'path 被守卫拒绝' })
        break
      }
      void (async () => {
        if (config.engine === 'local') {
          // local：git show <ref>:<path> 直读（memstore-local.fileAtRef）。
          // 空串 = 这个 ref 里没有这个文件 —— MEMORY.md 这类文件不会真的是空的，
          // 拿它判「找不到」足够可靠，也让面板口径与旧后端的 success 对齐。
          try {
            const store = await getMemstore()
            const text = await store.fileAtRef(path, ref)
            const ok = text !== ''
            send({
              type: 'memory:file-at-ref', path, ref, ok,
              content: ok ? text : null,
              error: ok ? null : `这个版本里没有 ${path}（或 ref 无效）`,
            })
          } catch (err) {
            send({ type: 'memory:file-at-ref', path, ref, ok: false, content: null, error: err.message })
          }
          return
        }
        try {
          const r = await legacy.request('memory_file_at_ref',
            { agent_id: memoryAgentId(), file_path: path, ref }, 15_000)
          send({ type: 'memory:file-at-ref', path, ref, ok: r?.success === true,
            content: r?.content ?? null, error: r?.error ?? null })
        } catch (err) {
          send({ type: 'memory:file-at-ref', path, ref, ok: false, content: null, error: err.message })
        }
      })()
      break
    }
    case 'memory:commit-diff': {
      const sha = String(msg.sha ?? '')
      void (async () => {
        if (config.engine === 'local') {
          // local：git show --patch（memstore-local.diff）。只读，不排队。
          try {
            const store = await getMemstore()
            const diff = await store.diff(sha)
            send({ type: 'memory:commit-diff', sha, ok: true, diff, error: null })
          } catch (err) {
            send({ type: 'memory:commit-diff', sha, ok: false, diff: null, error: err.message })
          }
          return
        }
        try {
          const r = await legacy.request('memory_commit_diff', { agent_id: memoryAgentId(), sha }, 15_000)
          send({ type: 'memory:commit-diff', sha, ok: r?.success === true,
            diff: r?.diff ?? null, error: r?.error ?? null })
        } catch (err) {
          send({ type: 'memory:commit-diff', sha, ok: false, diff: null, error: err.message })
        }
      })()
      break
    }
    // ---------------------------------------------------------------- 记忆中心（印象总结）
    // 契约见 `记忆中心_落地方案.md` §0.7。球 → host：
    //   { type:'impression-get' }                   打开面板
    //   { type:'impression-refresh' }               立刻重新总结一次
    //   { type:'impression-history-get' }           历史版本列表
    //   { type:'impression-at-get', sha }           读某一版
    //   { type:'impression-schedule', everyHours }  改频率（24 / 168 / 0=关）
    // host → 球：
    //   { type:'impression', loading:true }
    //   { type:'impression', ok, exists, seededOnly, text, updatedAt, updatedAgo,
    //     everyHours, scheduleLabel, nextDueAt, dueNow, reason, lastError }
    //   { type:'impression-history', ok, commits:[{sha,short,date,subject}] }
    //   { type:'impression-at', sha, ok, text, error }
    //   { type:'impression-result', ok, error }
    //
    // ★ 手动归档：面板上给一个「归档这一版」的按钮（或右键菜单项），
    //   用户可以在不等到下一个回合的情况下把脏改动推进历史。
    //   `force:true` 既跳过 5 分钟节流，也仍然守着**静默期** ——
    //   静默期是防「提交半截写入」的，手动触发没有理由绕过它。
    case 'memory:archive-now': {
      void (async () => {
        // ⚠️ 这里是 async 箭头函数的**函数体**，不是 switch 体 —— 想「提前退出」
        //    要用 `return`，`break` 会直接 SyntaxError（踩过）。
        const agentId = memoryAgentId()
        if (agentId === '') {
          send({ type: 'memory:archive-result', ok: false, error: '还没有 agent' })
          return
        }
        if (config.engine === 'local') {
          // local 的写即提交（memstore-local.write 里就 commit 了），所以「立即归档」
          // 只为一种情况存在：**有人绕过工具直接改了盘上的文件**（编辑器、脚本）。
          // commitAll 就是干这个的 —— 有脏改动就提交，没有就如实说没有。
          try {
            const store = await getMemstore()
            const r = await store.commitAll('manual archive')
            const committed = r?.sha ? 1 : 0
            send({
              type: 'memory:archive-result', ok: true,
              committed, checked: 1, hot: 0,
              skipped: committed ? '' : '没有未提交的改动',
            })
            if (committed) log(`归档：手动提交了盘上的脏改动（${String(r.sha).slice(0, 7)}）`)
          } catch (err) {
            send({ type: 'memory:archive-result', ok: false, error: err.message })
          }
          return
        }
        try {
          const r = await archiver.run(agentId, { reason: 'manual', force: true })
          send({
            type: 'memory:archive-result', ok: true,
            committed: r.committed, checked: r.checked, hot: r.hot, skipped: r.skipped ?? '',
          })
        } catch (err) {
          send({ type: 'memory:archive-result', ok: false, error: err.message })
        }
      })()
      break
    }
    // ⚠️ 一律走 `memoryAgentId()` —— 双模式下印象按 agent 分开（闲聊态/工作态各一份）。
    case 'impression-get': {
      impressionPanelOpen = true
      void sendImpression()
      break
    }
    case 'impression-refresh': {
      void (async () => {
        const agentId = memoryAgentId()
        // 触发前先记下**当前正文和 commit 时间** —— 之后分别用来判断
        // 「她到底写了没」和「commit 落地没」。
        const st0 = agentId ? await impressionFileState(agentId) : null
        const before = st0?.text ?? null
        // ⚠️ `followUp:false` —— 手动这条路自己会等、会推，
        //    不关掉的话两条链路会各推一次面板（球会连着收到两个 impression）。
        const r = await maybeRunImpression('manual', { force: true, followUp: false })
        send({ type: 'impression-result', ok: r.ok === true, error: r.error ?? null })
        if (r.ok !== true) return
        // 她写盘要时间，别立刻回读（会读到旧内容）。等**正文**变了就行 ——
        // 「最后更新于」取的就是正文 mtime，不需要再等 commit（理由见 `touchedAtOf()`）。
        const updated = await waitImpressionUpdated(agentId, before)
        log(updated ? '记忆中心：印象已更新，面板刷新' : '记忆中心：等印象更新超时（她可能还在跑，或写盘被拒）')
        await sendImpression()
      })()
      break
    }
    case 'impression-history-get': {
      void (async () => {
        if (config.engine === 'local') {
          // local：直接读记忆仓的 git log（只看印象这一个文件）。
          try {
            const store = await getMemstore()
            const commits = await store.commitList({ path: IMPRESSION_PATH, limit: 60 })
            send({ type: 'impression-history', ok: true, commits })
          } catch (err) {
            send({ type: 'impression-history', ok: false, commits: [], error: err.message })
          }
          return
        }
        try {
          const h = await legacy.request('memory_history',
            { agent_id: memoryAgentId(), file_path: IMPRESSION_PATH, limit: 60 }, 30_000)
          const commits = (h?.commits ?? []).map((c) => ({
            sha: c.sha,
            short: String(c.sha ?? '').slice(0, 7),
            date: c.timestamp ?? null,
            subject: c.message ?? '',
          }))
          send({ type: 'impression-history', ok: true, commits })
        } catch (err) {
          send({ type: 'impression-history', ok: false, commits: [], error: err.message })
        }
      })()
      break
    }
    case 'impression-at-get': {
      const sha = String(msg.sha ?? '')
      void (async () => {
        if (config.engine === 'local') {
          // local：面板翻旧版印象，直接读记忆仓里那个 commit 的文件内容。
          try {
            const store = await getMemstore()
            const text = await store.fileAtRef(IMPRESSION_PATH, sha)
            const ok = text !== ''
            send({ type: 'impression-at', sha, ok, text: ok ? text : null,
              error: ok ? null : `这个版本里没有 ${IMPRESSION_PATH}（或 ref 无效）` })
          } catch (err) {
            send({ type: 'impression-at', sha, ok: false, text: null, error: err.message })
          }
          return
        }
        try {
          const r = await legacy.request('memory_file_at_ref',
            { agent_id: memoryAgentId(), file_path: IMPRESSION_PATH, ref: sha }, 15_000)
          send({ type: 'impression-at', sha, ok: r?.success === true,
            text: r?.content ?? null, error: r?.error ?? null })
        } catch (err) {
          send({ type: 'impression-at', sha, ok: false, text: null, error: err.message })
        }
      })()
      break
    }
    case 'impression-schedule': {
      const hours = setImpressionEveryHours(msg.everyHours)
      log(`记忆中心：频率改为 ${hours === 0 ? '关闭' : `${hours} 小时`}`)
      // 刚打开、又刚好到期 → 顺手跑一次，别让用户等 20 分钟
      if (hours > 0) void maybeRunImpression('schedule')
      void sendImpression()
      break
    }
    // ---------------------------------------------------------------- tcc
    // 球在每次发送前会问一次权限状态（macOS 的屏幕录制/辅助功能授权），
    // helper 的 askTcc() 通过 socket 发过来并等回答，3 秒超时兜底。
    // 不回的话每次发送都白等满 3 秒（见 待办事项.md P1-1）。
    //
    // 回包的形状必须和 helper 内部的 tccUnavailable() 一致：
    //   { applicable: false, appName: '', screen: 'granted', accessibility: 'granted' }
    // tccReady() 判定 applicable === false 即放行。
    // 回包消息类型也确认过就是 'tcc'，helper 收包处是
    // `if (record.type === 'tcc') wait?.(record.status)`。
    case 'tcc':
    case 'tcc-open':
      send({
        type: 'tcc',
        status: { applicable: false, appName: '', screen: 'granted', accessibility: 'granted' },
      })
      break
    // 审批确认卡的回收（local 引擎的工作区文件工具）。
    // 球侧形状：`{type:'question-answer', id, answers:[{id,selected:[label],custom?}]}`
    // 与 `{type:'question-cancel', id}`；broker 负责把「允许/拒绝」翻成 verdict。
    case 'question-answer':
      if (approvalBroker) approvalBroker.answer(String(msg.id ?? ''), msg.answers)
      break
    case 'question-cancel':
      if (approvalBroker) approvalBroker.cancel(String(msg.id ?? ''))
      break
    case 'permission':
    case 'set-overlay':
    case 'set-background':
    case 'set-millifraction':
    case 'menu':
    case 'chrome-windows':
    case 'open-main':
      break
    case 'open':
      void openConversation(String(msg.sessionId ?? msg.id ?? ''))
      break
    // 对话级操作（右键历史列表菜单）：重命名 / 删除 / 锁定
    case 'conversation-action': {
      const action = String(msg.action ?? '')
      const sessionId = String(msg.sessionId ?? '')
      if (action === '' || sessionId === '') {
        send({ type: 'conversation-action-result', ok: false, action, sessionId, error: '参数不全' })
        break
      }
      if (action === 'history.rename') {
        const title = String(msg.payload?.title ?? msg.title ?? '')
        const result = renameConversation(sessionId, title)
        log(`重命名 ${sessionId}：${result.ok ? `→「${result.title}」` : `失败 ${result.error}`}`)
        send({ type: 'conversation-action-result', action, sessionId, ...result })
        // 改完要让列表刷新，否则用户看不到新标题
        if (result.ok) sendHistory()
        break
      }
      if (action === 'history.delete') {
        // 删掉当前所在会话时，把界面切到别的会话，别停在已不存在的 id 上
        const wasCurrent = sessionId === blockScope
        const result = deleteConversation(sessionId)
        log(`删除 ${sessionId}：${result.ok ? '已删除' : `失败 ${result.error}`}`)
        send({ type: 'conversation-action-result', action, sessionId, ...result })
        if (result.ok) {
          sendHistory()
          if (wasCurrent) {
            turnQueue.length = 0
            turnInFlight = false
            resetTranscript()
            blockScope = ''
            send({ type: 'session', sessionId: '' })
          }
        }
        break
      }
      if (action === 'history.set-password') {
        // 强锁密码：**只在这里落盘**（scrypt 哈希，见 lock.mjs）。
        // 原文不写日志、不进记忆、出这个函数就丢 —— 方案 §6 的硬约束。
        const pw = String(msg.payload?.password ?? '')
        if (pw.length === 0) {
          send({ type: 'conversation-action-result', action, sessionId, ok: false, error: '密码不能为空' })
          break
        }
        const okSet = lock.setStrongPassword(pw, sessionId)
        // ⚠️ 不要把 pw 拼进日志。只记「设了 / 没设成」。
        log(`强锁密码${okSet ? '已设置' : '设置失败'}`)
        send({ type: 'conversation-action-result', action, sessionId, ok: okSet })
        break
      }

      if (action === 'history.export') {
        // 逃生通道（方案 §7）：强锁密码忘了时的出路。**不经解锁**、直读磁盘明文。
        // 这不是漏洞 —— 强锁本来就只防「偷看屏幕」，能翻本机文件的人本来就能
        // 自己用记事本打开 messages.jsonl。见 history.mjs 的 exportConversation 注释。
        const r = exportConversation(sessionId)
        log(`导出对话 ${sessionId}：${r.ok ? `→ ${r.path}（${r.bytes} 字节）` : `失败 ${r.error}`}`)
        send({ type: 'conversation-action-result', action, sessionId, ...r })
        break
      }

      // 锁定 / 解锁（对话加密_落地方案.md §5）。
      //
      // 这一条是**开关**，不是单向「上锁」：菜单项文案由球侧按 dataset.locked 决定，
      // 但真正的判定放这里 —— 球侧的 locked 只反映**上一次推送**的快照，
      // 而用户可能连续点两次、或另一条路径先改了状态。
      if (action === 'history.lock') {
        const nowLocked = lock.isConvLocked(sessionId)

        if (nowLocked) {
          // 解锁**不校验密码**。理由（方案 §5 / §7）：
          //   能走到这个菜单，说明用户此刻**已经解开强锁进到界面里了**
          //   （gateOpen 在 openConversation 里拦掉了所有未解锁的入口）。
          //   再要一次密码是纯摩擦 —— 用户刚输过，还锁着的对话根本点不进来。
          //   真正的把关在「打开对话」那一步，不在这里。
          lock.unlockConversation(sessionId)
          log(`对话 ${sessionId} 已取消强锁`)
          send({
            type: 'conversation-action-result',
            action, sessionId, ok: true, locked: false,
          })
          sendHistory()
          break
        }

        // —— 上锁分支：⚠️ 没有密码就绝不允许上锁 ——
        //
        // 这是本功能**唯一一个能把用户永久锁死在外面**的地方，所以拦在最前面：
        //   上锁后 `gateOpen()` 会要求密码（`verifyStrong`→`verifyStrongPassword`），
        //   而 `verifyStrongPassword` 在没设过密码时**恒返回 false**
        //   （`slot?.passwordHash` 为空 → false）。
        //   即：先上锁、后设密码的顺序，产出的是一扇**谁都打不开的门**，
        //   而且 UI 上没有任何提示 —— 用户只会看到「密码一直不对」。
        //   ⇒ 宁可拒绝这次上锁，也不留一把没有钥匙的锁。
        if (!lock.hasStrongPassword(sessionId)) {
          log(`拒绝上锁 ${sessionId}：尚未设置强锁密码（先设密码才能上锁）`)
          send({
            type: 'conversation-action-result',
            action, sessionId, ok: false,
            needPassword: true,
            error: '要先用「设置密码」定一个强锁密码，再回来上锁 —— 否则这把锁没有钥匙，你自己也进不去',
          })
          break
        }

        lock.lockConversation(sessionId)
        log(`对话 ${sessionId} 已挂强锁（共 ${lock.lockedConvIds.length} 条）`)
        send({
          type: 'conversation-action-result',
          action, sessionId, ok: true, locked: true,
        })
        // 立刻刷新列表，否则球上的小锁图标要等下次 sendHistory 才出现
        sendHistory()
        break
      }
      break
    }
    case 'panel':
      break
    case 'disable':
      log('用户停用了悬浮球，退出')
      app.quit()
      break
    default:
      logRaw('球的未处理消息:', msg)
  }
}

// ---------------------------------------------------------------- 用户发消息

/**
 * 拿 runtime，没有就建一个。
 *
 * startRuntime 要 8~40 秒，这期间用户完全可能又点一次发送。原来只有
 * `if (runtime) return` 短路，第二次调用时 runtime 还是 null，于是又走一遍
 * 完整创建流程 → 两个 agent、两个 conversation 同时活着，块消息交叉灌进
 * 同一个球，session 被重置两次，turn 状态互相覆盖（见 待办事项.md P0-1 根因 A）。
 *
 * 用一个共享 promise 兜住窗口期：并发调用者 await 同一个结果，
 * 只有第一个人真正去建runtime。
 */
async function ensureRuntime() {
  if (runtime) return runtime

  // ★★ local engine 分叉（T3.4 口②）
  // engine='local' 时用自建 brain，跳过 startLegacyServer / startRuntime。
  // 默认 'legacy' 走原路，行为完全不变。
  if (config.engine === 'local') {
    if (!runtimePromise) {
      log('[local] 初始化自建引擎 brain…')
      runtimePromise = (async () => {
        // ★ 数据根必须在建任何 store 之前定下来：memory.mjs / session.mjs 都是
        // **惰性**读 env（不是模块顶层冻结），所以这一行生效；engine='legacy' 不设，
        // 仍读旧仓，行为不变。
        if (!process.env.ORB_DATA) process.env.ORB_DATA = join(ROOT, 'data')
        log(`[local] 数据根 ${process.env.ORB_DATA}`)

        const [{ createLLM }, { createMemoryStore }, { createSessionStore }, { createBrain },
          { createSettings }, { createSnapshotService }, { createPolicy, describePolicy },
          { createScheduleStore, startReminderTicker },
          { createWechatBridge, createWechatFront }] = await Promise.all([
          import('./llm.mjs'),
          import('./memstore.mjs'),
          import('./session.mjs'),
          import('./brain.mjs'),
          import('./settings.mjs'),
          import('./snapshot.mjs'),
          import('./policy.mjs'),
          import('./schedule.mjs'),
          import('./wechat.mjs'),
        ])

        // 读 API 配置。密钥归本应用自己的数据根（`<dataRoot>/providers/auth.json`），
        // 旧 `~/.legacy/.../auth.json` 只作为一次性迁移来源，复制过来后不再读它。
        const { readProviderAuth } = await import('./providers.mjs')
        const provider = readProviderAuth({ modelName: config.model, log })
        const { baseUrl, apiKey, model } = provider
        log(`[local] 模型 ${model} @ ${baseUrl}（密钥来自 ${provider.source}）`)

        const agentId = resolveAgentId() || 'local-agent'
        const settings = createSettings({ configPath: CONFIG_PATH, log })
        const llm = createLLM({ baseUrl, apiKey, model, timeoutMs: 60000, settings })
        // 短文案专用实例：同样的 key/model，但关掉思考、输出上限压到 1200。
        // 只给「喜欢理由 / 想对作者说的话」这种两百字的活，别让 max 思考把这件小事拖成半分钟。
        noteLlmRef = createLLM({
          baseUrl,
          apiKey,
          model,
          timeoutMs: 45000,
          settings: { get: () => ({ reasoningEffort: 'off', maxTokens: 1200 }) },
        })
        const memstore = await createMemoryStore({ engine: 'local', root: ROOT, agentId })

        // 余额（2026-10-21 用户要求）：她要能看见「这个账户还有多少钱」，
        // 好自己决定看视频是走「快速看」还是「认真看」——不再由菜单替她选。
        // 每次现读凭据（用户可能在设置里换了 key），5 分钟内复用上次结果。
        const { createBalance } = await import('./balance.mjs')
        const balance = createBalance({
          getAuth: () => {
            const p = readProviderAuth({ modelName: config.model })
            return { baseUrl: p.baseUrl, apiKey: p.apiKey, provider: p.provider }
          },
          warnBelow: Number(config.balanceWarnBelow) > 0 ? Number(config.balanceWarnBelow) : undefined,
          log,
        })
        void balance.snapshot().then((b) => log(`[local] ${balance.describe()}${b?.ok ? '' : '（不影响对话）'}`))

        // 首次运行：给一个内容中性的起点。**不预设章节结构** —— 那几节该长什么样
        // 由她按 persona 自己长出来（用户 2026-10-19 明确保留）。
        try {
          const listing = await memstore.list()
          const files = Array.isArray(listing) ? listing : (listing?.files ?? [])
          if (!files.some((f) => f.path === 'MEMORY.md')) {
            await memstore.write(
              'MEMORY.md',
              '# 记忆\n\n' +
                '## 关于他\n\n' +
                '## 我们之间\n\n' +
                '## 要紧的事\n\n' +
                '<!-- 只放每一轮都必须记得的事。日常流水写 journal/；成篇的东西写 about/<主题>.md。 -->\n',
              'init',
            )
            log('[local] 已初始化空白 MEMORY.md')
          }
        } catch (err) {
          log(`[local] 初始化记忆仓失败（不影响启动）: ${err.message}`)
        }

        const sessionStore = createSessionStore({ agentId })
        const snapshot = createSnapshotService({ memstore, settings, log })
        const persona = readPersona(mode)
        // local 的会话 id 固定：一个 agent 一条长会话，靠压缩控制视窗。
        const sessionId = `local-${agentId}`
        // 审批通道：写文件到白名单外、或覆盖已存在的文件时弹一张确认卡。
        // isConnected 必须是**实时**判断（`send()` 在未鉴权时静默丢弃，
        // 所以连不上时要立刻拒绝，不能等满 120 秒）。
        const { createApprovalBroker } = await import('./approval.mjs')
        approvalBroker = createApprovalBroker({
          send,
          isConnected: () => Boolean(ballSocket) && ballAuthed,
          log,
          // 手机上也得能批：卡片同时推到微信（人不在电脑前时，桌面那张卡等于没人看见，
          // 而工具调用会白等 120 秒然后按拒绝收口）。
          onAsk: (evt) => { try { wechatFront?.notifyAsk(evt) } catch (err) { log(`[wechat] 推审批提示失败: ${err.message}`) } },
          // 桌面先答了的话，手机那条提示得有个回音，否则他会对着一个已消失的卡片回「允许」。
          onSettle: (evt) => {
            if (!evt.reason.includes('手机')) {
              void wechatBridge?.send({ text: `刚才那件事已经处理好了（${evt.approved ? '准了' : '没准'}）。` })
            }
          },
        })

        // 联网：用**同一份** provider 凭据调 DeepSeek 的 `/tools/search` 与 `/tools/fetch`。
        // 这两个是独立端点，不在 `chat/completions` 里 —— 所以「她会不会联网」取决于
        // 我们接没接这两个工具，而不是模型自己有没有内置检索（她之前说「不能联网」是实话）。
        // 接不上不算致命：没有网她还能靠记忆和他说的话活着，只是别让她以为有网。
        let web = null
        try {
          const { createWeb } = await import('./web.mjs')
          web = createWeb({ auth: { baseUrl, apiKey }, log })
          log('[local] 联网已接入（search_web / fetch_url）')
        } catch (err) {
          log(`[local] 联网没接上（${err.message}），这轮她只有记忆和你说的话`)
        }
        // B 站（2026-10-21）：`bili_watch` 让她能真的看见视频画面 ——
        // view/playurl 拿直链、按 sidx 只取关键帧所在分片、Electron 自带 Chromium 解码，
        // 原生分辨率、零外部二进制、不下整片。
        // 两件事必须靠宿主注入，所以这里装配：
        //   ① cookie  —— 从「设置」抽屉扫码登录落下的 `data/bili-auth.json` 取；
        //                没登录也能跑，只是最高 480P（B 站对匿名用户的口径）。
        //   ② 解码    —— `kfdecode.mjs` 一进门就 `import { app, BrowserWindow } from 'electron'`，
        //                纯 Node 环境载不进来，只能在这一层、且只能动态 import。
        // 接不上不算致命：没有 B 站她照样能聊天，只是别让她以为自己看过视频。
        let bili = null
        let biliHistory = null
        try {
          const { createBiliWatch } = await import('./bili-watch.mjs')
          const { createBiliHistory } = await import('./bili-history.mjs')
          const getCookie = async () => {
            try {
              const auth = await ensureBiliAuth()
              return auth.cookieHeader()
            } catch {
              return ''
            }
          }
          // 身份快照给 bili-watch 用：它要在工具结果第一行写清「这次是谁的身份」。
          //
          // ★ 必须 `verify:true`（真问一次 `nav.isLogin`），不能只读本地文件。
          //   用户 2026-10-21 的原话就是「它怎么知道自己登录没登录」——
          //   本地那份 `bili-auth.json` 只能证明「扫过码」，证明不了「现在还有效」。
          //   代价是一次 nav 请求，所以加 60 秒缓存：连着看三条视频只问一次。
          let accountCache = { at: 0, value: null }
          const getAccount = async () => {
            if (accountCache.value && Date.now() - accountCache.at < 60_000) return accountCache.value
            try {
              const auth = await ensureBiliAuth()
              const st = await auth.status({ verify: true })
              const value = {
                loggedIn: st?.loggedIn === true,
                uname: st?.uname ?? '',
                mid: st?.mid ?? 0,
                vip: st?.vip === true,
                // 「刚问过 B 站」——bili-watch 会把这句原样告诉模型，避免它把旧值当现状。
                verified: st?.loggedIn === true || st?.stale === true,
              }
              accountCache = { at: Date.now(), value }
              return value
            } catch {
              // 问不到就当未登录（保守方向：宁可让她说「没登录」，也别让她冒充登录态说话）
              return { loggedIn: false, uname: '', mid: 0, vip: false, verified: false }
            }
          }
          biliHistory = createBiliHistory({ dataRoot: settingsDataRoot(), log })
          biliHistoryStore = biliHistory
          // 点赞/投币/收藏/评论：纯 HTTP，用同一份扫码 cookie 做鉴权（不挂网页）。
          const { createBiliActions } = await import('./bili-actions.mjs')
          biliActionsRef = createBiliActions({ getCookie, log })
          // ★ 字幕（「轻松看」档）。两条必须一起给：
          //   · WBI 签名器 —— 老的 player/v2 对未签名请求会返回**别人视频的字幕**
          //     （实测 8/8 全错），签过名的 player/wbi/v2 才是对的；见 src/wbi.mjs 头注释。
          //   · 落盘 —— 长字幕（>12000 字）不整段塞给模型，写进工作区让她按需 read_file。
          const { createWbi } = await import('./wbi.mjs')
          const { createBiliSubtitle } = await import('./bili-subtitle.mjs')
          const wbi = createWbi({ getCookie, log })
          const biliSubtitles = createBiliSubtitle({ getCookie, sign: wbi.sign, log })
          const saveSubtitle = async (relPath, text) => {
            try {
              const { writeWorkspaceFile } = await import('./workspace.mjs')
              const r = await writeWorkspaceFile(relPath, text)
              log(`[bili] 长字幕已存工作区：${r.path}（${Math.round(r.bytes / 1024)}KB）`)
              return { ok: true, path: r.path }
            } catch (err) {
              log(`[bili] 长字幕落盘失败（不影响已取到的正文）：${String(err?.message || err)}`)
              return { ok: false, error: String(err?.message || err) }
            }
          }
          // ★ 关键帧落盘（2026-10-22）。她**没法把图推给用户看**，只能报路径；
          //   图又只以 base64 活在这一轮的工具结果里 —— 不落盘就等于「看过了，但没人能复核」。
          //   必须走二进制写：`writeWorkspaceFile` 是 utf8 的，把 JPEG 当文本写会得到一个
          //   后缀是 .jpg、内容却是 base64 的坏文件（点开一片空白，还不报错）。
          const saveFrame = async (relPath, base64) => {
            try {
              const { writeWorkspaceBinary } = await import('./workspace.mjs')
              const buf = Buffer.from(String(base64 || ''), 'base64')
              const r = await writeWorkspaceBinary(relPath, buf)
              return { ok: true, path: r.path }
            } catch (err) {
              log(`[bili] 关键帧落盘失败（不影响她这一轮看图）：${String(err?.message || err)}`)
              return { ok: false, error: String(err?.message || err) }
            }
          }
          bili = createBiliWatch({
            getCookie,
            getAccount,
            log,
            subtitles: biliSubtitles,
            saveSubtitle,
            saveFrame,
            // 余额驱动的帧数预算（2026-10-22）：查不到余额就返回 null，工具按「充裕」处理。
            readBalance: async () => {
              try {
                const b = await balance.snapshot()
                return b?.ok ? Number(b.total) : null
              } catch {
                return null
              }
            },
            // 余额 <¥1 时看画面要先问他（复用同一张确认卡，手机上也能答）。
            askApproval: approvalBroker ? approvalBroker.ask : null,
          })

          // 看成功就记一笔（「她在 B 站看过什么」的账本，抽屉与 bili_history 工具共用）。
          // 用包装而不是让 brain 自己记：账本属于宿主侧数据，工具循环不该管落盘。
          const rawWatch = bili.watch
          bili.watch = async (args) => {
            const r = await rawWatch(args)
            if (r?.ok && r.meta?.bvid && r.meta?.cid) {
              biliHistory.record({
                bvid: r.meta.bvid,
                cid: r.meta.cid,
                aid: r.meta.aid,
                page: r.meta.page,
                title: r.meta.title,
                pageTitle: r.meta.pageTitle,
                duration: r.meta.duration,
                quality: r.meta.quality,
                qualityLabel: r.meta.qualityLabel,
                width: r.meta.width,
                height: r.meta.height,
                account: r.meta.account?.uname ?? '',
                frameTimes: (r.meta.frames ?? []).map((f) => f.t),
                // 关键帧落在工作区的哪个目录 —— 概览落账时靠它补路径（见 setSummary）
                framesDir: r.meta.framesDir ?? '',
              })
              // ★ 她自己判定「这条我喜欢」（2026-10-22 用户口径：
              //   「我喜欢的是它自己浏览 B 站看到的视频，而不是我点赞后才加进来的」）。
              //   `bili_watch` 带 `liked:true` 才写，理由用她自己的那句话。
              //   写进去的是 `liked.by='orb'` —— 抽屉的「我喜欢的」只认这一种。
              if (args?.liked === true) {
                const why = String(args?.reason ?? '').trim()
                const w = biliHistory.markLiked(r.meta.bvid, r.meta.cid, { reason: why, by: 'orb' })
                if (w?.ok) log(`[bili] 她自己喜欢上了：${why.slice(0, 30) || '(没写理由)'}`)
              }
              // ★ 看完顺手让她写一句「概览」（用户 2026-10-21：界面上要的是
              //   「这个视频大概说了什么」，不是一堆画质/时间点的技术信息）。
              //   **异步跑、不挡工具返回**：模型拿到画面就能回话，概览在后面补上，
              //   抽屉下次打开就有了。失败也只是少一句概览，不影响别的。
              void summarizeVideo(r)
                .then((s) => {
                  if (!s) return
                  // framesDir 一并给：setSummary 会在正文后面补「画面存 <dir>/」，
                  // 这是代码强制的一条（她没法把图推给用户，只能报路径）。
                  const w = biliHistory.setSummary(r.meta.bvid, r.meta.cid, s, {
                    framesDir: r.meta.framesDir ?? '',
                  })
                  if (w?.ok) log(`[bili] 概览写好了：${s.slice(0, 40)}`)
                })
                .catch((err) => log(`[bili] 概览生成异常：${err?.message || err}`))
            }
            return r
          }
          log(`[local] B 站已接入（bili_watch · ${biliHistory.describe()}）`)
        } catch (err) {
          log(`[local] B 站没接上（${err.message}），这轮她看不了视频`)
        }
        // 文件策略（2026-10-20 用户拍板：读全盘 / 写限白名单 / 危险动作必确认）。
        // `data/policy.json` 不存在时自动落一份缺省；用户直接改它，mtime 一变就重载，
        // 不用重启。白名单缺省就是 `data/workspace/`。
        const policy = createPolicy({ dataRoot: settingsDataRoot(), log })
        log(`[local] 文件策略 ${describePolicy(policy)}`)

        // 闹钟（2026-10-20）：她说「X 点提醒我」→ 落 `data/schedule.json`，
        // 宿主每 30 秒对一次表，到点由**宿主自己**把话播出去，不再跑一遍模型。
        // 为什么不跑模型：到点那一刻没有用户在场，跑模型只会烧 token 还可能胡想；
        // 而且她要说的那句话在排的时候就已经写好了，原样播出来才对得上「我记着了」。
        const scheduleStore = createScheduleStore({ dataRoot: settingsDataRoot(), log })
        log(`[local] ${scheduleStore.describe()}`)

        const brain = createBrain({
          llm,
          memstore,
          persona: persona.text,
          sessionStore,
          agentId,
          settings,
          snapshot,
          log,
          approve: approvalBroker.ask,
          web,
          bili,
          biliHistory,
          // 让她也能替他去点「赞 / 币 / 藏」（和抽屉按钮共用 `runBiliAct`）。
          // ★ 传 null 而不是函数：没有执行器时「工具 + 指南」两处都不该出现
          //   （记忆里的老坑：工具给了、指南没提 ⇒ 她会说「我做不到」）。
          biliAct: biliActionsRef ? runBiliAct : null,
          balance,
          // 嗓子的状态通道：每轮告诉她「这轮会不会真出声 / 上一句有没有念失败」。
          // 语音是宿主念的、结果不回模型，不给这一行她只能默认「他听见了」。
          voice,
          policy,
          schedule: scheduleStore,
          // ★ I5：brain 的 finally 会调这里 —— 回合结束的唯一出口
          onTurnIdle: () => onLoopIdle(),
        })
        // 工作区目录要先建出来。不建的话全新安装第一次 list_dir 会撞 ENOENT
        // （真机探针实测：「工作区里没有这个目录：.」），她连自己手上有什么都看不到。
        try {
          const { ensureWorkspaceRoot } = await import('./workspace.mjs')
          await ensureWorkspaceRoot()
        } catch (err) {
          log(`[local] 建工作区目录失败（不影响启动）: ${err.message}`)
        }

        // persona 指纹进日志：切模式时「人设到底换没换」本来是黑盒，
        // 有了这一段，探针（和排障）拿 readPersona(mode).sha256 一比就知道。
        log(`[local] brain 就绪 agent=${agentId} model=${model} persona=${persona.sha256.slice(0, 12)} ${persona.chars}字`)

        // ── 微信桥：手机也能说话 ───────────────────────────────────────────
        // 三块东西分工：
        //   bridge = 传输（长轮询 / 发消息 / 游标落盘）；
        //   front  = 会话侧（一回一答、忙时排队、把审批卡搬到手机上）；
        //   回合本身走 runWechatTurn —— 它自己 ensureRuntime()，**不把 brain 闭包进来**，
        //   否则切模式重建 runtime 之后，微信还在跟那个已经作废的 brain 说话。
        // 只建一次：bridge 里带着轮询循环和游标状态，重建会把在途那一批丢掉。
        // 具体创建在 ensureWechatBridge() 里（「设置」抽屉改配置后要拆了重建，共用同一份）。
        await ensureWechatBridge()
        // ★ 快照即刻就位：切模式的语义是「现在起用新人格说话」，不是「等你下一句才换」。
        //   不预热的话，system.json 里的 personaHash 要等第一条消息进了 brain.run 才翻，
        //   中途那些后台活（印象整理、闹钟后的自述）仍按旧人格的口径写。
        //   失败不算致命：首轮 brain.run 里的 ensureSnapshot 会照旧再来一次。
        try {
          await brain.ensureSnapshot(sessionId)
        } catch (err) {
          log(`[local] 预热 system 快照失败（不影响收发，首轮会重试）: ${err?.message || err}`)
        }

        // ★ 闹钟心跳的启动器要一起交出去：import 解的 `startReminderTicker` 与
        // `scheduleStore` 都活在这个 IIFE 的作用域里，而「起心跳」那一段写在
        // `await runtimePromise` 之后（那时 blockScope 才设好、球侧才连上）。
        // 早先直接把心脏写在下面直接引用二者，模块层面全是 undefined ⇒
        // `ReferenceError: startReminderTicker is not defined`：启动只丢心跳
        // （记一行「预热失败」），但每次切模式都会被判整次失败并回滚 mode。
        return {
          runtime: { conversation_id: sessionId, agent_id: agentId, brain, engine: 'local' },
          agent: null,
          created: false,
          scheduleStore,
          startReminderTicker,
        }
      })().finally(() => { runtimePromise = null })
    }
    const started = await runtimePromise
    if (!runtime) {
      runtime = started.runtime
      blockScope = runtime.conversation_id
      // local 的「当前会话」从这里起步；之后切历史会话 / 开新会话都只改它（见 setLocalSession）。
      localSessionId = runtime.conversation_id
      send({ type: 'session', sessionId: runtime.conversation_id })
      sendMode()
      log(`[local] runtime就绪 agent=${runtime.agent_id} conv=${runtime.conversation_id}`)
      // runtime 就绪这一刻球可能已经连上了（开机预热是典型情况），补一屏历史。
      // 球若还没连上，这里的 send 会被丢弃 —— 那种顺序由球鉴权处再补一次。
      replayCurrentLocalIfBlank()

      // 闹钟心跳。放在这里而不是进程启动时，是因为「到点说话」需要一条已就绪的会话
      // （blockScope 设好了、球侧也连上了才能上屏）。只起一次：runtime 因切模式重建时
      // 不该再叠一个 setInterval —— 两个心跳会对着同一份 schedule.json 各播一遍。
      // runtime 还没建就到点的那些，takeDue 会照常扣掉并记账，只是那一句不播
      // （见 speakReminder：宁可少说，不要重启后补播一串旧提醒）。
      if (!reminderTicker) {
        reminderTicker = started.startReminderTicker({
          store: started.scheduleStore,
          log,
          onFire: (item) => speakReminder(item),
        })
        log('[local] 闹钟心跳已起（30 秒对一次表，到点由宿主直接说）')
      }

      // 微信桥同样只起一次。start() 自己是幂等的（已在跑就回 {started:false}），
      // 没配 / 没开 / 缺 token 都只打一行日志不抛 —— 手机上收不到消息不该拖垮桌面。
      // 放在 runtime 就绪处而不是进程启动时：第一轮回复要能立刻跑，桥先起会导致
      // 「收到消息但 runtime 还在热身」时白回一句「出了点岔子」。
      if (wechatBridge) {
        const st = wechatBridge.start()
        if (st.started) log('[local] 微信桥已起（手机发来的消息走单独一条会话）')
      }
    }
    return runtime
  }

  // legacy 原路
  if (!legacyReady) throw new Error('旧后端还没就绪')
  if (!runtimePromise) {
    log('开始创建 runtime（可能要等 8~40 秒）…')
    const target = resolveAgentId()
    /**
     * ★ 主对话挂回（用户 m02698）。
     *
     * 恢复时机**就是这里**，不是启动那一刻：本进程启动时不建 runtime，
     * 用户发出第一条消息才走到 `ensureRuntime()`（`drainTurns` 是唯一生产调用者）。
     * 所以「每次打开软件默认进主对话」= **本次会话的第一条消息落在主对话上**，
     * 而不是开机就白付 8~40 秒的建 runtime 代价（用户确认的口径：首条消息时恢复）。
     */
    resumedMainConversation = liveMainConversation(mode)
    if (resumedMainConversation) log(`准备挂回主对话 ${resumedMainConversation}`)
    runtimePromise = startRuntime(legacy, {
      agentId: target,
      model: config.model,
      name: agentNameFor(mode),
      description: agentDescriptionFor(mode),
      // ⚠️ 只在「要现建 agent」时有意义。后端走 agent_id 分支时不会重写 system，
      //    传了也白传 —— 既有 agent 改人格请用 tools/apply-persona.mjs。
      system: target ? undefined : personaFor(mode),
      // null = 新建（首次运行、或主对话已被删）。非 null 时旧后端复用那条会话。
      conversationId: resumedMainConversation,
      permission: config.permission,
    }).finally(() => {
      runtimePromise = null
    })
  }
  const started = await runtimePromise
  if (!runtime) {
    runtime = started.runtime
    blockScope = runtime.conversation_id ?? 'pending'
    // ⚠️ 必须落盘，否则每次启动都新建 agent —— 记忆会被彻底丢掉
    // （config.json 里 agentId 会一直是 null，本地还会堆出一堆同名僵尸 agent）。
    if (runtime.agent_id) {
      const isNew = resolveAgentId() !== runtime.agent_id
      if (rememberAgent(runtime.agent_id)) {
        log(isNew ? `已新建 ${mode} agent ${runtime.agent_id}（已记入 config.json，下次启动复用）` : `复用已有 agent ${runtime.agent_id}`)
      }
    }
    log(`runtime就绪 agent=${runtime.agent_id} conv=${runtime.conversation_id}`)
    send({ type: 'session', sessionId: runtime.conversation_id })
    sendMode()
    /**
     * 主对话收尾（用户 m02698）：
     *   - 挂回成功 → **补一次历史回放**，否则球上是空的，看起来像记忆丢了；
     *   - 新建 → 立刻记成主对话（`rememberMainConversation` 幂等，写盘一次）。
     */
    const readyConv = runtime.conversation_id ?? null
    if (resumedMainConversation && readyConv === resumedMainConversation) {
      log(`已挂回主对话 ${readyConv}`)
      replayHistory(readyConv)
    } else {
      rememberMainConversation(mode, readyConv)
    }
    resumedMainConversation = null
  }
  return runtime
}

/**把一条消息真正发给旧后端（已确保有 runtime）。 */
function dispatchPrompt(rt, item) {
  lastAssistantKey = null // 新回合开始，usage 会挂到本轮的 assistant 块上
  // 本轮 assistant 块的起点。markTurnResponse() 只在 [这里, end] 范围内操作，
  // 不会误伤历史轮次的 response 标记（球按 user 块切 turn，折叠时每轮只显示
  // 带 data-response 的那条 —— 擦了标记上一轮正文就整块消失）。
  turnAssistantFrom = order.length
  // ★ local 引擎：同一个回合队列，换一条出口。放在上面两个状态位赋值之后分叉，
  // 是为了让 usage 挂本轮 assistant 块、markTurnResponse 只动本轮这两条语义保持不变。
  if (rt?.engine === 'local') {
    void runLocalTurn(rt, item)
    return
  }
  // 排障：切会话后发消息曾出现「日志说已发出但零 delta」。
  // 把 runtime 的关键字段和 otid 打全，才能区分是 runtime 不对还是 id 撞车。
  const attach = Array.isArray(item.attachments) ? item.attachments : []
  log(`dispatch → conv=${rt?.conversation_id ?? '(无)'} agent=${rt?.agent_id ?? '(无)'} otid=${item.id} 附件=${attach.length}`)
  legacy.send('input', {
    runtime: rt,
    payload: {
      kind: 'create_message',
      // ⚠️ client_message_id 必须用入队时就固定的那个，不能现读 userSeq。
      // 排队期间 userSeq 会被后续消息改掉（实测：第一条发 u-2，排队中的第二条
      // 发出时已经变成 u-3，与第三条撞 id，旧后端直接丢弃，界面表现为无响应）。
      messages: [{
        role: 'user',
        content: buildUserContent(item.text, attach),
        client_message_id: item.id,
      }],
    },
  })
}

/**
 * local 引擎的一个回合：把 brain 的事件流翻译成球侧块。
 *
 * ⚠️ 收尾（剥 mood 标记 / 挂 usage / markTurnResponse / settle）必须发生在
 * 收到 `done` 事件时、**在 for await 里面**。原因：brain 的 `finally` 会立刻调
 * `onTurnIdle()` → `onLoopIdle()` → `turnInFlight=false` + 放下一条队列，
 * 而 generator 的 finally 是在 for await 结束的瞬间执行的 —— 放在循环之后做收尾，
 * 会和下一回合的开局抢同一个 `turnAssistantFrom`。
 */
async function runLocalTurn(rt, item) {
  const { brain } = rt
  const attach = Array.isArray(item.attachments) ? item.attachments : []
  const assistantKey = `a:${item.id}`
  const reasoningKey = `r:${item.id}`
  let assistantRaw = ''
  let reasoningText = ''
  let noticeSeq = 0

  /** brain 的工具参数是对象；球侧（与旧后端路径一致）要的是可读文本 */
  const argsToText = (args) => {
    if (args === undefined || args === null) return ''
    if (typeof args === 'string') return args.slice(0, 4000)
    try { return JSON.stringify(args, null, 2).slice(0, 4000) } catch { return String(args).slice(0, 4000) }
  }

  /** brain 的 usage → 球侧 usage 字段名 */
  const toUiUsage = (u) => ({
    inputTokens: u?.promptTokens ?? 0,
    outputTokens: u?.completionTokens ?? 0,
    totalTokens: u?.totalTokens ?? 0,
    cacheReadTokens: u?.cacheHitTokens ?? 0,
    cacheWriteTokens: u?.cacheMissTokens ?? 0,
    reasoningTokens: u?.reasoningTokens ?? 0,
  })

  const finalize = (usage) => {
    // ★ 可观测性：思考 token 必须落进日志，否则「到底有没有在思考」永远只能靠猜。
    //   实测口径：reasoningTokens 来自 completion_tokens_details.reasoning_tokens。
    if (usage) {
      const ru = toUiUsage(usage)
      log(`[local] 用量 ${item.id} 思考=${ru.reasoningTokens} 输出=${ru.outputTokens} 输入=${ru.inputTokens} 缓存命中=${ru.cacheReadTokens}`)
    }
    // 收尾这一遍：被流式扣住的半截 mood 标记要放出来（否则尾巴永久少一截）
    if (blocks.has(key(assistantKey))) {
      const { text } = resolveMoodText(assistantRaw, false)
      const rec = blocks.get(key(assistantKey))
      if (text !== rec?.text || usage) {
        // ★ resend 收的是**已带前缀的完整 key**（见 :459 的 key() 与 :468 的注释），
        //   这里若传裸的 assistantKey 会变成 `conv|conv|a:...` 这种废 key。
        resend(key(assistantKey), 'assistant', text, false, usage ? { usage: toUiUsage(usage) } : {})
      }
    }
    // 没有还在转的块了：和 onDelta 的 settle(()=>true) 同一语义，
    // 但那个 settle 是 onDelta 内部的闭包，这里直接用 blocks 自己走一遍。
    for (const [k, rec] of blocks) {
      if (rec.running) resend(k, rec.kind, rec.text, false)
    }
    // 播报收尾：把没说完的残句吐出来（不然一句话结尾没句号，就永远少半截）。
    // 必须放在 resend 之后 —— 顺序反了不影响正确性，但日志里「话没念完」的原因会更难读。
    speech.finish()
    markTurnResponse()
    setTurn(false, '')
  }

  // ★ 2026-10-20：整轮认住「开跑时的会话」。putBlock 用的是**当前** blockScope（:703），
  //   而用户可以在回合进行中切走 —— 那时流式增量会被打进新打开的会话（实测：临时会话的
  //   回合切到 #wechat 后继续 putBlock，块 key 前缀变成 #wechat，切回去就是幽灵块/错位内容）。
  //   一旦当前会话不再是本回合这条：brain 继续跑、继续落盘，但一个块都不往球上推；
  //   切回来时 replayHistory 会从磁盘把完整一轮重放出来。
  const turnConv = rt.conversation_id
  const uiAlive = () => currentLocalSession() === turnConv
  let saidSwitched = false

  log(`[local] 回合开始 ${item.id} conv=${rt.conversation_id}`)
  try {
    for await (const ev of brain.run({
      sessionId: rt.conversation_id,
      userText: item.text ?? '',
      // ★ 图片随这一轮一起进模型：brain 会把 user content 组
      //   `[{type:'text'},{type:'image_url',image_url:{url:'data:…'}}]` 发给 deepseek-flash
      //   （实测该模型认这张形状且真能看出图里内容）。
      //   没有附件时 images 为空、content 仍是纯字符串，行为与以前完全一致。
      images: attach.map((a) => ({ mimeType: a?.mimeType, data: a?.data, name: a?.name })),
      // 只有在「渲染层给了附件记录却没带数据」时才告诉她图没收着，
      // 否则不要再多说一句「你看不了图」——那是旧行为，现在她看得见。
      extraTail: attach.length > 0 && attach.every((a) => !a?.data)
        ? `（他发来 ${attach.length} 张图片，但图片数据没传过来。）`
        : '',
    })) {
      if (!uiAlive()) {
        // 只留一行日志，别每来一个增量刷一次
        if (!saidSwitched) {
          saidSwitched = true
          // 这次会话欠一次回放：后台收口后由 onLoopIdle 补（见 pendingReplayFor 注释）
          pendingReplayFor = turnConv
          log(`[local] 回合进行中已切走（${turnConv} → ${currentLocalSession() || '(空)'}），本轮剩余增量只落盘不上屏`)
        }
        if (ev.type === 'done') log(`[local] 回合结束 ${item.id}（已切走，不回放）`)
        continue
      }
      switch (ev.type) {
        case 'assistant': {
          assistantRaw += ev.text
          const { text, mood, found, raw: moodRaw } = resolveMoodText(assistantRaw, true)
          // 播报吃**增量**而不是 `text`：`text` 每次都是全量，重复喂会念重。
          // 情绪标记由 speech.mjs 自己再剥一遍（它那条正则比 mood.mjs 宽，
          // 保证「mood 冒号」这几个字不会被念出来）。
          speech.feed(ev.text)
          // 这条守卫只防「正文里只有情绪标记」的空气泡；**整轮一个字都没有**（模型把预算
          // 全烧在 reasoning 上）的情况由 brain 的 notice 事件兜底上屏（见 brain.mjs 空正文分支），
          // 所以这里 break 掉不会让失败变成静默。
          if (text === '' && !blocks.has(key(assistantKey))) break
          putBlock(assistantKey, 'assistant', text, true)
          lastAssistantKey = key(assistantKey)
          if (found && mood) {
            turnMood = mood
            sendMood(mood, '正文标记')
          } else if (found) {
            // 写了标记但认不出：正文已剥干净，表情没动 —— 留痕（见 noteUnknownMood）
            noteUnknownMood(moodRaw)
          }
          break
        }
        case 'reasoning': {
          reasoningText += ev.text
          putBlock(reasoningKey, 'reasoning', reasoningText, true)
          break
        }
        case 'tool': {
          const k = `tool:${ev.id}`
          // 与旧后端路径对齐（main.mjs:3017-3032）：detail.args 是**字符串**，渲染层按文本消费；
          // 这里必须把 brain 给的 args 对象序列化，否则球侧显示 [object Object]。
          if (ev.phase === 'call') {
            putBlock(k, 'tool', String(ev.name ?? 'tool'), true, {
              detail: { args: argsToText(ev.args), result: '', isError: false, meta: '', cwd: '' },
            })
          } else {
            const prevArgs = blocks.get(key(k))?.detail?.args ?? ''
            putBlock(k, 'tool', String(ev.name ?? 'tool'), false, {
              detail: { args: prevArgs, result: String(ev.result ?? '').slice(0, 8000), isError: !!ev.isError, meta: '', cwd: '' },
            })
          }
          break
        }
        case 'notice': {
          noticeSeq += 1
          putBlock(`n:${item.id}-${noticeSeq}`, 'assistant', ev.text, false)
          break
        }
        case 'done': {
          // ★ 2026-10-22：finish_reason 与「空正文」必须落进日志。
          //   此前 llm.mjs:231 产出了 stopReason 却全链路无人消费，一次「思考=1810 / 输出=1810、
          //   content 为 0」的回合在日志里只剩「思考==输出」这个巧合可辨认。
          log(`[local] 回合结束 ${item.id} hash=${ev.promptHash ?? '(无)'} finish=${ev.stopReason ?? '(未知)'}${ev.emptyContent ? ' 空正文' : ''}`)
          finalize(ev.usage)
          break
        }
        default:
          break
      }
    }
  } catch (err) {
    log(`[local] 回合失败 ${item.id}: ${err.message}`)
    // 已切走的话这条报错属于别的会话，推上去反而插进用户正在看的对话里
    if (uiAlive()) putBlock(`err:${item.id}`, 'assistant', `出错了：${err.message}`, false)
    setTurn(false, '')
  }
}

/**
 * 组装用户消息的 content。
 *
 * ★旧后端的 `create_message` 两种形状都收：
 *   - 纯文本：`content: "你好"`（老路径，保留）
 *   - 多模态：`content: [{type:'text',...}, {type:'image', source:{type:'base64', media_type, data}}]`
 *
 * ★ 图片 part 的形状（2026-10-07 实测重定，**推翻上一版结论**）：
 *   **必须**是 legacy 形状 `{type:'image', source:{type:'base64', media_type, data}}`。
 *
 *   依据：websocket `input`/`create_message` 进用户消息的**唯一入口**是 legacy.js
 *   `localContentFromInputContent`（legacy.js:111693，由 `appendUserLocalMessage`
 *   legacy.js:110930 调用）。它只做两件事：留 `text`，其余全部交给
 *   `localImageContentFromLegacyImage`（legacy.js:110293）——后者要求
 *   `part.type === 'image'` 且 `part.source.type === 'base64'`，
 *   **任何不满足的 part 返回 null，被静默丢弃**。
 *   本地后端存储层根本不认识 OpenAI Responses 的 `input_image`/`image_url`
 *   （全文件 `input_image` 只有 4 处，都不在存储层），所以上一版发的
 *   `input_image + dataURL` 会被无声吃掉、连占位都不留。
 *
 *   实测对照（probe/e2e-image-two-providers.mjs 场景 G，插桩 legacy.js:25922）：
 *     legacy 形状   → `user:text|text|text|text|image` → 模型「图里是一个红色圆形和一个蓝色正方形」✅
 *     input_image   → `user:text|text|text|text`       → 模型「我没有收到任何图片」❌
 *
 *   ⚠️ `extractUserContentParts`（legacy.js:433655）虽然认 `input_image`，
 *   但它不在本地后端这条链路上（插桩零命中），拿它当依据是错的——
 *   上一版就是照它写的，方向反了。
 *   ⚠️ `data` 必须是**裸 base64**（本地后端把它原样落进 source.data），不要带 `data:` 前缀。
 *
 * ⚠️ 只在**真有附件**时才切成数组。理由有两条：
 *   1. 纯文本走数组形式在部分后端实现里会被额外解析一遍，无谓开销；
 *   2. 老会话的历史消息全是字符串形状，混着发会让「这轮为什么变了」难排查。
 *
 * ⚠️ 正文可能为空（用户只拖了图、没打字）。这时**不要**发一个空 text part ——
 *    某些实现会把它当成空消息拒绝。给一个占位句子，既满足协议也让球侧历史
 *    显示得出来（历史渲染读的是 putBlock 的那条，不读这里，但日志里好看）。
 */
const IMAGE_ONLY_PLACEHOLDER = '（发来一张图片）'

function buildUserContent(text, attachments) {
  const body = String(text ?? '').trim()
  if (!attachments || attachments.length === 0) return body
  const parts = [{
    type: 'text',
    text: body === '' ? IMAGE_ONLY_PLACEHOLDER : body,
  }]
  for (const a of attachments) {
    // ★ 必须是 legacy 形状，理由见上方注释（legacy.js:110293 localImageContentFromLegacyImage）
    parts.push({
      type: 'image',
      source: { type: 'base64', media_type: a.mimeType, data: a.data },
    })
  }
  return parts
}

/**
 * 回合队列的排水口：一次只发一条。
 *
 * ⚠️ 占位必须在 await ensureRuntime() **之前**做。startRuntime 要8~40 秒，
 * 这期间 turnQueue 还会被新的用户输入 push。若等ensureRuntime 回来才设
 * turnInFlight，中间这个窗口里来的第二条会重进本函数，读到同一个 turnQueue[0]，
 * 于是同一条消息被 input 两次（实测踩过：日志出现两次「已发出：3.11 和3.9」）。
 */
async function drainTurns() {
  if (turnInFlight || turnQueue.length === 0) return
  // ★ R1：总闸必须看「当前引擎是否可用」，而不是「旧后端是否就绪」。
  // 原来这里写死 `if (!legacyReady) return`，而 legacyReady 只由旧后端回调置真
  // ⇒ local 模式下消息永远发不出去，界面永久「正在思考」。
  if (config.engine !== 'local' && !legacyReady) {
    //旧后端还在起（要十几秒）。消息留在队列里，startLegacy() 就绪后会自己调回来。
    // 不这么做的话，用户在旧后端就绪前说的话会直接报错「旧后端还没就绪」。
    return
  }
  // 先占位 + 取走队列头，再去 await。这样并发进来的调用会直接被挡掉。
  turnInFlight = true
  const item = turnQueue.shift()
  log(`取出队列头：${item.text.slice(0, 20)}…（${item.id}，剩余 ${turnQueue.length}）`)
  let rt
  try {
    rt = await ensureRuntime()
  } catch (err) {
    log(`发消息失败: ${err.message}`)
    putBlock(`err:${item.id}`, 'assistant', `发送失败：${err.message}`, false)
    turnInFlight = false
    setTurn(false)
    if (turnQueue.length > 0) void drainTurns()
    return
  }
  dispatchPrompt(rt, item)
  log(`已发出：${item.text.slice(0, 20)}…（${item.id}）`)
}

/**
 * 处理一条用户输入（文本 + 可选图片附件）。
 *
 * `attachments` 的形状由渲染层给出：`[{name, mimeType, data}]`，data 是
 * **不含前缀的 base64**。这里不再校验（host 的 normalizePrompt 已经过了一遍），
 * 只做形状兜底 —— 拿不到数组就当没有。
 */
async function onUserPrompt(text, attachments) {
  const attach = Array.isArray(attachments) ? attachments : []
  // 纯图无字是合法输入（用户拖张图就发）。老逻辑 `!text.trim()` 直接 return，
  // 会把这种消息静默吞掉 —— 与「附件功能不存在」症状一样，分不出来。
  if (!String(text ?? '').trim() && attach.length === 0) return
  // 用户说话了 = 有交互，闲置计时归零（方案 §4.1）
  lockFlow.touch()
  // 「取消暗号 / 约个暗号」在对话里识别，不做菜单入口（方案 §4.2/§4.4）。
  // 纯关键词，不调模型 —— 这条链路要能离线成立。
  lockFlow.noteUserIntent(text)
  userSeq += 1
  // 消息 id 在这里就定下来，跟着消息一起排队。
  // ⚠️ 不能等到发送时再读 userSeq —— 排队期间它会被后续消息改掉。
  //
  // ⚠️⚠️ id 必须**全局唯一**，不能只是进程内序号。踩过：
  //  旧后端把 client_message_id 存成消息的 otid，并按它去重。切到一条历史会话
  //   再发消息时，若沿用 `u-1` 这种从1 重新数起的序号，就会和该会话里已有的
  //   otid=u-1 撞上 →旧后端认定是重复消息**静默丢弃** →
  //   日志显示「已发出」但零delta，界面表现为「一直正在思考」。
  //   验证证据：切到 local-conv-37 后发消息，磁盘里它的 otid 已经是 u-1。
  //   加会话前缀不够（切回同一个会话还是会撞），所以掺入进程随机后缀。
  const id = `u-${blockScope}-${userSeq}-${RUN_TOKEN}`
  // 球侧回显：文本原样，附件画成缩略图块（长度限制的占位文本在块类型里带）。
  // ⚠️ 这里**不能**把 base64 塞进块内容 —— 历史渲染是 innerHTML 级别的，
  //    一条 4MB 的 base64 会让整个面板卡住。球侧只认「有几张图」，不看内容。
  putBlock(`u:${userSeq}`, 'user', text, false, attach.length > 0 ? {
    imageCount: attach.length,
    imageNames: attach.map((a) => a.name).slice(0, 6),
  } : undefined)
  setTurn(true, '正在思考…')
  // sessionId 随队列项一起记下：切会话时要把「已上屏但还没发出去」的这条补写进**它自己**
  // 那条会话（D4）。不记的话队列项只是内存里的孤儿，切走即蒸发。
  turnQueue.push({ id, text, attachments: attach, sessionId: currentLocalSession() })
  await drainTurns()
}

/**
 * 「这条会话欠一次回放」（D3）。
 *
 * 场景：回合跑到一半他切走了（`uiAlive()` 变假，增量只落盘不上屏），随后这轮在后台收口。
 * 他切回来时 `openConversation` 会整条重放 —— 但如果他**本来就停在这条会话上**
 * （切走又切回，期间回合刚好收口），就没人再触发重放，界面停在半截答案上。
 * 这里记一笔，`onLoopIdle()` 收尾时补。
 */
let pendingReplayFor = ''

/**
 * 把队列里还没发出去的用户消息**补写进各自的会话文件**（D4）。
 *
 * 触发场景：用户打完字、块已经上屏，但回合还在跑（turnInFlight），他切走了。
 * 老逻辑直接 `turnQueue.length = 0`，那条消息只活在内存里 → 切回来时凭空消失，
 * 而用户明明看见自己说过了。
 *
 * 这里改成「落盘不发送」：会话文件里留下他确实说过的话（I1：上下文是派生物），
 * 但不再发给模型 —— 否则切到别的会话还会收到上一条会话的回答。
 */
function flushTurnQueue(reason) {
  if (turnQueue.length === 0) return
  const items = turnQueue.splice(0, turnQueue.length)
  const store = runtime?.brain?.sessionStore
  for (const it of items) {
    const sid = typeof it.sessionId === 'string' && it.sessionId !== '' ? it.sessionId : currentLocalSession()
    // 形状与 brain.run 落盘时对齐（src/brain.mjs:848-849 会滤掉没 data 的项，这里先滤一遍）
    const imgs = Array.isArray(it.attachments)
      ? it.attachments
          .filter((im) => im && typeof im.data === 'string' && im.data !== '')
          .map((im) => ({ mimeType: im.mimeType, data: im.data, name: im.name }))
      : []
    try {
      store?.appendMessage?.(sid, { role: 'user', text: it.text, images: imgs })
      log(`队列里没发出的消息已补写进 ${sid}（${reason}）`)
    } catch (err) {
      log(`队列消息补写失败（${sid}）: ${err.message}`)
    }
  }
}

/**
 * 历史抽屉的**节流刷新**（D2）。
 *
 * 新会话、回合收口、改名都需要重推一次列表；但一回合里可能触发好几次，
 * 每次 `listConversations` 都要扫目录 + 读每个 conversation.json，所以合成 500ms 一次。
 */
let historyRefreshTimer = null
function scheduleHistoryRefresh() {
  if (historyRefreshTimer !== null) return
  historyRefreshTimer = setTimeout(() => {
    historyRefreshTimer = null
    try {
      sendHistory()
    } catch (err) {
      log(`历史刷新失败: ${err.message}`)
    }
  }, 500)
  if (typeof historyRefreshTimer.unref === 'function') historyRefreshTimer.unref()
}

// ---------------------------------------------------------------- 历史对话

/**
 * 把历史会话列表推给球。
 *
 * 数据源是本地磁盘而不是旧后端协议 —— App Server 协议里没有
 * 「列出所有 conversation」这个请求（见 history.mjs 头部说明）。
 *
 * 球侧契约（helper/assets/shell.js:1528 renderHistory）只认两个字段：
 *   { sessionId, title }
 * 少了任何一个都会渲染成空白行。
 *
 * 锁定态下多推第三个字段 `locked:true`（方案 §9.2）。此时 **title 是空串** ——
 * 历史标题是首条用户消息截出来的（history.mjs titleFromMessages），
 * 原样推过去等于把内容漏给站在旁边的人，与 §4.1「全部历史进锁定态」自相矛盾。
 * 球侧见到 `locked:true` 就渲染占位行（小锁 + 「已锁定的对话」），**不得渲染 title**。
 */
/**
 * 内部辅助会话：不是「用户自己的对话」，不进历史抽屉。
 *
 * - `local-<agentId>#wechat` —— 微信桥落盘的会话（`runWechatTurn`，:813 一带）
 * - `local-<agentId>#impression` —— 印象整理跑的内部回合
 *
 * 两者和桌面主会话共用一个 agentId，所以 `listConversations(agentId)` 扫目录时会把它们
 * 一起读出来。用户点进去只能看到「一句喂喂喂」或「四段一模一样的内部提示」——这就是
 * 2026-10-20 反馈的「这条对话加载不出历史」。列表侧挡掉即可；磁盘上照旧，微信桥与印象
 * 整理仍按自己的 sessionId 读写。
 */
const isAuxSessionId = (id) =>
  typeof id === 'string' && /#(?:wechat|impression)$/.test(id)

function sendHistory() {
  let items
  try {
    const agentId = resolveAgentId()
    if (!agentId) {
      // 该模式的 agent 还没建（工作态第一次进来）→ 推空列表，别拿 null 去读盘
      log(`历史对话：${mode} 模式的 agent 还没建，推空列表`)
      send({ type: 'history', items: [] })
      return
    }
    // ★ 2026-10-20（D1 修正）：内部辅助会话**不再从抽屉里删掉**，改成打 kind 标签原样推给球，
    //   抽屉里显示一枚「微信 / 内部」小标。上次直接 filter 掉它们，代价是用户当天在微信里
    //   下派的工作（十几条真实对话）在抽屉里凭空消失 —— 那些内容是他自己写的，必须能点回去。
    //   kind 只影响显示，不影响 openConversation 的闸门（那边用的是不过滤的 listConversations）。
    items = listConversations(agentId).map((it) => {
      const kind = it.sessionId.endsWith('#wechat')
        ? 'wechat'
        : it.sessionId.endsWith('#impression')
          ? 'impression'
          : 'main'
      return kind === 'main' ? it : { ...it, kind }
    })
    if (config.engine !== 'local') for (const it of items) convOwnerCache.set(it.sessionId, mode)
  } catch (err) {
    log(`历史对话读取失败: ${err.message}`)
    items = []
  }
  // 当前会话置顶，其余按时间倒序（listConversations 已经排好了）
  const current = runtime?.conversation_id ?? ''
  if (current !== '') {
    const idx = items.findIndex((it) => it.sessionId === current)
    if (idx > 0) items.unshift(...items.splice(idx, 1))
  }
  // 日志用**原始**标题 —— 排障要看得见；遮罩只发生在最后一步推给球之前。
  log(`历史对话：${items.length} 条${items.length > 0 ? `（最近：${items[0].sessionId}「${items[0].title}」）` : ''}`)
  const out = lockFlow.maskHistory(items)
  const masked = out.reduce((n, it) => n + (it.locked ? 1 : 0), 0)
  if (masked > 0) log(`其中 ${masked} 条处于锁定态：只推占位，不推标题`)
  send({ type: 'history', items: out })
}

/**
 * 切到一条历史会话。
 *
 * 两步，顺序不能反：
 *  1. `startRuntime({ conversationId })` —— 让旧后端真的把运行上下文切过去。
 *     传 null 就是新建（onNewConversation 走的就是那条路）。
 *  2. `readConversationBlocks()` 重放旧消息到球上。
 *
 * ⚠️ 第2 步不能省：旧后端切会话时**不会**把历史消息重推一遍，
 * 只发 runtime_start_response。球上是空的 = 看起来「切了会话但什么都没」。
 *
 * ⚠️ 重放前必须 resetTranscript()，否则新旧块混在一起；
 *   而且要先把 blockScope 设成新会话 id，否则 key 前缀还是旧的
 *   —— 历史块的 id 是 ui-msg-N 形式，和新回合将来产出的 id 完全撞名。
 *
 * ⚠️ 前面还有一道隐私锁闸门（方案 §9.2）：锁定态、或挂了强锁的对话一律拦下，
 *    只推锁定卡片，**不切 runtime、不回放内容**。
 */
async function openConversation(sessionId, opts = {}) {
  if (sessionId === '') {
    log('open 缺 sessionId，忽略')
    return
  }
  lockFlow.touch()
  // ⚠️ 闸门必须在**任何状态改动之前**。先 resetTranscript / abort 再拦就晚了 ——
  //    旧会话已经被清空，球上是白的，用户以为坏了。
  //    `force` 是解锁成功后回头再走一遍用的，必须绕过闸门，否则会把自己拦下死循环。
  if (!opts.force && lockFlow.gateOpen(sessionId)) return
  // ⚠️ 这里判的是**当前模式**的 agent（不是 config.agentId）—— 工作态第一次进来时
  //    `agents.work` 还是空的，这时根本没有可打开的会话，挂起即可、别往下走。
  //    （agent 的真正创建发生在 switchMode / ensureRuntime，那里会带上工作态 persona。）
  // ★ P5：local 只有一份会话列表、一个 agent，不存在「该模式还没有 agent」这件事，
  //   而 legacyReady 在 local 下永远是 false —— 照旧拦会把「点历史对话」整个拦死。
  if (config.engine !== 'local' && (!legacyReady || !resolveAgentId())) {
    // ⚠️ 不能就这么返回 —— 球的 UI 完全没反馈，用户点了像坏了。
    //    冷启动时旧后端要十几秒，这期间点历史对话是常事。
    //    挂到 pendingOpen 上，startLegacy() 连上后自动补做（见那里的调用）。
    log(`旧后端还没就绪或该模式还没有 agent，切会话请求先挂起（目标 ${sessionId}）`)
    pendingOpen = sessionId
    return
  }
  // ★ local 会话切换（2026-10-19 改造）：以前这里写死「只有一条长会话
  //   `local-<agentId>`」，点别的会话直接 return —— 磁盘上明明有微信会话、
  //   印象整理会话、以及用户后来新开的会话，点了全都没反应，看起来就是「历史对话坏了」。
  //   现在允许切到任何**磁盘上真有消息**的会话：brain.run 按 sessionId 找文件，
  //   所以切会话不用重建 runtime，只要换掉当前 id、把历史重铺一遍。
  if (config.engine === 'local') {
    const rt = await ensureRuntime()
    // 存在性判据只有一条：`data/conversations/…/messages.jsonl` 在。历史列表里的 id
    // 本来就来自 listConversations，正常一定存在；这道检查只防手改 / 过期列表。
    if (sessionId !== rt.conversation_id && !listConversations().some((c) => c.sessionId === sessionId)) {
      log(`[local] 会话 ${sessionId} 在磁盘上没有消息，忽略`)
      return
    }
    // D4：切走时**别再丢**队列里已上屏的消息 —— 补写进它们各自那条会话，只是不发。
    flushTurnQueue('切到别的会话')
    turnInFlight = false
    resetTranscript()
    setLocalSession(sessionId)
    log(`[local] 切到会话 ${sessionId}`)
    send({ type: 'session', sessionId })
    sendMode()
    replayHistory(sessionId)
    // 切回来时补上「在途那轮已收口但界面还没补」的那些块（D3）
    if (pendingReplayFor !== '' && pendingReplayFor === sessionId) {
      pendingReplayFor = ''
      replayHistory(sessionId)
    }
    return
  }

  // 已经在当前会话了，别白折腾
  if (runtime?.conversation_id === sessionId) {
    log(`已经在会话 ${sessionId}，无需切换`)
    return
  }

  // 这条会话属于哪个模式？旧后端下两种模式的会话列表是分开的，落错了会把消息发给错的 agent。
  // 归属不一致时先切模式 —— switchMode 自己会收尾（abort + 重放 + 推 session），这里直接返回。
  // ★ P5：local 只有一份会话列表，没有「归属」可言，所以这条分支只在旧后端下生效。
  const owner = config.engine === 'local'
    ? null
    : (convOwnerCache.get(sessionId) ?? sniffConversationMode(sessionId))
  if (owner && owner !== mode) {
    log(`会话 ${sessionId} 属于 ${owner} 模式，先切模式再打开`)
    void switchMode(owner, { open: sessionId })
    return
  }

  log(`切换到历史会话 ${sessionId} …`)
  turnQueue.length = 0
  turnInFlight = false
  if (runtime && legacy) {
    try {
      legacy.send('abort_message', { runtime })
    } catch {}
  }
  resetTranscript()

  try {
    const started = await startRuntime(legacy, {
      agentId: resolveAgentId(),
      model: config.model,
      name: agentNameFor(mode),
      conversationId: sessionId,          // ← 与「新建」的唯一区别
      permission: config.permission,
    })
    runtime = started.runtime
    // ⚠️ 必须先改 blockScope 再放块，否则 key 前缀还是旧会话的
    blockScope = runtime.conversation_id ?? sessionId
    log(`已切到 conv=${runtime.conversation_id}`)
    send({ type: 'session', sessionId: runtime.conversation_id })
    sendMode()
    replayHistory(sessionId)
  } catch (err) {
    log(`切换会话失败: ${err.message}`)
  }
}

/** 把磁盘上的历史消息重放成球里的块。 */
function replayHistory(sessionId) {
  const loaded = readConversationBlocks(sessionId)
  if (!loaded || loaded.blocks.length === 0) {
    log(`会话 ${sessionId} 没有可回放的消息`)
    return
  }
  for (const b of loaded.blocks) {
    const extra = b.response ? { response: true } : {}
    if (b.usage) extra.usage = b.usage
    // 图片元数据（P2-4 补）：不回传它，切走再切回时气泡里的图就凭空消失
    // （块看起来「从没带过图」）。图本体太大，不随块走 —— 球侧画可点击的
    // 「图片 ×N」占位，点了再走 image-request 单独取。
    if (Number.isInteger(b.imageCount) && b.imageCount > 0) extra.imageCount = b.imageCount
    putBlock(b.key, b.kind, b.text, false, extra)
  }
  // 历史块的序号盘完之后，新回合从这往后接
  turnAssistantFrom = order.length
  log(`已回放 ${loaded.blocks.length} 个历史块（${loaded.participants.length} 轮提问）`)
}

/**
 * 冷启动补一屏（2026-10-19）。
 *
 * 以前 local 冷启动后球上是**空的**：`order` 里没有任何块，球鉴权时那段
 * 「把内存里的块重推一遍」等于什么都没推；而 `ensureRuntime` 的 local 分支
 * 只发了 `session` 和模式，从不回放磁盘上的历史。结果 —— 开机点开面板是一张
 * 白纸，得先手动点一次历史会话才有内容（用户报的「历史点了打不开」里，有一半
 * 其实是「打开全是空的」）。
 *
 * 只在「内存里确实还是空的」时补：`order.length > 0` 说明这一屏本来就该由
 * 内存状态还原（重连场景），再回放一遍会重块。
 */
function replayCurrentLocalIfBlank() {
  if (config.engine !== 'local') return
  if (order.length > 0) return
  if (!ballSocket || !ballAuthed) return
  const sid = currentLocalSession()
  if (!sid) return
  replayHistory(sid)
}

/**
 * 新建会话。先把旧的作废，再开新的。
 *
 * 换会话时若不 abort 旧 runtime，两个 conversation 的块消息会同时往球里灌
 * （旧会话的回合还在跑），而且它们的消息 id序号各自从 1 开始，
 * 会产出同名 key（待办事项.md 根因 B）。
 */
async function onNewConversation(targetMode = mode) {
  if (!MODES.includes(targetMode)) targetMode = mode
  // 在别的模式新建 = 先切过去，由 switchMode 统一收尾（别在这里另写一份切换逻辑）
  if (targetMode !== mode) {
    await switchMode(targetMode, { open: 'new' })
    return
  }
  // ★ local 的「新建对话」（2026-10-19 改造）：以前这里只回一句「本地只有一条长会话」，
  //   点了等于没反应 —— 用户的抱怨之一。现在真开一条新会话：
  //   记忆仓（memfs）是**整个 agent 共用**的，所以新会话不是「另一颗脑子」，
  //   只是「换一段干净的上下文」：她照样记得他，只是不再背着一屏旧对话。
  //   历史列表里也能点回来（id 落在 data/conversations/ 下）。
  if (config.engine === 'local') {
    flushTurnQueue('新开一条对话')
    turnInFlight = false
    resetTranscript()
    const rt = await ensureRuntime()
    const agentId = rt.agent_id || resolveAgentId() || 'local-agent'
    // 秒级时间戳可读、可排序；`#c…` 段不会撞上微信会话（`#wechat`）与印象整理（`#impression`）。
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    let sessionId = `local-${agentId}#c${stamp}`
    // 同一秒内连点两次：加序号，别把上一条空会话覆盖掉（create 不覆盖，但 id 撞了就选不出两条）
    for (let n = 2; rt.brain.sessionStore.exists(sessionId) && n < 100; n += 1) {
      sessionId = `local-${agentId}#c${stamp}-${n}`
    }
    rt.brain.sessionStore.create(sessionId, { summary: '' })
    setLocalSession(sessionId)
    log(`[local] 新开会话 ${sessionId}`)
    send({ type: 'session', sessionId })
    sendMode()
    // D2：新会话要在抽屉里立刻出现（create 现在会建空 messages.jsonl，listConversations 才认它）
    scheduleHistoryRefresh()
    return
  }
  turnQueue.length = 0
  turnInFlight = false
  if (runtime && legacy) {
    // 旧会话的回合还在跑的话，明确打断，否则它会继续往球里推内容
    try {
      legacy.send('abort_message', { runtime })
    } catch {}
  }
  resetTranscript()
  if (!legacyReady) {
    runtime = null
    blockScope = 'pending'
    return
  }
  try {
    const target = resolveAgentId()
    const started = await startRuntime(legacy, {
      agentId: target,
      model: config.model,
      name: agentNameFor(mode),
      description: agentDescriptionFor(mode),
      system: target ? undefined : personaFor(mode),
      conversationId: null,
      permission: config.permission,
    })
    runtime = started.runtime
    blockScope = runtime.conversation_id ?? 'pending'
    if (runtime.agent_id) rememberAgent(runtime.agent_id)
    log(`新会话 conv=${runtime.conversation_id}（${mode} 模式）`)
    // ★ 用户 m02698 的口径：「新对话」**不夺指针** —— 主对话始终是当初那一条，
    //   下次启动还是回到它。这里只在「还没有主对话」时空位认领
    //   （见 claimMainConversationIfEmpty 的注释）。
    claimMainConversationIfEmpty(mode, runtime.conversation_id)
    send({ type: 'session', sessionId: runtime.conversation_id })
    sendMode()
  } catch (err) {
    log(`新建会话失败: ${err.message}`)
  }
}

/**
 * 切换模式。**顺序照抄 openConversation** —— 这两个是同构操作（都是「换 runtime」），
 * 另写一份迟早漏掉某一步。
 *
 * ⚠️ 6 步顺序不能反（方案 §4.2）：
 *   1. 冻队列            —— 别让旧回合继续往球里推
 *   2. abort 旧 runtime  —— 不同 agent 的 runtime 不能并存
 *   3. resetTranscript
 *   4. startRuntime(目标 agent)（agent 不存在就现建，见 personaFor 的说明）
 *   5. blockScope = 新 conv   —— **必须在放块之前**，否则 key 前缀还是旧的
 *   6. send session + sendMode
 *
 * @param {string} target（当前只有 'chat'；'work' 已退役，传了会被 MODES 守卫拒掉）
 * @param {{open?: string}} [opts] `open='new'` 新建；`open=<sessionId>` 指定；省略=最近一条
 */
async function switchMode(target, opts = {}) {
  if (!MODES.includes(target)) {
    log(`switchMode 收到未知模式 ${JSON.stringify(target)}，忽略`)
    return
  }
  const open = opts.open
  if (target === mode && open !== 'new') {
    // 已经在目标模式：只补推一次状态，别白折腾 runtime
    sendMode()
    return
  }
  // ★ local 引擎不依赖旧后端，所以这道闸只对 legacy 引擎有意义。
  //   （以前 local 下永远进这个分支 ⇒ 切模式请求被挂起、永不执行，界面看着像点了没反应。）
  if (config.engine !== 'local' && !legacyReady) {
    log(`旧后端还没就绪，切模式请求先挂起（目标 ${target}）`)
    pendingSwitch = { mode: target, open }
    return
  }
  pendingSwitch = null

  // ★★ local engine 分叉（切模式）
  //  旧后端那边切模式 = abort → 换 conversation → startRuntime；本地没有 agent /
  //   conversation / abort 这些概念，切模式只是「换 persona（chat / work 两张人格卡）
  //   + 重开 brain」。P5 之后**记忆仓不再分模式**，所以这里连 agentId 都不用动。
  //   下面主体几乎每一行都是旧后端语义，所以不塞进去，单独走一条分支，两边互不干扰。
  if (config.engine === 'local') {
    const fromLocal = mode
    // ★ P5（2026-10-19 用户裁定）：**不再按模式分 agent / 分记忆仓**。
    //   以前这里会给工作态现造一个 `orb-work`，于是闲聊与工作各有一份 memfs，
    //   用户在工作态说的「我下周考试」到了闲聊态她完全不知道 —— 那不是陪伴，那是两个陌生人。
    //   现在 agentId 只有一个，切模式 = 换 persona + 重建 brain，记忆与历史对话全部共享。
    //   （旧 `orb-work` 目录留在盘上不删，只是不再被读。）
    const targetAgent = resolveAgentId()
    log(`[local] 切模式 ${fromLocal} → ${target}：人格与说话方式换，记忆不换（agent=${targetAgent ?? '(无)'}）`)
    if (open !== undefined) log(`[local] 忽略 open=${open}：本地一个 agent 只有一条长会话`)
    // 1. 收掉正在飞的那一轮
    turnQueue.length = 0
    turnInFlight = false
    // 2. 上一轮初始化若还在飞，先等它落地再清。否则它的「if (!runtime) 塞回去」
    //    会把旧 brain 装回来 —— 切模式后的第一条消息就发去了旧 persona/旧记忆仓。
    if (runtimePromise) {
      try { await runtimePromise } catch { /* 失败了正好重来 */ }
    }
    // 3. 清掉旧 brain
    resetTranscript()
    runtime = null
    blockScope = 'pending'
    approvalBroker = null   // 旧 broker 绑着旧的 send/isConnected，重建时一并换新
    _memstore = null        // 记忆仓没变，但内核实例要跟着重建的 brain 走（快照/引导语按 persona 变）
    // 4. 状态先改：ensureRuntime 内部按 mode 读 persona
    mode = target
    config.mode = target
    saveConfig()
    invalidateMemoryCache('切模式')
    try {
      const rt = await ensureRuntime()   // 内部会 push session + mode、设好 blockScope
      log(`[local] 已切到 ${target} 模式：agent=${rt.agent_id} conv=${rt.conversation_id}`)
      sendHistory()
    } catch (err) {
      log(`[local] 切模式失败（${fromLocal} → ${target}）: ${err.message}`)
      // 回滚模式标记，别让 UI 显示成已经切好了
      mode = fromLocal
      config.mode = fromLocal
      saveConfig()
      runtime = null
      _memstore = null
      sendMode()
    }
    return
  }

  const from = mode
  log(`切模式 ${from} → ${target}${open === undefined ? '' : `（open=${open}）`} …`)
  // 1
  turnQueue.length = 0
  turnInFlight = false
  // 2
  if (runtime && legacy) {
    try { legacy.send('abort_message', { runtime }) } catch { /* 已经死了就算了 */ }
  }
  // 3
  resetTranscript()
  // 状态先改：后面 ensureRuntime/建 agent/读会话列表都按新模式走
  mode = target
  config.mode = target
  saveConfig()
  runtime = null
  blockScope = 'pending'

  const wantConv = pickConversation(target, open)
  try {
    const known = resolveAgentId(target)
    const started = await startRuntime(legacy, {
      agentId: known,
      model: config.model,
      name: agentNameFor(target),
      description: agentDescriptionFor(target),
      // 第一次进工作态时 known 为 null —— 这一刻建出来的 agent 必须直接带人设
      system: known ? undefined : personaFor(target),
      conversationId: wantConv,
      permission: config.permission,
    })
    runtime = started.runtime
    // 5 —— 先改 blockScope 再放块
    blockScope = runtime.conversation_id ?? 'pending'
    if (runtime.agent_id) rememberAgent(runtime.agent_id)
    log(`已切到 ${target} 模式：agent=${runtime.agent_id} conv=${runtime.conversation_id}`)
    // 6
    send({ type: 'session', sessionId: runtime.conversation_id })
    sendMode()
    if (wantConv) replayHistory(wantConv)
    sendHistory()
  } catch (err) {
    log(`切模式失败（${from} → ${target}）: ${err.message}`)
    // 回滚模式标记，别让 UI 显示成已经切好了
    mode = from
    config.mode = from
    saveConfig()
    sendMode()
  }
}

// ----------------------------------------------------------------旧后端事件 -> 球的块

/**
 *旧后端的 loop 回到空闲（WAITING_ON_INPUT）—— 这是「可以发下一条」的唯一正确信号。
 *
 * 为什么不用 stop_reason：实测 stop_reason 比 WAITING_ON_INPUT 早到 12秒，
 * 其间 loop 仍在收尾。此刻发出去的 input 会被静默丢弃，表现为「一直正在思考」。
 * stop_reason 只用来收尾块（settle + 标记 response），不碰队列。
 */
function onLoopIdle() {
  turnInFlight = false
  // 回合真的结束了 → 记忆可能刚被反射改过，别让面板继续显示上一版。
  // ⚠️ 挂在这里而不是 markTurnResponse：后者在「本轮没有 assistant 正文」时会提前 return
  //    （只走 reasoning + tool 的回合），那种回合也可能写了记忆。onLoopIdle 是**唯一**
  //    可靠的「回合结束」信号（见本文件顶部关于 stop_reason 的说明）。
  invalidateMemoryCache('回合结束')
  /**
   * ★ 记忆归档：回合结束**必须**也查一次。
   *
   * ⚠️ 不能只靠 `memory_updated` 推送 —— 那条推送**只在 `commitResult.committed` 时发**
   *    （legacy.js:238216）。“她改了但没提交”这种情况**不会有任何推送**，
   *    而这恰恰是要兜底的那个场景。onLoopIdle 是唯一可靠的「回合结束」信号（理由见本文件顶部）。
   *
   * ⚠️ local 引擎不需要归档：本地 memstore 写即提交，不存在「写了没提交」的脏改动。
   */
  if (config.engine !== 'local') archiveMemory('turn-end')
  /**
   * 记忆中心：回合结束时正好是「她闲着、且一定有 runtime」的时机，
   * 是检查「印象该不该更新」最省事的一个点（比只靠 20 分钟定时器灵敏）。
   * fire-and-forget，失败不影响任何东西。
   *
   * ⚠️ 两种引擎都要查：local 下由 `runImpressionLocal()` 在此直接跑一轮，
   *    不再需要旧后端那个 agent/cron 链路。
   */
  void maybeRunImpression('idle')
  // D3：回合收口时，若界面正停在**这条**会话上、而它是在途那轮被切走后又切回来的，
  // 补一次回放把「只落盘没上屏」的增量补上。replayHistory 按 message.id 生成 key，
  // 与已有的块同 key 时是覆盖而不是重复，所以补回放是幂等的。
  if (pendingReplayFor !== '') {
    const owed = pendingReplayFor
    if (currentLocalSession() === owed) {
      pendingReplayFor = ''
      log(`回合已收口，补一次回放：${owed}`)
      replayHistory(owed)
    }
  }
  // D2：回合收口后标题/顺序会变（首条用户消息就是标题），刷新抽屉。
  scheduleHistoryRefresh()
  if (turnQueue.length > 0) {
    log(`队列里还有 ${turnQueue.length} 条，发下一条`)
    setTurn(true, '正在思考…')
    void drainTurns()
  } else {
    setTurn(false, '')
  }
}

function onLegacyEvent(msg) {
  // ORB_TRACE_LEGACY=1 打印收到的每一条旧后端消息（排查回合边界时用）
  if (process.env.ORB_TRACE_LEGACY === '1') {
    logRaw('← legacy', JSON.stringify(msg).slice(0, 300))
  }
  // 独立版专用：ORB_LEGACY_TALLY=1 时把消息类型计数打出来。
  // 为什么需要：出现过「loop 状态都收到了、唯独没有 stream_delta」的情况，
  // 只看日志尾部分不清是旧后端没推、还是推了但被onDelta 吞了。
  if (process.env.ORB_LEGACY_TALLY === '1') {
    const t = msg.type
    legacyTally[t] = (legacyTally[t] ?? 0) + 1
    const total = Object.values(legacyTally).reduce((a, b) => a + b, 0)
    if (total % 20 === 1) log(`legacy 消息计数 ${JSON.stringify(legacyTally)}`)
  }
  switch (msg.type) {
    case 'stream_delta':
      onDelta(msg.delta ?? {})
      break
    case 'update_loop_status': {
      const st = msg.loop_status?.status
      if (st) log(`loop_status=${st}`)
      if (st === 'WAITING_ON_INPUT') {
        // 这才是「回合真正结束、可以发下一条」的信号。
        //
        // ⚠️ 不要用 stop_reason 判断：实测 stop_reason 比 WAITING_ON_INPUT 早到
        // 12 秒（stop_reason 先发，loop 还在收尾）。在那之间投入的 input
        // 会被旧后端静默丢弃 —— 日志显示「已发出」，但一条 delta 都没有，
        // 界面上就表现为「一直正在思考」（这正是 P0-1 卡死的直接原因）。
        onLoopIdle()
      }
      break
    }
    case 'control_request':
      logRaw('收到审批请求（第一阶段未处理）:', msg)
      break
    case 'memory_updated': {
      // 记忆仓有新 commit（host 写 / 她的记忆工具写 / 反射 worker 写 都会推这一条）。
      // 记忆列表必须失效 —— 面板不能继续显示上一版。
      const paths = Array.isArray(msg.affected_paths) ? msg.affected_paths : []
      invalidateMemoryCache(`memory_updated ${paths.join(',')}`)
      /**
       * ⚠️ 这里**刻意不触发归档**。
       *
       * 理由：这条推送**只在 `commitResult.committed` 时才发**（legacy.js:238216）——
       * 也就是说，收到它的时刻，工作树**刚被提交过**，「改了但没提交」的场景
       * 在这条路径上根本不存在。实测它每轮都来、每次 `committed:0`，纯属白跑
       * 协议往返（`write_memory_file` 内部要起一次 git）。
       *
       * 真正需要兜底的场景由 `onLoopIdle()` 的 `turn-end` 覆盖，那是**唯一**能
       * 观察到「她写了但没提交」的时机。
       */
      break
    }
    case 'runtime_start_response':
    case 'sync_response':
    case 'abort_message_response':
      break
    default:
      break
  }
}

// ---------------------------------------------------------------- 上下文压缩（用户 m02698）

/**
 * 上下文压缩是旧后端侧**一直开着**的机制（agent 级 `compaction_settings.model='legacy/auto'`
 * + 本地上下文压力阈值），只是这两条 delta 以前没人接：`event_message` /
 * `summary_message` 在 `src/` 下零命中，于是它们掉进 `onDelta` 末尾的
 * 「未映射 delta」日志里 —— 界面上完全看不见，用户以为「它没有上下文压缩」。
 *
 * 两条 delta 的形状（逐字取自 legacy-code bundle 的 `emitCompactionChunks()`）：
 *   `{ message_type:'event_message', event_type:'compaction', event_data:{ trigger } }`
 *   `{ message_type:'summary_message', summary, compaction_stats? }`
 * 一前一后到达，所以先占位（此时只有 trigger）、后补正文与统计。
 *
 * ⚠️ 刻意用**新 kind `notice`**，不借 assistant/reasoning：那两种会被回合收尾逻辑
 *    当成「她的过程 / 正文」参与 `markTurnResponse()`（见该函数注释），一条系统
 *    提示混进去会把本轮的最终答案标记搞乱。球侧对 `notice` 有独立分支
 *    （`helper/assets/shell.js` 的 `createNoticeNode`）。
 */
let compactionNoticeKey = null

/** 探针开关：注入一条假压缩。真压缩要 ~98 万 tokens，本机造不出来（见 onLegacyReady）。 */
const FAKE_COMPACTION = process.env.ORB_FAKE_COMPACTION === '1'

/** 压缩触发原因 → 人话。取值来自 legacy-code（见 `compactForContextPressure` 等调用点）。 */
function compactionTriggerLabel(trigger) {
  if (trigger === 'context_window_limit') return '上下文压力'
  if (trigger === 'context_window_overflow') return '超出模型上下文'
  if (trigger === 'manual') return '手动触发'
  return trigger ? String(trigger) : '未知原因'
}

/** 987654 → `987.7k`；12000000 → `12.0M`。数值不合法给空串（宁可不显示也别显示 NaN）。 */
function formatTokens(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

/** 把 trigger + 统计拼成一行提示文案（有哪项写哪项，缺的整段跳过）。 */
function compactionNoticeText(trigger, stats) {
  const parts = ['上下文已压缩', `触发：${compactionTriggerLabel(trigger)}`]
  const before = Number(stats?.messagesBefore)
  const after = Number(stats?.messagesAfter)
  if (Number.isFinite(before) && Number.isFinite(after) && before > after) {
    parts.push(`隐藏 ${before - after} 条早期消息`)
  }
  const tokBefore = formatTokens(stats?.contextTokensBefore)
  const tokAfter = formatTokens(stats?.contextTokensAfter)
  if (tokBefore && tokAfter) parts.push(`上下文 ${tokBefore} → ${tokAfter} tokens`)
  return parts.join(' · ')
}

/**
 * 压缩事件属于当前会话吗？
 *
 * 压缩在**任何**会话里都可能发生 —— 包括印象任务那条隔离会话
 * （`conversation_id:'new'`，见 `ensureImpressionCron`）。把别的会话的压缩
 * 提示塞进用户正在看的这份 transcript，等于凭空多出一块看不懂的东西。
 */
function compactionInCurrentConversation(delta) {
  const conv = typeof delta.conversation_id === 'string' && delta.conversation_id !== ''
    ? delta.conversation_id : null
  if (!conv) return true
  const mine = runtime?.conversation_id ?? blockScope
  if (conv === mine) return true
  log(`压缩事件属于别的会话（${conv}，当前 ${mine}），忽略`)
  return false
}

function onCompactionEvent(delta) {
  const data = delta.event_data ?? {}
  const trigger = typeof data.trigger === 'string' ? data.trigger : ''
  log(`上下文压缩开始：trigger=${trigger || '(未给)'} conv=${delta.conversation_id ?? blockScope}`)
  // 时间戳进 key：同一条会话可能压很多次，用同一个 key 会互相覆盖
  const raw = `compact:${Date.now()}`
  compactionNoticeKey = key(raw)
  putBlock(raw, 'notice', `${compactionNoticeText(trigger, null)} · 摘要生成中…`, false, {
    detail: { trigger, summary: '', stats: null },
  })
  maybeSettleMemoryAfterCompaction(trigger)
}

function onCompactionSummary(delta) {
  const stats = delta.compaction_stats ?? null
  const summary = typeof delta.summary === 'string' ? delta.summary : ''
  if (compactionNoticeKey === null) {
    // 顺序意外（只收到摘要）：也补一条，别让用户什么都看不到
    log('上下文压缩：只收到 summary_message，补一条提示')
    const raw = `compact:${Date.now()}`
    compactionNoticeKey = key(raw)
    putBlock(raw, 'notice', compactionNoticeText(stats?.trigger, stats), false, {
      detail: { trigger: String(stats?.trigger ?? ''), summary, stats },
    })
    return
  }
  const trigger = blocks.get(compactionNoticeKey)?.detail?.trigger ?? stats?.trigger ?? ''
  const text = compactionNoticeText(trigger, stats)
  log(`上下文压缩完成：${text} · 摘要 ${summary.length} 字`)
  resend(compactionNoticeKey, 'notice', text, false, {
    detail: { trigger, summary, stats },
  })
  compactionNoticeKey = null
}

/**
 * 压缩之后顺带沉淀一次记忆（用户 m02698 拍板的**方案 A**）。
 *
 * 方案 A 的含义：**不碰旧后端自己的 reflectionTrigger**（那是它的设置，改了会影响
 * 别的客户端），改由 host 观察到压缩时调用**项目已有的**印象管线 —— 也就是
 * 「我们的回忆」页那个按钮和每日定时器走的同一条 `maybeRunImpression()`
 * （cron_trigger → 她写 `about/MEMORY.md`）。不新造第二套记忆。
 *
 * 四个取舍写在这里，免得下次有人「顺手改成更合理的样子」：
 *   - `force: true`：不走「还不到时候」的日常节流。压缩本身是稀有事件，碰上了就该沉淀；
 *   - `everyHours === 0`（用户关了自动总结）→ **不补跑**，尊重那个开关；
 *   - 去抖 10 分钟：溢出路径一次最多连压 3 回（`LOCAL_CONTEXT_OVERFLOW_MAX_COMPACTIONS`），
 *     不防就会连踢 3 次；
 *   - 「她正忙」「还没有 runtime」「上一次还在跑」由 `maybeRunImpression()` 自己挡，
 *     这里不重复实现。
 */
const COMPACTION_SETTLE_FLOOR_MS = 10 * 60 * 1000
let compactionSettleAt = 0
function maybeSettleMemoryAfterCompaction(trigger) {
  if (FAKE_COMPACTION) {
    log('压缩沉淀：ORB_FAKE_COMPACTION 探针态，跳过真实沉淀')
    return
  }
  if (impressionEveryHours() === 0) {
    log('压缩沉淀：自动总结已关闭，跳过')
    return
  }
  const now = Date.now()
  if (compactionSettleAt > 0 && now - compactionSettleAt < COMPACTION_SETTLE_FLOOR_MS) {
    log(`压缩沉淀：${Math.round((now - compactionSettleAt) / 60_000)} 分钟前刚沉淀过，跳过`)
    return
  }
  compactionSettleAt = now
  log(`压缩沉淀：触发一次记忆整理（compaction/${trigger || 'unknown'}）`)
  // 不 await：这条链路最长要几分钟，而这里是 delta 分发
  void maybeRunImpression('compaction', { force: true, followUp: true })
}

/** 探针用：造一条完整的两段压缩（真压缩在本机造不出来）。 */
function injectFakeCompaction() {
  log('ORB_FAKE_COMPACTION=1 → 注入一条假压缩（仅探针）')
  onCompactionEvent({
    message_type: 'event_message',
    event_type: 'compaction',
    event_data: { trigger: 'context_window_limit' },
  })
  onCompactionSummary({
    message_type: 'summary_message',
    summary: '（探针）这是被折叠的前文摘要正文：用户与助手讨论了环形菜单与主题背景。',
    compaction_stats: {
      trigger: 'context_window_limit',
      messagesBefore: 42,
      messagesAfter: 8,
      contextTokensBefore: 987654,
      contextTokensAfter: 12345,
    },
  })
}

function onDelta(delta) {
  const type = delta.message_type

  // 把还挂着 running 的块收尾。旧后端不给"思考结束"事件，只能靠下一个阶段来推断：
  // 正文一开始 → 思考结束；回合结束 → 剩下的一律结束。
  // 注意 k 是 blocks 里的完整 key（已带会话前缀），所以用 resend 而不是 putBlock。
  const settle = (predicate) => {
    for (const [k, rec] of blocks) {
      if (rec.running && predicate(rec, k)) resend(k, rec.kind, rec.text, false)
    }
  }

  // ---- 上下文压缩（用户 m02698）----
  // 这两条 delta 是 legacy-code 的 `emitCompactionChunks()` 发的（形见上方注释块）。
  // ⚠️ 必须放在这里、且在末尾那条 `logRaw('未映射 delta…')` 之前 —— 否则压缩
  //    又会被记成「未映射」（历史日志里 `event_message` 就是这么被丢掉的）。
  if (type === 'event_message') {
    if (delta.event_type === 'compaction') {
      if (compactionInCurrentConversation(delta)) onCompactionEvent(delta)
    } else {
      logRaw(`event_message[${delta.event_type ?? '?'}]:`, JSON.stringify(delta).slice(0, 320))
    }
    return
  }
  if (type === 'summary_message') {
    if (compactionInCurrentConversation(delta)) onCompactionSummary(delta)
    return
  }

  // ---- 工具调用 ----
  //旧后端把一次工具调用拆成好几条 delta：
  //   approval_request_message（调用请求）→ client_tool_start（开始执行）→ tool_return_message（结果）
  // 上游 dsh-orb 的 tool 块约定：text = 工具名，detail = { args, result, isError, meta, cwd }。
  // 渲染层靠 text 里的工具名去查图标与文案（transcript-model.js 的 activityKind）。
  if (type === 'client_tool_start' || type === 'approval_request_message') {
    const call = type === 'client_tool_start' ? delta : (delta.tool_call ?? {})
    const id = call.tool_call_id
    const name = type === 'client_tool_start' ? call.tool_name : call.name
    const args = type === 'client_tool_start' ? call.tool_args : call.arguments
    if (!id || !name) return
    settle((rec) => rec.kind === 'reasoning') // 开始用工具了，思考阶段收尾
    const prev = blocks.get(key(`tool:${id}`))?.detail ?? {}
    putBlock(`tool:${id}`, 'tool', String(name), false, {
      detail: { args: String(args ?? '').slice(0, 4000), result: prev.result ?? '', isError: false, meta: '', cwd: '' },
    })
    return
  }

  if (type === 'tool_return_message') {
    const id = delta.tool_call_id
    if (!id) return
    const k = key(`tool:${id}`)
    const prev = blocks.get(k)?.detail ?? {}
    const raw = delta.tool_return
    const result = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
    putBlock(`tool:${id}`, 'tool', blocks.get(k)?.text ?? 'tool', false, {
      detail: { args: prev.args ?? '', result: result.slice(0, 8000), isError: delta.status === 'error', meta: '', cwd: '' },
    })
    return
  }

  if (type === 'reasoning_message') {
    // id 形如 ui-msg-2:reasoning:0，和 assistant 消息共享基础 id（ui-msg-2），
    // 所以同一条回复的思考与正文能天然排在一起。
    const add = typeof delta.reasoning === 'string' ? delta.reasoning : ''
    if (!add) return
    const k = key(`r:${delta.id}`)
    const prev = blocks.get(k)?.text ?? ''
    putBlock(`r:${delta.id}`, 'reasoning', prev + add, true)
    return
  }

  if (type === 'assistant_message') {
    const k = key(`a:${delta.id}`)
    lastAssistantKey = k
    const add = (delta.content ?? [])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
    if (!add) return
    settle((rec) => rec.kind === 'reasoning') // 正文开始了，思考阶段收尾
    // 累积**原始**文本（含标记），再拿它算「给用户看什么」——
    // 这样流式过程中被扣住的半截标记，在下一个 delta 到达时能自己补回来。
    const raw = (rawAssistant.get(k) ?? '') + add
    rawAssistant.set(k, raw)
    // 播报：喂增量（与 local 路径同一条纪律 —— `text` 是全量，重复喂会念重）
    speech.feed(add)
    const { text, mood, found, raw: moodRaw } = resolveMoodText(raw, true)
    // 整条回复只有一个标记、没有正文时，别造一个空气泡出来。
    // （lastAssistantKey 仍会指过去，但 markTurnResponse 见到块不存在会直接返回。）
    if (text === '' && !blocks.has(k)) return
    putBlock(`a:${delta.id}`, 'assistant', text, true)
    if (found) {
      turnMood = mood // 认不出的情绪：只剥标记、不改情绪，所以这里可能是 null
      if (mood) sendMood(mood, '正文标记')
      else noteUnknownMood(moodRaw) // 认不出也要留痕，否则就是静默丢表情
    }
    return
  }

  // usage 挂到「本轮最后一条 assistant 块」。本轮还没有 assistant 正文时
  // （只走了 reasoning + tool）就丢弃 —— 否则会挂到上一轮的块上，
  // 或者掉进末尾的兜底日志变成噪音（待办事项.md P1-3）。
  if (type === 'usage_statistics') {
    if (!lastAssistantKey) return
    resend(lastAssistantKey, 'assistant', blocks.get(lastAssistantKey)?.text ?? '', false, {
      usage: {
        inputTokens: delta.prompt_tokens ?? 0,
        outputTokens: delta.completion_tokens ?? 0,
        totalTokens: delta.total_tokens,
        cacheReadTokens: delta.cached_input_tokens,
        cacheWriteTokens: delta.cache_write_tokens,
        reasoningTokens: delta.reasoning_tokens,
      },
    })
    return
  }

  if (type === 'stop_reason') {
    if (delta.stop_reason === 'requires_approval') {
      // 第一阶段没有审批弹窗（见 参考-协议与踩坑.md 第五节）：
      // standard 模式下 agent 会卡在等审批上，界面表现为「一直正在思考」。
      // 明确告诉用户，不要静默卡着。
      // ⚠️ 这里**不能**调 onLoopIdle 放队列 —— 队列里的下一条会撞上同一个死锁。
      turnInFlight = false
      turnQueue.length = 0
      setTurn(true, '等待授权（当前版本不支持逐次审批，请点停止并改权限档位）')
      return
    }
    log(`回合结束 stop_reason=${delta.stop_reason} conv=${delta.conversation_id ?? blockScope}`)
    // 收尾这一遍：把流式期间被扣住的半截标记放出来，并做**最终**一次剥离。
    // 不做的话，一条以「写了 mood 和值、就是没写右括号」结尾的回复，
    // 尾巴会被永久扣住（显示出来的正文比实际少一截）。
    for (const [k, raw] of rawAssistant) {
      const rec = blocks.get(k)
      if (rec?.kind !== 'assistant') continue
      const { text } = resolveMoodText(raw, false)
      if (text !== rec.text) resend(k, 'assistant', text, false)
    }
    settle(() => true) // 回合收尾，没有还该转的块了
    // 播报收尾（与 local 路径的 finalize 同一个理由：残句必须放出来）
    speech.finish()
    // 标记本轮最终答案。
    //
    // ⚠️ **只降级本轮的块，绝不能碰历史轮次**（实测踩过）。
    // 球按 user 块切分 turn，折叠时每个 turn 里只有带 data-response 的 assistant
    // 才显示（helper/assets/chat.css:171）。若遍历全部 blocks 重发不带
    // response 的版本，会把前面每轮已经打好的标记**全擦掉** ——
    // 现象：发出第 2 条消息后，第 1 轮正文整块消失，只剩「用时 6秒」表头。
    markTurnResponse()
    turnInFlight = false
    // ⚠️ 这里**不**放队列。
    // stop_reason 到达时 loop 还没真正收尾 —— 实测它比 WAITING_ON_INPUT 早到 12秒，
    // 这期间投入的 input 会被旧后端静默丢弃（日志显示「已发出」但一条 delta 都没有，
    // 界面上就是「一直正在思考」）。统一交给 onLoopIdle 处理。
    setTurn(false, '')
    return
  }

  if (type === 'loop_error' || type === 'error_message') {
    const detail = typeof delta.message === 'string' ? delta.message : JSON.stringify(delta).slice(0, 400)
    log(`旧后端报错: ${detail}`)
    putBlock(`err:${Date.now()}`, 'assistant', `旧后端报错：${detail}`, false)
    turnInFlight = false
    setTurn(false, '')
    if (turnQueue.length > 0) void drainTurns()
    return
  }

  if (type === 'status' && typeof delta.message === 'string') {
    send({ type: 'status', text: delta.message })
    return
  }

  // 协议噪音：不需要上屏，静默忽略
  if (type === 'approval_classification_end' || type === 'client_tool_end') return

  // 剩下的是真没映射的，打出来备查
  logRaw(`未映射 delta[${type}]:`, JSON.stringify(delta).slice(0, 320))
}

// ---------------------------------------------------------------- 启动

async function startLegacy() {
  // config.legacyUrl 是一把双刃剑：填了省一次冷启动，但那个进程一旦没了
  // （测试脚本退出、端口回收、重启电脑）就会变成死地址，用户双击 run.cmd 直接起不来。
  // 所以连不上时必须自动回退到自己起一个，而不是把错误抛给用户。
  const configured = config.legacyUrl ?? null
  if (configured) {
    log(`使用已在运行的旧后端：${configured}`)
    const conn = new LegacyConnection(configured)
    try {
      await conn.connect()
      conn.on('event', onLegacyEvent)
      conn.on('closed', () => log('旧后端连接断开'))
legacy = conn
    await conn.request('app_server_info')
    onLegacyReady()
    return
  } catch (err) {
    log(`配置的 legacyUrl 连不上（${err.message}），改为自动启动旧后端`)
      config.legacyUrl = null
    }
  }

  try {
    const { child, wsUrl } = await startLegacyServer({ legacyJs: LEGACY_JS, cwd: ROOT, log })
    log(`旧后端服务端就绪: ${wsUrl}`)
    app.on('before-quit', () => {
      try {
        child.kill()
      } catch {}
    })
    const conn = new LegacyConnection(wsUrl)
    await conn.connect()
    conn.on('event', onLegacyEvent)
    conn.on('closed', () => log('旧后端连接断开'))
    legacy = conn
    await conn.request('app_server_info')
    onLegacyReady()
  } catch (err) {
    log(`旧后端启动失败: ${err.message}`)
    setTurn(false, `旧后端启动失败：${err.message}`)
  }
}

/**
 * 把旧后端的 http 地址推给球。
 *
 * 为什么要运行时推而不是启动时用环境变量：helper 的模块顶层是在 import 时求值的，
 * 那时旧后端还没连上（冷启动要8~40 秒），拿不到地址。
 *
 * 为什么要这个地址：独立版没有 DSH 主窗口，右键菜单里的「打开旧后端界面」
 * 靠它拼出 http://127.0.0.1:<port>。旧后端的 ws 和 http 共用一个端口
 * （启动日志可证：ws://127.0.0.1:49640/ws 与 http://127.0.0.1:49640/v1 同端口）。
 */
/**
 *旧后端就绪后的统一收尾。
 *
 * 抽成函数是因为「连上已有的旧后端」和「自己起旧后端」两条路径
 * 原本各写了一份，重复的部分正是容易漏的补做逻辑 —— 踩过：
 * 新增的 pendingOpen 补做只加在其中一条路径上，另一条直接漏。
 */
function onLegacyReady() {
  legacyReady = true
  log('旧后端已连接')
  pushLegacyEndpoint()
  setTurn(false, '')
  sendMode()
  // 预取记忆列表：`list_memory` 实测每次都要 1.5~1.8 秒、冷启动那次约 5 秒，
  // 把这一次挪到这里，用户点开记忆中心才是热的。失败不影响功能（点开时会重试）。
  void prefetchMemory()
  // 记忆中心：建/修 `about/` 骨架、确保 cron 任务在、顺带查一次要不要跑。
  // 整条链路都失败也不该影响聊天 —— 内部已各自 try/catch，这里只是别让它变成未处理的 rejection。
  void ensureImpression('ready')
  startImpressionTimer()
  // ★ 记忆归档：冷启动查一次。上次退出前留下的脏改动（她写了但没提交）
  //   在这里被收进 git —— 否则那一版记忆一直对她的上下文不可见。
  archiveMemory('ready')
  // 探针专用（`ORB_FAKE_COMPACTION=1`）：造一条压缩提示，验证球侧的展示链路。
  // 真压缩要 ~98 万 tokens（deepseek-flash 的 contextWindow 是 1e6），本机造不出来。
  // 放在这里而不是更早：此时 socket 已鉴权，块能真的推给球。
  if (FAKE_COMPACTION) injectFakeCompaction()
  // 切模式比切会话更「上层」，先补它 —— 它能顺带把会话也切了
  if (pendingSwitch) {
    const p = pendingSwitch
    pendingSwitch = null
    log(`旧后端就绪，补做挂起的切模式 → ${p.mode}`)
    void switchMode(p.mode, { open: p.open })
    return
  }
  if (pendingOpen !== null) {
    const target = pendingOpen
    pendingOpen = null
    log(`旧后端就绪，补做挂起的切会话 → ${target}`)
    void openConversation(target)
    return                     // 切会话会自己重放历史，不要同时排水
  }
  if (turnQueue.length > 0) {
    log(`旧后端就绪，队列里有 ${turnQueue.length} 条待发送`)
    void drainTurns()
  }
}

function pushLegacyEndpoint() {
  const ws = legacy?.url
  if (!ws) return
  const http = ws.replace(/^ws:\/\//, 'http://').replace(/\/ws\/?$/, '')
  send({ type: 'legacy-endpoint', http, ws })
  log(`已把旧后端界面地址推给球：${http}`)
}

async function boot() {
  // 端口可被ORB_SOCKET_PORT 覆盖 —— 只给探针用（见 probe/history-e2e.mjs）。
  // 正常启动仍然是 0（动态端口），避免撞上别的进程占着的端口。
  const wantedPort = Number(process.env.ORB_SOCKET_PORT ?? '0') || 0
  await new Promise((resolve, reject) => {
    ballServer.once('error', reject)
    ballServer.listen(wantedPort, '127.0.0.1', resolve)
  })
  const port = ballServer.address().port
  log(`球的控制 socket 监听 127.0.0.1:${port}（动态端口）`)
  if (process.env.ORB_TRACE === '1') log(`socket token=${token}`)

  // helper 在模块顶层读这几个环境变量，必须在 import 之前设好
  process.env.ORB_SOCKET = `127.0.0.1:${port}`
  process.env.ORB_TOKEN = token
  // DSH 专用（取自定义头像），独立版用不上 —— 留空。
  process.env.ORB_WEB_PORT = ''
  process.env.ORB_APPEARANCE = JSON.stringify({ theme: config.theme, locale: config.locale })

  // ── 「设置」抽屉的读写通道（2026-10-19：模型/密钥 + 微信合成一条）──
  // 为什么落在本进程：写盘要碰 config.json、data/providers/auth.json、data/wechat.json，
  // 改完微信还要重启桥 —— 这三样都只活在这里。helper/lib/main.js 里旧后端时代
  // 的同名 handler 已整段删除（重复 ipcMain.handle 会抛）。
  const { ipcMain } = await import('electron')
  ipcMain.handle('orb:api-config-get', () => apiConfigSnapshot())
  ipcMain.handle('orb:api-config-set', (_event, patch) => applyApiConfig(patch))
  log('[settings] 设置通道已注册（orb:api-config-get / set）')

  // ── 语音播报（2026-10-22）──
  // 为什么单独两条通道、不并进 api-config：
  //   ① tts.json 是**另一个文件**、另一种嵌套形状（provider 段各自一组字段），
  //      塞进 applyApiConfig 会让那个函数同时管四种文件，失败归因变难；
  //   ② 开关（头像旁那颗按钮）与设置页是**同一个真源**，必须走同一条写入口，
  //      否则两处会各写一份、然后互相覆盖。
  ipcMain.handle('orb:tts-get', () => ttsSnapshot())
  ipcMain.handle('orb:tts-set', (_event, patch) => applyTtsPatch(patch))
  ipcMain.handle('orb:speech-toggle', (_event, on) => {
    const next = on === true
    if (next === (ttsState.cfg.enabled === true)) return speechState()
    try {
      saveTtsConfig({ ...ttsState.cfg, enabled: next }, settingsDataRoot())
      log(`[tts] 播报开关 → ${next ? '开' : '关'}`)
    } catch (err) {
      ttsState.lastError = `开关没能写盘：${err?.message || err}`
      log(`[tts] ${ttsState.lastError}`)
      return { ...speechState(), lastError: ttsState.lastError }
    }
    return refreshTts()
  })
  // 试听：固定一句话，走完整条链路（合成 → IPC → 渲染层播放）。
  // 不听一下就没法确认「配的 key 是不是真的能出声」—— 这是设置页唯一的验收手段。
  ipcMain.handle('orb:speech-test', async () => {
    const tts = ttsState.tts ?? buildTts()
    if (!tts) return { ok: false, error: ttsState.lastError || 'TTS 没配好' }
    const text = '喂，听得到吗？我是这样说话的。'
    const r = await tts.speak(text)
    if (!r.ok) {
      ttsState.lastError = r.error ?? '合成失败'
      return { ok: false, error: ttsState.lastError }
    }
    // 试听**不受 enabled 开关影响**：用户就是想先听一耳朵再决定开不开。
    send({
      type: 'speech',
      gen: -1,
      seq: 0,
      mime: r.mime ?? 'audio/mpeg',
      audio: r.audio.toString('base64'),
      chars: text.length,
      ms: r.ms ?? 0,
      preview: true,
    })
    return { ok: true, ms: r.ms ?? 0, bytes: r.audio.length ?? 0 }
  })
  log('[tts] 播报通道已注册（orb:tts-get / set / speech-toggle / speech-test）')

  // ── B 站扫码登录的四个动作（2026-10-21）──
  // 为什么不并进上面的 set：扫码是「动作」不是「字段」—— 它有中间态（等待扫码/已扫待确认/
  // 已过期），要轮询、要有内存里的 qrcode_key，塞进 patch 那种一次写盘的形状里会丢状态。
  ipcMain.handle('orb:bili-status', (_event, opts) => biliSnapshot(opts && typeof opts === 'object' ? opts : {}))
  ipcMain.handle('orb:bili-login-start', async () => {
    const bili = await ensureBiliAuth()
    return await bili.start()
  })
  ipcMain.handle('orb:bili-login-poll', async (_event, qrcodeKey) => {
    const bili = await ensureBiliAuth()
    return await bili.poll(String(qrcodeKey ?? ''))
  })
  ipcMain.handle('orb:bili-logout', async () => {
    const bili = await ensureBiliAuth()
    return await bili.logout()
  })
  // ── 微信扫码配对（2026-10-22，开源版必备）──
  // 与 B 站扫码同一种形状：`start` 取二维码 → 渲染层每 2 秒 `poll` → confirmed 落盘。
  // 不并进 api-config-set 的理由也一样：它有中间态（等待/已扫/过期），要有内存里的 qrcode。
  ipcMain.handle('orb:wechat-pair-start', async () => pairWechat('start'))
  ipcMain.handle('orb:wechat-pair-poll', async (_event, qrcodeKey) => pairWechat('poll', String(qrcodeKey ?? '')))
  log('[settings] 微信配对通道已注册（orb:wechat-pair-start / poll）')

  // 「看过的视频」抽屉：只读本地账本（data/bili-history.json），不联网。
  // ★ 与 bili_watch 共用同一份数据 —— 抽屉里看到的和 `bili_history` 工具读到的是同一个东西。
  ipcMain.handle('orb:bili-history', (_event, opts) => {
    if (!biliHistoryStore) return { ok: false, items: [], liked: [], error: '浏览记录没接上' }
    const limit = Math.max(1, Math.min(Number(opts?.limit) || 50, 200))
    return {
      ok: true,
      items: biliHistoryStore.list({ limit }),
      // 「我喜欢的」：liked 有值的那些，按喜欢时间倒序
      liked: biliHistoryStore.listLiked({ limit }),
      total: biliHistoryStore.count(),
    }
  })
  ipcMain.handle('orb:bili-history-clear', () => {
    if (!biliHistoryStore) return { ok: false, error: '浏览记录没接上' }
    return biliHistoryStore.clear()
  })
  // 删单条（2026-10-22 用户要求：底部「刷新 / 清空记录」整条去掉，改每条自带删除）。
  // ★ 只删本地账本这一条；B 站那边的观看/点赞记录不动。
  ipcMain.handle('orb:bili-history-delete', (_event, payload) => {
    if (!biliHistoryStore) return { ok: false, error: '浏览记录没接上' }
    const bvid = String(payload?.bvid || '')
    const cid = Number(payload?.cid || 0)
    if (!bvid) return { ok: false, error: '缺 bvid' }
    return biliHistoryStore.remove(bvid, cid)
  })

  // ── 「看过的视频」页面的动作（2026-10-21）──
  // 点赞/投币/收藏/发评论全是 B 站 OpenAPI 的 POST，用扫码那份 cookie + bili_jct 当 csrf。
  // ★ 不挂网页、不常驻渲染进程 —— 用户点了才发一次请求，发完就结束。
  // ★ 这些动作会真的改动用户账号（点赞进他的动态、评论是公开的），
  //   所以**只能由用户亲手点按钮触发**，代码里没有任何自动调用。
  // 抽屉里的三个按钮。实现已抽到 `runBiliAct`（和「她替他点」共用一份，见那里的注释）。
  ipcMain.handle('orb:bili-act', async (_event, payload) =>
    runBiliAct({
      bvid: payload?.bvid,
      cid: payload?.cid,
      action: payload?.action,
      count: payload?.count,
    }),
  )

  // 让她写「我为什么喜欢」+「想对作者说的话」。
  // 用一份关闭思考的独立 LLM 实例：这是两百字的短文案，开 max 思考要等半分钟，不值当。
  ipcMain.handle('orb:bili-compose', async (_event, payload) => {
    if (!biliHistoryStore) return { ok: false, error: '浏览记录没接上' }
    const bvid = String(payload?.bvid || '')
    const cid = Number(payload?.cid || 0)
    const item = biliHistoryStore.get(bvid, cid)
    if (!item) return { ok: false, error: '账本里没有这条视频' }
    if (!noteLlmRef) return { ok: false, error: '模型没接上，写不了' }
    try {
      const note = await composeLikeNote(item)
      const r = biliHistoryStore.updateNote(bvid, cid, note)
      return { ok: true, item: r.item, note }
    } catch (err) {
      return { ok: false, error: `写不出来：${String(err?.message || err)}` }
    }
  })

  ipcMain.handle('orb:bili-note-save', (_event, payload) => {
    if (!biliHistoryStore) return { ok: false, error: '浏览记录没接上' }
    const r = biliHistoryStore.updateNote(String(payload?.bvid || ''), Number(payload?.cid || 0), {
      reason: typeof payload?.reason === 'string' ? payload.reason : undefined,
      comment: typeof payload?.comment === 'string' ? payload.comment : undefined,
    })
    return r.ok ? { ok: true, item: r.item } : r
  })

  // 补写「概览」：老条目 / 只看了元信息的那条没有画面可用，
  // 只能依据标题和她自己写下的理由来写（prompt 里明确禁止编造画面细节）。
  ipcMain.handle('orb:bili-summary', async (_event, payload) => {
    if (!biliHistoryStore) return { ok: false, error: '浏览记录没接上' }
    const bvid = String(payload?.bvid || '')
    const cid = Number(payload?.cid || 0)
    const item = biliHistoryStore.get(bvid, cid)
    if (!item) return { ok: false, error: '账本里没有这条视频' }
    if (!noteLlmRef) return { ok: false, error: '模型没接上，写不了' }
    const force = payload?.force === true
    if (!force && String(item.summary || '').trim()) {
      return { ok: true, item, summary: item.summary }
    }
    try {
      const summary = await composeSummary(item)
      if (!summary) return { ok: false, error: '她没写出来' }
      const r = biliHistoryStore.setSummary(bvid, cid, summary)
      return { ok: true, item: r.item, summary }
    } catch (err) {
      return { ok: false, error: `写不出来：${String(err?.message || err)}` }
    }
  })

  // ★ 公开发言：评论会署用户的账号出现在视频评论区。只能由用户点「发送」触发。
  ipcMain.handle('orb:bili-comment-send', async (_event, payload) => {
    if (!biliHistoryStore || !biliActionsRef) return { ok: false, error: 'B 站通道没接上' }
    const bvid = String(payload?.bvid || '')
    const cid = Number(payload?.cid || 0)
    const text = String(payload?.text || '').trim()
    if (!text) return { ok: false, error: '内容是空的' }
    const item = biliHistoryStore.get(bvid, cid)
    if (!item) return { ok: false, error: '账本里没有这条视频' }
    let aid = Number(item.aid || 0)
    if (!aid) {
      try {
        const { fetchView } = await import('./bili-media.mjs')
        const v = await fetchView({ bvid, page: item.page || 1 })
        if (v.ok) aid = Number(v.aid || 0)
      } catch {
        /* 下面会报错 */
      }
    }
    const r = await biliActionsRef.comment({ aid, message: text })
    if (!r.ok) return r
    biliHistoryStore.updateNote(bvid, cid, { comment: text })
    biliHistoryStore.markSent(bvid, cid, text)
    return { ok: true, message: '发出去了' }
  })
  log('[settings] B 站通道已注册（status / login-* / history / act / compose / comment）')

  await import(pathToFileURL(HELPER_MAIN).href)
  log('helper 已加载，球窗口应已出现')

  // 自测：把球窗口的画面截下来存盘。
  // 沙箱里没有真实显示器，光靠日志只能证明「消息发出去了」，证明不了「UI 画出来了」。
  // ORB_SHOT = 第一次截图距启动的毫秒数；第二次固定在其后 45 秒（等模型把内容吐完）。
  const shotAt = Number(process.env.ORB_SHOT ?? '0')
  if (shotAt > 0) {
    const { BrowserWindow } = await import('electron')
    const grab = async (tag) => {
      const wins = BrowserWindow.getAllWindows()
      log(`截图(${tag})：窗口数 ${wins.length}`)
      // 球默认是收起态，得先点开才看得到对话流。
      // 渲染层只认 pointerdown + pointerup（位移 ≤4px 视为点击，会 toggle 成展开）。
      for (const w of wins) {
        try {
          const cls = await w.webContents.executeJavaScript(`(() => {
            const ball = document.querySelector('#ball')
            if (!ball) return 'no-ball'
            const base = { bubbles: true, cancelable: true, button: 0, buttons: 1,
                           pointerId: 1, pointerType: 'mouse', isPrimary: true,
                           clientX: 48, clientY: 48, screenX: 1964, screenY: 640 }
            try { ball.setPointerCapture = () => {} } catch (e) {}
            ball.dispatchEvent(new PointerEvent('pointerdown', base))
            ball.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }))
            return document.body.className
          })()`)
          if (cls !== 'no-ball') log(`展开(${tag}) body.class="${cls}"`)
        } catch {
          // 划词工具条等窗口里没有 #ball，忽略
        }
      }
      await new Promise((r) => setTimeout(r, 1500))
      // 光有截图不够 —— 必须证明截图那一刻 turn 真的是折叠态，
      // 否则 chat.css:171 那条隐藏规则根本没生效，截图说明不了任何问题。
      // 同时把每个 assistant 块的最终 display 值打出来，直接看正文有没有被藏。
      try {
        const diag = await wins[2].webContents.executeJavaScript(`(() => {
          const turns = [...document.querySelectorAll('.turn')]
          // 反向对照：把第 1 个 assistant 块的 data-response 摘掉，
          // 若 CSS 规则真的有鉴别力，它的 display 应该立刻变成 none。
          // 这是为了排除「规则根本没生效，截图说明不了问题」这种假阳性。
          let probe = null
          const first = turns[0]?.querySelector(':scope > .block[data-kind="assistant"]')
          if (first) {
            const was = first.getAttribute('data-response')
            first.removeAttribute('data-response')
            probe = { withResponse: null, withoutResponse: getComputedStyle(first).display }
            if (was !== null) first.setAttribute('data-response', was)
            probe.withResponse = getComputedStyle(first).display
          }
          return JSON.stringify({ probe, turns: turns.map((t) => ({
              open: t.hasAttribute('data-open'),
              assistants: [...t.querySelectorAll(':scope > .block[data-kind="assistant"]')].map((b) => ({
                response: b.getAttribute('data-response'),
                display: getComputedStyle(b).display,
                chars: (b.innerText || '').trim().length,
              })),
            })) })
        })()`)
        log(`折叠态诊断 ${diag}`)
      } catch (err) {
        log(`折叠态诊断失败: ${err.message}`)
      }
      for (let i = 0; i < wins.length; i += 1) {
        try {
          const img = await wins[i].webContents.capturePage()
          const file = join(LOGS, `shot-${tag}-${i}.png`)
          writeFileSync(file, img.toPNG())
          log(`截图已存 ${file} ${img.getSize().width}x${img.getSize().height}`)
        } catch (err) {
          log(`截图失败(${tag}-${i}): ${err.message}`)
        }
      }
    }
    setTimeout(() => void grab('early'), shotAt)
    // ORB_SHOT_TURNS = 等到第 N 轮的最终答案打上 response 标记后再截图。
    // 折叠态每个 turn 只显示带 data-response 的 assistant（chat.css:171），
    // 所以「第 2 轮收尾后的画面」必须卡在这个时刻，拍早了拍晚了都说明不了问题。
    const wantTurns = Number(process.env.ORB_SHOT_TURNS ?? '0')
    if (wantTurns > 0) {
      setTimeout(async () => {
        const deadline = Date.now() + 90_000
        const done = () =>
          [...blocks.values()].filter((b) => b.kind === 'assistant' && b.response === true).length >= wantTurns
        while (Date.now() < deadline && !done()) {
          await new Promise((r) => setTimeout(r, 500))
        }
        const n = [...blocks.values()].filter((b) => b.kind === 'assistant' && b.response === true).length
        log(done() ? `第 ${wantTurns} 轮已收尾，立刻截图` : `等第 ${wantTurns} 轮超时（只到 ${n} 轮），仍截一张`)
        await new Promise((r) => setTimeout(r, 1500))
        await grab('turns')
      }, shotAt)
    }
    // 过程节点只在回合进行中展开（回合一结束就折叠成「只留最终答案」），
    // 所以第二张必须卡在「工具块刚出现」那一刻，而不是固定等 45 秒。
    setTimeout(async () => {
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline && ![...blocks.values()].some((b) => b.kind === 'tool')) {
        await new Promise((r) => setTimeout(r, 1000))
      }
      const seen = [...blocks.values()].some((b) => b.kind === 'tool')
      log(seen ? '工具块已出现，立刻截图' : '等工具块超时，仍截一张')
      await new Promise((r) => setTimeout(r, 1500))
      await grab('live')
    }, shotAt)
  }

  // ORB_PROBE_WINDOW=1 —— 窗口层专项验证（沙箱无显示器时的唯一手段）。
  // 依次验证：resizable 在展开/收起间切换、程序改尺寸后 placement 是否跟着变、
  // move/clamp 会不会把尺寸重置、以及 window-state.json 有没有落盘。
  if (process.env.ORB_PROBE_WINDOW === '1') {
    setTimeout(() => void probeWindow(), 12_000)
  }

  // ORB_PROBE_SETTINGS=1 —— 「设置」抽屉端到端验证（沙箱无显示器时的唯一手段）。
  // 走的是和用户完全一样的链路：环菜单 → shell.js → preload → ipcMain → 磁盘。
  // 只动 contextBudgetTokens 一项，验完立刻还原，不碰密钥与微信配置。
  if (process.env.ORB_PROBE_SETTINGS === '1') {
    setTimeout(() => void probeSettings(), 12_000)
  }

  // ORB_PROBE_AB=1 —— A（历史会话切换）/ B（窗口内看图）端到端验证。
  // 要真发一条带图的消息（等模型回话），所以延后到 14 秒、单条回合超时由探针自己盯。
  if (process.env.ORB_PROBE_AB === '1') {
    setTimeout(() => void probeAb(), 14_000)
  }
  // ORB_PROBE_SWITCH=1 —— 频繁切换历史会话的压力探针（见 probeSwitch 注释）。
  if (process.env.ORB_PROBE_SWITCH === '1') {
    setTimeout(() => void probeSwitch(), 14_000)
  }

  // ★ local 引擎不需要旧后端服务端：起了也是白烧一个进程，
  // 而且会把 legacyReady 那条路径拉起来（R1 的根就在这里）。
  if (config.engine === 'local') {
    log('引擎=local，跳过旧后端启动')
    // 启动就把 brain 建起来，不等第一条消息。两个理由都是实测出来的：
    //   ① 闹钟心跳挂在「runtime 就绪」那一处，不预热的话，他半夜排的
    //      「早上七点叫我」要等他第二天先打一个字才会响 —— 那就不是闹钟了。
    //   ② 第一条消息原本要干等 8~40 秒（建 store + 读记忆仓 + 载 persona）。
    // 失败不算致命：只记一笔，第一条消息仍会照旧重试一遍完整流程。
    void ensureRuntime().catch((err) => {
      log(`[local] 启动预热失败（不影响收发，首条消息会重试）: ${err?.message || err}`)
    })
  } else {
    void startLegacy()
  }
}

/**
 * 窗口层专项探针。
 *
 * 为什么要这么写：窗口尺寸/resizable 都发生在 helper 进程内部，
 * 从这里（Host 进程）看不到。唯一的办法是通过 socket 让球页面
 * 调preload 暴露的 API 去驱动，再把结果读回来 —— 走的是和用户完全一样的链路。
 */
const STATE_FILE = join(ROOT, 'logs', 'window-state.json')

/** 读持久化的面板尺寸；读不到返回 null。 */
function readWindowStateSafe() {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    const p = state?.panel
    if (p && typeof p.width === 'number' && typeof p.height === 'number') return p
  } catch {}
  return null
}

async function probeWindow() {
  const { BrowserWindow } = await import('electron')
  const ball = BrowserWindow.getAllWindows().find((w) => {
    try {
      return w.webContents.getURL().includes('floating.html')
    } catch {
      return false
    }
  })
  if (!ball) {
    log('探针失败：没找到球窗口')
    return
  }
  const js = async (code) => {
    try {
      return await ball.webContents.executeJavaScript(code)
    } catch (err) {
      return { __error: err.message }
    }
  }
  const bounds = () => ball.getBounds()
  const results = []
  const check = (name, pass, detail) => {
    results.push({ name, pass, detail })
    log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` —— ${detail}` : ''}`)
  }

  // 1. 启动时的初始尺寸。
  // 沙箱里首启可能是 96×96（球态），也可能是被 clamp 过的最小面板 304×344
  // （取决于拿到的 workArea 多大）。两种都合法，只断言是合理值。
  //⚠️ 真正要验的是**展开时用没用上持久化的尺寸** —— 那是下面第2 条。
  const b0 = bounds()
  log(`初始 bounds = ${b0.width}×${b0.height}`)

  // 2. 展开 —— 关键：这里应该用持久化的面板尺寸，而不是 320×420 的默认值
  await js('window.dshOrb.setExpanded(true), true')
  await new Promise((r) => setTimeout(r, 1500))
  const b1 = bounds()
  log(`展开后 bounds = ${b1.width}×${b1.height}`)
  const saved = readWindowStateSafe()
  if (saved) {
    // 有存过尺寸 → 展开后必须等于「存的面板尺寸 + chrome」
    const wantW = saved.width + 24
    const wantH = saved.height + 24
    check(
      '展开时用上了持久化的尺寸（不是 320×420 默认值）',
      Math.abs(b1.width - wantW) < 8 && Math.abs(b1.height - wantH) < 8,
      `${b1.width}×${b1.height}（期望 ${wantW}×${wantH}）`,
    )
  } else {
    check('展开后大于球态', b1.width > 200 && b1.height > 200, `${b1.width}×${b1.height}（首次运行，无历史尺寸）`)
  }

  // 3. 模拟用户拖窗口边缘改大小。
  //⚠️ 沙箱里没有显示器，程序的 setBounds **不会** 触发 `resized` 事件
  //（该事件只在真实用户拖拽时触发）。所以这里测的是「窗口本身能不能变大」，
  // 而「尺寸有没有回写到 placement」由下面的 3b 用 helper 侧状态单独验证。
  const target = { w: 520, h: 640 }
  ball.setBounds({ x: b1.x, y: b1.y, width: target.w, height: target.h })
  await new Promise((r) => setTimeout(r, 1200))
  const b2 = bounds()
  log(`改尺寸后 bounds = ${b2.width}×${b2.height}`)
  check('窗口接受新尺寸', Math.abs(b2.width - target.w) < 60 && Math.abs(b2.height - target.h) < 60, `${b2.width}×${b2.height}`)

  // 3b. 走真实用户路径重设尺寸：调 orb:resize 让 helper 的 setPanelSize 真正执行。
  //真机上这一步由 `resized` 事件自动驱动（setBounds 不触发该事件），
  // 这里用显式通道在无显示器环境下验证同一条「回写 + 落盘」链路。
  const targetPanel = { w: 520 - 24, h: 640 - 24 }   // 减去四周透明 chrome
  const written = await js(`window.dshOrb.setPanelSize(${targetPanel.w}, ${targetPanel.h})`)
  await new Promise((r) => setTimeout(r, 1200))
  log(`orb:resize 返回 ${JSON.stringify(written)}`)
  check(
    'setPanelSize 生效并回写',
    written && written.width === targetPanel.w && written.height === targetPanel.h,
    JSON.stringify(written),
  )

  // 4. 收起再展开 → 尺寸必须是用户拖出来的值，而不是 320×420 的常量。
  // 这条是原设计最大的坑：setExpanded 每次都用常量重算 bounds，
  // 用户拖大之后一收一展开就弹回原尺寸。
  await js('window.dshOrb.setExpanded(false), true')
  await new Promise((r) => setTimeout(r, 1200))
  await js('window.dshOrb.setExpanded(true), true')
  await new Promise((r) => setTimeout(r, 1500))
  const b4 = bounds()
  log(`收起→展开 bounds = ${b4.width}×${b4.height}`)
  const expectW = targetPanel.w + 24
  const expectH = targetPanel.h + 24
  check(
    '收起→展开后仍是用户尺寸（没退回 320×420 常量）',
    Math.abs(b4.width - expectW) < 8 && Math.abs(b4.height - expectH) < 8,
    `${b4.width}×${b4.height}（期望 ${expectW}×${expectH}）`,
  )

  // 6. 持久化有没有落盘
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    log(`window-state.json = ${JSON.stringify(state)}`)
    check(
      '尺寸已落盘',
      state?.panel?.width > 200 && state?.panel?.height > 200,
      JSON.stringify(state),
    )
  } catch (err) {
    check('尺寸已落盘', false, `读不到 window-state.json：${err.message}`)
  }

  const failed = results.filter((r) => !r.pass)
  log(`窗口层探针：${results.length - failed.length}/${results.length} 通过`)
}

/**
 * 「设置」抽屉探针。
 *
 * 为什么要这么写：抽屉的读盘写盘全在宿主进程（`orb:api-config-get` / `-set`），
 * 渲染层只是表单。只测宿主函数会漏掉 preload 白名单、ipc 通道名、表单 id 三处
 * 最容易写错又最看不见的接缝 —— 所以这里从环菜单那一下开始，一路点到磁盘。
 */
async function probeSettings() {
  const { BrowserWindow } = await import('electron')
  const ball = BrowserWindow.getAllWindows().find((w) => {
    try {
      return w.webContents.getURL().includes('floating.html')
    } catch {
      return false
    }
  })
  if (!ball) {
    log('设置探针失败：没找到球窗口')
    return
  }
  const js = async (code) => {
    try {
      return await ball.webContents.executeJavaScript(code)
    } catch (err) {
      return { __error: err.message }
    }
  }
  const results = []
  const check = (name, pass, detail) => {
    results.push({ name, pass })
    log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` —— ${detail}` : ''}`)
  }
  const mask = (s) => (s ? `len=${s.length}` : '空')

  // 1. 宿主侧快照：不经过渲染层，先确认盘上读到的东西本身是对的。
  const host = await apiConfigSnapshot()
  check('快照读到 model', !!host.model, host.model)
  check('快照读到 baseUrl', !!host.baseUrl, host.baseUrl)
  check('快照读到密钥', (host.apiKey ?? '').length > 0, mask(host.apiKey))
  check('快照带微信段', !!host?.wechat?.file, JSON.stringify(host.wechat))

  // 2. 真点环菜单里的「设置」（主进程 → shell.js 的 onRingAction）。
  await js('window.dshOrb.setExpanded(true), true')
  await new Promise((r) => setTimeout(r, 1200))
  ball.webContents.send('orb:ring-action', 'api-config')
  await new Promise((r) => setTimeout(r, 2500))
  const readForm = () =>
    js(`(() => {
      const q = (s) => document.querySelector(s)
      const root = q('#api-config')
      const val = (s) => q(s)?.value ?? null
      return {
        open: root ? root.hidden !== true && getComputedStyle(root).display !== 'none' : null,
        title: q('#api-config-title')?.textContent?.trim() ?? null,
        provider: val('#api-provider'),
        model: val('#api-model'),
        baseUrl: val('#api-base-url'),
        keyLen: (val('#api-key') ?? '').length,
        keyType: q('#api-key')?.type ?? null,
        limit: val('#api-context-limit'),
        effort: val('#api-effort'),
        effortOptions: Array.from(document.querySelectorAll('#api-effort option')).map((o) => o.value),
        wechatEnabled: val('#api-wechat-enabled'),
        wechatTokenLen: (val('#api-wechat-token') ?? '').length,
        wechatBaseUrl: val('#api-wechat-base-url'),
        paths: q('#api-paths-value')?.textContent?.trim() ?? null,
        status: q('#api-config-status')?.textContent?.trim() ?? null,
        note: q('#api-config-note')?.textContent?.trim() ?? null,
      }
    })()`)
  const form = await readForm()
  log(`[设置探针] 面板状态 = ${JSON.stringify(form)}`)
  check('抽屉已打开', form?.open === true, String(form?.open))
  check('标题是「设置」', form?.title === '设置', form?.title)
  check('模型回填', form?.model === host.model, form?.model)
  check('接口地址回填', form?.baseUrl === host.baseUrl, form?.baseUrl)
  check('密钥回填', form?.keyLen === (host.apiKey ?? '').length, `input=${form?.keyLen} vs ${mask(host.apiKey)}`)
  check('密钥默认是 password 型', form?.keyType === 'password', form?.keyType)
  check('微信段回填', !!form?.wechatEnabled && (form?.wechatTokenLen ?? 0) > 0, `enabled=${form?.wechatEnabled} tokenLen=${form?.wechatTokenLen}`)
  // 推理等级：没显式配置时必须回落到出厂 max（与 src/settings.mjs 的缺省一致），
  // 否则下拉会是空白项 —— 用户看到「推理等级」后面一个空格子，比看不见更糟。
  check(
    '推理等级下拉回填（无配置时 = max）',
    !!form?.effort && form.effort === (host.reasoningEffort || 'max'),
    `select=${form?.effort} 快照=${JSON.stringify(host.reasoningEffort)}`,
  )
  check(
    '推理等级 8 个档位齐全',
    (form?.effortOptions ?? []).join(',') === 'off,minimal,low,medium,high,xhigh,ultra,max',
    String(form?.effortOptions),
  )
  check('路径行有内容', (form?.paths ?? '').length > 0, form?.paths)

  try {
    const img = await ball.webContents.capturePage()
    const file = join(LOGS, 'probe-settings.png')
    writeFileSync(file, img.toPNG())
    log(`设置抽屉截图已存 ${file} ${img.getSize().width}x${img.getSize().height}`)
  } catch (err) {
    log(`截图失败: ${err.message}`)
  }

  // 3. 真点「保存」：只改压缩阈值，验完改回去（密钥留空 = 不动，微信段不动）。
  const readConfig = () => JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''))
  const original = readConfig().contextBudgetTokens ?? null
  const probeValue = Number(original ?? 24000) === 26000 ? 28000 : 26000
  await js(`(() => { document.querySelector('#api-context-limit').value = '${probeValue}'; document.querySelector('#api-config-save').click(); return true })()`)
  await new Promise((r) => setTimeout(r, 2500))
  const after = readConfig()
  const afterForm = await readForm()
  check('保存写进了 config.json', after.contextBudgetTokens === probeValue, `contextBudgetTokens=${after.contextBudgetTokens}（期望 ${probeValue}）`)
  check('保存后有状态提示', (afterForm?.status ?? '').length > 0, afterForm?.status)

  await js(`(() => { document.querySelector('#api-context-limit').value = '${original ?? ''}'; document.querySelector('#api-config-save').click(); return true })()`)
  await new Promise((r) => setTimeout(r, 2500))
  const restored = readConfig()
  check(
    '改回原值（不留探针痕迹）',
    (restored.contextBudgetTokens ?? null) === original,
    `contextBudgetTokens=${JSON.stringify(restored.contextBudgetTokens ?? null)}（原 ${JSON.stringify(original)}）`,
  )

  // 3b. 推理等级：切一档 → 保存 → 验盘上、验 settings 真的读到；再把原值还原。
  const originalEffort = readConfig().reasoningEffort ?? null
  const probeEffort = originalEffort === 'high' ? 'low' : 'high'
  await js(`(() => { document.querySelector('#api-effort').value = '${probeEffort}'; document.querySelector('#api-config-save').click(); return true })()`)
  await new Promise((r) => setTimeout(r, 2500))
  check(
    '推理等级写进了 config.json',
    readConfig().reasoningEffort === probeEffort,
    `reasoningEffort=${JSON.stringify(readConfig().reasoningEffort)}（期望 ${probeEffort}）`,
  )
  // settings 每轮按 mtime 重读 ⇒ 这一条验的是「存完下一轮真的生效」，不只是文件写了。
  // 注意：`settings` 是 ensureRuntime 里的局部变量，探针碰不到，这里另起一个实例读同一个文件
  //（createSettings 的读法是 mtime 缓存 + 每次 get() 重读，语义与运行期一致）。
  const { createSettings } = await import('./settings.mjs')
  const probeSettings = createSettings({ configPath: CONFIG_PATH, log })
  check(
    'settings 读到了新档位（下一轮生效）',
    probeSettings.get().reasoningEffort === probeEffort,
    probeSettings.get().reasoningEffort,
  )
  const illegal = await applyApiConfig({ reasoningEffort: 'turbo' })
  check(
    '非法档位被拒并说清原因',
    /不合法/.test(illegal?.data?.error ?? illegal?.note ?? ''),
    String(illegal?.data?.error ?? illegal?.note ?? ''),
  )
  const restoreEffort = await applyApiConfig({ reasoningEffort: originalEffort })
  check(
    '推理等级已还原（不留探针痕迹）',
    (readConfig().reasoningEffort ?? null) === originalEffort,
    `reasoningEffort=${JSON.stringify(readConfig().reasoningEffort ?? null)}（原 ${JSON.stringify(originalEffort)}）${restoreEffort?.note ?? ''}`,
  )

  await js(`document.querySelector('#api-config-close')?.click(), true`)
  const failed = results.filter((r) => !r.pass)
  log(`设置抽屉探针：${results.length - failed.length}/${results.length} 通过`)
}

/**
 * ORB_PROBE_AB=1 —— A（历史会话切换）/ B（窗口内看图）端到端验证。
 *
 * 为什么非要走真 UI：这两件事的失败点都不在宿主函数里。
 *   A：openConversation 的 local 分支曾写死「只认 `local-<agentId>`」，别的 id 一律
 *      return —— 磁盘上有会话、历史列表里也看得见，点下去就是不动
 *      （用户报的「历史对话点了打不开」）。只测 openConversation 内部看不出这条。
 *   B：图要从「拖进 #composer」→ 压缩 → base64 → preload 白名单 → ipc → brain → HTTP
 *      整条链走通。任何一环丢字段，表现都是「球说没看到图」而不是报错，所以必须真发一条。
 *
 * 副作用控制：B 在**一次性新会话**里做（跑完用 deleteConversation 删掉），
 * 不往用户的真实对话里留探针消息；A 只切不动内容。
 */
async function probeAb() {
  const { BrowserWindow } = await import('electron')
  const ball = BrowserWindow.getAllWindows().find((w) => {
    try {
      return w.webContents.getURL().includes('floating.html')
    } catch {
      return false
    }
  })
  if (!ball) {
    log('AB 探针失败：没找到球窗口')
    return
  }
  const js = async (code) => {
    try {
      return await ball.webContents.executeJavaScript(code)
    } catch (err) {
      log(`[AB] executeJavaScript 出错: ${err.message}`)
      return { __error: err.message }
    }
  }
  const results = []
  const check = (name, pass, detail) => {
    results.push({ name, pass })
    log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` —— ${detail}` : ''}`)
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (fn, ms = 20000, step = 250) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await fn()) return true
      await sleep(step)
    }
    return false
  }
  const rows = () => js(`document.querySelectorAll('#transcript > *').length`)
  const blockCount = (sid) => {
    try {
      const r = readConversationBlocks(sid)
      return r?.blocks?.length ?? 0
    } catch {
      return 0
    }
  }
  const convDir = (sid) =>
    join(settingsDataRoot(), 'conversations', Buffer.from(`conversation:${sid}`, 'utf8').toString('base64').replace(/=+$/, ''))
  const readMessages = (sid) => {
    try {
      return readFileSync(join(convDir(sid), 'messages.jsonl'), 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)?.message ?? null
          } catch {
            return null
          }
        })
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    } catch {
      return []
    }
  }
  const textOf = (m) => {
    const c = m?.content
    if (typeof c === 'string') return c
    if (!Array.isArray(c)) return ''
    return c.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('\n')
  }

  // ── 0. 等 local 会话就绪 ─────────────────────────────────────────────
  const ready = await waitFor(() => currentLocalSession() !== '', 30000)
  check('[A] local 会话已就绪', ready, currentLocalSession())
  if (!ready) {
    log('AB 探针中止：local 会话没起来')
    return
  }
  const S0 = currentLocalSession()
  const list = listConversations()
  check('[A] 历史列表非空', list.length > 0, `${list.length} 条：${list.slice(0, 6).map((c) => c.sessionId).join(' | ')}`)
  const target = list.find((c) => c.sessionId !== S0)
  check('[A] 存在可切换的其它会话', !!target, target?.sessionId ?? '（只有当前会话）')

  // ── A. 真点历史：openSession → ipc 'orb:open' → openConversation(local 分支) ──
  const s0Rows = await rows()
  const s0Blocks = blockCount(S0)
  check('[A] 当前会话在球上有内容', (s0Rows ?? 0) > 0, `#transcript 子节点=${s0Rows}，磁盘块=${s0Blocks}`)

  if (target) {
    await js(`window.dshOrb.openSession(${JSON.stringify(target.sessionId)}), true`)
    const landed = await waitFor(() => currentLocalSession() === target.sessionId, 15000)
    check('[A] 切过去：runtime.conversation_id 换成目标', landed, `当前=${currentLocalSession()} 目标=${target.sessionId}`)
    const expectTarget = blockCount(target.sessionId)
    const targetRows = await waitFor(async () => ((await rows()) ?? 0) > 0, 10000)
    const gotRows = await rows()
    check('[A] 切过去后重放了目标会话的内容', targetRows, `#transcript 子节点=${gotRows}，磁盘块=${expectTarget}`)
    check('[A] 重放的不是当前会话（内容确实换了）', gotRows !== s0Rows || expectTarget === s0Blocks, `${s0Rows} → ${gotRows}`)
  }

  await js(`window.dshOrb.openSession(${JSON.stringify(S0)}), true`)
  const back = await waitFor(() => currentLocalSession() === S0, 15000)
  check('[A] 切回原会话', back, currentLocalSession())
  const backRows = await rows()
  check('[A] 切回后内容恢复', (backRows ?? 0) > 0, `#transcript 子节点=${backRows}（切走前 ${s0Rows}）`)

  // ── B. 一次性新会话里拖一张纯红图，看模型是否真看见 ──────────────────
  await js('window.dshOrb.newSession(), true')
  const madeNew = await waitFor(() => currentLocalSession() !== S0, 15000)
  const newId = currentLocalSession()
  check('[B] 新开会话成功', madeNew && newId !== S0, newId)
  if (!madeNew || newId === S0) {
    log('AB 探针：新会话没建起来，B 段跳过')
  } else {
    // 图的内容必须「猜不出来」：纯色图模型答错一次就分不清「没看见」还是「答歪了」
    // （第一版用纯红图，两次跑出「红色。」与「粉色」两种答案）。改成在页内 canvas 上
    // 画两个数字，答案 42 不可能靠文本猜中 —— 答对就等于图真的到了模型那儿。
    const drew = await js(`(async () => {
      const c = document.createElement('canvas')
      c.width = 240
      c.height = 120
      const g = c.getContext('2d')
      g.fillStyle = '#ffffff'
      g.fillRect(0, 0, 240, 120)
      g.fillStyle = '#000000'
      g.font = 'bold 84px sans-serif'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText('42', 120, 64)
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
      const file = new File([blob], 'probe-42.png', { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const form = document.querySelector('#composer')
      form.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
      return blob.size
    })()`)
    log(`[AB] 已造好数字图并投进附件条（${drew} 字节）`)
    // 压缩是异步的（canvas 重编码），附件条出现才算收下
    const attached = await waitFor(async () => {
      const n = await js(`document.querySelector('#attach-strip')?.children.length ?? -1`)
      return typeof n === 'number' && n > 0
    }, 12000)
    const attachCount = await js(`document.querySelector('#attach-strip')?.children.length ?? -1`)
    check('[B] 图片被附件条收下', attached, `#attach-strip 子节点=${attachCount}`)

    await js(`(() => {
      const p = document.querySelector('#prompt')
      p.textContent = '图里写的是什么数字？只回答数字本身，不要解释。'
      p.dispatchEvent(new Event('input', { bubbles: true }))
      const form = document.querySelector('#composer')
      if (typeof form.requestSubmit === 'function') form.requestSubmit()
      else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      return true
    })()`)

    // 等这一轮落盘（user + assistant 两条）
    const replied = await waitFor(() => {
      const msgs = readMessages(newId)
      return msgs.some((m) => m.role === 'assistant' && textOf(m).trim() !== '')
    }, 180000, 1000)
    const msgs = readMessages(newId)
    const userMsg = msgs.find((m) => m.role === 'user')
    const assistantMsg = [...msgs].reverse().find((m) => m.role === 'assistant')
    const userHasImage = JSON.stringify(userMsg?.content ?? '').includes('"type":"image"')
    check('[B] 用户消息落盘带图片片段', userHasImage, `parts=${Array.isArray(userMsg?.content) ? userMsg.content.map((p) => p?.type).join(',') : typeof userMsg?.content}`)
    check('[B] 这一轮拿到了回复', replied, textOf(assistantMsg).slice(0, 80))
    const seesImage = /42|四二/.test(textOf(assistantMsg))
    const usageNote = assistantMsg?.usage
      ? `prompt=${assistantMsg.usage.prompt_tokens ?? assistantMsg.usage.promptTokens ?? '?'} completion=${assistantMsg.usage.completion_tokens ?? assistantMsg.usage.completionTokens ?? '?'}`
      : 'usage 缺失'
    check('[B] 模型真看见图（答出了图里写的 42）', seesImage, `${textOf(assistantMsg).slice(0, 120)}（${usageNote}）`)

    // B-2. 切走再切回：历史里应当恢复成「图片 ×N」占位（imageCount 字段）
    await js(`window.dshOrb.openSession(${JSON.stringify(S0)}), true`)
    await waitFor(() => currentLocalSession() === S0, 15000)
    await js(`window.dshOrb.openSession(${JSON.stringify(newId)}), true`)
    const backNew = await waitFor(() => currentLocalSession() === newId, 15000)
    check('[B] 带图会话能再切回去', backNew, currentLocalSession())
    const imgBlocks = (readConversationBlocks(newId)?.blocks ?? []).filter((b) => (b.imageCount ?? 0) > 0)
    check('[B] 历史块带 imageCount（气泡显示「图片 ×N」）', imgBlocks.length > 0, `带图块=${imgBlocks.length}`)
    const hasPlaceholder = await js(`document.querySelector('#transcript')?.textContent?.includes('图片') ?? false`)
    check('[B] 重放后气泡里出现「图片」占位', hasPlaceholder === true, String(hasPlaceholder))

    // 收尾：回到真会话，删掉探针会话（不在用户历史里留垃圾）
    await js(`window.dshOrb.openSession(${JSON.stringify(S0)}), true`)
    await waitFor(() => currentLocalSession() === S0, 15000)
    const existed = existsSync(convDir(newId))
    deleteConversation(newId)
    check('[B] 探针会话已删除', existed && !existsSync(convDir(newId)), convDir(newId))
  }

  const failed = results.filter((r) => !r.pass)
  log(`AB 探针：${results.length - failed.length}/${results.length} 通过${failed.length ? `；失败项：${failed.map((r) => r.name).join('、')}` : ''}`)
}

/**
 * ORB_PROBE_SWITCH=1 —— 频繁切换历史会话的压力探针。
 *
 * 用户实测：快速连点历史列表后，某条对话「加载不出历史」。可能的失败点有三类，
 * 必须分别抓：
 *   ① 宿主：openConversation 里两个 id 交错 —— blockScope / runtime.conversation_id
 *      被后一次的 await 盖掉，重放写进了错的 key 前缀（块在，但属于上一条会话）。
 *   ② 渲染：clearTranscript() 与随后的 block 在同一帧批处理里，任何一步抛异常
 *      都会把该帧剩下的块整批丢掉（staged 已经 splice 掉，找不回来）。
 *   ③ 在途回合：切走时把 turnInFlight 置 false，但流还在推 —— 迟到的 delta 会
 *      落到新会话的 blockScope 上，变成「幽灵块」，把真实历史挤掉位置。
 * 所以每条断言都同时看「宿主 order/blocks」与「DOM 子节点」和「磁盘块数」三份数。
 *
 * 副作用控制：只在一次性新会话里发一条消息（跑完删掉），其余只切不动内容。
 */
async function probeSwitch() {
  const { BrowserWindow } = await import('electron')
  const ball = BrowserWindow.getAllWindows().find((w) => {
    try {
      return w.webContents.getURL().includes('floating.html')
    } catch {
      return false
    }
  })
  if (!ball) {
    log('[switch] 失败：没找到球窗口')
    return
  }
  const js = async (code) => {
    try {
      return await ball.webContents.executeJavaScript(code)
    } catch (err) {
      log(`[switch] executeJavaScript 出错: ${err.message}`)
      return { __error: err.message }
    }
  }
  const check = (name, pass, detail) => {
    log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` —— ${detail}` : ''}`)
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (fn, ms = 20000, step = 200) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await fn()) return true
      await sleep(step)
    }
    return false
  }
  const rows = () => js(`document.querySelectorAll('#transcript > *').length`)
  const blockCount = (sid) => {
    try {
      const r = readConversationBlocks(sid)
      return r === null ? -1 : (r.blocks?.length ?? 0)
    } catch (err) {
      log(`[switch] readConversationBlocks(${sid}) 抛错: ${err.message}`)
      return -2
    }
  }
  const hostState = () => `order=${order.length} blocks=${blocks.size} scope=${blockScope}`

  // 渲染层异常收集：任何未捕获异常/未处理 rejection 都要在结果里看见 ——
  // 帧批处理里抛一次，整帧剩下的块就永久丢了，日志里却只有一行 stderr。
  await js(`(() => {
    window.__swErrs = []
    addEventListener('error', (e) => window.__swErrs.push('error: ' + (e.message || '')))
    addEventListener('unhandledrejection', (e) => window.__swErrs.push('rejection: ' + ((e.reason && (e.reason.message || e.reason)) || '?')))
    return true
  })()`)
  const pageErrs = () => js('JSON.stringify(window.__swErrs || [])')
  ball.webContents.on('console-message', (...args) => {
    const ev = args[0]
    const level = typeof args[1] === 'number' ? args[1] : (ev && ev.level)
    const message = typeof args[2] === 'string' ? args[2] : (ev && ev.message) || ''
    if (level === 'error' || level === 3 || level === 2) log(`[switch][renderer] ${String(message).slice(0, 300)}`)
  })

  const ready = await waitFor(() => currentLocalSession() !== '', 30000)
  check('[switch] local 会话已就绪', ready, currentLocalSession())
  if (!ready) return
  const S0 = currentLocalSession()
  const sessions = listConversations().map((c) => c.sessionId)
  check('[switch] 历史会话 ≥ 2', sessions.length >= 2, `${sessions.length} 条：${sessions.join(' | ')}`)
  if (sessions.length < 2) return
  log(`[switch] 起始：当前=${S0} ${hostState()}`)
  check('[switch] 起始会话 DOM 与磁盘一致', (await rows()) === blockCount(S0), `DOM=${await rows()} 磁盘=${blockCount(S0)} ${hostState()}`)

  // ── S1. 连点：24 次、无间隔与 40ms 混合，落点固定为 sessions[N] ──
  const order1 = []
  for (let i = 0; i < 24; i += 1) {
    const id = sessions[(i * 5 + 1) % sessions.length]
    order1.push(id)
    await js(`window.dshOrb.openSession(${JSON.stringify(id)}), true`)
    if (i % 2 === 1) await sleep(40)
  }
  const last = order1[order1.length - 1]
  await waitFor(() => currentLocalSession() === last, 10000)
  await sleep(900)
  const s1Rows = await rows()
  const s1Disk = blockCount(last)
  check('[S1] 连点后落在最后一次点击的会话', currentLocalSession() === last, `当前=${currentLocalSession()} 期望=${last}`)
  check('[S1] 连点后 DOM 与磁盘一致', s1Rows === s1Disk, `DOM=${s1Rows} 磁盘=${s1Disk} ${hostState()}`)
  check('[S1] 宿主 order 与 DOM 对齐', order.length === s1Rows, `order=${order.length} DOM=${s1Rows}`)
  check('[S1] 连点期间渲染层无未捕获异常', (await pageErrs()) === '[]', await pageErrs())

  // ── S2. 逐条核对：每一条都必须能把 DOM 填成磁盘那么多（跑两轮） ──
  for (let round = 1; round <= 2; round += 1) {
    for (const id of sessions) {
      await js(`window.dshOrb.openSession(${JSON.stringify(id)}), true`)
      const landed = await waitFor(() => currentLocalSession() === id, 10000)
      await sleep(700)
      const dom = await rows()
      const disk = blockCount(id)
      check(`[S2-${round}] ${id} 加载完整`, landed && dom === disk, `DOM=${dom} 磁盘=${disk} ${hostState()}`)
    }
  }
  check('[S2] 渲染层无未捕获异常', (await pageErrs()) === '[]', await pageErrs())

  // ── S3. 在途回合 + 连点：迟到的流不该污染新会话，也不该吞掉原会话的回复 ──
  const preNew = currentLocalSession()
  await js('window.dshOrb.newSession(), true')
  // ★ 判据必须是「落到一条列表里没有的新会话」：S1/S2 跑完当前会话早就不是 S0 了，
  //   只比 S0 会让 waitFor 立刻命中，之后所有断言都挂在一个陈旧 id 上（上一版 S3 就红在这）。
  const madeNew = await waitFor(() => {
    const c = currentLocalSession()
    return c !== '' && c !== preNew && !sessions.includes(c)
  }, 15000)
  const tmpId = currentLocalSession()
  check('[S3] 一次性会话建起来', madeNew, tmpId)
  if (madeNew) {
    const before = blockCount(tmpId)
    await js(`(() => {
      const p = document.querySelector('#prompt')
      p.textContent = '（探针）只用一句话回答：你现在醒着吗？'
      p.dispatchEvent(new Event('input', { bubbles: true }))
      const f = document.querySelector('#composer')
      if (f && f.requestSubmit) f.requestSubmit()
      return true
    })()`)
    await sleep(900)                                  // 让它真开始跑（第一段流已经出来）
    // 回合还在跑的时候切走：这一步以前会把增量漏进「别的会话」的 blockScope
    const other = S0
    await js(`window.dshOrb.openSession(${JSON.stringify(other)}), true`)
    const otherOk = await waitFor(() => currentLocalSession() === other, 10000)
    await sleep(1100)                                 // 留足窗口，让迟到的增量有机会漏过来
    const domOther = await rows()
    const diskOther = blockCount(other)
    check('[S3] 途中切走：落在别的会话', otherOk, currentLocalSession())
    // 真 bug 的判据：在途回合的增量不得以「当前会话」为前缀插进来
    check('[S3] 别的会话没被在途回合污染（DOM 与磁盘一致）', domOther === diskOther, `DOM=${domOther} 磁盘=${diskOther} ${hostState()}`)
    await js(`window.dshOrb.openSession(${JSON.stringify(tmpId)}), true`)
    const backOk = await waitFor(() => currentLocalSession() === tmpId, 10000)
    await sleep(900)
    const domMid = await rows()
    const diskMid = blockCount(tmpId)
    check('[S3] 切回临时会话', backOk, currentLocalSession())
    // 切回后增量会继续往这条会话里推（同一会话，正确行为），允许比磁盘多出「正在写的这一条」
    check('[S3] 切回后 DOM 至多多出在途的一条', domMid <= diskMid + 1, `DOM=${domMid} 磁盘=${diskMid}（起点磁盘=${before}） ${hostState()}`)
    // 等回复落盘（上限 180 秒），再核一次。
    // ★ 判据是「一条完整的问答已经落盘」（user + assistant ≥ 2 块），不是「比刚才更多」——
    //   模型 1 秒内就答完时，切回来那一刻磁盘里已经有终稿，再等「更多」会白等到超时。
    const replied = await waitFor(() => blockCount(tmpId) >= 2, 180000, 1000)
    await sleep(600)
    // 磁盘侧正文从 block 里取（main.mjs 没有 readMessages，那是 session.mjs 的接口）
    const diskBlocks = readConversationBlocks(tmpId)
    const lastBlock = diskBlocks && Array.isArray(diskBlocks.blocks) && diskBlocks.blocks.length > 0
      ? diskBlocks.blocks[diskBlocks.blocks.length - 1]
      : null
    const lastText = lastBlock ? String(lastBlock.text ?? '') : ''
    const domEnd = await rows()
    const diskEnd = blockCount(tmpId)
    check('[S3] 回合在后台继续并落盘', replied && lastText.trim() !== '', `磁盘块 ${diskMid} → ${diskEnd}，末条="${lastText.slice(0, 24)}"`)
    check('[S3] 回合结束后 DOM 与磁盘一致', domEnd === diskEnd, `DOM=${domEnd} 磁盘=${diskEnd} ${hostState()}`)
    check('[S3] 渲染层无未捕获异常（在途切会话）', (await pageErrs()) === '[]', await pageErrs())
    // 清理：切回原会话再删临时会话
    await js(`window.dshOrb.openSession(${JSON.stringify(S0)}), true`)
    await waitFor(() => currentLocalSession() === S0, 10000)
    deleteConversation(tmpId)
    check('[S3] 一次性会话已删除', !existsSync(join(settingsDataRoot(), 'conversations', Buffer.from(`conversation:${tmpId}`, 'utf8').toString('base64').replace(/=+$/, ''))), tmpId)
  }

  // S4：内部辅助会话（#wechat 微信桥落盘 / #impression 印象整理）现在**保留在抽屉里**，
  //     但每条必须带 kind 徒标（微信 / 内部）。
  //     历史教训：上一版直接把它们过滤掉，代价是用户在微信里下派的工作（十几条真实对话）
  //     在抽屉里凭空消失。过滤 ≠ 正确，标注才是。
  try {
    sendHistory()
    await new Promise((r) => setTimeout(r, 400))
    const drawer = await js(`Array.from(document.querySelectorAll('#history-list > *')).map((n) => ({
      id: n.dataset.sessionId || '',
      badge: n.querySelector('.history-kind')?.textContent || '',
      text: String(n.textContent || ''),
    }))`)
    const rowsArr = Array.isArray(drawer) ? drawer : []
    const ids = rowsArr.map((r) => String(r.id)).filter((s) => s !== '')
    const auxRows = rowsArr.filter((r) => isAuxSessionId(String(r.id)))
    const auxBadged = auxRows.filter((r) => r.badge === '微信' || r.badge === '内部')
    check('[S4] 辅助会话保留在抽屉里且带 kind 徒标', auxRows.length === auxBadged.length && auxRows.length > 0,
      `辅助=${auxRows.length} 带标=${auxBadged.length} ${JSON.stringify(auxRows.map((r) => `${r.badge}:${r.id}`))}`)
    const mainRows = rowsArr.filter((r) => !isAuxSessionId(String(r.id)))
    check('[S4] 主会话没有 kind 徒标', mainRows.every((r) => r.badge === ''), `主会话行=${mainRows.length}`)
    const expect = listConversations(resolveAgentId()).length
    check('[S4] 抽屉条数 = 全部真实会话数（含辅助）', ids.length === expect, `DOM=${ids.length} 期望=${expect}`)
  } catch (err) {
    check('[S4] 抽屉检查', false, err.message)
  }
  log(`[switch] 结束：当前=${currentLocalSession()} ${hostState()}`)
}

app.on('window-all-closed', () => app.quit())
void boot().catch((err) => {
  log(`启动失败: ${err?.stack ?? err}`)
  app.quit()
})
