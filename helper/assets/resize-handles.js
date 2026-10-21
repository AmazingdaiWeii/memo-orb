/**
 * resize-handles.js —— 面板的拖拽缩放手柄（独立版新增）。
 *
 * ## 为什么必须自己画（P0-5，探针假阳性）
 *
 * 用户反馈「拖动边框仍然无法放大」，而 `probe/window-probe.mjs` 报 5/5 通过。
 * 根因是**探针验的不是用户走的路径**：
 *
 *   - 探针用 `win.setBounds({width, height})` **程序直接设尺寸**，
 *     而 Electron 的 `resized` 事件**只在真实拖拽窗口边缘时触发**，
 *     程序自己调 setBounds 不触发 —— 于是探针走的是「已验证的回写链路」，
 *     完全绕过了「用户能不能拖」这一环。
 *   - 而窗口是 `frame: false` + `transparent: true`，
 *     **Windows 上无边框 + 透明窗口没有系统 resize 热区** ——
 *     用户根本不存在「边框」可以拖。
 *
 * ## ★ 只有三条边能拖，不是四条（2026-10-07 修正）
 *
 * 面板窗口的**位置不是自由的**，它由球的原点锚定
 * （见 `main.js` 的 `overlayBoundsFromBall`）：
 *
 *   - `horizontal === 'left'`（面板展开在球的左边）
 *     → 窗口**右边**贴着球，左边才是自由边。
 *   - `horizontal === 'right'` → 反过来，右边是自由边。
 *   - `vertical === 'up'`（面板在球上方）→ 窗口**下边**贴着球，上边自由。
 *   - `vertical === 'down'` → 反过来，下边自由。
 *
 * 贴着球的那两条边**拖了也没用**：窗口原点由球决定，改不动。
 * 而且它们就压在球上（球的右缘正好等于面板右缘），
 * 暴露出来会**抢走球的点击和拖拽** —— 这正是 2026-10-07 卡死的同类问题。
 *
 * 所以每个方向只暴露 **1 条自由边 + 1 个自由角**，共 3 个手柄。
 *
 * ## 为什么拖拽中只显示尺寸读数、不让面板跟手变长
 *
 * 窗口尺寸由主进程 `setBounds` 决定，渲染层改 CSS 宽度只是把内容画到
 * **窗口边界之外**，会被裁掉 —— 用户拖了半天气看不见任何变化。
 * 真要跟手就得每帧一次 `setBounds`，而主进程每次都要 clamp + 重算方向，
 * 拖拽途中方向翻转会剧烈抖动，得不偿失。
 *
 * 于是：拖拽中给一个**贴着自由角的大小读数**（真实反馈、零 IPC），
 * 松手才真正 `setBounds` 一次。
 *
 * ## 命中区放在哪
 *
 * 窗口比面板大 `2 × CHROME_INSET`（12px），那圈是透明的。
 *
 * ★★ 2026-10-08（用户 m01764「拖动边缘放大缩小没了」）修正：
 *   手柄**贴着面板那条看得见的边**摆（'n' 的下缘 = 面板上边界，其余同理），
 *   命中区再从这条边界向内外各撑一点（外 6px + 内 4px）。
 *   旧版把边条摆在窗口外缘（0..6px），整条命中区（0..11px）全在那圈透明
 *   chrome 里，**与面板边界 12px 处完全不重叠** —— 用户照着面板的边去拖
 *   永远差 12px 拖不到，hover 提示线也画在离面板 12px 的空中。
 *   面板内部那点 4px 是面板自己的边框/内边距区，不碰输入框与消息列表。
 *
 * ⚠️ 但不能铺成 `inset: 0` 的全窗口命中层（那正是 2026-10-07 卡死的成因，
 * 见 context-menu.js 头部）。这里的做法是：
 *   - 每条手柄是**独立的窄条**（14px 方块 / 6px 长条），各有自己的几何范围；
 *   - 收起态、以及非自由边，整条 `display: none`，**不占命中**；
 *   - 拖拽期间用 `setPointerCapture`，全程只听 window 的事件，
 *     不依赖指针还留在手柄上。
 */

/** 手柄方向 → 光标。名字与 CSS 里的 `data-dir` 一一对应。 */
const CURSORS = {
  n: 'n-resize',
  s: 's-resize',
  e: 'e-resize',
  w: 'w-resize',
  ne: 'ne-resize',
  nw: 'nw-resize',
  se: 'se-resize',
  sw: 'sw-resize',
}

/**
 * 8 个方向里，每个方向要改哪几个边、符号是什么。
 * dx/dy 是「指针往右/往下走多少，尺寸就加多少」。
 */
const EFFECTS = {
  n: { dx: 0, dy: -1, w: 0, h: 1 },
  s: { dx: 0, dy: 1, w: 0, h: 1 },
  e: { dx: 1, dy: 0, w: 1, h: 0 },
  w: { dx: -1, dy: 0, w: 1, h: 0 },
  ne: { dx: 1, dy: -1, w: 1, h: 1 },
  nw: { dx: -1, dy: -1, w: 1, h: 1 },
  se: { dx: 1, dy: 1, w: 1, h: 1 },
  sw: { dx: -1, dy: 1, w: 1, h: 1 },
}

/** 自由边字母 → 自由角的键名。 */
const CORNER_OF = {
  w: { n: 'nw', s: 'sw' },
  e: { n: 'ne', s: 'se' },
}

/**
 * 球贴在窗口的哪个角 —— `direction` 的另一种表达。
 *
 * 窗口比面板大 `2 × CHROME_INSET`，球始终占据窗口的两个相邻角之一
 * （见 `main.js` 的 `overlayBoundsFromBall`）。手柄绝不能放上去，
 * 否则就是 2026-10-07 那次「球彻底失去交互」的卡死。
 */
export function ballCorner(direction = {}) {
  // horizontal==='left' → 面板在球左边 → 窗口**右**边贴球 → 球在 e侧
  const e = direction.horizontal === 'left'
  // vertical==='up'→ 面板在球上边 → 窗口**下**边贴球 → 球在 s 侧
  const s = direction.vertical === 'up'
  return `${s ? 's' : 'n'}${e ? 'e' : 'w'}`
}

/**
 * 首选角：用户指定的那一个（默认 `se`，即「窗体右下角」）。
 *
 * ⚠️ 2026-10-07 用户要求「把斜纹放进黑色窗体右下角位置」。
 *   但几何上**右下角不一定安全** —— 探针
 *   `probe/corner-vs-ball-geometry.mjs` 用真实常量算过：
 *   球的默认位置（工作区右边缘、垂直偏下）会让球正好落在窗口 `se` 角，
 *   此时把手柄放`se` 就是压在球上，直接复现卡死。
 *
 *   所以规则是：**首选角若与贴球角相同，就退到它的对角**。
 *   对角是离球最远的角落，永远安全（这也是 `freeEdges` 一直用的那个角）。
 *   实测：`se` 在 7 种常见球位里有 3 种会被球压住 —— 不能无脑写死。
 */
const PREFERRED_CORNER = 'se'

/** 一个角的对面那个角。 */
const OPPOSITE = { n: 's', s: 'n', e: 'w', w: 'e' }

/** 首选角的退让版本：与贴球角重合时取对角。 */
export function safeCorner(direction = {}, preferred = PREFERRED_CORNER) {
  const ball = ballCorner(direction)
  if (preferred !== ball) return preferred
  return `${OPPOSITE[preferred[0]]}${OPPOSITE[preferred[1]]}`
}

/**
 * 由展开方向推出「哪 3 个手柄可用」。
 *
 * @param {{horizontal?: string, vertical?: string}} direction
 * @returns {{h: string, v: string, corner: string}}
 */
export function freeEdges(direction = {}) {
  // `left` = 面板在球左边 → 窗口右边贴球 → 左边自由（反之亦然）。
  const h = direction.horizontal === 'right' ? 'e' : 'w'
  // `up` = 面板在球上边 → 窗口下边贴球 → 上边自由（反之亦然）。
  const v = direction.vertical === 'down' ? 's' : 'n'
  return { h, v, corner: CORNER_OF[h][v] }
}

/**
 * 边条厚度（px）—— **这是「视觉」宽度，命中区另有一次放大**。
 *
 * 视觉只有 6px（不然一条 12px 的黑边挂在面板上很难看），
 * 但命中区用 `::before` 撑到 `EDGE_HIT`=16px：
 * 用户抱怨「判定框太窄」说的是**点不中**，不是「看不见」，
 * 这两件事用两个尺寸分别解决。
 */
const EDGE = 6
/**
 * 边条的命中区厚度（px）—— 不可见，只负责接鼠标。
 *
 * ★ 2026-10-08（用户 m01764）：16 → 10，且改成**从面板可见边界向内外各撑**
 * （外 6px + 内 4px，见 `context-menu.css` 的 `.resize-handle[data-dir=…]::before`）。
 * 真源在 CSS 里，这个常量只用于对文档与探针表达意图。
 */
const EDGE_HIT = 10
/**
 * 角上的方块边长（px）—— 正方形，比两条边条交叠更好点。
 *
 * ★ 2026-10-07 从 14 提到 22：用户实测「判定框太窄，只能成功放大一次」。
 * 14px 在 100% 缩放下也就一个小方块，而面板四角是 `36px` 圆角
 * （`--panel-radius`）—— 手柄太小会整个躲进圆角切线里，
 * 用户的鼠标很容易落在「看着该是角」的位置却没命中。
 *
 * 上限受两件事约束：① 不能大到盖住面板内容（输入框在角上）；
 * ② 不能大到跨过对边（面板最小时宽 320，22 还很安全）。
 */
const CORNER = 22
/**
 * 角上的**视觉**斜纹边长（px）。
 *
 * 分成「命中区」和「视觉」两层是这个 UI 的关键：命中区要够大好点，
 * 视觉要够小不遮挡。
 *
 * ★ 2026-10-07 第一次改版（10px 实心方块 → 14px 斜纹）：
 *   用户原话「你的这个拖动ui做的，太难看了」，并给出参考
 *   `deco-plan/preview.html` —— 那边用的是 CSS `resize: both`，
 *   手柄是**浏览器原生**的：角落几根 45°细线，极淡、平时几乎看不见。
 *   实心方块太"实"、边界太硬，像往面板上贴了个控件，
 *   而不是「窗口本身可以被拉开」。
 *
 * ★★ 2026-10-07 第二次改版（14 → 22，并挪到窗体角）：
 *   用户原话「右上角的斜纹，目前在桌面上显示不明显，
 *   我希望把它放进黑色窗体右下角位置」。
 *   两个诉求：**放大**（14 太淡太细）+ **挪到窗体角**。
 *   「窗体」= `body`，它是 `background: transparent`——
 *   用户看到的「黑色」其实是**桌面壁纸透过来的颜色**，
 *   不是某个黑底元素。面板是 `inset: var(--chrome)` 的圆角块，
 *   窗体则是整个窗口。所以斜纹要落在**面板之外、窗体之内**的那圈。
 *
 *   取 22 = 与命中区同大小：视觉铺满命中区，鼠标移到哪就是哪，
 *   不用在「看得见的」和「点得到的」之间做心算。
 *
 * 命中区仍是 22px 不变 —— 「点不中」和「好不好看」是两个问题，
 * 别为了好看把命中区缩小（用户实测过判定框太窄，只放大成功一次）。
 */
const CORNER_VISUAL = 22
/** 键盘调整的步长（px）。 */
const KEY_STEP = 24

/**
 * @param {object} options
 * @param {Function} options.onResize   拖拽中回调：(width, height) => void
 * @param {Function} options.onCommit   松手/键盘确认时回调：(width, height, dir) => void
 * @param {Function} options.isEnabled  面板是否处于可缩放态（收起态返回 false）
 * @param {Function} options.getDirection 展开方向 → { horizontal, vertical }
 * @returns {{destroy: Function, refresh: Function}}
 */
export function createResizeHandles(options = {}) {
  const onResize = typeof options.onResize === 'function' ? options.onResize : () => {}
  const onCommit = typeof options.onCommit === 'function' ? options.onCommit : () => {}
  const isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : () => true
  const getDirection = typeof options.getDirection === 'function'
    ? options.getDirection
    // 兜底读 body 上的方向 class（`applyDirection` 一直在维护它们）。
    : () => ({
      horizontal: document.body.classList.contains('expand-right') ? 'right' : 'left',
      vertical: document.body.classList.contains('expand-down') ? 'down' : 'up',
    })

  /** @type {Map<string, HTMLElement>} */
  const handles = new Map()
  /** 拖拽中的会话；null 表示没在拖。 */
  let drag = null
  /** 拖拽期间显示的尺寸读数。 */
  let readout = null

  /**
   * 建一个手柄。
   * @param {string} dir EFFECTS 的key
   */
  function makeHandle(dir) {
    const el = document.createElement('div')
    el.className = 'resize-handle'
    el.dataset.dir = dir
    el.style.cssText = geometry(dir)
    el.style.cursor = CURSORS[dir]
    el.setAttribute('role', 'separator')
    el.setAttribute('aria-label', '调整面板大小')
    el.tabIndex = 0
    // 角手柄额外挂一个 class：视觉内圈（那个看得见的小方块）只画在角上。
    // 边条不给 —— 一条 6px 的窄条上画不出方块，画了也看不清。
    //
    // ⚠️ 别写成 `CORNER_OF.e.w === dir || CORNER_OF.e.e === dir`：
    //   那样只能命中 `nw` 和 `ne`，`sw`/`se` 两个角拿不到 class
    //   （探针「4 个角都带 is-corner」就是抓这条的）。
    //   直接对四个名字取集合，四个角天生对称，改逻辑也不会漏。
    if (dir === 'nw' || dir === 'ne' || dir === 'sw' || dir === 'se') {
      el.classList.add('is-corner')
    }
    el.addEventListener('pointerdown', (event) => onPointerDown(event, dir))
    el.addEventListener('keydown', (event) => onKeyDown(event, dir))
    document.body.append(el)
    handles.set(dir, el)
    return el
  }

  /**
   * 方向 → 相对 body 的定位（body 就是整个窗口）。
   *
   * ★★ 2026-10-08（用户 m01764「拖动边缘放大缩小没了」）：
   *   **边条必须贴在面板那条「看得见的边」上，而不是窗口外缘。**
   *   面板是 `inset: var(--chrome)`（12px），窗口比面板四周各宽 12px ——
   *   旧写法把边条放在窗口 0..6px 处，于是整条命中区（0..11px）**完全落在
   *   那圈透明 chrome 里，跟面板的可见边界（12px）根本不重叠**：
   *   用户照着「面板的边」去拖，永远差 12px 拖不到；hover 时那条提示线
   *   也画在离面板 12px 的空中（这正是用户早先说「拖动条在窗口外」的原因）。
   *   现在把边条贴着面板边界外侧摆：'n' 的**下**缘 = 面板上边界，其余同理。
   *   CSS 那边（context-menu.css）把 hover 提示线画在靠面板的那一侧，
   *   `::before` 命中区再从边界向内外各撑开（外 6px + 内 4px）。
   */
  function geometry(dir) {
    // 用百分比 + 固定像素混合：百分比跟窗口走，像素值保证边条够粗。
    switch (dir) {
      case 'n': return 'left:var(--chrome);right:var(--chrome);top:calc(var(--chrome) - ' + EDGE + 'px);height:' + EDGE + 'px;'
      case 's': return 'left:var(--chrome);right:var(--chrome);bottom:calc(var(--chrome) - ' + EDGE + 'px);height:' + EDGE + 'px;'
      case 'w': return 'top:var(--chrome);bottom:var(--chrome);left:calc(var(--chrome) - ' + EDGE + 'px);width:' + EDGE + 'px;'
      case 'e': return 'top:var(--chrome);bottom:var(--chrome);right:calc(var(--chrome) - ' + EDGE + 'px);width:' + EDGE + 'px;'
      case 'nw': return 'left:0;top:0;width:' + CORNER + 'px;height:' + CORNER + 'px;'
      case 'ne': return 'right:0;top:0;width:' + CORNER + 'px;height:' + CORNER + 'px;'
      case 'sw': return 'left:0;bottom:0;width:' + CORNER + 'px;height:' + CORNER + 'px;'
      case 'se': return 'right:0;bottom:0;width:' + CORNER + 'px;height:' + CORNER + 'px;'
      default: return ''
    }
  }

  function panelSize() {
    const panel = document.getElementById('panel')
    if (!panel) return null
    return { width: panel.offsetWidth, height: panel.offsetHeight }
  }

  function onPointerDown(event, dir) {
    if (event.button !== 0) return
    if (!isEnabled()) return
    // 左键才拖；右键/中键要让给菜单
    event.preventDefault()
    event.stopPropagation()
    const start = panelSize()
    if (start === null) return
    drag = {
      dir,
      startX: event.clientX,
      startY: event.clientY,
      startW: start.width,
      startH: start.height,
      width: start.width,
      height: start.height,
    }
    const el = event.currentTarget
    // 捕获指针：拖出窗口也不丢事件（无边框窗口里这个很关键）
    try { el.setPointerCapture(event.pointerId) } catch {}
    el.dataset.dragging = 'true'
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    // ★ 无边框窗口：指针在窗口外松手时收不到 pointerup，
    //   结果是拖拽会话永远不结束、读数永远挂在屏幕上。
    //   失焦是可靠的「用户已经松手」信号。
    window.addEventListener('blur', onPointerUp)
    showReadout(drag.width, drag.height)
  }

  function onPointerMove(event) {
    if (drag === null) return
    const effect = EFFECTS[drag.dir]
    if (effect === undefined) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    // 只让「这个方向负责的轴」跟着变；另一个轴锁死，避免误改。
    drag.width = effect.w === 1 ? drag.startW + dx * effect.dx : drag.startW
    drag.height = effect.h === 1 ? drag.startH + dy * effect.dy : drag.startH
    onResize(drag.width, drag.height)
    showReadout(drag.width, drag.height)
  }

  function onPointerUp() {
    if (drag === null) return
    const { width, height, dir } = drag
    drag = null
    for (const el of handles.values()) delete el.dataset.dragging
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
    window.removeEventListener('blur', onPointerUp)
    hideReadout()
    onCommit(width, height, dir)
  }

  /** 键盘调整：方向键改对应轴，Enter/空格确认。 */
  function onKeyDown(event, dir) {
    if (!isEnabled()) return
    const effect = EFFECTS[dir]
    if (effect === undefined) return
    const start = panelSize()
    if (start === null) return
    /**
     * 键 → 该键负责的轴（'x' / 'y'）与带符号步长。
     *
     * ⚠️ 必须**连轴一起返回**，不能只返回步长。
     * 第一版只返回步长，于是 `w` 边（`dy` 恒为 0）按下 ArrowUp 时，
     * `ArrowUp` 返回 -24，被当成水平位移算进宽度 ——
     * 用户按上下键会把宽度改掉，方向完全错乱。
     * 探针第 13 组的「左边手柄忽略上下键」就是抓这条的。
     */
    const AXIS_STEP = {
      ArrowLeft: ['x', -KEY_STEP],
      ArrowRight: ['x', KEY_STEP],
      ArrowUp: ['y', -KEY_STEP],
      ArrowDown: ['y', KEY_STEP],
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onCommit(start.width, start.height, dir)
      return
    }
    const move = AXIS_STEP[event.key]
    // 不在表里的键、以及这个方向不负责的轴，一律不响应。
    if (move === undefined) return
    const [axis, delta] = move
    if (axis === 'x' && effect.w !== 1) return
    if (axis === 'y' && effect.h !== 1) return
    event.preventDefault()
    const width = effect.w === 1 ? start.width + delta * effect.dx : start.width
    const height = effect.h === 1 ? start.height + delta * effect.dy : start.height
    onResize(width, height)
    showReadout(width, height)
    onCommit(width, height, dir)
  }

  // ── 尺寸读数 ─────────────────────────────────────────────────────────

  /**
   * 在**自由角**内侧显示 `宽 × 高`。
   * 贴着球那一侧不放读数 —— 那里是球，读数会盖住角色。
   */
  function showReadout(width, height) {
    const { h, v } = freeEdges(getDirection())
    if (readout === null) {
      readout = document.createElement('div')
      readout.className = 'resize-readout'
      readout.setAttribute('aria-hidden', 'true')
      document.body.append(readout)
    }
    readout.textContent = `${Math.round(width)} × ${Math.round(height)}`
    readout.style.top = v === 'n' ? '20px' : ''
    readout.style.bottom = v === 's' ? '20px' : ''
    readout.style.left = h === 'w' ? '20px' : ''
    readout.style.right = h === 'e' ? '20px' : ''
  }

  function hideReadout() {
    if (readout === null) return
    readout.remove()
    readout = null
  }

  function build() {
    for (const dir of Object.keys(EFFECTS)) makeHandle(dir)
    refresh()
  }

  /**
   * 按当前状态启用/停用手柄。
   *
   * 收起态必须**彻底 display:none**（而不是 opacity:0）——
   * 收起态窗口只有球那么大，手柄要是还吃事件，
   * 球就拖不动、点不开了。同理，**非自由边也必须 display:none**，
   * 它们压在球上。
   *
   * ★★ 2026-10-07 11:36：**角手柄已整体退役，这里只留两条自由边。**
   *
   * 用户第三轮反馈原话：「红框标注的这个拖动条，仍然在框外，
   * 尤其是我这种白色背景下，它不仅可视性差，而且，它是在窗口外的一部分，
   * 不美观。而且我发现，拖动窗口调整大小的功能似乎恢复了，
   * 因此，我希望你这一轮仅删除右下角的这个拖动ui。」
   *
   * 为什么连命中区一起撤、而不是只删 CSS 的图案：
   *   一条「看不见但吃事件」的 22px 命中区比不删更糟 ——
   *   ① 用户得不到任何视觉提示，却会在那个位置莫名触发 resize；
   *   ② 它 z-index 6 > 输入框 2，继续在面板角上抢点击；
   *   ③ 用户已确认边条够用，角是冗余的第二入口。
   *
   * ⚠️ 要恢复只需改这一行：
   *   `new Set(on ? [free.h, free.v, safeCorner(dir)] : [])`
   *   并把 CSS 里被删掉的 `.is-corner::after` 规则加回来。
   *   角元素、`CORNER = 22` 几何、`safeCorner()`/`ballCorner()`
   *   **全部原样保留着**，`handles` Map 里 4 个角也照常建出来，
   *   只是被 `display:none` —— 键盘 Tab 循环里也不会出现它们。
   */
  function refresh() {
    const on = isEnabled()
    const dir = getDirection()
    const free = freeEdges(dir)
    // ★ 只留两条自由边；角不在allowed 里 → 永远 display:none。
    const allowed = new Set(on ? [free.h, free.v] : [])
    for (const [d, el] of handles) {
      el.style.display = allowed.has(d) ? 'block' : 'none'
    }
    if (!on) hideReadout()
  }

  function destroy() {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
    window.removeEventListener('blur', onPointerUp)
    hideReadout()
    for (const el of handles.values()) el.remove()
    handles.clear()
  }

  build()
  return { destroy, refresh }
}