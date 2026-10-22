#!/usr/bin/env node
/**
 * 语音播报 · 接线结构探针 —— probe/speech-wiring-unit.mjs
 *
 * 为什么需要它：这个项目里最贵的一类 bug 是**静默断裂** —— 代码都在、语法全绿、
 * 一句异常都没有，但功能就是不工作。已经踩过的同款：
 *   · `helper/lib/main.js` 的 dispatchRecord 里**没有 deco 分支** ⇒ 表情永远不变
 *   · preload 没暴露 `onConversationAction` ⇒ 改名失败时完全静默
 *   · `executeTool` 里用 `this.agentId`（模块级函数没有 this）⇒ 永远搜不到
 *   · `capture()` 收了 bili 却没传给 renderSystemText ⇒ 指南从没进过 prompt
 *
 * 播报这条链路有 6 个必须对齐的接缝，任何一处错位都表现为「开关开着、她不出声」：
 *   ① 主进程 invoke 通道名  ↔ preload 的方法
 *   ② 主进程 send 的 type    ↔ helper 的 deliver 分支
 *   ③ helper 转发的通道名     ↔ preload 的 on 订阅
 *   ④ preload 的方法名        ↔ shell.js 的调用
 *   ⑤ 设置页注入的三个动作     ↔ shell.js 传进 createApiConfigPanel 的键
 *   ⑥ CSS/HTML 的承重属性      ↔ 少了就「看得见点不动 / 恒显示」
 *
 * 跑： node probe/speech-wiring-unit.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

/** 剥掉注释再扫结构 —— 否则注释里出现的字符串会把断言骗成绿的（这个坑踩过）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

let pass = 0
let fail = 0
const fails = []
function ok(cond, name, detail = '') {
  if (cond) {
    pass += 1
    console.log(`PASS ${name}`)
  } else {
    fail += 1
    fails.push(name)
    console.log(`FAIL ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

const mainSrc = stripComments(read('src/main.mjs'))
const helperSrc = stripComments(read('helper/lib/main.js'))
const preloadSrc = stripComments(read('helper/preload.cjs'))
const shellSrc = stripComments(read('helper/assets/shell.js'))
const panelSrc = stripComments(read('helper/assets/api-config.js'))
const htmlSrc = read('helper/assets/floating.html')
const cssSrc = stripComments(read('helper/assets/floating.css'))
const speechSrc = stripComments(read('src/tts/speech.mjs'))

// ───────────────────────── ① invoke 通道 ↔ preload ─────────────────────────
console.log('\n── ① 主进程 invoke 通道 ↔ preload 方法 ──')

const INVOKE_CHANNELS = ['orb:tts-get', 'orb:tts-set', 'orb:speech-toggle', 'orb:speech-test']
for (const ch of INVOKE_CHANNELS) {
  ok(new RegExp(`ipcMain\\.handle\\(\\s*['"]${ch}['"]`).test(mainSrc), `M: 主进程注册了 ${ch}`)
  ok(new RegExp(`invoke\\(\\s*['"]${ch}['"]`).test(preloadSrc), `P: preload 调用了 ${ch}`)
}

// ───────────────────────── ② send 的 type ↔ helper 分支 ────────────────────
console.log('\n── ② 主进程 send 的 type ↔ helper 的 deliver 分支 ──')

const PUSH_TYPES = ['speech', 'speech-stop', 'speech-state']
for (const t of PUSH_TYPES) {
  // 主进程要么在 speech.mjs 里 emit，要么在 main.mjs 里 send
  const emitted = new RegExp(`type:\\s*['"]${t}['"]`).test(mainSrc) || new RegExp(`type:\\s*['"]${t}['"]`).test(speechSrc)
  ok(emitted, `M: 有人发 type=${t}`)
  // helper 的 deliver 里必须有显式分支。写成两种写法都认（`record.type === "x"` / `x` 在集合里）
  const branch = new RegExp(`record\\.type\\s*===\\s*["']${t}["']`).test(helperSrc)
  ok(branch, `H: helper/lib/main.js 有 record.type === "${t}" 分支（没有 = 静默丢弃）`)
}

// ───────────────────────── ③ helper 转发 ↔ preload 订阅 ───────────────────
console.log('\n── ③ helper 转发通道 ↔ preload 的 on 订阅 ──')

const ON_CHANNELS = ['orb:speech', 'orb:speech-stop', 'orb:speech-state']
for (const ch of ON_CHANNELS) {
  ok(new RegExp(`send\\(\\s*["']${ch}["']`).test(helperSrc), `H: helper 往 ${ch} 推过`)
  ok(new RegExp(`ipcRenderer\\.on\\(\\s*['"]${ch}['"]`).test(preloadSrc), `P: preload 订阅了 ${ch}`)
}

// ───────────────────────── ④ preload 方法 ↔ shell.js 调用 ─────────────────
console.log('\n── ④ preload 方法 ↔ shell.js 真的调用 ──')

const PRELOAD_METHODS = ['onSpeech', 'onSpeechStop', 'onSpeechState', 'speechToggle', 'speechTest', 'ttsGet', 'ttsSet']
for (const m of PRELOAD_METHODS) {
  // preload 里必须真的 expose 出去（`m(` 或 `m:` 形态）
  const exposed = new RegExp(`\\n\\s*${m}\\s*\\(`).test(preloadSrc)
  ok(exposed, `P: preload 暴露了 ${m}()`)
  // shell.js 里必须真的用到（`api.${m}`），否则「暴露了但没人叫」
  const used = new RegExp(`api\\.${m}\\b`).test(shellSrc)
  ok(used, `S: shell.js 用到了 api.${m}`)
}

// ───────────────────── ⑤ 设置页注入 ↔ shell.js 传入 ──────────────────────
console.log('\n── ⑤ 设置页的三个注入动作 ↔ shell.js 传进去了 ──')

for (const key of ['ttsGet', 'ttsSave', 'speechTest']) {
  ok(new RegExp(`options\\.${key}`).test(panelSrc), `A: api-config.js 读了 options.${key}`)
  ok(new RegExp(`\\b${key}\\s*:`).test(shellSrc), `S: shell.js 往 panel 传了 ${key}`)
}

// ───────────────────── ⑥ 承重的 CSS / HTML 属性 ───────────────────────────
console.log('\n── ⑥ CSS / HTML 承重属性 ──')

ok(/media-src[^;]*blob:/.test(htmlSrc), 'H: floating.html 的 CSP 放行 media-src blob:')
ok(/id="speech-toggle"/.test(htmlSrc), 'H: #speech-toggle 在页面上')
ok(
  /id="deco-lane"[\s\S]{0,900}?id="speech-toggle"/.test(htmlSrc),
  'H: #speech-toggle 在 #deco-lane 里面（「头像旁边」的落点）',
)
// display:grid 必须先声明才需要 [hidden] 兜底；这里直接要求兜底存在（铁律）
ok(/#speech-toggle\s*\{[^}]*display:\s*grid/.test(cssSrc), 'C: #speech-toggle 用了 display:grid')
ok(/#speech-toggle\[hidden\]\s*\{\s*display:\s*none/.test(cssSrc), 'C: #speech-toggle[hidden]{display:none}（否则恒显示）')
ok(
  /#speech-toggle\s*\{[^}]*pointer-events:\s*auto/.test(cssSrc),
  'C: #speech-toggle 自己开了 pointer-events（父层 deco-lane 是 none，不开就点不动）',
)
// 按钮与 reasoning-lane 的宽度算式必须同时在（一处改了另一处没改 = 两个元素叠在一起）
ok(
  /#reasoning-lane\s*\{[^}]*width:[^;]*var\(--deco-size\)[^;]*62px/.test(cssSrc),
  'C: #reasoning-lane 的宽度为按钮让出了位置（62px 那一段）',
)
ok(
  /#speech-toggle\s*\{[^}]*right:\s*calc\(var\(--deco-size\)\s*\+\s*16px\)/.test(cssSrc),
  'C: #speech-toggle 的 right 与上面那条宽度算式是配对的',
)

// ───────────────────── ⑦ 数据根的坑（ORB_DATA 时序）─────────────────────
console.log('\n── ⑦ tts.json 的路径必须显式给 dataRoot ──')
ok(
  /loadTtsConfig\(\s*settingsDataRoot\(\)\s*\)/.test(mainSrc),
  'M: loadTtsConfig 显式传了 settingsDataRoot()（不传会回落到 ~/.legacy）',
)
ok(
  /saveTtsConfig\([^)]*settingsDataRoot\(\)/.test(mainSrc),
  'M: saveTtsConfig 也显式传了 settingsDataRoot()',
)
// 反面对照：不许出现无参调用
ok(
  !/loadTtsConfig\(\s*\)/.test(mainSrc),
  'M: 没有任何一处无参 loadTtsConfig()（那条会读错目录且静默返回缺省）',
)

// ───────────────────── ⑧ 播报真被接进回合了 ─────────────────────────────
console.log('\n── ⑧ 回合链路真的喂了播报 ──')
ok(/speech\.feed\(/.test(mainSrc), 'M: 有 speech.feed（流式喂句子）')
ok(/speech\.finish\(\)/.test(mainSrc), 'M: 有 speech.finish（回合收尾吐残句）')
ok(/speech\.stop\(/.test(mainSrc), 'M: 有 speech.stop（新回合打断）')
ok(/speech\.say\(/.test(mainSrc), 'M: 有 speech.say（闹钟那类完整句子）')
// 两条引擎都要接：local 的 assistant 分支 + legacy 的 assistant_message 分支
const feedCount = (mainSrc.match(/speech\.feed\(/g) || []).length
ok(feedCount >= 2, 'M: 两个引擎（local / legacy）都接了 feed', `只找到 ${feedCount} 处`)
const finishCount = (mainSrc.match(/speech\.finish\(\)/g) || []).length
ok(finishCount >= 2, 'M: 两个引擎都接了 finish', `只找到 ${finishCount} 处`)

// ───────────────────── ⑨ 不落盘 ────────────────────────────────────────
console.log('\n── ⑨ mp3 不落盘（用户要求：即用即抛）──')
// ① 编排层连 fs 都不该 import —— 它只跟 Buffer 打交道
ok(!/from\s+['"]node:fs['"]|require\(['"]node:fs['"]\)/.test(speechSrc), 'T: speech.mjs 根本不 import node:fs')
ok(!/writeFile|createWriteStream|appendFile/.test(speechSrc), 'T: speech.mjs 没有任何写文件调用')
// ② 音频只能以 base64 过 IPC（Buffer → 字符串 → Blob），不许落成文件
ok(/toString\(\s*['"]base64['"]\s*\)/.test(speechSrc), 'T: speech.mjs 把音频转 base64 过 IPC')
ok(!/\.mp3['"`]|\.wav['"`]/.test(speechSrc), 'T: speech.mjs 里没有拼过任何音频文件路径（落盘的第一征兆）')
// ③ 渲染层必须 revoke，否则内存会一直涨（不是文件问题，是内存泄漏）
ok(/revokeObjectURL/.test(shellSrc), 'S: shell.js 播完会 revokeObjectURL')
ok(/createObjectURL/.test(shellSrc), 'S: shell.js 用的是 blob URL，不是 data: 长串')
// ④ 反面对照：确认「写盘」这条能力确实只出现在配置保存里，不在音频链路上
ok(/saveTtsConfig\(/.test(mainSrc), 'M: 唯一会写盘的是配置（saveTtsConfig），不是音频')

// ───────────────────── ⑩ 开关关闭时不许出声 ────────────────────────────
console.log('\n── ⑩ 默认关 + 关掉真的静 ──')
const ttsIndexSrc = stripComments(read('src/tts/index.mjs'))
ok(/enabled:\s*false/.test(ttsIndexSrc), 'T: 出厂 enabled 是 false（开源版不带作者的 key 白用）')
ok(/if\s*\(!isOn\(\)\)\s*return/.test(speechSrc), 'T: speech.mjs 的 feed/finish/say 都有 isOn() 闸门')
ok(/setEnabled\(next\)[\s\S]{0,220}?this\.stop\(/.test(speechSrc), 'T: 关开关会顺手打断（不留半句的怪状态）')

// ───────────────────── ⑪ 初始化顺序（TDZ）──────────────────────────────
// `const speech = ...` 如果声明在使用它的函数之后，而那个函数在早期就被调用，
// 就会读到 TDZ 里的 speech 并抛 ReferenceError —— 而这个错误发生在 socket 回调里，
// 表现是「球起来了但点不动」。函数声明会 hoist、const 不会，这个差别必须钉住。
console.log('\n── ⑪ 初始化顺序（TDZ）──')
const idxSpeechConst = mainSrc.indexOf('const speech = createSpeechQueue(')
const idxSetTurnFn = mainSrc.indexOf('function setTurn(')
const idxSetTurnCall = mainSrc.search(/\nsetTurn\(/)
ok(idxSpeechConst > 0, 'M: 找得到 `const speech = createSpeechQueue(`')
ok(idxSpeechConst < idxSetTurnFn, 'M: const speech 声明在 setTurn 之前（函数体引用它时不会是 TDZ）',
  `speech@${idxSpeechConst} / setTurn@${idxSetTurnFn}`)
ok(idxSetTurnCall < 0 || idxSetTurnCall > idxSpeechConst, 'M: 模块顶层没有在声明之前就调 setTurn()',
  `first call@${idxSetTurnCall}`)
ok(
  /function settingsDataRoot\(/.test(mainSrc),
  'M: settingsDataRoot 是**函数声明**（hoisted）—— 改成 const 箭头函数的话，模块顶层那次 loadTtsConfig 会 TDZ',
)

console.log('')
console.log(`${pass} PASS / ${fail} FAIL`)
if (fail > 0) {
  console.log('失败项：' + fails.join('、'))
  process.exit(1)
}
