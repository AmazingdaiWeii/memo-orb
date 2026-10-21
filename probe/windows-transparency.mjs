#!/usr/bin/env node
/**
 * windows-transparency.mjs —— Windows 透明窗口的两条硬规矩（静态探针，纯 Node）。
 *
 * 两条规矩都是从**真实事故**里长出来的：
 *
 * ① **背景图必须被糊**
 *    球窗口 / 环窗口都是 `transparent: true` + `backgroundColor: "#00000000"`。
 *    Chromium 为了采样 backdrop，会把整块窗口按不透明 surface 合成 ——
 *    于是**整个窗口变成一个直角深色矩形**，面板那 36px 圆角直接失效
 *    （圆角外那圈本该透明的区也被涂满）。
 *    现象：球一展开就是一个「方块」，用户 2026-10-21 深夜报「你这边框是怎么回事」。
 *    ⚠️ 这条**无头环境与任何截图断言都测不出来**（背后没有像素可采样），
 *       只有真机能看见 —— 所以只能靠静态断言钉住规则本身。
 *
 * ② **本地引擎下不许出现「旧后端」字样**
 *    2026-10-19 断脐之后 `legacyReady` 在 `config.engine === 'local'` 下**永远是 false**
 *    （没有任何代码会去置真）。而球重连那一段原来只判 `!legacyReady`，
 *    于是**每次冷启动**球一连上就显示「正在启动旧后端…」——
 *    而旧后端根本不存在。用户 2026-10-21 深夜又撞见一次。
 *
 * 用法：`node probe/windows-transparency.mjs`
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`PASS ${name}${extra ? '  ' + extra : ''}`)
  } else {
    fail += 1
    failures.push(name)
    console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`)
  }
}

const MAIN_JS = read('helper', 'lib', 'main.js')
const SRC_MAIN = read('src', 'main.mjs')
const FLOAT_CSS = read('helper', 'assets', 'floating.css')
const RING_CSS = read('helper', 'assets', 'ring-menu.css')

console.log('── A. 三个窗口都是透明窗口 ──')

// 真正的窗口创建有 4 扇（选择工具 / 选区工具 / 球面板 / 环菜单），
// 第 1406 行那处 `new BrowserWindow` 只是注释里的字，别算进去。
// ★ 具体几扇会随功能增长，所以只钉「**每扇都是透明窗**」，不钉死数量。
const winLines = MAIN_JS.split(/\r?\n/)
const wins = []
winLines.forEach((line, i) => {
  if (!/\bnew BrowserWindow\s*\(/.test(line) || line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return
  const body = winLines.slice(i, i + 24).join('\n')
  wins.push({
    line: i + 1,
    transparent: /transparent:\s*true/.test(body),
    clearBg: /backgroundColor:\s*"#00000000"/.test(body),
  })
})
ok(`A0 ${wins.length} 扇窗口全部是透明窗（transparent + 全透明底色）`,
  wins.length >= 4 && wins.every((w) => w.transparent && w.clearBg),
  JSON.stringify(wins))

const transparentWins = (MAIN_JS.match(/transparent:\s*true/g) || []).length
ok('A1 三个窗口都声明了 transparent: true',
  transparentWins >= 3, `实际 ${transparentWins} 处（少一处就有一扇不透明窗口）`)
ok('A2 窗口背景色都是全透明（#00000000）',
  (MAIN_JS.match(/backgroundColor:\s*"#00000000"/g) || []).length >= 3,
  `${(MAIN_JS.match(/backgroundColor:\s*"#00000000"/g) || []).length} 处`)
ok('A3 面板保留 36px 圆角（这条要是没了，「直角方块」就没得治了）',
  /--panel-radius:\s*36px/.test(FLOAT_CSS) && /border-radius:\s*var\(--panel-radius\)/.test(FLOAT_CSS))

console.log('')
console.log('── B. 背景必须被糊住（这条才是真问题）──')

/**
 * ⚠️ 这里曾经写过相反的断言（「透明窗口里不许有 backdrop-filter」）——
 *   那是**误判**：我以为 #panel 的 backdrop-filter 会把透明窗口合成成直角方块，
 *   于是把母本原版的毛玻璃全删了，结果用户的满图背景原样透进来、正文压图
 *   ⇒ 他报「排版乱」。母本本来就有 backdrop-filter，之前从没出过问题。
 *
 * ★ 真正的机制：backdrop-filter 模糊的是「元素背后已绘制的内容」，
 *   而 `#bg-stack` 是 #panel 的子元素、z-index:-1，画在 panel 背景**之上**
 *   ⇒ **它根本不在 backdrop 范围内**。所以真正管用的是给 `.bg-layer`
 *   自己加 `filter: blur()`。
 */
/* ⚠️ 断言前必须先剥掉注释：注释里写着「`filter: blur()`」这类字样时，
 *   正则会跨着注释匹配上，断言就变成了恒真的假绿（这次真踩了）。 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*\/\/.*$/gm, '')
const FLOAT_LIVE = stripComments(FLOAT_CSS)

ok('B1 背景层自己被模糊（.bg-layer 有 filter: blur）—— 这才是让正文压得住满图的那一刀',
  /\.bg-layer\s*\{[^}]*?filter:\s*blur\(/.test(FLOAT_LIVE),
  '.bg-layer 没有 filter: blur ⇒ 背景图原样透进来，正文直接压在高对比花纹上')
ok('B2 blur 配了 transform: scale（否则模糊会把容器边角洗白）',
  /\.bg-layer\s*\{[^}]*?transform:\s*scale\(/.test(FLOAT_LIVE))
ok('B3 圆角还在（36px + 面板用它）—— 糊化不许以牺牲圆角为代价',
  /--panel-radius:\s*36px/.test(FLOAT_CSS) && /border-radius:\s*var\(--panel-radius\)/.test(FLOAT_LIVE))

console.log('')
console.log('── C. 本地引擎不该说「旧后端」（规矩 ②）──')

// 球重连那一行：必须同时判 engine
const reconnect = SRC_MAIN.match(/if \(([^\n]*)\) setTurn\(false, '正在启动旧后端…'\)/)
ok('C1 找得到「正在启动旧后端」那一行', reconnect !== null, String(reconnect && reconnect[0]).trim())
ok('C2 它先判 engine 是 local（本地引擎根本不会去启旧后端）',
  reconnect !== null && /engine\s*!==\s*'local'/.test(reconnect[1]),
  reconnect ? reconnect[1] : '')
ok('C3 同理，全文里「正在启动旧后端」只出现一次（别在别处又埋一句）',
  (SRC_MAIN.match(/setTurn\((?:true|false)?,?\s*'正在启动旧后端/g) || []).length === 1,
  `${(SRC_MAIN.match(/setTurn\((?:true|true|false)?,?\s*'正在启动旧后端/g) || []).length} 处`)

// 顺带把「本地引擎压根不启动旧后端」钉住 —— 这是 ① 的前提
ok('C4 engine=local 时跳过旧后端启动',
  /if\s*\(config\.engine\s*===\s*'local'\)[\s\S]{0,120}?跳过旧后端启动/.test(SRC_MAIN)
  || /跳过旧后端启动/.test(SRC_MAIN) && /engine\s*===\s*'local'/.test(SRC_MAIN))

console.log('')
console.log('── D. 反向对照：把两条规矩拆掉，本探针必须红 ──')
{
  // D1：把 C2 的 engine 判据去掉 → C2 必须红
  const broken = SRC_MAIN.replace(
    /if \(config\.engine !== 'local' && !legacyReady\) setTurn\(false, '正在启动旧后端…'\)/,
    "if (!legacyReady) setTurn(false, '正在启动旧后端…')",
  )
  const m = broken.match(/if \(([^\n]*)\) setTurn\(false, '正在启动旧后端…'\)/)
  ok('D1 去掉 engine 判据后 C2 会红（断言没恒真）',
    broken !== SRC_MAIN && (m === null || !/engine\s*!==\s*'local'/.test(m[1])))

  // D2：把所有 blur 去掉 → B1 必须红（不然这条断言是恒真的）
  // ⚠️ 必须**全局**替换：CSS 里 `backdrop-filter: blur(...)` 也含 "filter: blur(" 子串，
  //   只替换第一个的话，去掉的是母本 #panel 的那处，.bg-layer 的还在 ⇒ 对照失效（踩过）。
  const strippedAll = stripComments(FLOAT_CSS)
  const css2 = strippedAll.replace(/filter:\s*blur\([^;]*;/g, '')
  ok('D2 去掉背景层的 blur 后 B1 会红（断言没恒真）',
    css2 !== strippedAll && !/\.bg-layer\s*\{[^}]*?filter:\s*blur\(/.test(css2))
}

console.log('')
console.log(`windows-transparency: ${pass} PASS / ${fail} FAIL`)
if (fail) {
  console.log('失败项：' + failures.join(' | '))
  process.exitCode = 1
}