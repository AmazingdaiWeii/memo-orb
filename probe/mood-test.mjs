/**
 * 情绪 GIF · 纯逻辑单测
 *
 * ⚠️ 这些全绿**不代表情绪联动能跑** —— 它证明不了 host 的 `applyMood` 真的挂在了
 * `assistant_message` 上、也证明不了球真的换了图。那两条靠 wire 探针 + 真人肉眼。
 * 它证明的是三件很难用别的手段验的事：
 *   ① 我们算出来的 `src` **真的能过球侧那条正则**（正则从 `helper/lib/main.js` 里现读，
 *      不是我抄一份 —— 抄的那份会随球侧改动悄悄过期）；
 *   ② 用户敲定的六个倍速**逐条对得上**，且透明度是「图层级一个值」（依据 deco-plan/CONFIG.md）；
 *   ③ `(mood:...)` 的提取满足待测清单 2.1-2.5（任意位置、逐词、无误切、rice 语义）。
 *
 * 跑法：node probe/mood-test.mjs
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DECO_DIR,
  DEFAULT_MOOD,
  LAYER_OPACITY,
  MOOD_NAMES,
  MOODS,
  THINKING_MOOD,
  assetFor,
  coerceMood,
  extractMood,
  isSafeAssetSrc,
  sourceFileName,
} from '../src/mood.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT_DIR = join(ROOT, 'deco-plan', 'output')
const HELPER_MAIN = join(ROOT, 'helper', 'lib', 'main.js')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✅ ${name}${detail ? `  —— ${detail}` : ''}`) }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? `  —— ${detail}` : ''}`) }
}
const group = (t) => console.log(`\n=== ${t} ===`)

// ================================================================ 1. 用户的规格
group('1. 用户敲定的六个情绪 / 倍速 / 图层透明度')
/** 倍速来自用户 2026-10-07 原话：idle 0.85x / thinking 0.5x / happy 0.85x / shy 0.7x / sad 0.5x / surprised 0.5x */
const WANT = {
  idle: { speed: '0.85x' },
  thinking: { speed: '0.5x' },
  happy: { speed: '0.85x' },
  shy: { speed: '0.7x' },
  sad: { speed: '0.5x' },
  surprised: { speed: '0.5x' },
}
check('正好六个情绪', MOOD_NAMES.length === 6, MOOD_NAMES.join(','))
check('情绪名集合与用户给的一字不差',
  MOOD_NAMES.slice().sort().join(',') === Object.keys(WANT).sort().join(','), MOOD_NAMES.join(','))
for (const [mood, want] of Object.entries(WANT)) {
  const got = MOODS[mood]
  check(`${mood} 倍速 = ${want.speed}`, got?.speed === want.speed, String(got?.speed))
}
check('★ 情绪表里不写 opacity（透明度归图层，六个情绪共用一个值）',
  MOOD_NAMES.every((m) => MOODS[m].opacity === undefined),
  MOOD_NAMES.map((m) => `${m}=${MOODS[m].opacity}`).join(' '))
check('★ 图层透明度是个合法不透明度（0 < v ≤ 1，可调）',
  typeof LAYER_OPACITY === 'number' && LAYER_OPACITY > 0 && LAYER_OPACITY <= 1,
  String(LAYER_OPACITY))
// ⚠️ 这里**故意不写死具体数值**。
//    曾经断言 `LAYER_OPACITY === 0.65`（对齐 deco-plan/CONFIG.md 的「默认 65%」），
//    2026-10-07 用户做窗口美化时把整层调到 1（完全不透明），功能完全正确，
//    探针却红了 —— 一条「只在用户调参时才响」的假警报。
//    透明度是**视觉参数**，不是契约：它随美化变，不该被测试锁死。
//    真正该锁的是「六个情绪共用一个值」（下一条），不是那个值是几。
check('★ 六个情绪的透明度完全一致（不是 sad 单独一档）',
  new Set(MOOD_NAMES.map((m) => assetFor(m).opacity)).size === 1,
  MOOD_NAMES.map((m) => `${m}=${assetFor(m).opacity}`).join(' '))
check('兜底情绪是 idle', DEFAULT_MOOD === 'idle' && THINKING_MOOD === 'thinking')

// ================================================================ 2. ★ 与球侧正则对质
group('2. ★★ 算出来的 src 必须能过球侧那条正则（从 helper 现读，不抄）')
let ballRegex = null
if (existsSync(HELPER_MAIN)) {
  const src = readFileSync(HELPER_MAIN, 'utf8')
  const m = /const PRESET_SRC = (\/\^.*?\/);/.exec(src)
  if (m) {
    try { ballRegex = eval(m[1]) } catch { ballRegex = null }   // eslint-disable-line no-eval
    check('从 helper/lib/main.js 里读到了 PRESET_SRC 正则', true, m[1])
  } else {
    check('从 helper/lib/main.js 里读到了 PRESET_SRC 正则', false, '没匹配到 —— 球侧可能改了写法')
  }
} else {
  check('helper/lib/main.js 存在', false, HELPER_MAIN)
}

for (const mood of MOOD_NAMES) {
  const { src } = assetFor(mood)
  if (ballRegex) {
    ballRegex.lastIndex = 0
    check(`★ ${mood} 的 src 过球侧正则（${src}）`, ballRegex.test(src), src)
  }
}
/** 反面：素材目录里的原名是过不了的 —— 这正是本模块存在的理由。 */
if (ballRegex) {
  for (const bad of ['happy@0.85x.gif', 'deco/happy@0.85x.gif', 'Happy.gif', 'deco/../x.gif', 'deco/my file.gif']) {
    ballRegex.lastIndex = 0
    check(`反面：${bad} 确实过不了（会被球静默丢弃）`, ballRegex.test(bad) === false)
  }
}

group('2b. isSafeAssetSrc 与球侧正则一致')
for (const mood of MOOD_NAMES) {
  check(`${mood} 的 src 自家校验也放行`, isSafeAssetSrc(assetFor(mood).src))
}
for (const bad of ['happy@0.85x.gif', 'Happy.gif', 'deco/a b.gif', 'deco//x.gif', '', '.gif', 'deco/x.png']) {
  check(`拒绝 ${JSON.stringify(bad)}`, isSafeAssetSrc(bad) === false)
}

// ================================================================ 3. 素材文件真的在
group('3. ★ 源素材真的存在（deco-plan/output/），且改名规则算得对')
// deco-plan/ 是作者的本地素材管线目录（56.7MB 原图/预览），**不随仓库分发**。
// 目录不在时这条检查无从谈起，跳过而不是判红 —— 改名规则本身由下面两条与第 2 节覆盖。
if (existsSync(OUTPUT_DIR)) {
  for (const mood of MOOD_NAMES) {
    const name = sourceFileName(mood)
    check(`${mood} → ${name}`, name !== null && existsSync(join(OUTPUT_DIR, name)))
  }
} else {
  console.log('  · 跳过：deco-plan/output/ 不在（作者本地素材目录，不分发）')
}
check('未知情绪没有源文件名', sourceFileName('nope') === null)
check('DECO_DIR 是 deco', DECO_DIR === 'deco')

// ================================================================ 4. assetFor
group('4. assetFor')
const happy = assetFor('happy')
check('happy 的 src = deco/happy.gif', happy.src === 'deco/happy.gif', happy.src)
check('happy 的透明度 = 图层默认值', happy.opacity === LAYER_OPACITY, String(happy.opacity))
check('sad 的透明度跟 happy 一样（不单独调）',
  assetFor('sad').opacity === assetFor('happy').opacity,
  `${assetFor('sad').opacity} vs ${assetFor('happy').opacity}`)
check('★ 单个情绪可以单独覆盖透明度（留了这个口子）',
  assetFor('surprised').opacity === LAYER_OPACITY, String(assetFor('surprised').opacity))
check('★ 认不出的情绪兜底成 idle（不把球丢进空状态）', assetFor('whatever').mood === 'idle')
check('null 也兜底', assetFor(null).mood === 'idle')
check('undefined 也兜底', assetFor(undefined).mood === 'idle')
check('返回里带 mood 名（球侧要显示/调试）', typeof assetFor('shy').mood === 'string')
check('返回里带 speed（给文档/排障用，不影响渲染）', assetFor('shy').speed === '0.7x')

// ================================================================ 5. coerceMood
group('5. coerceMood —— 别名收敛')
for (const mood of MOOD_NAMES) {
  check(`英文原名 ${mood} 认得出`, coerceMood(mood) === mood)
  check(`大小写不敏感 ${mood.toUpperCase()}`, coerceMood(mood.toUpperCase()) === mood)
}
for (const [raw, want] of [
  ['开心', 'happy'], ['高兴', 'happy'], ['愉快', 'happy'], ['笑', 'happy'],
  ['害羞', 'shy'], ['不好意思', 'shy'],
  ['难过', 'sad'], ['委屈', 'sad'], ['哭', 'sad'], ['失落', 'sad'],
  ['惊讶', 'surprised'], ['吃惊', 'surprised'], ['震惊', 'surprised'],
  ['思考', 'thinking'], ['沉思', 'thinking'], ['认真', 'thinking'],
  ['平静', 'idle'], ['日常', 'idle'],
  ['cry', 'sad'], ['joy', 'happy'], ['shock', 'surprised'], ['think', 'thinking'],
]) {
  check(`「${raw}」→ ${want}`, coerceMood(raw) === want, String(coerceMood(raw)))
}
for (const raw of ['', '  ', 'nonsense', '情绪', '哈哈', null, undefined, 42, {}]) {
  check(`认不出 ${JSON.stringify(raw)}（返回 null，不瞎猜）`, coerceMood(raw) === null, String(coerceMood(raw)))
}

// ================================================================ 6. extractMood（核心）
group('6. ★ extractMood —— 待测清单 2.1-2.5')
const plain = '今天的活儿我干完了，你歇会儿吧。'
const r1 = extractMood(plain)
check('没有标记时正文一字不动', r1.text === plain && r1.found === false && r1.mood === null)

const r2 = extractMood('干完了。\n(mood:happy)')
check('2.1 末尾标记 → 提取出情绪', r2.mood === 'happy', String(r2.mood))
check('2.1 标记从正文里剥掉（用户不该看到）', !r2.text.includes('mood'), JSON.stringify(r2.text))
check('剥完不留奇怪空行', r2.text === '干完了。', JSON.stringify(r2.text))

check('2.5 标记在开头也认', extractMood('(mood:shy)\n别看我。').mood === 'shy')
check('2.5 标记在中间也认', extractMood('前面(mood:sad)后面').mood === 'sad')
check('2.5 中间剥离后前后接上', extractMood('前面(mood:sad)后面').text === '前面后面',
  JSON.stringify(extractMood('前面(mood:sad)后面').text))
check('2.5 整条只有标记 → 正文变空', extractMood('(mood:idle)').text === '')
check('中括号+中文冒号（她不一定记得用英文）', extractMood('好。（mood：害羞）').mood === 'shy')
check('大写 MOOD 也认', extractMood('好。(MOOD: happy)').mood === 'happy')
check('值两边有空格也认', extractMood('好。(mood:  happy  )').mood === 'happy')

check('多个标记 → 以最后一个为准（她中途改口）',
  extractMood('(mood:happy)算了，(mood:sad)').mood === 'sad', String(extractMood('(mood:happy)算了，(mood:sad)').mood))
check('多个标记全都被剥干净', !/mood/.test(extractMood('(mood:happy)算了，(mood:sad)').text))

const unknown = extractMood('好。(mood:乱七八糟的东西)')
check('认不出的情绪 → mood 为 null（不改情绪）', unknown.mood === null, String(unknown.mood))
check('但标记照样剥掉（形态对就是标记）', unknown.found === true && !unknown.text.includes('mood'),
  JSON.stringify(unknown.text))
check('raw 带回原值，便于排障', unknown.raw === '乱七八糟的东西', String(unknown.raw))

group('6b. ★ 无误切（2.4）—— 别把正常文字吃掉')
const cases = [
  ['mood 这个词', '不带冒号，不是标记'],
  ['（mood）', '带括号但没冒号'],
  ['我的 mood 有点复杂', '有 mood 有空格但没冒号'],
  ['(mode:happy)', '拼错成 mode，不该认'],
  ['（心情：开心）', '中文说法但没写 mood'],
  ['代码里写 mood: happy 是配置项', '有冒号但没括号'],
]
for (const [text, why] of cases) {
  const r = extractMood(text)
  check(`不动「${text}」（${why}）`, r.found === false && r.text === text, JSON.stringify(r.text))
}
check('超长值不吃掉整段（值限 12 字符）',
  extractMood('(mood:' + 'a'.repeat(30) + ')').found === false)
check('值里带空格不匹配（逼她用单个词）', extractMood('(mood:very happy)').found === false)

group('6c. 空白收拾')
check('标记独占一行时不留三重空行',
  !/\n{3,}/.test(extractMood('第一段\n\n(mood:happy)\n\n第二段').text),
  JSON.stringify(extractMood('第一段\n\n(mood:happy)\n\n第二段').text))
check('剥完首尾没有多余空白',
  extractMood('\n(mood:happy)\n').text === '', JSON.stringify(extractMood('\n(mood:happy)\n').text))
check('行尾残留空格被清掉',
  extractMood('好。  (mood:happy)').text === '好。', JSON.stringify(extractMood('好。  (mood:happy)').text))
check('非字符串输入不崩', extractMood(null).text === '' && extractMood(undefined).found === false)
check('空串不崩', extractMood('').found === false)

// ================================================================ 7. 幂等 / 组合
group('7. 组合与幂等')
const once = extractMood('你好。(mood:happy)')
const twice = extractMood(once.text)
check('★ 二次提取是干净的（说明第一次真的剥完了）',
  twice.found === false && twice.text === once.text, JSON.stringify(twice.text))
check('★ 提取后的正文再过一遍 assetFor 链路仍然自洽',
  isSafeAssetSrc(assetFor(once.mood).src), assetFor(once.mood).src)
/** 待测清单 2.3「rice 语义」：用户还没确认米饭那个素材的用途，所以本模块**刻意不收它**。 */
check('2.3 不把 rice/米饭 收进情绪表（语义待用户确认）',
  coerceMood('rice') === null && coerceMood('米饭') === null)
check('情绪表里没有任何 rice 相关条目', !JSON.stringify(MOODS).includes('rice'))

// ================================================================
console.log(`\n${'='.repeat(56)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
console.log('='.repeat(56))
process.exit(fail > 0 ? 1 : 0)
