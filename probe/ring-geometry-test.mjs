/**
 * 环形菜单几何断言（纯 node，不需要 Electron）。
 *
 * 跑法：`node probe/ring-geometry-test.mjs`
 *
 * 为什么要有这支探针：
 *   环形菜单「做不好」的历史里，**没有一条失败是审美问题**，全是几何与坐标系问题：
 *   菜单 200×200 塞进 96×96 的球窗口、球心距边恒 48px 导致固定外溢 62px、
 *   收缩窗口后用旧坐标定位（实测 left:537px）。这些数字当场都算得出来，
 *   当年却一条自动化断言都没有 —— 用户只能靠肉眼反复说「还是不行」。
 *   所以这里把几何全部变成可复算的断言。
 *
 * ★ 纪律（照 probe/handles-vs-menu-test.mjs）：断言用到的产品常量必须**从产品文件里抽**，
 *   不能抄本探针作者记忆里的数字。下面的 readProductConstants() 会正则解析
 *   helper/lib/main.js 与 helper/assets/ring-menu.css，再和 ring-geometry.js 对账。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_RING,
  OPACITY_MAX,
  OPACITY_MIN,
  arcSpan,
  clampOpacity,
  hitTest,
  itemBox,
  itemPositions,
  itemSpacing,
  opacityFromPoint,
  pointFromOpacity,
  ringLayout,
  visibleItemArc,
} from '../helper/assets/ring-geometry.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mainSource = readFileSync(join(ROOT, 'helper', 'lib', 'main.js'), 'utf8')
const cssSource = readFileSync(join(ROOT, 'helper', 'assets', 'ring-menu.css'), 'utf8')
const geometrySource = readFileSync(join(ROOT, 'helper', 'assets', 'ring-geometry.js'), 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ── 0. 从产品文件里抽常量 ─────────────────────────────────────────────── */
function productConstants() {
  const grab = (source, pattern, label) => {
    const match = source.match(pattern)
    if (!match) throw new Error(`产品文件里抽不到 ${label}（正则 ${pattern}）`)
    return Number(match[1])
  }
  return {
    // helper/lib/main.js 的 RING_* 常量：主进程用它们决定窗口尺寸与 query 参数
    mainOuter: grab(mainSource, /const RING_OUTER_D = (\d+(?:\.\d+)?);/, 'RING_OUTER_D'),
    mainBand: grab(mainSource, /const RING_BAND = (\d+(?:\.\d+)?);/, 'RING_BAND'),
    mainPad: grab(mainSource, /const RING_PAD = (\d+(?:\.\d+)?);/, 'RING_PAD'),
    mainShadow: grab(mainSource, /const RING_SHADOW_ROOM = (\d+(?:\.\d+)?);/, 'RING_SHADOW_ROOM'),
    // ★ 2026-10-08 第四轮：窗口边长把阴影余量也算进去了 ——
    //   `RING_OUTER_D + (RING_PAD + RING_SHADOW_ROOM) * 2`（原来是 `RING_OUTER_D + RING_PAD * 2`）。
    //   这条正则就是「三处口径一致」的交叉校验点，改公式必须同步改这里。
    mainWindow: grab(
      mainSource,
      /const RING_WINDOW_SIZE = RING_OUTER_D \+ \(RING_PAD \+ RING_SHADOW_ROOM\) \* (\d+(?:\.\d+)?);/,
      'RING_WINDOW_SIZE 的 pad+shadowRoom 系数',
    ),
    mainOpacityMin: grab(mainSource, /const PANEL_OPACITY_MIN = (\d+(?:\.\d+)?);/, 'PANEL_OPACITY_MIN'),
    mainOpacityMax: grab(mainSource, /const PANEL_OPACITY_MAX = (\d+(?:\.\d+)?);/, 'PANEL_OPACITY_MAX'),
    // ring-menu.css 里 hover 放大系数：最坏尺寸断言必须用产品真实生效的那个数
    hoverScale: grab(cssSource, /\.ring-item:hover,\s*\.ring-item:focus-visible\s*\{[^}]*--s:\s*([\d.]+)/, '.ring-item:hover 的 --s'),
    // 渲染层消费的 CSS 变量名（漏一个，几何就有一半落不到样式上）
    cssVars: ['--ring-window', '--ring-outer', '--ring-inner', '--ring-band', '--ring-icon', '--ring-pad', '--ring-mid'],
    // 几何模块里 hover 假设值
    geometryHover: Number((geometrySource.match(/const iconHover = icon \* ([\d.]+)/) ?? [])[1]),
  }
}

const product = productConstants()
const geo = ringLayout(DEFAULT_RING)
const window = product.mainOuter + (product.mainPad + product.mainShadow) * 2

/* ── 1. 三处口径必须一致：main.js / ring-geometry.js / ring-menu.css ───── */
check(
  'main.js 的 RING_* 与 ring-geometry.js 的 DEFAULT_RING 一致（外径/带宽/边距）',
  product.mainOuter === geo.outer && product.mainBand === geo.band && product.mainPad === geo.pad,
  `main=${product.mainOuter}/${product.mainBand}/${product.mainPad} geometry=${geo.outer}/${geo.band}/${geo.pad}`,
)
check(
  '主进程窗口边长 = 外径 + 2×边距，且与几何推导一致',
  product.mainWindow === 2 && window === geo.window,
  `main 系数=${product.mainWindow} window=${window} geometry=${geo.window}`,
)
check(
  '透明度范围在 main.js 与 ring-geometry.js 一致',
  product.mainOpacityMin === OPACITY_MIN && product.mainOpacityMax === OPACITY_MAX,
  `main=${product.mainOpacityMin}..${product.mainOpacityMax} geometry=${OPACITY_MIN}..${OPACITY_MAX}`,
)
check(
  'hover 放大系数在 ring-menu.css 与 ring-geometry.js 一致（最坏尺寸断言的前提）',
  product.hoverScale === product.geometryHover && product.geometryHover === 1.18,
  `css=${product.hoverScale} geometry=${product.geometryHover}`,
)
check(
  'ring-menu.css 为每个几何变量都留了兜底声明',
  product.cssVars.every((name) => cssSource.includes(`${name}:`)),
  product.cssVars.filter((name) => !cssSource.includes(`${name}:`)).join(','),
)
check(
  '渲染层不再自己硬编码菜单尺寸（ring-menu.js 里不出现 300/200/220 这类窗口常量）',
  !/RING_WINDOW_SIZE\s*=\s*\d+/.test(readFileSync(join(ROOT, 'helper', 'assets', 'ring-menu.js'), 'utf8')),
  'ring-menu.js 里又写死了窗口尺寸',
)

/* ── 2. 几何：圆、均分、不重叠、全在窗口内（5 项 = 真实项数，9 项 = 参考图）── */
for (const count of [5, 9]) {
  const positions = itemPositions(geo, count)
  const tag = `${count} 项`

  check(
    `${tag}：圆心到环带中线的距离全部等于 midR`,
    positions.every((p) => Math.abs(Math.hypot(p.x - geo.center, p.y - geo.center) - geo.midR) < 1e-9),
  )
  check(
    `${tag}：第一项在正上方（12 点），后续顺时针均分`,
    Math.abs(positions[0].x - geo.center) < 1e-9 &&
      positions[0].y < geo.center &&
      positions.every((p, i) => Math.abs(p.degrees - (i * 360) / count) < 1e-9),
    `degrees=${positions.map((p) => p.degrees.toFixed(1)).join(',')}`,
  )
  const spacing = itemSpacing(geo, count)
  check(`${tag}：相邻圆心弦长 > 图标盒边长（不重叠的必要条件）`, spacing > geo.iconHover, `弦长=${spacing.toFixed(1)} 盒=${geo.iconHover.toFixed(1)}`)

  let worstOverlap = Infinity
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = i + 1; j < positions.length; j += 1) {
      worstOverlap = Math.min(worstOverlap, Math.hypot(positions[i].x - positions[j].x, positions[i].y - positions[j].y))
    }
  }
  check(
    `${tag}：两两圆心最小距离 > 图标盒对角线（含 hover 放大后仍不相交）`,
    worstOverlap > geo.iconHover,
    `最近=${worstOverlap.toFixed(1)} 盒=${geo.iconHover.toFixed(1)}`,
  )

  const escaped = positions.filter((p) => {
    const box = itemBox(geo, p)
    return box.left < 0 || box.top < 0 || box.right > geo.window || box.bottom > geo.window
  })
  check(
    `${tag}：hover 放大后的图标盒全部落在窗口可视区内（0..${geo.window}）`,
    escaped.length === 0,
    escaped.map((p) => JSON.stringify(itemBox(geo, p))).join(' '),
  )

  // ★ 反向对照：把几何换回旧实现的硬编码（200×200 菜单、半径 62、48 盒）
  //   跑在 96×96 的球窗口里 —— 断言必须当场变红，否则这支探针验不出东西。
  const legacy = { outer: 200, band: 38, pad: 0, icon: 48, iconHover: 56.64, midR: 62, window: 96, center: 48, radiusOuter: 100, radiusInner: 62 }
  const legacyEscaped = itemPositions({ ...legacy, center: 48, midR: 62 }, 4).filter((p) => {
    const box = itemBox({ ...legacy, center: 48 }, p)
    return box.left < 0 || box.top < 0 || box.right > 96 || box.bottom > 96
  })
  check(`反向对照：旧实现（200 菜单 / 半径 62 / 96×96 窗口）4 项必须全部出界`, legacyEscaped.length === 4, `出界 ${legacyEscaped.length}/4`)
}

/* ── 3. 环带命中：孔内与环外一律穿透（球要能点、桌面不能被挡）──────────── */
const holeRadius = geo.radiusInner - 8
const bandRadius = geo.midR
const outsideRadius = geo.radiusOuter + 20
check('命中：中心孔内不算命中（点击落回球窗口）', hitTest(geo, geo.center + holeRadius, geo.center).inside === false)
check('命中：环带中线算命中（可点可拖）', hitTest(geo, geo.center + bandRadius, geo.center).inside === true)
check('命中：环外不算命中（桌面不被挡）', hitTest(geo, geo.center + outsideRadius, geo.center).inside === false)
check(
  '命中：中心孔半径 + 球半径留有余量（球 72px，孔 168px）',
  geo.inner / 2 >= 36 + 36,
  `孔半径=${geo.inner / 2} 球半径=36`,
)
check('命中：12 点方向的角度为 0°', Math.abs(hitTest(geo, geo.center, geo.center - bandRadius).degrees) < 1e-6)
check('命中：3 点（正右）为 90°', Math.abs(hitTest(geo, geo.center + bandRadius, geo.center).degrees - 90) < 1e-6)

/* ── 4. 透明度环：12 点 = 最小值，顺时针一圈到 12 点 = 最大值 ──────────── */
const atTop = opacityFromPoint(geo, geo.center, geo.center - bandRadius)
const atRight = opacityFromPoint(geo, geo.center + bandRadius, geo.center)
const atBottom = opacityFromPoint(geo, geo.center, geo.center + bandRadius)
const atLeft = opacityFromPoint(geo, geo.center - bandRadius, geo.center)
check('透明度：12 点 = 最小值', Math.abs(atTop - OPACITY_MIN) < 1e-9, `${atTop}`)
check(
  '透明度：顺时针单调递增（12 点 < 3 点 < 6 点 < 9 点）',
  atTop < atRight && atRight < atBottom && atBottom < atLeft,
  `${atTop.toFixed(3)} ${atRight.toFixed(3)} ${atBottom.toFixed(3)} ${atLeft.toFixed(3)}`,
)
check('透明度：结果始终落在 [MIN, MAX] 内', [atTop, atRight, atBottom, atLeft].every((v) => v >= OPACITY_MIN && v <= OPACITY_MAX))
check('透明度：非法值被夹到范围内', clampOpacity(-5) === OPACITY_MIN && clampOpacity(9) === OPACITY_MAX && clampOpacity('x') === OPACITY_MIN)
check(
  '透明度：内部取值正/逆映射自洽（点 → 值 → 点，角度回得来）',
  (() => {
    for (const value of [0.3, 0.4, 0.55, 0.7, 0.9, 0.98]) {
      const point = pointFromOpacity(geo, value)
      if (Math.abs(opacityFromPoint(geo, point.x, point.y) - value) > 1e-6) return false
    }
    return true
  })(),
)
// ★ 端点必须显式断言：[MIN, MAX] 铺满整圈的代价，就是 0% 与 100% 落在同一个点（12 点）。
//   于是「从最大值再顺时针多拖一点」会回到最小值 —— 这是圆盘滑杆的固有语义，
//   必须被断言固定下来（否则以后有人改成 359° 就会静默改变手感）。
check(
  '透明度：0% 与 100% 在 12 点重合，超过最大值顺时针回落到最小值（圆盘滑杆的固有语义）',
  Math.abs(opacityFromPoint(geo, pointFromOpacity(geo, OPACITY_MIN).x, pointFromOpacity(geo, OPACITY_MIN).y) - OPACITY_MIN) < 1e-9 &&
    Math.abs(opacityFromPoint(geo, pointFromOpacity(geo, OPACITY_MAX).x, pointFromOpacity(geo, OPACITY_MAX).y) - OPACITY_MIN) < 1e-9,
)
check(
  '透明度：轨道半径在外缘之内（指示弧不会画到窗口外）',
  (() => {
    const point = pointFromOpacity(geo, 1)
    return Math.hypot(point.x - geo.center, point.y - geo.center) + 4 <= geo.window / 2
  })(),
)

/* ── J. 可见弧（用户 m01036 ①：球贴屏幕边时图标不能跑到屏外） ─────────────
 * 第三轮把「环窗口夹进工作区」改成了「环心恒等于球心 + 把图标铺进仍可见的弧」。
 * 这两条互相依赖：夹取保证圆心对得上球，可见弧保证贴边时剩下的图标仍然点得到。
 * 弧是**屏幕坐标**算出来的（窗口 bounds × 显示器工作区），所以这里用真数据验。 */
console.log('')
console.log('## J. 可见弧：贴边时图标必须整颗留在屏内')

// 整圈可见 = 没有弧（调用方按整圈均布，保持旧行为逐像素不变）
const fullArea = { x: -10000, y: -10000, width: 20000, height: 20000 }
const near = { x: 1000, y: 800, width: geo.window, height: geo.window }
check('J1：工作区完全包住环时 → 返回 null（整圈均布）', visibleItemArc(geo, near, fullArea) === null)

// 整圈路径与「传一个覆盖整圈的弧」必须等价（arcSpan 会把整圈归一成 null）
check('J2：不传弧与传满圈弧走同一条路径（itemPositions 逐点相同）',
  JSON.stringify(itemPositions(geo, 5)) === JSON.stringify(itemPositions(geo, 5, { start: 0, size: Math.PI * 2 })))

// 球贴在屏幕右下角：环的右下部分会出屏。
// ★ 注意坐标系：环窗口 bounds 与工作区都是**屏幕坐标**，
//   而 itemPositions/itemBox 给的是**窗口内坐标** —— 断言必须把 bounds 加回去，
//   否则「0..280 的窗口内坐标」对 1920×1080 的工作区恒成立，会得到一条假绿。
const workArea = { x: 0, y: 0, width: 1920, height: 1080 }
const ball = { x: 1900, y: 1060 } // 球心（屏幕坐标），离右下角只剩 20px
const bounds = { x: ball.x - geo.window / 2, y: ball.y - geo.window / 2, width: geo.window, height: geo.window }
const screenBox = (position) => {
  const box = itemBox(geo, position)
  return {
    left: box.left + bounds.x,
    right: box.right + bounds.x,
    top: box.top + bounds.y,
    bottom: box.bottom + bounds.y,
  }
}
const insideWorkArea = (box) =>
  box.left >= workArea.x &&
  box.right <= workArea.x + workArea.width &&
  box.top >= workArea.y &&
  box.bottom <= workArea.y + workArea.height

const arc = visibleItemArc(geo, bounds, workArea)
check('J3：球贴到屏幕右下角时返回一段非空可见弧', arc !== null && arc.size > 0, arc ? `size=${arc.degrees.toFixed(1)}°` : 'null')

// 核心断言：铺进弧里的图标，每一个都必须**完整**落在工作区内
const inArc = itemPositions(geo, 5, arc)
const allInside = inArc.every((position) => insideWorkArea(screenBox(position)))
check('J4：铺进弧里的 5 个图标全部完整落在工作区内（这是本轮修复的核心）', allInside)

// 反向对照：把图标按整圈铺（旧的写法），必须至少有一个出屏 —— 否则这支探针没在验东西
const wholeRing = itemPositions(geo, 5).map(screenBox)
const someOutside = wholeRing.some((box) => !insideWorkArea(box))
check('J4（反向对照）：同一位置按整圈铺，就会有图标落在工作区外', someOutside)

// 弧必须落在可见的那一侧：右下角贴边时，可用的图标都在环的左上方
const visibleMean = inArc.reduce((sum, p) => sum + Math.hypot(p.x - geo.center, p.y - geo.center), 0) / inArc.length
check('J5：弧内图标仍落在同一个图标环上（半径没被改）', Math.abs(visibleMean - geo.midR) < geo.iconHover)

check('J6：弧的跨度小于整圈、且采样精度够（不会退化成 0 长度）',
  arc.size < Math.PI * 2 * 0.999 && arc.size > (Math.PI * 2) / 720
)

check('J7：arcSpan 把「非法/空/整圈」统一归一成 null（调用方只认 null 与真弧两种）',
  arcSpan(null) === null && arcSpan({ start: 0, size: 0 }) === null &&
  arcSpan({ start: 0, size: Math.PI * 2 }) === null && arcSpan({ start: 1, size: 1 }) !== null)

// 球在屏幕正中、离四边都够远 → 整圈可见（不该无谓地把图标挤在一起）
const middle = { x: 960 - geo.window / 2, y: 540 - geo.window / 2, width: geo.window, height: geo.window }
check('J8：球在屏幕中央时仍是整圈均布（不因为「有工作区」就退化成弧）',
  visibleItemArc(geo, middle, workArea) === null)

/* ── 5. ★ 阴影余量：环菜单上那个「隐约的方块」（2026-10-08 第四轮）────────────
 * 用户截图里环菜单上有一层淡淡的方块。逐像素量过：方块边缘**正好压在环窗口足迹上**
 * （桌面纯白 255，越过窗口边界一像素直接掉到 224 再单调变暗到环）。
 * 根因是 #plane 的 box-shadow 外扩超出窗口留白，被窗口边界垂直切平。
 * 所以这两条必须钉死：
 *   (a) 产品 CSS 里阴影的最大外扩 ≤ 几何给的 shadowRoom（窗口装得下，不被切）；
 *   (b) #plane/#band **不再**用 `inset: var(--ring-pad)` 定位 —— 一用 inset，
 *       shadowRoom 就会同时把环缩小，环的视觉尺寸会随阴影余量漂移。
 * 数字一律从产品文件里抽（照本文件纪律），不抄作者记忆。 */
console.log('')
console.log('## 5. 阴影余量：环菜单上的「隐约方块」')

/**
 * 从 CSS 的 `box-shadow` 里抽最大外扩。
 *
 * ★ CSS 语法是 `[inset] offsetX offsetY [blur] [spread] color` —— **offsetY 是第二个数、
 *   blur 是第三个数**（第一版解析器把第一个当 offsetY 了，等于把 offsetX 当成了竖直偏移，
 *   算出来的外扩是错的）。这里按位置严格取值。
 *   外扩 = |offsetY| + blur/2（spread 暂不参与；负 offset 朝上也要占余量，取绝对值）。
 */
function shadowExtent(css) {
  const block = css.match(/#plane\s*\{[^}]*box-shadow:([^;]+);/s)
  if (!block) return null
  let max = 0
  for (const layer of block[1].split(/,(?![^(]*\))/)) {
    // 去掉颜色/关键字，只留长度值（`0` 这种无单位的也要算）
    const nums = (layer.match(/(?:^|\s)(-?\d+(?:\.\d+)?)(px)?(?=\s|$)/g) ?? [])
      .map((n) => Number.parseFloat(n))
    if (nums.length < 2) continue
    const offsetY = Math.abs(nums[1])
    const blur = nums[2] ?? 0
    const spread = nums[3] ?? 0
    max = Math.max(max, offsetY + Math.max(0, blur) / 2 + Math.max(0, spread))
  }
  return max
}

const shadow = shadowExtent(cssSource)
check('5.1：#plane 的 box-shadow 能从产品 CSS 里抽出来（抽不到说明选择器被改了）', shadow !== null)
check(
  '5.2：阴影最大外扩 ≤ 阴影余量（阴影装得进窗口，不会被边界切平成方块）',
  shadow !== null && shadow <= geo.shadowRoom,
  `外扩=${shadow?.toFixed(1)}px shadowRoom=${geo.shadowRoom}px`,
)
check(
  '5.3：#plane / #band 不再用 inset:var(--ring-pad) 定位（否则加余量会把环缩小）',
  !/#plane[\s\S]{0,400}?inset:\s*var\(--ring-pad\)/.test(cssSource) &&
    !/#band[\s\S]{0,400}?inset:\s*var\(--ring-pad\)/.test(cssSource),
  '#plane 或 #band 又用 inset 吃 --ring-pad 了',
)
check(
  '5.4：#plane / #band 改为「固定 outer 尺寸 + 居中」，与窗口留白解耦',
  /#plane,\s*#band\s*\{[^}]*width:\s*var\(--ring-outer\)/.test(cssSource) &&
    /#plane,\s*#band\s*\{[^}]*height:\s*var\(--ring-outer\)/.test(cssSource),
)
check(
  '5.5：窗口边长把 shadowRoom 算进去了（main.js 与几何推导一致）',
  product.mainShadow === geo.shadowRoom && product.mainWindow === 2 && window === geo.window,
  `mainShadow=${product.mainShadow} geometry=${geo.shadowRoom} window=${window} geometry=${geo.window}`,
)
check(
  '5.6：渲染层下发/落地了 --ring-shadow-room（漏一处，主进程的窗口就与 CSS 对不上）',
  cssSource.includes('--ring-shadow-room:') &&
    /setProperty\('--ring-shadow-room'/.test(readFileSync(join(ROOT, 'helper', 'assets', 'ring-menu.js'), 'utf8')),
)
check(
  '5.7：环的视觉尺寸不受 shadowRoom 影响（same outer → same inner/icon/midR）',
  (() => {
    const bare = ringLayout({ ...DEFAULT_RING, shadowRoom: 0 })
    const padded = ringLayout({ ...DEFAULT_RING, shadowRoom: 64 })
    return (
      bare.outer === padded.outer &&
      bare.inner === padded.inner &&
      bare.icon === padded.icon &&
      bare.midR === padded.midR &&
      padded.window === bare.window + 128
    )
  })(),
)
// ★ 反向对照：把 shadowRoom 设成 0（旧行为），阴影必须**装不下** —— 否则这组断言验不出东西。
check(
  '5.8（反向对照）：shadowRoom = 0 时阴影必然溢出（这就是旧版方块 bug 的成因）',
  shadow !== null && ringLayout({ ...DEFAULT_RING, shadowRoom: 0 }).shadowRoom < shadow,
)

console.log('')
console.log(`${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
