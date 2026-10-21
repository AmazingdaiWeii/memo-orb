/**
 * 文件工具三级策略 + 审批确认卡的**端到端**验收（真球 + 真 Electron + 真模型）。
 *
 *   node probe/approval-gui-local.mjs
 *
 * ★ 2026-10-20 按 P2 语义重写。旧版验的是「list_dir / 新建写都要弹卡」——那是 P2
 *   之前的规矩，现在已经是 **读全盘免审批、白名单内新建免问、白名单外与覆盖已存在
 *   文件才弹卡**（`src/policy.mjs` 的 writeVerdict）。旧断言在新代码下必然 FAIL，
 *   且 FAIL 的原因是「没弹卡」而不是「坏了」。
 *
 * 现在验的五件事（顺序即执行顺序）：
 *   A. read_file 读仓库里的 package.json → **不弹卡**、工具成功、正文说出 name
 *   B. 白名单内新建 workspace/note-auto.txt → **不弹卡**、文件真被创建
 *   C. 白名单外写 outside/note-denied.txt → 弹卡 → 点「拒绝」→ 文件不许出现
 *   D. 白名单外写 outside/note-allowed.txt → 弹卡 → 点「允许」→ 文件真被创建
 *   E. 覆盖白名单内已存在的 note-overwrite.txt → 弹卡（不可逆）→ 允许 → 内容被换掉
 *
 * 沙箱：`_sandbox-data-apr/` + 一次性 agentId；config.json 改完会恢复。
 * 固定端口 25972（避开 a7 的 25971）。
 */
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CFG = join(ROOT, 'config.json')
const LOG = join(ROOT, 'logs', 'orb.log')
const SOCK_PORT = 25972
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const AGENT = `orb-apr-test-${STAMP}`
const DATA = join(ROOT, '_sandbox-data-apr')
const WS = join(DATA, 'workspace')
const OUT = join(DATA, 'outside')
const BAK = join(ROOT, 'bak', `config.apr-${STAMP}.json`)

const original = readFileSync(CFG, 'utf8')
const originalLog = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
mkdirSync(dirname(BAK), { recursive: true })
writeFileSync(BAK, original, 'utf8')

// 沙箱复位：策略回到缺省（白名单只有 <dataRoot>\workspace），产物清空
for (const p of ['policy.json', 'wechat.json', 'schedule.json']) {
  try { unlinkSync(join(DATA, p)) } catch { /* 本来没有 */ }
}
rmSync(WS, { recursive: true, force: true })
rmSync(OUT, { recursive: true, force: true })
mkdirSync(WS, { recursive: true })
mkdirSync(OUT, { recursive: true })
const overwriteFile = join(WS, 'note-overwrite.txt')
writeFileSync(overwriteFile, 'old-content\n', 'utf8')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` —— ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  ORB_ELECTRON_FLAGS: '--no-sandbox --disable-gpu',
  ORB_TRACE: '1',
  ORB_SOCKET_PORT: String(SOCK_PORT),
  ORB_DATA: DATA,
  ORB_SELFTEST: '',
})) if (v !== undefined) env[k] = v

const orb = spawn(process.execPath, [join(ROOT, 'src', 'launch.mjs')], {
  cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'],
})
let orbOut = ''
orb.stdout?.on('data', (d) => { orbOut += d })
orb.stderr?.on('data', (d) => { orbOut += d })

let sock = null
const restoreConfig = () => {
  try {
    writeFileSync(CFG, original, 'utf8')
    return true
  } catch (e) {
    console.log(`!! config.json 恢复失败，请手工从 ${BAK} 拷回：${e.message}`)
    return false
  }
}
let cleaned = false
const cleanup = () => {
  if (cleaned) return
  cleaned = true
  try { sock?.destroy() } catch { /* 已断 */ }
  try { orb.kill() } catch { /* 已退出 */ }
  if (restoreConfig()) console.log('>>> config.json 已恢复')
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
  await sleep(1000)
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
check('socket 端口就是指定的那个（不是上次残留的日志）', sockInfo.port === SOCK_PORT, `127.0.0.1:${sockInfo.port}`)

// ---------------------------------------------------------------- 等真球
let realBallUp = null
for (let i = 0; i < 90 && !realBallUp; i += 1) {
  await sleep(1000)
  realBallUp = lastMatch(/球鉴权通过/)
}
check('真球（helper）连上 Host', Boolean(realBallUp))
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

const waitForNew = async (from, pred, ms) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const hit = received.slice(from).find(pred)
    if (hit) return hit
    await sleep(200)
  }
  return null
}
const send = (obj) => sock.write(`${JSON.stringify(obj)}\n`)
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

/**
 * 等回合收口，期间把本回合新冒出来的卡全部按同一口径答掉。
 * 上限 5 张：真出现无限重试说明「被拒别重试」没传达到位，那本身就是要报的问题。
 */
const settleTurn = async (from, label, ms, alreadyAnswered = []) => {
  const deadline = Date.now() + ms
  const answered = new Set(alreadyAnswered)
  const cards = []
  let capped = false
  while (Date.now() < deadline) {
    for (const m of received.slice(from)) {
      if (m.type !== 'question' || answered.has(m.id)) continue
      if (cards.length >= 5) { capped = true; continue }
      answered.add(m.id)
      cards.push(m)
      const lab = m.questions?.[0]?.options?.find((o) => String(o.label).startsWith(label))?.label ?? label
      answerCard(m, lab)
    }
    if (received.slice(from).some((m) => m.type === 'turn' && m.running === false)) {
      return { ok: true, cards, capped }
    }
    await sleep(200)
  }
  return { ok: false, cards, capped }
}

const blocksOf = (from) => received.slice(from).filter((m) => m.type === 'block')
const textOf = (from) =>
  blocksOf(from).filter((b) => b.kind === 'assistant').map((b) => b.text ?? '').join('')

// ---------------------------------------------------------------- A：读全盘免审批
console.log('\n[A] 她要 read_file 读 package.json → 不该弹卡')
const a0 = received.length
const tA = Date.now()
send({ type: 'prompt', text: '用 read_file 读一下 E:\\Memo orb\\package.json，告诉我里面的 name 字段是什么。' })
const turnA = await settleTurn(a0, '允许', 180_000)
check('A 回合正常收口', turnA.ok, turnA.ok ? `全程 ${Date.now() - tA}ms` : '180 秒内没有 turn=false')
check('A 读文件没有弹确认卡（读全盘免审批）', turnA.cards.length === 0,
  turnA.cards.length ? `不该出现的卡：${turnA.cards.map((c) => c.id).join(', ')}` : '零张卡')
{
  const toolA = lastByKey(blocksOf(a0).filter((b) => b.kind === 'tool'))
  // 球侧 detail.result 是「字符串化的工具回执」，直接对原文用 /"name"/ 会被转义引号（\"name\"）骗过，
  // 必须先 parse 再看 text 字段 —— 这是探针自己的坑，不是代码问题。
  const parsedA = toolA.map((b) => {
    const raw = b.detail?.result
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return null }
  })
  const okRead = parsedA.some((r) => r && r.ok === true && /"name"/.test(String(r.text ?? '')))
  check('A 工具结果落成块且是成功（同 key、running=false）',
    toolA.length > 0 && toolA.every((b) => b.running === false) && okRead,
    toolA.length
      ? `${toolA.length} 块 running=${toolA.map((b) => b.running).join(',')} okRead=${okRead}`
      : '没有 tool 块')
  const textA = textOf(a0)
  check('A 正文里有回复', textA.trim().length > 0, textA.trim().replace(/\n/g, ' ').slice(0, 120))
}

// ---------------------------------------------------------------- B：白名单内新建免问
console.log('\n[B] 她在白名单内新建文件 → 不该弹卡 → 文件真出现')
const autoFile = join(WS, 'note-auto.txt')
const b0 = received.length
const tB = Date.now()
send({ type: 'prompt', text: '在工作区里新建一个文件，路径就用 note-auto.txt，内容写 hello。用 write_file 直接写。' })
const turnB = await settleTurn(b0, '允许', 180_000)
check('B 回合正常收口', turnB.ok, turnB.ok ? `全程 ${Date.now() - tB}ms` : '180 秒内没有 turn=false')
check('B 白名单内新建没有弹确认卡', turnB.cards.length === 0,
  turnB.cards.length ? `不该出现的卡：${turnB.cards.map((c) => c.id).join(', ')}` : '零张卡')
check('B 文件真被创建（内容 hello）', existsSync(autoFile) && /hello/i.test(readFileSync(autoFile, 'utf8')),
  existsSync(autoFile) ? readFileSync(autoFile, 'utf8').slice(0, 40) : `${autoFile} 不存在`)

// ---------------------------------------------------------------- C：白名单外 + 拒绝
console.log('\n[C] 她往白名单外写 → 弹卡 → 点「拒绝」→ 文件不许出现')
const deniedFile = join(OUT, 'note-denied.txt')
const c0 = received.length
const tC = Date.now()
send({
  type: 'prompt',
  text: '把内容 hello 写进 E:\\Memo orb\\_sandbox-data-apr\\outside\\note-denied.txt，用 write_file，路径就给这个绝对路径。这是我要的，直接做。',
})
const cardC = await waitForNew(c0, (m) => m.type === 'question', 120_000)
check('C 真的发出了确认卡（白名单外必须问）', Boolean(cardC),
  cardC ? `${Date.now() - tC}ms id=${cardC.id}` : '120 秒内没有 question')
let textC = ''
if (cardC) {
  const q = cardC.questions?.[0]
  check('C 卡片字段齐全（header/question/detail/options）',
    Boolean(q?.header && q?.question && q?.detail && Array.isArray(q?.options) && q.options.length >= 2),
    q ? `${q.header}｜${q.question}` : '')
  check('C 卡片写明了为什么问（白名单外）', /白名单外|外面/.test(String(q?.detail ?? '') + String(q?.question ?? '')),
    String(q?.detail ?? '').slice(0, 80))
  const denyLabel = q?.options?.find((o) => String(o.label).startsWith('拒绝'))?.label
  check('C 有「拒绝」选项', Boolean(denyLabel), denyLabel)
  const stillRunning = received.slice(c0).some((m) => m.type === 'turn' && m.running === true) &&
    !received.slice(c0).some((m) => m.type === 'turn' && m.running === false)
  check('C 等确认期间回合没有提前收口', stillRunning)
  answerCard(cardC, denyLabel ?? '拒绝')
  const cleared = await waitForNew(c0, (m) => m.type === 'question-clear' && m.id === cardC.id, 30_000)
  check('C 回答后 host 收走了卡片（question-clear）', Boolean(cleared))
  const turnC = await settleTurn(c0, '拒绝', 180_000, [cardC.id])
  check('C 拒绝后回合仍然收口（拒绝不是挂起）', turnC.ok,
    turnC.ok ? `全程 ${Date.now() - tC}ms` : '180 秒内没有 turn=false')
  await sleep(1200)
  textC = textOf(c0)
  const toolC = lastByKey(blocksOf(c0).filter((b) => b.kind === 'tool'))
  check('C 工具块落成「被拒」而不是成功',
    toolC.length > 0 && toolC.every((b) => b.running === false) &&
      /denied|拒绝|没放行|不执行/.test(toolC.map((b) => String(b.detail?.result ?? '')).join(' ')),
    toolC.map((b) => String(b.detail?.result ?? '').slice(0, 60)).join(' ｜ ') || '没有 tool 块')
  check('C 她在正文里承认被拦了（不是假装写成功）',
    /拒|拦|不让|没写|没有写|不批|没同意|不给你/.test(textC),
    textC.trim().replace(/\n/g, ' ').slice(0, 140))
}
check('C 被拒绝后文件不许出现', !existsSync(deniedFile), deniedFile)

// ---------------------------------------------------------------- D：白名单外 + 允许
console.log('\n[D] 她往白名单外写 → 弹卡 → 点「允许」→ 文件真出现')
const allowedFile = join(OUT, 'note-allowed.txt')
const d0 = received.length
const tD = Date.now()
send({
  type: 'prompt',
  text: '把内容 allowed-hello 写进 E:\\Memo orb\\_sandbox-data-apr\\outside\\note-allowed.txt，用 write_file，路径就给这个绝对路径。这是我要的，直接做。',
})
const cardD = await waitForNew(d0, (m) => m.type === 'question', 120_000)
check('D 也发出了确认卡', Boolean(cardD),
  cardD ? `${Date.now() - tD}ms id=${cardD.id}` : '120 秒内没有 question')
if (cardD) {
  const q = cardD.questions?.[0]
  const allowLabel = q?.options?.find((o) => String(o.label).startsWith('允许'))?.label
  check('D 有「允许」选项', Boolean(allowLabel), allowLabel)
  answerCard(cardD, allowLabel ?? '允许')
  const turnD = await settleTurn(d0, '允许', 180_000, [cardD.id])
  check('D 允许后回合正常收口', turnD.ok,
    turnD.ok ? `全程 ${Date.now() - tD}ms` : '180 秒内没有 turn=false')
  if (turnD.cards.length > 0) {
    check('D 回合内重试触发的后续卡也都被答掉（没有卡在半路）', !turnD.capped,
      turnD.cards.map((c) => c.id).join(', '))
  }
  await sleep(1200)
  check('D 放行后文件真被创建（内容 allowed-hello）',
    existsSync(allowedFile) && /allowed-hello/.test(readFileSync(allowedFile, 'utf8')),
    existsSync(allowedFile) ? readFileSync(allowedFile, 'utf8').slice(0, 40) : `${allowedFile} 不存在`)
}

// ---------------------------------------------------------------- E：覆盖已存在文件
console.log('\n[E] 她覆盖白名单内已存在文件 → 必须问（不可逆）→ 允许 → 内容换掉')
const e0 = received.length
const tE = Date.now()
send({
  type: 'prompt',
  text: '用 write_file 把工作区里的 note-overwrite.txt 整个覆盖成 new-content。这个文件已经存在，直接覆盖，内容只写 new-content。',
})
const cardE = await waitForNew(e0, (m) => m.type === 'question', 120_000)
check('E 覆盖已存在文件时弹了卡', Boolean(cardE),
  cardE ? `${Date.now() - tE}ms id=${cardE.id}` : '120 秒内没有 question（覆盖居然免问，是回归）')
if (cardE) {
  const q = cardE.questions?.[0]
  check('E 卡片写明是「覆盖/不可逆」', /覆盖|不可逆/.test(String(q?.detail ?? '') + String(q?.question ?? '')),
    String(q?.detail ?? '').slice(0, 80))
  const allowLabel = q?.options?.find((o) => String(o.label).startsWith('允许'))?.label
  answerCard(cardE, allowLabel ?? '允许')
  const turnE = await settleTurn(e0, '允许', 180_000, [cardE.id])
  check('E 回合正常收口', turnE.ok, turnE.ok ? `全程 ${Date.now() - tE}ms` : '180 秒内没有 turn=false')
  await sleep(1200)
  check('E 放行后内容真被换掉', /new-content/.test(readFileSync(overwriteFile, 'utf8')),
    readFileSync(overwriteFile, 'utf8').slice(0, 40))
}

// ---------------------------------------------------------------- 收尾证据
const logTail = tailLog()
check('日志里有审批收口记录', /\[approval\].*(允许|拒绝|放行)/.test(logTail),
  (logTail.match(/\[approval\][^\n]*/g) ?? []).slice(-2).join(' ｜ '))
check('日志里有 write_file 的 free / ask 两种口径',
  /\[brain\] write_file .*\[free\]/.test(logTail) && /\[brain\] write_file .*\[ask\]/.test(logTail),
  (logTail.match(/\[brain\] write_file[^\n]*/g) ?? []).slice(-4).join(' ｜ '))
check('没有未捕获异常', !/Uncaught|UnhandledPromiseRejection/.test(logTail),
  (logTail.match(/Uncaught[^\n]*|UnhandledPromiseRejection[^\n]*/) ?? [''])[0].slice(0, 120))
restoreConfig()
check('config.json 已恢复（agentId 回到真值）',
  JSON.parse(readFileSync(CFG, 'utf8')).agentId !== AGENT)

const failed = checks.filter((c) => !c.ok)
console.log(`\n=== PASS ${checks.length - failed.length} · FAIL ${failed.length} ===`)
for (const f of failed) console.log(`  FAIL ${f.name} —— ${f.detail}`)
if (failed.length) {
  console.log('\n--- 日志尾部 ---')
  console.log(logTail.slice(-3000) || orbOut.slice(-3000))
}
cleanup()
process.exit(failed.length ? 1 : 0)
