/**
 * probe/schedule-unit.mjs · 定时提醒自检（无头、真文件、无网络、不等真实 30 秒）
 *
 * 验的是什么（P3 硬要求）：
 *   1. **时间解析只认写得清的**：`+30m` / `21:30` / `10-21 09:00` / ISO 能解析；
 *      `明天早上` 必须**报错**——猜一次就是半夜响铃，宁可让她改口重说。
 *   2. **到点由宿主说话，不跑模型**：`takeDue` 只把到点的捞出来并**先写 firedAt**；
 *      重启之后不能再响一遍（重复骚扰比漏一句更糟）。
 *   3. **迟到分档**：1 分钟内不算迟到；2 小时算迟到但照说；超过 6 小时只记账不打扰。
 *   4. **落盘可靠**：原子写、坏文件改名留证据、手工改 json 立即生效（每次操作重读盘）。
 *   5. **工具面对得住**：`set_reminder` 原样存 `what`（到点播的就是这句）、
 *      `list_reminders` 能查、`cancel_reminder` 认前缀、排完的 when 说得清。
 *   6. **每轮带时钟**：用户消息尾部有「（现在是 …）」，否则她排提醒只能靠猜。
 *
 * 跑法：`node probe\schedule-unit.mjs`
 * 沙箱：`_sandbox-schedule/`（每次跑前清空，不碰真实 data/）
 */

import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SANDBOX = join(ROOT, '_sandbox-schedule')
const AGENT = 'schedule-probe'

// ★ 必须在 import src/* 之前设：memory.mjs / session.mjs 都按 env 算数据根
process.env.ORB_DATA = SANDBOX

rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(SANDBOX, { recursive: true })

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function throws(fn) {
  try {
    fn()
    return null
  } catch (err) {
    return err.message
  }
}

const {
  parseWhen, describeWhen, describeClock, describeNow,
  createScheduleStore, startReminderTicker,
  SCHEDULE_VERSION, MAX_PENDING, MAX_TEXT_CHARS,
} = await import('../src/schedule.mjs')

// 固定「现在」：2026-10-19 21:00:00 本机时间。
// 用固定值而不是 Date.now()，是因为「20:00 要滚到明天」这类断言在真时间下会半夜翻脸。
const NOW = new Date(2026, 9, 19, 21, 0, 0, 0).getTime()
const HOUR = 3600_000

// ── 1. parseWhen ─────────────────────────────────────────
check('+30m 解析为半小时后', parseWhen('+30m', { now: NOW }).getTime() === NOW + 30 * 60_000)
check('+2h 解析为两小时后', parseWhen('+2h', { now: NOW }).getTime() === NOW + 2 * HOUR)
check('+3天（中文单位）也认', parseWhen('+3天', { now: NOW }).getTime() === NOW + 3 * 24 * HOUR)
const hmToday = parseWhen('21:30', { now: NOW })
check('21:30 落在今天（还没到）', hmToday.getDate() === 19 && hmToday.getHours() === 21 && hmToday.getMinutes() === 30, hmToday.toString())
const hmPast = parseWhen('20:00', { now: NOW })
check('20:00 已经过了 → 滚到明天', hmPast.getDate() === 20 && hmPast.getHours() === 20, hmPast.toString())
// 正好等于现在这一刻的 "21:00" 不该被推到明天（留了 60 秒余量）
check('正好等于现在 → 不动', parseWhen('21:00', { now: NOW }).getDate() === 19)
const md = parseWhen('10-21 09:00', { now: NOW })
check('10-21 09:00 → 今年 10 月 21 日', md.getFullYear() === 2026 && md.getMonth() === 9 && md.getDate() === 21 && md.getHours() === 9, md.toString())
const mdRoll = parseWhen('10-01 09:00', { now: NOW })
check('过去的日子（10-01）→ 滚到明年', mdRoll.getFullYear() === 2027, mdRoll.toString())
const ymd = parseWhen('2026-12-01 07:05', { now: NOW })
check('YYYY-MM-DD HH:mm 精确解析', ymd.getTime() === new Date(2026, 11, 1, 7, 5, 0, 0).getTime(), ymd.toString())
const iso = parseWhen('2026-10-19T13:00:00Z', { now: NOW })
check('带时区 ISO 交给 Date（不自己算）', iso.getTime() === Date.parse('2026-10-19T13:00:00Z'), iso.toISOString())

const vague = throws(() => parseWhen('明天早上', { now: NOW }))
check('「明天早上」必须报错（不许猜）', Boolean(vague) && /看不懂这个时间/.test(vague), vague ?? '(没报错)')
check('报错里带正确写法', Boolean(vague) && /21:30/.test(vague) && /\+30m/.test(vague))
check('空 when 报错', Boolean(throws(() => parseWhen('  ', { now: NOW }))))

// ── 2. 人话描述 ───────────────────────────────────────────
check('describeWhen 今天', describeWhen(new Date(2026, 9, 19, 21, 30), { now: NOW }) === '今天 21:30')
check('describeWhen 明天', describeWhen(new Date(2026, 9, 20, 8, 0), { now: NOW }) === '明天 08:00')
check('describeWhen 昨天', describeWhen(new Date(2026, 9, 18, 8, 0), { now: NOW }) === '昨天 08:00')
check('describeWhen 远日子带星期', /^12月1日 07:05（周[日一二三四五六]）$/.test(describeWhen(new Date(2026, 11, 1, 7, 5), { now: NOW })), describeWhen(new Date(2026, 11, 1, 7, 5), { now: NOW }))
check('describeClock 整点', describeClock(new Date(2026, 9, 19, 9, 0)) === '9 点')
check('describeClock 带分钟补零', describeClock(new Date(2026, 9, 19, 9, 5)) === '9 点 05 分')
check('describeNow 形状', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}（周[日一二三四五六]）$/.test(describeNow(NOW)), describeNow(NOW))

// ── 3. 提醒仓 ───────────────────────────────────────────
const logs = []
const log = (m) => { logs.push(String(m)) }
const store = createScheduleStore({ dataRoot: SANDBOX, log, now: () => NOW })
const file = join(SANDBOX, 'schedule.json')

check('构造即落空库（用户能直接打开看）', existsSync(file))
const fresh = JSON.parse(readFileSync(file, 'utf8'))
check('空库形状 version=1 / items=[]', fresh.version === SCHEDULE_VERSION && Array.isArray(fresh.items) && fresh.items.length === 0, JSON.stringify(fresh))
check('空库 describe 说得清', store.describe() === '没有排着的提醒', store.describe())

check('add 拒绝空文本', Boolean(throws(() => store.add({ when: new Date(NOW + HOUR).toISOString(), text: '   ' }))))
check('add 拒绝超过 500 字', Boolean(throws(() => store.add({ when: new Date(NOW + HOUR).toISOString(), text: 'x'.repeat(MAX_TEXT_CHARS + 1) }))))
const pastMsg = throws(() => store.add({ when: new Date(NOW - 10 * 60_000).toISOString(), text: '已经过去了' }))
check('add 拒绝过去的时间', Boolean(pastMsg) && /已经过去/.test(pastMsg), pastMsg ?? '')
check('add 拒绝一年以后', Boolean(throws(() => store.add({ when: new Date(NOW + 400 * 24 * HOUR).toISOString(), text: '太远' }))))

const r1 = store.add({ when: new Date(NOW + 30 * 60_000).toISOString(), text: '该喝水了' })
check('add 返回 id 形如 r-…', /^r-[a-z0-9]+$/.test(r1.id), r1.id)
check('add 落到盘上', JSON.parse(readFileSync(file, 'utf8')).items.length === 1)
check('没触发的 firedAt 是 null', JSON.parse(readFileSync(file, 'utf8')).items[0].firedAt === null)
const r2 = store.add({ when: new Date(NOW + 2 * HOUR).toISOString(), text: '该睡了', channel: 'wechat' })
check('channel 记住 wechat', r2.channel === 'wechat')
check('乱写的 channel 落回 all', store.add({ when: new Date(NOW + 3 * HOUR).toISOString(), text: '随便', channel: '短信' }).channel === 'all')

check('pending 按时间升序', store.pending().map((i) => i.text).slice(0, 2).join(',') === '该喝水了,该睡了', store.pending().map((i) => i.text).join(','))
check('describe 一行一条', /该喝水了/.test(store.describe()) && /该睡了/.test(store.describe()))

// takeDue：还没到 → 什么都不给
check('没到点 takeDue 给空', store.takeDue(NOW).length === 0)
// 到点
const fired = store.takeDue(NOW + 31 * 60_000)
check('到点捞出一条', fired.length === 1 && fired[0].text === '该喝水了', `${fired.length} 条`)
check('不到 1 分钟不算迟到', fired[0].late === false && fired[0].silent === false, `lateMs=${fired[0].lateMs}`)
check('at 交回 Date（工具层要格式化）', fired[0].at instanceof Date)
check('firedAt 已落盘', JSON.parse(readFileSync(file, 'utf8')).items.find((i) => i.id === r1.id)?.firedAt !== null)
check('再取一次不会重复（重启也不重复）', store.takeDue(NOW + 40 * 60_000).length === 0)

// 迟到分档
const late = store.takeDue(NOW + 2 * HOUR + 10 * 60_000)
check('迟到 10 分钟算迟到但照说', late.length === 1 && late[0].text === '该睡了' && late[0].late === true && late[0].silent === false, `lateMs=${late[0]?.lateMs}`)
const r3 = store.add({ when: new Date(NOW + 4 * HOUR).toISOString(), text: '迟到太久的' })
const silent = store.takeDue(NOW + 12 * HOUR).filter((i) => i.id === r3.id)
check('迟到 >6 小时只记账不打扰', silent.length === 1 && silent[0].silent === true, JSON.stringify({ n: silent.length, silent: silent[0]?.silent }))
check('沉默的那条也写了 note', JSON.parse(readFileSync(file, 'utf8')).items.find((i) => i.id === r3.id)?.note?.includes('只记账') === true)

// cancel
const r4 = store.add({ when: new Date(NOW + 5 * HOUR).toISOString(), text: '可以删的' })
const prefix = r4.id.slice(0, 4)
check('cancel 认唯一前缀', store.cancel(prefix).id === r4.id)
check('cancel 之后盘上没有它', !JSON.parse(readFileSync(file, 'utf8')).items.some((i) => i.id === r4.id))
const gone = throws(() => store.cancel('r-zzzzzz'))
check('cancel 不存在的 id 报错', Boolean(gone) && /没有这个 id/.test(gone), gone ?? '')
const already = throws(() => store.cancel(r1.id))
check('已说过的删不掉', Boolean(already) && /已经说过/.test(already), already ?? '')
check('cancel 空 id 报错', Boolean(throws(() => store.cancel(''))))

// 手工改盘立即生效（每次操作重读）
const manual = JSON.parse(readFileSync(file, 'utf8'))
manual.items.push({ id: 'r-manual1', at: new Date(NOW + 6 * HOUR).toISOString(), text: '手写的', channel: 'all', createdAt: new Date(NOW).toISOString(), firedAt: null, late: false })
writeFileSync(file, JSON.stringify(manual, null, 2), 'utf8')
check('手工改 json 立即生效', store.pending().some((i) => i.id === 'r-manual1'))

// 坏文件：改名留证据，不清空
writeFileSync(file, '{ 这不是 json', 'utf8')
const afterBroken = store.list()
const brokenFiles = readdirSync(SANDBOX).filter((n) => n.startsWith('schedule.json.broken-'))
check('坏文件不静默清空（当空库）', Array.isArray(afterBroken) && afterBroken.length === 0)
check('坏文件改名留了证据', brokenFiles.length === 1, brokenFiles.join(','))

// 上限
const store2 = createScheduleStore({ dataRoot: join(SANDBOX, 'cap'), log, now: () => NOW })
for (let i = 0; i < MAX_PENDING; i += 1) {
  store2.add({ when: new Date(NOW + (i + 1) * 60_000).toISOString(), text: `第 ${i + 1} 条` })
}
const capMsg = throws(() => store2.add({ when: new Date(NOW + 2 * HOUR).toISOString(), text: '第 51 条' }))
check(`排到 ${MAX_PENDING} 条就拒绝再加`, Boolean(capMsg) && /已经有 50 条/.test(capMsg), capMsg ?? '')

// ── 4. 假 LLM + 真工具循环 ───────────────────────────────
const { createBrain } = await import('../src/brain.mjs')
const { createMemoryStore } = await import('../src/memstore.mjs')
const { createSettings } = await import('../src/settings.mjs')
const { createSnapshotService, GUIDE_VERSION, buildToolGuide } = await import('../src/snapshot.mjs')
const { createSessionStore } = await import('../src/session.mjs')

const memstore = await createMemoryStore({ engine: 'local', root: ROOT, agentId: AGENT })
const settings = createSettings({ configPath: join(SANDBOX, 'config.json'), log })
const snapshot = createSnapshotService({ memstore, settings, log })
const sessionStore = createSessionStore({ agentId: AGENT })

const seen = { messages: null }
function fakeLLM(script) {
  let round = 0
  return {
    async* stream({ messages, tools }) {
      seen.messages = messages
      seen.tools = tools
      const events = script[round++] ?? [{ type: 'content', text: '（没有更多脚本了）' }]
      for (const e of events) yield e
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    },
  }
}

const brainStore = createScheduleStore({ dataRoot: join(SANDBOX, 'brain'), log, now: () => NOW })
const script = [
  [{ type: 'tool_call', id: 's1', name: 'set_reminder', args: { when: '+30m', what: '起来走两步，你坐太久了' } }],
  [{ type: 'tool_call', id: 's2', name: 'set_reminder', args: { when: '明天早上', what: '猜的时间' } }],
  [{ type: 'tool_call', id: 's3', name: 'list_reminders', args: {} }],
  [{ type: 'tool_call', id: 's4', name: 'cancel_reminder', args: { id: 'r-nope' } }],
  [{ type: 'content', text: '好，我记着了。' }],
]

const brain = createBrain({
  llm: fakeLLM(script),
  memstore,
  persona: '你是球。',
  sessionStore,
  agentId: AGENT,
  settings,
  snapshot,
  log,
  approve: async () => ({ approved: true }),
  policy: null,
  schedule: brainStore,
  now: () => NOW,
})

const names = brain.tools.map((t) => t.function?.name)
check('工具列表含三个闹钟工具', ['set_reminder', 'list_reminders', 'cancel_reminder'].every((n) => names.includes(n)), names.join(','))
check('工具总数 = 12（含 2026-10-21 新增的 bili_watch）', names.length === 12, String(names.length))

const toolResults = []
for await (const ev of brain.run({ sessionId: 'sched-probe', userText: '三十分钟后提醒我起来走两步' })) {
  if (ev.type === 'tool' && ev.phase === 'result') toolResults.push(ev)
}
const parsed = toolResults.map((r) => {
  try { return { name: r.name, json: JSON.parse(r.result) } } catch { return { name: r.name, json: { _raw: r.result } } }
})
const setOk = parsed.find((p) => p.name === 'set_reminder' && p.json.ok)
check('set_reminder 成功', Boolean(setOk), JSON.stringify(setOk?.json ?? null))
check('when 说得清（今天/明天 + 钟点）', /^(今天|明天) \d{2}:\d{2}$/.test(setOk?.json?.when ?? ''), setOk?.json?.when)
check('what 原样存（到点播的就是这句）', brainStore.pending()[0]?.text === '起来走两步，你坐太久了', brainStore.pending()[0]?.text)

const setBad = parsed.filter((p) => p.name === 'set_reminder')[1]
check('含糊时间被工具挡住（ok:false）', setBad?.json?.ok === false && /看不懂这个时间/.test(setBad?.json?.error ?? ''), JSON.stringify(setBad?.json ?? null))

const listOk = parsed.find((p) => p.name === 'list_reminders')
check('list_reminders 数得对', listOk?.json?.ok === true && listOk.json.count === brainStore.pending().length, JSON.stringify(listOk?.json ?? null))
check('list_reminders 带回 when/where', typeof listOk?.json?.items?.[0]?.when === 'string' && typeof listOk?.json?.items?.[0]?.where === 'string')

const cancelBad = parsed.find((p) => p.name === 'cancel_reminder')
check('cancel_reminder 对不存在的 id 报错而不是崩', cancelBad?.json?.ok === false, JSON.stringify(cancelBad?.json ?? null))

// 每轮时钟注入
const lastUser = [...(seen.messages ?? [])].reverse().find((m) => m.role === 'user')
const lastText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '')
check('用户消息尾部带「（现在是 …）」', /（现在是 \d{4}-\d{2}-\d{2} \d{2}:\d{2}（周[日一二三四五六]））/.test(lastText), lastText.slice(-60))
check('工具描述里写了「到点原样说出口」', /原样/.test(String(seen.tools?.find?.((t) => t.function?.name === 'set_reminder')?.function?.description ?? '')))

// 指南同步
check('GUIDE_VERSION = 8（+余额/看法自选）', GUIDE_VERSION === 8, String(GUIDE_VERSION))
const guide = buildToolGuide({ web: false })
check('指南含「时间与闹钟」一节', /## 时间与闹钟/.test(guide))
check('指南写了到点不跑模型', /宿主直接播/.test(guide))
check('指南写了不要猜时间', /唯一可信/.test(guide))

// ── 5. ticker ───────────────────────────────────────────
const tickStore = createScheduleStore({ dataRoot: join(SANDBOX, 'tick'), log, now: () => NOW })
const firedItems = []
const ticker = startReminderTicker({
  store: tickStore,
  onFire: (item) => { firedItems.push(item.text) },
  log,
  now: () => NOW,
  immediate: false,
})
check('immediate=false 时构造不投递', firedItems.length === 0)
tickStore.add({ when: new Date(NOW - 10_000).toISOString(), text: '刚刚到点的' })
await ticker.tick()
check('tick 投递到点的', firedItems.length === 1 && firedItems[0] === '刚刚到点的', firedItems.join(','))
await ticker.tick()
check('同一个 tick 不会投第二次', firedItems.length === 1)
ticker.stop()
tickStore.add({ when: new Date(NOW - 5_000).toISOString(), text: 'stop 之后到点的' })
const afterStop = await ticker.tick()
check('stop 之后 tick 不再动作', afterStop.length === 0 && firedItems.length === 1)

// ── 汇总 ────────────────────────────────────────────────
const pass = results.filter((r) => r.ok).length
const fail = results.length - pass
console.log(`\n${pass} PASS / ${fail} FAIL（共 ${results.length} 条）`)
if (fail > 0) {
  console.log('\n失败项：')
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
}
process.exit(fail > 0 ? 1 : 0)
