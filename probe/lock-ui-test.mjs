/**
 * 对话隐私锁 —— **渲染层**行为验证（真的跑 shell.js，不是复刻）。
 *
 * 为什么必须单开一个：`lock-test`（58 条）/`lock-flow-test`（59 条）/
 * `lock-wire-probe`（协议收发）全绿也证明不了「用户点得到」——
 * 它们要么验 host 模块、要么走 socket 直连。而这一次的缺口恰好全在球侧：
 * history.lock 分支没接、preload 没暴露 onLock、shell.js 里没有任何 lock 代码。
 * **host 全绿 + 球侧零代码 = 功能完全不可用**，这类「一半接上了」的
 * 中间态只有把真渲染层跑起来才看得见。
 *
 * ★★ 与既有 rename-inline-test 的根本区别：
 *   那个探针**复刻**了产品的渲染逻辑（它自己也承认「改产品时这里要跟着改」）。
 *    复刻的探针只能测「我理解的产品」，测不出「真实产品漏了什么」。
 *    这个探针**直接 import 真的 shell.js**、喂真的 floating.html，
 *    只把 `window.dshOrb` 换成记录型的 Proxy。
 *    ⇒ 产品里少了哪个 `api.onLock` 订阅、DOM 里少了哪个 id，
 *      这里都会在**装配阶段**就炸出来，而不是等断言去猜。
 *
 * ⚠️ 仍然测不到的（jsdom 没有布局引擎、没有合成器）：
 *    · 卡片实际落在哪、挡不挡球、暗亮主题下的对比度
 *    · 输入框能不能真的聚焦、光标在哪
 *    · 锁定行的虚线边框好不好看
 *    这些必须真机看一眼。
 *
 * 跑法：`node probe/lock-ui-test.mjs`
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

// ═══════════════════════════════════════════════════ 0. 装配 jsdom

/**
 * 用**真实的 floating.html**，不是手搭的骨架。
 * 手搭骨架会让「产品 HTML 里漏了某个 id」这类 bug 直接消失 ——
 * 而 `#lock-gate` / `#lock-input` 这些节点正是这次新增的、最容易漏的。
 */
const html = readFileSync(join(ASSETS, 'floating.html'), 'utf8')
const page = new JSDOM(html, {
  pretendToBeVisual: true,
  url: pathToFileURL(join(ROOT, 'helper', 'assets', 'floating.html')).href,
  // shell.js 会用 <script type="module"> 之外的方式被我们手动 import，
  // 这里把外部资源全关掉，只留 DOM。
  resources: undefined,
  runScripts: 'outside-only',
})
const W = page.window

// jsdom 不做 CSS 解析也不需要，但我们仍要读 CSS 文本做静态断言
const CSS = readFileSync(join(ASSETS, 'floating.css'), 'utf8')
const SHELL = readFileSync(join(ASSETS, 'shell.js'), 'utf8')
const HTML = html

// 把 DOM 全局塞给 shell.js 需要的那些名字
for (const key of [
  'window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent',
  'KeyboardEvent', 'FocusEvent', 'CustomEvent', 'CSS', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'DOMRect',
]) {
  if (W[key] !== undefined) globalThis[key] = W[key]
}
globalThis.window = W

/**
 * jsdom 缺的浏览器 API —— 补齐到「shell.js 能装配起来」的最低限度。
 *
 * ⚠️ 这些桩只补**环境**，不补产品逻辑。凡是产品要靠它决策的地方
 *    （例如 prefers-color-scheme），桩一律返回中性的值，
 *    免得探针替产品做了一次它自己没做的判断。
 */
if (typeof W.matchMedia !== 'function') {
  W.matchMedia = (query) => ({
    matches: false,
    media: String(query),
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false },
  })
}
// layout 引擎缺失 → 尺寸恒 0（这不是 bug，是 jsdom 的已知事实）。
// 铺开给所有元素，免得产品里 `offsetWidth` 读到 undefined 而走错分支。
if (typeof W.Element.prototype.getBoundingClientRect !== 'function' || true) {
  W.Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() { return this } }
  }
}
// resize-handles 会读这两项决定手柄布局 —— 打桩成 0，行为可预测
Object.defineProperty(W.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 0 } })
Object.defineProperty(W.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 0 } })
// 面板展开态靠它；给个可写的桩（产品会读也会写）
W.Element.prototype.setPointerCapture = function () {}
W.Element.prototype.releasePointerCapture = function () {}
W.Element.prototype.hasPointerCapture = function () { return false }
if (typeof W.PointerEvent !== 'function') W.PointerEvent = W.MouseEvent
if (typeof W.ResizeObserver !== 'function') {
  W.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
}
if (typeof W.requestIdleCallback !== 'function') W.requestIdleCallback = (fn) => W.setTimeout(fn, 0)

// ═══════════════════════════════════════════════════ 1. 记录型 API 桩

/**
 * ★ 用 Proxy 自动应答**所有** api 方法，而不是手写一份清单。
 *   踩过两次的教训：手写清单天然会漏（漏过 `onBlockDrop`、漏过 `onDeco`），
 *   而漏掉的那个订阅在探针里就是「产品调了但没人接」→ 假绿。
 *   Proxy 让「产品新加了哪个 api 方法」永远不会变成探针的维护负担。
 */
const calls = []
/** 各 `on*` 回调的注册表：{ onLock: [fn], ... } */
const subscribers = {}
/** host → 球 的推送模拟器 */
function push(channel, payload) {
  for (const fn of subscribers[channel] ?? []) fn(payload)
}

const api = new Proxy(
  {},
  {
    get(_t, prop) {
      const name = String(prop)
      // `on*` 一律当订阅注册器：记住回调，返回取消函数
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
      // 其余一律当命令：记录调用、返回 Promise（有些调用会被 await）
      return (...args) => {
        calls.push({ name, args })
        return Promise.resolve(undefined)
      }
    },
  },
)

W.dshOrb = api
globalThis.dshOrb = api

// ═══════════════════════════════════════════════════ 2. 装配真 shell.js

console.log('── 0. 装配：真的跑一遍 shell.js ──')

let bootError = null
try {
  // 动态 import 真实产品文件。它模块底部会自己调 main()。
  await import(new URL('../helper/assets/shell.js', import.meta.url).href)
} catch (err) {
  bootError = err
}
check('★ shell.js 能在真 HTML 上装配成功（不抛）', bootError === null,
  bootError === null ? '' : `${bootError.name}: ${bootError.message}`)

/** 装配失败就没必要继续跑后面 —— 全部会连锁红，看不出真因。 */
if (bootError !== null) {
  console.log('\n' + '='.repeat(56))
  console.log(`通过 ${passed} / 失败 ${failed}`)
  console.log('装配就炸了，后面的断言没有意义，提前退出。')
  process.exit(1)
}

const doc = W.document
const gate = doc.querySelector('#lock-gate')
const lockInput = doc.querySelector('#lock-input')
const lockSubmit = doc.querySelector('#lock-submit')
const lockFeedback = doc.querySelector('#lock-feedback')
const lockTitle = doc.querySelector('#lock-title')
const lockExport = doc.querySelector('#lock-export')

// ═══════════════════════════════════════════════════ 3. DOM 与订阅存在性

console.log('\n── 1. 节点与订阅：产品里到底有没有这些东西 ──')

check('HTML 里有 #lock-gate（解锁卡容器）', gate !== null)
check('HTML 里有 #lock-input', lockInput !== null)
check('HTML 里有 #lock-submit', lockSubmit !== null)
check('HTML 里有 #lock-feedback', lockFeedback !== null)
check('HTML 里有 #lock-title', lockTitle !== null)
check('HTML 里有 #lock-export（强锁逃生通道）', lockExport !== null)

check('★ shell.js 订阅了 api.onLock（进锁的唯一入口）',
  (subscribers.onLock ?? []).length > 0,
  `实际订阅数 ${(subscribers.onLock ?? []).length}`)
check('★ shell.js 订阅了 api.onLockFeedback', (subscribers.onLockFeedback ?? []).length > 0)
check('shell.js 订阅了 api.onSoftAgreement', (subscribers.onSoftAgreement ?? []).length > 0)

// ═══════════════════════════════════════════════════ 4. 历史遮罩（软锁）

console.log('\n── 2. 历史遮罩：锁定时标题绝不能露 ──')

/** 喂一份历史列表（含 2 条明文 + 1 条已锁）。 */
push('onHistory', [
  { sessionId: 'conv-a', title: '关于梦境的那次长谈' },
  { sessionId: 'conv-b', title: '她第一次叫我名字' },
  { sessionId: 'conv-locked', title: '', locked: true, kind: 'strong' },
])

// 打开历史抽屉会触发 renderHistory（setHistoryOpen(true) → renderHistory）
const historyBtn = doc.querySelector('#history')
historyBtn?.dispatchEvent(new W.MouseEvent('click', { bubbles: true }))

const rows = [...doc.querySelectorAll('.history-row')]
check('历史列表渲染出了 3 行', rows.length === 3, `实际 ${rows.length}`)

const lockedRow = doc.querySelector('.history-row[data-session-id="conv-locked"]')
check('已锁条目带 data-locked="true"', lockedRow?.dataset.locked === 'true')
check('★ 已锁条目带 .locked 类（走占位行样式）', lockedRow?.classList.contains('locked') === true)
check('★ 已锁条目**不显示标题**',
  lockedRow !== null && !lockedRow.textContent.includes('她第一次') && !lockedRow.textContent.includes('长谈'))
check('★ 已锁条目显示占位文案（「已锁定的对话」）',
  lockedRow !== null && /已锁定|Locked/.test(lockedRow.textContent ?? ''),
  lockedRow?.textContent ?? '')
check('已锁条目里有小锁图标（.lock-icon）', lockedRow?.querySelector('.lock-icon') !== null)
check('明文条目**照常显示标题**',
  doc.querySelector('.history-row[data-session-id="conv-a"]')?.textContent === '关于梦境的那次长谈')

// ═══════════════════════════════════════════════════ 5. 进锁 → 卡片出现

console.log('\n── 3. 超时软锁：host 主动推时球要弹卡 ──')

check('进锁前卡片是收着的', gate?.hidden === true)

push('onLock', { state: 'locked', kind: 'soft', attemptsLeft: 5, hasAgreement: true })

check('★ 收到 lock(soft) 后卡片显示', gate?.hidden === false)
check('卡片走了软锁文案', /暗号/.test(lockTitle?.textContent ?? ''), lockTitle?.textContent ?? '')
check('软锁时**不显示**导出按钮（导出只给强锁）', lockExport?.hidden === true)
check('输入框可用（有暗号可对）', lockInput?.disabled === false)

// ═══════════════════════════════════════════════════ 6. 提交一次尝试

console.log('\n── 4. 提交尝试：原文交出去、本地不留 ──')

calls.length = 0
if (lockInput) lockInput.value = '小饼干'
lockSubmit?.dispatchEvent(new W.MouseEvent('click', { bubbles: true }))

const unlockCall = calls.find((c) => c.name === 'unlock')
check('★ 点「解锁」调了 api.unlock', unlockCall !== undefined,
  calls.map((c) => c.name).join(',') || '(没有任何调用)')
check('★ 原文原样交给 host', unlockCall?.args?.[0] === '小饼干', String(unlockCall?.args?.[0]))
check('★ 提交后输入框立即清空（不留原文）', lockInput?.value === '')

// 失败反馈
push('onLockFeedback', { ok: false, kind: 'soft', attemptsLeft: 4, message: '再想想？' })
check('失败反馈显示出来了', lockFeedback?.hidden === false)
check('失败反馈用了 host 给的那句话', lockFeedback?.textContent === '再想想？',
  lockFeedback?.textContent ?? '')
check('失败后卡片仍然开着（还有机会）', gate?.hidden === false)

// ═══════════════════════════════════════════════════ 7. 无暗号时的护栏

console.log('\n── 5. 没有暗号可对时：不能给一个假装能用的输入框 ──')

push('onLock', { state: 'locked', kind: 'soft', attemptsLeft: 5, hasAgreement: false })
check('★ 未约暗号时输入框被禁用', lockInput?.disabled === true)
check('★ 未约暗号时提交按钮被禁用', lockSubmit?.disabled === true)
check('文案说明了「还没约过暗号」', /还没约|never agreed/.test(doc.querySelector('#lock-detail')?.textContent ?? ''),
  doc.querySelector('#lock-detail')?.textContent ?? '')

// 取消暗号的状态标记要能纠正这个判断
push('onSoftAgreement', { state: 'set' })
check('收到 soft-agreement(set) 后输入框恢复可用', lockInput?.disabled === false)

// ═══════════════════════════════════════════════════ 8. 强锁

console.log('\n── 6. 强锁：密码框 + 逃生通道 ──')

push('onLock', { state: 'locked', kind: 'strong', convId: 'conv-locked', attemptsLeft: 5 })
// 标题要能让人一眼知道「这里要输密码」—— 只说「锁着」不够，
// 用户会去找暗号。中英文都接受。
check('强锁标题/详情提到密码', /密码|password/i.test(
  `${lockTitle?.textContent ?? ''} ${doc.querySelector('#lock-detail')?.textContent ?? ''}`),
  `${lockTitle?.textContent ?? ''} / ${doc.querySelector('#lock-detail')?.textContent ?? ''}`)
check('★ 强锁时才显示「导出对话」逃生按钮', lockExport?.hidden === false)
check('强锁输入框可用', lockInput?.disabled === false)

calls.length = 0
if (lockInput) lockInput.value = 'hunter2'
lockSubmit?.dispatchEvent(new W.MouseEvent('click', { bubbles: true }))
const strongCall = calls.find((c) => c.name === 'unlock')
check('★ 强锁提交带上了 convId（host 才知道解哪一条）',
  strongCall?.args?.[1] === 'conv-locked', String(strongCall?.args?.[1]))

// 逃生通道
calls.length = 0
lockExport?.dispatchEvent(new W.MouseEvent('click', { bubbles: true }))
const exportCall = calls.find((c) => c.name === 'conversationAction')
check('★ 点导出走 conversationAction(history.export)',
  exportCall?.args?.[0] === 'history.export', String(exportCall?.args?.[0]))

// ═══════════════════════════════════════════════════ 9. 解锁 → 收卡

console.log('\n── 7. 解锁成功：卡片收掉、历史恢复 ──')

push('onLock', { state: 'unlocked', kind: 'strong' })
check('★ 收到 unlocked 后卡片收起', gate?.hidden === true)

push('onHistory', [
  { sessionId: 'conv-a', title: '关于梦境的那次长谈' },
  { sessionId: 'conv-locked', title: '她第一次叫我名字' },
])
const lockedRow2 = doc.querySelector('.history-row[data-session-id="conv-locked"]')
check('★ 解锁后标题恢复显示', lockedRow2?.textContent === '她第一次叫我名字',
  lockedRow2?.textContent ?? '')
check('解锁后不再带 .locked 类', lockedRow2?.classList.contains('locked') !== true)

// ═══════════════════════════════════════════════════ 10. 设密码卡（needPassword）

console.log('\n── 8. 上锁被拒（还没设密码）→ 弹设置卡，而不是死路一条 ──')

calls.length = 0
// 模拟用户点菜单上锁 → host 回 needPassword
push('onConversationAction', {
  action: 'history.lock', sessionId: 'conv-a', ok: false, needPassword: true,
  error: '要先用「设置密码」定一个强锁密码',
})
check('★ 收到 needPassword 后弹出设置卡', gate?.hidden === false)
check('设置卡文案讲的是「定密码」', /密码/.test(lockTitle?.textContent ?? ''), lockTitle?.textContent ?? '')
check('设置卡里给了知情告知', /忘了|forget/i.test(lockFeedback?.textContent ?? ''),
  lockFeedback?.textContent ?? '')

calls.length = 0
if (lockInput) lockInput.value = 'my-secret'
lockSubmit?.dispatchEvent(new W.MouseEvent('click', { bubbles: true }))
const setPwCall = calls.find((c) => c.name === 'conversationAction' && c.args?.[0] === 'history.set-password')
check('★ 提交后走 history.set-password', setPwCall !== undefined,
  calls.map((c) => `${c.name}(${c.args?.[0] ?? ''})`).join(',') || '(无)')
check('★ 密码原样交给 host', setPwCall?.args?.[1]?.password === 'my-secret')

// 设密码成功 → 自动补一次上锁
calls.length = 0
push('onConversationAction', { action: 'history.set-password', sessionId: 'conv-a', ok: true })
const autoLock = calls.find((c) => c.name === 'conversationAction' && c.args?.[0] === 'history.lock')
check('★ 设密码成功后自动补一次上锁（不该只定不上）', autoLock !== undefined,
  calls.map((c) => `${c.name}(${c.args?.[0] ?? ''})`).join(',') || '(无)')
check('自动上锁带的是同一条会话', autoLock?.args?.[1]?.sessionId === 'conv-a')
check('设置卡已收起', gate?.hidden === true)

// ═══════════════════════════════════════════════════ 11. 反向对照

console.log('\n── 9. 反向对照：这些断言必须能抓到「球侧没接」 ──')

{
  // 模拟 2026-10-07 之前的真实状态：shell.js 里没有任何 lock 代码。
  // ⚠️ 不能只删 `api.onLock(` 那一行（那只证明一行），要证明**整块缺失会被抓到**。
  const noLock = SHELL
    .replace(/\s*if \(typeof api\.onLock === 'function'\) \{[\s\S]*?\n  \}/, '\n')
    .replace(/\s*if \(typeof api\.onLockFeedback === 'function'\) \{[\s\S]*?\n  \}/, '\n')
  check('（对照）删掉 onLock / onLockFeedback 订阅后，订阅断言会红',
    !/api\.onLock\s*\(/.test(noLock) && !/api\.onLockFeedback\s*\(/.test(noLock),
    '对照失效 —— 说明订阅断言抓不住「球侧没接」')
}
{
  // 模拟「占位行照抄了标题」这个最危险的实现错误。
  const leaky = SHELL.replace(
    /function renderLockedRow\(button, item\) \{[\s\S]*?\n  \}/,
    (m) => m.replace(/label\.textContent = messages\.lockRowLabel/, 'label.textContent = item.title'),
  )
  check('（对照）把占位行改成渲染真实标题后，遮罩断言会红',
    /label\.textContent = item\.title/.test(leaky) && leaky !== SHELL,
    '对照失效 —— 说明「不露标题」这条断言抓不住泄密实现')
}
{
  // 模拟 preload 没暴露 onLock —— 这是「静默丢弃」的另一半。
  const PRELOAD = readFileSync(join(ROOT, 'helper', 'preload.cjs'), 'utf8')
  const noOnLock = PRELOAD.replace(/\s*onLock\(callback\) \{[\s\S]*?\n  \},/, '')
  check('（对照）preload 删掉 onLock 暴露后能检出',
    !/onLock\(callback\)/.test(noOnLock) && noOnLock !== PRELOAD,
    '对照失效 —— preload 侧的缺失没被覆盖')
}

// ═══════════════════════════════════════════════════ 12. 主线分发分支（跨文件）

console.log('\n── 10. 跨文件：主进程与 preload 的对应项都在 ──')

const MAIN = readFileSync(join(ROOT, 'helper', 'lib', 'main.js'), 'utf8')
const PRELOAD = readFileSync(join(ROOT, 'helper', 'preload.cjs'), 'utf8')
const HOSTMAIN = readFileSync(join(ROOT, 'src', 'main.mjs'), 'utf8')

check('★ 主进程 dispatchRecord 有 lock 分支',
  /\n\tif \(record\.type === "lock"\) \{/.test(MAIN))
check('★ 主进程 dispatchRecord 有 lock-feedback 分支',
  /\n\tif \(record\.type === "lock-feedback"\) \{/.test(MAIN))
check('主进程 dispatchRecord 有 soft-agreement 分支',
  /\n\tif \(record\.type === "soft-agreement"\) \{/.test(MAIN))
check('★ 主进程有 orb:lock-action 上行通道（球 → host）',
  /ipcMain\.on\("orb:lock-action"/.test(MAIN))
check('preload 暴露了 unlock(', /\n  unlock\(input, convId\) \{/.test(PRELOAD))
check('preload 暴露了 lockNow(', /\n  lockNow\(\) \{/.test(PRELOAD))
check('preload 暴露了 onLock(', /\n  onLock\(callback\) \{/.test(PRELOAD))
check('★ preload 的 conversationAction **原样透传** payload（白名单会静默丢 password）',
  /conversationAction\(action, payload\) \{\s*ipcRenderer\.send\('orb:conversation-action', \{ action, payload: payload \?\? \{\} \}\)/.test(PRELOAD))
check('★ host 侧 history.lock 不再返回「还没接上」占位',
  !/锁定功能还没接上/.test(HOSTMAIN))
check('★ host 侧 history.lock 会先查 hasStrongPassword（没密码不许上锁）',
  /action === 'history\.lock'[\s\S]{0,1400}?hasStrongPassword/.test(HOSTMAIN))
check('host 侧新增了 history.set-password 分支',
  /action === 'history\.set-password'/.test(HOSTMAIN))
check('host 侧新增了 history.export 分支',
  /action === 'history\.export'/.test(HOSTMAIN))
check('主进程 conversation-action 白名单放行了 set-password',
  /action !== "history\.set-password"/.test(MAIN))
check('主进程 conversation-action-result 转发了 path（导出落点）',
  /path: typeof record\.path === "string"/.test(MAIN))

// ═══════════════════════════════════════════════════ 13. CSS 静态断言

console.log('\n── 11. CSS：占位行与卡片的样式契约 ──')

check('CSS 有 .history-row.locked 规则', /\.history-row\.locked\s*\{/.test(CSS))
check('CSS 有 .lock-icon 规则', /\.lock-icon\s*\{/.test(CSS))
check('CSS 有 .lock-card 规则', /\.lock-card\s*\{/.test(CSS))
check('CSS 有 #lock-gate[hidden] 的 display:none', /#lock-gate\[hidden\]/.test(CSS))
check('★ CSS 里锁卡不抢 z-index 梯队（不写 z-index）',
  !/#lock-gate[^{]*\{[^}]*z-index/.test(CSS))
check('历史抽屉打开时锁卡让位（body.history-open #lock-gate）',
  /body\.history-open\s*#lock-gate/.test(CSS))

// ═══════════════════════════════════════════════════ 汇总

console.log('\n' + '='.repeat(56))
console.log(`通过 ${passed} / 失败 ${failed}`)
console.log('='.repeat(56))
console.log('')
console.log('⚠️ 探针验的是「链路通、分支在、DOM 有」。以下必须真机看：')
console.log('   · 锁卡实际落在哪、会不会压住球或输入框')
console.log('   · 暗亮两套主题下卡片与虚线行框的对比度')
console.log('   · 输入框真机能否聚焦、中文输入法回车不误提交')
console.log('   · 超时锁到点时球是否真的主动弹卡（桩推 ≠ 真 host 推）')
process.exit(failed === 0 ? 0 : 1)
