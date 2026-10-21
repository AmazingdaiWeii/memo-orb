/**
 * 环形菜单 · 交互契约断言（纯 node，不需要 Electron）
 *
 * 跑法：`node probe/ring-interaction-test.mjs`
 *
 * 为什么要有这支探针（为什么前两支没抓到）：
 *   `probe/ring-geometry-test.mjs` 验的是**几何数字**，`probe/ring-menu-layout.cjs`
 *   验的是**环窗口里的排版**。两者都只覆盖「菜单已经出现在屏幕上之后」的事。
 *   而 2026-10-07 夜用户实测（m00827）报的三个问题全都发生在**球窗口那一侧**：
 *     ① 右键球要按好几次菜单才出来（球态被写成穿透 + 首次要新建窗口）；
 *     ② 菜单中心有灰块盖住球（`#hud` 的 `display:flex` 压过 `[hidden]` —— 布局探针只读
 *        它的 textContent，读得到「35%」就 PASS 了，压根没断言可见性）；
 *     ③ 悬停就弹面板、点一下还会「钉住」，跟右键菜单抢同一块区域。
 *   这三个都是**状态机与契约**问题，量像素量不出来。所以这支探针改成从产品源码里
 *   抽结构断言，每条都配一个反向对照（把修复换回旧写法，断言必须变红）。
 *
 * ★ 纪律：断言里的正则只认「产品里真实存在的字符串」。抽不到就 FAIL ——
 *   那本身就是契约断了，而不是探针写错了。（前一支探针曾因为把区间终点写成
 *   `closeRingMenuWindow` 而切出空串，5 条契约集体假红。）
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')

const SHELL = read('helper', 'assets', 'shell.js')
const MAIN = read('helper', 'lib', 'main.js')
const HOST = read('src', 'main.mjs')   // 三个 api-config IPC 由 host 侧注册（MAIN 里只有一个 legacy-status）
const PRELOAD = read('helper', 'preload.cjs')
const RING_CSS = read('helper', 'assets', 'ring-menu.css')

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

/** 抽一段源码。抽不到就抛 —— 契约断了要让探针自己红，不要静默跳过。 */
function slice(source, from, to, label) {
  const i = source.indexOf(from)
  if (i < 0) throw new Error(`抽不到起点：${label} —— ${from}`)
  const j = to === '' ? source.length : source.indexOf(to, i + from.length)
  if (j < 0) throw new Error(`抽不到终点：${label} —— ${to}`)
  return source.slice(i, j)
}

console.log('# 环形菜单交互契约探针 · 纯源码断言（用户 m00827 的三条实测反馈）')
console.log('')

/* ── A. 球窗口点击通路：球态穿透必须彻底消失 ─────────────────────────────── */
console.log('## A. 球态不再穿透（「右键要按好几次」的机制根因）')
const oldRestore = `function restoreBallClickThrough() {
	if (!win || win.isDestroyed()) return;
	if (placement?.isExpanded === true) { win.setIgnoreMouseEvents(false); return; }
	try { win.setIgnoreMouseEvents(true, { forward: true }); } catch {}
}`
const ballPassThrough = (source) => /win\.setIgnoreMouseEvents\(true/.test(source)
// hideBall() 里那句是「隐藏前先关穿透，防 hide 前闪一帧」（见该函数注释），
// 跟「球态穿透导致右键打不进来」是两件事 —— 必须排除，否则断言会把正确实现判红。
const mainWithoutHideBall = MAIN.replace(/function hideBall\(\)[\s\S]*?\n\}/, '')
check('A1：球窗口不再有任何「球态穿透」（穿透时右键 contextmenu 到不了渲染层；hideBall 的隐藏前收穿透不计）',
  !ballPassThrough(mainWithoutHideBall), 'main.js 里仍有 win.setIgnoreMouseEvents(true…)')
check('A1（反向对照）：同一条断言对改动前的实现会变红 —— 证明它不是恒真',
  ballPassThrough(oldRestore) === true)
const restoreBody = slice(MAIN, 'function restoreBallClickThrough', '\n}', 'restoreBallClickThrough')
check('A2：restoreBallClickThrough 恒把球窗口设为可点（没有「球态穿透」那条分支）',
  /setIgnoreMouseEvents\(false\)/.test(restoreBody) && !/setIgnoreMouseEvents\(true/.test(restoreBody),
  restoreBody.trim().split('\n').slice(0, 2).join(' '))

/* ── B. 左右键互斥（m00827 §2） ──────────────────────────────────────────── */
console.log('')
console.log('## B. 左右键互斥：悬停不展开 / 左键开面板 / 右键开菜单')
const enterBlock = slice(SHELL, "document.body.addEventListener('pointerenter'", "document.body.addEventListener('pointerleave'", 'pointerenter')
const oldEnter = "document.body.addEventListener('pointerenter', () => {\n    if (docked !== undefined) { if (dockHoverArmed) void unsnapDocked(); return }\n    if (suppressExpand) return\n    void setExpanded(true)\n  })"
const hoverExpands = (block) => /setExpanded\(true\)/.test(block)
check('B1：悬停不再展开面板（pointerenter 里没有 setExpanded(true)）',
  !hoverExpands(enterBlock))
check('B1（反向对照）：改动前的 pointerenter 会被这条断言抓到',
  hoverExpands(oldEnter) === true)

const upBlock = slice(SHELL, "ball.addEventListener('pointerup'", "ball.addEventListener('pointercancel'", 'pointerup')
check('B2：左键点球 → togglePanel()（开/关面板）', /togglePanel\(\)/.test(upBlock), upBlock.trim().split('\n').slice(-2).join(' '))
const oldUp = "const dragged = await finishPointer(event)\n    if (dragged || skipClick) { skipClick = false; return }\n    pinned = !pinned\n    document.body.classList.toggle('pinned', pinned)\n    if (pinned) await setExpanded(true)"
const pinsOnClick = (block) =>
  /pinned = !pinned/.test(block) || /pinned = true[\s\S]{0,200}?setExpanded\(true\)/.test(block)
// ★ 2026-10-08（用户 m01764）这条契约**反向**了：左键点球必须重新「点一下钉住」。
//   上一版（第二轮）把 `pinned = true` 删掉，`scheduleCollapse()` 的闸门随之失效 ——
//   指针离开窗口 180ms 面板就自己收，用户伸手去拖边缘手柄时面板先没了，
//   表现就是「拖动边缘放大缩小的功能没了」。所以断言从「不许 pinned」翻成「必须有 pinned」。
check('B3：左键点球会「钉住」面板（pinned = true 且随后 setExpanded(true)）',
  pinsOnClick(SHELL))
check('B3（反向对照）：上一版旧写法（pinned = !pinned）同样会被这条断言认出来',
  pinsOnClick(oldUp) === true)
check('B3b：钉住会加上 body.pinned（CSS 的 pin 色描边靠它）',
  /pinned = true[\s\S]{0,200}?classList\.add\('pinned'\)/.test(SHELL))

const ctxBlock = slice(SHELL, "ball.addEventListener('contextmenu'", 'async function toggleRingMenu', 'contextmenu')
check('B4：右键点球 → toggleRingMenu()（同一入口开/关）', /toggleRingMenu\(\)/.test(ctxBlock))

const setExpandedBlock = slice(SHELL, 'async function setExpanded', 'function scheduleCollapse', 'setExpanded')
check('B5：展开面板这条路会先收掉环菜单（互斥的另一半）',
  /if \(next\) \{[\s\S]{0,300}?api\.ringClose\(\)[\s\S]{0,300}?await api\.setExpanded\(true\)/.test(setExpandedBlock))

const ringToggle = slice(SHELL, 'async function toggleRingMenu', 'async function togglePanel', 'toggleRingMenu')
check('B6：toggleRingMenu 已开着时走 ringClose（右键再点一次 = 收起）',
  /if \(ringOpen\) \{[\s\S]{0,200}?api\.ringClose\(\)/.test(ringToggle))
check('B7：修 C1 —— 先 await setExpanded(false, true) 再读球心坐标（顺序反了菜单会落在窗外）',
  ringToggle.indexOf('await setExpanded(false, true)') >= 0 &&
  ringToggle.indexOf('await setExpanded(false, true)') < ringToggle.indexOf('getBoundingClientRect()'))

const panelToggle = slice(SHELL, 'async function togglePanel', "document.addEventListener('dragenter'", 'togglePanel')
check('B8：togglePanel 开着则 force 收起（立即收缩窗口），关着则展开',
  /if \(expanded\) \{[\s\S]{0,300}?setExpanded\(false, true\)/.test(panelToggle) && /await setExpanded\(true\)/.test(panelToggle))
check('B9：拖文件到球上仍能展开面板（悬停展开取消后的补偿入口）',
  /addEventListener\('dragenter'/.test(SHELL))

/* ── C. 环菜单开关状态：三处必须一致（左键收起菜单靠它） ─────────────────── */
console.log('')
console.log('## C. orb:ring-state 状态广播（互斥判断的唯一真源）')
check('C1：shell 注册了 onRingState（菜单自己关掉时本侧状态能跟上）', /api\.onRingState\(\(open\)/.test(SHELL))
check('C2：preload 暴露 onRingState', /onRingState\(callback\)/.test(PRELOAD))
const stateSends = (MAIN.match(/orb:ring-state/g) || []).length
check('C3：主进程在「关闭」与「显示」两处各广播一次 orb:ring-state', stateSends >= 2, `出现 ${stateSends} 次`)
check('C3（反向对照）：只广播一次的旧形态会被抓到', (('x orb:ring-state y').match(/orb:ring-state/g) || []).length < 2)
check('C4：关窗时顺手把球窗口恢复成可点（否则关完菜单球就点不动了）',
  /function closeRingMenuWindow\(\)[\s\S]{0,600}?setIgnoreMouseEvents\(false\)/.test(MAIN))

/* ── D. 打开即时性（m00827 §1） ─────────────────────────────────────────── */
console.log('')
console.log('## D. 「点一次就该出来」')
const openBlock = slice(MAIN, 'ipcMain.on("orb:ring-open"', 'ipcMain.on("orb:ring-close"', 'orb:ring-open')
check('D1：打开时按**真实光标位置**定初始穿透态（光标压在环带上就直接可点，不等 mousemove）',
  /screen\.getCursorScreenPoint\(\)/.test(openBlock) && /ringBandHitAt\(/.test(openBlock))
check('D2：ready-to-show 之外还有兜底强推（透明窗口的 ready-to-show 可能不触发）',
  /ready-to-show[\s\S]{0,400}?\}, 500\)/.test(openBlock), openBlock.length + ' chars')
const LOADF = 'await win.loadFile(fileURLToPath(new URL("../assets/floating.html"'
const loadAt = MAIN.indexOf(LOADF)
const preheatAt = MAIN.indexOf('openRingMenuWindow();', loadAt < 0 ? 0 : loadAt)
check('D3：环菜单窗口在启动时预热（首次右键不该付「新建 BrowserWindow + loadFile」的账）',
  loadAt >= 0 && preheatAt > loadAt, `loadFile@${loadAt} preheat@${preheatAt}`)
const bandHit = slice(MAIN, 'function ringBandHitAt', '\n}', 'ringBandHitAt')
check('D4：ringBandHitAt 从环几何常量推导内外半径（不另写数字）',
  /RING_OUTER_D \/ 2/.test(bandHit) && /RING_BAND \* 2/.test(bandHit))

/* ── E. 中心孔的灰块（m00827 §1） ───────────────────────────────────────── */
console.log('')
console.log('## E. 中心孔不允许有常驻灰块')
check('E1：ring-menu.css 有 #hud[hidden] { display: none }（ID 选择器压过 UA 的 [hidden]）',
  /#hud\[hidden\]\s*\{[^}]*display:\s*none/.test(RING_CSS))
check('E1（反向对照）：旧 CSS（只有 #hud{display:flex}）会被这条断言抓到',
  !/#hud\[hidden\]/.test('#hud { display: flex; }'))
const planeRule = slice(RING_CSS, '#plane {', '}', '#plane')
check('E2：#plane 不带 mask（它只负责投影；带 mask 会把 box-shadow 一起裁掉）',
  !/mask/.test(planeRule))
check('E3：布局探针同时断言空闲态 HUD 的 display 与拖动期的反向对照',
  /P2③：空闲态 HUD 不可见/.test(read('probe', 'ring-menu-layout.cjs')) &&
  /P4b（反向对照）/.test(read('probe', 'ring-menu-layout.cjs')))

/* ── F. 环心必须等于球心（用户 m01036 ①） ────────────────────────────────
 * 第一轮为了让菜单永远不出屏，把环窗口 bounds 夹进了工作区。代价是：
 * 球贴边时环心被推离球心（最坏 (140-48)=92px），菜单里那 5 个图标看上去
 * 就「没围着球」。用户的原话是「球体没有出现在菜单的中央」。
 * 现在改成不夹取：环心恒等于球心，代价是环可能被屏幕切掉一部分 ——
 * 那一部分由 F2/F3 的「可见弧」补：图标整体铺进仍然可见的那段弧里。 */
console.log('')
console.log('## F. 环心 = 球心（不夹取）+ 屏外部分用可见弧补偿')
const boundsBlock = slice(MAIN, 'function ringWindowBounds', '\n}', 'ringWindowBounds')
check('F1：ringWindowBounds 不再夹取（环心恒等于球心）',
  !/clampAxis/.test(boundsBlock) && !/getDisplayNearestPoint/.test(boundsBlock) && /screenX - half/.test(boundsBlock))
check('F1（反向对照）：旧实现（夹进 workArea 的 clampAxis 版本）会被同一条断言抓到',
  /clampAxis/.test('const clampAxis = (v, min, max) => Math.max(min, Math.min(max, v));'))
check('F2：主进程 import 了 visibleItemArc，并在下发数据里带上 arc',
  /import \{ ringLayout, visibleItemArc \}/.test(MAIN) && /arc: currentRingArc\(\)/.test(MAIN))
const repositionBlock = slice(MAIN, 'function repositionRingMenuWindow', '\n}', 'repositionRingMenuWindow')
check('F3：球移动后重新下发一次（可见范围会变，弧要跟着变）',
  /sendRingData\(\)/.test(repositionBlock) && /setBounds\(/.test(repositionBlock))
check('F4：渲染层把 arc 传进 itemPositions（图标铺进弧内）',
  /renderItems\(list, arc = null\)/.test(read('helper', 'assets', 'ring-menu.js')) &&
  /itemPositions\(geo, items\.length, arc\)/.test(read('helper', 'assets', 'ring-menu.js')))

/* ── G. 「API 配置」项与抽屉（用户 m01036 ⑥ / 待办 P2-1） ───────────────── */
console.log('')
console.log('## G. 「API 配置」进菜单，且是一页抽屉（不是又一个静默失败）')
const ballItems = slice(SHELL, 'function ballMenuItems', '\n  }', 'ballMenuItems')
check('G1：ballMenuItems() 里有 api-config 项，文案走 messages.menuApiConfig',
  /id: 'api-config'/.test(ballItems) && /messages\.menuApiConfig/.test(ballItems))
const ringItems = slice(SHELL, 'function ringItems', '\n  }', 'ringItems')
check('G2：环菜单清单从 ballMenuItems() 派生（不复制第二份清单，避免两边漂移）',
  /ballMenuItems\(\)/.test(ringItems))
check('G3：handleMenuAction 认得 api-config（开/关抽屉）',
  /if \(id === 'api-config'\) \{ apiConfigPanel\?\.setOpen\(!apiConfigPanel\.isOpen\(\)\); return \}/.test(SHELL))
check('G4：主进程注册了三个 API 配置 IPC（api-config-get/set 在 host，legacy-status 在窗口层）',
  /ipcMain\.handle\(['"]orb:api-config-get['"]/.test(HOST) &&
  /ipcMain\.handle\(['"]orb:api-config-set['"]/.test(HOST) &&
  /ipcMain\.handle\(['"]orb:legacy-status['"]/.test(MAIN))
// 2026-10-19 断脐后这段实现搬了家：守卫在 host 的 applyApiConfig()，密钥写盘在 providers.mjs。
// 断言跟着契约走（「不整份覆写」「不许把密钥文件写坏」），不再钉死旧函数名。
const setBlock = slice(HOST, 'async function applyApiConfig', '\n}', 'applyApiConfig')
const PROVIDERS = read('src', 'providers.mjs')
check('G5：密钥写盘走 tmp + rename（原子替换，写到一半崩掉旧文件仍完整）',
  /const tmp = `\$\{file\}\.tmp-/.test(PROVIDERS) && /renameSync\(tmp, file\)/.test(PROVIDERS))
check('G6：只改用户动过的字段（每个字段都有「值变了才写」的守卫），不做整份覆写',
  /patch\.model\.trim\(\) !== config\.model/.test(setBlock) &&
  /config\.contextBudgetTokens !== patch\.contextBudgetTokens/.test(setBlock) &&
  /config\.reasoningEffort !== wanted/.test(setBlock))
check('G6（反向对照）：无守卫的整份覆写形态会被抓到',
  !/patch\.model\.trim\(\) !== config\.model/.test('config.model = patch.model; auth.providers[p].base_url = patch.baseUrl'))
check('G7：floating.css 有 #api-config 的 [hidden] 复位（与 #hud 同一类坑：ID 选择器压过 UA 的 [hidden]）',
  /#api-config\[hidden\][\s\S]{0,240}?display:\s*none/.test(read('helper', 'assets', 'floating.css')))
check('G8：抽屉默认 hidden，且 API Key 输入框默认 password（要显式点「显示」才露出）',
  /<section id="api-config"[^>]*hidden/.test(read('helper', 'assets', 'floating.html')) &&
  /<input id="api-key" type="password"/.test(read('helper', 'assets', 'floating.html')))
// 唯一例外：B 站二维码把 src/qr.mjs 自己生成的 SVG 塞进容器（不是来自文件/模型的外部内容）。
// 所以断言收窄成「除 biliQrEl 外一律 textContent」。
const API_CFG = read('helper', 'assets', 'api-config.js')
const innerHtmlSites = (API_CFG.match(/[\w$]+\.innerHTML\s*=/g) || []).map((s) => s.split('.')[0])
check('G9：api-config.js 只用 textContent 写文案（值来自文件/模型，禁 innerHTML；B 站二维码 SVG 除外）',
  innerHtmlSites.every((n) => n === 'biliQrEl') &&
  /\.textContent/.test(API_CFG),
  innerHtmlSites.join(','))
check('G10：preload 暴露 apiConfigGet/apiConfigSet/legacyStatus，且 legacy-status 走 invoke（要返回值给渲染层判断）',
  /apiConfigGet\(\)/.test(PRELOAD) && /apiConfigSet\(patch\)/.test(PRELOAD) &&
  /legacyStatus\(\) \{\s*return ipcRenderer\.invoke\('orb:legacy-status'\)/.test(PRELOAD))
const openLegacyWebBody = slice(SHELL, 'async function openLegacyWeb()', '\n  }', 'openLegacyWeb')
check('G11：拿不到旧后端地址时不再静默 return —— 改为打开 API 配置页并给出提示',
  /legacyStatus\(\)/.test(openLegacyWebBody) && /apiConfigPanel\?\.setOpen\(true, \{ note: messages\.apiNoEndpoint \}\)/.test(openLegacyWebBody))
check('G11（反向对照）：旧的「静默 return」形态会被同一条断言抓到',
  !(/legacyStatus\(\)/.test('function openLegacyWeb() { if (!legacyHttp) return; shell.openExternal(legacyHttp) }')))

/* ── H. 收起面板要重置抽屉（用户 m01036 ④） ───────────────────────────── */
console.log('')
console.log('## H. 收起面板 = 回到默认对话框（抽屉不许留在上次那一页）')
const resetBlock = slice(SHELL, 'function resetDrawers()', '\n  }', 'resetDrawers')
check('H1：resetDrawers() 关掉历史/回忆/API 配置三页（只关不开）',
  /setHistoryOpen\(false\)/.test(resetBlock) &&
  /impressionPanel\??\.setOpen\(false\)/.test(resetBlock) &&
  /apiConfigPanel\??\.setOpen\(false\)/.test(resetBlock) &&
  !/setOpen\(true\)/.test(resetBlock))
check('H2：setExpanded 收起时调用它（否则再点球还停在上次的抽屉里）',
  /resetDrawers\(\)[\s\S]{0,600}?classList\.remove\('expanded'\)/.test(
    slice(SHELL, 'async function setExpanded', 'function ballGrabOffset', 'setExpanded-collapse')))

/* ── I. 球边缘右键不许漏给旧列表菜单（用户 m01036 ⑤） ─────────────────── */
console.log('')
console.log('## I. 球「边缘」右键也归环菜单')
check('I1：onContextMenu 同时用 ball.contains 与 nearBall（圆外那圈盒子不在 #ball 里）',
  /ball\.contains\(event\.target\) \|\| nearBall\(event\)/.test(SHELL) && /function nearBall\(event\)/.test(SHELL))
const nearBallBlock = slice(SHELL, 'function nearBall(event)', '\n  }', 'nearBall')
check('I2：nearBall 用「球心 + 半径 + 12px」判定（贴边的光晕/描边也算球）',
  /Math\.hypot\(dx, dy\) <= rect\.width \/ 2 \+ 12/.test(nearBallBlock))
check('I3：球的 contextmenu 里 stopPropagation（否则 document 上的同名监听会把环菜单 toggle 两次）',
  /ball\.addEventListener\('contextmenu'[\s\S]{0,400}?event\.stopPropagation\(\)/.test(SHELL))

/* ── J. 主题菜单 + 三张页面背景（用户 m02033） ─────────────────────────────
 * 用户原话（m02033）：「分为 3 个使用背景，1，对话页背景，2，历史对话背景
 * 3，我们的回忆背景……环形菜单中需要额外加入一个主题菜单，其不仅提供了黑白
 * 两色的主题切换，还支持自定义分别导入前文三个页面的背景。」
 * 这一节只断言**源码契约**（清单/互斥/IPC/白名单）；「背景是否真的随视图换、
 * 三态按钮是否真的发 IPC」由 `probe/shell-boot-smoke.cjs` 的真渲染进程断言管。
 */
console.log('')
console.log('## J. 环菜单「主题」项 + 三个视图各自一张背景')
// 2026-10-21：环菜单里的「打开旧后端界面」被换成「看过的视频」。
// ★ 断言要看**代码**，不能被注释骗：我在这段里留了一行讲"原来是什么"的注释，
//   直接对原文 grep `legacy-web` 会命中注释而假绿 —— 所以先剥掉行注释。
const ballItemsCode = ballItems.replace(/\/\/.*$/gm, '')
check('J1：ballMenuItems() 里有 theme 项（文案走 messages.menuTheme），且插在 api-config 与 bili-history 之间',
  /id: 'theme'/.test(ballItemsCode) && /messages\.menuTheme/.test(ballItemsCode) &&
  /'api-config'[\s\S]{0,260}?id: 'theme'[\s\S]{0,260}?bili-history/.test(ballItemsCode))
check('J1b：菜单里不再有 legacy-web 项（旧后端已剥离，那一项点了什么都不会发生）',
  !/id: 'legacy-web'/.test(ballItemsCode))
check('J1c：新增的 bili-history 项文案走 messages.menuBiliHistory',
  /id: 'bili-history'/.test(ballItemsCode) && /messages\.menuBiliHistory/.test(ballItemsCode))
check('J2：ring-menu.js 的 ITEM_ICONS 有 theme 图标（否则落到圆点兜底）',
  /ITEM_ICONS = \{[\s\S]{0,1200}?\btheme:/.test(read('helper', 'assets', 'ring-menu.js')))
check('J3：handleMenuAction 认得 theme（开/关抽屉）',
  /if \(id === 'theme'\) \{ themePanel\?\.setOpen\(!themePanel\.isOpen\(\)\); return \}/.test(SHELL))
const themeExclusive = slice(SHELL, 'const themePanel = createThemePanel(', 'applyStaticText', 'themePanel')
const exclusivePattern =
  /if \(who === 'theme'\)[\s\S]{0,240}?setHistoryOpen\(false\)[\s\S]{0,240}?impressionPanel\?\.setOpen\(false\)[\s\S]{0,240}?apiConfigPanel\?\.setOpen\(false\)/
check('J4：主题抽屉开时关掉另外三页（历史/回忆/API 配置），互斥是双向的',
  exclusivePattern.test(themeExclusive))
check('J4（反向对照）：只关「历史」不关另外两页的半吊子互斥会被同一条断言抓到',
  !exclusivePattern.test(
    `setExclusiveOpen: (who) => { if (who === 'theme') { setHistoryOpen(false) } },`))
check('J5：preload 暴露主题/背景九条新 API（三个方向：读快照 / 改状态 / 收广播）',
  /themeGet\(\)/.test(PRELOAD) && /themeSet\(mode\)/.test(PRELOAD) && /onTheme\(callback\)/.test(PRELOAD) &&
  /backgroundsGet\(\)/.test(PRELOAD) && /backgroundsImport\(slot\)/.test(PRELOAD) &&
  /backgroundsClear\(slot\)/.test(PRELOAD) && /backgroundsUpdate\(patch\)/.test(PRELOAD) &&
  /openBackgroundsFolder\(\)/.test(PRELOAD) && /onBackgrounds\(callback\)/.test(PRELOAD))
check('J6：主进程注册了主题/背景六个 invoke + 打开目录一条 send，且图都收在 helper/assets/backgrounds 下',
  /ipcMain\.handle\("orb:theme-get"/.test(MAIN) && /ipcMain\.handle\("orb:theme-set"/.test(MAIN) &&
  /ipcMain\.handle\("orb:bg-get"/.test(MAIN) && /ipcMain\.handle\("orb:bg-import"/.test(MAIN) &&
  /ipcMain\.handle\("orb:bg-clear"/.test(MAIN) && /ipcMain\.handle\("orb:bg-update"/.test(MAIN) &&
  /ipcMain\.on\("orb:bg-open-folder"/.test(MAIN) &&
  /BG_DIR = join\(PROJECT_ROOT, "helper", "assets", "backgrounds"\)/.test(MAIN))
check('J7：主题与背景的偏好都落在 logs/window-state.json（与透明度同一处，不另开配置文件）',
  /loadStoredTheme|saveStoredTheme/.test(MAIN) && /loadStoredBackgrounds|saveStoredBackgrounds/.test(MAIN) &&
  /readWindowState\(\)/.test(MAIN))
check('J8：theme-panel.js 的 applyClose() 定义与调用成对（2026-10-08「启动即死」事故的通用防线）',
  /function applyClose\(\)/.test(read('helper', 'assets', 'theme-panel.js')) &&
  /applyClose\(\)/.test(read('helper', 'assets', 'theme-panel.js')))
check('J8b：抽屉的 setOpen 先互斥、后记账（互斥回调会把自己关掉，顺序反了抽屉打不开）',
  /if \(next\) setExclusiveOpen\('theme'\)[\s\S]{0,80}?open = next/.test(read('helper', 'assets', 'theme-panel.js')))
check('J9：三个视图 → 三个槽的收口只有 syncQuestion() 一处（含 chat/history/recall 三个字面量）',
  /backgrounds\.setView\([\s\S]{0,200}?'history'[\s\S]{0,200}?'recall'[\s\S]{0,200}?'chat'/.test(SHELL) &&
  /themePanel\?\.isOpen\(\) === true/.test(SHELL))
check('J10：floating.html 面板内的背景层 = 三个 .bg-layer[data-slot] + 一层蒙层（不是第二个窗口）',
  /<div id="bg-stack"/.test(read('helper', 'assets', 'floating.html')) &&
  (read('helper', 'assets', 'floating.html').match(/class="bg-layer" data-slot=/g) || []).length === 3 &&
  /data-slot="chat"/.test(read('helper', 'assets', 'floating.html')) &&
  /data-slot="history"/.test(read('helper', 'assets', 'floating.html')) &&
  /data-slot="recall"/.test(read('helper', 'assets', 'floating.html')) &&
  /<div id="bg-scrim"/.test(read('helper', 'assets', 'floating.html')))
const floatCss = read('helper', 'assets', 'floating.css')
check('J11：背景层画在面板自己的玻璃底之上、内容之下（z-index:-1 + 面板自身有 transform 层叠上下文）',
  /#bg-stack[\s\S]{0,240}?z-index:\s*-1/.test(floatCss))
check('J11b：三个视图各有一条「切换时把对应层淡入」的规则（这是「随功能切换加载」的实现处）',
  /#panel\[data-view='chat'\] \.bg-layer\[data-slot='chat'\]/.test(floatCss) &&
  /#panel\[data-view='history'\] \.bg-layer\[data-slot='history'\]/.test(floatCss) &&
  /#panel\[data-view='recall'\] \.bg-layer\[data-slot='recall'\]/.test(floatCss))
check('J12：主题页也有 [hidden] 复位（与 #hud / #api-config 同一类坑：ID 选择器压过 UA 的 [hidden]）',
  /#theme\[hidden\][\s\S]{0,240}?display:\s*none/.test(floatCss) &&
  /<section id="theme"[^>]*hidden/.test(read('helper', 'assets', 'floating.html')))
check('J13：新模块一律 textContent（文件名来自用户磁盘、文案来自语种表，禁 innerHTML）',
  !/\.innerHTML/.test(read('helper', 'assets', 'theme-panel.js')) &&
  !/\.innerHTML/.test(read('helper', 'assets', 'backgrounds.js')))

/* ── J 的真行为部分：直接 import 新模块，验白名单挡不挡得住路径穿越 ───────── */
const backgrounds = await import(new URL('../helper/assets/backgrounds.js', import.meta.url).href)
const okPath = backgrounds.safeBackgroundUrl('backgrounds/bg-chat-20261008T000000.png')
const evil = [
  '../../etc/passwd',
  'backgrounds/../secret.png',
  'backgrounds/bg-../x.png',
  'http://evil.example/x.png',
  'https://evil.example/bg-a.png',
  'data:image/png;base64,AAAA',
  'backgrounds/bg-a.svg',
  'backgrounds/bg-a.png?x=1',
  'backgrounds/bg-a.png#x',
  'file:///C:/Windows/win.ini',
  '',
]
const leaked = evil.filter((value) => backgrounds.safeBackgroundUrl(value))
check('J14：safeBackgroundUrl 只放行 backgrounds/bg-*.{png,jpg,jpeg,webp,gif}（穿越/外链/data:/svg 一律挡）',
  okPath === 'backgrounds/bg-chat-20261008T000000.png' && leaked.length === 0,
  `放行了 ${JSON.stringify(leaked)}`)
check('J15：slotForView 把三个视图映射到三个槽，未知视图回落 chat（视图名与槽名是两套词）',
  backgrounds.slotForView('chat') === 'chat' &&
  backgrounds.slotForView('history') === 'history' &&
  backgrounds.slotForView('recall') === 'recall' &&
  backgrounds.slotForView('nope') === 'chat' &&
  backgrounds.slotForView(undefined) === 'chat')

console.log('')
console.log(`${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
