#!/usr/bin/env node
/**
 * windows-transparency.mjs —— Windows 透明窗口的两条硬规矩（静态探针，纯 Node）。
 *
 * 两条规矩都是从**真实事故**里长出来的：
 *
 * ① **毛玻璃只糊框架，不糊背景图**
 *    球窗口 / 环窗口都是 `transparent: true` + `backgroundColor: "#00000000"`。
 *    Chromium 为了采样 backdrop，会把整块窗口按不透明 surface 合成 ——
 *    于是**整个窗口变成一个直角深色矩形**，面板那 36px 圆角直接失效
 *    （圆角外那圈本该透明的区也被涂满）。
 *    现象：球一展开就是一个「方块」，用户 2026-10-21 深夜报「你这边框是怎么回事」。
 *    ⚠️ 这条**无头环境与任何截图断言都测不出来**（背后没有像素可采样），
 *       只有真机能看见 —— 所以只能靠静态断言钉住规则本身。
 *    ★ 2026-10-22 更正：真正要的不是「把背景糊掉」，而是「框架是玻璃、背景是清楚的」。
 *      做法是把 `#bg-stack` 搬出 `#panel`（见下面 B 组）。
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
const FLOAT_HTML = read('helper', 'assets', 'floating.html')
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
console.log('── B. 毛玻璃只糊框架，不糊背景（2026-10-22 换的口径）──')

/**
 * ⚠️ 这一组**曾经写的是相反的断言**（「`.bg-layer` 必须有 filter: blur」）——
 *   那是照着 2026-10-21 的错误处方钉的：当时以为「#bg-stack 在 #panel 里，
 *   backdrop-filter 糊不到它，只好让它自己糊」。前半句对，处方是反的。
 *
 * 用户 2026-10-22 明确：「毛玻璃只对对话框、输入框、其它菜单框架生效，
 * 不对对话背景做遮罩」——而旧处方恰好把背景糊成一片雾、框架却没有玻璃。
 *
 * 正解：把 `#bg-stack` 搬到 `#panel` **外面**（body 下、z-index 更低），
 *   · 图在面板背后 ⇒ `#panel` 的 `backdrop-filter` 真的糊到它；
 *   · 图自己不加 filter ⇒ 背景清楚；
 *   · 两层的圆角/展开动画逐条对齐 ⇒ 透明窗口的圆角不丢。
 *
 * 所以这一组现在是**反向断言**：谁再给 `.bg-layer` 加 blur，这里必须红。
 */
/* ⚠️ 断言前必须先剥掉注释：注释里写着「`filter: blur()`」这类字样时，
 *   正则会跨着注释匹配上，断言就变成了恒真的假绿（这次真踩了）。 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*\/\/.*$/gm, '')
const FLOAT_LIVE = stripComments(FLOAT_CSS)

ok('B1 背景层已在 #panel 外面（否则 backdrop-filter 糊不到它，通透度圆环也就没反应）',
  /<body>[\s\S]*?<div id="bg-stack"[\s\S]*?<section id="panel"/.test(FLOAT_HTML),
  'DOM 顺序必须是 #bg-stack 在 #panel 之前')
ok('B2 背景图自己**不许**糊（.bg-layer 不能有 filter: blur）',
  !/\.bg-layer\s*\{[^}]*?filter:\s*blur\(/.test(FLOAT_LIVE),
  '给 .bg-layer 加 blur = 把对话背景糊成雾，用户要的正好相反')
ok('B3 面板的毛玻璃在（#panel 有 backdrop-filter）',
  /#panel\s*\{[^}]*?backdrop-filter:\s*blur\(/.test(FLOAT_LIVE),
  '#panel 丢了 backdrop-filter ⇒ 框架不再是玻璃')
ok('B4 层级配对（#panel z-index:1 / #bg-stack z-index:0）',
  /#panel\s*\{[^}]*?z-index:\s*1\b/.test(FLOAT_LIVE) &&
    /#bg-stack\s*\{[^}]*?z-index:\s*0\b/.test(FLOAT_LIVE))
ok('B5 圆角还在（36px + 面板用它）—— 搬层不许以牺牲圆角为代价',
  /--panel-radius:\s*36px/.test(FLOAT_CSS) && /border-radius:\s*var\(--panel-radius\)/.test(FLOAT_LIVE))
ok('B6 两层的展开动画对齐（#bg-stack 有 opacity/transform/transform-origin 三件套）',
  /#bg-stack\s*\{[^}]*?transform-origin:\s*var\(--origin-x\)/.test(FLOAT_LIVE) &&
    /body\.expanded\s+#bg-stack\s*\{[^}]*?opacity:\s*1/.test(FLOAT_LIVE))

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

  // D2：给 `.bg-layer` 塞回一句 blur → B2 必须红（不然那条反向断言是恒真的）
  const withBlur = `${FLOAT_LIVE}\n.bg-layer {\n  filter: blur(8px);\n}\n`
  ok('D2 给 .bg-layer 塞回 blur 后 B2 会红（断言没恒真）',
    /\.bg-layer\s*\{[^}]*?filter:\s*blur\(/.test(withBlur))
}

console.log('')
console.log(`windows-transparency: ${pass} PASS / ${fail} FAIL`)
if (fail) {
  console.log('失败项：' + failures.join(' | '))
  process.exitCode = 1
}