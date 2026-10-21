/**
 * src/lock.mjs 的模块级实测。**不启 Electron、不连 Letta**，纯跑状态层。
 *
 * 跑法：node probe/lock-test.mjs
 * 退出码非 0 = 有断言没过。
 *
 * 重点盯三件事（方案 §6 / §4.2 的硬约束，光看代码看不出来）：
 *   1. locks.json 里**永远不出现密码/暗号原文**；
 *   2. 软考验失败多次之后，**磁盘文件一个字节都不变**（零副作用）；
 *   3. 重启（重新 load）之后考验轮数重置为满，不累计。
 */

import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLockStore, softMatches, normalizeAnswer, SOFT_MAX_ATTEMPTS, STRONG_MAX_ATTEMPTS } from '../src/lock.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = join(HERE, 'lock-test.json')

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`)
  }
}

function section(t) {
  console.log(`\n── ${t} ──`)
}

const readRaw = () => (existsSync(FILE) ? readFileSync(FILE, 'utf8') : '')

rmSync(FILE, { force: true })

// ─────────────────────────────────────────────────────────── 强锁：凭证

section('强锁：scrypt 凭证')

const PASSWORD = '正确密码-XYZ-9527'
const store = createLockStore({ path: FILE, log: () => {} })

ok('初始无密码', !store.hasStrongPassword())
ok('错误密码在未设置时也返回 false', !store.verifyStrongPassword(PASSWORD))

store.setStrongPassword(PASSWORD)

ok('设置后可校验', store.hasStrongPassword())
ok('正确密码通过', store.verifyStrongPassword(PASSWORD))
ok('错误密码拒绝', !store.verifyStrongPassword('正确密码-XYZ-9528'))
ok('空串拒绝', !store.verifyStrongPassword(''))
ok('前缀不通过（不是子串匹配）', !store.verifyStrongPassword('正确密码-XYZ'))

const raw1 = readRaw()
ok('磁盘上不含密码原文', !raw1.includes(PASSWORD), raw1.slice(0, 120))
ok('磁盘上有 salt 字段', /"salt"\s*:\s*"[0-9a-f]{32}"/.test(raw1))
ok('磁盘上有哈希字段', /"passwordHash"\s*:\s*"[0-9a-f]{64}"/.test(raw1))

// 同一个密码设两次 → 哈希必须不同（随机 salt）
const hashA = JSON.parse(raw1).strong.passwordHash
store.setStrongPassword(PASSWORD)
const hashB = JSON.parse(readRaw()).strong.passwordHash
ok('同密码两次设置产出不同哈希（随机 salt 生效）', hashA !== hashB)
ok('换 salt 后原密码仍能校验', store.verifyStrongPassword(PASSWORD))

store.clearStrongPassword()
ok('清空后再校验返回 false', !store.verifyStrongPassword(PASSWORD))
ok('clear 后磁盘无残留哈希', !JSON.parse(readRaw()).strong.passwordHash)

// ─────────────────────────────────────────────────────────── 强锁：输错冷却

section('强锁：连续输错冷却')

store.setStrongPassword(PASSWORD)
let last = null
for (let i = 0; i < STRONG_MAX_ATTEMPTS; i++) last = store.noteStrongFailure()
ok('到上限后进入冷却', last.locked === true, JSON.stringify(last))
ok('冷却剩余时间 > 0', last.remainingMs > 0)
ok('冷却期间 isLocked 可读', store.strongLockoutRemaining() > 0)

store.clearStrongFailures()
ok('清空失败记录后不再冷却', store.strongLockoutRemaining() === 0)

store.setStrongPassword(PASSWORD)
ok('清空失败记录后正密码仍可通过', store.verifyStrongPassword(PASSWORD))

// ─────────────────────────────────────────────────────────── 强锁：对话清单

section('强锁：对话清单')

const CONV = 'local-conv-65'
ok('初始不在清单', !store.isConvLocked(CONV))
store.lockConversation(CONV)
ok('上锁后 isConvLocked=true', store.isConvLocked(CONV))
ok('重复上锁不叠加', store.lockConversation(CONV) === false)
ok('lockedConvIds 含该条', store.lockedConvIds.includes(CONV))
store.unlockConversation(CONV)
ok('解锁后不在清单', !store.isConvLocked(CONV))

// ─────────────────────────────────────────────────────────── 软锁：指针

section('软锁：约定指针（零凭证存储）')

const PASSPHRASE = '小饼干'
ok('初始无约定', !store.hasAgreement())
ok('缺 messageId 不写', store.setAgreement({ convId: CONV }) === false)
store.setAgreement({ convId: CONV, messageId: 'ui-msg-4' })
ok('写入后 hasAgreement=true', store.hasAgreement())
ok('指针内容正确', store.getAgreement()?.messageId === 'ui-msg-4')

const rawAgree = readRaw()
ok('磁盘上不含暗号原文', !rawAgree.includes(PASSPHRASE))
ok('磁盘上只有指针字段', /"softAgreement"[\s\S]{0,80}"messageId"/.test(rawAgree))

store.clearAgreement()
ok('清空后 hasAgreement=false', !store.hasAgreement())

// ─────────────────────────────────────────────────────────── 软锁：命中判定

section('软锁：回读比对')

// 真实的约定消息长这样（鲸鱼娘一句人话，暗号明文嵌在里面）
const AGREEMENT_TEXT = '好呀，那我们的暗号就是「小饼干」，我记住啦。下次你回来说这三个字我就认得你。'

ok('归一化去空白+小写', normalizeAnswer('  小 饼 干 ') === '小饼干')
ok('归一化对英文生效', normalizeAnswer(' AbC ') === 'abc')
ok('命中：正好是暗号', softMatches('小饼干', AGREEMENT_TEXT))
ok('命中：带空格也能过', softMatches('  小 饼 干 ', AGREEMENT_TEXT))
ok('命中：大小写无关（英文场景）', softMatches('abc', 'Agreement: ABC'))
ok('不命中：说错了', !softMatches('大饼干', AGREEMENT_TEXT))
ok('不命中：单字太短，防蒙', !softMatches('的', AGREEMENT_TEXT))
ok('不命中：空输入', !softMatches('', AGREEMENT_TEXT))
ok('不命中：空原文（指针指向的消息没读到）', !softMatches('小饼干', ''))
ok('不命中：超长输入不会误判', !softMatches('小饼干和别的东西', AGREEMENT_TEXT))

// ── 全角标点（2026-10-07 真机踩到）
// 约定消息里是半角 `?`/`,`（模型输出习惯），用户手打中文时输入法默认出全角 `？`/`，`。
// 实测「球上有几颗糖？」判 false、去问号才 true —— 差一个符号就开不了锁，
// 而界面不会提示「多了个全角符号」。标点是排版噪声不是暗号语义，两边统一折半角。
const REAL_AGREEMENT =
  '行嘞,定好了。\n\n**暗号:「球上有几颗糖?」**\n我要接的是:**「七颗。」**\n\n快去快去。'
ok('归一化：全角问号折半角', normalizeAnswer('球上有几颗糖？') === normalizeAnswer('球上有几颗糖?'))
ok('归一化：全角逗号折半角', normalizeAnswer('甲，乙') === normalizeAnswer('甲,乙'))
// 中文成对符号统一折成 <> / '' —— 目的是「全角与半角等价」，不就具体折成哪个字符
ok('归一化：中文尖括号折成 <>', normalizeAnswer('「甲」') === normalizeAnswer('《甲》'))
ok('归一化：中文引号折成 ASCII 引号', normalizeAnswer('“甲”') === normalizeAnswer("'甲'"))
ok('归一化：全角字母数字也折（Ａ１→a1）', normalizeAnswer('Ａ１') === 'a1')
ok('★ 全角问号也能开锁（真机同款）', softMatches('球上有几颗糖？', REAL_AGREEMENT))
ok('★ 半角问号同样能开锁', softMatches('球上有几颗糖?', REAL_AGREEMENT))
ok('★ 带全角书名号包裹也能开锁', softMatches('「球上有几颗糖？」', REAL_AGREEMENT))
ok('片段即可开锁（子串语义）', softMatches('几颗糖', REAL_AGREEMENT))
ok('说错仍然不开锁（别为了容错把锁放松）', !softMatches('球上有几颗枣', REAL_AGREEMENT))

// ─────────────────────────────────────────────────────────── 软考验：零副作用

section('软考验：5 轮 + 零副作用')

store.beginSoftChallenge()
ok('开局满轮', store.softAttemptsLeft() === SOFT_MAX_ATTEMPTS, `left=${store.softAttemptsLeft()}`)

const beforeStat = statSync(FILE)
const beforeRaw = readRaw()

let left = SOFT_MAX_ATTEMPTS
for (let i = 0; i < SOFT_MAX_ATTEMPTS; i++) left = store.noteSoftFailure()
ok(`失败 ${SOFT_MAX_ATTEMPTS} 次后剩余 0`, left === 0, `left=${left}`)
ok('多失败一次也不会变负', store.noteSoftFailure() === 0)

const afterRaw = readRaw()
ok('5 轮失败后磁盘内容一字未变', beforeRaw === afterRaw)
ok('5 轮失败后文件未被写（mtime 不变）', statSync(FILE).mtimeMs === beforeStat.mtimeMs)

const rawAfterFail = readRaw()
ok('磁盘上没有「失败计数」字段', !/"softFail/i.test(rawAfterFail) && !/"attempt/i.test(rawAfterFail))
ok('磁盘上没有「疑似非本人」类标记',
  !/疑|非本人|不通过|suspect/i.test(rawAfterFail))

store.endSoftChallenge()
ok('结束考验后剩余回到满轮', store.softAttemptsLeft() === SOFT_MAX_ATTEMPTS)

// ─────────────────────────────────────────────────────────── 重启不累计

section('重启（重新 load）不累计历史失败')

store.beginSoftChallenge()
store.noteSoftFailure()
store.noteSoftFailure()
ok('本进程内已消耗 2 轮', store.softAttemptsLeft() === SOFT_MAX_ATTEMPTS - 2)

const reopened = createLockStore({ path: FILE, log: () => {} })
ok('重新加载后回到满轮（不累计）', reopened.softAttemptsLeft() === SOFT_MAX_ATTEMPTS,
  `left=${reopened.softAttemptsLeft()}`)

// ─────────────────────────────────────────────────────────── 设置

section('设置与快照')

reopened.updateSettings({ idleTimeoutMin: 15 })
ok('设置写回生效', reopened.getSettings().idleTimeoutMin === 15)
ok('设置落了盘', JSON.parse(readRaw()).settings.idleTimeoutMin === 15)
ok('默认值不被覆盖丢失', reopened.getSettings().softEnabled === false)

const snap = reopened.snapshot()
ok('快照不含任何凭证原文',
  !JSON.stringify(snap).includes(PASSWORD) && !JSON.stringify(snap).includes(PASSPHRASE))
ok('快照字段齐全',
  ['strongMode', 'hasPassword', 'lockedConvIds', 'hasAgreement', 'settings', 'softAttemptsLeft']
    .every((k) => k in snap))

// ─────────────────────────────────────────────────────────── 坏文件兜底

section('locks.json 损坏时的兜底')

const BAD = join(HERE, 'lock-test-bad.json')
const { writeFileSync } = await import('node:fs')
writeFileSync(BAD, '{ 这不是 json', 'utf8')
const broken = createLockStore({ path: BAD, log: () => {} })
ok('坏文件不抛异常，按空锁启动', !broken.hasStrongPassword() && !broken.hasAgreement())
ok('坏文件不误伤已锁列表', broken.lockedConvIds.length === 0)
rmSync(BAD, { force: true })

// ─────────────────────────────────────────────────────────── 收尾

rmSync(FILE, { force: true })

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail > 0) {
  console.log('未过项：')
  for (const f of failures) console.log(`  - ${f}`)
}
console.log('='.repeat(46))
process.exit(fail === 0 ? 0 : 1)
