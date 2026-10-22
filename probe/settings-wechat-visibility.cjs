#!/usr/bin/env node
/**
 * 设置抽屉：「分组折叠是否真的让微信一眼可见」+「扫码配对区在不在」（真渲染进程）。
 *
 * 起因（2026-10-22 用户报障）：
 *   「微信接入功能正常，但微信的设置功能是缺失的 —— 它压根没有出现在设置页面，
 *     只能用户自己填一串 api，但 api 如何获取，不知道。」
 *
 * 第一次测出来的事实：微信段**在**，但 `#api-config` 可视 440px / 内容 1130px，
 * 微信标题在折叠线以下 113px，暗色滚动条几乎不可见 ⇒ 用户以为没有这个功能。
 *
 * 于是做了两件事，本探针各钉一条：
 *   A. **分组折叠** —— 默认只展开第一组，三组标题必须全部落在首屏可视区内；
 *   B. **内置扫码配对** —— 开源版默认用户没装 DSH，token 只能靠这一步拿到。
 *
 * 断言：
 *   W1 `#api-config` 打开、可见、可滚
 *   W2 三个 `.api-group-head` 存在，文案非空（文案来自 shell.js 双语表，HTML 里没有字面量）
 *   W3 ★ 默认折叠态下，三组标题的 bottom 全部 ≤ 可视底边（这就是「一眼看见微信」的判据）
 *   W4 默认只展开第一组（model 的 body 不 hidden，wechat/bili 的都 hidden）
 *   W5 ★ `.api-group-body[hidden]` 的 computed display 必须是 `none`（铁律：display:flex 会压过 UA 的 [hidden]）
 *   W6 点微信标题 → 它展开、aria 变 true，且不影响 model 组
 *   W7 ★ 微信组里有扫码配对区：按钮有文案且在、二维码容器初始收起、状态行有文案
 *   W8 徽标有文案（未连接/已连接），不是空白
 *   W9 微信组有「第一次用怎么弄」的说明行（用户原话是「api 如何获取不知道」）
 *   W10 ★ 真点一次「扫码配对」→ 主进程收到 start、二维码画出来、状态行不是错误态
 *
 * ⚠️ 不碰真实 config / data：所有 orb:* 通道都挂哑处理器，快照用 fixture。
 *
 * 跑法：
 *   env -u ELECTRON_RUN_AS_NODE NODE_OPTIONS= \
 *     runtime/electron/electron.exe probe/settings-wechat-visibility.cjs --no-sandbox --disable-gpu
 * 产物：logs/shot-settings-folded.png · shot-settings-wechat.png · shot-settings-wechat-qr.png
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const ROOT = resolve(__dirname, '..')
const PAGE = join(ROOT, 'helper', 'assets', 'floating.html')
const PRELOAD = join(ROOT, 'helper', 'preload.cjs')

app.disableHardwareAcceleration()

/** 与主进程 apiConfigSnapshot 同形（含 wechat 段）。 */
const API_SNAPSHOT = {
  ok: true,
  model: 'deepseek-v4',
  provider: 'deepseek',
  providerLabel: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-probe-not-a-real-key',
  configPath: join(ROOT, 'config.json'),
  authPath: join(ROOT, 'data', 'providers', 'auth.json'),
  contextBudgetTokens: null,
  reasoningEffort: '',
  wechat: {
    file: join(ROOT, 'data', 'wechat.json'),
    enabled: false,
    botToken: '',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    description: '微信：关闭',
  },
  bili: { ok: true, loggedIn: false, account: '', file: join(ROOT, 'data', 'bili-auth.json') },
  error: '',
}

/** 假的配对二维码（只要是个 svg 就行，本探针验的是「画出来了没有」）。 */
const FAKE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="148" height="148" viewBox="0 0 10 10"><rect width="10" height="10" fill="#fff"/><rect x="1" y="1" width="3" height="3" fill="#111"/></svg>'

const CHANNELS = [
  'orb:api-config-get', 'orb:api-config-set', 'orb:appearance', 'orb:attach', 'orb:avatar',
  'orb:avatar-set', 'orb:avatars', 'orb:backgrounds', 'orb:ball-hide', 'orb:bg-clear', 'orb:bg-get',
  'orb:bg-import', 'orb:bg-open-folder', 'orb:bg-update', 'orb:bili-act', 'orb:bili-comment-send',
  'orb:bili-compose', 'orb:bili-history', 'orb:bili-history-clear', 'orb:bili-history-delete',
  'orb:bili-login-poll', 'orb:bili-login-start', 'orb:bili-logout', 'orb:bili-note-save',
  'orb:bili-status', 'orb:bili-summary', 'orb:block', 'orb:block-drop', 'orb:clamp',
  'orb:conversation-action', 'orb:copy', 'orb:edit-menu', 'orb:expand', 'orb:history',
  'orb:image-data', 'orb:image-request', 'orb:legacy-status', 'orb:lock', 'orb:lock-action',
  'orb:lock-feedback', 'orb:menu', 'orb:menu-hold', 'orb:move', 'orb:new', 'orb:open',
  'orb:open-external', 'orb:open-legacy-web', 'orb:panel-opacity', 'orb:prompt', 'orb:question',
  'orb:question-answer', 'orb:question-cancel', 'orb:question-clear', 'orb:question-error',
  'orb:reset', 'orb:resize', 'orb:ring-action', 'orb:ring-close', 'orb:ring-open', 'orb:ring-state',
  'orb:session', 'orb:soft-agreement', 'orb:stop', 'orb:tcc-open', 'orb:tcc-status', 'orb:theme-get',
  'orb:theme-set', 'orb:unsnap', 'orb:wechat-pair-start', 'orb:wechat-pair-poll',
]

/** 渲染层真的调了配对接口没有（W10 的反向证据）。 */
const pairCalls = []
/** 第几次 poll —— 用来演「先 waiting、再 confirmed、之后一律超时」的真实时序。 */
let pairPollCount = 0
/** 配对成功后主进程会回一份带 token 的快照（界面据此把徽标变成「已连接」）。 */
const PAIRED_SNAPSHOT = Object.assign({}, API_SNAPSHOT, {
  wechat: Object.assign({}, API_SNAPSHOT.wechat, {
    enabled: true,
    botToken: 'tok-probe',
    description: '微信：开启（bot_42 → user_7）',
  }),
})

for (const ch of CHANNELS) {
  ipcMain.handle(ch, () => {
    if (ch === 'orb:api-config-get') return pairPollCount >= 2 ? Object.assign({}, PAIRED_SNAPSHOT) : Object.assign({}, API_SNAPSHOT)
    if (ch === 'orb:theme-get') return { ok: true, mode: 'dark', dark: true }
    if (ch === 'orb:wechat-pair-start') {
      pairCalls.push('start')
      return {
        ok: true,
        qrcodeKey: 'probe-qrcode-key',
        url: 'https://liteapp.weixin.qq.com/q/probe',
        svg: FAKE_SVG,
        expiresAt: Date.now() + 300000,
      }
    }
    if (ch === 'orb:wechat-pair-poll') {
      pairCalls.push('poll')
      pairPollCount += 1
      // 时序照真实：第 1 次还没扫 → 第 2 次配好 → 之后一律「请求超时」。
      // 第三次那个超时正是 2026-10-22 用户实测到的**把成功提示盖成红字**的元凶；
      // 修好之后前端根本不该再发第三次，所以 W11 同时验「不再发」和「不被盖」。
      if (pairPollCount === 1) return { ok: true, state: 'waiting' }
      if (pairPollCount === 2) {
        return { ok: true, state: 'confirmed', creds: { botId: 'bot_42', userId: 'user_7' } }
      }
      return { ok: false, state: 'error', error: '请求超时' }
    }
    return { ok: true }
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`PASS ${name}`)
    return
  }
  failed += 1
  console.log(`FAIL ${name}${detail ? `  —— ${detail}` : ''}`)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    // 照用户真机 logs/window-state.json 的 panel 尺寸（560×734）建窗 ——
    // 用小窗口测出来的「折叠线在哪」没有参考价值。
    width: 560,
    height: 734,
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })

  await win.loadFile(PAGE)
  await sleep(1200)

  win.webContents.send('orb:ring-action', 'api-config')
  await sleep(1400)

  /* ── W1 ~ W5：默认折叠态 ─────────────────────────────────────────── */
  const folded = await win.webContents.executeJavaScript(`
    (() => {
      const root = document.getElementById('api-config')
      const rr = root.getBoundingClientRect()
      const visibleBottom = rr.top + root.clientHeight
      const groups = [...document.querySelectorAll('.api-group')].map((g) => {
        const head = g.querySelector('.api-group-head')
        const title = g.querySelector('.api-group-title')
        const body = g.querySelector('.api-group-body')
        const badge = g.querySelector('.api-group-badge')
        const hr = head.getBoundingClientRect()
        return {
          name: g.getAttribute('data-group'),
          title: (title ? title.textContent : '').trim(),
          badge: (badge ? badge.textContent : '').trim(),
          expanded: head ? head.getAttribute('aria-expanded') : null,
          bodyHidden: body ? body.hidden : null,
          bodyDisplay: body ? getComputedStyle(body).display : '',
          top: Math.round(hr.top),
          bottom: Math.round(hr.bottom),
        }
      })
      return {
        open: !root.hidden,
        overflowY: getComputedStyle(root).overflowY,
        scrollH: root.scrollHeight,
        clientH: root.clientHeight,
        visibleBottom: Math.round(visibleBottom),
        groups,
      }
    })()
  `)

  check(
    'W1 设置抽屉打开且可见、可滚动',
    folded.open === true && folded.overflowY === 'auto',
    JSON.stringify({ open: folded.open, overflowY: folded.overflowY })
  )
  check(
    'W2 三个分组标题都在、且都有文案（文案来自 shell.js 双语表）',
    folded.groups.length === 3 && folded.groups.every((g) => g.title !== ''),
    JSON.stringify(folded.groups.map((g) => `${g.name}:${g.title}`))
  )

  const allHeadsVisible = folded.groups.every((g) => g.bottom <= folded.visibleBottom)
  check(
    'W3 ★ 默认折叠态下三组标题全在首屏内（这才是「一眼看见微信」）',
    allHeadsVisible,
    JSON.stringify({
      visibleBottom: folded.visibleBottom,
      heads: folded.groups.map((g) => `${g.name} ↓${g.bottom}`),
    })
  )

  const expandedNames = folded.groups.filter((g) => g.expanded === 'true').map((g) => g.name)
  check(
    'W4 默认三组全部收起 —— 且每组标题上都有徽标（收起不等于把信息藏起来）',
    expandedNames.length === 0 && folded.groups.every((g) => g.badge !== ''),
    JSON.stringify({
      expanded: expandedNames,
      badges: folded.groups.map((g) => `${g.name}=${g.badge}`),
    })
  )

  const hiddenBodies = folded.groups.filter((g) => g.bodyHidden === true)
  check(
    'W5 ★ `.api-group-body[hidden]` 的 computed display 必须是 none（display:flex 会压过 UA 的 [hidden]）',
    hiddenBodies.length === 3 && hiddenBodies.every((g) => g.bodyDisplay === 'none'),
    JSON.stringify(hiddenBodies.map((g) => `${g.name}:${g.bodyDisplay}`))
  )

  const shotFolded = await win.webContents.capturePage()
  writeFileSync(join(ROOT, 'logs', 'shot-settings-folded.png'), shotFolded.toPNG())

  /* ── W6 ~ W9：点开微信组 ─────────────────────────────────────────── */
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-group-toggle="wechat"]').click()`
  )
  await sleep(400)

  const opened = await win.webContents.executeJavaScript(`
    (() => {
      const body = document.querySelector('[data-group-body="wechat"]')
      const head = document.querySelector('[data-group-toggle="wechat"]')
      const modelBody = document.querySelector('[data-group-body="model"]')
      const btn = document.getElementById('api-wechat-pair')
      const qr = document.getElementById('api-wechat-qr')
      const hint = document.getElementById('api-wechat-pair-hint')
      const badge = document.getElementById('api-wechat-badge')
      const lead = document.getElementById('api-wechat-lead')
      const rect = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), hidden: !!n.hidden, display: getComputedStyle(n).display } }
      return {
        bodyHidden: body.hidden,
        bodyDisplay: getComputedStyle(body).display,
        aria: head.getAttribute('aria-expanded'),
        modelHidden: modelBody.hidden,
        btn: { text: btn ? btn.textContent.trim() : '', ...rect(btn) },
        qr: rect(qr),
        hint: hint ? hint.textContent.trim() : '',
        badge: badge ? badge.textContent.trim() : '',
        lead: lead ? lead.textContent.trim() : '',
      }
    })()
  `)

  check(
    'W6 点微信标题 → 它自己展开、aria-expanded=true，且 model 组保持原状（互不影响）',
    opened.bodyHidden === false &&
      opened.bodyDisplay !== 'none' &&
      opened.aria === 'true' &&
      opened.modelHidden === true,
    JSON.stringify({
      bodyHidden: opened.bodyHidden,
      bodyDisplay: opened.bodyDisplay,
      aria: opened.aria,
      modelHidden: opened.modelHidden,
    })
  )

  check(
    'W7 ★ 扫码配对区齐了：按钮有文案且在、二维码容器初始收起、状态行有文案',
    opened.btn.text !== '' &&
      opened.btn.w > 0 &&
      opened.btn.h > 0 &&
      opened.qr &&
      opened.qr.hidden === true &&
      opened.hint !== '',
    JSON.stringify(opened)
  )

  check('W8 微信组标题有状态徽标（未连接/已连接），不是空白', opened.badge !== '', `badge="${opened.badge}"`)

  check(
    'W9 微信组有「第一次用怎么弄」的说明行（用户原话是「api 如何获取不知道」）',
    opened.lead !== '',
    `lead="${opened.lead}"`
  )

  const shotWechat = await win.webContents.capturePage()
  writeFileSync(join(ROOT, 'logs', 'shot-settings-wechat.png'), shotWechat.toPNG())

  /* ── W10：真点一次「扫码配对」，验渲染层 → 主进程 → 回填二维码 ─────── */
  await win.webContents.executeJavaScript(`document.getElementById('api-wechat-pair').click()`)
  await sleep(900)

  const paired = await win.webContents.executeJavaScript(`
    (() => {
      const qr = document.getElementById('api-wechat-qr')
      const hint = document.getElementById('api-wechat-pair-hint')
      return {
        qrHidden: qr.hidden,
        qrSvg: qr.querySelectorAll('svg').length,
        hint: hint.textContent.trim(),
        hintKind: hint.dataset.kind || '',
      }
    })()
  `)

  check(
    'W10 ★ 点「扫码配对」→ 主进程收到 start、二维码被画出来、状态行不是错误态',
    pairCalls.includes('start') && paired.qrHidden === false && paired.qrSvg === 1 && paired.hintKind !== 'error',
    JSON.stringify({ pairCalls, ...paired })
  )

  /* ── W11 / W12：配对成功之后，提示不许被后来的超时盖成红字 ──────────── */
  // 时序（真实 2 秒节拍）：点按钮后 t≈2s 发 poll#1（waiting），t≈4s 发 poll#2（confirmed）。
  await sleep(2400)
  await sleep(2400)
  const afterConfirm = await win.webContents.executeJavaScript(`
    (() => {
      const hint = document.getElementById('api-wechat-pair-hint')
      const badge = document.getElementById('api-wechat-badge')
      return {
        kind: hint.dataset.kind || '',
        text: hint.textContent.trim(),
        badge: badge.textContent.trim(),
        badgeState: badge.dataset.state || '',
        qrHidden: document.getElementById('api-wechat-qr').hidden,
      }
    })()
  `)
  const pollsAtConfirm = pairPollCount
  await sleep(5000)
  const later = await win.webContents.executeJavaScript(`
    (() => {
      const hint = document.getElementById('api-wechat-pair-hint')
      return { kind: hint.dataset.kind || '', text: hint.textContent.trim() }
    })()
  `)

  check(
    'W11 ★ 配对成功后不再继续轮询，提示保持成功、不被后来的「请求超时」盖成红字',
    afterConfirm.kind !== 'error' &&
      afterConfirm.qrHidden === true &&
      later.kind !== 'error' &&
      pairPollCount === pollsAtConfirm,
    JSON.stringify({
      afterConfirm,
      later,
      pollCount: pairPollCount,
      atConfirm: pollsAtConfirm,
      calls: pairCalls,
    })
  )

  check(
    'W12 配对成功后重读快照 ⇒ 徽标变「已连接」、二维码自动收起',
    afterConfirm.badgeState === 'on' && afterConfirm.qrHidden === true,
    JSON.stringify(afterConfirm)
  )

  const shotQr = await win.webContents.capturePage()
  writeFileSync(join(ROOT, 'logs', 'shot-settings-wechat-qr.png'), shotQr.toPNG())

  console.log('='.repeat(70))
  console.log(`通过 ${passed} / 失败 ${failed}`)
  console.log('截图：logs/shot-settings-folded.png · shot-settings-wechat.png · shot-settings-wechat-qr.png')

  win.destroy()
  app.exit(failed === 0 ? 0 : 1)
})
