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
  ['#api-wechat-enabled-label', 'apiWechatEnabled'],
  ['#api-wechat-token-label', 'apiWechatToken'],
  ['#api-wechat-base-url-label', 'apiWechatBaseUrl'],
  ['#api-group-bili', 'apiGroupBili'],
  ['#api-bili-login', 'apiBiliLogin'],
  ['#api-bili-logout', 'apiBiliLogout'],
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

  let open = false
  let data = null
  let busy = false
  let revealed = false
  let wechatRevealed = false
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

  function render() {
    if (noteEl) {
      noteEl.textContent = note
      noteEl.hidden = note === ''
    }
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
    busy = false
    if (reloadBtn) reloadBtn.disabled = false
    if (data?.ok !== true) {
      setStatus(`${t('apiLoadFailed')}${data?.error ?? ''}`, 'error')
      return
    }
    note = ''
    render()
  }

  async function submit() {
    if (busy) return
    const patch = patchFromForm()
    if (Object.keys(patch).length === 0) {
      setStatus(t('apiNoChange'), 'info')
      return
    }
    busy = true
    if (saveBtn) saveBtn.disabled = true
    setStatus(t('apiSaving'), 'info')
    let result = null
    try {
      result = await save(patch)
    } catch (error) {
      result = { ok: false, error: String(error?.message ?? error) }
    }
    busy = false
    if (saveBtn) saveBtn.disabled = false
    if (result?.ok !== true) {
      setStatus(`${t('apiSaveFailed')}${result?.error ?? ''}`, 'error')
      return
    }
    data = result.data ?? data
    render()
    setStatus(`${t('apiSaved')}${result.note ? `\n${result.note}` : ''}`, 'ok')
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
