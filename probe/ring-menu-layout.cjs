/**
 * 环形菜单 · 真实窗口布局断言（Electron 冒烟）
 *
 * 跑法（两次，验 DPI 无关）：
 *   & "E:\Memo orb\runtime\electron\electron.exe" "E:\Memo orb\probe\ring-menu-layout.cjs"
 *   $env:RING_PROBE_SCALE="1.5"; & "...\electron.exe" "E:\Memo orb\probe\ring-menu-layout.cjs"
 *
 * 为什么要有这支探针：
 *   环形菜单的历史里，DOM 与几何从没在**真实渲染进程**里被量过。旧实现把 200×200 的菜单
 *   写死在 96×96 的球窗口里，光靠肉眼看「有时候在有时候不在」，没人能说出「第 4 个按钮的
 *   getBoundingClientRect().right 超出了 innerWidth 多少像素」。这支探针把每个按钮的**真实
 *   可见矩形**量出来断言，并让两支反向对照（隐藏窗口不成立的就说明断言没生效）。
 *
 * ★ 纪律：断言用到的窗口尺寸/通道名**从产品文件里抽**（helper/lib/main.js、helper/preload-ring.cjs），
 *   不抄本探针作者记忆里的数字。抽不到就当场 FAIL —— 那本身就是「主进程与渲染层契约断了」。
 *
 * 探针会做三件事，全部记录在案：
 *   P1 隐藏窗口 + 动画开启：只为记录动画是否在跑（不做几何断言）
 *   P2 隐藏窗口 + 动画/过渡强制关闭：**静止态几何硬断言**（这是真值）
 *   P3 真显示窗口（opacity 0.05，用户基本看不见）+ 动画跑完：**活体几何硬断言**，应与 P2 一致
 *   P4 改透明度：断言指示弧与材质预览跟着变（拖动条真的接上了）
 *   P5 关闭：断言窗口 hidden（关闭的正确语义是隐藏窗口，不是藏 DOM）
 */

const { app, BrowserWindow, ipcMain } = require('electron')
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')

const ROOT = resolve(__dirname, '..')
const SCALE = process.env.RING_PROBE_SCALE || '1'
// 两次 DPI 运行各留一份，互不覆盖（报告要同时贴 1x 与 1.5x 的原始输出）
const SUFFIX = SCALE === '1' ? '' : `-scale${String(SCALE).replace('.', '')}`
const LOG_PATH = join(__dirname, `_ring-menu-layout${SUFFIX}.log`)
const JSON_PATH = join(__dirname, `_ring-menu-layout${SUFFIX}.json`)

if (SCALE !== '1') app.commandLine.appendSwitch('force-device-scale-factor', SCALE)
app.disableHardwareAcceleration()

// 逐行落盘（不是收尾一次性写）：探针若中途挂住，日志里必须留下它挂在哪一步。
// Windows 上 electron.exe 是 GUI 子系统程序，stdout 未必接得住管道，以文件为准。
try {
  writeFileSync(LOG_PATH, '')
} catch { /* 落盘失败不影响 stdout */ }
const lines = []
let passed = 0
let failed = 0
function out(text = '') {
  lines.push(text)
  console.log(text)
  try {
    appendFileSync(LOG_PATH, `${text}\n`, 'utf8')
  } catch { /* ignore */ }
}
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    out(`PASS  ${name}`)
  } else {
    failed += 1
    out(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 从产品文件抽常量与通道名 ─────────────────────────────────────────── */
const mainSource = readFileSync(join(ROOT, 'helper', 'lib', 'main.js'), 'utf8')
const preloadRingSource = readFileSync(join(ROOT, 'helper', 'preload-ring.cjs'), 'utf8')
const shellSource = readFileSync(join(ROOT, 'helper', 'assets', 'shell.js'), 'utf8')

function grab(source, pattern, label) {
  const m = source.match(pattern)
  if (!m) throw new Error(`产品文件里抽不到 ${label}（正则 ${pattern}）`)
  return m[1]
}
const RING = {
  outer: Number(grab(mainSource, /const RING_OUTER_D = (\d+(?:\.\d+)?);/, 'RING_OUTER_D')),
  band: Number(grab(mainSource, /const RING_BAND = (\d+(?:\.\d+)?);/, 'RING_BAND')),
  pad: Number(grab(mainSource, /const RING_PAD = (\d+(?:\.\d+)?);/, 'RING_PAD')),
}
RING.window = RING.outer + RING.pad * 2
const CH_DATA = grab(mainSource, /webContents\.send\("(ring-menu:[a-z]+)"/, 'ring-menu:data 通道')
const DATA_CHANNELS = [...new Set([...preloadRingSource.matchAll(/\b(?:send|on)\('([a-z-]+:[a-z-]+)'/g)].map((m) => m[1]))]

const ITEMS = [
  { id: 'avatar', label: '更换显示样式（头像）' },
  { id: 'impression', label: '我们的回忆' },
  { id: 'history', label: '历史对话' },
  { id: 'new-chat', label: '新建' },
  { id: 'letta-web', label: '打开 Letta 界面' },
]
const HOVER = Number(grab(readFileSync(join(ROOT, 'helper', 'assets', 'ring-menu.css'), 'utf8'), /\.ring-item:hover,\s*\.ring-item:focus-visible\s*\{[^}]*--s:\s*([\d.]+)/, 'hover 放大系数'))

const received = { action: [], close: 0, hit: [], opacity: [] }
let ringWin = null
ipcMain.on('orb:ring-action', (_e, id) => received.action.push(id))
// 照产品主进程的行为镜像：收到 close 就隐藏环窗口（产品里是 closeRingMenuWindow()）。
// 探针不复刻这一步，就等于在验一个不存在的实现 —— P5 曾经因此假红。
ipcMain.on('orb:ring-close', () => {
  received.close += 1
  if (ringWin && !ringWin.isDestroyed()) ringWin.hide()
})
ipcMain.on('orb:ring-hit', (_e, b) => received.hit.push(b))
ipcMain.on('orb:ring-opacity', (_e, v) => received.opacity.push(v))

async function measure(win) {
  return win.webContents.executeJavaScript(`(() => {
    const px = (v) => Number(v.toFixed(2))
    const rect = (el) => { const r = el.getBoundingClientRect(); return { left: px(r.left), top: px(r.top), right: px(r.right), bottom: px(r.bottom), width: px(r.width), height: px(r.height) } }
    const root = getComputedStyle(document.documentElement)
    const items = [...document.querySelectorAll('.ring-item')].map((el) => ({
      id: el.dataset.id || '',
      label: el.getAttribute('aria-label') || '',
      rect: rect(el),
      transform: getComputedStyle(el).transform,
    }))
    const orbitValue = document.querySelector('#orbit-value')
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      cssWindow: px(parseFloat(root.getPropertyValue('--ring-window'))),
      cssOuter: px(parseFloat(root.getPropertyValue('--ring-outer'))),
      cssInner: px(parseFloat(root.getPropertyValue('--ring-inner'))),
      ringOpen: document.getElementById('ring').classList.contains('is-open'),
      itemCount: items.length,
      items,
      bandRadiusOuter: px(document.getElementById('band').getBoundingClientRect().width / 2),
      // 挖孔 mask 到底有没有生效？写了个语法错的 mask 会被浏览器整条丢掉（= 整块实心圆盘盖住球）。
      // 所以这里读**解析后**的 mask-image：能读到 radial-gradient 才说明中心孔真的挖出来了。
      bandMask: (getComputedStyle(document.getElementById('band')).maskImage ||
        getComputedStyle(document.getElementById('band')).webkitMaskImage || 'none'),
      orbitDash: orbitValue ? orbitValue.getAttribute('stroke-dasharray') : null,
      previewOpacity: root.getPropertyValue('--panel-preview').trim(),
      hud: (document.getElementById('hud-value') || {}).textContent || '',
      hudDisplay: getComputedStyle(document.getElementById('hud')).display,
      hudHidden: document.getElementById('hud').hidden === true,
      animations: document.getAnimations ? document.getAnimations().map((a) => ({ name: a.animationName || '', state: a.playState })) : [],
      visibility: document.visibilityState,
    }
  })()`)
}

/** 一个按钮完整落在窗口可视区内？含 hover 放大后的最坏盒。 */
function escaped(items, w, h) {
  const grow = (HOVER - 1) / 2
  return items.filter((it) => {
    const r = it.rect
    const cx = (r.left + r.right) / 2
    const cy = (r.top + r.bottom) / 2
    const hw = (r.width / 2) * (1 + grow * 2)
    const hh = (r.height / 2) * (1 + grow * 2)
    return cx - hw < -0.01 || cy - hh < -0.01 || cx + hw > w + 0.01 || cy + hh > h + 0.01
  })
}
function overlaps(items) {
  const bad = []
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i].rect
      const b = items[j].rect
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) bad.push(`${items[i].id}×${items[j].id}`)
    }
  }
  return bad
}

app.whenReady().then(async () => {
  let win = null
  let exitCode = 0
  // 看门狗：探针必须在 30s 内自己结束，否则留下「挂在哪一步」的日志再退。
  const watchdog = setTimeout(() => {
    out('[watchdog] 探针 30s 未结束，强制退出（上一行就是它卡住的位置）')
    app.exit(4)
  }, 30_000)
  try {
    out(`# 环形菜单布局探针 · deviceScaleFactor=${SCALE} · electron=${process.versions.electron}`)
    out(`# 产品常量：outer=${RING.outer} band=${RING.band} pad=${RING.pad} window=${RING.window} hover=${HOVER} 数据通道=${CH_DATA}`)
    out(`# preload-ring.cjs 里的通道：${DATA_CHANNELS.join(', ')}`)
    out('')

    /* ── 契约：主进程必须认得渲染层发的每一个通道 ─────────────────────── */
    const missing = DATA_CHANNELS.filter((ch) => !mainSource.includes(`"${ch}"`))
    check('契约：preload-ring.cjs 用到的每个通道在主进程里都有对应处理', missing.length === 0, missing.join(','))
    check('契约：主进程用 RING_OUTER_D + RING_PAD*2 推导窗口尺寸（不是另写一个数）',
      // ⚠️ 2026-10-21：产品现在算的是 RING_OUTER_D + (RING_PAD + RING_SHADOW_ROOM) * 2
      //   （窗口要给阴影外扩留位，否则阴影被窗口边界裁掉 —— 旧版方块 bug 的成因）。
      //   原来这条只认 `RING_OUTER_D + RING_PAD * 2`，于是产品改对了、探针反而红了。
      //   断言的**本意**是「窗口尺寸必须由这几个常量推导出来，不能另写一个数」，
      //   所以改成认「含 RING_PAD 的推导式」即可。
      /const RING_WINDOW_SIZE = RING_OUTER_D \+ [^;]*RING_PAD[^;]*;/.test(mainSource) &&
      /RING_SHADOW_ROOM/.test(mainSource))
    check('修 C1：右键先 await 收起窗口，再读球的位置（顺序反了菜单就会落在窗外）',
      /await setExpanded\(false, true\)[\s\S]{0,400}?getBoundingClientRect\(\)/.test(shellSource))
    check('修 C3：主进程把环窗口夹取进工作区（workArea）', /getDisplayNearestPoint\([\s\S]{0,200}?workArea/.test(mainSource))
    check('修 C6：环菜单的动作先展开面板再执行（三个目的地在 #panel 内）',
      /if \(!expanded\)[\s\S]{0,120}?await setExpanded\(true\)[\s\S]{0,120}?handleMenuAction\(/.test(shellSource))
    check('修 C7：--panel-opacity 在亮色 :root 也有声明（不只暗色主题）',
      /:root\s*\{[^}]*--panel-opacity/.test(readFileSync(join(ROOT, 'helper', 'assets', 'floating.css'), 'utf8')))
    check('契约：主进程收到 orb:ring-close 会隐藏环窗口（关闭 = 隐藏窗口，不是藏 DOM）',
      /ipcMain\.on\("orb:ring-close"[\s\S]{0,300}?closeRingMenuWindow\(\)/.test(mainSource))
    // 环窗口的窗口属性：透明/置顶/无边框/不抢焦点/不进任务栏 —— 少一条都会变成「挡桌面的黑方块」
    // 切片起点/终点都从 RING_OUTER_D 之后找：closeRingMenuWindow 在别处（orb:expand）也被调用过，
    // 直接用 indexOf('closeRingMenuWindow') 当终点会切出一段空串（这支探针第一次跑就是这么假红的）。
    const ringStart = mainSource.indexOf('const RING_OUTER_D')
    const ringBlock = mainSource.slice(ringStart, mainSource.indexOf('function ringWindowBounds', ringStart))
    const ringOpts = { transparent: 'transparent: true', frame: 'frame: false', skipTaskbar: 'skipTaskbar: true', focusable: 'focusable: false', alwaysOnTop: 'alwaysOnTop: true' }
    const missingOpts = Object.entries(ringOpts).filter(([, needle]) => !ringBlock.includes(needle)).map(([k]) => k)
    check('契约：环窗口是「透明/无边框/置顶/不抢焦点/不进任务栏」', missingOpts.length === 0, missingOpts.join(','))
    check('契约：环窗口按 screen-saver 层级置顶（与球窗口同级）', /setAlwaysOnTop\(true, "screen-saver"\)/.test(ringBlock))
    check('契约：环窗口起步就穿透鼠标（环外/中心孔要能穿到球和桌面）',
      /setRingClickThrough\(true\)/.test(ringBlock) &&
        /setIgnoreMouseEvents\(passThrough === true, \{ forward: true \}\)/.test(mainSource),
      '要么没有起步穿透，要么 forward:true 丢了（丢了就收不到 mousemove，环带永远点不到）')
    out('')

    win = new BrowserWindow({
      width: RING.window,
      height: RING.window,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(ROOT, 'helper', 'preload-ring.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    ringWin = win

    await win.loadFile(join(ROOT, 'helper', 'assets', 'ring-menu.html'), {
      query: { outer: String(RING.outer), band: String(RING.band), pad: String(RING.pad) },
    })
    await sleep(120)

    /* P1：注入数据（照主进程 sendRingData 的形状） */
    win.webContents.send(CH_DATA, { items: ITEMS, opacity: 0.7 })
    await sleep(500)
    const p1 = await measure(win)
    out(`[P1 隐藏窗口 / 动画开启] animations=${JSON.stringify(p1.animations)} visibility=${p1.visibility}`)
    check('P1：注入 5 项后渲染层确实渲染出 5 个按钮', p1.itemCount === ITEMS.length, `${p1.itemCount}`)
    check('P1：#ring 进入 .is-open（开合状态机的入口）', p1.ringOpen === true)
    check('P1：按钮 aria-label 与下发的文案一致（可访问名来自主进程，不是渲染层另抄一份）',
      p1.items.every((it, i) => it.label === ITEMS[i].label), JSON.stringify(p1.items.map((i) => i.label)))
    check('P1：按钮顺序与下发顺序一致（12 点顺时针）',
      p1.items.map((i) => i.id).join(',') === ITEMS.map((i) => i.id).join(','), p1.items.map((i) => i.id).join(','))
    out('')

    /* P2：静止态几何（关掉动画/过渡，这是可复算的真值） */
    await win.webContents.insertCSS('*, *::before, *::after { animation: none !important; transition: none !important; }')
    await sleep(150)
    const p2 = await measure(win)
    out(`[P2 隐藏窗口 / 动画关闭] inner=${p2.innerWidth}×${p2.innerHeight} cssWindow=${p2.cssWindow} outer=${p2.cssOuter} inner=${p2.cssInner} bandR=${p2.bandRadiusOuter}`)
    for (const it of p2.items) out(`   ${it.id.padEnd(11)} rect=${it.rect.left},${it.rect.top} → ${it.rect.right},${it.rect.bottom} (${it.rect.width}×${it.rect.height}) transform=${it.transform}`)

    check('P2①：每个按钮（含 hover 放大 1.18 的最坏盒）完整落在窗口可视区内',
      escaped(p2.items, p2.innerWidth, p2.innerHeight).length === 0,
      JSON.stringify(escaped(p2.items, p2.innerWidth, p2.innerHeight).map((i) => `${i.id}:${JSON.stringify(i.rect)}`)))
    check('P2②：按钮彼此不重叠', overlaps(p2.items).length === 0, overlaps(p2.items).join(','))
    check('P2：窗口真实尺寸 = 主进程常量推导的尺寸（主进程/渲染层没有各写一份 220）',
      Math.abs(p2.innerWidth - RING.window) < 1.5 && Math.abs(p2.innerHeight - RING.window) < 1.5,
      `${p2.innerWidth} vs ${RING.window}`)
    check('P2：渲染层用的 --ring-outer 来自 query（与主进程同一个数）', Math.abs(p2.cssOuter - RING.outer) < 0.01, `${p2.cssOuter} vs ${RING.outer}`)
    check('P2：环带在窗口里居中且左右各留 pad（环不会顶到窗口边）',
      Math.abs(p2.bandRadiusOuter - RING.outer / 2) < 0.5 && Math.abs((p2.innerWidth / 2 - p2.bandRadiusOuter) - RING.pad) < 0.5,
      `bandR=${p2.bandRadiusOuter} pad=${p2.innerWidth / 2 - p2.bandRadiusOuter}`)
    check('P2：窗口边长 ≥ 环外径（旧实现 200 塞进 96 的直接否定）', p2.innerWidth >= RING.outer, `${p2.innerWidth} vs ${RING.outer}`)
    // ★ m00827 §1 回归：空闲态中心孔里不能有任何灰块。
    //   旧实现 `#hud { display: flex }` 是 ID 选择器，压过 UA 的 `[hidden] { display: none }`，
    //   于是 hidden 形同虚设：「拖动时才出现的材质预览 + 百分比」常驻在孔中央、盖住站在孔里的球
    //   （用户实测：「菜单中心似乎有一层灰色蒙罩遮挡了球体本身的 UI」）。
    check('P2③：空闲态 HUD 不可见（中心孔不允许有常驻灰块）',
      p2.hudDisplay === 'none' && p2.hudHidden === true, `display=${p2.hudDisplay} hidden=${p2.hudHidden}`)
    // ★ m00827 §1 的 paint 侧：环带靠 mask 挖出中心孔。若 mask 语法不被浏览器接受，
    //   整条声明会被丢掉 → 变成一块实心圆盘盖住站在孔里的球（也正是「灰色蒙罩」的样子）。
    //   所以断言读的是**解析后**的 mask-image，而不是源码里写了什么。
    check('P2④：环带的挖孔 mask 真的生效（解析后是 radial-gradient，不是被丢掉的 none）',
      /radial-gradient/i.test(String(p2.bandMask)), String(p2.bandMask).slice(0, 110))

    /* P4：透明度拖动条真的接上了（改数据 → 指示弧与材质预览跟着变） */
    win.webContents.send(CH_DATA, { items: ITEMS, opacity: 0.35 })
    await sleep(150)
    const p4 = await measure(win)
    out(`[P4 透明度 0.35] orbitDash=${p4.orbitDash} --panel-preview=${p4.previewOpacity} hud=${p4.hud}`)
    check('P4：透明度变化会改写指示弧 dasharray（拖动条可视化）', p4.orbitDash !== p2.orbitDash && p4.orbitDash !== null, `${p2.orbitDash} → ${p4.orbitDash}`)
    check('P4：HUD 显示百分比（拖动时有读数）', /3[45]%/.test(p4.hud), p4.hud)
    win.webContents.send(CH_DATA, { items: ITEMS, opacity: 0.7 })
    await sleep(120)

    /* P3：真显示窗口，动画跑完后再量一次（活体） */
    win.setOpacity(0.05)
    win.showInactive()
    await sleep(700)
    const p3 = await measure(win)
    out(`[P3 真显示窗口] visibility=${p3.visibility} animations=${JSON.stringify(p3.animations)}`)
    if (p3.visibility !== 'visible') out('   ⚠ 窗口已显示但 visibilityState 不是 visible（记录，不做断言）')
    let maxDrift = 0
    for (let i = 0; i < p3.items.length && i < p2.items.length; i += 1) {
      const a = p3.items[i].rect
      const b = p2.items[i].rect
      maxDrift = Math.max(maxDrift, Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.right - b.right), Math.abs(a.bottom - b.bottom))
    }
    out(`   与 P2 静止态的最大偏差 = ${maxDrift.toFixed(2)}px`)
    check('P3①（活体）：每个按钮完整落在窗口可视区内',
      escaped(p3.items, p3.innerWidth, p3.innerHeight).length === 0,
      JSON.stringify(escaped(p3.items, p3.innerWidth, p3.innerHeight).map((i) => i.id)))
    check('P3②（活体）：按钮彼此不重叠', overlaps(p3.items).length === 0, overlaps(p3.items).join(','))
    check('P3：动画结束后与静止态一致（开合动画的落点就是被断言的那个几何）', maxDrift < 0.75, `${maxDrift}px`)

    /* P4b：真鼠标事件打在环带左侧（9 点）—— 验「光标进环带才能点」+「拖动条把值算对并送到主进程」。
       期望值可从几何算：9 点 = 顺时针 270° = t 0.75 → 0.2 + 0.75×0.8 = 0.80。
       这条断言覆盖 渲染层命中 → 透明度换算 → preload → ipcMain → 落盘 的整条链路。 */
    const point = { x: Math.round(p3.innerWidth / 2 - RING.outer / 2 + RING.band / 2), y: Math.round(p3.innerHeight / 2) }
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    await sleep(60)
    const hitAfterMove = received.hit.lastIndexOf(true) > received.hit.lastIndexOf(false)
    win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await sleep(80)
    // 反向对照：拖动期间 HUD **必须**可见 —— 证明 P2③ 那条「空闲态 display:none」不是恒真断言
    const p4bDrag = await measure(win)
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await sleep(160)
    const lastOpacity = received.opacity[received.opacity.length - 1]
    const p4b = await measure(win)
    out(`[P4b 光标打在环带 9 点 (${point.x},${point.y})] hit=${JSON.stringify(received.hit)} opacity=${JSON.stringify(received.opacity)} hud=${p4b.hud}`)
    check('P4b：光标进入环带时把窗口从穿透切回可点（否则环带永远点不到）', hitAfterMove === true, JSON.stringify(received.hit))
    check('P4b：在环带 9 点按下 → 透明度换算正确（期望 0.80）', typeof lastOpacity === 'number' && Math.abs(lastOpacity - 0.8) < 0.02, `${lastOpacity}`)
    check('P4b：透明度经 IPC 送到主进程（拖动条不是只改渲染层的 CSS）', received.opacity.length >= 1, `${received.opacity.length}`)
    check('P4b（反向对照）：拖动期间 HUD 可见 —— 证明 P2③ 断言会随状态翻转、不是恒真',
      p4bDrag.hudDisplay !== 'none', `drag display=${p4bDrag.hudDisplay} / idle display=${p2.hudDisplay}`)
    out('')

    /* P5：关闭。渲染层调 close() → 主进程 hide() —— 这才是「看不见」的语义 */
    await win.webContents.executeJavaScript('window.ringMenu.close()')
    await sleep(200)
    const p5 = await measure(win)
    check('P5①：渲染层 close() 走到主进程并隐藏环窗口（关闭 = 隐藏窗口，不是藏 DOM）', !win.isVisible())
    out(`[P5 证据] isVisible=${win.isVisible()} doc.visibilityState=${p5.visibility} closeSignal=${received.close}`)
    out('   注：doc.visibilityState 在 backgroundThrottling:false 下不跟随窗口隐藏，只作记录、不作断言；')
    out('       真正决定「按钮画不画」的是窗口可见性，所以下面用显示/隐藏的反向对照来证明断言会随状态变化。')
    // 反向对照：同一条断言必须能随状态翻转，否则它可能只是恒真
    win.showInactive()
    await sleep(200)
    check('P5②（反向对照）：再次显示后 isVisible 变 true —— 证明 P5① 不是恒真断言', win.isVisible())
    win.hide()
    await sleep(200)
    check('P5③：hide() 后再次不可见（按钮不再绘制）', !win.isVisible())
    check('P5④：close 信号确实到达主进程（渲染层 → preload → ipcMain 全链路通）', received.close >= 1, `${received.close}`)
    out('')

    /* P5⑤（反向对照）：把 #band 的 mask 强行改成 none，解析后的 mask-image 必须跟着变成 none ——
       证明 P2④ 读的是浏览器真正生效的样式，而不是「源码写了就一定过」的字面量断言。 */
    const maskKey = await win.webContents.insertCSS('#band { -webkit-mask: none !important; mask: none !important; }')
    await sleep(120)
    const p5mask = await measure(win)
    await win.webContents.removeInsertedCSS(maskKey)
    check('P5⑤（反向对照）：mask 改成 none 后 bandMask 跟着变 —— P2④ 不是恒真断言',
      String(p5mask.bandMask).trim() === 'none', String(p5mask.bandMask).slice(0, 60))
    out('')

    const payload = { scale: SCALE, ring: RING, hover: HOVER, p1, p2, p3, p4, p5, received, passed, failed }
    writeFileSync(JSON_PATH, JSON.stringify(payload, null, 2))
    out(`${passed} 通过 / ${failed} 失败`)
    exitCode = failed === 0 ? 0 : 1
  } catch (error) {
    out(`探针自身报错：${error && error.stack ? error.stack : error}`)
    failed += 1
    exitCode = 2
  } finally {
    clearTimeout(watchdog)
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(exitCode)
  }
})

app.on('window-all-closed', () => {})
