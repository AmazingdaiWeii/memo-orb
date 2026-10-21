// 真配置冒烟：**不改 config.json**，直接在工程根跑一次真实使用路径。
//
// 与 a7-gui-local.mjs 的区别：那个用一次性 agentId + 沙箱数据根验收功能；
// 这个验的是「用户把 config.json 切到 engine=local 之后，自己那份配置真能跑」。
// 只发一句话、看一眼落盘，然后收工（不写记忆内容，不改配置）。
//
// ══════════════🔴 2026-10-21 加的保险丝（血的教训）══════════════
//
// 这个探针**拿真实的 config.json + 真实的 data/ 起一个真 orb**，所以：
//   ① 它退出时会把内存里的配置**写回 config.json** —— 用户正在用的话，
//      可能把他刚改的设置覆盖掉；
//   ② 它发的那句话会真的进用户的会话目录与记忆；
//   ③ 它会和用户正在跑的 orb **抢同一个托盘图标与 socket**。
//
// 同类事故已经出过：`switch-mode-local-gui.mjs` / `impression-local-gui.mjs`
// 把 config.agentId 换成了 `orb-*-test-*`（靠 exit 事件恢复，进程被杀就恢复不了），
// 于是用户「历史对话和记忆一起消失」—— 数据没丢，只是换了 agent。
//
// 所以现在：**默认不跑**。要跑必须显式加 `--i-know`，且检测到 orb 正在运行就拒绝。
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LOG = join(ROOT, 'logs', 'orb.log')
const SOCK_PORT = 25973
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
const DATA = process.env.ORB_DATA || join(ROOT, 'data')
const REPO = join(DATA, 'memfs', cfg.agentId, 'memory')

// ── 保险丝：默认拒绝 ────────────────────────────────────────────────────
if (!process.argv.includes('--i-know')) {
  console.log([
    '',
    '⛔ 这个探针会拿**真实的 config.json + 真实的 data/** 起一个真 orb：',
    '   · 它退出时会把内存里的配置写回 config.json（可能覆盖你刚改的设置）',
    '   · 它发的那句话会真的进你的会话目录与记忆',
    '   · 它会和你正在跑的 orb 抢托盘图标与 socket',
    '',
    '确认要跑，请显式加 --i-know：',
    '   node probe/real-local-smoke.mjs --i-know',
    '',
  ].join('\n'))
  process.exit(2)
}
{
  // orb 正在运行就别碰 —— 两个实例共用托盘与端口，会互相踢。
  let running = false
  try {
    const { execFileSync } = await import('node:child_process')
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/NH'], { encoding: 'utf8' })
    running = /electron\.exe/i.test(out)
  } catch { /* 查不到就当没跑 */ }
  if (running) {
    console.log('⛔ 检测到 electron.exe 正在运行 —— 请先完全退出 orb 再跑这个探针（两个实例会互相踢）。')
    process.exit(2)
  }
}

const HINT = '（随手一提：我现在喝冰美式，不加糖。）'

const originalLog = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
const env = { ...process.env, ORB_SOCKET_PORT: String(SOCK_PORT), ORB_TRACE: '1',
  ORB_ELECTRON_FLAGS: '--no-sandbox --disable-gpu' }
delete env.ORB_DATA // 用真实配置里的数据根（工程根 data/）

const orb = spawn(process.execPath, [join(ROOT, 'src', 'launch.mjs')], {
  cwd: ROOT, env, stdio: 'ignore', windowsHide: true,
})
const cleanup = () => {
  try { orb.kill() } catch { /* 已退出 */ }
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(orb.pid)], { stdio: 'ignore' })
  } catch { /* 进程树已没了 */ }
}
process.on('exit', cleanup)

const readLog = () => { try { return readFileSync(LOG, 'utf8') } catch { return '' } }
const tailLog = () => readLog().slice(originalLog.length)

let sockInfo = null
const deadline = Date.now() + 120_000
while (Date.now() < deadline && !sockInfo) {
  await new Promise((r) => setTimeout(r, 1000))
  // ★ 只看**本次启动之后**追加的日志：整份 log 里有上一次跑留下的端口号，
  // 用它去连会连到已关闭的 socket，然后一路超时（首跑就踩了这条）。
  const tail = tailLog()
  const m = /球的控制 socket 监听 127\.0\.0\.1:(\d+)/.exec(tail)
  const t = /socket token=(\S+)/.exec(tail)
  if (m && t && Number(m[1]) === SOCK_PORT) sockInfo = { port: Number(m[1]), token: t[1] }
}
if (!sockInfo) {
  console.log('FAIL 没等到 socket 信息')
  console.log(tailLog().split('\n').slice(-15).join('\n'))
  cleanup()
  process.exit(1)
}

// ★ 等**真球（helper）先鉴权通过**再插队：ballSocket 是全局单例，
// 谁后连谁就是球。先连的话会被 helper 顶掉，于是 prompt 被处理、推送却全进了 helper。
{
  const end = Date.now() + 120_000
  while (Date.now() < end && !/球鉴权通过/.test(tailLog())) await new Promise((r) => setTimeout(r, 500))
  await new Promise((r) => setTimeout(r, 2000))
}

let sock = null
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
      try { received.push(JSON.parse(p)) } catch { /* 半包 */ }
    }
  })
  sock.on('error', () => {})
  setTimeout(resolve, 3000)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (from, pred, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = received.slice(from).find(pred)
    if (hit) return hit
    await sleep(200)
  }
  return null
}

const at = received.length
sock.write(`${JSON.stringify({ type: 'prompt', text: `你好呀，今天有点冷。${HINT}` })}\n`)
const turned = await waitFor(at, (m) => m.type === 'turn' && m.running === true, 8000)
const done = await waitFor(at, (m) => m.type === 'turn' && m.running === false, 120_000)
await sleep(1500)

const blocks = received.slice(at).filter((m) => m.type === 'block')
const lastByKey = new Map()
for (const b of blocks) lastByKey.set(b.key, b)
const answer = [...lastByKey.values()].filter((b) => b.kind === 'assistant')
  .map((b) => b.text ?? '').join('').trim()

console.log(`turn=true ${turned ? 'OK' : '超时'}`)
console.log(`回合收口 ${done ? 'OK' : '超时'}`)
console.log(`回复（${answer.length} 字）：${answer.replace(/\n/g, ' ').slice(0, 200)}`)

const logTail = tailLog()
console.log(`数据根日志：${(logTail.match(/\[local\] 数据根[^\n]*/) ?? ['（无）'])[0]}`)
console.log(`记忆仓 ${REPO} 存在=${existsSync(REPO)}`)
if (existsSync(join(REPO, 'MEMORY.md'))) {
  // ★ 用 statSync().size —— 中文 352 字节只占 134 个 UTF-16 字符，
  //   拿 string.length 当字节数会让「记忆有没有涨」永远读错。
  console.log(`MEMORY.md：${statSync(join(REPO, 'MEMORY.md')).size}B`)
}
try {
  console.log(`commits=${execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()}`)
} catch (e) { console.log(`commits 读失败：${e.message.slice(0, 60)}`) }
const ok = Boolean(turned && done && answer.length > 0)
console.log(ok ? 'PASS' : 'FAIL')
cleanup()
process.exit(ok ? 0 : 1)
