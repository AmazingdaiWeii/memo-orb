/**
 * 环形菜单几何 —— 纯函数，不碰 DOM、不碰 Electron。
 *
 * 为什么要把几何单独抽成一个模块：
 *   1. 旧实现把「菜单 200×200」「按钮半径 62」「按钮盒 48」三组数字分别硬编码在
 *      `ring-menu.css` 与 `ring-menu.js` 里，改一处忘一处 —— 这就是勘察报告里
 *      「口径不一致」类问题的温床。现在尺寸只有一个来源（本文件的几何参数），
 *      CSS 变量与按钮坐标都从它推导。
 *   2. 主进程要用同一组参数决定窗口大小（`helper/lib/main.js` 的 RING_* 常量），
 *      探针 `probe/ring-geometry-test.mjs` 会正则解析 main.js 断言两边一致 ——
 *      照 `probe/handles-vs-menu-test.mjs` 的纪律：**断言必须从产品文件里抽，
 *      不能抄探针作者记忆里的数字**。
 *   3. 纯函数可以被 `node` 直接 import 做断言：圆心、间距、命中、透明度映射
 *      全都是可复算的，不需要真窗口。
 *
 * 坐标系：以环菜单窗口左上角为原点，单位 CSS px。
 * 圆心恒在窗口正中 (`window / 2`)；`pad` 是环外缘到窗口边的留白。
 */

/**
 * 默认几何：外径 248 / 环带宽 40 / 外边距 16 / 阴影余量 56。
 * 中心孔 168×168。
 *
 * ★ 2026-10-08：「阴影余量」是可选项，加它是因为用户截图里环菜单上有个**隐约的方块**。
 *   量出来的根因：`#plane` 的 `box-shadow: 0 22px 54px` 外扩 = 22 + 54/2 = **49px**，
 *   而窗口只留了 `pad`(16px) —— 阴影被窗口边界切平，梯度戛然而止，看起来就是一个方块。
 *   所以 `window = outer + 2*(pad + shadowRoom)`：窗口撑大到能装下阴影，
 *   而环的视觉尺寸（outer/band/inner/图标位置/命中区）**一点不变**。
 *   56 = 49 + 7 余量（断言 5.2 会从 CSS 反算实际外扩来卡这一条，改阴影必须同步改这里）。
 *   缺省 0 时退化为旧行为 `window = outer + 2*pad`，兼容既有调用。
 */
export const DEFAULT_RING = { outer: 248, band: 40, pad: 16, shadowRoom: 56 }

/** 面板毛玻璃透明度的可调范围。低于 0.2 面板基本看不见，高于 1 无意义。 */
export const OPACITY_MIN = 0.2
export const OPACITY_MAX = 1

function positive(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * 由外径/带宽/边距推导出所有派生尺寸。
 * - `inner`：中心孔直径（= outer - 2*band）
 * - `midR`：环带中线半径，图标圆心都落在这条弧上
 * - `icon`：图标按钮盒边长（随带宽伸缩，强约束在环带内）
 * - `window`：环菜单窗口边长（outer + 2*(pad + shadowRoom)）
 * - `ringInset`：环外缘到窗口边的**总**留白（= pad + shadowRoom）—— 
 *   环带/投影层的视觉尺寸由 outer 决定、靠居中定位，不再吃这个值；
 *   它只描述「窗口比环大多少」。
 */
export function ringLayout(geo = DEFAULT_RING) {
  const outer = positive(geo.outer, DEFAULT_RING.outer)
  const band = positive(geo.band, DEFAULT_RING.band)
  const pad = Number.isFinite(Number(geo.pad)) && Number(geo.pad) >= 0 ? Number(geo.pad) : DEFAULT_RING.pad
  // 阴影余量：允许为 0（退化成旧行为）；非法值一律当 0，绝不因为写错就把窗口撑爆。
  const shadowRoomRaw = Number(geo.shadowRoom)
  const shadowRoom = Number.isFinite(shadowRoomRaw) && shadowRoomRaw > 0 ? shadowRoomRaw : 0
  const inner = Math.max(24, outer - 2 * band)
  const midR = (outer / 2 + inner / 2) / 2
  // 图标盒不超过带宽的 62%（留出 hover 放大的余量），也不超过外径的 11%（大环时别显得小气）。
  const icon = Math.round(Math.min(band * 0.62, outer * 0.11))
  const window = outer + 2 * (pad + shadowRoom)
  const center = window / 2
  // 悬停放大到 1.18 倍后仍必须完整落在窗口内 —— 断言里要用这个最坏尺寸。
  const iconHover = icon * 1.18
  return {
    outer,
    band,
    pad,
    shadowRoom,
    ringInset: pad + shadowRoom,
    inner,
    midR,
    icon,
    iconHover,
    window,
    center,
    radiusOuter: outer / 2,
    radiusInner: inner / 2,
  }
}

/**
 * 图标圆心坐标：默认从 12 点开始顺时针均匀分布（第一个在正上方，与参考图一致）。
 * 图标**不随角度旋转**（transform 只做平移，不做 rotate）—— 参考图里所有图标都是直立的。
 *
 * `arc`（可选）把图标限制在一段弧里：`{ start, size }`，角度用本文件的约定
 * （-π/2 = 12 点，顺时针增加；y 轴向下）。
 * ★ 为什么需要它（用户 m01036 反馈「球体没有出现在菜单的中央」）：
 *   旧版主进程把环菜单窗口**夹取**进屏幕工作区，于是环心偏离球心最多 92px。
 *   现在圆心恒等于球心（不夹取），代价是贴边时整圈会被屏幕切掉一块 ——
 *   落在屏幕外的图标既看不见也点不到。主进程用 `visibleItemArc()` 算出
 *   屏幕上真实可见的那段弧并下发给渲染层，图标就全部铺在弧内。
 * `arc` 为 `null`（或覆盖整圈）时退回「整圈均布」，与旧行为逐像素一致。
 */
export function itemPositions(geo, count, arc = null) {
  const n = Math.max(1, Math.floor(count))
  const span = arcSpan(arc)
  const out = []
  for (let i = 0; i < n; i += 1) {
    const t = span === null ? i / n : (i + 0.5) / n
    const angle = span === null ? -Math.PI / 2 + t * Math.PI * 2 : span.start + t * span.size
    const twoPi = Math.PI * 2
    out.push({
      index: i,
      angle,
      // 度数（0 = 12 点，顺时针增加），排障与报告里用得上
      degrees: ((((angle + Math.PI / 2) % twoPi) + twoPi) % twoPi) * (180 / Math.PI),
      x: geo.center + Math.cos(angle) * geo.midR,
      y: geo.center + Math.sin(angle) * geo.midR,
      dx: Math.cos(angle) * geo.midR,
      dy: Math.sin(angle) * geo.midR,
    })
  }
  return out
}

/** 把 `arc` 归一化成 `{ start, size }`；无效或覆盖整圈时返回 `null`（= 整圈均布）。 */
export function arcSpan(arc) {
  if (!arc) return null
  const start = Number(arc.start)
  const size = Number(arc.size)
  if (!Number.isFinite(start) || !Number.isFinite(size)) return null
  if (size <= 0 || size >= Math.PI * 2 * 0.999) return null
  return { start, size }
}

/**
 * 算出「图标圆心环」上有多少落在工作区里，返回可见的那段弧（环上最长的一段连续可见区）；
 * 整圈都可见时返回 `null`（调用方按整圈均布）。
 *
 * @param {object} geo       `ringLayout()` 的结果（用到 center / midR / iconHover）
 * @param {object} bounds    环菜单窗口在**屏幕坐标**里的位置 `{x,y,width,height}`
 * @param {object} workArea  显示器工作区（屏幕坐标）
 * @param {number} samples   采样数，默认 720（每 0.5°）
 * @param {number} margin    图标盒到工作区边缘至少留的空隙（px）
 * @returns {{start:number,size:number,degrees:number}|null}
 */
export function visibleItemArc(geo, bounds, workArea, samples = 720, margin = 4) {
  if (!geo || !bounds || !workArea) return null
  const total = Math.max(8, Math.floor(samples))
  const step = (Math.PI * 2) / total
  const half = geo.iconHover / 2
  const mask = new Array(total)
  let allVisible = true
  for (let i = 0; i < total; i += 1) {
    const angle = -Math.PI / 2 + i * step
    const x = bounds.x + geo.center + Math.cos(angle) * geo.midR
    const y = bounds.y + geo.center + Math.sin(angle) * geo.midR
    const ok =
      x - half >= workArea.x + margin &&
      x + half <= workArea.x + workArea.width - margin &&
      y - half >= workArea.y + margin &&
      y + half <= workArea.y + workArea.height - margin
    mask[i] = ok
    if (!ok) allVisible = false
  }
  if (allVisible) return null
  // 环形数组里的最长 true 段：从第一个 false 的下一格开始扫，
  // 段就不会被数组首尾截断（第一格是 false，说明没有 true 段跨过它）。
  const firstBlocked = mask.indexOf(false)
  if (firstBlocked < 0) return null
  let bestStart = -1
  let bestLen = 0
  let runStart = -1
  let runLen = 0
  for (let k = 1; k <= total; k += 1) {
    const idx = (firstBlocked + k) % total
    if (mask[idx]) {
      if (runStart < 0) runStart = idx
      runLen += 1
      if (runLen > bestLen) {
        bestLen = runLen
        bestStart = runStart
      }
    } else {
      runStart = -1
      runLen = 0
    }
  }
  if (bestLen <= 0) return null
  return { start: -Math.PI / 2 + bestStart * step, size: bestLen * step, degrees: (bestLen * step * 180) / Math.PI }
}

/** 相邻图标圆心之间的弦长 —— 用于「图标不重叠」断言。 */
export function itemSpacing(geo, count) {
  const n = Math.max(2, Math.floor(count))
  return 2 * geo.midR * Math.sin(Math.PI / n)
}

/** 图标按钮盒（含 hover 最坏尺寸）的四边，用于「完整落在窗口内」断言。 */
export function itemBox(geo, position, size = geo.iconHover) {
  const half = size / 2
  return { left: position.x - half, top: position.y - half, right: position.x + half, bottom: position.y + half }
}

/**
 * 环带命中测试。`slop` 把环带内外各放宽几像素 —— 光标贴着边缘时不该掉命中。
 * 返回 `{ inside, r, angle, degrees }`：`inside` 为真表示可以吃鼠标事件（点击/拖动）。
 */
export function hitTest(geo, x, y, slop = 6) {
  const dx = x - geo.center
  const dy = y - geo.center
  const r = Math.hypot(dx, dy)
  const angle = normalizeAngle(Math.atan2(dy, dx) + Math.PI / 2)
  return {
    inside: r >= geo.radiusInner - slop && r <= geo.radiusOuter + slop,
    r,
    angle,
    degrees: (angle * 180) / Math.PI,
  }
}

function normalizeAngle(rad) {
  const twoPi = Math.PI * 2
  return ((rad % twoPi) + twoPi) % twoPi
}

export function clampOpacity(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return OPACITY_MIN
  return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, n))
}

/**
 * 把环上一点映射成透明度：12 点 = 最小值(0.2)，顺时针一圈回到 12 点 = 最大值(1)。
 * 拖动条就是把「圆环的角度」当滑轨 —— 这是用户明确要的形态
 * （`收尾待办.md` §4.1：拖动条放在环形菜单外围的圆环上）。
 */
export function opacityFromPoint(geo, x, y) {
  const { angle } = hitTest(geo, x, y, 0)
  const t = angle / (Math.PI * 2)
  return clampOpacity(OPACITY_MIN + t * (OPACITY_MAX - OPACITY_MIN))
}

/** `opacityFromPoint` 的逆：给透明度求环上的指示点（轨道圆点用）。 */
export function pointFromOpacity(geo, value, radius = geo.radiusOuter - 5) {
  const v = clampOpacity(value)
  const t = (v - OPACITY_MIN) / (OPACITY_MAX - OPACITY_MIN)
  const angle = t * Math.PI * 2 - Math.PI / 2
  return { x: geo.center + Math.cos(angle) * radius, y: geo.center + Math.sin(angle) * radius, angle, t }
}

/** 拖动条进度弧的 dash 长度：`{ dash, gap }`，配合 `stroke-dasharray` 使用。 */
export function opacityArc(geo, value, radius = geo.radiusOuter - 5) {
  const { t } = pointFromOpacity(geo, value, radius)
  const circumference = Math.PI * 2 * radius
  return { circumference, dash: circumference * t, gap: circumference * (1 - t), radius }
}
