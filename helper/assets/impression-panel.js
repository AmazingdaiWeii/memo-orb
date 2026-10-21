/**
 * impression-panel.js —— 记忆中心面板（P0-7「我们的回忆」）。
 *
 * ## 设计依据
 *
 * `记忆中心_落地方案.md` §〇（用户 2026-10-07 重新定义的权威版本）：
 *
 * | 层 | 内容 |
 * |---|---|
 * | 入口 | 只有一个，挂在球的右键菜单里（挨着「历史对话」） |
 * | 内容 | 一份**自然语言写的**「她眼中的你」，不是文件列表、不是键值表 |
 * | 产出| 定时任务（cron），初定一天一次 |
 *
 * host 侧六条协议**已全部实现**（`src/main.mjs` 的 `impression-*` case），
 * 本模块只负责呈现与交互。
 *
 * ## ★ 为什么正文一律用 `textContent`，绝不 `innerHTML`
 *
 * 正文是**模型写的自然语言**，内容不受控。用 `innerHTML` 等于开一个
 * 存储型 XSS 口子：模型某次输出里带一段标签，就能在球的面板里执行脚本，
 * 而球是 `file://` / 本地特权页面，读得到记忆仓库和配置文件。
 *
 * 代价是 Markdown 不渲染（`**粗体**`、`## 标题` 会露出原样）。
 * 这个代价是**故意付的** —— 显示瑕疵远小于特权页被注入。
 * 真要渲染，用「先转义、再按白名单替换少量标记」的纯文本方案，
 * 不要图省事塞一个 Markdown 库进来。
 */

/** 频率三档。键是 host 认的 `everyHours`，值是给人看的标签。 */
const SCHEDULE_OPTIONS = [
  { hours: 24, zh: '每天一次', en: 'Daily' },
  { hours: 168, zh: '每周一次', en: 'Weekly' },
  { hours: 0, zh: '已关闭', en: 'Off' },
]

/**
 * @param {object} options
 * @param {Function} options.send上行：`(action, extra) => void`
 * @param {Function} options.isZh
 * @param {Function} options.setExclusiveOpen 互斥打开（关掉历史面板等）
 * @param {Function} options.onToggle 开合变化通知：`(open) => void`
 * @param {Function} options.openPicker 打开频率菜单：`(spec) => void`，
 *   `spec` 含 `{x, y, items, onPick}`；`onPick` 由本模块提供，负责上行。
 * @param {Function} options.translate 取词条：`(key) => string`
 */
export function createImpressionPanel(options) {
  const send = typeof options.send === 'function' ? options.send : () => {}
  const isZh = typeof options.isZh === 'function' ? options.isZh : () => true
  const setExclusiveOpen = typeof options.setExclusiveOpen === 'function'
    ? options.setExclusiveOpen
    : () => {}
  const t = typeof options.translate === 'function' ? options.translate : (key) => key
  const onToggle = typeof options.onToggle === 'function' ? options.onToggle : () => {}
  /**
   * 打开频率菜单。由 shell 注入 `contextMenu.open` 的封装。
   * 不在本模块里自建菜单 —— 右键菜单、头像选择器都是同一套，
   * 复制一份会出现两套互不兼容的菜单样式和定位逻辑。
   * @param {{x:number,y:number,items:Array}} spec
   */
  const openPicker = typeof options.openPicker === 'function' ? options.openPicker : () => {}

  const root = document.querySelector('#impression')
  const titleEl = document.querySelector('#impression-title')
  const closeBtn = document.querySelector('#impression-close')
  const metaEl = document.querySelector('#impression-meta')
  const warnEl = document.querySelector('#impression-warn')
  const bodyEl = document.querySelector('#impression-body')
  const emptyEl = document.querySelector('#impression-empty')
  const refreshBtn = document.querySelector('#impression-refresh')
  const scheduleBtn = document.querySelector('#impression-schedule')
  const historyBox = document.querySelector('#impression-history')
  const historySummary = document.querySelector('#impression-history-summary')
  const historyList = document.querySelector('#impression-history-list')
  const atBox = document.querySelector('#impression-at')
  const atMeta = document.querySelector('#impression-at-meta')
  const atBody = document.querySelector('#impression-at-body')
  const atBack = document.querySelector('#impression-at-back')

  let open = false
  /** host 最后一次推来的完整数据，渲染的唯一数据源。 */
  let data = null
  /** 手动触发后到回执之间的等待态。 */
  let refreshing = false
  let historyRequested = false

  /**
   * 可重复调用的「只刷文案」。
   *
   * ★ 它同时是对外导出的 `setLocale`（见文件末尾 return），而
   *   `helper/assets/shell.js` 每次切语言/刷主题都会调它 —— 所以这里
   *   **不能**绑任何 addEventListener，否则监听器会一层层叠上去：
   *   点一次「立即执行一次」就发 N 条 send('refresh')，频率选择发 N 次
   *   schedule，host 侧就是 N 次写盘。事件一律放 bindOnce()。
   */
  function applyStatic() {
    titleEl.textContent = t('impressionTitle')
    // ★ `×` 走textContent，不走 innerHTML（虽然这里是字面量，但同一个函数
    //   下面就在处理模型产出的文本，别给后人留一个混用的口子）。
    //   之前只设了 aria-label，按钮**看起来是空的** —— 有 aria-label
    //   读屏能念出来， sighted 用户只看到一个不知道能不能点的方块。
    closeBtn.textContent = '×'
    closeBtn.setAttribute('aria-label', t('impressionClose'))
    refreshBtn.textContent = t('impressionRefresh')
    historySummary.textContent = t('impressionHistory')
    atBack.textContent = t('impressionBack')
  }

  /** 只在初始化时绑一次的事件（理由见 applyStatic 的注释）。 */
  function bindOnce() {
    // ★ 频率选择：自绘按钮 + 复用 shell 的 contextMenu（见 HTML 处的说明）。
    //   按钮本身只显示当前档位文字和一个 ▾，点击时把三档交给外层菜单。
    scheduleBtn.addEventListener('click', () => {
      const rect = scheduleBtn.getBoundingClientRect()
      openPicker({
        x: rect.left,
        y: rect.top,
        items: SCHEDULE_OPTIONS.map((option) => ({
          id: String(option.hours),
          label: isZh() ? option.zh : option.en,
          checked: String(option.hours) === String(data?.everyHours ?? 24),
          payload: { hours: option.hours },
        })),
        onPick: (hours) => {
          const value = Number(hours)
          if (!Number.isFinite(value)) return
          // 立刻改按钮文字，别等 host 回包 —— 否则点了看着像没反应。
          // host 推回新数据后 syncFooter 会用权威值覆盖它。
          data = { ...(data ?? {}), everyHours: value }
          syncFooter()
          send('schedule', { everyHours: value })
        },
      })
    })
    closeBtn.addEventListener('click', () => setOpen(false))
    refreshBtn.addEventListener('click', () => {
      // 防连点：一次触发要等她跑完（可能一两分钟），期间禁用按钮。
      if (refreshing) return
      refreshing = true
      syncFooter()
      send('refresh')
    })
    atBack.addEventListener('click', () => {
      atBox.hidden = true
    })
    // 历史版本默认收起（只在这里设一次 —— 切语言不该把用户展开的列表收回去），
    // 且第一次展开时才去要数据（host 侧要扫 git）
    historyBox.hidden = true
    historyBox.addEventListener('toggle', () => {
      if (historyBox.open && !historyRequested) {
        historyRequested = true
        send('history-get')
      }
    })
  }

  function setOpen(next) {
    // ★ 顺序是关键：**先互斥、后记账**。
    //
    // 反过来写（先 `open = next` 再 `setExclusiveOpen`）会把自己刚打开的面板
    // 又关掉：`setExclusiveOpen` → `setHistoryOpen(false)` → 它那侧无条件回调
    // `impressionPanel.setOpen(false)`，此时 `open` 已经是 `true`，
    // 不等于 `false`，守卫挡不住 → 面板开一下就没。
    //
    // 先调互斥时 `open` 还是旧值 `false`，回调进来的 `setOpen(false)`
    // 被下面的幂等守卫挡掉，递归到此终止（不需要额外的递归标志位）。
    if (open === next) return
    if (next) setExclusiveOpen('impression')
    open = next
    root.hidden = !next
    // 记忆中心打开时，隐藏底层的输入框和装饰区域（与历史面板一致）
    document.body.classList.toggle('impression-open', next)
    // 通知外层：抽屉开关会改变「谁是当前视图」，`#transcript` 的显隐、
    // GIF 图层的暂停等都在外层统一收口，不要在这里各自为政。
    onToggle(next)
    if (next) send('get')
  }

  /** 底部按钮的等待态。 */
  function syncFooter() {
    refreshBtn.disabled = refreshing
    refreshBtn.textContent = refreshing
      ? t('impressionRefreshing')
      : (data !== null && data.ok === true && data.everyHours === 0
        ? t('impressionRefreshDisabled')
        : t('impressionRefresh'))
    if (data !== null) {
      // ★ 按钮文字 = 当前档位 + ▾（原生 <select> 换成自绘后的对应物）。
      //   `everyHours` 缺失时按 24兜底 —— host 侧老会话可能没这个字段。
      const hours = Number(data.everyHours ?? 24)
      const current = SCHEDULE_OPTIONS.find((option) => option.hours === hours)
      scheduleBtn.textContent = `${current ? (isZh() ? current.zh : current.en) : hours} ▾`
      scheduleBtn.setAttribute('aria-label', t('impressionSchedule'))
      scheduleBtn.dataset.hours = String(hours)
    }
  }

  /** 把 host 推来的数据画出来。 */
  function render() {
    if (data === null) return
    if (data.loading === true) {
      emptyEl.hidden = false
      emptyEl.textContent = t('impressionLoading')
      bodyEl.textContent = ''
      metaEl.textContent = ''
      warnEl.hidden = true
      syncFooter()
      return
    }
    if (data.ok !== true) {
      bodyEl.textContent = ''
      metaEl.textContent = ''
      emptyEl.hidden = false
      emptyEl.textContent = `${t('impressionFailed')}${data.error ?? ''}`
      warnEl.hidden = true
      syncFooter()
      return
    }

    const text = typeof data.text === 'string' ? data.text.trim() : ''
    const exists = data.exists === true && text !== ''
    emptyEl.hidden = exists
    bodyEl.textContent = text
    if (!exists) {
      emptyEl.textContent = data.seededOnly === true
        ? t('impressionEmpty')
        : t('impressionMissing')
    }

    // 元信息：更新时间 + 下次计划。两者都来自 host，别自己算「多久以前」。
    const bits = []
    if (data.updatedAgo) bits.push(`${t('impressionUpdated')} ${data.updatedAgo}`)
    if (data.nextDueAt && data.everyHours !== 0) {
      bits.push(`${t('impressionNext')} ${formatClock(data.nextDueAt)}`)
    } else if (data.everyHours === 0) {
      bits.push(t('impressionOff'))
    }
    metaEl.textContent = bits.join(' · ')

    // 警告：只说人话，不把 'missing-frontmatter' 这类内部码丢给用户。
    const warns = []
    if (typeof data.lastError === 'string' && data.lastError !== '') warns.push(data.lastError)
    if (data.historyStale === true) warns.push(t('impressionStale'))
    warnEl.hidden = warns.length === 0
    warnEl.textContent = warns.join(' ')

    syncFooter()
  }

  function formatClock(value) {
    const at = Date.parse(String(value))
    if (!Number.isFinite(at)) return ''
    const d = new Date(at)
    const pad = (n) => String(n).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  // ── host 下行 ────────────────────────────────────────────────────────

  function onPayload(payload) {
    if (payload === null || typeof payload !== 'object') return
    switch (payload.type) {
      case 'impression': {
        data = payload
        // 收到带loading 的包时不清掉 refreshing —— 回执可能还没到。
        if (payload.loading !== true && payload.ok === true) refreshing = false
        render()
        return
      }
      case 'impression-result': {
        refreshing = false
        if (payload.ok === true) {
          // 成功不在这里下结论：文件什么时候写完由 host 的后续 impression 推送说了算。
          emptyEl.hidden = false
          emptyEl.textContent = t('impressionTriggered')
        } else {
          emptyEl.hidden = false
          emptyEl.textContent = `${t('impressionFailed')}${payload.error ?? ''}`
        }
        syncFooter()
        return
      }
      case 'impression-history': {
        historyList.replaceChildren()
        const commits = Array.isArray(payload.commits) ? payload.commits : []
        if (payload.ok !== true || commits.length === 0) {
          const empty = document.createElement('p')
          empty.className = 'impression-empty'
          empty.textContent = payload.ok !== true
            ? `${t('impressionHistoryFailed')}${payload.error ?? ''}`
            : t('impressionHistoryEmpty')
          historyList.append(empty)
          return
        }
        for (const commit of commits) {
          const row = document.createElement('button')
          row.type = 'button'
          row.className = 'impression-commit'
          const date = document.createElement('span')
          date.className = 'impression-commit-date'
          date.textContent = String(commit.date ?? '')
          const subject = document.createElement('span')
          subject.className = 'impression-commit-subject'
          // ⚠️ textContent：subject 是 git commit message，同样当不可信内容处理
          subject.textContent = String(commit.subject ?? '')
          row.append(date, subject)
          row.addEventListener('click', () => {
            atBox.hidden = false
            atMeta.textContent = `${t('impressionVersion')} ${formatClock(commit.date)}`
            atBody.textContent = t('impressionVersionLoading')
            send('at-get', { sha: String(commit.sha ?? '') })
          })
          historyList.append(row)
        }
        return
      }
      case 'impression-at': {
        if (payload.ok !== true) {
          atBody.textContent = `${t('impressionVersionFailed')}${payload.error ?? ''}`
          return
        }
        atBody.textContent = String(payload.text ?? '')
        if (typeof payload.date === 'string' && payload.date !== '') {
          atMeta.textContent = `${t('impressionVersion')} ${formatClock(payload.date)}`
        }
        return
      }
      default:
    }
  }

  bindOnce()
  applyStatic()
  render()

  // ★ `setLocale` 故意指向 applyStatic（只刷文案、不重绑事件）——
  //   shell.js 在切语言/刷主题时会反复调它。
  return { setOpen, onPayload, isOpen: () => open, setLocale: applyStatic }
}