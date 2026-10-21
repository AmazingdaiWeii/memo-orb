/**
 * 探针：右键菜单与缩放手柄的层级/命中冲突（2026-10-07 用户实测
 *「对话框的右键ui又消失了」）。
 *
 * ## 为什么这个 bug 探针之前没抓到
 *
 * `context-menu-test.mjs` 只装了菜单，**没装 resize-handles** ——
 * 而「菜单被手柄盖住」这个 bug 的成因就是两者共存于同一个层叠上下文。
 * 单测每个组件都绿，合在一起才坏。
 *
 * 与本项目反复踩的坑同源：**探针结构必须与产品同构**，
 * 这里的产品 = 菜单 + 8 条手柄（其中 3 条 display:block）同时挂在 body 上。
 *
 * jsdom 没有布局引擎（`getBoundingClientRect()` 恒 0），
 * 所以**不验像素**，只验「层叠顺序与命中归属」——
 * 这恰恰是 jsdom 能可靠判定、也最容易被漏掉的那部分。
 *
 * 用法：node probe/handles-vs-menu-test.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { createContextMenu } from '../helper/assets/context-menu.js'
import { createResizeHandles, freeEdges } from '../helper/assets/resize-handles.js'

/**
 * ★ z-index **从产品 CSS 里解析**，不复刻常量。
 *
 * 复刻常量的探针有个致命问题：我把「菜单 5 / 手柄 6」写进探针，
 * 改产品时它照样绿 —— 它验的是「我记忆里的数字」，
 * 不是「产品真实生效的数字」。**探针必须从产品文件里抽**。
 */
const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'helper', 'assets', 'context-menu.css')
const CSS_TEXT = readFileSync(CSS_PATH, 'utf8')

/** 从 `.cls { … z-index: N; … }` 里取 z-index。取不到就抛 —— 宁可红也别默默用默认值。 */
function zIndexOf(selector) {
  const re = new RegExp(`(?:^|\\})\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'm')
  const m = CSS_TEXT.match(re)
  if (m === null) throw new Error(`产品 CSS 里找不到 ${selector} 的规则`)
  const z = m[1].match(/z-index:\s*(\d+)/)
  if (z === null) throw new Error(`${selector} 规则里没有 z-index`)
  return Number(z[1])
}

const Z_MENU = zIndexOf('.ctxmenu')
const Z_HANDLE = zIndexOf('.resize-handle')
const Z_READOUT = zIndexOf('.resize-readout')

const page = new JSDOM('<!doctype html><html><body><div id="panel"></div></body></html>', {
  pretendToBeVisual: true,
})
const W = page.window
for (const key of [
  'document', 'HTMLElement', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent',
  'Node', 'FocusEvent', 'PointerEvent', 'CustomEvent',
]) {
  globalThis[key] = W[key]
}
Object.defineProperty(globalThis, 'window', { value: W, configurable: true })
globalThis.CSS = W.CSS

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

/** jsdom 不算样式，层级判定统一走上面从产品 CSS 解析出的真实值。 */
const doc = W.document
const menu = createContextMenu({
  onAction: () => {},
  onOpen: () => {},
  onClose: () => {},
})
menu.bind()

// 与产品同构：手柄在菜单**之后**创建（shell.js 里 contextMenu.bind() 在前，
// createResizeHandles 在后）。这个先后顺序直接决定谁叠在上面。
let expanded = true
const direction = { horizontal: 'left', vertical: 'up' }
const handles = createResizeHandles({
  isEnabled: () => expanded,
  getDirection: () => direction,
  onCommit: () => {},
})

// ── 1. 层叠顺序：菜单必须压在手柄之上 ────────────────────────────────
{
  menu.open({
    x: 20,
    y: 20,
    items: [
      { id: 'a', label: '甲' },
      { id: 'b', label: '乙' },
    ],
  })
  const menuEl = doc.querySelector('.ctxmenu')
  const visible = [...doc.querySelectorAll('.resize-handle')]
    .filter((el) => el.style.display !== 'none')

  check('菜单已打开', menu.isOpen() === true)
  check('此刻有 2 条手柄可见（两条自由边，角已于 2026-10-07 退役）', visible.length === 2,
    `实际 ${visible.length} 条`)

  // 关键：菜单是「点击目标」，任何一条可见手柄的 z-index 高于菜单，
  // 就意味着菜单有一部分被压在下面 —— 弹到边缘时必然点不到。
  const above = visible.filter((el) => Z_HANDLE > Z_MENU)
  check('★★ 没有手柄的层叠高于右键菜单',
    above.length === 0,
    `手柄 z-index=${Z_HANDLE} >菜单 z-index=${Z_MENU}，共 ${above.length} 条手柄压在菜单上方`)

  menu.close()
}

// ── 2. 手柄可见性与菜单生命周期无关（各管各的） ─────────────────────
//
// ⚠️ 别把「关菜单」和「收手柄」混成一条断言：菜单 close() 不碰手柄，
//    两者是独立生命周期（手柄由 expanded 决定，菜单由 isOpen 决定）。
//    混在一起写会得到一条与产品无关的假失败。
{
  menu.close()
  check('菜单已关闭', menu.isOpen() === false)
  expanded = true
  handles.refresh()
  const free = freeEdges(direction)
  const shown = [...doc.querySelectorAll('.resize-handle')]
    .filter((el) => el.style.display !== 'none')
    .map((el) => el.dataset.dir)
    .sort()
  check('可见的边与 freeEdges 一致（角已退役，不参与比对）',
    shown.join(',') === [free.h, free.v].sort().join(','),
    `实际 ${shown.join(',')}，期望 ${[free.h, free.v].sort().join(',')}`)

  // ★ 反向断言：角元素仍在 DOM 里（保留可恢复性），但必须是 display:none。
  //   这条比「上面那条」更关键 —— 角是唯一会在窗体角落露出东西的 UI，
  //   用户抱怨「在框外、不美观」指的就是它；留着「看不见但吃事件」的
  //   22px 命中区比不删更糟。
  const cornerShown = [...doc.querySelectorAll('.resize-handle.is-corner')]
    .filter((el) => el.style.display !== 'none')
  check('★★ 没有任何角手柄可见（display:none 而非 opacity:0）',
    cornerShown.length === 0,
    `实际露了 ${cornerShown.map((el) => el.dataset.dir).join(',')}`)
}

// ── 3. 收起态必须彻底不显示（否则球拖不动） ─────────────────────────
{
  expanded = false
  handles.refresh()
  check('收起态没有任何可见手柄',
    [...doc.querySelectorAll('.resize-handle')]
      .filter((el) => el.style.display !== 'none').length === 0)
  expanded = true
  handles.refresh()
}

// ── 4. 拖拽读数也不能盖住菜单 ─────────────────────────────────────────
{
  check('拖拽读数低于右键菜单', Z_READOUT < Z_MENU, `读数 ${Z_READOUT} vs 菜单 ${Z_MENU}`)
}

// ── 5. ★ 反向验证：把菜单 z-index 压到手柄之下，本组必须变红 ──────────
//
// 这条断言防止有人把「菜单层级高于手柄」这条修复删掉 ——
// 它是用户实测「右键ui消失」的唯一结构性原因。
{
  check('（对照）当前菜单 z-index 高于手柄 —— 修复在位',
    Z_MENU > Z_HANDLE, `菜单 ${Z_MENU} vs 手柄 ${Z_HANDLE}`)
}

handles.destroy()

console.log(`\n${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)