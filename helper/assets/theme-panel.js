/**
 * theme-panel.js —— 「主题」抽屉（用户 m02033）。
 *
 * 用户原话：「环形菜单中需要额外加入一个主题菜单，其不仅提供了黑白两色的
 * 主题切换，还支持自定义分别导入前文三个页面的背景。」
 *
 * 两件事：
 *   1. **外观**三态（跟随系统 / 浅色 / 深色）—— 真源是主进程的
 *      `nativeTheme.themeSource`（`orb:theme-set`）。它一变，**所有窗口**
 *      （球窗口、环菜单、划词工具条）的 prefers-color-scheme 一起翻，
 *      渲染层不必各存一份，也不会和 host 推来的 appearance 打架
 *      （`auto` 才跟随 host，`light`/`dark` 顶掉它）。
 *   2. **三张页面背景**（对话页 / 历史对话 / 我们的回忆）—— 每槽可导入、清除、
 *      选适配方式、调蒙层浓度；真源是 `helper/assets/backgrounds/` +
 *      `logs/window-state.json`（`orb:bg-*`）。
 *
 * ★ 本模块只呈现与收集输入，不做文件 IO、不碰 localStorage。
 * ★ 形态与 `api-config.js` 一致：占满内容区的抽屉、与其它抽屉互斥、
 *   `setOpen` 里**先互斥、后记账**（否则互斥回调会把自己关掉）。
 * ★ 关闭按钮的文字与无障碍名必须成对给（`api-config.js:98-117` 的事故：
 *   只设 aria-label 的按钮肉眼看来是空方块；而函数漏定义会让整个 `main()`
 *   在初始化期中断、所有球窗口监听集体失效）。
 * ★ 三态按钮与三张槽卡由本模块用 `createElement` 建（HTML 里不放中文字面量，
 *   文案一律走 `t()`），槽卡结构见浮动窗口 #theme 段。
 */

import { BG_SLOTS, safeBackgroundUrl } from './backgrounds.js'

const MODES = ['auto', 'light', 'dark']
const MODE_KEYS = { auto: 'themeModeAuto', light: 'themeModeLight', dark: 'themeModeDark' }
const SLOT_KEYS = { chat: 'themeSlotChat', history: 'themeSlotHistory', recall: 'themeSlotRecall' }
const FITS = ['cover', 'contain', 'auto']
const FIT_KEYS = { cover: 'themeFitCover', contain: 'themeFitContain', auto: 'themeFitAuto' }
const SCRIM_DEFAULT = 0.55
const SCRIM_MAX = 0.9
const SCRIM_STEP = 0.05

/** 静态文案：`applyStatic()` 逐条刷（按钮/标题/标签，全走 textContent）。 */
const LABELS = [
  ['#theme-title', 'themeTitle'],
  ['#theme-mode-label', 'themeMode'],
  ['#theme-bg-label', 'themeBg'],
  ['#theme-bg-hint', 'themeBgHint'],
  ['#theme-open-folder', 'themeOpenFolder'],
]

function messageOf(error) {
  return String(error?.message ?? error)
}

export function createThemePanel(options = {}) {
  const t = typeof options.translate === 'function' ? options.translate : (key) => key
  const setExclusiveOpen = typeof options.setExclusiveOpen === 'function' ? options.setExclusiveOpen : () => {}
  const onToggle = typeof options.onToggle === 'function' ? options.onToggle : () => {}
  const getTheme = typeof options.getTheme === 'function' ? options.getTheme : async () => null
  const setTheme = typeof options.setTheme === 'function' ? options.setTheme : async () => null
  const getBackgrounds = typeof options.getBackgrounds === 'function' ? options.getBackgrounds : async () => null
  const importBackground = typeof options.importBackground === 'function' ? options.importBackground : async () => null
  const clearBackground = typeof options.clearBackground === 'function' ? options.clearBackground : async () => null
  const updateBackground = typeof options.updateBackground === 'function' ? options.updateBackground : async () => null
  const openFolder = typeof options.openFolder === 'function' ? options.openFolder : () => {}

  const root = document.querySelector('#theme')
  const closeBtn = document.querySelector('#theme-close')
  const noteEl = document.querySelector('#theme-note')
  const modeGroup = document.querySelector('#theme-mode')
  const slotList = document.querySelector('#theme-bg-list')
  const folderBtn = document.querySelector('#theme-open-folder')

  let open = false
  /** '' = 空闲；其它值 = 正在处理（按钮全体禁用，防重入）。 */
  let busy = ''
  let mode = 'auto'
  let slots = {}
  let note = ''

  const modeButtons = new Map()
  const cards = new Map()

  for (const [selector, key] of LABELS) {
    const node = document.querySelector(selector)
    if (node) node.textContent = t(key)
  }

  function applyClose() {
    if (!closeBtn) return
    closeBtn.textContent = '×'
    closeBtn.setAttribute('aria-label', t('themeClose'))
  }

  function setNote(text) {
    note = text
    if (!noteEl) return
    noteEl.textContent = text
    noteEl.hidden = text === ''
  }

  function entryFor(slot) {
    const entry = slots?.[slot]
    return entry && typeof entry === 'object' ? entry : null
  }

  function hasImage(slot) {
    return safeBackgroundUrl(entryFor(slot)?.url) !== ''
  }

  /** 主进程快照 → 本地状态。返回值里就带着 `slots`，所以不必再发一次查询。 */
  function applySnapshot(payload) {
    if (!payload || typeof payload !== 'object') return
    if (payload.slots && typeof payload.slots === 'object') slots = payload.slots
  }

  function buildModes() {
    if (!modeGroup) return
    modeGroup.textContent = ''
    for (const value of MODES) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.setAttribute('role', 'radio')
      btn.dataset.mode = value
      btn.textContent = t(MODE_KEYS[value])
      btn.addEventListener('click', () => void chooseMode(value))
      modeGroup.append(btn)
      modeButtons.set(value, btn)
    }
  }

  function buildSlot(slot) {
    if (!slotList) return
    const card = document.createElement('div')
    card.className = 'theme-slot'
    card.dataset.slot = slot

    const head = document.createElement('div')
    head.className = 'theme-slot-head'
    const name = document.createElement('span')
    name.className = 'theme-slot-name'
    name.textContent = t(SLOT_KEYS[slot])
    const file = document.createElement('span')
    file.className = 'theme-slot-file'
    head.append(name, file)

    const preview = document.createElement('div')
    preview.className = 'theme-slot-preview'

    const actions = document.createElement('div')
    actions.className = 'theme-slot-actions'
    const importBtn = document.createElement('button')
    importBtn.type = 'button'
    importBtn.textContent = t('themeImport')
    const clearBtn = document.createElement('button')
    clearBtn.type = 'button'
    clearBtn.textContent = t('themeClear')
    actions.append(importBtn, clearBtn)

    const fitLabel = document.createElement('span')
    fitLabel.className = 'theme-slot-fit-label'
    fitLabel.textContent = t('themeFitLabel')

    const fitRow = document.createElement('div')
    fitRow.className = 'theme-slot-fit'
    const fitButtons = new Map()
    for (const fit of FITS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.setAttribute('role', 'radio')
      btn.dataset.fit = fit
      btn.textContent = t(FIT_KEYS[fit])
      btn.addEventListener('click', () => void chooseFit(slot, fit))
      fitRow.append(btn)
      fitButtons.set(fit, btn)
    }

    const scrimLabel = document.createElement('span')
    scrimLabel.className = 'theme-slot-scrim-label'
    const scrimInput = document.createElement('input')
    scrimInput.type = 'range'
    scrimInput.min = '0'
    scrimInput.max = String(SCRIM_MAX)
    scrimInput.step = String(SCRIM_STEP)
    scrimInput.setAttribute('aria-label', t('themeScrim'))
    const scrimWrap = document.createElement('label')
    scrimWrap.className = 'theme-slot-scrim'
    scrimWrap.append(scrimLabel, scrimInput)

    card.append(head, preview, actions, fitLabel, fitRow, scrimWrap)
    slotList.append(card)

    cards.set(slot, { card, file, preview, importBtn, clearBtn, fitButtons, scrimLabel, scrimInput })

    importBtn.addEventListener('click', () => void pickImage(slot))
    clearBtn.addEventListener('click', () => void dropImage(slot))
    // 拖动中只刷新数字（不发 IPC）；松手才落盘，免得一拖几十次写盘。
    scrimInput.addEventListener('input', () => {
      scrimLabel.textContent = `${t('themeScrim')} ${Math.round(Number(scrimInput.value) * 100)}%`
    })
    scrimInput.addEventListener('change', () => void chooseScrim(slot, Number(scrimInput.value)))
  }

  function renderModes() {
    const disabled = busy !== ''
    for (const [value, btn] of modeButtons) {
      btn.setAttribute('aria-checked', String(value === mode))
      btn.disabled = disabled
    }
  }

  function renderSlot(slot) {
    const card = cards.get(slot)
    if (!card) return
    const entry = entryFor(slot)
    const url = safeBackgroundUrl(entry?.url)
    const has = url !== ''
    const working = busy !== ''

    card.file.textContent = has ? String(entry?.file ?? url) : t('themeNoImage')
    card.preview.style.backgroundImage = has ? `url("${url}")` : ''
    card.preview.classList.toggle('has-image', has)

    const fit = FITS.includes(entry?.fit) ? entry.fit : 'cover'
    for (const [value, btn] of card.fitButtons) {
      btn.setAttribute('aria-checked', String(value === fit))
      btn.disabled = working || !has
    }

    const scrim = Number.isFinite(Number(entry?.scrim)) ? Number(entry.scrim) : SCRIM_DEFAULT
    card.scrimInput.value = String(scrim)
    card.scrimInput.disabled = working || !has
    card.scrimLabel.textContent = `${t('themeScrim')} ${Math.round(scrim * 100)}%`

    card.importBtn.disabled = working
    card.clearBtn.disabled = working || !has
  }

  function render() {
    renderModes()
    for (const slot of BG_SLOTS) renderSlot(slot)
    if (folderBtn) folderBtn.disabled = false
  }

  async function reload() {
    if (busy !== '') return
    busy = 'load'
    setNote(t('themeLoading'))
    render()
    let theme = null
    let backgrounds = null
    try {
      theme = await getTheme()
    } catch (error) {
      theme = { ok: false, error: messageOf(error) }
    }
    try {
      backgrounds = await getBackgrounds()
    } catch (error) {
      backgrounds = { ok: false, error: messageOf(error) }
    }
    busy = ''
    if (theme?.ok === true && MODES.includes(theme.mode)) mode = theme.mode
    applySnapshot(backgrounds)
    if (theme?.ok !== true) {
      setNote(`${t('themeLoadFailed')}${theme?.error ?? ''}`)
      render()
      return
    }
    if (backgrounds?.ok !== true) {
      setNote(`${t('themeLoadFailed')}${backgrounds?.error ?? ''}`)
      render()
      return
    }
    setNote('')
    render()
  }

  async function chooseMode(next) {
    if (busy !== '' || !MODES.includes(next)) return
    const previous = mode
    // 乐观更新：明暗切换是即时视觉反馈，等一个 IPC 往返会「顿一下」。
    mode = next
    renderModes()
    busy = 'theme'
    render()
    let result = null
    try {
      result = await setTheme(next)
    } catch (error) {
      result = { ok: false, error: messageOf(error) }
    }
    busy = ''
    if (result?.ok !== true) {
      mode = previous
      renderModes()
      setNote(`${t('themeFailed')}${result?.error ?? ''}`)
      render()
      return
    }
    if (MODES.includes(result.mode)) mode = result.mode
    setNote('')
    render()
  }

  async function pickImage(slot) {
    if (busy !== '' || !BG_SLOTS.includes(slot)) return
    busy = slot
    setNote(t('themeBusy'))
    render()
    let result = null
    try {
      result = await importBackground(slot)
    } catch (error) {
      result = { ok: false, error: messageOf(error) }
    }
    busy = ''
    if (result?.ok !== true) {
      // 用户点了「取消」不是错误，别把红字怼到他脸上。
      setNote(result?.canceled === true ? '' : `${t('themeFailed')}${result?.error ?? ''}`)
      render()
      return
    }
    applySnapshot(result)
    setNote(t('themeImported'))
    render()
  }

  async function dropImage(slot) {
    if (busy !== '' || !BG_SLOTS.includes(slot) || !hasImage(slot)) return
    busy = slot
    setNote(t('themeBusy'))
    render()
    let result = null
    try {
      result = await clearBackground(slot)
    } catch (error) {
      result = { ok: false, error: messageOf(error) }
    }
    busy = ''
    if (result?.ok !== true) {
      setNote(`${t('themeFailed')}${result?.error ?? ''}`)
      render()
      return
    }
    applySnapshot(result)
    setNote(t('themeCleared'))
    render()
  }

  async function patchSlot(slot, patch) {
    if (busy !== '' || !BG_SLOTS.includes(slot)) return
    busy = slot
    render()
    let result = null
    try {
      result = await updateBackground({ slot, ...patch })
    } catch (error) {
      result = { ok: false, error: messageOf(error) }
    }
    busy = ''
    if (result?.ok !== true) setNote(`${t('themeFailed')}${result?.error ?? ''}`)
    else {
      applySnapshot(result)
      setNote('')
    }
    render()
  }

  function chooseFit(slot, fit) {
    if (!FITS.includes(fit) || !hasImage(slot)) return
    void patchSlot(slot, { fit })
  }

  function chooseScrim(slot, value) {
    if (!hasImage(slot)) return
    const scrim = Math.min(SCRIM_MAX, Math.max(0, Number(value)))
    // 先就地上屏（拖动松手那一刻就要看到浓度变化），落盘走 IPC。
    const entry = entryFor(slot)
    if (entry) slots[slot] = { ...entry, scrim }
    void patchSlot(slot, { scrim })
  }

  function setOpen(next, opts = {}) {
    // 与记忆中心/API 配置同一条纪律：**先互斥、后记账**。
    if (open === next) return
    if (next) setExclusiveOpen('theme')
    open = next
    if (typeof opts.note === 'string') setNote(opts.note)
    if (root) root.hidden = !next
    document.body.classList.toggle('theme-open', next)
    onToggle(next)
    if (next) void reload()
  }

  buildModes()
  for (const slot of BG_SLOTS) buildSlot(slot)
  applyClose()
  for (const [selector, key] of LABELS) {
    const node = document.querySelector(selector)
    if (node) node.textContent = t(key)
  }

  closeBtn?.addEventListener('click', () => setOpen(false))
  folderBtn?.addEventListener('click', () => openFolder())

  if (root) root.hidden = true

  return {
    setOpen,
    isOpen: () => open,
    /** 主进程另有一条 `orb:backgrounds` 广播（别的窗口改了也同步），走这里。 */
    applyBackgrounds: (payload) => {
      applySnapshot(payload)
      render()
    },
    applyTheme: (payload) => {
      if (payload && MODES.includes(payload.mode)) mode = payload.mode
      renderModes()
    },
    setLocale: () => {
      for (const [selector, key] of LABELS) {
        const node = document.querySelector(selector)
        if (node) node.textContent = t(key)
      }
      for (const [value, btn] of modeButtons) btn.textContent = t(MODE_KEYS[value])
      for (const [slot, card] of cards) {
        card.card.querySelector('.theme-slot-name').textContent = t(SLOT_KEYS[slot])
        card.card.querySelector('.theme-slot-fit-label').textContent = t('themeFitLabel')
        card.importBtn.textContent = t('themeImport')
        card.clearBtn.textContent = t('themeClear')
        for (const [fit, btn] of card.fitButtons) btn.textContent = t(FIT_KEYS[fit])
        card.scrimInput.setAttribute('aria-label', t('themeScrim'))
      }
      applyClose()
      render()
    },
  }
}
