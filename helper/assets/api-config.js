/**
 * api-config.js —— 「设置」抽屉（2026-10-19 由「API 配置」重组而来）。
 *
 * 形态与记忆中心（impression-panel.js）一致：占满内容区、与其它抽屉互斥、
 * 从球菜单/环菜单进入、关闭后回到默认对话框。区别是它**可写**。
 *
 * 2026-10-19 剥离旧后端之后，这一页只剩「本机真源」，两段：
 *   1. 模型：`config.json` 的 `model` / `contextBudgetTokens` + `data/providers/auth.json`
 *      的 `base_url` / `auth.key`；
 *   2. 微信：`data/wechat.json` 的开关 / bot token / 接口地址。
 *旧后端时代的三样（legacy 地址行、「打开旧后端」按钮、写 agent 记录的思考开关与
 * context_window_limit）**整段删掉** —— 在这个引擎下那些控件写进去没有任何读侧。
 *
 * ★ 本模块**只呈现与收集输入**，读盘/写盘全在主进程（`orb:api-config-get` /
 *   `orb:api-config-set`，见 src/main.mjs 的 apiConfigSnapshot / applyApiConfig）。
 *   渲染层不做文件 IO：那条链路要「路径错了要报错、微信改完要重启桥」，
 *   放在只管画的地方迟早出错。
 *
 * ★ API key 是敏感值：默认 `type="password"`，要显式点「显示」才露出；
 *   本模块不把它写进 console、不写进 localStorage、不回显到任何提示文案里。
 */

/** 字段与文案键的对应关系集中在这里，`applyStatic()` 逐条刷。 */
const LABELS = [
  ['#api-config-title', 'apiTitle'],
  ['#api-group-model', 'apiGroupModel'],
  ['#api-provider-label', 'apiProvider'],
  ['#api-model-label', 'apiModel'],
  ['#api-base-url-label', 'apiBaseUrl'],
  ['#api-key-label', 'apiKey'],
  ['#api-context-limit-label', 'apiContextLimit'],
  ['#api-effort-label', 'apiReasoningEffort'],
  ['#api-group-wechat', 'apiGroupWechat'],
  ['#api-wechat-lead', 'apiWechatLead'],
  ['#api-wechat-pair', 'apiWechatPair'],
  ['#api-wechat-enabled-label', 'apiWechatEnabled'],
  ['#api-wechat-token-label', 'apiWechatToken'],
  ['#api-wechat-base-url-label', 'apiWechatBaseUrl'],
  ['#api-group-bili', 'apiGroupBili'],
  ['#api-bili-login', 'apiBiliLogin'],
  ['#api-bili-logout', 'apiBiliLogout'],
  // 语音播报（2026-10-22）
  ['#api-group-speech', 'apiGroupSpeech'],
  ['#api-speech-lead', 'apiSpeechLead'],
  ['#api-speech-enabled-label', 'apiSpeechEnabled'],
  ['#api-speech-provider-label', 'apiSpeechProvider'],
  ['#api-speech-volcano-key-label', 'apiSpeechVolcanoKey'],
  ['#api-speech-speaker-label', 'apiSpeechSpeaker'],
  ['#api-speech-speaker-hint', 'apiSpeechSpeakerHint'],
  ['#api-speech-volcano-app-id-label', 'apiSpeechVolcanoAppId'],
  ['#api-speech-volcano-access-key-label', 'apiSpeechVolcanoAccessKey'],
  ['#api-speech-base-url-label', 'apiSpeechBaseUrl'],
  ['#api-speech-model-label', 'apiSpeechModel'],
  ['#api-speech-voice-label', 'apiSpeechVoice'],
  ['#api-speech-openai-key-label', 'apiSpeechVolcanoKey'],
  ['#api-speech-hint', 'apiSpeechHintVar'],
  ['#api-speech-test', 'apiSpeechTest'],
  ['#api-paths-label', 'apiPaths'],
  ['#api-config-save', 'apiSave'],
  ['#api-config-reload', 'apiReload'],
]

export function createApiConfigPanel(options = {}) {
  const t = typeof options.translate === 'function' ? options.translate : (key) => key
  const setExclusiveOpen = typeof options.setExclusiveOpen === 'function' ? options.setExclusiveOpen : () => {}
  const onToggle = typeof options.onToggle === 'function' ? options.onToggle : () => {}
  const ask = typeof options.get === 'function' ? options.get : async () => null
  const save = typeof options.save === 'function' ? options.save : async () => null
  // B 站扫码的两个动作 + 轮询。注入式（不走全局 `api`），与 get/save 同一套写法，
  // 好处是本模块能在没有 preload 的环境（探针/单测）里被 import 而不炸。
  const biliStart = typeof options.biliStart === 'function' ? options.biliStart : async () => ({ ok: false, error: 'no bridge' })
  const biliPoll = typeof options.biliPoll === 'function' ? options.biliPoll : async () => ({ ok: false, error: 'no bridge' })
  const biliLogout = typeof options.biliLogout === 'function' ? options.biliLogout : async () => ({ ok: false, error: 'no bridge' })
  const biliStatus = typeof options.biliStatus === 'function' ? options.biliStatus : async () => ({ ok: false, error: 'no bridge' })
  // 微信扫码配对（2026-10-22，开源版必备）：与 B 站扫码同一套注入式写法，
  // 保证本模块在没有 preload 的环境（探针/单测）里也能 import。
  const wechatPairStart = typeof options.wechatPairStart === 'function' ? options.wechatPairStart : async () => ({ ok: false, error: 'no bridge' })
  const wechatPairPoll = typeof options.wechatPairPoll === 'function' ? options.wechatPairPoll : async () => ({ ok: false, error: 'no bridge' })
  // 语音播报（2026-10-22）：与上面同一套注入式写法。三个动作各自独立：
  //   ttsGet 读快照 / ttsSet 存 / speechTest 现合成一句来试听。
  //   **试听是唯一的验收手段** —— 没有它，用户只能「保存 → 回对话 → 等她说一句 → 发现没声 → 再回来」。
  const ttsGet = typeof options.ttsGet === 'function' ? options.ttsGet : async () => null
  const ttsSave = typeof options.ttsSave === 'function' ? options.ttsSave : async () => null
  const speechTest = typeof options.speechTest === 'function' ? options.speechTest : async () => ({ ok: false, error: 'no bridge' })

  const root = document.querySelector('#api-config')
  const closeBtn = document.querySelector('#api-config-close')
  const noteEl = document.querySelector('#api-config-note')
  const providerEl = document.querySelector('#api-provider')
  const modelEl = document.querySelector('#api-model')
  const baseUrlEl = document.querySelector('#api-base-url')
  const keyEl = document.querySelector('#api-key')
  const keyReveal = document.querySelector('#api-key-reveal')
  const limitEl = document.querySelector('#api-context-limit')
  const effortEl = document.querySelector('#api-effort')
  const wechatEnabledEl = document.querySelector('#api-wechat-enabled')
  const wechatTokenEl = document.querySelector('#api-wechat-token')
  const wechatTokenReveal = document.querySelector('#api-wechat-token-reveal')
  const wechatBaseUrlEl = document.querySelector('#api-wechat-base-url')
  const pathsEl = document.querySelector('#api-paths-value')
  const statusEl = document.querySelector('#api-config-status')
  const saveBtn = document.querySelector('#api-config-save')
  const reloadBtn = document.querySelector('#api-config-reload')
  const biliAccountEl = document.querySelector('#api-bili-account')
  const biliQrEl = document.querySelector('#api-bili-qr')
  const biliHintEl = document.querySelector('#api-bili-hint')
  const biliLoginBtn = document.querySelector('#api-bili-login')
  const biliLogoutBtn = document.querySelector('#api-bili-logout')
  // ── 微信扫码配对 ──
  const wechatLeadEl = document.querySelector('#api-wechat-lead')
  const wechatPairBtn = document.querySelector('#api-wechat-pair')
  const wechatQrEl = document.querySelector('#api-wechat-qr')
  const wechatAccountEl = document.querySelector('#api-wechat-account')
  const wechatPairHintEl = document.querySelector('#api-wechat-pair-hint')
  const wechatBadgeEl = document.querySelector('#api-wechat-badge')
  const biliBadgeEl = document.querySelector('#api-bili-badge')
  const modelBadgeEl = document.querySelector('#api-group-model-badge')
  // ── 语音播报（2026-10-22）──
  const speechBadgeEl = document.querySelector('#api-speech-badge')
  const speechEnabledEl = document.querySelector('#api-speech-enabled')
  const speechProviderEl = document.querySelector('#api-speech-provider')
  const speechVolcanoKeyEl = document.querySelector('#api-speech-volcano-key')
  const speechVolcanoKeyReveal = document.querySelector('#api-speech-volcano-key-reveal')
  const speechSpeakerEl = document.querySelector('#api-speech-speaker')
  const speechAppIdEl = document.querySelector('#api-speech-volcano-app-id')
  const speechAccessKeyEl = document.querySelector('#api-speech-volcano-access-key')
  const speechAccessKeyReveal = document.querySelector('#api-speech-volcano-access-key-reveal')
  const speechBaseUrlEl = document.querySelector('#api-speech-base-url')
  const speechModelEl = document.querySelector('#api-speech-model')
  const speechVoiceEl = document.querySelector('#api-speech-voice')
  const speechOpenaiKeyEl = document.querySelector('#api-speech-openai-key')
  const speechOpenaiKeyReveal = document.querySelector('#api-speech-openai-key-reveal')
  const speechVariantEl = document.querySelector('#api-speech-variant')
  const speechTestBtn = document.querySelector('#api-speech-test')
  const speechStatusEl = document.querySelector('#api-speech-status')
  const speechBlocks = [...document.querySelectorAll('[data-tts-for]')]

  let open = false
  let data = null
  /** 语音配置快照（独立于 data —— 它是另一个文件、另一组字段）。 */
  let ttsData = null
  let busy = false
  let revealed = false
  let wechatRevealed = false
  let speechRevealed = false
  let speechBusy = false
  let note = ''
  /**
   * 扫码态：`biliTimer` 是 2 秒一次的 poll 定时器，`biliKey` 是当前二维码的 key。
   * 两个都要在关抽屉/重新扫码时清掉 —— 留着定时器会在抽屉关掉之后继续打接口，
   * 拿到 confirmed 还会去 `render()` 一个隐藏的 DOM。
   */
  let biliTimer = null
  let biliKey = ''
  let biliBusy = false

  for (const [selector, key] of LABELS) {
    const node = document.querySelector(selector)
    if (!node) continue
    // 标题/标签/按钮一律 textContent，不走 innerHTML。
    node.textContent = t(key)
  }

  const str = (v) => (v === null || v === undefined ? '' : String(v))

  /** 用户改过的字段才提交，避免「点一次保存把没碰过的值也重写一遍」。 */
  function patchFromForm() {
    const patch = {}
    if (!data) return patch
    if (modelEl && modelEl.value.trim() !== str(data.model).trim()) patch.model = modelEl.value.trim()
    if (baseUrlEl && baseUrlEl.value.trim() !== str(data.baseUrl).trim()) patch.baseUrl = baseUrlEl.value.trim()
    if (keyEl && keyEl.value.trim() !== str(data.apiKey).trim()) patch.apiKey = keyEl.value.trim()

    // 压缩阈值：空 = 清掉这个键（回到出厂 24 000），否则必须是正整数。
    if (limitEl) {
      const raw = limitEl.value.trim()
      if (raw !== str(data.contextBudgetTokens)) {
        patch.contextBudgetTokens = raw === '' ? null : Number(raw)
      }
    }

    // 推理等级：空 = 清掉这个键（回到出厂 max），否则必须落在合法档位里
    //（宿主侧 `applyApiConfig()` 会再校验一遍，这里只负责不提交未改动的值）。
    // 注意「没配过」与「显式 max」在界面上长得一样（都显示 max），所以比较前先归一化，
    // 否则用户只是点一下保存、根本没碰下拉，也会被写出一条 reasoningEffort: "max"。
    if (effortEl) {
      const raw = effortEl.value.trim()
      const cur = str(data.reasoningEffort) || 'max'
      if (raw !== (cur === 'none' ? 'off' : cur)) {
        patch.reasoningEffort = raw === '' ? null : raw
      }
    }

    const wechat = data.wechat ?? {}
    const wechatPatch = {}
    if (wechatEnabledEl && wechatEnabledEl.value !== (wechat.enabled ? 'on' : 'off')) {
      wechatPatch.enabled = wechatEnabledEl.value === 'on'
    }
    if (wechatTokenEl && wechatTokenEl.value.trim() !== str(wechat.botToken).trim()) {
      wechatPatch.botToken = wechatTokenEl.value.trim()
    }
    if (wechatBaseUrlEl && wechatBaseUrlEl.value.trim() !== str(wechat.baseUrl).trim()) {
      wechatPatch.baseUrl = wechatBaseUrlEl.value.trim()
    }
    if (Object.keys(wechatPatch).length > 0) patch.wechat = wechatPatch
    return patch
  }

  function setStatus(text, kind = 'info') {
    if (!statusEl) return
    statusEl.textContent = text
    statusEl.dataset.kind = kind
    statusEl.hidden = text === ''
  }

  /** `<option>` 的 value 是协议值，可见文字按语种写。 */
  function applyOptions() {
    if (wechatEnabledEl) {
      const off = wechatEnabledEl.querySelector('option[value="off"]')
      const on = wechatEnabledEl.querySelector('option[value="on"]')
      if (off) off.textContent = t('apiOff')
      if (on) on.textContent = t('apiOn')
    }
    // 语音开关同样只有两个 value（on/off），文案随语种。
    if (speechEnabledEl) {
      const off = speechEnabledEl.querySelector('option[value="off"]')
      const on = speechEnabledEl.querySelector('option[value="on"]')
      if (off) off.textContent = t('apiOff')
      if (on) on.textContent = t('apiOn')
    }
    if (speechTestBtn) speechTestBtn.textContent = t('apiSpeechTest')
    // 推理等级：8 个档位逐一刷可见文字；value 是发给 API 的协议值，不翻译。
    if (effortEl) {
      const keys = {
        off: 'apiEffortOff',
        minimal: 'apiEffortMinimal',
        low: 'apiEffortLow',
        medium: 'apiEffortMedium',
        high: 'apiEffortHigh',
        xhigh: 'apiEffortXhigh',
        ultra: 'apiEffortUltra',
        max: 'apiEffortMax',
      }
      for (const [value, key] of Object.entries(keys)) {
        const node = effortEl.querySelector(`option[value="${value}"]`)
        if (node) node.textContent = t(key)
      }
    }
  }

  function syncReveal() {
    if (keyEl) keyEl.type = revealed ? 'text' : 'password'
    if (keyReveal) {
      keyReveal.textContent = t(revealed ? 'apiHideKey' : 'apiShowKey')
      keyReveal.setAttribute('aria-pressed', String(revealed))
    }
    if (wechatTokenEl) wechatTokenEl.type = wechatRevealed ? 'text' : 'password'
    if (wechatTokenReveal) {
      wechatTokenReveal.textContent = t(wechatRevealed ? 'apiHideKey' : 'apiShowKey')
      wechatTokenReveal.setAttribute('aria-pressed', String(wechatRevealed))
    }
    // 语音那三格密钥同样默认 password，要显式点「显示」才露 —— 这是全页统一纪律。
    for (const [node, btn] of [
      [speechVolcanoKeyEl, speechVolcanoKeyReveal],
      [speechAccessKeyEl, speechAccessKeyReveal],
      [speechOpenaiKeyEl, speechOpenaiKeyReveal],
    ]) {
      if (node) node.type = speechRevealed ? 'text' : 'password'
      if (btn) {
        btn.textContent = t(speechRevealed ? 'apiHideKey' : 'apiShowKey')
        btn.setAttribute('aria-pressed', String(speechRevealed))
      }
    }
  }

  /**
   * 关闭按钮：可见文字「×」+ 无障碍名。
   *
   * ⚠️ 只设 `aria-label` 的按钮在肉眼看来是**空方块**（`impression-panel.js:90`
   *   的教训），所以文字与无障碍名必须一起给。
   *
   * ⚠️⚠️ 本函数曾经**只有调用、没有定义**（:198 与 :210 两处调用）——
   *   `createApiConfigPanel()` 一进初始化就抛 `ReferenceError: applyClose is not defined`，
   *   而它是在 `shell.js` 的 `main()` 里被调用的，于是 `main()` 当场中断：
   *   `applyStaticText()` 与其后**所有球窗口监听**（pointerdown/move/up、contextmenu）
   *   全都没注册。2026-10-08 用户实测症状正是「左键点击与拖动全无反应 + 右键被
   *   窗口层原生菜单接管」。改这个文件时务必让定义与调用成对出现。
   */
  function applyClose() {
    if (!closeBtn) return
    closeBtn.textContent = '×'
    closeBtn.setAttribute('aria-label', t('apiClose'))
  }

  /**
   * B 站那一块。
   *
   * 与上面所有字段的根本区别：扫码是**动作**，不是「改完点保存」的字段 ——
   * 所以它不走 `patchFromForm()`，而是自己调三个 IPC，且有自己的中间态
   * （等扫码 / 已扫待确认 / 过期），用 2 秒一次的轮询推着走。
   *
   * 口令（SESSDATA）不回渲染层：这里只看得到 uname / UID / 到期日。
   */
  function biliHint(text, kind = 'info') {
    if (!biliHintEl) return
    biliHintEl.textContent = text
    biliHintEl.dataset.kind = kind
  }

  function stopBiliPoll() {
    if (biliTimer) {
      clearInterval(biliTimer)
      biliTimer = null
    }
    biliKey = ''
  }

  function hideBiliQr() {
    if (!biliQrEl) return
    biliQrEl.hidden = true
    biliQrEl.innerHTML = ''
  }

  /** 到期日：宿主给的是 epoch 毫秒，别直接 slice 字符串（会显示成 1758…）。 */
  function formatDay(ms) {
    const n = Number(ms)
    if (!Number.isFinite(n) || n <= 0) return ''
    const d = new Date(n)
    const pad = (v) => String(v).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  // ── 分组折叠（2026-10-22）────────────────────────────────────────────
  /**
   * 为什么要有：用户报「微信设置压根没出现在设置页」。真相是它在，但整页内容
   * 1130px 挤在 440px 的可视区里，微信标题在折叠线以下 113px，暗色滚动条又几乎
   * 看不见 —— 一屏只看到「模型与密钥」，结论自然就成了「没有这个功能」。
   *
   * 现在一组一个块、默认只展开第一组，所有组的标题一屏可见。
   * ⚠️ 只切 `hidden` + `aria-expanded`，不碰别处状态（抽屉互斥那套与本折叠无关）。
   */
  for (const head of document.querySelectorAll('[data-group-toggle]')) {
    head.addEventListener('click', () => {
      const name = head.getAttribute('data-group-toggle')
      const body = document.querySelector(`[data-group-body="${name}"]`)
      if (!body) return
      const willOpen = body.hidden
      body.hidden = !willOpen
      head.setAttribute('aria-expanded', String(willOpen))
      // 收起微信组就停轮询：看不见的二维码不该继续打接口
      if (!willOpen && name === 'wechat') {
        stopWechatPoll()
        hideWechatQr()
      }
    })
  }

  // ── 微信扫码配对（2026-10-22，开源版必备）──────────────────────────────
  /**
   * 为什么必须有：token 原本是 DSH 的 `dsh-omni-bridge` 插件扫码产出的，本程序
   * 首次启动从 `~/.dsh/omni-bridge-config.json` 迁过来。**开源版默认用户没装 DSH** ——
   * 对他们来说这里只有三个空框，且没有任何途径能填上。所以把配对内置。
   *
   * 形状与 B 站扫码完全一致（取码 → 每 2 秒轮询 → 成功就停），唯一区别：
   * 配对成功时**主进程已经把 botToken 写进 `data/wechat.json` 并重建了桥**，
   * 所以这里不用再点「保存」，`reload()` 刷一次快照就行。
   */
  let wxQr = ''
  let wxTimer = null
  let wxBusy = false
  /** 有没有一次 poll 还在路上（配合下面的过期结果丢弃）。 */
  let wxPolling = false

  function stopWechatPoll() {
    if (wxTimer) {
      clearInterval(wxTimer)
      wxTimer = null
    }
  }

  function hideWechatQr() {
    wxQr = ''
    if (wechatQrEl) {
      wechatQrEl.hidden = true
      wechatQrEl.innerHTML = ''
    }
  }

  function wechatHint(text, kind = 'info') {
    if (!wechatPairHintEl) return
    wechatPairHintEl.textContent = text
    if (kind === 'info') delete wechatPairHintEl.dataset.kind
    else wechatPairHintEl.dataset.kind = kind
  }

  /** 账号行 + 两个组标题上的状态徽标 + 按钮文字。纯用 `data`，不联网。 */
  function renderWechatPair() {
    const wechat = data?.wechat ?? {}
    const paired = str(wechat.botToken) !== ''
    // ★ 有 token ≠ 连上了（2026-10-22 修）：以前只看 token 非空就亮「已连接」，
    //   于是某个刚从别的工具搬来凭据、但开关关着的机器也显示已连接。
    //   真口径：有 token **且** 开关是开的，才算「已连接」。
    const live = paired && wechat.enabled === true
    // 三组默认全收起（一屏放得下全部标题），所以每组标题右边必须带一个
    // 「不点开也知道现在什么状态」的徽标 —— 否则收起就等于把信息藏起来了。
    if (modelBadgeEl) {
      const model = str(data?.model)
      modelBadgeEl.textContent = model
      // 模型名用中性色（不设 data-state=on），别和「已连接/已登录」那种绿灯抢注意力
      delete modelBadgeEl.dataset.state
    }
    if (wechatAccountEl) {
      wechatAccountEl.textContent = t(paired ? 'apiWechatPaired' : 'apiWechatNotPaired')
      wechatAccountEl.dataset.state = live ? 'in' : 'out'
    }
    if (wechatBadgeEl) {
      wechatBadgeEl.textContent = t(live ? 'apiWechatBadgeOn' : paired ? 'apiWechatBadgePairedOff' : 'apiWechatBadgeOff')
      if (live) wechatBadgeEl.dataset.state = 'on'
      else delete wechatBadgeEl.dataset.state
    }
    if (biliBadgeEl) {
      const loggedIn = data?.bili?.loggedIn === true
      biliBadgeEl.textContent = t(loggedIn ? 'apiBiliBadgeOn' : 'apiBiliBadgeOff')
      if (loggedIn) biliBadgeEl.dataset.state = 'on'
      else delete biliBadgeEl.dataset.state
    }
    if (wechatPairBtn) wechatPairBtn.textContent = t(paired ? 'apiWechatRepair' : 'apiWechatPair')
    // 轮询进行中就别覆盖提示行（那是 poll 的活儿）
    if (wxTimer) return
    hideWechatQr()
    if (live) wechatHint(t('apiWechatReady'), 'ok')
    else if (paired) wechatHint(t('apiWechatPairOff'), 'info')
    else wechatHint(t('apiWechatNeedPair'), 'info')
  }

  /**
   * 2 秒一问。宿主返回 `{ ok, state }`，state ∈ waiting|scanned|confirmed|expired。
   * ★ 别把「没见过的 state」当失败：主进程已经把未知状态统一归成 waiting
   *   （理由见 src/wechat-pair.mjs 文件头），这里只处理已知的四种。
   */
  function startWechatPoll(key) {
    stopWechatPoll()
    wxQr = key
    wechatHint(t('apiWechatWaitScan'), 'info')
    wxTimer = setInterval(async () => {
      // 抓一份「这一轮问的是哪张码」。回来的时候要拿它跟当前值比 —— 见下面那条。
      const mine = wxQr
      if (!mine) {
        stopWechatPoll()
        return
      }
      // ★ 上一次还没回来就别再发。
      //   2026-10-22 实测 bug：配对成功后主进程要写盘 + 重建桥（几百毫秒到几秒），
      //   而这里 2 秒一发的定时器还停不下来（它拿不到结果）。于是第二次 poll
      //   打到**已消费**的 qrcode 上，服务端挂住不回 → 15 秒本地超时 →
      //   把「配对失败：请求超时」的红字盖在已经显示的「配对成功」上面。
      if (wxPolling) return
      wxPolling = true
      let res = null
      try {
        res = await wechatPairPoll(mine)
      } catch (error) {
        res = { ok: false, state: 'error', error: String(error?.message ?? error) }
      } finally {
        wxPolling = false
      }
      // ★ 回来时这张码已经不是当前这张了（成功了 / 过期了 / 用户重新取过码）
      //   ⇒ 这是过期信息，一个字都不许再往界面上写。红字就是这么来的。
      if (wxQr !== mine) return
      const state = res?.state ?? (res?.ok === true ? 'waiting' : 'error')
      if (state === 'confirmed') {
        stopWechatPoll()
        hideWechatQr()
        wechatHint(t('apiWechatPairingOk'), 'ok')
        // 主进程已落盘并重建桥 —— 刷一次快照即可，不用再点「保存」
        await reload()
        return
      }
      if (state === 'expired') {
        stopWechatPoll()
        hideWechatQr()
        wechatHint(t('apiWechatExpired'), 'error')
        return
      }
      if (state === 'scanned') wechatHint(t('apiWechatScanned'), 'ok')
      else if (state === 'waiting') wechatHint(t('apiWechatWaitScan'), 'info')
      else {
        stopWechatPoll()
        hideWechatQr()
        wechatHint(`${t('apiWechatPairFailed')}${res?.error ?? ''}`, 'error')
      }
    }, 2000)
  }

  async function beginWechatPair() {
    if (wxBusy) return
    wxBusy = true
    stopWechatPoll()
    hideWechatQr()
    if (wechatPairBtn) wechatPairBtn.disabled = true
    wechatHint(t('apiWechatPairing'), 'info')
    let res = null
    try {
      res = await wechatPairStart()
    } catch (error) {
      res = { ok: false, error: String(error?.message ?? error) }
    }
    wxBusy = false
    if (wechatPairBtn) wechatPairBtn.disabled = false
    if (res?.ok !== true || !res.qrcodeKey) {
      wechatHint(`${t('apiWechatPairFailed')}${res?.error ?? ''}`, 'error')
      return
    }
    if (wechatQrEl) {
      // svg 来自主进程的 src/qr.mjs（自己画的，不是外部内容），可以直接塞
      wechatQrEl.innerHTML = str(res.svg)
      wechatQrEl.hidden = false
    }
    startWechatPoll(res.qrcodeKey)
  }

  /** 账号行 + 按钮文字/可用性。不联网，纯用 `data.bili`。 */
  function renderBili() {
    if (!biliAccountEl && !biliLoginBtn) return
    const bili = data?.bili ?? {}
    const loggedIn = bili.loggedIn === true
    if (biliAccountEl) {
      if (loggedIn) {
        const bits = [bili.uname || t('apiBiliUnknownUser')]
        if (bili.mid) bits.push(`UID ${bili.mid}`)
        const day = formatDay(bili.expiresAt)
        if (day) bits.push(`${t('apiBiliExpires')} ${day}`)
        biliAccountEl.textContent = bits.join(' · ')
        biliAccountEl.dataset.state = 'in'
      } else {
        biliAccountEl.textContent = t('apiBiliNotLoggedIn')
        biliAccountEl.dataset.state = 'out'
      }
    }
    if (biliLoginBtn) biliLoginBtn.textContent = t(loggedIn ? 'apiBiliRelogin' : 'apiBiliLogin')
    if (biliLogoutBtn) {
      biliLogoutBtn.disabled = !loggedIn
      biliLogoutBtn.textContent = t('apiBiliLogout')
    }
    // 轮询进行中就别覆盖状态行（那是 poll 的活儿：等待扫码/已扫待确认）。
    if (biliTimer) return
    hideBiliQr()
    biliHint(t(loggedIn ? 'apiBiliConfirmed' : 'apiBiliNotLoggedIn'), loggedIn ? 'ok' : 'info')
  }

  /**
   * 2 秒一问。宿主返回 `{ ok, state, ... }`，state ∈ waiting|scanned|confirmed|expired。
   * `confirmed` 时宿主已经把 cookie 落盘了 —— 这里要重新 `reload()` 才有 uname/头像。
   */
  function startBiliPoll(key) {
    stopBiliPoll()
    biliKey = key
    biliHint(t('apiBiliWaitScan'), 'info')
    biliTimer = setInterval(async () => {
      if (!biliKey) {
        stopBiliPoll()
        return
      }
      let res = null
      try {
        res = await biliPoll(biliKey)
      } catch (error) {
        res = { ok: false, state: 'error', error: String(error?.message ?? error) }
      }
      const state = res?.state ?? (res?.ok === true ? 'confirmed' : 'error')
      if (state === 'confirmed') {
        stopBiliPoll()
        hideBiliQr()
        biliHint(t('apiBiliConfirmed'), 'ok')
        await reload()
        return
      }
      if (state === 'expired') {
        stopBiliPoll()
        hideBiliQr()
        biliHint(t('apiBiliExpired'), 'error')
        return
      }
      if (state === 'scanned') biliHint(t('apiBiliScanned'), 'ok')
      else if (state === 'waiting') biliHint(t('apiBiliWaitScan'), 'info')
      else {
        stopBiliPoll()
        hideBiliQr()
        biliHint(`${t('apiBiliFailed')}${res?.error ?? ''}`, 'error')
      }
    }, 2000)
  }

  async function beginBiliLogin() {
    if (biliBusy) return
    biliBusy = true
    stopBiliPoll()
    hideBiliQr()
    if (biliLoginBtn) biliLoginBtn.disabled = true
    biliHint(t('apiBiliStarting'), 'info')
    let res = null
    try {
      res = await biliStart()
    } catch (error) {
      res = { ok: false, error: String(error?.message ?? error) }
    }
    biliBusy = false
    if (biliLoginBtn) biliLoginBtn.disabled = false
    if (res?.ok !== true || !res.qrcodeKey) {
      biliHint(`${t('apiBiliFailed')}${res?.error ?? ''}`, 'error')
      return
    }
    if (biliQrEl) {
      // svg 来自主进程的 src/qr.mjs（自己画的，不是外部内容），可以直接塞。
      biliQrEl.innerHTML = str(res.svg)
      biliQrEl.hidden = false
    }
    startBiliPoll(res.qrcodeKey)
  }

  async function doBiliLogout() {
    if (biliBusy) return
    biliBusy = true
    stopBiliPoll()
    hideBiliQr()
    if (biliLogoutBtn) biliLogoutBtn.disabled = true
    try {
      await biliLogout()
    } catch {
      // 退出失败也把界面拉回未登录态，最终以 reload 读到的文件为准。
    }
    biliBusy = false
    await reload()
  }

  /**
   * 开抽屉时联网复核一次（`nav` 接口）。文件的 `expiresAt` 只是本地估算 ——
   * 用户在别的设备点了「退出所有设备」，本地文件仍然写着已登录。
   * 复核失败（断网/接口抽风）保持原样，不改任何提示。
   */
  async function refreshBiliLive() {
    let res = null
    try {
      res = await biliStatus({ verify: true })
    } catch {
      return
    }
    if (!res || res.ok !== true) return
    data = data ?? {}
    data.bili = { ...(data.bili ?? {}), ...res }
    renderBili()
  }

  // ── 语音播报（2026-10-22）────────────────────────────────────────────
  /**
   * 为什么要单独一段、还要一个「试听」按钮：
   *
   * 语音这一组和模型那组最大的差别是**配错了不会有任何反馈** ——
   * 模型 key 填错，下一条消息立刻报错；语音 key 填错，只是「她不说话」，
   * 而且开关看着是开的。用户没有别的办法判断到底是 key 错了、音色 ID 错了、
   * 还是 CSP 拦了。所以「试听」不是锦上添花，是这组设置唯一的验收手段：
   * 它走的是**和平时播报完全相同**的一条链路（合成 → IPC → Blob → Audio）。
   */
  function speechStatus(text, kind = 'info') {
    if (!speechStatusEl) return
    speechStatusEl.textContent = text
    speechStatusEl.dataset.kind = kind
    speechStatusEl.hidden = text === ''
  }

  /** provider 一变就切两组字段的显隐 —— 页面上永远只出现当前 provider 需要填的格子。 */
  function syncSpeechBlocks() {
    const want = speechProviderEl ? speechProviderEl.value : ''
    for (const block of speechBlocks) {
      block.hidden = block.getAttribute('data-tts-for') !== want
    }
  }

  function renderSpeech() {
    if (speechBadgeEl) {
      const on = ttsData?.enabled === true
      speechBadgeEl.textContent = on ? t('apiOn') : t('apiOff')
      // 与其他三组徽标同一条约定：`data-state="on"` 才高亮，否则删掉属性（CSS 有默认灰）。
      if (on) speechBadgeEl.dataset.state = 'on'
      else delete speechBadgeEl.dataset.state
    }
    if (!ttsData) return

    if (speechProviderEl) {
      // provider 清单只在 src/tts/index.mjs 的 PROVIDERS 里定义一次，
      // 这里按快照重建 —— 以后加一家 provider，页面自动多一个选项。
      const list = Array.isArray(ttsData.providers) ? ttsData.providers : []
      const want = list.map((p) => p.id).join(',')
      if (speechProviderEl.dataset.built !== want) {
        speechProviderEl.innerHTML = ''
        for (const p of list) {
          const opt = document.createElement('option')
          opt.value = p.id
          opt.textContent = p.label
          speechProviderEl.append(opt)
        }
        speechProviderEl.dataset.built = want
      }
      speechProviderEl.value = str(ttsData.provider)
    }
    if (speechEnabledEl) speechEnabledEl.value = ttsData.enabled === true ? 'on' : 'off'

    const v = ttsData.volcano ?? {}
    if (speechVolcanoKeyEl) speechVolcanoKeyEl.value = str(v.apiKey)
    if (speechSpeakerEl) speechSpeakerEl.value = str(v.speaker)
    if (speechAppIdEl) speechAppIdEl.value = str(v.appId)
    if (speechAccessKeyEl) speechAccessKeyEl.value = str(v.accessKey)

    const o = ttsData.openai ?? {}
    if (speechBaseUrlEl) speechBaseUrlEl.value = str(o.baseUrl)
    if (speechModelEl) speechModelEl.value = str(o.model)
    if (speechVoiceEl) speechVoiceEl.value = str(o.voice)
    if (speechOpenaiKeyEl) speechOpenaiKeyEl.value = str(o.apiKey)

    if (speechVariantEl) {
      const variant = str(ttsData.state?.variant)
      speechVariantEl.hidden = variant === ''
      speechVariantEl.textContent = variant === '' ? '' : `${t('apiSpeechVariant')}: ${variant}`
    }

    syncSpeechBlocks()
  }

  /**
   * 只收集**用户真的动过**的格子。
   * 与 `patchFromForm()` 同一条纪律：点一次保存不该把没碰过的值重写一遍
   * （那样会把主进程探测出来的 `variant` 之类的运行时结果覆盖掉）。
   */
  function speechPatchFromForm() {
    const patch = {}
    if (!ttsData) return patch
    const dirty = (el, cur) => el && el.value.trim() !== str(cur).trim()

    if (speechProviderEl && speechProviderEl.value !== str(ttsData.provider)) {
      patch.provider = speechProviderEl.value
    }
    const wantEnabled = speechEnabledEl ? speechEnabledEl.value === 'on' : ttsData.enabled === true
    if (wantEnabled !== (ttsData.enabled === true)) patch.enabled = wantEnabled

    const v = ttsData.volcano ?? {}
    const o = ttsData.openai ?? {}
    const volcano = {}
    if (dirty(speechVolcanoKeyEl, v.apiKey)) volcano.apiKey = speechVolcanoKeyEl.value.trim()
    if (dirty(speechSpeakerEl, v.speaker)) volcano.speaker = speechSpeakerEl.value.trim()
    if (dirty(speechAppIdEl, v.appId)) volcano.appId = speechAppIdEl.value.trim()
    if (dirty(speechAccessKeyEl, v.accessKey)) volcano.accessKey = speechAccessKeyEl.value.trim()
    if (Object.keys(volcano).length > 0) patch.volcano = volcano

    const openai = {}
    if (dirty(speechBaseUrlEl, o.baseUrl)) openai.baseUrl = speechBaseUrlEl.value.trim()
    if (dirty(speechModelEl, o.model)) openai.model = speechModelEl.value.trim()
    if (dirty(speechVoiceEl, o.voice)) openai.voice = speechVoiceEl.value.trim()
    if (dirty(speechOpenaiKeyEl, o.apiKey)) openai.apiKey = speechOpenaiKeyEl.value.trim()
    if (Object.keys(openai).length > 0) patch.openai = openai

    return patch
  }

  async function doSpeechTest() {
    if (speechBusy) return
    speechBusy = true
    if (speechTestBtn) speechTestBtn.disabled = true
    speechStatus(t('apiSpeechTesting'), 'info')
    let r = null
    try {
      r = await speechTest()
    } catch (error) {
      r = { ok: false, error: String(error?.message ?? error) }
    }
    speechBusy = false
    if (speechTestBtn) speechTestBtn.disabled = false
    if (r?.ok === true) {
      speechStatus(`${t('apiSpeechTestOk')}${r.ms ? `（${r.ms}ms / ${Math.round((r.bytes || 0) / 1024)}KB）` : ''}`, 'ok')
    } else {
      speechStatus(`${t('apiSpeechTestFail')}${r?.error ?? ''}`, 'error')
    }
  }

  function render() {
    if (noteEl) {
      noteEl.textContent = note
      noteEl.hidden = note === ''
    }
    // ★ 必须放在 `if (!data) return` **之前**：语音那份快照与模型那份是两个文件，
    //   模型读取失败（auth.json 坏了）不该连带把语音那组也画不出来。
    renderSpeech()
    if (!data) return
    if (providerEl) providerEl.value = str(data.providerLabel ?? data.provider)
    if (modelEl) modelEl.value = str(data.model)
    if (baseUrlEl) baseUrlEl.value = str(data.baseUrl)
    if (keyEl) keyEl.value = str(data.apiKey)
    if (limitEl) {
      limitEl.value = str(data.contextBudgetTokens)
      limitEl.placeholder = t('apiContextLimitHint')
    }
    // 空值 = 没显式配置 ⇒ 下拉落到出厂档（max），与 src/settings.mjs 的缺省一致。
    // `none` 与 `off` 等价（都翻成 `thinking:{type:'disabled'}`），但下拉里只列 `off`，
    // 所以老配置写成 none 时显示成 off，不出现空白项。
    if (effortEl) {
      const effort = str(data.reasoningEffort) || 'max'
      effortEl.value = effort === 'none' ? 'off' : effort
    }
    const wechat = data.wechat ?? {}
    if (wechatEnabledEl) wechatEnabledEl.value = wechat.enabled ? 'on' : 'off'
    if (wechatTokenEl) wechatTokenEl.value = str(wechat.botToken)
    if (wechatBaseUrlEl) wechatBaseUrlEl.value = str(wechat.baseUrl)

    if (pathsEl) {
      const lines = []
      if (data.configPath) lines.push(`${t('apiModel')}: ${data.configPath}`)
      if (data.authPath) lines.push(`${t('apiKey')}: ${data.authPath}`)
      if (wechat.file) lines.push(`${t('apiWechatToken')}: ${wechat.file}`)
      // B 站登录态落在自己一个文件里（见 src/bili-auth.mjs），面板上给出路径便于排查。
      if (data.bili?.file) lines.push(`${t('apiGroupBili')}: ${data.bili.file}`)
      pathsEl.textContent = lines.join('\n')
    }

    renderBili()
    renderWechatPair()

    const notes = []
    if (data.error) notes.push(data.error)
    if (wechat.description) notes.push(wechat.description)
    if (data.bili?.description) notes.push(data.bili.description)
    notes.push(t('apiEffectiveNote'))
    setStatus(notes.join('\n'), data.error ? 'error' : 'info')
  }

  async function reload() {
    if (busy) return
    busy = true
    if (reloadBtn) reloadBtn.disabled = true
    setStatus(t('apiLoading'), 'info')
    try {
      data = await ask()
    } catch (error) {
      data = { ok: false, error: String(error?.message ?? error) }
    }
    // 语音那份单独读：两个文件、两条通道，任何一边失败都不该连坐。
    // 失败时保留上一份（`ttsData ?? null`），总比整组回空让人以为配置丢了强。
    try {
      const snapshot = await ttsGet()
      if (snapshot && snapshot.ok !== false) ttsData = snapshot
    } catch {
      /* 保持上一份 */
    }
    busy = false
    if (reloadBtn) reloadBtn.disabled = false
    if (data?.ok !== true) {
      setStatus(`${t('apiLoadFailed')}${data?.error ?? ''}`, 'error')
      render()
      return
    }
    note = ''
    render()
  }

  async function submit() {
    if (busy) return
    const patch = patchFromForm()
    const ttsPatch = speechPatchFromForm()
    if (Object.keys(patch).length === 0 && Object.keys(ttsPatch).length === 0) {
      setStatus(t('apiNoChange'), 'info')
      return
    }
    busy = true
    if (saveBtn) saveBtn.disabled = true
    setStatus(t('apiSaving'), 'info')

    // 语音先存：它是另一个文件，失败不该拦住模型那段（且反过来也一样）。
    let ttsResult = null
    if (Object.keys(ttsPatch).length > 0) {
      try {
        ttsResult = await ttsSave(ttsPatch)
      } catch (error) {
        ttsResult = { ok: false, error: String(error?.message ?? error) }
      }
      if (ttsResult?.ok === true && ttsResult.data) ttsData = ttsResult.data
    }

    let result = null
    if (Object.keys(patch).length > 0) {
      try {
        result = await save(patch)
      } catch (error) {
        result = { ok: false, error: String(error?.message ?? error) }
      }
    }

    busy = false
    if (saveBtn) saveBtn.disabled = false

    // 只有语音改动时，不被「模型那段没有改动」判成失败。
    const modelOk = result === null || result?.ok === true
    const speechOk = ttsResult === null || ttsResult?.ok === true
    if (!modelOk || !speechOk) {
      const why = [!modelOk ? result?.error : '', !speechOk ? `语音：${ttsResult?.error ?? ''}` : '']
        .filter(Boolean)
        .join(' / ')
      setStatus(`${t('apiSaveFailed')}${why}`, 'error')
      render()
      return
    }

    if (result?.data) data = result.data
    render()
    const notes = [result?.note, ttsResult?.note].filter(Boolean).join('；')
    setStatus(`${t('apiSaved')}${notes ? `\n${notes}` : ''}`, 'ok')
  }

  function setOpen(next, opts = {}) {
    // 与记忆中心同一条纪律：**先互斥、后记账**，否则互斥回调会把自己关掉。
    if (open === next) return
    if (next) setExclusiveOpen('api-config')
    open = next
    if (typeof opts.note === 'string') note = opts.note
    if (root) root.hidden = !next
    document.body.classList.toggle('api-config-open', next)
    onToggle(next)
    // 关抽屉就停轮询：留着定时器会在看不见的地方一直打 passport 接口。
    if (!next) {
      stopBiliPoll()
      hideBiliQr()
      // 微信配对轮询同理：关掉抽屉后看不见二维码，还在打接口就是纯浪费。
      stopWechatPoll()
      hideWechatQr()
    }
    if (next) {
      // 先读文件、再联网复核 —— 顺序反了会被后到的文件快照盖掉 verify 的结果。
      void (async () => {
        await reload()
        await refreshBiliLive()
      })()
    }
  }

  closeBtn?.addEventListener('click', () => setOpen(false))
  reloadBtn?.addEventListener('click', () => void reload())
  saveBtn?.addEventListener('click', () => void submit())
  keyReveal?.addEventListener('click', () => {
    revealed = !revealed
    syncReveal()
  })
  wechatTokenReveal?.addEventListener('click', () => {
    wechatRevealed = !wechatRevealed
    syncReveal()
  })
  biliLoginBtn?.addEventListener('click', () => void beginBiliLogin())
  biliLogoutBtn?.addEventListener('click', () => void doBiliLogout())
  wechatPairBtn?.addEventListener('click', () => void beginWechatPair())
  // ── 语音播报（2026-10-22）──
  // provider 一变就切字段显隐：不切的话用户会看到两组格子堆在一起，
  // 不知道哪一格才是自己要填的（火山的 apiKey 和 OpenAI 的 apiKey 长得一模一样）。
  speechProviderEl?.addEventListener('change', () => syncSpeechBlocks())
  speechVolcanoKeyReveal?.addEventListener('click', () => {
    speechRevealed = !speechRevealed
    syncReveal()
  })
  speechAccessKeyReveal?.addEventListener('click', () => {
    speechRevealed = !speechRevealed
    syncReveal()
  })
  speechOpenaiKeyReveal?.addEventListener('click', () => {
    speechRevealed = !speechRevealed
    syncReveal()
  })
  speechTestBtn?.addEventListener('click', () => void doSpeechTest())

  // 表单里 Ctrl/Cmd+Enter 直接保存（输入框是单行 input，Enter 不该触发保存）。
  root?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return
    event.preventDefault()
    void submit()
  })

  syncReveal()
  applyOptions()
  applyClose()
  if (root) root.hidden = true

  return {
    setOpen,
    isOpen: () => open,
    setLocale: () => {
      for (const [selector, key] of LABELS) {
        const node = document.querySelector(selector)
        if (node) node.textContent = t(key)
      }
      syncReveal()
      applyOptions()
      applyClose()
      render()
    },
  }
}
