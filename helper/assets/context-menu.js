/**
 * context-menu.js —— 渲染层自己的右键菜单（DOM 实现）。
 *
 * 为什么不用 Electron 的 `Menu.popup()`：
 *   1. 原生菜单是 OS 级窗口，`z-index` 管不到它；面板是 `transparent:true`
 *      的无边框窗口，popup 的锚点命中判定会和透明区域错位。
 *   2. 球态下窗口设了 `setIgnoreMouseEvents(true, { forward: true })`
 *      （鼠标穿透），原生 `context-menu` 事件不保证触发 —— 右键球没反应。
 *   3. 原生菜单**挂不到列表项上**。「历史对话」要按条目弹出
 *      重命名 / 删除 / 锁定，原生菜单做不到（见待办事项 P0-4）。
 *
 * ★★ 2026-10-07 修掉的卡死（用户实测：球拖到屏幕左下角后彻底失去交互）
 *
 *   第一版用了一个 `position:fixed; inset:0` 的 backdrop 遮罩来承接
 *   「点击外部关闭」。在**无边框 + 透明 + 置顶**的窗口里这是致命的：
 *   backdrop 盖住整个窗口，一旦它处于显示状态，球的 hover/click 全被它吃掉
 *   （`mouseenter` 不再触发 → 「鼠标放上去没反应」），而球又依赖 hover 展开，
 *   于是进入自锁。更糟的是退出通道也被它自己堵死：弹菜单前我们会临时关掉
 *   鼠标穿透，弹完再恢复；一旦窗口先恢复了穿透，backdrop 的 `pointerdown`
 *   就**收不到事件**，「点外部关闭」这条唯一逃生路径失效，菜单永久卡在打开态。
 *
 *   **教训：在透明置顶窗口里，永远不要铺一个覆盖全窗口的命中层。**
 *   现在改成「document 上监听 pointerdown + 判断落点是否在菜单外」，
 *   零遮罩、零常驻元素，不存在把UI 整体吞掉的可能。
 *
 * 用法：
 *   const menu = createContextMenu({ onAction, onOpen, onClose })
 *   menu.bind()                       // 接管整页的右键
 *   menu.open({ x, y, items })        // 弹一次
 *   menu.close()
 *
 * `items` 由调用方给，**不要在这里硬编码菜单项** —— 球菜单与
 * 对话级菜单的内容都应当由 host 下发的数据驱动。
 */

/** 菜单项的规范化：只保留渲染层需要的字段，其余原样透传。 */
function normalizeItems(items) {
  if (!Array.isArray(items)) return []
  return items
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      // 稳定的 action id；缺失时用 label 兜底（宿主给的是 label 文本）
      id: typeof item.id === 'string' && item.id !== '' ? item.id : String(item.label ?? ''),
      label: typeof item.label === 'string' ? item.label : '',
      // 'normal' | 'danger' | 'separator'
      kind: item.kind === 'danger' || item.kind === 'separator' ? item.kind : 'normal',
      disabled: item.disabled === true,
      // 分组：同一 group 的相邻项之间会被画上分隔线。
      // 用它替代 separator 项，便于「按数据分组」而不是「按顺序硬排」。
      group: typeof item.group === 'string' ? item.group : '',
      checked: item.checked === true,
      // 透传业务载荷（sessionId / sha 等），点击时原样回给 onAction
      payload: item.payload,
    }))
}

export function createContextMenu(options = {}) {
  const onAction = typeof options.onAction === 'function' ? options.onAction : () => {}
  /** 点击菜单外部时是否自动关掉。取消框等场景可以关掉。 */
  const closeOnOutside = options.closeOnOutside !== false
  /** 打开/关闭的生命周期钩子 —— host 靠它精确开关鼠标穿透（不要再靠定时器猜）。 */
  const onOpen = typeof options.onOpen === 'function' ? options.onOpen : () => {}
  const onClose = typeof options.onClose === 'function' ? options.onClose : () => {}

  let root = null
  /** 当前打开的菜单项；null 表示没打开 */
  let current = null
  /** 键盘焦点要回到哪里，关闭时还回去 */
  let returnFocus = null

  function ensureNodes() {
    if (root) return
    root = document.createElement('div')
    root.className = 'ctxmenu'
    root.setAttribute('role', 'menu')
    root.setAttribute('tabindex', '-1')
    root.hidden = true
    document.body.append(root)
  }

  function render(items) {
    ensureNodes()
    root.replaceChildren()
    let lastGroup = null
    for (const item of items) {
      if (item.kind === 'separator') {
        const hr = document.createElement('div')
        hr.className = 'ctxmenu-sep'
        hr.setAttribute('role', 'separator')
        root.append(hr)
        lastGroup = null
        continue
      }
      const row = document.createElement('button')
      row.type = 'button'
      row.className = item.kind === 'danger' ? 'ctxmenu-item danger' : 'ctxmenu-item'
      row.setAttribute('role', 'menuitem')
      row.dataset.action = item.id
      if (item.group !== '' && item.group === lastGroup && root.lastElementChild?.className !== 'ctxmenu-sep') {
        // 同组紧邻项之间不要重复画线
      } else if (item.group !== '' && root.lastElementChild != null) {
        const hr = document.createElement('div')
        hr.className = 'ctxmenu-sep'
        hr.setAttribute('role', 'separator')
        root.append(hr)
      }
      lastGroup = item.group

      const label = document.createElement('span')
      label.className = 'ctxmenu-label'
      label.textContent = item.checked ? `${item.label}✓` : item.label
      row.append(label)

      if (item.disabled) {
        row.disabled = true
        row.setAttribute('aria-disabled', 'true')
      } else {
        row.addEventListener('click', () => {
          const payload = item.payload
          const id = item.id
          close()
          onAction(id, payload, item)
        })
        // 上下键在菜单项间移动
        row.addEventListener('keydown', (event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          const rows = focusableRows()
          const at = rows.indexOf(row)
          if (at < 0) return
          const next = event.key === 'ArrowDown' ? at + 1 : at - 1
          rows[(next + rows.length) % rows.length]?.focus()
        })
      }
      root.append(row)
    }
  }

  function focusableRows() {
    if (!root) return []
    return [...root.querySelectorAll('.ctxmenu-item:not([disabled])')]
  }

  /**
   * 定位：优先让菜单落在指针右下，越界时翻到另一侧。
   *
   * 窗口可能被用户缩得很小，也可能贴着屏幕边（球在左下角时尤其如此），
   * 所以先夹进可视区、再决定往哪边翻 —— 顺序不能反，
   * 否则菜单会被放到 `innerWidth/innerHeight` 之外（= 看不见）。
   */
  function place(x, y) {
    if (!root) return
    root.hidden = false
    root.style.left = '0px'
    root.style.top = '0px'
    // 先量尺寸才知道往哪翻 —— hidden 状态下量不到
    const rect = root.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const gap = 2
    const w = Math.min(rect.width, vw)
    const h = Math.min(rect.height, vh)

    // 默认落在指针右下，右边放不下就翻到左侧
    let left = x + gap
    if (left + w > vw) left = x - w - gap
    // 上下同理：下边放不下翻到上边
    let top = y + gap
    if (top + h > vh) top = y - h - gap
    // ★ 最后无条件夹进可视区。翻转之后仍可能越界（菜单比窗口还大、
    // 或指针在边角），这一步是「菜单绝不跑到窗口外」的兜底。
    left = Math.min(Math.max(0, left), Math.max(0, vw - w))
    top = Math.min(Math.max(0, top), Math.max(0, vh - h))

    root.style.left = `${Math.round(left)}px`
    root.style.top = `${Math.round(top)}px`
  }

  function open(payload) {
    const items = normalizeItems(payload?.items)
    if (items.length === 0) return
    ensureNodes()
    if (current === null) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      current = items
      // 通知 host：菜单要开着，穿透必须关掉。**必须在 place 之前**——
      // 窗口一旦还是穿透态，这帧的定位量测就不可信。
      onOpen()
    } else {
      current = items
    }
    render(items)
    place(Number(payload?.x) || 0, Number(payload?.y) || 0)
    // 第一项可用项给焦点，键盘用户能直接操作
    focusableRows()[0]?.focus()
  }

  function close() {
    if (current === null) return
    current = null
    if (root) {
      root.hidden = true
      root.replaceChildren()
    }
    // 焦点归位，否则键盘用户会被丢到 body 上
    if (returnFocus && returnFocus.isConnected) returnFocus.focus()
    returnFocus = null
    onClose()
  }

  function isOpen() {
    return current !== null
  }

  /** 是否应该把这次右键让给浏览器默认行为。 */
  function shouldIgnore(target) {
    if (!(target instanceof Element)) return false
    // 输入区、划词工具栏、可编辑区域 —— 右键要保留原生行为
    if (target.closest('#prompt, textarea, input, [contenteditable="true"]')) return true
    if (target.closest('#selection-toolbar, #selection-chip')) return true
    return false
  }

  /** 接管整页的右键。返回取消函数。 */
  function bind() {
    if (typeof document === 'undefined') return () => {}
    ensureNodes()
    const onContextMenu = (event) => {
      // 已经在菜单里操作时不劫持
      if (event.target instanceof Element && event.target.closest('.ctxmenu')) return
      if (shouldIgnore(event.target)) {
        // 可编辑区：交回浏览器（复制/粘贴）。Electron 默认不弹原生菜单，
        // 所以显式通知 host 用编辑角色弹一个 —— 否则这里等于「右键无反应」。
        options.onEditableContextMenu?.(event)
        return
      }
      event.preventDefault()
      // 交由调用方决定弹什么 —— 球菜单 vs 对话级菜单
      options.onContextMenu?.(event)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') close()
    }
    /**
     * 「点击外部关闭」—— 用捕获阶段的 document 监听，**不铺遮罩**。
     * 落点在菜单外就关掉；落在菜单内（含菜单项的空白 padding）不关，
     * 否则「按下—松开」中途菜单消失，点击会落空。
     */
    const onPointerDown = (event) => {
      if (!closeOnOutside || current === null) return
      const target = event.target
      if (target instanceof Element && target.closest('.ctxmenu')) return
      close()
    }
    document.addEventListener('contextmenu', onContextMenu)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', close)
    }
  }

  return { bind, open, close, isOpen, shouldIgnore }
}