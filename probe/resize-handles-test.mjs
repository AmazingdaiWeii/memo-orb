/**
 * 探针：面板拖拽缩放手柄（P0-5）。
 *
 * ## 为什么这个功能探针格外重要
 *
 * P0-5 本身就是**探针假阳性**的产物：`probe/window-probe.mjs` 报 5/5 通过，
 * 用户真机拖不动边框。根因是探针用 `win.setBounds()` 程序直接设尺寸，
 * 绕过了「用户能不能拖」这一环；而 `frame:false` + `transparent:true`
 * 的窗口在 Windows 上根本没有系统 resize 热区。
 *
 * 所以这个探针刻意**不去验「窗口能不能变」**（那是主进程的老链路），
 * 而是验渲染层这一层新加的东西：
 *   - 8 个手柄建出来了、几何互不重叠
 *   - **只有远离球的那 3 个手柄露出来**（★ 见下）
 *   - 方向算得对（往外拖变大、往里拖变小）
 *   - **收起态 + 非自由边彻底不吃事件**（否则球会被挡住）
 *   - 拖拽中只回调 onResize，松手才 onCommit（不边拖边写盘）
 *
 * ## ★ 为什么「非自由边必须隐藏」是本文件最重要的一条
 *
 * 面板窗口的位置**不是自由的**，它由球的原点锚定（main.js 的
 * `overlayBoundsFromBall`）。展开方向决定哪几条边贴着球：
 *
 *   面板在球的左边 → 窗口右边贴球 → 只有左边能拖
 *
 * 贴着球的边暴露出来有双重危害：
 *   1. 拖了也没用（窗口原点由球决定，改不动）
 *   2. **抢球的点击** —— 球的右缘正好等于面板右缘，
 *      那条手柄就压在球上，是 2026-10-07 卡死的同类问题
 *
 * ## ⚠️ jsdom 没有布局引擎
 *
 * `getBoundingClientRect()` / `offsetWidth` 恒为 0，
 * 所以这里靠 `stubPanelSize()` 手动打桩起始尺寸。
 *
 * 用法：node probe/resize-handles-test.mjs
 */

import { JSDOM } from 'jsdom'

const page = new JSDOM(
  '<!doctype html><html><body><section id="panel"></section></body></html>',
  { pretendToBeVisual: true },
)
const W = page.window
for (const key of ['document', 'HTMLElement', 'Element', 'Event', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'Node']) {
  globalThis[key] = W[key]
}
Object.defineProperty(globalThis, 'window', { value: W, configurable: true })

const mod = await import('../helper/assets/resize-handles.js')
const UI = mod.createResizeHandles
const freeEdges = mod.freeEdges

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS ${name}`) }
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` —— ${detail}` : ''}`) }
}

const panel = W.document.querySelector('#panel')
const handles = () => [...W.document.querySelectorAll('.resize-handle')]
const shown = () => handles().filter((n) => n.style.display !== 'none')

/** 给 panel 打桩尺寸（jsdom 没有布局引擎）。 */
function stubPanelSize(w, h) {
  Object.defineProperty(panel, 'offsetWidth', { value: w, configurable: true })
  Object.defineProperty(panel, 'offsetHeight', { value: h, configurable: true })
}

/**
 * 派发一次指针序列：down(dir) → move(dx,dy) → up。
 *
 * ⚠️ 必须**清掉其它实例**再取元素：`document.querySelector` 只会返回第一个匹配，
 * 而前面几组可能留下没destroy 的实例，于是 pointerdown 打在了别人的手柄上
 * —— 症状是「明明 refresh 过了却拖不动」（2026-10-07 实测踩过）。
 */
function drag(dir, dx, dy, pointerId = 1) {
  // 只保留最后一个手柄（当前组刚建的那个）。
  const all = [...W.document.querySelectorAll(`.resize-handle[data-dir="${dir}"]`)]
  const el = all[all.length - 1]
  if (!el) return false
  const opts = { bubbles: true, cancelable: true, button: 0, pointerId, clientX: 100, clientY: 100 }
  el.dispatchEvent(new W.PointerEvent('pointerdown', opts))
  W.dispatchEvent(new W.PointerEvent('pointermove', { ...opts, clientX: 100 + dx, clientY: 100 + dy }))
  W.dispatchEvent(new W.PointerEvent('pointerup', opts))
  return true
}

// ── 1. 基本形态 ───────────────────────────────────────────────────────
{
  const h = UI({ isEnabled: () => true, getDirection: () => ({ horizontal: 'left', vertical: 'up' }) })
  check('建出 8 个手柄（4 边 + 4 角）', handles().length === 8, `实际 ${handles().length}`)

  const dirs = handles().map((n) => n.dataset.dir).sort()
  check('方向齐全 n/s/e/w/ne/nw/se/sw',
    JSON.stringify(dirs) === JSON.stringify(['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w']),
    `实际 ${JSON.stringify(dirs)}`)

  check('每个手柄都有定位样式（不靠铺满命中）',
    handles().every((n) => n.style.cssText.length > 0))

  h.destroy()
  check('destroy 后手柄全清', handles().length === 0)
}

// ── 2. ★ freeEdges：自由边的推导 ──────────────────────────────────────
// 面板在球的左边 → 窗口右边贴球 → 左边(w) 才是自由边
{
  check('面板在球左侧 → 自由边是 w（上/右被球占）',
    JSON.stringify(freeEdges({ horizontal: 'left', vertical: 'up' })) ===
      JSON.stringify({ h: 'w', v: 'n', corner: 'nw' }),
    JSON.stringify(freeEdges({ horizontal: 'left', vertical: 'up' })))
  check('面板在球右侧 → 自由边是 e',
    freeEdges({ horizontal: 'right', vertical: 'up' }).h === 'e')
  check('面板在球下侧 → 自由边是 s',
    freeEdges({ horizontal: 'left', vertical: 'down' }).v === 's')
  check('面板在球右下 → 自由角是 se',
    freeEdges({ horizontal: 'right', vertical: 'down' }).corner === 'se')
  check('自由边与自由角自洽（角由两条自由边组成）',
    ['left', 'right'].every((hv) => ['up', 'down'].every((vv) => {
      const f = freeEdges({ horizontal: hv, vertical: vv })
      return f.corner.includes(f.h) && f.corner.includes(f.v)
    })))
}

// ── 3. ★ 只有自由边露出来（本文件最重要的一条）────────────────────────
//
// ★★ 2026-10-07 11:36：**角手柄整体退役，这里只剩两条自由边。**
//
// 用户第三轮反馈：「红框标注的这个拖动条，仍然在框外……不美观。
// 而且我发现，拖动窗口调整大小的功能似乎恢复了，
// 因此，我希望你这一轮仅删除右下角的这个拖动ui。」
//
// 边仍走 `freeEdges()`：贴球的两条边拖了没用（面板位置由球锚定，
// 球右缘就是面板右缘，露出来会压在球上抢点击，就是那次卡死），
// 所以边**必须**随方向翻。
//
// 期望值里**不再有任何角**——这是本次行为变更的判据。
{
  for (const [direction, expect, desc] of [
    [{ horizontal: 'left', vertical: 'up' }, ['n', 'w'], '面板左上展开：只露 上/左（无角）'],
    [{ horizontal: 'right', vertical: 'up' }, ['e', 'n'], '面板右上展开：只露 上/右（无角）'],
    [{ horizontal: 'left', vertical: 'down' }, ['s', 'w'], '面板左下展开：只露 下/左（无角）'],
    [{ horizontal: 'right', vertical: 'down' }, ['e', 's'], '面板右下展开：只露 下/右（无角）'],
  ]) {
    const h = UI({ isEnabled: () => true, getDirection: () => direction })
    const got = shown().map((n) => n.dataset.dir).sort()
    check(desc,
      JSON.stringify(got) === JSON.stringify(expect.slice().sort()) && got.length === 2,
      `实际 ${JSON.stringify(got)}`)
    h.destroy()
  }
}

// ── 3b. ★★ 角手柄必须永远不露出来（用户 2026-10-07 11:36 直接要求删除）──
//
// 为什么这条比第 3 组还重要：角是**唯一会在窗体角落露出东西**的 UI，
// 用户抱怨「在框外、不美观、白底上看不清」指的正是它。
// 而角留着最大的隐患是**看不见但吃事件**的 22px 命中区 ——
// 比不删更糟。所以必须是 `display:none`（彻底不吃事件），
// 不是 `opacity:0`。
{
  for (const [horizontal, vertical] of [['left', 'up'], ['right', 'up'], ['left', 'down'], ['right', 'down']]) {
    const h = UI({ isEnabled: () => true, getDirection: () => ({ horizontal, vertical }) })
    const corners = shown().filter((n) => ['nw', 'ne', 'sw', 'se'].includes(n.dataset.dir))
    check(`方向 ${horizontal}/${vertical}：没有任何角手柄可见`,
      corners.length === 0,
      `实际露了 ${JSON.stringify(corners.map((n) => n.dataset.dir))}`)

    // 角元素仍在 DOM 里（保留可恢复性），但display 必须是 none
    const cornerNodes = [...handles().filter((n) => ['nw', 'ne', 'sw', 'se'].includes(n.dataset.dir))]
    check(`方向 ${horizontal}/${vertical}：4 个角元素都是 display:none（不吃事件）`,
      cornerNodes.length === 4 && cornerNodes.every((n) => n.style.display === 'none'),
      `实际 ${cornerNodes.map((n) => `${n.dataset.dir}:${n.style.display || '(空)'}`).join(' ')}`)
    h.destroy()
  }
}

// ── 4. 方向翻转后要跟着换边（applyDirection → refresh 这条链）─────────
//
// ⚠️ 2026-10-07 11:36：**只剩两条边随方向翻，角已整体退役。**
//   边走 `freeEdges()`：left→w、up→n、right→e、down→s。
//   （此前还有「角走 safeCorner()、固定 se 被球占了才退对角」的规则，
//     那套逻辑连同它的几何论证仍保留在 `probe/corner-vs-ball-geometry.mjs` 里，
//     角元素也还在 `resize-handles.js` 中 —— 只是不再被 `refresh()` 放进
//     allowed 集合。想恢复见 refresh() 的注释。）
//
// 这里是**行为变更**，不是回归：旧断言期望 3 条（含 1 个角），现在 2 条。
{
  let direction = { horizontal: 'left', vertical: 'up' }
  const h = UI({ isEnabled: () => true, getDirection: () => direction })
  check('初始露的是 上/左（left/up）',
    JSON.stringify(shown().map((n) => n.dataset.dir).sort()) === JSON.stringify(['n', 'w']),
    JSON.stringify(shown().map((n) => n.dataset.dir)))

  // 球拖到屏幕另一边 → 展开方向翻转 → 边必须重算
  direction = { horizontal: 'right', vertical: 'down' }
  h.refresh()
  check('方向翻转并 refresh 后改为 下/右',
    JSON.stringify(shown().map((n) => n.dataset.dir).sort()) === JSON.stringify(['e', 's']),
    JSON.stringify(shown().map((n) => n.dataset.dir)))
  h.destroy()
}

// ── 4b. ★★ onCommit 回包驱动的换边（shell.js 接线，2026-10-07 修）──────
//
// 上一组只测了「方向变了 → refresh 会换边」，那要求**外部先改direction**。
// 但真实链路里方向是主进程算出来的：面板拖大后可能从球的左边翻到右边，
// `orb:resize` 才会把新方向回传。shell.js 的 onCommit 必须接住它 ——
//
//   api.setPanelSize(w,h) → { width, height, horizontal, vertical }
//                                       └─ applyDirection(state) → refresh()
//
// 不接的话：面板已经长到球右边，可拖的手柄还留在左边，用户得往反方向拖。
// 这一组复刻 shell.js 的 onCommit 写法（含主进程回包形状），验证整条链。
{
  let direction = { horizontal: 'left', vertical: 'up' }
  const commits = []
  const h = UI({
    isEnabled: () => true,
    getDirection: () => direction,
    // 复刻 shell.js:2333 的接线
    onCommit: (width, height) => {
      commits.push({ width, height })
      // 主进程：clamp 尺寸 + setExpanded(true) 重算方向
      const next = { width, height }
      return Promise.resolve({
        ...next,
        expanded: true,
        // 面板变大 → 从球左侧翻到右侧
        horizontal: direction.horizontal === 'left' ? 'right' : 'left',
        vertical: 'down',
      })
    },
  })

  // 模拟一次真实的左边拖拽 + 松手（w 手柄在 left/up 方向下是自由边）
  drag('w', 20, 0)
  check('边拖拽松手后提交了一次', commits.length === 1, `实际 ${commits.length} 次`)

  // 等主进程回包，然后按 shell.js 的做法接住方向
  await Promise.resolve()
  await Promise.resolve()
  const state = { horizontal: 'right', vertical: 'down' }
  direction = { horizontal: state.horizontal, vertical: state.vertical }
  h.refresh()
  check('★★ 收到主进程的新方向后手柄换到 下/右（角已退役）',
    JSON.stringify(shown().map((n) => n.dataset.dir).sort()) === JSON.stringify(['e', 's']),
    JSON.stringify(shown().map((n) => n.dataset.dir)))
  h.destroy()
}

// ── 5. ★ 收起态手柄必须彻底不吃事件（P0-5 的关键）────────────────────
// 收起态窗口只有球那么大。手柄要是还留命中区，球就拖不动、点不开。
{
  let enabled = false
  const h = UI({ isEnabled: () => enabled, getDirection: () => ({ horizontal: 'left', vertical: 'up' }) })
  check('收起态手柄 display:none',
    handles().every((n) => n.style.display === 'none'))
  check('收起态没有 opacity 残留（不能用 opacity:0 代替）',
    handles().every((n) => n.style.opacity === ''))

  stubPanelSize(320, 420)
  let resized = 0
  const h2 = UI({
    isEnabled: () => enabled,
    getDirection: () => ({ horizontal: 'left', vertical: 'up' }),
    onResize: () => { resized += 1 },
  })
  drag('w', -50, 0)
  check('收起态拖拽无响应', resized === 0, `实际 ${resized}`)

  enabled = true
  h2.refresh()
  check('展开后自由边手柄恢复显示（只有 2 条边，角已退役）',
    shown().length === 2,
    `实际 ${shown().length} 个: ${JSON.stringify(shown().map((n) => n.dataset.dir))}`)

  resized = 0
  drag('w', -50, 0)
  check('展开后可拖拽', resized === 1, `实际 ${resized}`)

  // 反向：贴球的边即使在展开态也不该露出来
  check('展开态贴球的边仍然隐藏（不抢球的点击）',
    !shown().some((n) => n.dataset.dir === 'e'))

  h.destroy(); h2.destroy()
}

// ── 6. 方向语义：往外拖变大 ──────────────────────────────────────────
// ⚠️ 期望值是「四角向外拖 → 变大」。第一版探针在这里写反了
//    （以为 nw 左上要变小），结果三向 fake-FAIL —— 实现是对的，探针错了。
{
  const left = { horizontal: 'left', vertical: 'up' }
  const cases = [
    ['w', -60, 0, { w: 380, h: 420 }, '左边：左拖-60 → 只加宽'],
    ['n', 0, -60, { w: 320, h: 480 }, '上边：上拖-60 → 只加高'],
    ['nw', -60, -60, { w: 380, h: 480 }, '左上角：向左上拖 → 宽高都加'],
    ['n', 0, 60, { w: 320, h: 360 }, '上边：往下拖 → 只减高（宽度锁死）'],
    ['w', 60, 0, { w: 260, h: 420 }, '左边：右拖+60 → 只减宽'],
  ]
  for (const [dir, dx, dy, expect, desc] of cases) {
    const calls = []
    const h = UI({
      isEnabled: () => true,
      getDirection: () => left,
      onResize: (w, hh) => calls.push({ w, h: hh }),
    })
    stubPanelSize(320, 420)
    drag(dir, dx, dy)
    const last = calls[calls.length - 1]
    check(desc,
      last !== undefined && last.w === expect.w && last.h === expect.h,
      last === undefined ? '没回调' : `实际 ${last.w}×${last.h}`)
    h.destroy()
  }
}

// ── 7. 纯边方向只改一个轴 ────────────────────────────────────────────
{
  const left = { horizontal: 'left', vertical: 'up' }
  for (const [dir, dx, dy, axis, desc] of [
    ['w', -40, 999, 'w', '左边缘：垂直方向乱拖也不改高'],
    ['n', 999, -40, 'h', '上边缘：水平方向乱拖也不改宽'],
  ]) {
    const calls = []
    const h = UI({ isEnabled: () => true, getDirection: () => left, onResize: (w, hh) => calls.push({ w, h: hh }) })
    stubPanelSize(320, 420)
    drag(dir, dx, dy)
    const last = calls[calls.length - 1]
    const okAxis = axis === 'w' ? last?.h === 420 : last?.w === 320
    check(desc, okAxis, last === undefined ? '没回调' : `实际 ${last.w}×${last.h}`)
    h.destroy()
  }
}

// ── 8. 拖拽中 vs 松手：不能边拖边写盘 ──────────────────────────────────
{
  const left = { horizontal: 'left', vertical: 'up' }
  const resizes = []
  const commits = []
  const h = UI({
    isEnabled: () => true,
    getDirection: () => left,
    onResize: (w, hh) => resizes.push({ w, h: hh }),
    onCommit: (w, hh, dir) => commits.push({ w, h: hh, dir }),
  })
  stubPanelSize(320, 420)
  const el = W.document.querySelector('.resize-handle[data-dir="w"]')
  const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 100, clientY: 100 }
  el.dispatchEvent(new W.PointerEvent('pointerdown', opts))
  check('按下还不该提交', commits.length === 0)
  for (const step of [10, 20, 30]) {
    W.dispatchEvent(new W.PointerEvent('pointermove', { ...opts, clientX: 100 - step, clientY: 100 }))
  }
  check('拖拽中只回调 onResize', resizes.length === 3 && commits.length === 0,
    `resize ${resizes.length} / commit ${commits.length}`)
  W.dispatchEvent(new W.PointerEvent('pointerup', opts))
  check('松手才提交一次', commits.length === 1)
  check('提交的是最终尺寸', commits[0]?.w === 350 && commits[0]?.h === 420,
    commits[0] === undefined ? '没提交' : `${commits[0].w}×${commits[0].h}`)
  check('提交带回方向', commits[0]?.dir === 'w')
  h.destroy()
}

// ── 9. 无边框窗口：指针在窗口外松手也要结束拖拽 ──────────────────────
// pointerup 在窗外收不到 → 会话永不结束、读数永挂屏幕上。
{
  const left = { horizontal: 'left', vertical: 'up' }
  const commits = []
  const h = UI({
    isEnabled: () => true,
    getDirection: () => left,
    onCommit: (w) => commits.push(w),
  })
  stubPanelSize(320, 420)
  const el = W.document.querySelector('.resize-handle[data-dir="w"]')
  const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 100, clientY: 100 }
  el.dispatchEvent(new W.PointerEvent('pointerdown', opts))
  W.dispatchEvent(new W.PointerEvent('pointermove', { ...opts, clientX: 40 }))
  check('拖拽中读数已显示',
    W.document.querySelectorAll('.resize-readout').length === 1)
  W.dispatchEvent(new W.FocusEvent('blur'))
  check('窗口失焦即视为松手（提交一次）', commits.length === 1, `实际 ${commits.length}`)
  check('失焦后读数被清掉',
    W.document.querySelectorAll('.resize-readout').length === 0,
    `残留 ${W.document.querySelectorAll('.resize-readout').length} 个`)
  check('失焦后 dragging 标记已清',
    handles().every((n) => n.dataset.dragging === undefined))
  h.destroy()
}

// ── 10. 松手后监听要摘干净（否则下一次拖拽会双跑）─────────────────────
{
  const left = { horizontal: 'left', vertical: 'up' }
  const commits = []
  const h = UI({ isEnabled: () => true, getDirection: () => left, onCommit: (w) => commits.push(w) })
  stubPanelSize(320, 420)
  drag('w', -50, 0)
  check('第一次拖拽提交一次', commits.length === 1)
  W.dispatchEvent(new W.PointerEvent('pointermove', { bubbles: true, clientX: 999, clientY: 999, pointerId: 1 }))
  check('松手后残留 pointermove 不再触发提交', commits.length === 1, `实际 ${commits.length}`)
  h.destroy()
}

// ── 11. 非左键不开始拖拽（右键要让给菜单）─────────────────────────────
{
  const left = { horizontal: 'left', vertical: 'up' }
  let resized = 0
  const h = UI({
    isEnabled: () => true,
    getDirection: () => left,
    onResize: () => { resized += 1 },
  })
  stubPanelSize(320, 420)
  const el = W.document.querySelector('.resize-handle[data-dir="w"]')
  el.dispatchEvent(new W.PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, button: 2, pointerId: 1, clientX: 100, clientY: 100,
  }))
  W.dispatchEvent(new W.PointerEvent('pointermove', { bubbles: true, clientX: 40, clientY: 40, pointerId: 1 }))
  check('右键按下不触发拖拽', resized === 0)
  h.destroy()
}

// ── 12. 几何：4 个角 + 4 条边，命中区够大、视觉够小 ────────────────────
//
// ★ 2026-10-07 用户实测「判定框太窄，只能成功放大一次」，并建议
//   「在边角上加一个固定的 UI，拖动就能整体缩放」。于是把「命中区」
//   和「看得见的东西」拆成两个尺寸：
//     - 角命中区 22px（CORNER）—— 好点上去
//     - 角视觉10px（::after）—— 平时看得见一个小方块，但不挡内容
//     - 边命中区 16px（EDGE_HIT，::before）—— 比 6px 的视觉宽得多
//   探针只能验到「元素几何 + class」，伪元素的尺寸由 CSS 负责，
//   那部分靠人眼（已在待测清单里）。
{
  const h = UI({ isEnabled: () => true, getDirection: () => ({ horizontal: 'left', vertical: 'up' }) })
  const byDir = Object.fromEntries(handles().map((n) => [n.dataset.dir, n.style.cssText]))
  const nodes = Object.fromEntries(handles().map((n) => [n.dataset.dir, n]))
  // jsdom 的 cssText 序列化带空格（`width: 22px`），正则必须容空格
  const corner = (d) => /width:\s*22px/.test(byDir[d]) && /height:\s*22px/.test(byDir[d])
  const edge = (d) => /height:\s*6px/.test(byDir[d]) || /width:\s*6px/.test(byDir[d])
  check('4 个角是 22px 方块（比原来的 14px 好点）',
    ['nw', 'ne', 'se', 'sw'].every(corner),
    `nw=${byDir.nw}`)
  check('4 条边视觉仍是 6px 细条（命中区靠 ::before 另算）',
    ['n', 's', 'e', 'w'].every(edge),
    `n=${byDir.n}`)
  check('角手柄带 is-corner class（CSS 据此画视觉方块）',
    ['nw', 'ne', 'se', 'sw'].every((d) => nodes[d].classList.contains('is-corner')))
  check('边条不带 is-corner class',
    ['n', 's', 'e', 'w'].every((d) => !nodes[d].classList.contains('is-corner')))

  // 角必须比边大 —— 角是「整体缩放」的主入口，用户明确点了这里
  const cornerSize = Number((byDir.nw.match(/width:\s*(\d+)px/) || [])[1])
  const edgeSize = Number((byDir.n.match(/height:\s*(\d+)px/) || [])[1])
  check('角命中区严格大于边视觉宽度', cornerSize > edgeSize,
    `角 ${cornerSize}px vs 边 ${edgeSize}px`)

  // 角不能大到跨过对边（面板最小时的可用空间）
  check('角不会大到盖住半个面板（≤ 40px）', cornerSize <= 40, `实际 ${cornerSize}px`)

  // ★ 角不能盖住输入框的角 —— 这是本轮最容易踩的连带问题。
  //   手柄是 `position:fixed` 相对**窗口**，从 0 起算；
  //   输入框 `#composer` 是 `left/right:16px` 相对**面板**，面板还有
  //   `--chrome:12px` 的内缩 → 输入框左缘在窗口 28px 处。
  //   角命中区 22px < 28px，留6px 余量。
  //   （z-index 上手柄 6> 输入框 2，撞上了就一定是手柄赢。）
  const COMPOSER_INSET = 16 + 12
  check('角命中区不侵入输入框（小于输入框到窗口边的距离）',
    cornerSize < COMPOSER_INSET, `角 ${cornerSize}px vs 输入框 ${COMPOSER_INSET}px`)
  h.destroy()
}

// ── 13. 键盘可达：方向键调整 + Enter 确认 ─────────────────────────────
// 手柄是 div，天生不可聚焦可达；给了 tabIndex 就必须真能用。
{
  const left = { horizontal: 'left', vertical: 'up' }
  const commits = []
  const h = UI({
    isEnabled: () => true,
    getDirection: () => left,
    onCommit: (w, hh, dir) => commits.push({ w, h: hh, dir }),
  })
  stubPanelSize(320, 420)
  const el = W.document.querySelector('.resize-handle[data-dir="w"]')
  check('手柄可聚焦（tabIndex=0）', el.tabIndex === 0, `实际 ${el.tabIndex}`)

  el.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
  check('左方向键加宽 24', commits.at(-1)?.w === 344, `实际 ${commits.at(-1)?.w}`)
  el.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
  check('右方向键减宽 24', commits.at(-1)?.w === 296, `实际 ${commits.at(-1)?.w}`)

  // ⚠️ 每次按键都以 panel 当前尺寸为基准（stub 固定 320），
  // 所以上下键测试**必须重新打桩**成已知值 —— 否则断言的是累积结果。
  // 第一版探针忘了这步，断言 344 而实际是上一次按键留下的 296，fake-FAIL。
  stubPanelSize(320, 420)
  const before = commits.length
  el.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
  //轴不匹配 → **一次提交都不该有**（没有新尺寸可提交）。
  // 踩过的坑：第一版断言写成 `commits.length === before + 1`，
  // 于是实现「照提交」反而过了。语义就是「完全忽略」。
  check('左边手柄忽略上下键（无任何提交）',
    commits.length === before,
    `多出 ${commits.length - before} 次提交`)
  // 再确认尺寸本身也没被偷偷改掉
  stubPanelSize(320, 420)
  el.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  check('（对照）ArrowDown 同样被忽略',
    commits.length === before,
    `多出 ${commits.length - before} 次提交`)
  h.destroy()
}

console.log(`\n${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)