// 「切模式」在 local 引擎下的 GUI 端到端验收（沙箱数据根 + 一次性 agentId）。
//
// P5（2026-10-19 用户裁定）之后，切模式的语义**整体改了**，这个探针跟着改：
//   旧语义：chat / work 各有一个 Letta agent、各有一份 memfs 记忆仓 —— 于是「工作态说的事，
//           闲聊态完全不知道」，用户原话是「那不是陪伴，是两个陌生人」。
//   新语义：**只有一个 agent、只有一条长会话**；切模式 = 换 persona + 重建 brain，
//           记忆与历史对话全部共享；`config.json` 里 `agents:{chat,work}` 收拢成单个 `agentId`。
//
// 因此这里验四件事（也是 P5 唯一的验收面）：
//   ① 老配置（有 agents、没有 agentId）启动时被归一，且**不是**新造一个 id；
//   ② 切模式前后 agentId / sessionId 都不变（= 记忆必然共享），也不会新建 memfs 目录；
//   ③ 人格真的换了 —— 靠 system.json 里的 personaHash 与日志指纹双向比对；
//      ★ 这里踩过一个真 bug：旧快照按 guideVersion 判重用，人格换了也照样复用 ⇒
//        「切了模式、说话方式没变」。修法是快照记 personaHash（src/snapshot.mjs）。
//   ④ 两个模式的消息落在同一份 messages.jsonl 里（历史共享的硬证据）。
//
// ⚠️ 为什么必须真起 Electron：切模式的价值全在 `ensureRuntime()` 里（读 persona、建
//    memstore、建 brain），单测造不出那个对象。
//
// ⚠️ 本探针**会临时改 config.json**，跑完（含异常）由 `restoreConfig()` 拷回备份；
//    备份在 `bak/config.mode-<stamp>.json`。
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPersona } from '../src/persona.mjs'
import { hashPersona } from '../src/snapshot.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LOG = join(ROOT, 'logs', 'orb.log')
const CFG = join(ROOT, 'config.json')
const PORT = 25975
const DATA = join(ROOT, '_sandbox-data-mode')

const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const AGENT = `orb-mode-test-${STAMP}`
// 老配置里那份「工作态 agent」：P5 之后**不该**再被读、也不该被新建。
const LEGACY_WORK_AGENT = 'orb-work'
const BAK = join(ROOT, 'bak', `config.mode-${STAMP}.json`)

const MEMFS = join(DATA, 'memfs')
const WORK_REPO = join(MEMFS, LEGACY_WORK_AGENT, 'memory')

// persona 指纹：探针自己算一遍，跟日志/system.json 里的一一比对 —— 这是「人设真的换了」的唯一硬证据。
const chatPersona = readPersona('chat')
const workPersona = readPersona('work')
const sha12 = (p) => p.sha256.slice(0, 12)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` —— ${detail}` : ''}`)
}

// ---------------------------------------------------------------- 配置与现场
let restored = false
function restoreConfig() {
  if (restored) return
  restored = true
  try { copyFileSync(BAK, CFG) } catch { /* 备份没了也没别的办法 */ }
}

mkdirSync(dirname(BAK), { recursive: true })
copyFileSync(CFG, BAK)
const origCfg = JSON.parse(readFileSync(CFG, 'utf8'))

// ★ 故意写成「老配置」：有 `agents.chat/work`、**没有**顶层 `agentId`。
//   真实用户从双模式版本升级上来就是这个形状 —— 归一化那条路不亲测等于没测。
const seed = { ...origCfg, engine: 'local', agents: { chat: AGENT, work: LEGACY_WORK_AGENT }, mode: 'chat' }
delete seed.agentId
writeFileSync(CFG, `${JSON.stringify(seed, null, 2)}\n`, 'utf8')

rmSync(DATA, { recursive: true, force: true })
console.log(`沙箱 agent=${AGENT}（来自老配置 agents.chat）数据根=${DATA}（已清空）`)
console.log(`persona 指纹 chat=${sha12(chatPersona)} work=${sha12(workPersona)}`)

const originalLog = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
const env = {
  ...process.env,
  ORB_DATA: DATA,
  ORB_SOCKET_PORT: String(PORT),
  ORB_TRACE: '1',
  ORB_ELECTRON_FLAGS: '--no-sandbox --disable-gpu',
}

const orb = spawn(process.execPath, [join(ROOT, 'src', 'launch.mjs')], {
  cwd: ROOT, env, stdio: 'ignore', windowsHide: true,
})
let cleaned = false
const cleanup = () => {
  if (cleaned) return
  cleaned = true
  try { orb.kill() } catch { /* 已退出 */ }
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(orb.pid)], { stdio: 'ignore' }) } catch { /* 进程树没了 */ }
}
process.on('exit', () => { cleanup(); restoreConfig() })

const readLog = () => { try { return readFileSync(LOG, 'utf8') } catch { return '' } }
const tailLog = () => readLog().slice(originalLog.length)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 会话目录名算法与 src/session.mjs:28 保持一致（base64 无 padding）。
const sessionDirOf = (sessionId) =>
  join(DATA, 'conversations', Buffer.from(`conversation:${sessionId}`, 'utf8').toString('base64').replace(/=+$/, ''))
const readSystemJson = (sessionId) => {
  try { return JSON.parse(readFileSync(join(sessionDirOf(sessionId), 'system.json'), 'utf8')) } catch { return null }
}
const readMessages = (sessionId) => {
  try {
    return readFileSync(join(sessionDirOf(sessionId), 'messages.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch { return [] }
}

// ---------------------------------------------------------------- 等 socket
let sockInfo = null
{
  const end = Date.now() + 120_000
  while (Date.now() < end && !sockInfo) {
    await sleep(1000)
    const tail = tailLog()
    const m = /球的控制 socket 监听 127\.0\.0\.1:(\d+)/.exec(tail)
    const t = /socket token=(\S+)/.exec(tail)
    if (m && t && Number(m[1]) === PORT) sockInfo = { port: Number(m[1]), token: t[1] }
  }
}
if (!sockInfo) {
  console.log('FAIL 没等到 socket 信息')
  console.log(tailLog().split('\n').slice(-20).join('\n'))
  cleanup(); restoreConfig()
  process.exit(1)
}
check('socket 端口就是指定的那个', true, `127.0.0.1:${sockInfo.port}`)

// ★ 等**真球（helper）先鉴权**再插队：ballSocket 是全局单例，谁后连谁是球。
{
  const end = Date.now() + 120_000
  while (Date.now() < end && !/球鉴权通过/.test(tailLog())) await sleep(500)
  check('真球（helper）连上 Host', /球鉴权通过/.test(tailLog()))
  await sleep(2000)
}

// ---------------------------------------------------------------- 连上冒充球
const received = []
let sock = null
await new Promise((resolve) => {
  sock = connect({ host: '127.0.0.1', port: sockInfo.port }, () => {
    sock.write(`${JSON.stringify({ type: 'hello', token: sockInfo.token })}\n`)
  })
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('data', (chunk) => {
    buf += chunk
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const p of parts) {
      if (!p.trim()) continue
      try { received.push(JSON.parse(p)) } catch { /* 半包 */ }
    }
  })
  sock.on('error', () => {})
  setTimeout(resolve, 3000)
})
check('探针抢到球位', true, `${received.length} 条推送`)

const sendMsg = (o) => sock.write(`${JSON.stringify(o)}\n`)
const waitFor = async (from, pred, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = received.slice(from).find(pred)
    if (hit) return hit
    await sleep(200)
  }
  return null
}
const readCfg = () => JSON.parse(readFileSync(CFG, 'utf8'))
const brainLines = () => {
  const re = /\[local\] brain 就绪 agent=(\S+) model=\S+ persona=([0-9a-f]{12}) (\d+)字/g
  return [...tailLog().matchAll(re)].map((m) => ({ agent: m[1], sha: m[2], chars: Number(m[3]) }))
}
/** 让模型说一句话并等回合收口；返回拼好的 assistant 正文。 */
const sayOneTurn = async (text, ms = 240_000) => {
  const at = received.length
  sendMsg({ type: 'prompt', text })
  const done = await waitFor(at, (m) => m.type === 'turn' && m.running === false, ms)
  const blocks = received.slice(at).filter((m) => m.type === 'block')
  const lastByKey = new Map()
  for (const b of blocks) lastByKey.set(b.key, b)
  const reply = [...lastByKey.values()].filter((b) => b.kind === 'assistant').map((b) => b.text ?? '').join('')
  return { done, reply, blocks, at }
}

// ---------------------------------------------------------------- ① 老配置归一
const SESSION = `local-${AGENT}`
{
  const tail = tailLog()
  check('日志记了「收拢为单个 agent」', /\[local\]?.*收拢为单个 agent（P5）：agentId=/.test(tail) || /收拢为单个 agent（P5）：agentId=/.test(tail),
    (/收拢为单个 agent（P5）：agentId=(\S+)/.exec(tail) ?? [])[0] ?? '没这行')

  const cfg = readCfg()
  check('config.agentId 取的是老配置的 agents.chat', cfg.agentId === AGENT, `agentId=${cfg.agentId}`)
  check('config.agents 已被删掉（不再分记忆仓）', cfg.agents === undefined, JSON.stringify(cfg.agents ?? null))
  check('config.mode 仍是 chat', cfg.mode === 'chat', `mode=${cfg.mode}`)

  // 启动时的那条 `mode` 推送**看不到**：球重连只重放 session / turn / appearance / deco，
  // 不重放 mode（真机日志 16:26:49 那组可见）。所以启动模式只能从日志侧验，
  // 「切模式后能收到 mode」另在 ③ 里验 —— 那才是用户会遇到的时序。
  const bootMode = /-> 球 mode (\{.*?\})/.exec(tailLog())
  check('启动时发出了 {type:mode}', Boolean(bootMode), bootMode?.[1]?.slice(0, 120) ?? '日志里没有')
  let bootModeObj = {}
  try { bootModeObj = JSON.parse(bootMode?.[1] ?? '{}') } catch {}
  check('启动模式 = chat', bootModeObj.mode === 'chat', String(bootModeObj.mode))
  check('mode 里带 agentId 且就是归一出来的那个', bootModeObj.agentId === AGENT, String(bootModeObj.agentId))

  const sess = await waitFor(0, (m) => m.type === 'session' && String(m.sessionId ?? '').startsWith('local-'), 30_000)
  check('会话是 local-<唯一 agent>', sess?.sessionId === SESSION, `sessionId=${sess?.sessionId}`)

  const chatLine = brainLines().find((s) => s.agent === AGENT)
  check('闲聊态 brain 用 chat persona（日志指纹）', chatLine?.sha === sha12(chatPersona),
    chatLine ? `日志 ${chatLine.sha}/${chatLine.chars}字，期望 ${sha12(chatPersona)}` : '日志里没有 brain 就绪')

  check('没有给老配置的 orb-work 建记忆仓', !existsSync(join(MEMFS, LEGACY_WORK_AGENT)),
    existsSync(join(MEMFS, LEGACY_WORK_AGENT)) ? '居然建了' : '没建')
}

// ---------------------------------------------------------------- ② 闲聊态说一句（后面验历史共享）
const CHAT_LINE = '（探针）记住这句：我下周要考试。'
{
  const { done, reply } = await sayOneTurn(CHAT_LINE)
  check('闲聊态回合正常收口', Boolean(done), done ? '' : '超时')
  check('闲聊态有正文回来', reply.trim().length > 0, `${reply.trim().length} 字`)

  const snap = readSystemJson(SESSION)
  check('system.json 里记了 personaHash（chat）', snap?.personaHash === hashPersona(chatPersona.text),
    String(snap?.personaHash ?? '(没有)').slice(0, 24))
}

// ---------------------------------------------------------------- ③ 切到工作态：agent / 会话都不换
{
  const at = received.length
  sendMsg({ type: 'switch-mode', mode: 'work' })
  const modeMsg = await waitFor(at, (m) => m.type === 'mode' && m.mode === 'work', 90_000)
  check('切到工作态后收到 mode 推送（不再永久挂起）', Boolean(modeMsg), JSON.stringify(modeMsg ?? {}).slice(0, 120))
  check('★ 工作态用同一个 agent（不再现造 orb-work）', modeMsg?.agentId === AGENT, `agentId=${modeMsg?.agentId}`)

  const sess = await waitFor(at, (m) => m.type === 'session', 30_000)
  check('★ 会话 id 没变（同一条长会话）', sess?.sessionId === SESSION, `sessionId=${sess?.sessionId}`)

  const tail = tailLog()
  check('日志解释了口径「人格与说话方式换，记忆不换」',
    new RegExp(`\\[local\\] 切模式 chat → work：人格与说话方式换，记忆不换（agent=${AGENT}）`).test(tail))
  check('日志记了「已切到 work 模式」', new RegExp(`\\[local\\] 已切到 work 模式：agent=${AGENT}`).test(tail))
  check('★ 日志记了「人格变了 → 重建 system 快照」（persona 指纹生效）', /\[brain\] 人格变了（换模式）/.test(tail))

  const cfg = readCfg()
  check('config.mode 落盘为 work', cfg.mode === 'work', `mode=${cfg.mode}`)
  check('config.agentId 没被切模式改写', cfg.agentId === AGENT, `agentId=${cfg.agentId}`)
  check('config.agents 依旧不存在', cfg.agents === undefined, JSON.stringify(cfg.agents ?? null))

  const workLine = brainLines().filter((s) => s.agent === AGENT).pop()
  check('工作态 brain 用 work persona（日志指纹）', workLine?.sha === sha12(workPersona),
    workLine ? `日志 ${workLine.sha}/${workLine.chars}字，期望 ${sha12(workPersona)}` : '日志里没有 brain 就绪')

  const snap = readSystemJson(SESSION)
  check('★ system.json 的 personaHash 换成了 work', snap?.personaHash === hashPersona(workPersona.text),
    String(snap?.personaHash ?? '(没有)').slice(0, 24))
  check('system 正文里已经是工作模式的口径', String(snap?.content ?? '').includes('工作模式'))
  check('★ 工作态没为 orb-work 建记忆仓', !existsSync(WORK_REPO), existsSync(WORK_REPO) ? '建了' : '没建')
}

// ---------------------------------------------------------------- ④ 工作态说话 + 历史共享
{
  const { done, reply } = await sayOneTurn('用一句话说你现在是什么状态。')
  check('工作态下回合正常收口', Boolean(done), done ? '' : '超时')
  check('工作态下有正文回来', reply.trim().length > 0, `${reply.trim().length} 字`)

  const msgs = readMessages(SESSION)
  const hasChatLine = msgs.some((m) => JSON.stringify(m).includes(CHAT_LINE))
  check('★ 闲聊态那句话还在同一条会话里（历史共享）', hasChatLine, `${msgs.length} 条消息`)
  check('★ 消息条数 ≥ 4（两问两答都落在一条会话里）', msgs.length >= 4, `${msgs.length} 条`)
}

// ---------------------------------------------------------------- ⑤ 切回闲聊：人格回来、会话还是同一条
{
  const at = received.length
  sendMsg({ type: 'switch-mode', mode: 'chat' })
  const modeMsg = await waitFor(at, (m) => m.type === 'mode' && m.mode === 'chat', 90_000)
  check('切回闲聊后收到 mode 推送', Boolean(modeMsg), JSON.stringify(modeMsg ?? {}).slice(0, 120))
  check('闲聊用的还是同一个 agent', modeMsg?.agentId === AGENT, `agentId=${modeMsg?.agentId}`)

  const sess = await waitFor(at, (m) => m.type === 'session', 30_000)
  check('会话 id 仍是同一条', sess?.sessionId === SESSION, `sessionId=${sess?.sessionId}`)

  const tail = tailLog()
  const count = (tail.match(/\[brain\] 人格变了（换模式）/g) ?? []).length
  check('人格重建恰好发生两次（work 一次、chat 一次）', count === 2, `${count} 次`)

  const chatLine = brainLines().filter((s) => s.agent === AGENT).pop()
  check('闲聊态 brain 用回 chat persona', chatLine?.sha === sha12(chatPersona),
    chatLine ? `日志 ${chatLine.sha}，期望 ${sha12(chatPersona)}` : '日志里没有 brain 就绪')

  const snap = readSystemJson(SESSION)
  check('system.json 的 personaHash 换回 chat', snap?.personaHash === hashPersona(chatPersona.text),
    String(snap?.personaHash ?? '(没有)').slice(0, 24))

  const cfg = readCfg()
  check('config.mode 回到 chat', cfg.mode === 'chat', `mode=${cfg.mode}`)
  check('config 里始终只有一个 agentId', cfg.agentId === AGENT && cfg.agents === undefined)
}

// ---------------------------------------------------------------- ⑥ 现场与收尾
{
  const tail = tailLog()
  check('没有切模式失败', !/\[local\] 切模式失败/.test(tail))
  check('没有撞「Letta 还没就绪，切模式请求先挂起」', !/切模式请求先挂起/.test(tail))
  check('没有异常堆栈', !/Uncaught|UnhandledPromiseRejection/.test(tail))

  const agentDirs = existsSync(MEMFS) ? readdirSync(MEMFS) : []
  check('★ 数据根下只有一个 agent 的记忆仓', agentDirs.length === 1 && agentDirs[0] === AGENT,
    JSON.stringify(agentDirs))
}

cleanup()
restoreConfig()
{
  // 备份是**迁移前**的原文件，里面本来就有 `agents:{chat:...}`（生产配置如此），
  // 所以「恢复」的正确判据是「与备份逐字段相等」，不是「里面没有 agents」。
  const afterCfg = readCfg()
  check('config.json 已恢复（与备份逐字段相等）', JSON.stringify(afterCfg) === JSON.stringify(origCfg),
    `agentId=${afterCfg.agentId} 备份=${JSON.stringify(origCfg).slice(0, 80)}`)
  check('恢复后不是这次的沙箱 id', afterCfg.agentId !== AGENT && JSON.stringify(afterCfg).includes(String(origCfg.agentId)),
    `agentId=${afterCfg.agentId} 原始=${origCfg.agentId}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length} PASS / ${failed.length} FAIL ===`)
if (failed.length) for (const f of failed) console.log(`  ✗ ${f.name} ${f.detail}`)
process.exit(failed.length ? 1 : 0)
