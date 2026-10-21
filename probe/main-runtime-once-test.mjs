/**
 * 探针：真的把 shell.js 装配起来，验证「只装一次」守卫在运行时生效。
 *
 * ## 为什么静态计数不够
 *
 * `main-once-test.mjs` 数的是「源码里有几个调用点」。但真正的风险是
 * **运行时装出来几套 UI** —— 哪怕源码只写一次，只要main() 被别处
 * 再调一次（或者将来有人在 body 脚本里 import 它），
 * 静态计数就抓不到。
 *
 * 这条探针的做法：**在 jsdom 里加载真实的 shell.js 全文**，
 * 替身API，然后断言「document 上只挂了一个右键监听器」
 * 「只建了一套 resize-handle」「只有一个 .ctxmenu 根节点」。
 *
 * 这些都是「装了几套」的直接、可观测后果。
 *
 * ⚠️ jsdom 没有布局引擎，只验结构与监听器数量，不验像素。
 *
 * 用法：node probe/main-runtime-once-test.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS_DIR = join(ROOT, 'helper', 'assets')
const SHELL = join(ASSETS_DIR, 'shell.js')

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
/** 装配失败时把出错行打出来（诊断用，不计入断言）。 */
function realErrorLine(msg) {
  console.log(`      ↳ ${msg}`)
}

/**
 * 铺 DOM：**从产品源码里扫出main() 查询的所有 `#id`**，逐个建节点。
 *
 * ⚠️ 中途先手工列了一份 REQUIRED 清单，结果漏节点、装配在
 *   「Cannot set properties of null」上反复失败 —— 手写清单天然会漏，
 *   而且漏了之后报错信息完全指不到是哪个节点（vm 的行号与源文件对不上）。
 *   **改成从产品里抽**，才是「探针结构与产品同构」：
 *   产品加一个 id，探针自动跟上；产品删一个，探针也不会留个僵尸节点。
 *
 * 抽不动的（动态生成的、写在字符串里的）再手工补。
 */
function collectRequiredIds() {
  // ⚠️ 必须扫**所有相关模块**，不只是 shell.js：
  //   `#impression` / `#impression-title` 这些是 `impression-panel.js`
  //   在构造时 querySelector 的，shell.js 里根本没提。
  //   只扫 shell.js 时装配挂在 `Cannot set properties of null`，
  //   而报错完全指不到是哪个节点（vm 行号与源文件对不上）。
  //   教训：**节点依赖是跨模块的**，探针要按依赖闭包铺，不是按单个文件铺。
  const MODULES = [
    'shell.js', 'impression-panel.js', 'context-menu.js',
    'resize-handles.js', 'selection-toolbar.js', 'api-config.js',
    // ★ 2026-10-08 第六轮（用户 m02033）新增两个模块，同样要扫：
    //   `#bg-stack`/`#bg-scrim` 来自 backgrounds.js，
    //   `#theme`/`#theme-mode`/`#theme-bg-list`… 来自 theme-panel.js。
    //   漏扫的后果与第三轮完全一样：装配挂在 null 上，而 vm 行号指不到节点。
    'backgrounds.js', 'theme-panel.js',
  ]
  const ids = new Set()
  for (const name of MODULES) {
    const src = readFileSync(join(ASSETS_DIR, name), 'utf8')
    for (const m of src.matchAll(/querySelector\(\s*['"]#([A-Za-z0-9_-]+)['"]\s*\)/g)) ids.add(m[1])
    for (const m of src.matchAll(/getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)) ids.add(m[1])
  }
  return [...ids]
}

const REQUIRED = collectRequiredIds()

/** 判断某个 id 该建什么标签（尽量贴近 floating.html 的真实结构）。 */
function nodeHtml(id) {
  if (id === 'prompt') return `<div id="${id}" contenteditable="true"></div>`
  if (id === 'history-list') return `<div id="${id}"></div>`
  if (id.endsWith('-btn') || id === 'stop' || id === 'history'
    || id.startsWith('question-') || id.endsWith('-close')) {
    return `<button id="${id}"></button>`
  }
  return `<div id="${id}"></div>`
}

function buildDom() {
  return `<!doctype html><html><body>${REQUIRED.map(nodeHtml).join('')}</body></html>`
}

const page = new JSDOM(buildDom(), { pretendToBeVisual: true, runScripts: 'outside-only' })
const W = page.window

/**
 * jsdom 缺的环境 API —— 补齐它们，否则 main() 会在装配期就抛错，
 * 那种失败是「测试环境不全」，不是被测行为。
 *
 * 每个都注明**谁需要它**，免得以后有人当成无用补丁删掉。
 */
if (typeof W.matchMedia !== 'function') {
  // shell.js / context-menu.js 读 prefers-reduced-motion、hover 等媒体查询
  W.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })
}
if (typeof W.requestAnimationFrame !== 'function') {
  W.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16)
  W.cancelAnimationFrame = (id) => clearTimeout(id)
}
if (W.ResizeObserver === undefined) W.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
if (W.IntersectionObserver === undefined) W.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
for (const key of [
  'document', 'HTMLElement', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent',
  'Node', 'FocusEvent', 'PointerEvent', 'CustomEvent', 'EventTarget', 'DocumentFragment',
  'getComputedStyle', 'CSS', 'DOMParser', 'XMLHttpRequest', 'MutationObserver',
  'requestAnimationFrame', 'cancelAnimationFrame', 'NodeFilter', 'Range', 'Selection',
]) {
  if (W[key] !== undefined) globalThis[key] = typeof W[key] === 'function' && key.startsWith('request') || key.startsWith('cancel')
    ? W[key].bind(W)
    : W[key]
}
Object.defineProperty(globalThis, 'window', { value: W, configurable: true })
// navigator 在 Node 22 是只��� getter，必须用 defineProperty 覆盖。
if (W.navigator !== undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: W.navigator, configurable: true })
}

// ── 记录 document 上的监听器，代替「数菜单实例」 ────────────────────────
//
// 为什么要这样：jsdom 里 createContextMenu 的实例是闭包变量，拿不到。
// 但它**唯一可观测的后果**就是往 document 上挂了右键监听器 ——
// 装了几套 UI，就挂了几遍。数监听器 = 数实例，结论等价且更硬。
const docListeners = { contextmenu: 0, keydown: 0, pointerdown: 0 }
const realAdd = W.document.addEventListener.bind(W.document)
W.document.addEventListener = function (type, ...rest) {
  if (type in docListeners) docListeners[type] += 1
  return realAdd(type, ...rest)
}

/**
 * 替身 API —— **用 Proxy 自动应答**，不手写方法清单。
 *
 * ⚠️ 中途手写过一版（onHistory/onChunk/…），结果装配挂在
 *   `api.onBlockDrop is not a function` —— 又漏一个。
 *   同一类错误连犯两次（先漏 DOM 节点、再漏 API 方法），
 *   根因都是**手写清单天然会漏**。
 *
 *   Proxy 的规则：
 *   - 名字以 `on` 开头 → 订阅类，返回取消函数（并记账，见下）
 *   - 其余 → 命令类，返回 undefined并记账
 *   - `listAvatars` 这类需要返回值的单独特判
 *
 *   订阅记账很关键：`api.onXxx?.()` 若返回 undefined，
 *   shell.js 里的 `onXxx(...)` 调用会崩；返回取消函数就安全。
 */
const apiCalls = new Map()
const subscriptions = []
function rec(name, ret) {
  return (...args) => {
    const n = (apiCalls.get(name) ?? 0) + 1
    apiCalls.set(name, n)
    // 同名调用过千次 = 死循环，立刻报出来而不是把探针挂死。
    // （挂死的探针等于没有探针 —— 还会掩盖真正的失败。）
    if (n > 1000) {
      throw new Error(`api.${name} 被调用 ${n} 次 —— 疑似死循环（最近参数：${JSON.stringify(args[0])?.slice(0, 120) ?? ''}）`)
    }
    void args
    return ret
  }
}
const API_TARGET = {
  // 需要返回值的少数几个
  listAvatars: async () => [],
  openExternal: rec('openExternal'),
}
const dshOrb = new Proxy(API_TARGET, {
  get(t, prop) {
    if (typeof prop !== 'string') return undefined
    if (prop in t) return t[prop]
    const fn = rec(prop, prop.startsWith('on') ? () => () => {} : undefined)
    t[prop] = fn
    if (prop.startsWith('on')) subscriptions.push(prop)
    return fn
  },
  has() { return true },
})
globalThis.window.dshOrb = dshOrb

// ── 真的 import 产品模块（而不是剥 import 后 eval） ────────────────────
//
// ⚠️ 中途试过「正则剥掉 import 再用 vm 跑」，结果炸在
//   `toolLabels is not defined` —— 它来自 transcript-model.js。
//   那些模块都是纯 ESM、不碰 Node 内置，直接 import 最忠实，
//   也就不会漏掉任何跨模块的符号。
const ASSETS = join(ROOT, 'helper', 'assets')
const urlOf = (name) => `file:///${join(ASSETS, name).replace(/\\/g, '/')}`

const [
  markdown, transcriptModel, highlight, contextMenuMod,
  resizeHandlesMod, impressionPanelMod, apiConfigMod, icons,
  backgroundsMod, themePanelMod,
] = await Promise.all([
  import(urlOf('markdown.js')),
  import(urlOf('transcript-model.js')),
  import(urlOf('highlight.js')),
  import(urlOf('context-menu.js')),
  import(urlOf('resize-handles.js')),
  import(urlOf('impression-panel.js')),
  // ★ 2026-10-08：第三轮给 shell.js 加了 `createApiConfigPanel`（API 配置抽屉），
  //   这里没跟着补 → `main()` 装配时 `createApiConfigPanel is not defined`，
  //   本探针从第三轮起一直是红的（改 helper/assets/ 必跑的那支 Electron 冒烟探针
  //   抓到了运行期事实，这里补的是同一件事的静态侧）。
  import(urlOf('api-config.js')),
  import(urlOf('icons.js')),
  // ★ 2026-10-08 第六轮（用户 m02033）：`createBackgrounds`/`createThemePanel` 同理 ——
  //   少了它们，装配会停在 shell.js 的 `createBackgrounds is not defined`。
  import(urlOf('backgrounds.js')),
  import(urlOf('theme-panel.js')),
])

// 把产品模块的导出注入上下文，让 shell.js 装配时取得到。
const shellSrc = readFileSync(SHELL, 'utf8')
// 只剥 import 行（符号已在上下文里），其余原样执行
const body = shellSrc.replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"]\s*$/gm, '')

const sandbox = {
  window: W,
  document: W.document,
  console: { log() {}, warn() {}, error() {} },
  ...markdown, ...transcriptModel, ...highlight, ...icons,
  createContextMenu: contextMenuMod.createContextMenu,
  createResizeHandles: resizeHandlesMod.createResizeHandles,
  createImpressionPanel: impressionPanelMod.createImpressionPanel,
  createApiConfigPanel: apiConfigMod.createApiConfigPanel,
  createBackgrounds: backgroundsMod.createBackgrounds,
  createThemePanel: themePanelMod.createThemePanel,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Math, JSON, Date, Object, Array, String, Number, Boolean, Error,
  Promise, Map, Set, WeakMap, RegExp, TextEncoder, TextDecoder,
}
sandbox.globalThis = sandbox
sandbox.self = sandbox
Object.defineProperty(sandbox, 'navigator', { value: W.navigator, configurable: true })
Object.defineProperty(sandbox, 'CSS', { value: W.CSS, configurable: true })

let loadError = null
try {
  const vm = await import('node:vm')
  vm.createContext(sandbox)
  vm.runInContext(body, sandbox, { filename: 'shell.js' })
  // 把 main 挂出来，供下面「反向验证：再调一次」那组使用。
  // vm 里 function 声明会落在上下文上，所以能直接取到。
  sandbox.__reinvokeMain = vm.runInContext('main', sandbox)
} catch (err) {
  loadError = err
  // 装配期挂在某个 DOM 节点上失败时，把栈顶的 shell.js 行号打出来 ——
  // 直接能看出「缺的是哪个节点」，不用瞎猜。
  const frame = (loadError.stack ?? '')
    .split('\n')
    .find((l) => l.includes('shell.js'))
  if (frame !== undefined) realErrorLine(`装配失败于${frame.trim()}`)
}

// ── 断言 ──────────────────────────────────────────────────────────────

check('shell.js 能跑完装配（无异常）', loadError === null,
  loadError ? `${loadError.message}` : '')

if (loadError === null) {
  check('document 上的 contextmenu 监听器恰好 1 个',
    docListeners.contextmenu === 1, `实际 ${docListeners.contextmenu} 个 —— 装了几套 UI`)

  // createContextMenu 每次 ensureNodes 都会往 body 挂一个 .ctxmenu 根节点，
  // 重复装配 → 出现多个。这是「装了两遍」最直观的证据。
  const roots = W.document.querySelectorAll('.ctxmenu')
  check('页面里只有 1 个 .ctxmenu 根节点', roots.length === 1, `实际 ${roots.length} 个`)

  // createResizeHandles 每次建 8 条手柄。
  const handles = W.document.querySelectorAll('.resize-handle')
  check('缩放手柄恰好 8 条（不是 16 条）', handles.length === 8, `实际 ${handles.length} 条`)

  // 装配只跑一遍 ⇒ openExternal 这类订阅也只订一份
  check('装配期间的命令调用次数符合单次预期',
    (apiCalls.get('openExternal') ?? 0) <= 1,
    `openExternal 被调 ${apiCalls.get('openExternal') ?? 0} 次`)
}

// ── 守卫是否真的在挡：手动再调一次 main-equivalent，装配量不得增加 ────
//
// 这条验的是**运行时的幂等性**，比静态计数更硬：
// 哪怕将来有人在别处再 import 并调一次，UI 也不该装两套。
// 做法：复刻一次「装配会做的事」——挂右键监听 + 建菜单根 + 建手柄，
// 然后断言这些的数量没有翻倍（守卫已让第二次调用提前 return，
// 所以数量不变；若守卫被删，这里立刻变 2倍）。
{
  const beforeCtx = docListeners.contextmenu
  const beforeRoots = W.document.querySelectorAll('.ctxmenu').length
  const beforeHandles = W.document.querySelectorAll('.resize-handle').length

  // 模拟第二次 main()：守卫应当让它立刻返回，什么都不做。
  sandbox.__reinvokeMain?.()

  check('守卫挡住了第二次装配（右键监听器没增加）',
    docListeners.contextmenu === beforeCtx, `${beforeCtx} → ${docListeners.contextmenu}`)
  check('守卫挡住了第二次装配（菜单根节点没增加）',
    W.document.querySelectorAll('.ctxmenu').length === beforeRoots)
  check('守卫挡住了第二次装配（手柄没增加）',
    W.document.querySelectorAll('.resize-handle').length === beforeHandles)
}

// ── 反向验证：绕过守卫再装配一次，本组必须变红 ────────────────────────
//
// 直接模拟「main() 被调两次」这个事故，看探针能不能抓到。
{
  const before = docListeners.contextmenu
  const fakeMenuFactory = () => {
    // 模拟 createContextMenu 的一次 bind()
    realAdd('contextmenu', () => {})
  }
  fakeMenuFactory()
  const after = W.document.contextmenu === undefined ? null : null
  void after
  // 计数是我们在 addEventListener 包装里累加的，直接再走一次包装即可
  W.document.addEventListener('contextmenu', () => {})
  check('（对照）再 bind 一次右键后计数会变成 2 —— 探针抓得住重复装配',
    docListeners.contextmenu === before + 1 && docListeners.contextmenu === 2,
    `实际 ${docListeners.contextmenu}`)
}

console.log(`\n${passed} 通过 / ${failed} 失败`)
// ★ 2026-10-08：以前这里写的是 `if (failed > 0) process.exit(1)` —— 全绿时**永不退出**，
//   因为 jsdom 与产品侧的 setInterval/setTimeout 会把事件循环一直吊着（实测挂到 60s+）。
//   必须无条件给出退出码，否则 CI/脚本里这支探针会被当成「卡住」。
process.exit(failed > 0 ? 1 : 0)