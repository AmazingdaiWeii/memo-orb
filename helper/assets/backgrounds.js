/**
 * backgrounds.js —— 面板背景层（用户 m02033：「三个页面各自一张背景图，
 * 随功能切换加载」）。
 *
 * 三个槽对应面板里三个可切换的页面（与 shell.js 的抽屉状态一一对应）：
 *   chat    → #transcript（对话页，也是所有抽屉之外的默认页）
 *   history → #history-list（历史对话）
 *   recall  → #impression（记忆中心 =「我们的回忆」）
 *
 * ★ 为什么是「面板内的一层 DOM」而不是「第二个窗口」：
 *   用户真正要的是**图片不变形**。形变从来不是层数问题，而是适配方式问题 ——
 *   只要用 cover / contain / auto（都不拉伸图元），窗口被拖大拖小时
 *   图片只是「换裁切区域 / 换留边 / 露出更多」，元素本身一个像素都不变形。
 *   反之若真开第二个窗口，它得自己跟踪面板的位置与尺寸、切换视图时还要
 *   另走一条 IPC，复杂度翻倍而效果相同。
 *
 * ★ 真源全在主进程（`helper/lib/main.js` 的 orb:bg-* 与 window-state.json）：
 *   本模块只负责把快照画到 DOM 上，不读盘、不记账。
 *
 * ★ 图片路径只认 `backgrounds/bg-<slot>-<时间戳>.<ext>` 这一种形状
 *   （主进程已按同名正则校验过一次，这里再挡一次：CSS 里拼字符串，
 *   绝不能出现 `..`、引号或绝对路径）。
 */

/** 三个槽的固定顺序 —— 与主进程 BG_SLOTS 一一对应，改一处必须同步改那边。 */
export const BG_SLOTS = ['chat', 'history', 'recall']
/** 适配方式：铺满裁切 / 完整留边 / 原始像素。三者都不形变。 */
export const BG_FITS = ['cover', 'contain', 'auto']

const BG_URL = /^backgrounds\/bg-[a-z0-9][a-z0-9._-]*\.(?:png|jpe?g|webp|gif)$/i

/** 页面（视图）名 → 槽名。抽屉级页面（API 配置 / 主题 / 锁卡）沿用聊天页。 */
export function slotForView(view) {
  return BG_SLOTS.includes(view) ? view : 'chat'
}

/** 校验主进程给的相对路径；不合法就当没设背景。 */
export function safeBackgroundUrl(url) {
  return typeof url === 'string' && BG_URL.test(url) ? url : ''
}

export function createBackgrounds() {
  const panel = document.querySelector('#panel')
  const scrim = document.querySelector('#bg-scrim')
  const layers = new Map()
  for (const slot of BG_SLOTS) {
    const node = document.querySelector(`.bg-layer[data-slot="${slot}"]`)
    if (node) layers.set(slot, node)
  }

  let snapshot = null
  let view = 'chat'

  function entryFor(slot) {
    const entry = snapshot?.slots?.[slot]
    return entry && typeof entry === 'object' ? entry : null
  }

  /** 把一槽的图片与适配方式写到对应图层上。 */
  function paintLayer(slot) {
    const node = layers.get(slot)
    if (!node) return
    const entry = entryFor(slot)
    const url = safeBackgroundUrl(entry?.url)
    node.style.backgroundImage = url === '' ? '' : `url("${url}")`
    node.style.backgroundSize = BG_FITS.includes(entry?.fit) ? entry.fit : 'cover'
  }

  /** 蒙层只跟着**当前视图那一槽**；没设背景的视图浓度恒为 0。 */
  function paintScrim() {
    if (!scrim) return
    const entry = entryFor(slotForView(view))
    const url = safeBackgroundUrl(entry?.url)
    const alpha = url === '' ? 0 : Number(entry?.scrim)
    scrim.style.opacity = String(Number.isFinite(alpha) ? Math.min(0.9, Math.max(0, alpha)) : 0)
  }

  /** 主进程快照 → DOM。onBackgrounds 每次推送都会走这里（幂等）。 */
  function apply(payload) {
    snapshot = payload && typeof payload === 'object' ? payload : null
    for (const slot of BG_SLOTS) paintLayer(slot)
    paintScrim()
  }

  /** 视图切换：由 shell.js 的 syncQuestion() 调（那里的 drawerOpen 判断是唯一真源）。 */
  function setView(next) {
    const resolved = slotForView(next)
    if (resolved !== view) view = resolved
    if (panel && panel.dataset.view !== view) panel.dataset.view = view
    paintScrim()
  }

  if (panel && panel.dataset.view === undefined) panel.dataset.view = view

  return {
    apply,
    setView,
    getView: () => view,
    getSnapshot: () => snapshot,
  }
}
