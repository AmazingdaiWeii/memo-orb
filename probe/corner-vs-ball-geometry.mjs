/**
 * 验算：角手柄固定到右下角（`se`）会不会压到球。
 *
 * ## 为什么必须先算再改
 *
 * 2026-10-07 已经吃过一次教训：贴着球的那两条边暴露出来会**抢走球的点击
 * 和拖拽**，那次的表现是「球彻底失去交互」（见 MEMORY 的 UI 铁律段）。
 * 角手柄比边条更大更危险，所以「把它挪到右下角」这句话能不能照做，
 * 要先看几何 —— 不是看到右下角空着就摆上去。
 *
 * ## 几何（全部取自 helper/lib/main.js 的真实常量）
 *
 *   BALL_SIZE     = 72   球直径
 *   CHROME_INSET  = 12   窗口比面板大出来的那圈透明边
 *   面板默认      = 360 × 520（见 PANEL_SIZE_DEFAULT）
 *   窗口          = 面板 + 2×12 = 384 × 544
 *
 * `expandedOverlayBounds` 里：
 *   direction.horizontal === 'left'（面板在球左边）→ 窗口**右**边贴球
 *   direction.vertical   === 'up'  （面板在球上边）→ 窗口**下**边贴球
 *
 * 也就是说 **球永远在窗口的两个相邻角上**，且正好是「面板没展开的那侧」。
 *
 * ## 结论
 *
 * `se`（右下角）只有在「球在左上」时才安全 —— 也就是
 *   horizontal === 'right'（面板在球右边 → 窗口左边贴球）
 *   且vertical === 'down'（面板在球下边 → 窗口上边贴球）
 * 其余三种组合下球分别占据 sw / nw / ne，`se` 离球都至少有 12px 以上。
 *
 * 但用户看到的球通常在**屏幕右侧中部**（`defaultFloatingBallOrigin`：
 * 工作区右边缘、垂直偏下）。这时：
 *   ball.x ≈ workArea.width - 72 → 屏幕右半 → expandDirection 给
 *   horizontal='left'（面板往左展开）→ 窗口**右**边贴球
 *   ball.y 垂直偏下→ vertical='down'? 不，vertical 判的是「球离上边多远」，
 *   球偏下 → 球离上边远 → vertical='up'（面板往上展开）→ 窗口**下**边贴球
 *   ⇒ 球落在窗口右下角（se）！**se 正好被球压住。**
 *
 * 所以「无脑固定 se」会直接制造一次卡死。必须让角手柄
 * **跟着「离球最远的那个角」走** —— 也就是现在的 `freeEdges().corner`。
 *
 * 用法：node probe/corner-vs-ball-geometry.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { safeCorner } from '../helper/assets/resize-handles.js'

const BALL_SIZE = 72
const CHROME_INSET = 12
const PANEL_W = 360
const PANEL_H = 520
const WIN_W = PANEL_W + 2 * CHROME_INSET
const WIN_H = PANEL_H + 2 * CHROME_INSET

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS ${name}`) } else {
    failed += 1; console.log(`FAIL ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

/** 复刻 main.js 的 expandDirection。workArea 是屏幕可用区（原点 0,0）。 */
function expandDirection(ball, workArea) {
  return {
    horizontal: ball.x + BALL_SIZE / 2 - workArea.x > workArea.width / 2 ? 'left' : 'right',
    vertical: ball.y - workArea.y < PANEL_H - BALL_SIZE ? 'down' : 'up',
  }
}

/** 复刻 overlayBoundsFromBall：算窗口在屏幕坐标系里的位置，并推出球落在窗口哪个角。 */
function ballCorner(direction, ball) {
  const x = direction.horizontal === 'left'
    ? ball.x - (PANEL_W - BALL_SIZE) - CHROME_INSET
    : ball.x - CHROME_INSET
  const y = direction.vertical === 'up'
    ? ball.y - (PANEL_H - BALL_SIZE) - CHROME_INSET
    : ball.y - CHROME_INSET
  // 球相对窗口的位置
  const relX = ball.x - x
  const relY = ball.y - y
  const onLeft = relX < WIN_W / 2
  const onTop = relY < WIN_H / 2
  return {
    x, y, relX, relY,
    corner: `${onTop ? 'n' : 's'}${onLeft ? 'w' : 'e'}`,
  }
}

const SCREEN = { x: 0, y: 0, width: 2560, height: 1440 }

// 覆盖用户可能的球位：四个角 + 屏幕右中部（默认位）+ 右下（之前卡死的位置）
const BALLS = [
  { name: '左上角', x: 40, y: 40 },
  { name: '右上角', x: SCREEN.width - 112, y: 40 },
  { name: '左下角', x: 40, y: SCREEN.height - 112 },
  { name: '右下角', x: SCREEN.width - 112, y: SCREEN.height - 112 },
  { name: '屏幕右中部（默认位）', x: SCREEN.width - 72, y: SCREEN.height / 2 },
  { name: '屏幕左中部', x: 0, y: SCREEN.height / 2 },
  { name: '正中间', x: SCREEN.width / 2, y: SCREEN.height / 2 },
]

console.log('球位 → 窗口上的贴球角 → 自由角（手柄落点）\n')
const rows = []
for (const ball of BALLS) {
  const dir = expandDirection(ball, SCREEN)
  const info = ballCorner(dir, ball)
  const h = dir.horizontal === 'right' ? 'e' : 'w'
  const v = dir.vertical === 'down' ? 's' : 'n'
  const corner = { e: { n: 'ne', s: 'se' }, w: { n: 'nw', s: 'sw' } }[h][v]
  rows.push({ 球位: ball.name, 方向: `${dir.horizontal}/${dir.vertical}`, 贴球角: info.corner, 自由角: corner })
}
console.table(rows)

// ── 断言 1：自由角**永远不等于**贴球角 ────────────────────────────────
for (const r of rows) {
  check(`「${r.球位}」下自由角 ${r.自由角} 不与贴球角 ${r.贴球角} 重合`,
    r.自由角 !== r.贴球角, `重合了 —— 手柄会压在球上（2026-10-07 卡死同款）`)
}

// ── 断言 2：自由角与贴球角**对角**（即隔得最远） ──────────────────────
for (const r of rows) {
  const opposite = { n: 's', s: 'n', e: 'w', w: 'e' }
  const [rv, rh] = r.贴球角
  const expect = `${opposite[rv]}${opposite[rh]}`
  check(`「${r.球位}」的自由角是贴球角的对角`, r.自由角 === expect,
    `贴球 ${r.贴球角} → 对角应为 ${expect}，实际 ${r.自由角}`)
}

// ── 断言 3：默认球位（屏幕右中部）下，se 会被球压住 ──────────────────
//
// 这是「无脑固定右下角」的直接反证，也是本探针存在的意义。
{
  const def = rows.find((r) => r.球位 === '屏幕右中部（默认位）')
  check('★ 默认球位下 se 角确实被球占据 —— 所以不能无脑固定右下角',
    def.贴球角 === 'se', `实际贴球角是 ${def.贴球角}`)
  check('★ 默认球位下正确落点是对角 nw', def.自由角 === 'nw', `实际 ${def.自由角}`)
}

// ── 断言 4：手动统计「se 安全的球位数」 ─────────────────────────────
//
// 若安全比例很低，就证明「固定右下角」必须做成「可切换」而不是「写死」。
{
  const safe = rows.filter((r) => r.贴球角 !== 'se').length
  console.log(`\nse 角安全的球位：${safe}/${rows.length}`)
  check('se 在部分球位下不可用（所以不能无脑写死右下角）',
    safe < rows.length, `${safe}/${rows.length} 安全`)
}

// ── 断言 5：★★ 产品真正用的 safeCorner() 绝不返回贴球角 ────────────
//
// 上面都是推演，这里直接调**产品文件里导出的** `safeCorner()`，
// 对全部 4 种方向组合断言「返回值≠ 贴球角」。
//
// 这是本探针的核心断言：用户要求「固定右下角」，
// 但实现必须是「右下角，被球占了才退让」。
// 一旦有人把safeCorner 改回直接返回 preferred，这条立刻红。
{
  const safeCornerSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'helper', 'assets', 'resize-handles.js'),
    'utf8',
  )
  const exported = safeCornerSrc.match(/export\s+function\s+safeCorner/)
  check('产品导出 safeCorner（可被探针直接调用）', exported !== null,
    'resize-handles.js 没有导出 safeCorner —— 探针只能静态检查，退化为假绿')

  for (const horizontal of ['left', 'right']) {
    for (const vertical of ['up', 'down']) {
      const d = { horizontal, vertical }
      const ball = `${vertical === 'up' ? 's' : 'n'}${horizontal === 'left' ? 'e' : 'w'}`
      const got = safeCorner(d)
      check(`safeCorner(${horizontal}/${vertical}) ≠ 贴球角 ${ball}`,
        got !== ball, `返回了 ${got} —— 手柄会压在球上（卡死风险）`)
    }
  }
}

// ── 断言 6：safeCorner 在球不占 se 时就该给 se（用户的偏好优先） ──────
{
  // 球在 nw（horizontal='right' → 球在 w侧；vertical='down' → 球在 n 侧）
  const d = { horizontal: 'right', vertical: 'down' }
  check('球在 nw 时 safeCorner 返回 se（尊重用户指定的右下角）',
    safeCorner(d) === 'se', `实际 ${safeCorner(d)}`)
}

console.log(`\n${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)