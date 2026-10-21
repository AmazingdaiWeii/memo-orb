/**
 * 探针：渲染层右键菜单的行为验证。
 *
 * 验的全是**纯逻辑与 DOM 行为**，不需要显示器，也不需要真球：
 *   - 菜单项规范化（分隔线、禁用、分组、对勾）
 *   - 定位翻转（贴近右/下边缘时不溢出）
 *   - Escape / 点外部关闭
 *   - 输入区右键要让给浏览器默认行为
 *   - 点击回包带对的 action id 与 payload
 *
 * 用法：node probe/context-menu-test.mjs
 *
 * ⚠️ 这个探针验不到「人点得到吗」—— 真实鼠标穿透、原生菜单锚点、
 * 窗口命中判定这些必须在真机验（见 MEMORY.md「探针的固有盲区」）。
 */

import { JSDOM } from 'jsdom'

// context-menu.js 是浏览器模块，直接 import 时拿不到 document/window。
// 所以先建一个 jsdom 页面并把关键全局装上，再 import。
const page = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const W = page.window
for (const key of ['document', 'HTMLElement', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'Node']) {
  globalThis[key] = W[key]
}
Object.defineProperty(globalThis, 'window', { value: W, configurable: true })

const UI = (await import('../helper/assets/context-menu.js')).createContextMenu

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

/**
 * 每个 case 用一个干净的 body。
 * ⚠️ 不能改innerWidth/innerHeight —— jsdom 的 window.innerWidth 只读，
 *    重定义会让依赖它的 `place()` 拿到错值，定位翻转就验不准。
 *    400×400 的默认视口足够小，一样能触发翻转。
 *
 * ⚠️⚠️ jsdom **没有布局引擎**：`getBoundingClientRect()` 恒返回全 0。
 *    `place()` 靠它量菜单尺寸，所以在这个探针里量到的是 0，
 *    翻转分支会**被跳过** —— 直接断言 style.left/top 会得到
 *    `x + gap` 这种「没翻转」的值，看起来像 bug 其实不是。
 *    要验定位逻辑必须先用 `stubRect()` 喂一个假尺寸，见下面 §9。
 */
function newPage() {
  W.document.body.innerHTML = ''
  W.document.querySelectorAll('.ctxmenu, .ctxmenu-backdrop').forEach((n) => n.remove())
  return W
}

/**
 * 给 `.ctxmenu` 喂一个假的布局尺寸，让 `place()` 的翻转逻辑真的跑起来。
 * @param {number} w @param {number} h
 */
function stubRect(w, h) {
  const proto = W.Element.prototype
  const original = proto.getBoundingClientRect
  proto.getBoundingClientRect = function () {
    if (this.classList?.contains('ctxmenu')) {
      return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h }
    }
    return original.call(this)
  }
  return () => { proto.getBoundingClientRect = original }
}

// ── 1. 菜单项规范化与渲染 ────────────────────────────────────────────
{
  const window = newPage()
  const document = window.document
  const got = []
  const menu = UI({ onAction: (id, payload) => got.push({ id, payload }) })
  menu.bind()
  menu.open({
    x: 10,
    y: 10,
    items: [
      { id: 'history.rename', label: '重命名', group: 'act', payload: { sessionId: 'c1' } },
      { id: 'history.lock', label: '锁定', group: 'act', payload: { sessionId: 'c1' } },
      { id: 'history.delete', label: '删除', kind: 'danger', group: 'danger', payload: { sessionId: 'c1' } },
    ],
  })
  const rows = [...document.querySelectorAll('.ctxmenu-item')]
  check('三个菜单项都渲染出来', rows.length === 3, `实际 ${rows.length}`)
  check('danger 类只挂在删除上', rows[2].className.includes('danger') && !rows[0].className.includes('danger'))
  check(
    '同一 group 紧邻项之间不画分隔线',
    document.querySelectorAll('.ctxmenu-sep').length === 1,
    `实际 ${document.querySelectorAll('.ctxmenu-sep').length} 条（预期 1：act 与 danger 之间）`,
  )

  rows[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  check('点击回包带对的 action 与 payload', got.length === 1 && got[0].id === 'history.rename' && got[0].payload.sessionId === 'c1')
  check('点击后菜单关闭', menu.isOpen() === false)
}

// ── 2. 禁用项不触发回调 ─────────────────────────────────────────────
{
  const window = newPage()
  const document = window.document
  let fired = 0
  const menu = UI({ onAction: () => { fired += 1 } })
  menu.bind()
  menu.open({
    x: 5, y: 5,
    items: [
      { id: 'a', label: '可用' },
      { id: 'b', label: '禁用', disabled: true },
    ],
  })
  const rows = [...document.querySelectorAll('.ctxmenu-item')]
  rows[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  check('禁用项点了不回调', fired === 0, `实际回调 ${fired} 次`)
  check('禁用项带 disabled 属性', rows[1].disabled === true)
  check('禁用项不可聚焦', menu.isOpen() && document.activeElement !== rows[1])
}

// ── 3. 定位翻转：贴近右边缘 / 下边缘时不溢出 ────────────────────────
{
  const window = newPage()
  const document = window.document
  const menu = UI({ onAction: () => {} })
  menu.bind()
  menu.open({
    x: 395, y: 395,
    items: [{ id: 'a', label: '一个很长的菜单项标题用来撑宽度测试翻转行为' }],
  })
  const el = document.querySelector('.ctxmenu')
  const left = Number.parseFloat(el.style.left)
  const top = Number.parseFloat(el.style.top)
  check(
    '贴近右下角时翻到指针左上，不溢出',
    left + el.offsetWidth <= 400 && top + el.offsetHeight <= 400,
    `left=${left} top=${top} w=${el.offsetWidth} h=${el.offsetHeight}`,
  )
  check('菜单在视口内可见', el.hidden === false)
}

// ── 4. 关闭路径 ──────────────────────────────────────────────────────
{
  const window = newPage()
  const document = window.document
  const menu = UI({ onAction: () => {} })
  menu.bind()
  menu.open({ x: 1, y: 1, items: [{ id: 'a', label: 'A' }] })
  check('打开后 isOpen 为真', menu.isOpen() === true)

  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  check('Escape 能关闭', menu.isOpen() === false)

  menu.open({ x: 1, y: 1, items: [{ id: 'a', label: 'A' }] })
  // 2026-10-07：不再有 backdrop，改由 document 捕获阶段的 pointerdown 判断落点
  document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))
  check('点在菜单外能关闭', menu.isOpen() === false)

  menu.open({ x: 1, y: 1, items: [{ id: 'a', label: 'A' }] })
  document.querySelector('.ctxmenu').dispatchEvent(
    new window.MouseEvent('pointerdown', { bubbles: true }),
  )
  check('点在菜单内不关闭（否则按下—松开中途菜单消失，点击落空）', menu.isOpen() === true)

  menu.open({ x: 1, y: 1, items: [{ id: 'a', label: 'A' }] })
  menu.close()
  check('close() 直接关', menu.isOpen() === false)
  check('关闭后菜单不留在 DOM 内容里', document.querySelector('.ctxmenu').children.length === 0)
}

// ── 4b. 卡死回归：不得存在任何覆盖全窗口的命中层 ────────────────────
// 2026-10-07 用户实测：球拖到屏幕左下角后彻底失去交互。根因是
// 「点击外部关闭」的 backdrop 用了 position:fixed; inset:0，
// 它盖住球 → 球的 hover/click 全被吞；而窗口的鼠标穿透又会先于
// 点击生效，backdrop 自己的 pointerdown 收不到事件 → 退出通道
// 被自己堵死 → 整块UI 永久自锁。
{
  const window = newPage()
  const document = window.document
  const menu = UI({ onAction: () => {} })
  menu.bind()
  menu.open({ x: 10, y: 10, items: [{ id: 'a', label: 'A' }] })

  // 全窗口命中层的特征：fixed + inset:0（等价于铺满视口）
  const fullBleed = [...document.querySelectorAll('body *')].filter((node) => {
    const style = window.getComputedStyle(node)
    return style.position === 'fixed'
      && (style.top === '0px' || style.left === '0px')
      && node.getBoundingClientRect().width >= window.innerWidth
  })
  check(
    `菜单打开时不存在覆盖全窗口的命中层（找到 ${fullBleed.length} 个：${
      fullBleed.map((n) => n.className || n.tagName).join(',') || '无'
    }）`,
    fullBleed.length === 0,
  )
  check('backdrop 元素已彻底移除', document.querySelector('.ctxmenu-backdrop') === null)
}

// ── 4c. 生命周期钩子：菜单开关必须如实上报给host ────────────────────
// 上一版是「关穿透 + 220ms 无条件恢复」，实测会把球弄死：
// 面板已展开时还恢复穿透，用户看到的就是「亮着但点不动的球」。
// 现在改成 open/close 如实上报，由主进程决定恢复时机。
{
  const window = newPage()
  const log = []
  const menu = UI({
    onAction: () => {},
    onOpen: () => { log.push('open') },
    onClose: () => { log.push('close') },
  })
  menu.bind()

  menu.open({ x: 1, y: 1, items: [{ id: 'a', label: 'A' }] })
  check('打开时上报一次 open', log.join(',') === 'open')

  menu.open({ x: 2, y: 2, items: [{ id: 'b', label: 'B' }] })
  check('已开着时换内容不重复上报 open', log.join(',') === 'open')

  menu.close()
  check('关闭时上报 close', log.join(',') === 'open,close')

  menu.close()
  check('重复 close 不会重复上报', log.join(',') === 'open,close')
}

// ── 5. 空菜单不弹 ───────────────────────────────────────────────────
{
  const window = newPage()
  const menu = UI({ onAction: () => {} })
  menu.bind()
  menu.open({ x: 10, y: 10, items: [] })
  check('空 items 不弹菜单', menu.isOpen() === false)
  menu.open({ x: 10, y: 10 })
  check('没有 items 字段也不弹', menu.isOpen() === false)
}

// ── 6. 输入区 / 划词工具栏要让给浏览器默认右键 ─────────────────────
{
  const window = newPage()
  const document = window.document
  document.body.innerHTML = `
    <div id="prompt" contenteditable="true"></div>
    <textarea id="ta"></textarea>
    <div id="selection-chip"></div>
    <div id="history-list">
      <button class="history-row" data-session-id="c1">会话一</button>
    </div>
  `
  let opened = 0
  let editable = 0
  const menu = UI({
    onAction: () => {},
    onContextMenu: () => { opened += 1 },
    onEditableContextMenu: () => { editable += 1 },
  })
  menu.bind()

  const fire = (selector) => {
    const target = document.querySelector(selector)
    const ev = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    target.dispatchEvent(ev)
    return ev
  }

  const evPrompt = fire('#prompt')
  check('输入区右键不被接管', opened === 0 && evPrompt.defaultPrevented === false)
  const evTextarea = fire('#ta')
  check('textarea 右键不被接管', opened === 0 && evTextarea.defaultPrevented === false)
  const evChip = fire('#selection-chip')
  check('划词 chip 右键不被接管', opened === 0 && evChip.defaultPrevented === false)

  const evRow = fire('.history-row')
  check('历史条目右键被接管', opened === 1 && evRow.defaultPrevented === true)

  // 2026-10-07 用户实测「输入框右键确实无效」。
  // 光「让给浏览器」不够 —— Electron 默认不弹原生右键菜单，
  // 必须显式通知 host 用编辑角色弹一个，否则复制粘贴没法用。
  check(
    `输入区/textarea/划词 chip 都通知了 host 弹编辑菜单（共 ${editable} 次）`,
    editable === 3,
  )
}

// ── 7. 菜单自身内部的右键不被反复接管 ─────────────────────────────
{
  const window = newPage()
  const document = window.document
  let opened = 0
  const menu = UI({ onAction: () => {}, onContextMenu: () => { opened += 1 } })
  menu.bind()
  menu.open({ x: 5, y: 5, items: [{ id: 'a', label: 'A' }] })
  const row = document.querySelector('.ctxmenu-item')
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  check('菜单内部右键不重新弹自己', opened === 0 && menu.isOpen() === true)
}

// ── 8. checked 项显示对勾 ───────────────────────────────────────────
{
  const window = newPage()
  const document = window.document
  const menu = UI({ onAction: () => {} })
  menu.bind()
  menu.open({
    x: 5, y: 5,
    items: [
      { id: 'a', label: '头像', checked: true },
      { id: 'b', label: '普通' },
    ],
  })
  const labels = [...document.querySelectorAll('.ctxmenu-label')].map((n) => n.textContent)
  check('checked 项带对勾', labels[0].includes('✓'), `实际「${labels[0]}」`)
  check('未选中项没有对勾', !labels[1].includes('✓'))
}

// ── 9. 定位兜底：贴边 / 菜单比视口还大都不能跑到窗口外 ───────────────
// 2026-10-07 用户实测的卡死触发条件之一就是「球放在屏幕左下角」。
{
  const window = newPage()
  const document = window.document
  const menu = UI({ onAction: () => {} })
  menu.bind()

  // 菜单真实尺寸约 172×120（CSS min-width/max-width 给的量级）
  const restore = stubRect(172, 120)
  const at = () => {
    const el = document.querySelector('.ctxmenu')
    return { left: parseFloat(el.style.left) || 0, top: parseFloat(el.style.top) || 0 }
  }
  const inView = (p) => p.left >= 0 && p.top >= 0
    && p.left < window.innerWidth && p.top < window.innerHeight

  try {
    // 左下角：必须向上翻转，且不越出上边界
    menu.open({ x: 2, y: window.innerHeight - 2, items: [{ id: 'a', label: 'A' }] })
    let p = at()
    check(
      `左下角时翻到指针上方且不出界（left=${p.left} top=${p.top} vw=${window.innerWidth} vh=${window.innerHeight}）`,
      inView(p) && p.top < window.innerHeight - 2,
    )
    menu.close()

    // 右上角：必须向左翻转
    menu.open({ x: window.innerWidth - 2, y: 2, items: [{ id: 'a', label: 'A' }] })
    p = at()
    check(
      `右上角时翻到指针左方且不出界（left=${p.left} top=${p.top}）`,
      inView(p) && p.left < window.innerWidth - 2,
    )
    menu.close()

    // 视口正中：右下偏移，不翻转
    menu.open({
      x: Math.round(window.innerWidth / 2),
      y: Math.round(window.innerHeight / 2),
      items: [{ id: 'a', label: 'A' }],
    })
    p = at()
    check(
      `视口正中时落在指针右下（left=${p.left} top=${p.top}）`,
      p.left > Math.round(window.innerWidth / 2) && p.top > Math.round(window.innerHeight / 2),
    )
    menu.close()

    // 菜单比整个视口还大：翻转后仍要夹回可视区（不能出现负值）
    restore()
    stubRect(window.innerWidth + 200, window.innerHeight + 200)
    menu.open({ x: 4, y: window.innerHeight - 4, items: [{ id: 'a', label: 'A' }] })
    p = at()
    check(`菜单比视口大时仍被夹进可视区（left=${p.left} top=${p.top}）`, p.left >= 0 && p.top >= 0)
    menu.close()

    // 坐标为 0（|| fallback 分支）也不能算出负值
    menu.open({ x: 0, y: 0, items: [{ id: 'a', label: 'A' }] })
    p = at()
    check(`指针在原点时不出界（left=${p.left} top=${p.top}）`, p.left >= 0 && p.top >= 0)
  } finally {
    restore()
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────────
console.log(`\n${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)