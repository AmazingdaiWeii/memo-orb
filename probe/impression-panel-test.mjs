/**
 * 探针：记忆中心面板（P0-7「我们的回忆」）。
 *
 * ## 验什么、不验什么
 *
 * host 侧六条协议早已实现且有实测记录（`记忆中心_落地方案.md` §〇），
 * 这里**不重复验 host**，只验渲染层这一层新写的：
 *   - 五类下行消息分派正确（`impression` / `-history` / `-at` / `-result`）
 *   - loading / 空 / 出错三种状态互不串味
 *   - ★ 正文与 commit subject 一律 `textContent`（XSS 回归）
 *   - 与历史面板互斥，且不会无限互调
 *   - 频率只认三档
 *
 * ## ⚠️ jsdom 没有布局引擎
 *
 * `getBoundingClientRect` / `offsetWidth` 恒为 0，本探针不碰几何。
 *
 * 用法：node probe/impression-panel-test.mjs
 */

import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 从真实的 floating.html 里抽出 #impression 那段 DOM。
 *
 * ⚠️ 不这么做就会在探针里另抄一份 HTML —— 那样探针绿了不代表产品能用。
 * 「探针与产品结构漂移」是本项目吃过的暗亏（见 MEMORY.md「探针断言路径要与产品一致」）。
 */
const html = readFileSync(join(ROOT, 'helper', 'assets', 'floating.html'), 'utf8')
const match = html.match(/<section id="impression"[\s\S]*?<\/section>/)
if (match === null) {
  console.error('FAIL 抽不出 #impression 段 —— floating.html 结构变了？')
  process.exit(1)
}

const page = new JSDOM(
  `<!doctype html><html><body><section id="panel"><div id="history-list"></div>${match[0]}</section></body></html>`,
  { pretendToBeVisual: true },
)
const W = page.window
for (const key of ['document', 'HTMLElement', 'Element', 'Event', 'Node', 'CustomEvent']) {
  globalThis[key] = W[key]
}
Object.defineProperty(globalThis, 'window', { value: W, configurable: true })

const { createImpressionPanel } = await import('../helper/assets/impression-panel.js')

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS ${name}`) }
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` —— ${detail}` : ''}`) }
}

const q = (sel) => W.document.querySelector(sel)
const root = q('#impression')
const bodyEl = q('#impression-body')
const emptyEl = q('#impression-empty')
const metaEl = q('#impression-meta')
const warnEl = q('#impression-warn')
const refreshBtn = q('#impression-refresh')
const scheduleSelect = q('#impression-schedule')
const historyBox = q('#impression-history')
const historyList = q('#impression-history-list')
const atBox = q('#impression-at')
const atBody = q('#impression-at-body')

/** 建一个面板 + 记录上行消息 + 记录打开菜单的请求。 */
function mount() {
  const sent = []
  const picked = []
  const panel = createImpressionPanel({
    send: (action, extra) => sent.push({ action, ...(extra ?? {}) }),
    isZh: () => true,
    translate: (key) => ({ impressionTitle: '她眼中的你' })[key] ?? key,
    setExclusiveOpen: (who) => { sent.push({ action: '__exclusive', who }) },
    // 频率菜单交给外层（产品里是 contextMenu.open），这里只记录请求
    openPicker: (spec) => { picked.push(spec) },
  })
  return { panel, sent, picked }
}

// ── 1. 初始状态：收起、不显示任何正文 ─────────────────────────────────
{
  const { panel } = mount()
  check('初始收起（hidden）', root.hidden === true)
  check('初始不显示正文', bodyEl.textContent === '')
  check('isOpen 初始为 false', panel.isOpen() === false)
}

// ── 2. 打开 → 上行 get、标题上词条 ────────────────────────────────────
{
  const { panel, sent } = mount()
  panel.setOpen(true)
  check('打开后 hidden=false', root.hidden === false)
  check('打开时上行 get', sent.some((m) => m.action === 'get'),
    JSON.stringify(sent))
  check('打开时通知外部互斥', sent.some((m) => m.action === '__exclusive' && m.who === 'impression'))
  check('标题用的是词条不是 key', q('#impression-title').textContent === '她眼中的你',
    q('#impression-title').textContent)
}

// ── 3. ★ loading / 正文 / 空 / 出错 四态互不串味 ──────────────────────
{
  const { panel } = mount()
  panel.setOpen(true)

  panel.onPayload({ type: 'impression', loading: true })
  check('loading：显示「正在读」，正文清空',
    emptyEl.hidden === false && bodyEl.textContent === '' &&
    emptyEl.textContent === 'impressionLoading',
    `empty=${emptyEl.textContent} body="${bodyEl.textContent}"`)

  panel.onPayload({ type: 'impression', ok: true, exists: true, text: '她觉得你挺有意思的。', updatedAgo: '2 分钟前', everyHours: 24 })
  check('有正文：显示正文、藏空态',
    emptyEl.hidden === true && bodyEl.textContent === '她觉得你挺有意思的。',
    `body="${bodyEl.textContent}"`)

  panel.onPayload({ type: 'impression', ok: true, exists: false, text: '', seededOnly: true, everyHours: 24 })
  check('只有种子：给「已建好但还是空的」',
    emptyEl.hidden === false && bodyEl.textContent === '' &&
    emptyEl.textContent === 'impressionEmpty',
    emptyEl.textContent)

  panel.onPayload({ type: 'impression', ok: true, exists: false, text: '', seededOnly: false, everyHours: 24 })
  check('连种子都没有：给「还没有印象文件」',
    emptyEl.hidden === false && emptyEl.textContent === 'impressionMissing',
    emptyEl.textContent)

  panel.onPayload({ type: 'impression', ok: false, error: '还没有 agent', text: null })
  check('出错：给可读原因、不留旧正文',
    emptyEl.hidden === false && bodyEl.textContent === '' &&
    emptyEl.textContent.includes('还没有 agent'),
    emptyEl.textContent)
}

// ── 4. ★ 正文是模型写的不可信内容 —— 绝不能当 HTML 解析 ───────────────
{
  const { panel } = mount()
  panel.setOpen(true)
  const evil = '<img src=x onerror="globalThis.__pwned=1"><script>globalThis.__pwned=2</script>'
  panel.onPayload({ type: 'impression', ok: true, exists: true, text: evil, everyHours: 24 })
  check('恶意正文原样显示为文本', bodyEl.textContent === evil)
  check('★ 没有生成任何元素（未被当 HTML 解析）',
    bodyEl.querySelectorAll('img, script').length === 0,
    `生成了 ${bodyEl.querySelectorAll('img, script').length} 个`)
  check('★ 没有执行脚本', globalThis.__pwned === undefined,
    `__pwned=${globalThis.__pwned}`)
}

// ── 5. 元信息与警告 ──────────────────────────────────────────────────
{
  const { panel } = mount()
  panel.setOpen(true)
  panel.onPayload({
    type: 'impression',
    ok: true, exists: true, text: 'x', updatedAgo: '2 分钟前',
    everyHours: 24, nextDueAt: '2026-10-09T04:00:00.000Z',
  })
  check('元信息含更新时间与下次时间',
    metaEl.textContent.includes('2 分钟前') && metaEl.textContent.includes('impressionNext'),
    metaEl.textContent)

  panel.onPayload({ type: 'impression', ok: true, exists: true, text: 'x', everyHours: 0 })
  check('频率为 0 时明说「已关闭」',
    metaEl.textContent.includes('impressionOff'), metaEl.textContent)

  panel.onPayload({
    type: 'impression', ok: true, exists: true, text: 'x',
    everyHours: 24, historyStale: true, lastError: '印象文件格式不合法，已尝试自动修复',
  })
  check('警告：stale + lastError 都上屏、给的是人话',
    warnEl.hidden === false &&
    warnEl.textContent.includes('impressionStale') &&
    warnEl.textContent.includes('格式不合法'),
    warnEl.textContent)

  panel.onPayload({ type: 'impression', ok: true, exists: true, text: 'x', everyHours: 24 })
  check('警告消失时会收起', warnEl.hidden === true, warnEl.textContent)
}

// ── 6. ★ 手动触发：防连点、回执、频率关时禁用 ──────────────────────────
{
  const { panel, sent } = mount()
  panel.setOpen(true)
  panel.onPayload({ type: 'impression', ok: true, exists: true, text: 'x', everyHours: 24 })

  refreshBtn.dispatchEvent(new W.Event('click'))
  check('点一下上行 refresh', sent.filter((m) => m.action === 'refresh').length === 1)
  check('等待期按钮禁用', refreshBtn.disabled === true)
  check('等待期按钮文案变了', refreshBtn.textContent === 'impressionRefreshing',
    refreshBtn.textContent)

  refreshBtn.dispatchEvent(new W.Event('click'))
  check('等待期再点不重复触发（防连点）',
    sent.filter((m) => m.action === 'refresh').length === 1,
    `实际 ${sent.filter((m) => m.action === 'refresh').length} 次`)

  panel.onPayload({ type: 'impression-result', ok: false, error: '上一次触发还在进行中' })
  check('失败回执：解锁按钮 + 显示原因',
    refreshBtn.disabled === false &&
    emptyEl.hidden === false &&
    emptyEl.textContent.includes('上一次触发还在进行中'),
    emptyEl.textContent)

  // 频率关着的时候不该让用户点「重新总结」——点了必然被判成条件不满足
  panel.onPayload({ type: 'impression', ok: true, exists: true, text: 'x', everyHours: 0 })
  check('频率=0 时按钮变成「先打开频率」',
    refreshBtn.textContent === 'impressionRefreshDisabled',
    refreshBtn.textContent)

  // loading 包不能把 refreshing 清掉 —— 回执还没到
  panel.onPayload({ type: 'impression', ok: true, exists: true, text: 'x', everyHours: 24 })
  refreshBtn.dispatchEvent(new W.Event('click'))
  check('重新触发后回到等待态', refreshBtn.disabled === true)
  panel.onPayload({ type: 'impression', loading: true })
  check('★ loading 包不清掉等待态（回执还没到）', refreshBtn.disabled === true,
    `disabled=${refreshBtn.disabled}`)
  panel.onPayload({ type: 'impression', ok: true, exists: true, text: 'x', everyHours: 24 })
  check('★ 带数据的那包才解锁', refreshBtn.disabled === false,
    `disabled=${refreshBtn.disabled}`)
}

// ── 7. 频率选择：自绘按钮 + 复用右键菜单（2026-10-07 从原生<select> 换来）──
{
  const { panel, sent, picked } = mount()
  panel.setOpen(true)

  // 点按钮 → 交给外层菜单（openPicker），三档带正确的 id / label / checked
  scheduleSelect.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true }))
  check('点频率按钮会请求打开菜单', picked.length === 1, `实际 ${picked.length} 次`)
  const ids = (picked[0]?.items ?? []).map((i) => i.id)
  check('菜单只有 24 / 168 / 0 三档',
    JSON.stringify(ids) === JSON.stringify(['24', '168', '0']),
    JSON.stringify(ids))
  const labels = (picked[0]?.items ?? []).map((i) => i.label)
  check('三档都有中文标签',
    JSON.stringify(labels) === JSON.stringify(['每天一次', '每周一次', '已关闭']),
    JSON.stringify(labels))

  panel.onPayload({ type: 'impression', ok: true, exists: true, text: 'x', everyHours: 168 })
  check('按钮文字反映 host 来的频率',
    scheduleSelect.textContent.includes('每周一次'), scheduleSelect.textContent)
  check('按钮带data.hours 供外部定位', scheduleSelect.dataset.hours === '168',
    scheduleSelect.dataset.hours)

  // 模拟用户在菜单里点「已关闭」—— onPick 由面板提供
  const before = sent.length
  picked[0].onPick('0')
  check('改频率真的上行',
    sent.slice(before).some((m) => m.action === 'schedule' && m.everyHours === 0),
    JSON.stringify(sent.filter((m) => m.action === 'schedule')))
  check('点完立刻改按钮文字，不等 host 回包',
    scheduleSelect.textContent.includes('已关闭'), scheduleSelect.textContent)

  // 脏值不能上行（防NaN 进协议）
  const n2 = sent.length
  picked[0].onPick('abc')
  check('非法档位不上行', sent.length === n2, `多出 ${sent.length - n2} 条`)
}

// ── 7b. ★ 原生 <select> 不能再出现（2026-10-07 用户截图：菜单一片空白）──
//
// 原生下拉的弹出列表是 OS 绘制的非客户区，暗色主题下选项继承浅色字、
// 落在白色弹出底上 → 「只有 hover 才看得见」。已换成自绘按钮。
// 这条防回归：别哪天又手痒改回 <select>。
{
  check('频率控件不是原生 <select>',
    scheduleSelect.tagName === 'BUTTON', `实际 <${scheduleSelect.tagName.toLowerCase()}>`)
  check('页面里没有任何 <select>',
    W.document.querySelectorAll('select').length === 0,
    `${W.document.querySelectorAll('select').length} 个`)
  check('频率控件声明了 aria-haspopup',
    scheduleSelect.getAttribute('aria-haspopup') === 'menu',
    String(scheduleSelect.getAttribute('aria-haspopup')))
}

// ── 8. 历史版本：懒加载 + 点某版读那一版 ─────────────────────────────
{
  const { panel, sent } = mount()
  panel.setOpen(true)
  check('历史版本默认收起', historyBox.open === false)
  panel.onPayload({ type: 'impression-history', ok: true, commits: [{ sha: 'abc1234', date: '2026-10-06T04:00:00.000Z', subject: '印象整理' }] })
  check('没展开就不该收到历史（懒加载）',
    sent.filter((m) => m.action === 'history-get').length === 0)

  // 展开 → 才上行要数据
  historyBox.open = true
  historyBox.dispatchEvent(new W.Event('toggle'))
  check('展开后才上行 history-get',
    sent.filter((m) => m.action === 'history-get').length === 1,
    JSON.stringify(sent.filter((m) => m.action === 'history-get')))

  check('commit 行已渲染', historyList.querySelectorAll('.impression-commit').length === 1)

  // 再展开不该重复要（historyRequested 幂等）
  historyBox.dispatchEvent(new W.Event('toggle'))
  check('重复展开不重复要数据',
    sent.filter((m) => m.action === 'history-get').length === 1,
    `实际 ${sent.filter((m) => m.action === 'history-get').length}`)

  historyList.querySelector('.impression-commit').dispatchEvent(new W.Event('click'))
  check('点某版 → 上行 at-get 且带 sha',
    sent.some((m) => m.action === 'at-get' && m.sha === 'abc1234'),
    JSON.stringify(sent.filter((m) => m.action === 'at-get')))
  check('点某版 → 展开那一版的框', atBox.hidden === false)

  panel.onPayload({ type: 'impression-at', ok: true, text: '那时候她觉得…', date: '2026-10-06T04:00:00.000Z' })
  check('那一版正文显示出来', atBody.textContent === '那时候她觉得…', atBody.textContent)

  q('#impression-at-back').dispatchEvent(new W.Event('click'))
  check('「收起」把那一版折回去', atBox.hidden === true)
}

// ── 9. ★ commit subject 同样按不可信内容处理 ──────────────────────────
{
  const { panel } = mount()
  panel.setOpen(true)
  const evil = '<img src=x onerror="globalThis.__pwned2=1">'
  panel.onPayload({ type: 'impression-history', ok: true, commits: [{ sha: 'a', date: '2026-10-06T04:00:00.000Z', subject: evil }] })
  check('恶意 subject 原样为文本',
    historyList.querySelector('.impression-commit-subject').textContent === evil)
  check('★ subject 里没有元素',
    historyList.querySelectorAll('img').length === 0)
}

// ── 10. 历史为空 / 读失败 ─────────────────────────────────────────────
{
  const { panel } = mount()
  panel.setOpen(true)
  panel.onPayload({ type: 'impression-history', ok: true, commits: [] })
  check('空历史给提示而不是空白',
    historyList.textContent.includes('impressionHistoryEmpty'),
    historyList.textContent)

  panel.onPayload({ type: 'impression-history', ok: false, commits: [], error: 'git 不可用' })
  check('历史读失败给原因',
    historyList.textContent.includes('git 不可用'), historyList.textContent)

  panel.onPayload({ type: 'impression-at', ok: false, error: '对象不存在' })
  check('单版读失败给原因',
    atBody.textContent.includes('对象不存在'), atBody.textContent)
}

// ── 11. ★ 互斥不无限互调 ─────────────────────────────────────────────
// setOpen(false) → setExclusiveOpen → 外部调 setHistoryOpen(false)
// → 又回调 setOpen(false)。没有幂等守卫就是栈溢出。
{
  const { panel, sent } = mount()
  panel.setOpen(true)
  panel.setOpen(true)
  check('重复 setOpen(true) 只上行一次 get',
    sent.filter((m) => m.action === 'get').length === 1,
    `实际 ${sent.filter((m) => m.action === 'get').length} 次`)
  check('重复 setOpen(true) 只通知一次互斥',
    sent.filter((m) => m.action === '__exclusive').length === 1,
    `实际 ${sent.filter((m) => m.action === '__exclusive').length} 次`)

  sent.length = 0
  panel.setOpen(false)
  panel.setOpen(false)
  check('★ 关闭方向同样幂等（无递归爆栈）',
    sent.filter((m) => m.action === '__exclusive').length === 0,
    `实际 ${sent.filter((m) => m.action === '__exclusive').length} 次`)
  check('关闭后 hidden=true', root.hidden === true)
}

// ── 12. ★★ 真实互调：打开记忆中心不能被自己关掉 ────────────────────────
//
// 上面第 11 组用 stub 测递归，**抓不到真 bug** —— stub 只记一条日志，
// 不会真的回调 `setOpen(false)`。而线上真实的双向互斥是：
//
//   impressionPanel.setOpen(true)   （shell.js: handleMenuAction）
//     → setExclusiveOpen('impression')
//       → setHistoryOpen(false)        （shell.js）
//         → if (!historyOpen) impressionPanel.setOpen(false)← 无条件回调
//
// 如果 `setOpen` 先把 `open = true` 落账再调互斥，上面最后一行看到的
// `open` 已经是 `true`，`setOpen(false)` 的幂等守卫挡不住 → 面板开一下就没。
// 这是 2026-10-07 修掉的真 bug，**必须有这条回归**。
{
  const sent = []
  const panel = createImpressionPanel({
    send: (action, extra) => sent.push({ action, ...(extra ?? {}) }),
    isZh: () => true,
    translate: (key) => key,
    // 复刻 shell.js 的真实接线：外部无条件回调 setOpen(false)
    setExclusiveOpen: (who) => {
      if (who === 'impression') panel.setOpen(false)
    },
  })
  panel.setOpen(true)
  check('★★ 打开记忆中心后仍然是打开的（不被自己关掉）',
    panel.isOpen() === true && root.hidden === false,
    `isOpen=${panel.isOpen()} hidden=${root.hidden}`)
  check('★★ 打开时仍然上行了 get',
    sent.some((m) => m.action === 'get'))
}

// ── 13. 未知类型不炸 ─────────────────────────────────────────────────
{
  const { panel } = mount()
  panel.setOpen(true)
  let threw = false
  try {
    panel.onPayload({ type: 'impression-unknown', foo: 1 })
    panel.onPayload(null)
    panel.onPayload(undefined)
    panel.onPayload('not an object')
  } catch {
    threw = true
  }
  check('未知类型 / 脏载荷不抛异常', threw === false)
}

// ── 14. ★★ setLocale 反复调用不能叠监听（2026-10-08 修的真债）──────────
//
// 由来：`applyStatic` 里原来绑了 5 个 addEventListener，而它同时被当作
// `setLocale` 对外导出 —— shell.js:793 每次切语言/刷主题都会调它，
// 于是监听器一层层叠上去：点一次「立即执行一次」发 N 条 refresh。
// 现在事件挪到 bindOnce()，只有初始化调一次。
{
  const { panel, sent, picked } = mount()
  panel.onPayload({ type: 'impression', ok: true, exists: true, text: 'x', everyHours: 24 })

  // shell.js 的调用姿势：切一次语种 → setLocale 一次
  panel.setLocale()
  panel.setLocale()
  panel.setLocale()

  const before = sent.filter((m) => m.action === 'refresh').length
  refreshBtn.dispatchEvent(new W.Event('click'))
  const fired = sent.filter((m) => m.action === 'refresh').length - before
  check('★★ 切三次语种后点一次「立即执行一次」只上行一条 refresh',
    fired === 1, `实际 ${fired} 条`)

  // 频率按钮同理：叠了 N 层就会开 N 次菜单
  const pickedBefore = picked.length
  scheduleSelect.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true }))
  check('★ 频率按钮也只为一次点击开一次菜单',
    picked.length - pickedBefore === 1, `实际 ${picked.length - pickedBefore} 次`)

  // 切语种不该把用户展开的历史列表收回去（那是一次性初始状态）
  historyBox.hidden = false
  panel.setLocale()
  check('★ 切语种不重置历史列表的展开状态（hidden 不再被写）',
    historyBox.hidden === false)
}

// ── 15. 源码契约：事件只能待在一个函数里（防后人把 addEventListener 挪回去）──
{
  const src = readFileSync(join(ROOT, 'helper', 'assets', 'impression-panel.js'), 'utf8')
    .replace(/\r\n/g, '\n')
  const cut = (startNeedle, endNeedle) => {
    const start = src.indexOf(startNeedle)
    if (start < 0) return ''
    const end = src.indexOf(endNeedle, start + startNeedle.length)
    return end < 0 ? src.slice(start) : src.slice(start, end)
  }
  const applyStaticBody = cut('function applyStatic() {', '\n  }\n\n  /** 只在初始化时绑一次的事件')
  const bindOnceBody = cut('function bindOnce() {', '\n  }\n\n  function setOpen(')
  const count = (text, needle) => text.split(needle).length - 1

  check('applyStatic 切得出来', applyStaticBody.length > 0)
  check('bindOnce 切得出来', bindOnceBody.length > 0)
  check('★ applyStatic 里一个 addEventListener 都没有（否则 setLocale 会叠层）',
    count(applyStaticBody, 'addEventListener') === 0,
    `实际 ${count(applyStaticBody, 'addEventListener')} 个`)
  check('★ 五个监听都还在 bindOnce 里（别顺手删事件）',
    count(bindOnceBody, 'addEventListener') === 5,
    `实际 ${count(bindOnceBody, 'addEventListener')} 个`)
  check('初始化同时调用 bindOnce 与 applyStatic',
    /\n  bindOnce\(\)\n  applyStatic\(\)\n  render\(\)/.test(src))
  check('★ 对外的 setLocale 仍然只指向 applyStatic（不指向 bindOnce）',
    /setLocale: applyStatic \}/.test(src))
}

console.log(`\n${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)