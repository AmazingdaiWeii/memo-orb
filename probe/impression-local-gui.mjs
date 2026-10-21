// 印象总结「本地直跑」的 GUI 端到端验收（沙箱数据根 + 一次性 agentId）。
//
// 验的是这条链路：面板点「现在重新总结一次」→ host 真的让她在独立会话里跑一轮
// → `about/印象.md` 正文变了 → 面板收到新内容 → **球上不冒出任何一句正文**。
//
// ⚠️ 为什么必须真起 Electron：`runImpressionLocal()` 走的是 `runtime.brain`，
//    那个对象只有在 `ensureRuntime()` 里才存在 —— 单测没法造。
//
// ⚠️ 本探针**会临时改 config.json**（engine/agentId），跑完（含异常）由
//    `restoreConfig()` 拷回备份；备份在 `bak/config.imp-<stamp>.json`。
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, statSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LOG = join(ROOT, 'logs', 'orb.log')
const CFG = join(ROOT, 'config.json')
const PORT = 25974
const DATA = join(ROOT, '_sandbox-data-imp')

const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const AGENT = `orb-imp-test-${STAMP}`
const BAK = join(ROOT, 'bak', `config.imp-${STAMP}.json`)

// ★ 有效 agentId 的真源是 `config.agents.chat`，不是顶层 `agentId`：
//   `normalizeModeConfig()`（src/main.mjs:354）会用 `agents.chat` 把顶层 `agentId` 覆盖回去。
//   只改顶层会导致引擎照旧用原来的 agent，探针却去一个空目录里找文件（首跑 5 条 FAIL 就是这么来的）。
//   所以这里两个都写，并且**从日志确认**引擎真正用的是哪个。
let REPO = join(DATA, 'memfs', AGENT, 'memory')
let IMP = join(REPO, 'about', '印象.md')
const rebaseTo = (agent) => {
  if (agent === AGENT) return
  REPO = join(DATA, 'memfs', agent, 'memory')
  IMP = join(REPO, 'about', '印象.md')
}

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
const agents = { ...(origCfg.agents ?? {}), chat: AGENT }
writeFileSync(CFG, `${JSON.stringify({ ...origCfg, engine: 'local', agentId: AGENT, agents }, null, 2)}\n`, 'utf8')

// ★ 数据根必须从零开始：上一轮留下的 `about/印象.md` 会让「正文变了」的断言恒真，
//   只剩 `MEMORY.md` 的时候才验得清「她真的重写了印象文件」。
rmSync(DATA, { recursive: true, force: true })
console.log(`沙箱 agent=${AGENT}（agents.chat）数据根=${DATA}（已清空）`)

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

// ---------------------------------------------------------------- 等 socket
let sockInfo = null
{
  const end = Date.now() + 120_000
  while (Date.now() < end && !sockInfo) {
    await sleep(1000)
    // ★ 只看本次启动之后追加的日志：整份 log 里有上一次跑留下的端口。
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

// ---------------------------------------------------------------- 记下种子
const seedBefore = existsSync(IMP) ? readFileSync(IMP, 'utf8') : null
const commitsBefore = (() => {
  try { return Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()) } catch { return -1 }
})()

// ---------------------------------------------------------------- 打开面板
{
  const at = received.length
  sendMsg({ type: 'impression-get' })
  const panel = await waitFor(at, (m) => m.type === 'impression' && m.loading !== true, 60_000)
  check('打开面板能拿到 impression 数据', Boolean(panel), panel?.error ?? (panel ? `exists=${panel.exists}` : '超时'))
}

// ---------------------------------------------------------------- 点「重新总结一次」
const at = received.length
const t0 = Date.now()
sendMsg({ type: 'impression-refresh' })
const result = await waitFor(at, (m) => m.type === 'impression-result', 300_000)
const ms = Date.now() - t0
check('点了按钮能拿到 impression-result（不再假死）', Boolean(result), `${ms}ms ${result ? JSON.stringify(result).slice(0, 160) : '超时'}`)
check('结果 ok:true', result?.ok === true, result?.error ?? '')

// 面板推送（host 自己那条链路）
const panelPush = await waitFor(at, (m) => m.type === 'impression' && m.loading !== true, 200_000)
check('面板收到了刷新后的印象', Boolean(panelPush), panelPush ? `text ${(panelPush.text ?? '').length} 字` : '超时')

// ---------------------------------------------------------------- 落盘
// 先确认引擎真正用的 agent，再谈路径 —— 否则下面五条会集体对着空目录喊 FAIL。
{
  const m = /\[local\] brain 就绪 agent=(\S+)/.exec(tailLog())
  const used = m?.[1] ?? ''
  check('引擎用的就是沙箱 agent（config.agents.chat 生效）', used === AGENT, used ? `日志 agent=${used}` : '日志里没有 brain 就绪')
  if (used && used !== AGENT) {
    console.log(`WARN 引擎用的是 ${used}，把断言路径改到它下面`)
    rebaseTo(used)
  }
}
const nowText = existsSync(IMP) ? readFileSync(IMP, 'utf8') : null
check('about/印象.md 真的被写了', nowText !== null, nowText ? `${statSync(IMP).size}B` : '文件不存在')
check('正文确实变了（不是原样没动）', nowText !== null && nowText !== seedBefore,
  seedBefore === null ? '种子本来不存在 → 新写' : `${(seedBefore ?? '').length} → ${(nowText ?? '').length} 字符`)
check('正文不是空壳', (nowText ?? '').trim().length > 80, `${(nowText ?? '').trim().length} 字符`)
check('面板推送的正文与磁盘一致', Boolean(nowText) && (panelPush?.text ?? '').trim() === nowText.trim())

const commitsAfter = (() => {
  try { return Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()) } catch { return -1 }
})()
check('记忆仓多了一次提交', commitsAfter > commitsBefore, `${commitsBefore} → ${commitsAfter}`)

// ---------------------------------------------------------------- 不往球上说话
const blocks = received.slice(at).filter((m) => m.type === 'block')
const assistantBlocks = blocks.filter((b) => b.kind === 'assistant')
check('这一轮没有往球上推正文（独处时间就该安静）', assistantBlocks.length === 0,
  assistantBlocks.length ? `${assistantBlocks.length} 条：${JSON.stringify(assistantBlocks[0]).slice(0, 120)}` : '')

// ---------------------------------------------------------------- 日志
const tail = tailLog()
check('日志出现「本地直跑印象整理」', /记忆中心：本地直跑印象整理/.test(tail))
check('日志出现「本地印象已更新」', /记忆中心：本地印象已更新/.test(tail))
check('没有再撞「Letta 还没就绪」（这次修的就是它）', !/Letta 还没就绪/.test(tail))
check('没有异常堆栈', !/Uncaught|UnhandledPromiseRejection|本地印象异常/.test(tail))

// ---------------------------------------------------------------- 收尾
cleanup()
restoreConfig()
const afterCfg = JSON.parse(readFileSync(CFG, 'utf8'))
check('config.json 已恢复（agentId 不是这次的沙箱 id）', afterCfg.agentId !== AGENT, `agentId=${afterCfg.agentId}`)

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length} PASS / ${failed.length} FAIL ===`)
if (failed.length) for (const f of failed) console.log(`  ✗ ${f.name} ${f.detail}`)
process.exit(failed.length ? 1 : 0)
