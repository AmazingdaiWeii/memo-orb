#!/usr/bin/env node
/**
 * 流式情绪标记探针 —— 守「她永远看不到 `(mood:...)`」这条不变量。
 *
 * ============================ 为什么需要这支 ============================
 *
 * 情绪标记有**三条**正则，分处两个文件，各自负责一个阶段：
 *
 *   src/mood.mjs   MARKER_SRC        回合收尾：把完整标记剥掉 + 取情绪
 *   src/main.mjs   MARKER_TAIL       流式中：token 只到了半截，先把尾巴扣住不显示
 *   src/main.mjs   UNCLOSED_MARKER   回合收尾：她忘写右括号，末尾残留也要剥
 *
 * 三条的**值域必须一致**。不一致的后果不是报错，而是：
 *   · 只改了 MARKER_SRC ⇒ 完整标记能剥，但流式那几秒会闪出 `（mood:开心，`；
 *   · 只改了 MARKER_TAIL ⇒ 扣住了但收尾不剥，标记永远留在正文里。
 *
 * 2026-10-22 放宽「值里可以有中文逗号」时，我改了 MARKER_SRC 才想起 main.mjs 里
 * 还有两个兄弟 —— 差点又是一次"改了一半、看着像好了"。而当时 **一支探针都没有**
 * 覆盖这条链路（`grep MARKER_TAIL probe/` 零命中），所以那种漏改可以静默通过全部测试。
 *
 * ============================ 怎么保证不漂移 ============================
 *
 * 探针**不复制**正则字面量，而是从 `src/main.mjs` 源码里把 `/.../flags` 抠出来，
 * 用 `new Function` 还原成真的 RegExp。这样测的一定是产品此刻在用的那份。
 * （复制副本这个错，`probe/mood-alias-audit.mjs` 已经犯过一次，导致 5 条标记隐形。）
 *
 * 用法：node probe/mood-stream-marker.mjs
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMoodMarker, extractMood } from '../src/mood.mjs'

const ROOT = process.cwd()
const MAIN = readFileSync(join(ROOT, 'src', 'main.mjs'), 'utf8')

let pass = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✅ ${name}${detail ? `  —— ${detail}` : ''}`)
  } else {
    failures.push(name)
    console.log(`  ❌ ${name}${detail ? `  —— ${detail}` : ''}`)
  }
}
function group(title) {
  console.log(`\n=== ${title} ===`)
}

// ---------------------------------------------------------------- 抠字面量
/**
 * 从 main.mjs 里取出 `const NAME = /.../flags` 的**正则字面量部分**并还原。
 * 抠不到就直接抛 —— 宁可探针炸掉，也不要「找不到就跳过」那种静默通过。
 */
function grabLiteral(name) {
  const re = new RegExp(`^const ${name} = (\\/.+?\\/[gimsuy]*)$`, 'm')
  const m = re.exec(MAIN)
  if (!m) throw new Error(`抠不到 src/main.mjs 里的 ${name} —— 变量名改了？还是换行写法？`)
  // 字面量里不能有裸斜杠，否则这里会截断。当前三条都没有，加新的注意。
  return new Function(`return ${m[1]}`)()
}

const MARKER_TAIL = grabLiteral('MARKER_TAIL')
const UNCLOSED_MARKER = grabLiteral('UNCLOSED_MARKER')
const MARKER = createMoodMarker()

// ------------------------------------------------- 复刻 main.mjs 的三行扣留逻辑
/**
 * ⚠️ 这里是**复刻** `src/main.mjs` 的 `heldMarkerTail()`（原函数没导出，import 主入口
 *    会连带执行 Electron 那一堆）。逻辑只有三行、且半年没变过，复制风险可接受；
 *    真正容易漂的是正则本身，而那两条是抠出来的真货。
 *    E 组的一致性断言就是用来兜住"复刻逻辑和产品逻辑不一致"的。
 */
function heldTail(raw) {
  const at = Math.max(raw.lastIndexOf('('), raw.lastIndexOf('（'))
  if (at < 0) return ''
  const tail = raw.slice(at)
  if (/[)）]/.test(tail)) return '' // 已闭合，交给 extractMood
  return MARKER_TAIL.test(tail) ? tail : ''
}

/** 某个流式前缀「此刻会显示给她看什么」。 */
function shownWhileStreaming(prefix) {
  const held = heldTail(prefix)
  const body = held ? prefix.slice(0, prefix.length - held.length) : prefix
  return extractMood(body).text
}

/** 回合收尾时「最终显示什么」。 */
function shownAtEnd(raw) {
  const parsed = extractMood(raw)
  let text = parsed.text
  const unclosed = UNCLOSED_MARKER.exec(text)
  if (unclosed) text = text.slice(0, unclosed.index).replace(/[ \t]+$/, '')
  return text
}

// ================================================================== 1
group('1. 真样本逐字符流式：任何一刻都不许露出 mood')

const SAMPLES = [
  ['好呀（mood:开心，松了口气）。', 'happy'],
  ['好呀（mood:愣了下，认真起来）。', 'surprised'],
  ['好呀（mood:惊喜，眼睛都亮了）。', 'surprised'],
  ['好呀（mood:有点窘，笑了）。', 'shy'],
  ['好呀（mood:乐了，好奇）。', 'happy'],
  ['好呀(mood:happy)。', 'happy'],
  ['好呀（mood：害羞）。', 'shy'],
  ['好呀(MOOD: SAD)。', 'sad'],
]

for (const [full, wantMood] of SAMPLES) {
  let leaked = null
  for (let i = 1; i <= full.length; i += 1) {
    const shown = shownWhileStreaming(full.slice(0, i))
    if (/mood/i.test(shown)) {
      leaked = { at: i, prefix: full.slice(0, i), shown }
      break
    }
  }
  check(
    `逐字符喂「${full}」全程不泄漏`,
    leaked === null,
    leaked ? `第 ${leaked.at} 个字符起显示 ${JSON.stringify(leaked.shown)}` : '',
  )

  const end = extractMood(full)
  check(`「${full}」收尾取到 ${wantMood}`, end.mood === wantMood, String(end.mood))
  check(`「${full}」收尾正文干净`, !/mood/i.test(end.text), JSON.stringify(end.text))
}

// ================================================================== 2
group('2. 忘写右括号（她真会忘）：收尾也要剥干净')

for (const [raw, want] of [
  ['好呀（mood:开心，松了口气', '好呀'],
  ['好呀（mood:happy', '好呀'],
  ['好呀（mood：害羞', '好呀'],
  ['好呀(mood:乐了，好奇', '好呀'],
]) {
  const shown = shownAtEnd(raw)
  check(`「${raw}」→ 正文「${want}」`, shown === want, JSON.stringify(shown))
}

// ================================================================== 3
group('3. 不误伤正常正文（宁可少剥，不可乱吃）')

const SAFE = [
  ['（这只是括号', '中文括号里不是 mood'],
  ['（心情：开心', '中文说法但没写 mood'],
  ['（maybe later', '以 m 开头但不是 mood'],
  ['（muted', '以 mu 开头但不是 mood'],
  ['（照着做就行', '普通中文括号内容'],
]
for (const [text, why] of SAFE) {
  check(`不扣「${text}」（${why}）`, heldTail(text) === '', JSON.stringify(heldTail(text)))
  check(`不剥「${text}」（${why}）`, shownAtEnd(text) === text, JSON.stringify(shownAtEnd(text)))
}

// 反过来：真的半截标记必须被扣住，否则就会漏出来
for (const [tail, why] of [
  ['（m', '刚收到左括号和一个 m'],
  ['（mo', 'mo'],
  ['（mood', '有 mood 没冒号'],
  ['（mood:', '有冒号没值'],
  ['（mood:开心', '有值没右括号'],
  ['（mood:开心，', '有中文逗号'],
  ['（mood:开心，松了口气', '两个词'],
]) {
  check(`扣住「${tail}」（${why}）`, heldTail(tail) === tail, JSON.stringify(heldTail(tail)))
}

// ================================================================== 4
group('4. ★ 三条正则值域一致（这条专抓"改了一半"）')

/**
 * 对同一个值：完整标记能不能剥 ⟺ 未闭合版能不能剥 ⟺ 流式尾巴能不能扣住。
 * 三者不一致就是漂移，而漂移的表现就是"偶发漏出括号"，最难查。
 */
const VALUES = [
  ['happy', '单英文词'],
  ['开心', '单中文词'],
  ['开心，松了口气', '中文逗号两个词'],
  ['开心、好奇', '顿号两个词'],
  ['shy, happy', '英文逗号两个词'],
  ['被将了一军', '长一点的别名'],
  ['认真起来，有点闷，但又觉得还行', '三个词、带标点'],
  ['a'.repeat(48), '恰好 48 字（上限内）'],
  ['a'.repeat(49), '49 字（刚好超限）'],
  ['a'.repeat(80), '80 字（远超限）'],
  ['x'.repeat(200), '200 字（该被上限挡住）'],
]

for (const [value, why] of VALUES) {
  const closed = `（mood:${value}）`
  const open = `（mood:${value}`

  const canStrip = MARKER.test(closed)
  MARKER.lastIndex = 0
  const canStripOpen = UNCLOSED_MARKER.test(open)
  const canHold = MARKER_TAIL.test(open)

  check(
    `值「${why}」三条正则一致（剥=${canStrip} / 未闭合剥=${canStripOpen} / 扣=${canHold}）`,
    canStrip === canStripOpen && canStrip === canHold,
  )
}

// ================================================================== 5
group('5. 上限真的在起作用（不是形同虚设）')

check('48 字以内认', MARKER.test(`（mood:${'a'.repeat(48)}）`))
MARKER.lastIndex = 0
check('49 字不认', !MARKER.test(`（mood:${'a'.repeat(49)}）`))
MARKER.lastIndex = 0
check('真实最长样本（9 字）远在上限内', MARKER.test('（mood:惊喜，眼睛都亮了）'))
MARKER.lastIndex = 0

// ================================================================== 6
group('6. 换行不许跨（标记不能吃掉下一段）')

check('值里含换行时三条正则都不认（不会跨行吞正文）',
  !MARKER.test('（mood:开心\n下一段正文）') &&
  !UNCLOSED_MARKER.test('（mood:开心\n下一段正文') &&
  !MARKER_TAIL.test('（mood:开心\n下一段正文'))
MARKER.lastIndex = 0

check('跨行文本原样保留',
  extractMood('（mood:开心\n下一段正文）').text === '（mood:开心\n下一段正文）',
  JSON.stringify(extractMood('（mood:开心\n下一段正文）').text))

// ==================================================================
console.log('\n' + '='.repeat(56))
if (failures.length === 0) {
  console.log(`通过 ${pass} / 失败 0`)
  console.log('='.repeat(56))
  process.exit(0)
}
console.log(`通过 ${pass} / 失败 ${failures.length}`)
for (const f of failures) console.log(`  · ${f}`)
console.log('='.repeat(56))
process.exit(1)
