/**
 * 对话隐私锁 —— 流程级实测（不启 Electron、不连 Letta）。
 *
 * 跑法：node probe/lock-flow-test.mjs
 * 退出码非 0 = 有断言没过。
 *
 * 这一层验的是「状态层接上流程之后行为对不对」，重点：
 *   1. 锁定态推给球的历史条目：**title 必须是空串**（不能把内容漏给旁边的人）；
 *   2. 打开会话的闸门**必须在任何状态改动之前**拦下（不能先清屏再拦）；
 *   3. 5 轮全失败 → 主动解锁 + 道德警告，且**磁盘一个字节都没变**；
 *   4. 软锁与强锁叠加时，先软后强（方案 §5「双重遮罩」）。
 */

import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLockStore, SOFT_MAX_ATTEMPTS, STRONG_MAX_ATTEMPTS } from '../src/lock.mjs'
import { createLockFlow } from '../src/lock-flow.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = join(HERE, 'lock-flow-test.json')

let pass = 0
let fail = 0
const failures = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)

rmSync(FILE, { force: true })

// ────────────────────────────────── 假球：收 host 发来的每一条消息

const outbox = []
const send = (obj) => outbox.push(obj)
/**
 * 最近一条「校验反馈」。
 * ⚠️ 刻意不是 outbox 末条：解锁成功时 host 会连发三条
 * （lock-feedback → lock/unlocked → 历史刷新），
 * 取末条会拿到 history-refresh，断言的就完全不是要验的东西了（踩过一次）。
 */
const last = () => [...outbox].reverse().find((m) => m.type === 'lock-feedback')
const drain = () => (outbox.length = 0)
const ofType = (t) => outbox.filter((m) => m.type === t)

const CONV = 'local-conv-65'
const CONV_B = 'local-conv-38'

/** 假的磁盘回读：约定消息就躺在 CONV 里的某条 assistant 消息上。 */
const AGREEMENT_TEXT = '好呀，那我们的暗号就是「小饼干」，我记住啦。'
const FAKE_BLOCKS = {
  [CONV]: {
    blocks: [
      { key: `${CONV}|u:1`, kind: 'user', text: '我们约个暗号吧' },
      { key: `${CONV}|a:ui-msg-4:assistant:1`, kind: 'assistant', text: AGREEMENT_TEXT },
    ],
  },
}

let openedCalls = []
const lock = createLockStore({ path: FILE, log: () => {} })
const flow = createLockFlow({
  lock,
  send,
  refreshHistory: () => send({ type: 'history-refresh' }),
  openConversation: async (id, opts) => { openedCalls.push({ id, opts }) },
  readConversationBlocks: (id) => FAKE_BLOCKS[id] ?? null,
  log: () => {},
})

// ────────────────────────────────── 未锁时：一切照旧

section('未锁时：不打扰')

ok('未锁时 gateOpen 放行', flow.gateOpen(CONV) === false)
ok('未锁时不动 outbox', outbox.length === 0)
const plain = [{ sessionId: CONV, title: '今天天气不错', updatedAt: '2026-10-07' }]
ok('未锁时历史条目原样透传', flow.maskHistory(plain)[0].title === '今天天气不错',
  JSON.stringify(flow.maskHistory(plain)))

// ────────────────────────────────── 软锁生效

section('软锁生效：遮罩 + 闸门')

flow.engageNow()
ok('推了 lock/locked', ofType('lock').some((m) => m.state === 'locked' && m.kind === 'soft'))
ok('顺手刷了一次历史', ofType('history-refresh').length === 1)

const masked = flow.maskHistory([{ sessionId: CONV, title: '今天天气不错', updatedAt: 'x' }])
ok('锁定态条目带 locked:true', masked[0].locked === true)
ok('★ 锁定态 title 被抹成空串', masked[0].title === '', JSON.stringify(masked[0]))
ok('锁定态 kind=soft', masked[0].kind === 'soft')

drain()
ok('软锁下 gateOpen 拦下', flow.gateOpen(CONV_B) === true)
ok('拦下时推的是软锁卡', ofType('lock').some((m) => m.kind === 'soft' && m.state === 'locked'))

// ────────────────────────────────── 软锁：答错 / 答对

section('软锁：对暗号')

drain()
flow.handleBallMessage({ type: 'unlock', input: '大饼干' })
ok('答错返回 feedback.ok=false', last().type === 'lock-feedback' && last().ok === false)
ok(`答错后还剩 ${SOFT_MAX_ATTEMPTS - 1} 轮`, last().attemptsLeft === SOFT_MAX_ATTEMPTS - 1,
  `left=${last().attemptsLeft}`)
ok('答错不解锁', flow.locked === true)

drain()
flow.handleBallMessage({ type: 'unlock', input: '小饼干' })
ok('还没约定过暗号 → 判失败，绝不误放行', last().ok === false && flow.locked === true,
  JSON.stringify(last()))

// 约定一次暗号：指针钉到磁盘上的 ui-msg-4（见 FAKE_BLOCKS 的 a:ui-msg-4:assistant:1）
lock.setAgreement({ convId: CONV, messageId: 'ui-msg-4' })

drain()
flow.handleBallMessage({ type: 'unlock', input: ' 小 饼 干 ' }) // 带空格，验归一化
ok('答对后推 unlocked', ofType('lock').some((m) => m.state === 'unlocked'))
ok('答对后软锁解除', flow.locked === false)
ok('解锁后自动补开之前被拦的会话', openedCalls.length === 1 && openedCalls[0]?.id === CONV_B,
  JSON.stringify(openedCalls))
ok('补开时带 force（否则会被自己拦下死循环）', openedCalls[0]?.opts?.force === true)

// ────────────────────────────────── 软锁：5 轮全失败零副作用

section('软锁：5 轮全失败（零副作用）')

openedCalls = []
flow.engageNow()
drain()

const beforeRaw = readFileSync(FILE, 'utf8')
const beforeMtime = statSync(FILE).mtimeMs

for (let i = 1; i <= SOFT_MAX_ATTEMPTS; i++) {
  drain()
  flow.handleBallMessage({ type: 'unlock', input: '瞎猜' })
}
const final = last()
ok('第 5 轮给出道德警告', typeof final.message === 'string' && final.message.includes('诚实'),
  final.message)
ok('第 5 轮 attemptsLeft=0', final.attemptsLeft === 0)
ok('第 5 轮后主动解开（不锁死）', flow.locked === false)
ok('★ 5 轮失败后磁盘内容一字未变', readFileSync(FILE, 'utf8') === beforeRaw)
ok('★ 5 轮失败后文件未被写（mtime 不变）', statSync(FILE).mtimeMs === beforeMtime)
ok('★ 磁盘上无「疑似非本人」类标记', !/疑|非本人|不通过|suspect|attempt/i.test(beforeRaw))

drain()
flow.engageNow()
ok('★ 下一次锁定是全新开始（轮数回到满）', flow.status().softAttemptsLeft === SOFT_MAX_ATTEMPTS,
  `left=${flow.status().softAttemptsLeft}`)

// ────────────────────────────────── 强锁

section('强锁：密码 + 冷却')

lock.setStrongPassword('主密码-ABC')
lock.lockConversation(CONV_B)
flow.engageNow()
flow.handleBallMessage({ type: 'unlock', input: '小饼干' }) // 先解软锁
ok('软锁已解', flow.locked === false)

drain()
ok('挂了强锁的对话被拦', flow.gateOpen(CONV_B) === true)
ok('拦下时推的是强锁卡', ofType('lock').some((m) => m.kind === 'strong' && m.convId === CONV_B))

drain()
flow.handleBallMessage({ type: 'unlock', input: '错的密码', convId: CONV_B })
ok('密码错：ok=false', last().ok === false)
ok('密码错：提示还能试几次', /还能试/.test(last().message), last().message)
ok('密码错：不放行', openedCalls.length === 0)

drain()
flow.handleBallMessage({ type: 'unlock', input: '主密码-ABC', convId: CONV_B })
ok('密码对：ok=true', last().ok === true)
ok('密码对：直接打开该对话', openedCalls.length === 1 && openedCalls[0].id === CONV_B)
ok('密码对：同样带 force', openedCalls[0].opts?.force === true)

// 连续输错到冷却
for (let i = 0; i < STRONG_MAX_ATTEMPTS; i++) {
  drain()
  flow.handleBallMessage({ type: 'unlock', input: '再错', convId: CONV_B })
}
drain()
flow.handleBallMessage({ type: 'unlock', input: '主密码-ABC', convId: CONV_B })
ok('冷却期内正确密码也不放行', last().ok === false && /等 \d+ 分钟/.test(last().message),
  last().message)

lock.clearStrongFailures(CONV_B)
drain()
flow.handleBallMessage({ type: 'unlock', input: '主密码-ABC', convId: CONV_B })
ok('冷却清掉后正确密码可放行', last().ok === true)

// ────────────────────────────────── 双重遮罩顺序

section('双重遮罩：先软后强（方案 §5）')

lock.lockConversation(CONV_B)
flow.engageNow()   // 软锁 + CONV_B 挂强锁
drain()
flow.gateOpen(CONV_B)
ok('两层都锁时，先出软锁卡', ofType('lock')[0].kind === 'soft', JSON.stringify(ofType('lock')))

drain()
flow.handleBallMessage({ type: 'unlock', input: '小饼干' })
ok('软锁解开后补开的是 CONV_B', openedCalls[openedCalls.length - 1].id === CONV_B)
ok('软锁解开不等于绕过强锁（强锁清单没被动）', lock.isConvLocked(CONV_B) === true)

// ────────────────────────────────── 对话内意图

section('对话内意图：取消 / 约定暗号')

lock.setAgreement({ convId: CONV, messageId: 'ui-msg-4' })
ok('前置：指针已写入', lock.hasAgreement())

drain()
const r1 = flow.noteUserIntent('取消暗号吧，不想每次对了')
ok('识别出取消意图', r1 === 'cancel')
ok('指针被清空', !lock.hasAgreement())
ok('推了 soft-agreement/none 给球', ofType('soft-agreement').some((m) => m.state === 'none'))

const r2 = flow.noteUserIntent('我们约个暗号吧')
ok('识别出约定意图', r2 === 'agree')

drain()
const pinned = flow.pinAgreement(`${CONV}|a:ui-msg-9:assistant:1`)
ok('回合收尾把指针钉上', pinned === true)
ok('钉的是 convId', lock.getAgreement()?.convId === CONV, JSON.stringify(lock.getAgreement()))
ok('钉的是 messageId', lock.getAgreement()?.messageId === 'ui-msg-9', JSON.stringify(lock.getAgreement()))

ok('钉过一次之后不会重复钉', flow.pinAgreement(`${CONV}|a:ui-msg-10:assistant:1`) === false)

// 指针没命中时：判失败，不做「整段对话兜底」
section('指针失效：判失败，不做整段兜底')

drain()
flow.engageNow()
flow.handleBallMessage({ type: 'unlock', input: '小饼干' })   // 指针指向 ui-msg-9，磁盘里没有
ok('指针没命中 → 判失败', last().ok === false, JSON.stringify(last()))
ok('★ 没有回退成「整段对话比对」而误放行', flow.locked === true)

// ────────────────────────────────── 坏输入不崩

section('坏输入不崩')

let threw = null
try {
  flow.handleBallMessage({ type: 'unlock' })
  flow.handleBallMessage({ type: 'unlock', input: null, convId: 123 })
  flow.handleBallMessage({ type: '不知道什么类型' })
  flow.maskHistory(null)
  flow.maskHistory('不是数组')
  flow.noteUserIntent(undefined)
  flow.pinAgreement(null)
} catch (err) { threw = err }
ok('畸形消息不抛异常', threw === null, threw?.message)

// ────────────────────────────────── 超时锁：没有暗号可对就绝不上锁

section('超时锁：没有暗号可对时不上锁（方案 §8 默认 softEnabled=false）')

process.env.ORB_LOCK_TICK_MS = '120'
process.env.ORB_LOCK_IDLE_MIN = '0.001'   // 60ms，把 30 分钟压到秒级

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const idleLogs = []
const mkIdleFlow = (out) => createLockFlow({
  lock,
  send: (m) => out.push(m),
  refreshHistory: () => out.push({ type: 'history-refresh' }),
  openConversation: async () => {},
  readConversationBlocks: () => null,
  log: (m) => idleLogs.push(m),
})

// ① 软锁未启用（就是方案 §8 的出厂默认值）
lock.updateSettings({ softEnabled: false, idleTimeoutMin: 0.001 })
lock.clearAgreement()
const idleA = []
const fA = mkIdleFlow(idleA)
fA.startIdleWatch()
await sleep(500)
ok('★ 软锁未启用：闲置再久也不上锁（出厂默认值下不惊吓用户）',
  fA.locked === false && !idleA.some((m) => m.type === 'lock'),
  JSON.stringify(idleA.filter((m) => m.type === 'lock')))
ok('日志明说「未布防」', idleLogs.some((m) => /未布防/.test(m) && /软锁未启用/.test(m)),
  JSON.stringify(idleLogs))

// ② 启用了软锁，但用户还没走约定仪式 —— 最危险的一档：有锁无暗号
lock.updateSettings({ softEnabled: true })
lock.clearAgreement()
const idleB = []
const fB = mkIdleFlow(idleB)
fB.startIdleWatch()
await sleep(500)
ok('★★ 软锁已启用但尚无暗号：仍然不上锁（否则用户连错 5 轮挨道德警告）',
  fB.locked === false && !idleB.some((m) => m.type === 'lock'),
  JSON.stringify(idleB.filter((m) => m.type === 'lock')))
ok('日志把原因写成「尚未约定暗号」',
  idleLogs.some((m) => /未布防/.test(m) && /尚未约定暗号/.test(m)), JSON.stringify(idleLogs))

// ③ 已启用 + 已约定 → 该锁必须真的锁上（别为了防误伤把功能关死）
lock.setAgreement({ convId: CONV, messageId: 'ui-msg-4' })
const idleC = []
const fC = mkIdleFlow(idleC)
fC.startIdleWatch()
await sleep(600)
ok('★★ 启用且已约定 → 闲置到点确实上锁', fC.locked === true
  && idleC.some((m) => m.type === 'lock' && m.state === 'locked' && m.kind === 'soft'),
  JSON.stringify(idleC.filter((m) => m.type === 'lock')))
ok('布防日志带上真实分钟数', idleLogs.some((m) => /闲置锁已布防/.test(m)), JSON.stringify(idleLogs))
ok('上锁时顺手刷新历史（列表立刻转遮罩）', idleC.some((m) => m.type === 'history-refresh'))

// ④ 用户取消暗号 → 超时锁随之关闭，不该再主动上锁
lock.clearAgreement()
const idleD = []
const fD = mkIdleFlow(idleD)
fD.startIdleWatch()
await sleep(500)
ok('★ 取消暗号后不再上锁（方案 §4.4「超时锁定随之关闭」）',
  fD.locked === false && !idleD.some((m) => m.type === 'lock'),
  JSON.stringify(idleD.filter((m) => m.type === 'lock')))

delete process.env.ORB_LOCK_TICK_MS
delete process.env.ORB_LOCK_IDLE_MIN

// ────────────────────────────────── 收尾

rmSync(FILE, { force: true })

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail > 0) { console.log('未过项：'); for (const f of failures) console.log(`  - ${f}`) }
console.log('='.repeat(46))
process.exit(fail === 0 ? 0 : 1)
