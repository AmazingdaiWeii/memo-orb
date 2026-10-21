/**
 * GUI 端到端夹具（真 Electron + 真球 + 真模型），给 P1/P3 的 e2e 探针共用。
 *
 * 为什么需要它：`web-tools-unit` / `schedule-unit` 只验到模块层（打桩 LLM、不启动 Electron）。
 * 设计文档 §12 要求 P1/P3 各有一套「真模型被要求做这件事，回合内真的发生了」的验收，
 * 那必须走真实链路：起 orb → 冒充球连 socket → 发 prompt → 看 block 推送。
 *
 * 用法：
 *   const h = await boot({ port: 25973, tag: 'orb-web-e2e', sandbox: '_sandbox-data-web' })
 *   h.send({ type: 'prompt', text: '...' })
 *   const turn = await h.settleTurn(0, 180_000)
 *   h.check('...', ok, detail)
 *   h.finish()   // 打印 === PASS n · FAIL m ===，恢复 config.json，退出码 = FAIL 数
 *
 * 约定（与既有探针一致，别改）：
 *   - 沙箱 `ORB_DATA` 指向项目内 `_sandbox-*`，绝不碰生产 `data/`；
 *   - 一次性 agentId，跑完 config.json 逐字节恢复（备份在 `bak/`）；
 *   - 球侧 block 以 key 覆盖（同 key 后到的为准），所以取正文/工具块**必须**先 lastByKey，
 *     否则流式增量会被当成重复内容拼起来（旧探针的「`name`name`name`」就是这么来的）。
 */
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const ROOT_DIR = ROOT
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function boot({ port, tag, sandbox, prepare }) {
  const CFG = join(ROOT, 'config.json')
  const LOG = join(ROOT, 'logs', 'orb.log')
  const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const AGENT = `${tag}-${STAMP}`
  const DATA = join(ROOT, sandbox)
  const BAK = join(ROOT, 'bak', `config-${tag}-${STAMP}.json`)

  const original = readFileSync(CFG, 'utf8')
  const originalLog = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
  mkdirSync(dirname(BAK), { recursive: true })
  writeFileSync(BAK, original, 'utf8')
  mkdirSync(DATA, { recursive: true })
  if (prepare) await prepare({ dataDir: DATA, agent: AGENT })

  const cfg = JSON.parse(original)
  cfg.engine = 'local'
  cfg.agentId = AGENT
  cfg.agents = { ...(cfg.agents ?? {}), chat: AGENT }
  writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  console.log(`>>> config.json 临时改为 engine=local agentId=${AGENT}（备份 ${BAK}）`)

  const env = { ...process.env }
  for (const [k, v] of Object.entries({
    ORB_ELECTRON_FLAGS: '--no-sandbox --disable-gpu',
    ORB_TRACE: '1',
    ORB_SOCKET_PORT: String(port),
    ORB_DATA: DATA,
    ORB_SELFTEST: '',
  })) if (v !== undefined) env[k] = v

  const orb = spawn(process.execPath, [join(ROOT, 'src', 'launch.mjs')], {
    cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let orbOut = ''
  orb.stdout?.on('data', (d) => { orbOut += d })
  orb.stderr?.on('data', (d) => { orbOut += d })

  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` —— ${detail}` : ''}`)
  }

  let sock = null
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
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
  const lastMatch = (re) => {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
    const all = [...tailLog().matchAll(new RegExp(re.source, flags))]
    return all.length > 0 ? all[all.length - 1] : null
  }

  // ---------------------------------------------------------------- 等 socket 与真球
  let sockInfo = null
  const waitSock = Date.now() + 120_000
  while (Date.now() < waitSock && !sockInfo) {
    await sleep(1000)
    const p = lastMatch(/球的控制 socket 监听 127\.0\.0\.1:(\d+)/)
    const token = lastMatch(/socket token=(\S+)/)
    if (p && token) sockInfo = { port: Number(p[1]), token: token[1] }
  }
  if (!sockInfo) {
    console.log('!! 没等到 socket 就绪')
    console.log(tailLog().slice(-4000) || orbOut.slice(-4000))
    cleanup()
    process.exit(1)
  }
  check('socket 端口就是指定的那个（不是上次残留的日志）', sockInfo.port === port, `127.0.0.1:${sockInfo.port}`)

  let realBallUp = false
  for (let i = 0; i < 90 && !realBallUp; i += 1) {
    await sleep(1000)
    realBallUp = Boolean(lastMatch(/球鉴权通过/))
  }
  check('真球（helper）连上 Host', realBallUp)
  if (realBallUp) await sleep(1500)

  // ---------------------------------------------------------------- 冒充球
  const received = []
  let buf = ''
  await new Promise((resolve) => {
    sock = connect({ host: '127.0.0.1', port: sockInfo.port }, () => {
      sock.write(`${JSON.stringify({ type: 'hello', token: sockInfo.token })}\n`)
      resolve()
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
  })
  await sleep(3000)
  check('探针抢到球位', received.length > 0, `${received.length} 条`)

  const send = (obj) => sock.write(`${JSON.stringify(obj)}\n`)
  const waitForNew = async (from, pred, ms) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const hit = received.slice(from).find(pred)
      if (hit) return hit
      await sleep(200)
    }
    return null
  }
  const answerCard = (card, label) => {
    const qid = card.questions?.[0]?.id ?? 'q1'
    send({ type: 'question-answer', id: card.id, answers: [{ id: qid, selected: [label] }] })
  }
  /** 按 key 取最后一条（球侧渲染层就是这么覆盖的：同 key 后到的为准）。 */
  const lastByKey = (arr) => {
    const m = new Map()
    for (const b of arr) m.set(b.key, b)
    return [...m.values()]
  }
  /** 等回合收口；期间冒出来的卡一律按 label 允许（e2e 里我们不想被卡住）。 */
  const settleTurn = async (from, ms, label = '允许') => {
    const deadline = Date.now() + ms
    const answered = new Set()
    const cards = []
    while (Date.now() < deadline) {
      for (const m of received.slice(from)) {
        if (m.type !== 'question' || answered.has(m.id)) continue
        answered.add(m.id)
        cards.push(m)
        const lab = m.questions?.[0]?.options?.find((o) => String(o.label).startsWith(label))?.label ?? label
        answerCard(m, lab)
      }
      if (received.slice(from).some((m) => m.type === 'turn' && m.running === false)) {
        return { ok: true, cards }
      }
      await sleep(200)
    }
    return { ok: false, cards }
  }
  const blocksOf = (from) => received.slice(from).filter((m) => m.type === 'block')
  const parseResult = (block) => {
    const raw = block?.detail?.result
    if (typeof raw !== 'string') return raw ?? null
    try { return JSON.parse(raw) } catch { return null }
  }

  const finish = () => {
    cleanup()
    const fails = checks.filter((c) => !c.ok)
    console.log(`=== PASS ${checks.length - fails.length} · FAIL ${fails.length} ===`)
    for (const f of fails) console.log(`  FAIL ${f.name} —— ${f.detail}`)
    process.exit(fails.length === 0 ? 0 : 1)
  }

  return {
    check, send, received, waitForNew, settleTurn, lastByKey, blocksOf, parseResult,
    tailLog, lastMatch, finish, agent: AGENT, dataDir: DATA,
  }
}
