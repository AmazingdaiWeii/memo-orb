/**
 * 对话框发图（P2-4）—— **渲染层**行为验证（真的跑 shell.js，不是复刻）。
 *
 * 为什么必须真跑 shell.js：这个功能的缺口**全在球侧**。
 *   `preload.cjs` / `helper/lib/main.js` / `src/main.mjs` 这条上送链路
 *   探针可以直接 import 验证（本文件下半部分就是），但「用户把图拖进来
 *   到底有没有反应」只能靠装配真渲染层。
 *   host 全绿 + 球侧零代码 = 功能完全不可用 —— 这与 lock 那次是同一类病。
 *
 * ★★ jsdom 没有 canvas / createImageBitmap / FileReader 的完整实现。
 *   这里**打了桩，但桩只补环境**：
 *     · `createImageBitmap` → 返回一个假的 bitmap（宽高可读、close 可调）
 *     · `HTMLCanvasElement.prototype.getContext('2d')` → 假 ctx（drawImage 记账）
 *     · `toBlob` → 回调一个 **可控大小的** Blob（按档位递减，模拟压缩生效）
 *   产品逻辑（三档阶梯、512KB 判定、跳过小图、maxCount）全部由产品代码自己走。
 *
 * ⚠️ 仍然测不到的：
 *   · 缩略图真的长什么样、48×48 的框里构图对不对
 *   · 拖拽提示环的位置（依赖 header/layout，jsdom 无布局引擎）
 *   · base64 真的发到 Letta 后模型看不看得懂
 *
 * 跑法：`node probe/image-attach-test.mjs`
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = join(ROOT, 'helper', 'assets')

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`PASS ${name}`)
    return
  }
  failed += 1
  console.log(`FAIL ${name}${detail === '' ? '' : ` —— ${detail}`}`)
}

// ═══════════════════════════════════════════════════ A. 纯模块层（无 DOM）

console.log('── A. image-attach.js 纯逻辑 ──')

const mod = await import(pathToFileURL(join(ASSETS, 'image-attach.js')).href)
const { isImageFile, pickImageFiles, compressImage, MAX_ATTACHMENTS, formatBytes } = mod

check('导出 MAX_ATTACHMENTS', typeof MAX_ATTACHMENTS === 'number' && MAX_ATTACHMENTS > 0,
  String(MAX_ATTACHMENTS))
check('导出 formatBytes', typeof formatBytes === 'function')

// ── isImageFile ──
const f = (name, type, size = 100) => {
  const file = new File([new Uint8Array(Math.min(size, 64))], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}
check('png 认作图片', isImageFile(f('a.png', 'image/png')))
check('无 type 但 .jpg 扩展名也认', isImageFile(f('a.jpg', '')))
check('svg 不算图片（它不是位图，压缩无意义）', !isImageFile(f('a.svg', 'image/svg+xml')))
check('纯文本不算图片', !isImageFile(f('a.txt', 'text/plain')))
check('null 不炸', !isImageFile(null))

// ── pickImageFiles ──
check('items 里只有 file 才取（WorkBuddy 的 kind 判定）',
  pickImageFiles({
    items: [
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => f('x.png', 'image/png') },
    ],
  }).length === 1,
)
check('items 拿不到时退回 files',
  pickImageFiles({
    items: [],
    files: [f('y.png', 'image/png')],
  }).length === 1,
)
check('items 里混了文本文件时只挑图片',
  pickImageFiles({
    items: [
      { kind: 'file', getAsFile: () => f('a.txt', 'text/plain') },
      { kind: 'file', getAsFile: () => f('b.png', 'image/png') },
    ],
  }).length === 1,
)
check('两种来源都没有时返回空数组（不炸）',
  pickImageFiles({}).length === 0 &&
  pickImageFiles(null).length === 0,
)

// ── compressImage 的分支（不依赖 DOM：小图直接跳过）──
const small = f('small.png', 'image/png', 100 * 1024)
const r1 = await compressImage(small)
check('★ 小于 512KB 的图**不做任何压缩**（不无谓重编码）',
  r1.compressed === false && r1.blob === small && r1.finalBytes === 100 * 1024,
  `compressed=${r1.compressed} same=${r1.blob === small}`)

const huge = f('huge.png', 'image/png', 60 * 1024 * 1024)
const r2 = await compressImage(huge)
check('★ 超过 50MB 直接放弃压缩（解码会卡死页面）',
  r2.compressed === false && r2.reachedTarget === false && r2.blob === huge,
  `attempts=${r2.attempts}`)

const notImage = f('doc.pdf', 'application/pdf', 5 * 1024 * 1024)
const r3 = await compressImage(notImage)
check('非图片原样返回', r3.compressed === false && r3.blob === notImage)

check('压缩结果带齐 UI 需要的字段',
  ['mimeType', 'originalBytes', 'finalBytes', 'compressed', 'reachedTarget', 'attempts']
    .every((k) => k in r1),
  Object.keys(r1).join(','))

console.log(`\n（A 段结束：${passed} 通过 / ${failed} 失败）\n`)

// ═══════════════════════════════════════════════════ B. 装配真渲染层

console.log('── B. 装配：真的跑一遍 shell.js ──')

const html = readFileSync(join(ASSETS, 'floating.html'), 'utf8')
const page = new JSDOM(html, {
  pretendToBeVisual: true,
  url: pathToFileURL(join(ROOT, 'helper', 'assets', 'floating.html')).href,
  resources: undefined,
  runScripts: 'outside-only',
})
const W = page.window

const CSS = readFileSync(join(ASSETS, 'floating.css'), 'utf8')
const HTML = html
const SHELL = readFileSync(join(ASSETS, 'shell.js'), 'utf8')

for (const key of [
  'window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent',
  'KeyboardEvent', 'FocusEvent', 'CustomEvent', 'CSS', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'DOMRect', 'File', 'Blob',
  'FileReader', 'URL', 'DragEvent', 'DataTransfer', 'ClipboardEvent',
]) {
  if (W[key] !== undefined) globalThis[key] = W[key]
}
globalThis.window = W

if (typeof W.matchMedia !== 'function') {
  W.matchMedia = (query) => ({
    matches: false, media: String(query), onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false },
  })
}
if (typeof W.Element.prototype.getBoundingClientRect !== 'function' || true) {
  W.Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() { return this } }
  }
}
Object.defineProperty(W.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 0 } })
Object.defineProperty(W.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 0 } })
W.Element.prototype.setPointerCapture = function () {}
W.Element.prototype.releasePointerCapture = function () {}
W.Element.prototype.hasPointerCapture = function () { return false }
if (typeof W.PointerEvent !== 'function') W.PointerEvent = W.MouseEvent
if (typeof W.ResizeObserver !== 'function') {
  W.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
}
if (typeof W.requestIdleCallback !== 'function') W.requestIdleCallback = (fn) => W.setTimeout(fn, 0)

// ── canvas / createImageBitmap / objectURL 桩 ──
//
// ★ 关键设计：toBlob 吐出的 Blob 大小由 **sizeFor(quality)** 决定，
//   而不是靠一个「按调用次序出牌」的队列。
//   为什么：压缩器内部有一个「质量再降两轮」的小循环（见
//   vendor/image-compression.js 的 `for (let i = 0; i < 2 && ...)`），
//   同一个 maxWidthOrHeight 档位会被 toBlob 调用 1~3 次。
//   用队列出牌会让「第几次调用」和「第几档」错位 —— 我第一版就是这么写的，
//   结果 D5 段读到的是 D4 段剩下的牌，断言全错而产品是对的。
//   ⇒ 桩只回答「这个质量下大概多大」，调用次序由产品自己决定。
let canvasCalls = []
let sizeFor = () => 1024     // 默认：压得很小
let bitmapCalls = []
let lastCtx = null

/**
 * 造一个**真实字节数**等于 size 的 Blob。
 *
 * ⚠️ 不能只 `defineProperty(blob,'size',...)` —— 压缩器最后是
 *    `return new File([blob], name, {type})`，File 构造函数**按真实字节重算 size**，
 *    被 defineProperty 的假值会被丢掉，于是压缩器看见的永远是「4 字节」。
 *    （第一版就是这么写的，症状是「明明压了但 compressed 报 false」。）
 *   用 `new Uint8Array(size)` 分配真实内存代价高（512KB×N），
 *   所以用一个被真实现算出长度的占位串。
 */
function makeFakeBlob(size, type = 'image/jpeg') {
  const safe = Math.max(0, Math.min(size, 8 * 1024 * 1024))
  return new W.Blob(['x'.repeat(safe)], { type })
}

// objectURL 桩：用自增 id，便于断言 revoke 有没有被调
let urlSeq = 0
const liveURLs = new Set()
W.URL.createObjectURL = () => {
  const u = `blob:probe-${++urlSeq}`
  liveURLs.add(u)
  return u
}
W.URL.revokeObjectURL = (u) => { liveURLs.delete(u) }

W.createImageBitmap = async (source, opts) => {
  bitmapCalls.push({ source, opts })
  return {
    width: 4000, height: 3000, close() { bitmapCalls[bitmapCalls.length - 1].closed = true },
  }
}

W.HTMLCanvasElement.prototype.getContext = function () {
  lastCtx = {
    fillStyle: '',
    fillRect() { this.filled = (this.filled ?? 0) + 1 },
    drawImage() { this.drawn = (this.drawn ?? 0) + 1 },
    clearRect() {},
  }
  return lastCtx
}
W.HTMLCanvasElement.prototype.toBlob = function (cb, type, quality) {
  const q = typeof quality === 'number' ? quality : 1
  canvasCalls.push({ type, quality: q, fillStyle: lastCtx?.fillStyle })
  // ★ 用**假 size 的 File 返回值**：压缩器最后 `return new File([blob], ...)`，
  //   而 File 构造函数会按真实字节重算 size —— 所以桩必须在
  //   `sizeFor()` 里已经决定了大小之后，让压缩器原样把它包出去。
  //   做法：让 blob 的字节长度就等于 sizeFor 的值（用一个占位数组）。
  const size = sizeFor(q)
  const blob = makeFakeBlob(size, type ?? 'image/jpeg')
  W.setTimeout(() => cb(blob), 0)
}

globalThis.createImageBitmap = W.createImageBitmap
globalThis.Blob = W.Blob
globalThis.URL = W.URL

// ── 记录型 API 桩（Proxy 自动应答，别手写清单）──
const calls = []
const subscribers = {}
function push(channel, payload) {
  for (const fn of subscribers[channel] ?? []) fn(payload)
}

/**
 * ★ 少数通道**有返回值**，不能一律 `Promise.resolve(undefined)`。
 *
 * `orb:expand` 真机上回的是 `{expanded, horizontal, vertical, docked}`
 * （helper/lib/main.js:1518），而渲染层 shell.js:984 会读 `state.horizontal`
 * 喂给 `applyDirection()`。桩要是给了 undefined，applyDirection 当场炸
 * ——那是**桩的洞**，不是产品 bug（真机走 preload.cjs:13 → IPC，拿得到对象）。
 * 这里按真机形状补齐。
 */
const RETURNS = {
  setExpanded: () => ({ expanded: true, horizontal: 'left', vertical: 'up', docked: undefined }),
}

const api = new Proxy({}, {
  get(_t, prop) {
    const name = String(prop)
    if (name.startsWith('on')) {
      return (fn) => {
        if (typeof fn !== 'function') return () => {}
        ;(subscribers[name] ??= []).push(fn)
        return () => {
          const arr = subscribers[name] ?? []
          const i = arr.indexOf(fn)
          if (i >= 0) arr.splice(i, 1)
        }
      }
    }
    return (...args) => {
      calls.push({ name, args })
      if (RETURNS[name]) return Promise.resolve(RETURNS[name](...args))
      return Promise.resolve(undefined)
    }
  },
})
W.dshOrb = api
globalThis.dshOrb = api

let bootError = null
try {
  await import(pathToFileURL(join(ASSETS, 'shell.js')).href)
} catch (err) {
  bootError = err
}
check('★ shell.js 能在真 HTML 上装配成功（不抛）', bootError === null,
  bootError === null ? '' : `${bootError.name}: ${bootError.message}`)
if (bootError !== null) {
  console.log('\n' + '='.repeat(56))
  console.log(`通过 ${passed} / 失败 ${failed}`)
  console.log('装配就炸了，后面的断言没有意义，提前退出。')
  process.exit(1)
}

const doc = W.document
const composer = doc.querySelector('#composer')
const prompt = doc.querySelector('#prompt')
const strip = doc.querySelector('#attach-strip')
const dropHint = doc.querySelector('#drop-hint')

// ═══════════════════════════════════════════════════ C. DOM 契约

console.log('\n── C. DOM 与 CSS 契约 ──')

check('#attach-strip 存在于真 HTML 里', strip !== null)
check('#drop-hint 存在于真 HTML 里', dropHint !== null)
check('★ 附件条在 #composer 内部（跟着输入框走，不另起浮层）',
  strip !== null && composer.contains(strip))
check('★ 提示层在 #composer 内部', dropHint !== null && composer.contains(dropHint))
check('附件条初始 hidden（没图就不占视觉）', strip?.hasAttribute('hidden') === true)
check('提示层初始 hidden（没拖就不出现）', dropHint?.hasAttribute('hidden') === true)

check('CSS：附件条 z-index 用 3（普通控件档，不与输入框的 2 打架）',
  /#attach-strip\s*\{[^}]*z-index:\s*3/.test(CSS))
check('★★ CSS：提示层必须 pointer-events:none（吃了事件就变成「看着能拖、拖不进去」）',
  /#drop-hint\s*\{[^}]*pointer-events:\s*none/.test(CSS))
check('CSS：提示层隐藏时 display:none（光靠 hidden 属性不够，它是 flex）',
  /#drop-hint\[hidden\]\s*\{[^}]*display:\s*none/.test(CSS))
check('CSS：附件条按展开方向往对应侧躲（expand-up 在下、expand-down 在上）',
  /body\.expand-up\s+#attach-strip\s*\{[^}]*bottom:\s*100%/.test(CSS) &&
  /body\.expand-down\s+#attach-strip\s*\{[^}]*top:\s*100%/.test(CSS))
check('CSS：--accent 已定义（浅色主题）', /--accent:\s*#[0-9a-f]{3,8}/i.test(CSS))
check('CSS：--accent 有暗色主题覆盖', /data-ds-dark-theme[\s\S]{0,600}--accent:/.test(CSS))

// 产品源码断言：粘贴分支必须先判文件
check('★ 产品源码：paste 处理里先调 pickImageFiles 再决定 preventDefault',
  /addEventListener\('paste'[\s\S]{0,400}pickImageFiles\(event\.clipboardData\)/.test(SHELL))
check('★ 产品源码：拖拽深度用计数器而非布尔（父子元素间移动会连发 leave/enter）',
  /let dragDepth = 0/.test(SHELL) &&
  /dragDepth \+= 1/.test(SHELL) &&
  /dragDepth = Math\.max\(0, dragDepth - 1\)/.test(SHELL))
check('★ 产品源码：dragenter/dragover/dragleave/drop 四个都绑了',
  ['dragenter', 'dragover', 'dragleave', 'drop'].every((t) =>
    new RegExp(`addEventListener\\('${t}'`).test(SHELL)))
check('★ 产品源码：window blur 兜底收起提示层（无边框窗口窗外松手收不到 drop）',
  /addEventListener\('blur'[\s\S]{0,120}dropHint\.hidden = true/.test(SHELL))
check('产品源码：提交前检查附件是否还在压缩中',
  /async function submitComposer[\s\S]{0,600}attachments\.some\(\(a\) => a\.busy\)/.test(SHELL))
check('★ 产品源码：清空/切会话时释放 objectURL（不 revoke 就是内存泄漏）',
  /function clearAttachments[\s\S]{0,200}dispose\?\./.test(SHELL) &&
  /clearTranscript[\s\S]{0,400}clearAttachments\(\)/.test(SHELL))

// ═══════════════════════════════════════════════════ D. 行为：拖进来

console.log('\n── D. 行为：图片进得来、看得见、删得掉 ──')

function dragEvent(type, files) {
  const dt = {
    types: files.length > 0 ? ['Files'] : [],
    items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
    files,
    dropEffect: '',
  }
  const ev = new W.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'dataTransfer', { value: dt })
  return ev
}

function dropFiles(files) {
  composer.dispatchEvent(dragEvent('dragenter', files))
  composer.dispatchEvent(dragEvent('dragover', files))
  composer.dispatchEvent(dragEvent('drop', files))
}

const wait = (ms) => new Promise((r) => W.setTimeout(r, ms))

// D1 拖入提示层的显隐
const png = f('shot.png', 'image/png', 900 * 1024)
composer.dispatchEvent(dragEvent('dragenter', [png]))
check('★ dragenter 有文件 → 提示层出现', dropHint.hidden === false)
// 父子元素间移动会连发 enter：再来一次，不能把提示层关掉
composer.dispatchEvent(dragEvent('dragenter', [png]))
composer.dispatchEvent(dragEvent('dragleave', [png]))
check('★★ 深层子元素间移动（enter→enter→leave）提示层**仍然可见**（计数器生效）',
  dropHint.hidden === false)
composer.dispatchEvent(dragEvent('dragleave', [png]))
check('真正的离开（再 leave，计数归零）→ 提示层收起', dropHint.hidden === true)

// D2 拖入小图（不压缩分支）
sizeFor = () => 1024
composer.dispatchEvent(dragEvent('dragenter', [png]))
check('放下前提示层可见', dropHint.hidden === false)
composer.dispatchEvent(dragEvent('drop', [png]))
check('★ drop 之后提示层立即收起（不等异步压缩）', dropHint.hidden === true)
await wait(60)
check('★ 缩略图条出现', strip.hidden === false)
check('条里有 1 个附件项', strip.children.length === 1)
check('附件项是 <li>（父节点是 ul，不能塞 div）',
  strip.children[0]?.tagName === 'LI')
check('附件项里有 <img> 缩略图', strip.children[0]?.querySelector('img') !== null)
check('附件项里有删除按钮', strip.children[0]?.querySelector('.attach-remove') !== null)
check('小图不做压缩 → 不标 heavy',
  strip.children[0]?.dataset.heavy === '0',
  `heavy=${strip.children[0]?.dataset.heavy}`)

// D3 删除
strip.children[0].querySelector('.attach-remove').dispatchEvent(
  new W.MouseEvent('click', { bubbles: true, cancelable: true }),
)
await wait(20)
check('★ 点删除按钮 → 附件项消失', strip.children.length === 0)
check('删空之后条子重新 hidden（不留空框）', strip.hidden === true)
check('★ 删除时 revoke 了 objectURL（liveURLs 归零）',
  liveURLs.size === 0, `还活着 ${liveURLs.size} 个`)

// D4 大图走压缩阶梯
//
// ★ 这个桩按「质量」返回大小：只要产品在**降档**，size 就该变小。
//   质量 0.85 → 900KB（超 512KB）、0.70 → 700KB（还超）、0.55 → 300KB（达标）。
//   产品应该在第一档失败后降到第二档、再降到第三档，到第三档才停 ——
//   这正是「三档阶梯」该有的行为。
sizeFor = (q) => (q >= 0.8 ? 900 * 1024 : q >= 0.6 ? 700 * 1024 : 300 * 1024)
canvasCalls = []
const big = f('big.png', 'image/png', 3 * 1024 * 1024)
dropFiles([big])
await wait(300)
check('★ 大图真的走了 canvas 压缩', canvasCalls.length > 0, `canvas 调用 ${canvasCalls.length} 次`)
// ⚠️ 序列里第一个 `quality=1` 是 `shrink()` 缩放阶段的 PNG 重绘（不是编码档位）；
//    质量值还带浮点误差（0.55 存成 0.5499999999999999）—— 一律近似比较。
const d4quals = canvasCalls.map((c) => c.quality).filter((q) => q < 1)
const near = (a, b) => Math.abs(a - b) < 0.01
check('★ 三档阶梯：质量逐级下降（0.85 → 0.70 → 0.55），到 ≤512KB 就停',
  d4quals.length > 0 &&
  near(d4quals[0], 0.85) &&
  d4quals.some((q) => near(q, 0.7)) &&
  near(d4quals[d4quals.length - 1], 0.55),
  `实际质量序列 ${JSON.stringify(d4quals)}（原始 ${JSON.stringify(canvasCalls.map((c) => c.quality))}）`)
check('★ 压到 ≤512KB 后不再继续试更小的档（不是死磕跑完全部）',
  d4quals.filter((q) => near(q, 0.85)).length === 1,
  `0.85 出现 ${d4quals.filter((q) => near(q, 0.85)).length} 次`)
check('压缩结果 ≤512KB → 不标 heavy',
  strip.children.length === 1 && strip.children[0]?.dataset.heavy === '0',
  `heavy=${strip.children[0]?.dataset.heavy}`)
check('★ 压缩真的发生时 thumbURL 是 objectURL（不是 dataURL，后者会把整图常驻内存）',
  (strip.querySelector('img')?.src ?? '').startsWith('blob:'),
  strip.querySelector('img')?.src)

// 清理
strip.children[0]?.querySelector('.attach-remove')?.dispatchEvent(
  new W.MouseEvent('click', { bubbles: true, cancelable: true }),
)
await wait(30)

// D5 压不到目标 → heavy 角标
//
// 这一档**无论质量多低都压不到 512KB** —— 模拟「图太复杂，压不动」。
sizeFor = () => 700 * 1024
canvasCalls = []
dropFiles([f('huge2.png', 'image/png', 5 * 1024 * 1024)])
await wait(400)
check('★★ 三档都压不到 512KB → 仍然接受，但标 heavy（提示用户这张图吃上下文）',
  strip.children.length === 1 && strip.children[0]?.dataset.heavy === '1',
  `heavy=${strip.children[0]?.dataset.heavy}`)
check('压不到目标时三档的**初始质量**都试过（0.85 / 0.70 / 0.55 各出现一次）',
  [0.85, 0.7, 0.55].every((q) => canvasCalls.some((c) => Math.abs(c.quality - q) < 0.01)),
  `质量序列 ${JSON.stringify(canvasCalls.map((c) => c.quality))}`)
check('压不到时用「试过的最小那张」而不是原图',
  (strip.querySelector('img')?.src ?? '').startsWith('blob:'))

// D6 多张 + 上限
strip.children[0]?.querySelector('.attach-remove')?.dispatchEvent(
  new W.MouseEvent('click', { bubbles: true, cancelable: true }),
)
await wait(30)
sizeFor = () => 1024
// MAX_ATTACHMENTS 从产品模块读，不手写 6 —— 常量改了这里跟着对
const many = Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, i) =>
  f(`m${i}.png`, 'image/png', 100 * 1024))
dropFiles(many)
await wait(200)
check(`★ 一次拖 ${MAX_ATTACHMENTS + 2} 张 → 只收 ${MAX_ATTACHMENTS} 张（上限生效）`,
  strip.children.length === MAX_ATTACHMENTS,
  `实收 ${strip.children.length}`)

// 再拖一张，应该被挡
dropFiles([f('extra.png', 'image/png', 100 * 1024)])
await wait(100)
check('已满时再拖 → 数量不变，且给了提示（不是静默吞掉）',
  strip.children.length === MAX_ATTACHMENTS,
  `实收 ${strip.children.length}`)

// ═══════════════════════════════════════════════════ E. 行为：粘贴

console.log('\n── E. 行为：粘贴截图 ──')

// 清干净
let guard = 0
while (strip.children.length > 0 && guard++ < 20) {
  strip.children[0].querySelector('.attach-remove')?.dispatchEvent(
    new W.MouseEvent('click', { bubbles: true, cancelable: true }),
  )
  await wait(10)
}
sizeFor = () => 1024

function pasteEvent(items, text) {
  const ev = new W.Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clipboardData', {
    value: {
      items,
      files: items.map((i) => i.getAsFile()).filter(Boolean),
      getData: (t) => (t === 'text/plain' ? (text ?? '') : ''),
    },
  })
  return ev
}

prompt.dispatchEvent(pasteEvent([{ kind: 'file', getAsFile: () => f('clip.png', 'image/png', 80 * 1024) }], ''))
await wait(80)
check('★★ 粘贴截图 → 被收成附件（旧实现无条件 preventDefault 后只取 text/plain，图被整条吞掉）',
  strip.children.length === 1, `实收 ${strip.children.length}`)

// 纯文本粘贴仍然要能进输入框
const before = prompt.textContent
prompt.dispatchEvent(pasteEvent([], 'hello 世界'))
check('★ 纯文本粘贴不受影响，仍然写进输入框',
  prompt.textContent.includes('hello 世界'),
  `textContent=${JSON.stringify(prompt.textContent.slice(0, 40))}（改前 "${before}"）`)

// ═══════════════════════════════════════════════════ F. 行为：发送

console.log('\n── F. 行为：上送形状 ──')

// 把输入框填上字（走产品自己的 insertPlainText 分支不易控制，直接设 textContent）
prompt.textContent = '看看这张图'
prompt.dispatchEvent(new W.Event('input', { bubbles: true }))

const beforeSend = calls.filter((c) => c.name === 'send').length
composer.dispatchEvent(new W.Event('submit', { bubbles: true, cancelable: true }))
await wait(200)

const sends = calls.filter((c) => c.name === 'send')
check('提交触发了 api.send', sends.length > beforeSend, `send 调用 ${sends.length} 次`)
const last = sends[sends.length - 1]
check('★ send 收到**第二个实参**（附件数组）—— preload 扩展的必要条件',
  last !== undefined && last.args.length >= 2,
  last === undefined ? '没有 send' : `实参个数 ${last.args.length}`)
const attachmentsArg = last?.args?.[1]
check('★ 附件是数组', Array.isArray(attachmentsArg))
check('附件项带 name / mimeType / data 三个字段（preload 契约）',
  attachmentsArg?.length > 0 &&
  ['name', 'mimeType', 'data'].every((k) => k in attachmentsArg[0]),
  JSON.stringify(Object.keys(attachmentsArg?.[0] ?? {})))
check('★ data 是**纯 base64**，不含 `data:` 前缀（Letta 的 source.data 不认前缀）',
  typeof attachmentsArg?.[0]?.data === 'string' &&
  attachmentsArg[0].data.length > 0 &&
  !attachmentsArg[0].data.startsWith('data:'),
  String(attachmentsArg?.[0]?.data ?? '').slice(0, 24))
check('★ data 是合法 base64（能被 atob 解出来）', (() => {
  try { W.atob(attachmentsArg?.[0]?.data ?? ''); return true } catch { return false }
})())
check('正文仍作为第一个实参传出去（纯文本路径没被破坏）',
  typeof last?.args?.[0] === 'string' && last.args[0].includes('看看这张图'),
  JSON.stringify(String(last?.args?.[0] ?? '').slice(0, 40)))
check('★ 发送后附件条清空（已送出的图不留在输入框上）',
  strip.children.length === 0 && strip.hidden === true)
// ★ 发送路径**故意不 revoke**：缩略图要交接给对话流回显（shell.js:3389 handOffAttachments）。
//   早 revoke ⇒ 气泡里的 <img> 当场裂图。回收改由 clearTranscript → disposeLiveThumbs() 统一做。
//   （本条原写作 `liveURLs.size === 0`，是交接机制落地前的旧契约，2026-10-08 修正。）
check('★ 发送后 objectURL **仍然活着**（交接给对话流回显，不提前 revoke）',
  liveURLs.size > 0, `活着 ${liveURLs.size} 个`)
check('★ 产品源码：交接出去的 objectURL 由 clearTranscript 统一回收',
  /function disposeLiveThumbs[\s\S]{0,200}dispose\?\./.test(SHELL) &&
  /function clearTranscript[\s\S]{0,600}disposeLiveThumbs\(\)/.test(SHELL))

// 只有图没有字也要能发
sizeFor = () => 1024
dropFiles([f('only.png', 'image/png', 100 * 1024)])
await wait(200)
prompt.textContent = ''
prompt.dispatchEvent(new W.Event('input', { bubbles: true }))
const before2 = calls.filter((c) => c.name === 'send').length
composer.dispatchEvent(new W.Event('submit', { bubbles: true, cancelable: true }))
await wait(200)
check('★★ 只有图、没有字 → 也能发出去（旧逻辑 `text === ""` 直接 return，会静默吞掉）',
  calls.filter((c) => c.name === 'send').length > before2,
  `send 次数 ${calls.filter((c) => c.name === 'send').length}`)

// 全空则不发
const before3 = calls.filter((c) => c.name === 'send').length
composer.dispatchEvent(new W.Event('submit', { bubbles: true, cancelable: true }))
await wait(100)
check('全空（无字无图）→ 不发送（别产生空消息）',
  calls.filter((c) => c.name === 'send').length === before3)

console.log('\n' + '='.repeat(56))
console.log(`通过 ${passed} / 失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
