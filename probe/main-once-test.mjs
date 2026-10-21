/**
 * 探针：`main()` 只许装配一次（2026-10-07 用户实测三个现象的共同根因）。
 *
 * ## 真实事故
 *
 * `shell.js` 结尾曾经是：
 *     main()
 *     api.onImpression?.(...)
 *     main()          ← 重复
 *
 * `main()` 里是全套UI 装配：`querySelector` + `addEventListener` +
 * `createContextMenu()` + `createResizeHandles()` + `createImpressionPanel()`。
 * **跑两遍不报错、界面看起来也正常**，但：
 *
 *   1. 两个独立的 `contextMenu` 实例，各自 `document.bind()` 了一次右键。
 *      用户点「重命名」→ 实例 A 关闭并进入编辑态，
 *      **实例 B 的菜单还留在屏幕上**，盖住输入框。
 *      用户看到的原话：「此时如果直接点击 ✓，相当于取消重命名操作」。
 *   2. 可编辑区分支也跑两遍 → 两个原生 Menu.popup() 抢同一个鼠标事件
 *      → 「输入框内右键弹不出菜单」。
 *   3. 缩放手柄建了 16 条（8 × 2），命中判定互相打架。
 *
 * ## 为什么之前的探针全都抓不到
 *
 * 现有探针（rename-inline / context-menu / resize-handles）都是
 * **从产品文件里抽单个函数**测的 —— 从来没有把 `main()` 整体跑过。
 * 「装配跑几遍」不在任何一个被测函数的职责范围内。
 *
 * 这就是记忆里那条铁律的另一个侧面：
 * **探针结构必须与产品同构** —— 产品是「整个页面装配一次」，
 * 探针就也得真的装配一次，不能只测零件。
 *
 * 用法：node probe/main-once-test.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHELL = join(ROOT, 'helper', 'assets', 'shell.js')

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`PASS ${name}`)
  } else {
    failed += 1
    console.log(`FAIL ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

const src = readFileSync(SHELL, 'utf8')

// ── 1. 顶层 `main()` 调用点必须恰好一个 ───────────────────────────────
//
// 只认「行首无缩进」的调用 —— main() 内部的自递归/测试调用不算。
const callSites = src
  .split(/\r?\n/)
  .map((line, i) => ({ line, no: i + 1 }))
  .filter(({ line }) => /^main\(\)\s*;?\s*$/.test(line))

check('main() 顶层调用点恰好 1 个', callSites.length === 1,
  `实际 ${callSites.length} 个，位于第 ${callSites.map((c) => c.no).join('、')} 行`)

// ── 2. main() 自身必须有幂等守卫 ──────────────────────────────────────
//
// 只查调用点不够：将来有人再写一遍 `main()` 时，
// 有守卫至少不会真的装两套（只会在控制台留一条 warn）。
const hasGuard =
  /main\._done\s*===\s*true/.test(src) &&
  /main\._done\s*=\s*true/.test(src)

check('main() 内有「已装配就return」守卫', hasGuard,
  '缺少 main._done 守卫 —— 重复调用会真的装配两套 UI')

// ── 3. 反向验证：把调用点改回两个，本组必须变红 ──────────────────────
//
// 这条断言防止有人把守卫和调用点一起删掉「顺手清理」。
{
  const doubled = src.replace(/^main\(\)\s*$/m, 'main()\nmain()')
  const doubledCalls = doubled
    .split(/\r?\n/)
    .filter((line) => /^main\(\)\s*;?\s*$/.test(line))
  check('（对照）人为复制调用点后，本探针的计数断言会变红',
    doubledCalls.length === 2, `实际 ${doubledCalls.length} 个 —— 断言没抓住，说明探针失效`)
}

// ── 4. 其它装配型函数不应有多入口 ─────────────────────────────────────
//
// createResizeHandles / createContextMenu 若在 main() 外被调用，
// 同样会造成「两套实例」。这里只做静态提醒性检查：
//
// ★ 2026-10-21 修正：原来这里写死「main() 的行号范围 ≈ 285~2700」，
//   而 shell.js 早就长到 4500+ 行 —— 结果 main() **内部**的
//   createContextMenu(4021) / createResizeHandles(4095) 被误判成「main() 外」，
//   探针红了但产品是好的（典型的「断言过时」）。
//   现在改成真去括号配对，算出 main() 的实际起止行。
{
  const lines = src.split(/\r?\n/)
  const mainStart = lines.findIndex((l) => /^\s*(?:async\s+)?function\s+main\s*\(/.test(l))
  let mainEnd = lines.length
  if (mainStart >= 0) {
    let depth = 0
    let started = false
    for (let i = mainStart; i < lines.length; i += 1) {
      for (const ch of lines[i]) {
        if (ch === '{') { depth += 1; started = true }
        else if (ch === '}') { depth -= 1 }
      }
      if (started && depth === 0) { mainEnd = i + 1; break }
    }
  }
  check('能定位 main() 的实际行号范围（括号配对）', mainStart >= 0 && mainEnd > mainStart,
    `mainStart=${mainStart + 1} mainEnd=${mainEnd}`)

  const factories = ['createResizeHandles', 'createContextMenu', 'createImpressionPanel']
  for (const name of factories) {
    const outside = lines
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => line.includes(`${name}(`) && !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
      .filter(({ no }) => no < mainStart + 1 || no > mainEnd)
    check(`${name} 只在 main() 内构造`, outside.length === 0,
      `main() 外出现 ${outside.length} 次：第 ${outside.map((c) => c.no).join('、')} 行（main 范围 ${mainStart + 1}~${mainEnd}）`)
  }
}

console.log(`\n${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)