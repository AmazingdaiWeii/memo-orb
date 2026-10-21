/**
 * 环形菜单（方案C · 独立窗口）渲染层。
 *
 * ── 这个文件要解决的、旧实现没解决的问题（勘察报告里的 C1–C8）─────────────
 *   C1 坐标系错位：旧实现在球窗口里弹出菜单，窗口先收缩、菜单却拿收缩前的坐标。
 *      方案C 下菜单有自己的窗口，主进程按**球心屏幕坐标**摆放窗口，
 *      渲染层一律用窗口内的局部坐标（0..window），坐标系只有一个。
 *   C2/C3 尺寸与夹取：尺寸不再硬编码，全部由 ring-geometry.js 推导；
 *      窗口夹取在**主进程**做（要把整个窗口摆进工作区）。
 *   C4 环挤在 96×96 的球窗口里：现在是 280×280 的独立窗口。
 *   C5 漏报 setMenuHold：方案C 不需要 —— 菜单自己就是窗口，不必借球窗口的命中。
 *   C6 点了没反应：菜单项的动作由 shell.js 在**展开面板之后**执行（球态下
 *      「历史对话/我们的回忆/头像」这些目的地都在 #panel 里）。
 *   C7 透明度变量只在暗色主题存在：floating.css 已把 --panel-opacity 提到 :root，
 *      拖动结果经主进程落盘（logs/window-state.json）。
 *   C8 命中/热区：环带命中才算「可交互」，中心孔与环外一律穿透 ——
 *      这样中心的球仍然可以点、可以拖，环外不挡桌面。
 *
 *   ★ 环带命中与穿透的实现是「forward + 动态 setIgnoreMouseEvents」这套标准写法：
 *     窗口以 ignore=true + forward=true 起步（mousemove 照样送到渲染层），
 *     渲染层算出光标是否压在环带上，再让主进程切 ignore=false —— 于是
 *     环带能点、孔与环外全穿透。
 */

import { icon, SPARKLE, GLOBE } from './icons.js'
import {
  DEFAULT_RING,
  OPACITY_MIN,
  OPACITY_MAX,
  clampOpacity,
  hitTest,
  itemPositions,
  opacityArc,
  opacityFromPoint,
  pointFromOpacity,
  ringLayout,
} from './ring-geometry.js'

const params = new URLSearchParams(location.search)
const num = (key, fallback) => (params.has(key) ? Number(params.get(key)) : fallback)
const geo = ringLayout({
  outer: num('outer', DEFAULT_RING.outer),
  band: num('band', DEFAULT_RING.band),
  pad: num('pad', DEFAULT_RING.pad),
  // ★ 阴影余量由主进程下发（见 main.js 的 RING_SHADOW_ROOM）。它只影响窗口尺寸，
  //   用来给 #plane 的大范围 box-shadow 留出不被窗口边界切平的余量。
  shadowRoom: num('shadowRoom', DEFAULT_RING.shadowRoom),
})

/**
 * 图标：能复用项目 icons.js 的就复用（保持全项目一套图标语言），
 * 缺的（人像 / 时钟 / 加号）在这里自绘 —— 与参考图同款观感但**不搬它的贴图**。
 * 参考图里的齿轮/播放/连衣裙/闹钟/点心/面具在 orb 没有对应功能，一律不放。
 */
const ITEM_ICONS = {
  avatar: '<path d="M8 7.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z" stroke="currentColor"></path><path d="M3.1 14.1c0-2.3 2.2-3.9 4.9-3.9s4.9 1.6 4.9 3.9" stroke="currentColor"></path>',
  impression: SPARKLE,
  history: '<circle cx="8" cy="8" r="6" stroke="currentColor"></circle><path d="M8 4.5v4l2.5 1.5" stroke="currentColor"></path>',
  'new-chat': '<path d="M8 3.1v9.8" stroke="currentColor"></path><path d="M3.1 8h9.8" stroke="currentColor"></path>',
  // 「API 配置」用经典的三横杆滑杆图标（自绘；语义 = 可调的设置项）。
  'api-config': '<path d="M3 4.6h10" stroke="currentColor"></path><circle cx="6.4" cy="4.6" r="1.5" stroke="currentColor"></circle><path d="M3 8h10" stroke="currentColor"></path><circle cx="9.8" cy="8" r="1.5" stroke="currentColor"></circle><path d="M3 11.4h10" stroke="currentColor"></path><circle cx="7.2" cy="11.4" r="1.5" stroke="currentColor"></circle>',
  // 「主题」用经典的半明半暗圆盘（自绘；语义 = 明暗切换 + 页面背景）。
  theme: '<circle cx="8" cy="8" r="5.6" stroke="currentColor"></circle><path d="M8 2.4a5.6 5.6 0 0 1 0 11.2Z" fill="currentColor" stroke="none"></path>',
  'legacy-web': GLOBE,
  // 「看过的视频」用「圆里一个播放三角」：语义 = 视频 / 看过的片子。
  // （2026-10-21 取代环菜单里的 legacy-web 项。）
  'bili-history': '<circle cx="8" cy="8" r="6" stroke="currentColor"></circle><path d="M6.6 5.2 11.2 8l-4.6 2.8Z" fill="currentColor" stroke="none"></path>',
  // 「隐藏悬浮球」用「眼睛 + 斜杠」：全项目通用的「藏起来」语义，
  // 比任何自创图形都更好认（用户 2026-10-08 要求环菜单里也能藏球）。
  'ball-hide': '<path d="M1.8 8S4.2 4 8 4s6.2 4 6.2 4-2.4 4-6.2 4S1.8 8 1.8 8Z" stroke="currentColor"></path><circle cx="8" cy="8" r="1.9" stroke="currentColor"></circle><path d="M3 13 13 3" stroke="currentColor"></path>',
}
const FALLBACK_ICON = '<circle cx="8" cy="8" r="3.2" stroke="currentColor"></circle>'

/** 没等到主进程数据时的兜底项：只有 id（图标按 id 取），文案留空。 */
const FALLBACK_ITEMS = [{ id: 'avatar' }, { id: 'impression' }, { id: 'history' }, { id: 'new-chat' }, { id: 'bili-history' }, { id: 'ball-hide' }]

const ring = document.getElementById('ring')
const itemsHost = document.getElementById('items')
const hud = document.getElementById('hud')
const hudValue = document.getElementById('hud-value')
const orbit = document.getElementById('orbit')
const orbitTrack = document.getElementById('orbit-track')
const orbitValue = document.getElementById('orbit-value')
const orbitThumb = document.getElementById('orbit-thumb')

const bridge = window.ringMenu ?? {}

const state = {
  items: [],
  opacity: clampOpacity(0.7),
  armed: false,      // 光标是否已经进过环带（没进过就不启动「离开即关闭」计时）
  interactive: false,
  dragging: false,
  hudTimer: undefined,
  leaveTimer: undefined,
  lastMove: 0,
  lastX: -1,
  lastY: -1,
}

/* ── 几何落地：CSS 变量 + SVG 轨道 ─────────────────────────────────────── */
function applyGeometry() {
  const root = document.documentElement.style
  root.setProperty('--ring-window', `${geo.window}px`)
  root.setProperty('--ring-outer', `${geo.outer}px`)
  root.setProperty('--ring-inner', `${geo.inner}px`)
  root.setProperty('--ring-band', `${geo.band}px`)
  root.setProperty('--ring-icon', `${geo.icon}px`)
  root.setProperty('--ring-pad', `${geo.pad}px`)
  root.setProperty('--ring-shadow-room', `${geo.shadowRoom}px`)
  root.setProperty('--ring-mid', `${geo.midR}px`)

  orbit.setAttribute('viewBox', `0 0 ${geo.window} ${geo.window}`)
  for (const circle of [orbitTrack, orbitValue]) {
    circle.setAttribute('cx', String(geo.center))
    circle.setAttribute('cy', String(geo.center))
    circle.setAttribute('r', String(geo.radiusOuter - 5))
  }
  // 进度弧从 12 点开始顺时针长出来
  orbitValue.setAttribute('transform', `rotate(-90 ${geo.center} ${geo.center})`)
  orbitThumb.setAttribute('r', '4')
}

/* ── 透明度（拖动条 → 主进程落盘）────────────────────────────────────── */
function applyOpacity(value, announce = true) {
  state.opacity = clampOpacity(value)
  const arc = opacityArc(geo, state.opacity)
  orbitValue.setAttribute('stroke-dasharray', `${arc.dash} ${arc.gap}`)
  const point = pointFromOpacity(geo, state.opacity)
  orbitThumb.setAttribute('cx', String(point.x))
  orbitThumb.setAttribute('cy', String(point.y))
  // 预览块用的是面板真实材质（暗色 --panel-bg = rgba(21,21,23,opacity)）
  document.documentElement.style.setProperty('--panel-preview', `rgba(21, 21, 23, ${state.opacity.toFixed(3)})`)
  const percent = `${Math.round(state.opacity * 100)}%`
  if (hudValue.textContent !== percent) hudValue.textContent = percent
  if (announce && typeof bridge.opacity === 'function') bridge.opacity(state.opacity)
}

function showHud(transient = false) {
  if (state.hudTimer !== undefined) {
    clearTimeout(state.hudTimer)
    state.hudTimer = undefined
  }
  hud.hidden = false
  if (transient) {
    state.hudTimer = setTimeout(() => {
      state.hudTimer = undefined
      hud.hidden = true
    }, 900)
  }
}

/* ── 菜单项渲染 ───────────────────────────────────────────────────────── */
/**
 * ★ `arc`：主进程算出的「屏幕里可见的那段弧」。
 *   球贴边时环带会被屏幕切掉一块，整圈均布会让几个图标落在屏幕外（看不见也点不到）；
 *   拿到弧之后，全部图标都铺在弧内（几何见 assets/ring-geometry.js 的 itemPositions/visibleItemArc）。
 *   `null` = 整圈可见 → 走原来的整圈均布，观感与参考图一致。
 */
function renderItems(list, arc = null) {
  const items = Array.isArray(list) && list.length > 0 ? list : FALLBACK_ITEMS
  state.items = items
  itemsHost.replaceChildren()
  const positions = itemPositions(geo, items.length, arc)
  items.forEach((item, index) => {
    const id = String(item?.id ?? '')
    const position = positions[index]
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ring-item'
    button.dataset.id = id
    button.setAttribute('role', 'menuitem')
    button.setAttribute('aria-label', String(item?.label ?? id))
    button.style.setProperty('--dx', `${position.dx.toFixed(2)}px`)
    button.style.setProperty('--dy', `${position.dy.toFixed(2)}px`)
    button.style.setProperty('--i', String(index))
    // 标签沿半径**向环内**弹（环外没有窗口余量）：-单位向量 × (图标半宽 + 18)
    const inset = geo.icon / 2 + 18
    button.style.setProperty('--lx', `${(-Math.cos(position.angle) * inset).toFixed(2)}px`)
    button.style.setProperty('--ly', `${(-Math.sin(position.angle) * inset).toFixed(2)}px`)
    button.append(icon(ITEM_ICONS[id] ?? FALLBACK_ICON, 24, '0 0 16 16'))
    const label = String(item?.label ?? '')
    if (label) {
      const span = document.createElement('span')
      span.className = 'ring-item-label'
      span.textContent = label
      button.append(span)
    }
    // 用 pointerup 而不是 click：环带上的 pointerdown 起手是「拖透明度」，
    // 只有落在按钮上的那一下才算「点了菜单项」（见 onPointerDown 的分支）。
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (typeof bridge.action === 'function') bridge.action(id)
    })
    itemsHost.append(button)
  })
}

/* ── 穿透 / 命中 ──────────────────────────────────────────────────────── */
function setInteractive(next) {
  if (next === state.interactive) return
  state.interactive = next
  if (typeof bridge.hit === 'function') bridge.hit(next)
}

function close() {
  if (typeof bridge.close === 'function') bridge.close()
}

function cancelLeave() {
  if (state.leaveTimer !== undefined) {
    clearTimeout(state.leaveTimer)
    state.leaveTimer = undefined
  }
}

function scheduleLeave() {
  if (state.leaveTimer !== undefined) return
  state.leaveTimer = setTimeout(() => {
    state.leaveTimer = undefined
    if (!state.dragging && !state.interactive) close()
  }, 320)
}

function onPointerMove(event) {
  state.lastMove = Date.now()
  const hit = hitTest(geo, event.clientX, event.clientY, 7)
  if (state.dragging) {
    applyOpacity(opacityFromPoint(geo, event.clientX, event.clientY))
    setInteractive(true)
    return
  }
  if (hit.inside) {
    state.armed = true
    cancelLeave()
    document.body.classList.add('is-slider-hover')
  } else {
    document.body.classList.remove('is-slider-hover')
    if (state.armed) scheduleLeave()
  }
  setInteractive(hit.inside)
}

function onPointerDown(event) {
  if (event.button !== 0) return
  // 落在菜单项上：交给 click，不当拖动条
  if (event.target instanceof Element && event.target.closest('.ring-item')) return
  const hit = hitTest(geo, event.clientX, event.clientY, 7)
  if (!hit.inside) return
  state.armed = true
  state.dragging = true
  cancelLeave()
  document.body.classList.add('is-slider-active')
  setInteractive(true)
  applyOpacity(opacityFromPoint(geo, event.clientX, event.clientY))
  showHud()
  event.preventDefault()
}

function onPointerUp() {
  if (!state.dragging) return
  state.dragging = false
  document.body.classList.remove('is-slider-active')
  showHud(true)
  const hit = hitTest(geo, state.lastX ?? -1, state.lastY ?? -1, 7)
  if (!hit.inside) setInteractive(false)
}

/** 兜底：光标跑出窗口后 mousemove 不再到达，光靠「离开计时」会把菜单永远挂在屏幕上。 */
function watchStale() {
  setInterval(() => {
    if (!state.armed || state.dragging || state.interactive) return
    if (Date.now() - state.lastMove > 1200) close()
  }, 300)
}

/* ── 装配 ─────────────────────────────────────────────────────────────── */
applyGeometry()
renderItems(FALLBACK_ITEMS)
applyOpacity(state.opacity, false)

document.addEventListener('pointermove', (event) => {
  state.lastX = event.clientX
  state.lastY = event.clientY
  onPointerMove(event)
})
document.addEventListener('pointerdown', onPointerDown)
document.addEventListener('pointerup', onPointerUp)
document.addEventListener('contextmenu', (event) => event.preventDefault())
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') close()
})
document.addEventListener('mouseleave', () => {
  if (state.armed && !state.dragging) scheduleLeave()
})

if (typeof bridge.onData === 'function') {
  bridge.onData((payload) => {
    const data = payload && typeof payload === 'object' ? payload : {}
    const arc = data.arc && Number.isFinite(Number(data.arc.size)) ? data.arc : null
    if (Array.isArray(data.items)) renderItems(data.items, arc)
    if (Number.isFinite(Number(data.opacity))) applyOpacity(Number(data.opacity), false)
    // 重放出现动画：窗口是 showInactive 直接显示的，DOM 不会自己重跑动画
    ring.classList.remove('is-open')
    void ring.offsetWidth
    ring.classList.add('is-open')
    state.armed = false
    state.dragging = false
    state.interactive = false
    state.lastMove = Date.now()
    cancelLeave()
    hud.hidden = true
  })
}

watchStale()
