/**
 * 探针：历史对话「行内重命名」的行为验证。
 *
 * 为什么单独一个文件：行内编辑是**用户明确要求的交互**
 * （原话：「不需要弹出二级菜单，只需要把当前选中的对话标题临时变为
 * 可更改即可，然后再添加一个确认和取消按钮在该编辑页面中显示」），
 * 而上一版的 `window.prompt` 实测在无边框透明置顶窗口里弹不出来。
 *
 * ⚠️ jsdom 没有布局引擎，`getBoundingClientRect()` 恒为 0，
 *    所以这里只验行为与状态机，不验像素。
 *
 * 用法：node probe/rename-inline-test.mjs
 */

import { JSDOM } from 'jsdom'

const page = new JSDOM(
  '<!doctype html><html><body><div id="history-list" role="listbox"></div></body></html>',
  { pretendToBeVisual: true },
)
const W = page.window
for (const key of ['document', 'HTMLElement', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'Node', 'FocusEvent']) {
  globalThis[key] = W[key]
}
Object.defineProperty(globalThis, 'window', { value: W, configurable: true })

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

const list = W.document.querySelector('#history-list')

/**
 * 复刻 shell.js 的行内重命名实现（保持与产品同构，改产品时这里要跟着改）。
 * @param {Array<{sessionId:string,title:string}>} items
 * @param {Function} send 提交回调
 */
function createHarness(items, send, opts = {}) {
  let renamingSessionId = ''
  let seq = 0
  // ★ 与产品同构：行本身是个<button>，点了会关面板并切会话。
  //   2026-10-07 用户实测「改名无法保存」的真根因就在这条链上：
  //   编辑态把<input>+ 两个 <button> 塞进了这个 row，点✓ 时事件
  //   **冒泡到 row**，row 的 click 又调setHistoryOpen(false) ——
  //   面板当场关闭、DOM 销毁。第一版探针没有这层，所以 45/45 全绿
  //   却漏掉了它。复刻产品结构是这个探针存在的意义。
  const onRowClick = typeof opts.onRowClick === 'function' ? opts.onRowClick : () => {}

  function cssEscape(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
    return String(value).replace(/["\\]/g, '\\$&')
  }

  function renderHistory() {
    if (renamingSessionId !== '') return
    list.replaceChildren()
    for (const item of items) {
      const button = W.document.createElement('button')
      button.type = 'button'
      button.className = 'history-row'
      button.dataset.sessionId = item.sessionId
      button.textContent = item.title
      button.addEventListener('click', () => onRowClick(item.sessionId))
      list.append(button)
    }
  }

  function beginInlineRename(sessionId, currentTitle) {
    if (renamingSessionId === sessionId) return
    if (renamingSessionId !== '') {
      renamingSessionId = ''
      renderHistory()
    }
    const row = list.querySelector(`.history-row[data-session-id="${cssEscape(sessionId)}"]`)
    if (!(row instanceof W.HTMLElement)) return

    renamingSessionId = sessionId
    row.classList.add('renaming')
    const previous = currentTitle

    const input = W.document.createElement('input')
    input.type = 'text'
    input.className = 'rename-input'
    input.value = previous
    input.maxLength = 200

    const confirm = W.document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'rename-btn confirm'
    confirm.textContent = '✓'

    const cancel = W.document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'rename-btn'
    cancel.textContent = '✕'

    const shell = W.document.createElement('span')
    shell.className = 'rename-row'
    row.replaceChildren(shell)
    shell.append(input, confirm, cancel)

    const finish = (commit) => {
      if (renamingSessionId !== sessionId) return
      const next = input.value.trim()
      renamingSessionId = ''
      row.classList.remove('renaming')
      renderHistory()
      if (commit && next !== '' && next !== previous) {
        send({ sessionId, title: next })
      }
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); event.stopPropagation(); return }
      if (event.key === 'Escape') { event.preventDefault(); finish(false); event.stopPropagation() }
    })
    confirm.addEventListener('click', (event) => { finish(true); event.stopPropagation() })
    cancel.addEventListener('click', (event) => { finish(false); event.stopPropagation() })
    // 挡掉 mousedown 的默认行为 → 点按钮时 input 不失焦 → blur 不会抢跑
    for (const button of [confirm, cancel]) {
      button.addEventListener('mousedown', (event) => { event.preventDefault() })
    }
    input.addEventListener('blur', () => { if (renamingSessionId === sessionId) finish(false) })

    input.focus()
    input.select()
  }

  renderHistory()
  return { renderHistory, beginInlineRename, isRenaming: () => renamingSessionId !== '' }
}

const q = (sel) => list.querySelector(sel)
const key = (el, k) => el.dispatchEvent(new W.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
const click = (el) => el.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true }))
const ITEMSa = [{ sessionId: 'c1', title: '在吗？' }, { sessionId: 'c2', title: '你好' }]

// ── 1. 基本形态 ───────────────────────────────────────────────────────
{
  const sent = []
  const h = createHarness(ITEMSa, (p) => sent.push(p))
  h.beginInlineRename('c1', '在吗？')

  check('标题行变成输入框', q('.rename-input') !== null)
  check('输入框预填原标题', q('.rename-input')?.value === '在吗？', `实际「${q('.rename-input')?.value}」`)
  check('行内出现确认按钮', q('.rename-btn.confirm') !== null)
  check('行内出现取消按钮', q('.rename-btn:not(.confirm)') !== null)
  check('确认/取消都在同一行内（不是二级弹窗）', q('.rename-row')?.children.length === 3)
  check('编辑中的行加了 renaming 标记', q('.history-row')?.classList.contains('renaming') === true)
  check('进入编辑态', h.isRenaming() === true)
  check('还没提交任何东西', sent.length === 0)
}

// ── 2. 确认提交 ───────────────────────────────────────────────────────
{
  const sent = []
  const h = createHarness(ITEMSa, (p) => sent.push(p))
  h.beginInlineRename('c1', '在吗？')
  q('.rename-input').value = '  晚安  '
  click(q('.rename-btn.confirm'))

  check('确认后发出重命名', sent.length === 1)
  check('带对的 sessionId', sent[0]?.sessionId === 'c1')
  check('标题被 trim 过', sent[0]?.title === '晚安', `实际「${sent[0]?.title}」`)
  check('退出编辑态', h.isRenaming() === false)
  check('输入框已移除', q('.rename-input') === null)
  check('标题恢复成普通行', q('.history-row')?.textContent === '在吗？')
}

// ── 3. Enter 提交 / Esc 取消 ──────────────────────────────────────────
{
  const sent = []
  const h = createHarness(ITEMSa, (p) => sent.push(p))
  h.beginInlineRename('c1', '在吗？')
  q('.rename-input').value = 'Enter 提交'
  key(q('.rename-input'), 'Enter')
  check('Enter 等同确认', sent.length === 1 && sent[0]?.title === 'Enter 提交')

  h.beginInlineRename('c2', '你好')
  q('.rename-input').value = '不该被提交'
  key(q('.rename-input'), 'Escape')
  check('Esc 取消不提交', sent.length === 1)
  check('Esc 后退出编辑态', h.isRenaming() === false)
  check('Esc 后标题还原', q('.history-row[data-session-id="c2"]')?.textContent === '你好')
}

// ── 4. 取消按钮 ───────────────────────────────────────────────────────
{
  const sent = []
  const h = createHarness(ITEMSa, (p) => sent.push(p))
  h.beginInlineRename('c1', '在吗？')
  q('.rename-input').value = '写了但不要'
  click(q('.rename-btn:not(.confirm)'))
  check('取消按钮不提交', sent.length === 0)
  check('取消后退出编辑态', h.isRenaming() === false)
  check('取消后标题还原', q('.history-row[data-session-id="c1"]')?.textContent === '在吗？')
}

// ── 5. 边界：空标题 / 未改动 / 失焦 ───────────────────────────────────
{
  const sent = []
  const h = createHarness(ITEMSa, (p) => sent.push(p))

  h.beginInlineRename('c1', '在吗？')
  q('.rename-input').value = '   '
  click(q('.rename-btn.confirm'))
  check('纯空白标题不提交（避免把对话名清空）', sent.length === 0)
  check('空白提交后也退出编辑态', h.isRenaming() === false)

  h.beginInlineRename('c1', '在吗？')
  click(q('.rename-btn.confirm'))
  check('没改内容不提交', sent.length === 0)

  h.beginInlineRename('c1', '在吗？')
  q('.rename-input').value = '失焦就撤销'
  q('.rename-input').dispatchEvent(new W.FocusEvent('blur'))
  check('失焦等同取消（不会把半截内容提交）', sent.length === 0)
  check('失焦后退出编辑态', h.isRenaming() === false)
}

// ── 6. 编辑期间不被历史刷新冲掉 ───────────────────────────────────────
// 用户正在打字时如果 host 推来新的历史列表，不能把手上的输入框冲没。
{
  const sent = []
  const h = createHarness(ITEMSa, (p) => sent.push(p))
  h.beginInlineRename('c1', '在吗？')
  q('.rename-input').value = '正在打字…'
  h.renderHistory()                       // 模拟 host 推历史
  check('编辑期间 renderHistory 不重画（输入框保住）', q('.rename-input')?.value === '正在打字…')
  click(q('.rename-btn.confirm'))
  check('打字内容最终仍能提交', sent.length === 1 && sent[0]?.title === '正在打字…')
}

// ── 7. 换一条编辑 ─────────────────────────────────────────────────────
{
  const sent = []
  const h = createHarness(ITEMSa, (p) => sent.push(p))
  h.beginInlineRename('c1', '在吗？')
  q('.rename-input').value = 'c1 的新名字'
  h.beginInlineRename('c2', '你好')
  check('同一时刻只有一条在编辑', q('.rename-input') !== null)
  check('切到c2 后编辑的是 c2', q('.history-row[data-session-id="c2"] .rename-input')?.value === '你好')
  check('切走后 c1 的输入被丢弃（未提交）', sent.length === 0)
  check('c1 标题还原', q('.history-row[data-session-id="c1"]')?.textContent === '在吗？')
}

// ── 8. 重复进入同一条是幂等的 ─────────────────────────────────────────
{
  const h = createHarness(ITEMSa, () => {})
  h.beginInlineRename('c1', '在吗？')
  const before = q('.rename-input')
  h.beginInlineRename('c1', '在吗？')
  check('重复打开同一条不会重建输入框', q('.rename-input') === before)
  check('只有一个输入框', list.querySelectorAll('.rename-input').length === 1)
}

// ── 9. ★ 点「✓」的真实时序（用户实测「改名无法生效」的根因） ──────
//
// 浏览器点按钮的派发顺序是：
//   mousedown →（input 失焦）→ blur → mouseup → click
//
// 原来的写法是 blur 里直接 finish(false)：它先把 renamingSessionId 清成 ''，
// 紧接着 click 里的 finish(true) 被首行守卫挡掉 → **请求永远发不出去**。
// 这就是「行内编辑大部分正常、只有改名不生效」的原因：
//   · Enter 提交 → 正常（不走 blur）
//   · 点别处失焦 → 正常（本来就该取消）
//   · 点 ✓ 按钮 → 坏掉（blur 抢先）
//
// ⚠️ 中途试过「blur 里 setTimeout(0) 延后判定」，探针立刻变红：
// 延后到下一轮时 renderHistory() 已经把整行重建，click 打在销毁的节点上，
// 依然发不出去。**正解是 mousedown 阶段 preventDefault()，让 input 根本不丢焦点。**
const tick = () => new Promise((r) => setTimeout(r, 0))

/** 模拟真浏览器点按钮：mousedown 的默认行为会让 input 失焦，除非被 preventDefault 挡掉。 */
function clickLikeBrowser(button) {
  const input = q('.rename-input')
  const down = new W.MouseEvent('mousedown', { bubbles: true, cancelable: true })
  button.dispatchEvent(down)
  if (down.defaultPrevented === false && input !== null && document.activeElement === input) {
    input.dispatchEvent(new W.FocusEvent('blur'))
  }
  button.dispatchEvent(new W.MouseEvent('mouseup', { bubbles: true, cancelable: true }))
  button.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true }))
}

{
  const sent = []
  const h = createHarness(ITEMSa, (p) => sent.push(p))
  h.beginInlineRename('c1', '在吗？')
  q('.rename-input').value = '点按钮改名'
  clickLikeBrowser(q('.rename-btn.confirm'))
  check('点✓ 能真正发出重命名（blur 不再抢跑）', sent.length === 1,
    `实际发出 ${sent.length} 条`)
  check('带对的标题', sent[0]?.title === '点按钮改名', `实际「${sent[0]?.title}」`)
  check('退出编辑态', h.isRenaming() === false)
}

// 反向验证：确认 preventDefault 真的是在起作用
//（拿掉它就应当复现「点✓发不出去」—— 这条断言防止有人把修复删掉）
{
  const sent = []
  const h = createHarness(ITEMSa, (p) => sent.push(p))
  h.beginInlineRename('c1', '在吗？')
  const input = q('.rename-input')
  const btn = q('.rename-btn.confirm')
  input.value = '不该发出去'
  // 不带 mousedown 监听 = 模拟「修复被删掉」：直接 blur 再 click
  input.dispatchEvent(new W.FocusEvent('blur'))
  btn.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true }))
  check('（对照）blur 抢先时确实发不出去 —— 说明 preventDefault 是必要的',
    sent.length === 0, `实际 ${sent.length} 条`)
}

// 取消按钮同理
{
  const sent = []
  const h = createHarness(ITEMSa, (p) => sent.push(p))
  h.beginInlineRename('c1', '在吗？')
  q('.rename-input').value = '写了又取消'
  clickLikeBrowser(q('.rename-btn:not(.confirm)'))
  check('点✕ 不提交', sent.length === 0)
  check('点✕ 后退出编辑态', h.isRenaming() === false)
  check('点✕ 后标题还原', q('.history-row[data-session-id="c1"]')?.textContent === '在吗？')
}

// 点别处失焦仍要取消
{
  const sent = []
  const h = createHarness(ITEMSa, (p) => sent.push(p))
  h.beginInlineRename('c1', '在吗？')
  q('.rename-input').value = '敲了一半'
  q('.rename-input').dispatchEvent(new W.FocusEvent('blur'))
  check('失焦（点空白处）按取消收尾', h.isRenaming() === false)
  check('失焦取消不提交', sent.length === 0)
  check('失焦后标题还原', q('.history-row[data-session-id="c1"]')?.textContent === '在吗？')
}

// Enter 之后紧跟的 blur 不该把已提交的态再动一次
{
  const sent = []
  const h = createHarness(ITEMSa, (p) => sent.push(p))
  h.beginInlineRename('c1', '在吗？')
  const input = q('.rename-input')
  input.value = 'Enter 提交'
  key(input, 'Enter')
  input.dispatchEvent(new W.FocusEvent('blur'))
  check('Enter 提交后迟到的 blur 不产生第二次提交', sent.length === 1,
    `实际 ${sent.length} 条`)
}

// ── ★★ 真bug 回归：编辑态的点击不能冒泡到 row（2026-10-07 用户实测）─────
//
// 现象：用户改完名点✓，面板直接关了、名字没保存。orb.log 里
// **一条 `重命名 …` 记录都没有** —— 请求确实没发出去。
//
// 根因：历史列表的每一行是 `<button class="history-row">`，
// 它自己带 click 监听（setHistoryOpen(false) + api.openSession）。
// `beginInlineRename` 把 `<input>` 和 ✓/✕ 两个 `<button>` **塞进这个 row**，
// 于是点 ✓ 时事件沿冒泡链上行到 row → **面板被关掉、DOM 销毁**。
//
// 第一版探针的 row 上**没有** click 监听，所以 45/45 全绿却漏掉了它。
// 这一组带真实监听，用反向验证确认过：撤掉产品修复后立刻变红。
{
  const sent = []
  let panelOpen = true
  let openedSession = null
  const h = createHarness(ITEMSa, (p) => sent.push(p), {
    // 复刻 shell.js:1669 的行点击行为
    onRowClick: (sessionId) => {
      panelOpen = false
      openedSession = sessionId
    },
  })
  h.beginInlineRename('c1', '在吗？')
  const input = q('.rename-input')
  input.value = '新的名字'
  // 真实点击序列：mousedown（被 preventDefault）→ mouseup → click
  const btn = q('.rename-btn.confirm')
  btn.dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
  btn.dispatchEvent(new W.MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }))
  click(btn)

  check('★★ 点✓ 不会连带触发行的 click（面板不会被关掉）',
    panelOpen === true, `面板 open=${panelOpen}，被切到 ${openedSession}`)
  check('★★ 点✓ 不会误触发 openSession', openedSession === null, `实际 ${openedSession}`)
  check('★★ 点✓ 真的提交出去了', sent.length === 1, `实际 ${sent.length} 条`)
  check('★★ 提交内容正确',
    sent[0]?.title === '新的名字' && sent[0]?.sessionId === 'c1',
    JSON.stringify(sent[0] ?? null))
  check('★★ 编辑态已退出', h.isRenaming() === false)
}

// 取消按钮同理：✕ 也不该冒泡到 row
{
  const sent = []
  let rowClicks = 0
  const h = createHarness(ITEMSa, (p) => sent.push(p), { onRowClick: () => { rowClicks += 1 } })
  h.beginInlineRename('c1', '在吗？')
  q('.rename-input').value = '不该保存'
  const btn = q('.rename-btn:not(.confirm)')
  btn.dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
  click(btn)
  check('点✕ 也不冒泡到行', rowClicks === 0, `实际 ${rowClicks} 次`)
  check('点✕ 不提交', sent.length === 0)
}

// 在输入框里打字（keydown）也不该冒泡 —— 否则 Enter 会同时切会话
{
  const sent = []
  let rowClicks = 0
  const h = createHarness(ITEMSa, (p) => sent.push(p), { onRowClick: () => { rowClicks += 1 } })
  h.beginInlineRename('c1', '在吗？')
  const input = q('.rename-input')
  input.value = '回车提交'
  key(input, 'Enter')
  check('Enter 不冒泡到行', rowClicks === 0, `实际 ${rowClicks} 次`)
  check('Enter 正常提交', sent.length === 1, `实际 ${sent.length} 条`)
}

console.log(`\n${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)