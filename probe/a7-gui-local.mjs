/**
 * A7 真机验收：GUI 里 engine=local 能不能正常跑完一轮。
 *
 * 为什么不能只靠 node 直跑 brain：A7 验的是「球 → socket → main.mjs → local brain → 球」
 * 整条链路 —— 总闸（R1）、dispatchPrompt 分叉、runLocalTurn 的事件翻译、回合收口
 * （turn=false）都在 main.mjs 里，node 直跑一行都碰不到。
 *
 * 做法（照抄 probe/history-e2e.mjs 的成熟套路）：
 *   1. 备份 config.json → 改成本次一次性配置（engine=local + 一次性 agentId + 沙箱数据根）
 *   2. 起 launch.mjs（Electron），从日志抓 socket 端口与 token
 *   3. 等真球连上之后**再插队**（ballSocket 是全局单例，后来者覆盖前者 —— 顺序错了就发不出消息）
 *   4. 冒充球发 prompt，收 block/turn 事件，断言：
 *      3 秒内出现第一块（A7 判据）、回合有 turn=false 收口（不卡「正在思考」）、
 *      工具块拼得成一块（R4）、第二轮记得第一轮说的事（记忆真的进了下一轮）
 *   5. finally 里恢复 config.json、杀进程
 *
 * ⚠️ 全程只碰 _sandbox-data-a7；真实 data/ 与 ~/.letta 一个字节都不动（A5 的延伸）。
 */
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CFG = join(ROOT, 'config.json')
const LOG = join(ROOT, 'logs', 'orb.log')
const SOCK_PORT = 25971
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const AGENT = `orb-g3-test-${STAMP}`
const DATA = join(ROOT, '_sandbox-data-a7')
const BAK = join(ROOT, 'bak', `config.a7-${STAMP}.json`)

mkdirSync(DATA, { recursive: true })
const original = readFileSync(CFG, 'utf8')
const originalLog = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
mkdirSync(dirname(BAK), { recursive: true })
writeFileSync(BAK, original, 'utf8')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` —— ${detail}` : ''}`)
}

// ---------------------------------------------------------------- 一次性配置
const cfg = JSON.parse(original)
cfg.engine = 'local'
cfg.agentId = AGENT
cfg.agents = { ...(cfg.agents ?? {}), chat: AGENT }
writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
console.log(`>>> config.json 临时改为 engine=local agentId=${AGENT}（备份 ${BAK}）`)

// ---------------------------------------------------------------- 起 orb
const env = { ...process.env }
for (const [k, v] of Object.entries({
  // 沙箱里 Chromium 的 GPU 子进程起不来 → FATAL。两者必须一起给。
  ORB_ELECTRON_FLAGS: '--no-sandbox --disable-gpu',
  ORB_TRACE: '1', // token 只在这个开关下打进日志
  ORB_SOCKET_PORT: String(SOCK_PORT), // 固定端口，省得从日志抓
  ORB_DATA: DATA, // 记忆 / 会话全落沙箱
  ORB_SELFTEST: '',
})) if (v !== undefined) env[k] = v

const orb = spawn(process.execPath, [join(ROOT, 'src', 'launch.mjs')], {
  cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'],
})
let orbOut = ''
orb.stdout?.on('data', (d) => { orbOut += d })
orb.stderr?.on('data', (d) => { orbOut += d })

let sock = null
const cleanup = () => {
  try { sock?.destroy() } catch { /* 已断 */ }
  try { orb.kill() } catch { /* 已退出 */ }
  try {
    writeFileSync(CFG, original, 'utf8')
    console.log('>>> config.json 已恢复')
  } catch (e) {
    console.log(`!! config.json 恢复失败，请手工从 ${BAK} 拷回：${e.message}`)
  }
}
process.on('exit', cleanup)

const readLog = () => { try { return readFileSync(LOG, 'utf8') } catch { return '' } }
const tailLog = () => readLog().slice(originalLog.length)
function lastMatch(re) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
  const all = [...tailLog().matchAll(new RegExp(re.source, flags))]
  return all.length > 0 ? all[all.length - 1] : null
}

// ---------------------------------------------------------------- 等 socket
let sockInfo = null
const waitSock = Date.now() + 120_000
while (Date.now() < waitSock && !sockInfo) {
  await new Promise((r) => setTimeout(r, 1000))
  const port = lastMatch(/球的控制 socket 监听 127\.0\.0\.1:(\d+)/)
  const token = lastMatch(/socket token=(\S+)/)
  if (port && token) sockInfo = { port: Number(port[1]), token: token[1] }
}
if (!sockInfo) {
  console.log('!! 没等到 socket 就绪')
  console.log(tailLog().slice(-4000) || orbOut.slice(-4000))
  cleanup()
  process.exit(1)
}
console.log(`>>> socket = 127.0.0.1:${sockInfo.port}`)

// ---------------------------------------------------------------- 等真球
let realBallUp = null
for (let i = 0; i < 90 && !realBallUp; i += 1) {
  await new Promise((r) => setTimeout(r, 1000))
  realBallUp = lastMatch(/球鉴权通过/)
}
check('真球（helper）连上 Host', Boolean(realBallUp))
if (realBallUp) await new Promise((r) => setTimeout(r, 1500))

// ---------------------------------------------------------------- 冒充球
const received = []
let buf = ''
await new Promise((resolve) => {
  sock = connect({ host: '127.0.0.1', port: sockInfo.port }, () => {
    sock.write(`${JSON.stringify({ type: 'hello', token: sockInfo.token })}\n`)
  })
  sock.setEncoding('utf8')
  sock.on('data', (chunk) => {
    buf += chunk
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const p of parts) {
      if (!p.trim()) continue
      try { received.push(JSON.parse(p)) } catch { /* 半包/杂包 */ }
    }
  })
  sock.on('error', () => {})
  setTimeout(resolve, 3000)
})
check('探针抢到球位（能收到首包）', received.length > 0, `${received.length} 条`)
if (received.length === 0) {
  cleanup()
  process.exit(1)
}

/**
 * 只在这一刻之后收到的消息里找。
 *
 * 必须带游标：`received.find` 会从头扫，第 2 轮等 turn=false 会立刻命中第 1 轮那条，
 * 于是「第二轮收口」变成永远 PASS —— 假绿比红更坏。
 */
const waitForNew = async (from, pred, ms) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const hit = received.slice(from).find(pred)
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- 第 1 轮
const c1 = received.length
const t0 = Date.now()
sock.write(`${JSON.stringify({ type: 'prompt', text: '我叫阿澈，喜欢冰美式不加糖，最讨厌香菜。记住了吗？' })}\n`)

const firstTurnOn = await waitForNew(c1, (m) => m.type === 'turn' && m.running === true, 6000)
const tFirstTurn = Date.now() - t0
const firstBlock = await waitForNew(c1, (m) => m.type === 'block', 6000)
const tFirstBlock = Date.now() - t0
check('回合一开就 turn=true（不是干等）', Boolean(firstTurnOn), firstTurnOn ? `${tFirstTurn}ms` : '6 秒内没有 turn=true')
check('3 秒内推出第一块（A7 判据）', Boolean(firstBlock) && tFirstBlock <= 3000,
  firstBlock ? `第一块 ${tFirstBlock}ms（${firstBlock.key}）` : `6 秒内没有 block`)

const turnOff1 = await waitForNew(c1, (m) => m.type === 'turn' && m.running === false, 120_000)
check('回合正常收口、不卡「正在思考」', Boolean(turnOff1),
  turnOff1 ? `第一轮全程 ${Date.now() - t0}ms` : '120 秒内没有 turn=false')

await sleep(1500)
const msgs1 = received.slice(c1)
const blocks1 = msgs1.filter((m) => m.type === 'block')
// ★ 同一个 key 会被推多次（每次都是**全量**文本，不是增量）；按 key 聚合成「更新序列」，
//   取最后一次当定稿，否则 join 起来会出现「记住记住啦记住啦」这种重复累积的假象。
const byKey1 = new Map()
for (const b of blocks1) {
  if (!byKey1.has(b.key)) byKey1.set(b.key, [])
  byKey1.get(b.key).push(b)
}
const lastOf = (key) => byKey1.get(key).at(-1)
const assistantKeys1 = [...byKey1.keys()].filter((k) => lastOf(k).kind === 'assistant')
const assistant1 = assistantKeys1.map((k) => lastOf(k).text ?? '').join('')
check('本轮有 assistant 正文', assistant1.trim().length > 0, `${assistant1.trim().length} 字 / ${assistantKeys1.length} 块`)
console.log(`    回复：${assistant1.trim().slice(0, 160).replace(/\n/g, ' ')}`)

// R4：工具调用与结果必须落在**同一个 block key** 上（call 时 running=true，result 时 running=false）
const toolKeys = [...byKey1.keys()].filter((k) => lastOf(k).kind === 'tool')
const paired = toolKeys.filter((k) => {
  const seq = byKey1.get(k)
  const first = seq[0]
  const last = seq.at(-1)
  return first.running === true && last.running === false && typeof last.detail?.args === 'string'
})
check('工具调用与结果拼在同一个块上（R4，且 args 是字符串）',
  toolKeys.length === 0 || paired.length === toolKeys.length,
  `tool 块 ${toolKeys.length} / 成对 ${paired.length}${toolKeys.length ? ` / 示例 ${toolKeys[0]}` : '（本轮没调工具）'}`)

// ---------------------------------------------------------------- 第 2 轮（记忆是否生效）
const c2 = received.length
const t1 = Date.now()
sock.write(`${JSON.stringify({ type: 'prompt', text: '我叫什么？喜欢喝什么？有什么忌口？' })}\n`)
const turnOff2 = await waitForNew(c2, (m) => m.type === 'turn' && m.running === false, 120_000)
await sleep(1500)
const answer2 = (() => {
  const m = new Map()
  for (const b of received.slice(c2)) if (b.type === 'block' && b.kind === 'assistant') m.set(b.key, b.text ?? '')
  return [...m.values()].join('')
})()
const remembered = /阿澈/.test(answer2) && /冰美式|美式/.test(answer2) && /香菜/.test(answer2)
check('第二轮答得出第一轮说的事（记忆链路通）', remembered, answer2.trim().replace(/\n/g, ' ').slice(0, 160))
check('第二轮也有回合收口', Boolean(turnOff2), turnOff2 ? `全程 ${Date.now() - t1}ms` : '120 秒内没有 turn=false')

// ---------------------------------------------------------------- 落盘证据
const memRepo = join(DATA, 'memfs', AGENT, 'memory')
const memoryFile = join(memRepo, 'MEMORY.md')
check('沙箱记忆仓里 MEMORY.md 存在', existsSync(memoryFile),
  existsSync(memoryFile) ? `${readFileSync(memoryFile, 'utf8').length}B` : memRepo)
let commits = ''
try {
  commits = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: memRepo, encoding: 'utf8' }).trim()
} catch (e) { commits = `(git 读失败：${e.message.slice(0, 80)})` }
check('记忆仓有提交（写即 commit）', /^\d+$/.test(commits) && Number(commits) > 0, `commits=${commits}`)

// ------------------------------------------------- R3 面板端点（local 下的四个命令）
const memSha = (() => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: memRepo, encoding: 'utf8' }).trim() } catch { return '' }
})()
/** 发一条面板命令，只在这一刻之后收的包里找对应回包（同 waitForNew 的游标道理）。 */
const askPanel = async (payload, expectType, ms = 20_000) => {
  const at = received.length
  sock.write(`${JSON.stringify(payload)}\n`)
  return waitForNew(at, (m) => m.type === expectType, ms)
}

const fatRef = await askPanel({ type: 'memory:file-at-ref', path: 'MEMORY.md', ref: memSha }, 'memory:file-at-ref')
check('面板 file-at-ref：按 sha 读出那个版本的文件',
  Boolean(fatRef?.ok) && (fatRef?.content ?? '').length > 0,
  fatRef ? `ok=${fatRef.ok} ${(fatRef.content ?? '').length}B error=${fatRef.error ?? '无'}` : '20 秒无响应')

const fatHead = await askPanel({ type: 'memory:file-at-ref', path: 'MEMORY.md', ref: 'HEAD' }, 'memory:file-at-ref')
check('面板 file-at-ref：ref 给分支名也能用（HEAD）', Boolean(fatHead?.ok),
  fatHead ? `ok=${fatHead.ok} error=${fatHead.error ?? '无'}` : '20 秒无响应')

const cdiff = await askPanel({ type: 'memory:commit-diff', sha: memSha }, 'memory:commit-diff')
check('面板 commit-diff：这次提交的 patch 非空',
  Boolean(cdiff?.ok) && /diff --git/.test(cdiff?.diff ?? ''),
  cdiff ? `ok=${cdiff.ok} ${(cdiff.diff ?? '').length}B error=${cdiff.error ?? '无'}` : '20 秒无响应')

const arch = await askPanel({ type: 'memory:archive-now' }, 'memory:archive-result')
check('面板 archive-now：干净仓不产生空提交（committed 0）',
  Boolean(arch?.ok) && arch?.committed === 0,
  arch ? `ok=${arch.ok} committed=${arch.committed} skipped=${arch.skipped ?? ''}` : '20 秒无响应')

const ih = await askPanel({ type: 'impression-history-get' }, 'impression-history')
check('面板 impression-history：local 下能读提交列表（印象文件可空）',
  ih?.ok === true && Array.isArray(ih?.commits),
  ih ? `ok=${ih.ok} ${ih.commits?.length ?? 0} 条 error=${ih.error ?? '无'}` : '20 秒无响应')

const convDir = join(DATA, 'conversations')
const convIndex = join(convDir, 'index.json')
const convIds = existsSync(convIndex) ? (JSON.parse(readFileSync(convIndex, 'utf8'))?.ids ?? []).length : 0
check('会话已落盘', existsSync(convDir), `conversations 目录${existsSync(convDir) ? '存在' : '不存在'}，会话数 ${convIds}`)

// ---------------------------------------------------------------- 日志侧证据
const logTail = tailLog()
check('启动日志确认跳过 Letta', /引擎=local，跳过 Letta 启动/.test(logTail))
check('没有未捕获异常', !/UnhandledPromiseRejection|TypeError:|ReferenceError:/.test(logTail),
  (logTail.match(/(UnhandledPromiseRejection|TypeError:|ReferenceError:)[^\n]*/g) ?? []).slice(0, 3).join(' | '))

console.log('\n===== 汇总 =====')
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}`)
const failed = checks.filter((c) => !c.ok)
console.log(`PASS ${checks.length - failed.length} · FAIL ${failed.length}`)
writeFileSync(join(DATA, `a7-${STAMP}.log`), `${tailLog()}\n\n===== 汇总 =====\n${checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` —— ${c.detail}` : ''}`).join('\n')}\n`, 'utf8')

cleanup()
process.exit(failed.length === 0 ? 0 : 1)
