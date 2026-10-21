/**
 * bili-history-panel.js —— 「看过的视频」抽屉。
 *
 * 页面的来历：环菜单原来那项「打开旧后端界面」在 10-19 剥离后端后点了没反应，
 * 用户要求把它改造成「她在 B 站看过什么」。
 *
 * 2026-10-21 夜按用户意见重排成**上下两块**：
 *   上「我喜欢的」—— liked 有值的那些；点一条 → 二级面板看「我喜欢的理由 / 想对作者说的话」
 *   下「我看过的」—— 全部账本条目
 * 每块只露最近 2 条，更早的收进 `<details>`（用户说的「下拉菜单」）。
 *
 * 2026-10-21 深夜再按用户意见改了一版（**当前形态**）：
 *   · 顶部大标题「看过的视频」与下面「共 N 条…」那行**删掉**（多余，腾地方）；
 *     板块标题改用原来那个大标题的**格式**。
 *   · 每条只留「标题 + 概览」。概览 = 她看完之后自己写的一句「这视频大概讲了什么」
 *     （主进程看完视频后用真实关键帧生成，见 src/main.mjs 的 summarizeVideo）。
 *     画质 / 看过几次 / 取了哪几秒这些技术信息**全部不显示** —— 用户嫌它们占地方也没用。
 *   · 「观看时间 + 视频时长」放到原来「B 站」按钮那一格。
 *     「B 站」入口没丢：看的块点标题即开；喜欢的块在二级面板里有「在 B 站看原片」。
 *
 * ★ 形态与其它抽屉一致：占满内容区、互斥、`setOpen` 里**先互斥后记账**。
 * ★ 全部文案走 `t()`；行内容一律 textContent —— 标题是 B 站返回的第三方字符串。
 * ★ 「发送评论」是**公开发言**（会署用户的账号出现在评论区），必须二次确认后才调。
 */

const LABELS = [
  ['#bili-liked-title', 'biliLikedTitle'],
  ['#bili-watched-title', 'biliWatchedTitle'],
  ['#bili-liked-empty', 'biliLikedEmpty'],
  ['#bili-watched-empty', 'biliWatchedEmpty'],
  ['#bili-note-summary-label', 'biliNoteSummaryLabel'],
  ['#bili-note-reason-label', 'biliNoteReasonLabel'],
  ['#bili-note-comment-label', 'biliNoteCommentLabel'],
  ['#bili-note-send', 'biliNoteSend'],
  ['#bili-note-regen', 'biliNoteRegen'],
  ['#bili-note-cancel', 'biliNoteCancel'],
  ['#bili-note-summary-write', 'biliNoteSummaryWrite'],
  ['#bili-note-open-bili', 'biliNoteOpenBili'],
]

/** 每块默认露几条（用户要求：最近两个）。 */
const VISIBLE = 2

/** 秒 → `3:33`（视频时长）。 */
function clock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const p = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`
}

export function createBiliHistoryPanel(options = {}) {
  const t = typeof options.translate === 'function' ? options.translate : (key) => key
  const setExclusiveOpen = typeof options.setExclusiveOpen === 'function' ? options.setExclusiveOpen : () => {}
  const onToggle = typeof options.onToggle === 'function' ? options.onToggle : () => {}
  const fetchHistory = typeof options.fetchHistory === 'function' ? options.fetchHistory : async () => null
  const openExternal = typeof options.openExternal === 'function' ? options.openExternal : () => {}
  const act = typeof options.act === 'function' ? options.act : async () => ({ ok: false, error: 'no-op' })
  /** 删除单条（用户 2026-10-22：底部「刷新 / 清空记录」整条删掉，改每条自带删除）。 */
  const removeItem = typeof options.removeItem === 'function' ? options.removeItem : async () => ({ ok: false, error: 'no-op' })
  const compose = typeof options.compose === 'function' ? options.compose : async () => ({ ok: false, error: 'no-op' })
  const summaryWrite = typeof options.summaryWrite === 'function' ? options.summaryWrite : async () => ({ ok: false, error: 'no-op' })
  const noteSave = typeof options.noteSave === 'function' ? options.noteSave : async () => ({ ok: false })
  const commentSend = typeof options.commentSend === 'function' ? options.commentSend : async () => ({ ok: false })

  const root = document.querySelector('#bili-history')
  const closeBtn = document.querySelector('#bili-history-close')
  /** 列表页的状态行：动作的成败**必须在这里可见** —— 二级面板里的 #bili-note-status
   *  在列表页是隐藏的，早先的错误全写在那儿，点了按钮等于毫无反馈（用户 2026-10-22 报「根本不生效」）。 */
  const listStatus = document.querySelector('#bili-history-status')

  const likedList = document.querySelector('#bili-liked-list')
  const likedMore = document.querySelector('#bili-liked-more')
  const likedMoreSummary = document.querySelector('#bili-liked-more-summary')
  const likedOlder = document.querySelector('#bili-liked-older')
  const likedEmpty = document.querySelector('#bili-liked-empty')

  const watchedList = document.querySelector('#bili-watched-list')
  const watchedMore = document.querySelector('#bili-watched-more')
  const watchedMoreSummary = document.querySelector('#bili-watched-more-summary')
  const watchedOlder = document.querySelector('#bili-watched-older')
  const watchedEmpty = document.querySelector('#bili-watched-empty')

  const noteBox = document.querySelector('#bili-note')
  const noteTitle = document.querySelector('#bili-note-title')
  const noteSummary = document.querySelector('#bili-note-summary')
  const noteReason = document.querySelector('#bili-note-reason')
  const noteComment = document.querySelector('#bili-note-comment')
  const noteStatus = document.querySelector('#bili-note-status')
  const noteSend = document.querySelector('#bili-note-send')
  const noteRegen = document.querySelector('#bili-note-regen')
  const noteCancel = document.querySelector('#bili-note-cancel')
  const noteSummaryWrite = document.querySelector('#bili-note-summary-write')
  const noteOpenBili = document.querySelector('#bili-note-open-bili')

  let open = false
  /** 正在等接口的项（bvid#cid + 动作），用来禁掉重复点击。 */
  let busy = ''
  /** 正在等她写文案的项。 */
  let composing = ''
  let items = []
  let liked = []
  /** 二级面板当前看的是哪条（null = 在列表页）。 */
  let noteItem = null
  let statusText = ''

  function applyStatic() {
    for (const [selector, key] of LABELS) {
      const node = document.querySelector(selector)
      if (node) node.textContent = t(key)
    }
    if (closeBtn) {
      closeBtn.textContent = '×'
      closeBtn.setAttribute('aria-label', t('biliHistoryClose'))
    }
    if (noteComment) noteComment.maxLength = 1000
  }

  function setStatus(text) {
    statusText = String(text || '')
    // 两处都写：二级面板里看 #bili-note-status，列表页看 #bili-history-status。
    // 只写前者的话，列表页点「赞 / 币 / 藏」失败时**一点动静都没有**。
    if (noteStatus) {
      noteStatus.textContent = statusText
      noteStatus.hidden = statusText === ''
    }
    if (listStatus) {
      listStatus.textContent = statusText
      listStatus.hidden = statusText === '' || Boolean(noteItem)
    }
  }

  /**
   * 「什么时候看的 · 多长」。
   *
   * ★ 这是唯一保留的技术信息（用户 2026-10-21 深夜点名要留在「B 站」那一格）：
   *   什么时候看的、这条有多长 —— 别的（画质、看过几次、看了哪几秒）全删。
   */
  function whenLine(it) {
    const bits = []
    if (it.when) bits.push(String(it.when))
    if (Number(it.duration) > 0) bits.push(clock(it.duration))
    return bits.join(' · ')
  }

  /**
   * 概览：她看完之后自己写的那一句。
   * 没有就退化成占位（灰色）：没取过画面的说「只看了元信息」，其余说「还没写概览」。
   */
  function summaryOf(it) {
    const s = String(it.summary || '').trim()
    if (s) return { text: s, empty: false }
    const noFrames = !Array.isArray(it.frameTimes) || it.frameTimes.length === 0
    return { text: t(noFrames ? 'biliHistoryInfoOnly' : 'biliSummaryEmpty'), empty: true }
  }

  function keyOf(it) {
    return `${it.bvid}#${it.cid}`
  }

  function urlOf(it) {
    return `https://www.bilibili.com/video/${it.bvid}${it.page > 1 ? `?p=${it.page}` : ''}`
  }

  /**
   * 一个动作小按钮。`done` 为真时显示已完成态并禁用
   *（赞/投币/收藏都是「做过了就再做没意义」的操作，B 站那边也会回 65006 之类）。
   */
  function chip({ id, label, done, onTap }) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `bili-chip${done ? ' is-done' : ''}`
    b.dataset.chip = id
    b.textContent = label
    b.disabled = done || busy !== ''
    if (done) b.setAttribute('aria-pressed', 'true')
    b.addEventListener('click', (event) => {
      event.stopPropagation()
      if (busy) return
      onTap()
    })
    return b
  }

  function buildRow(it, block) {
    const row = document.createElement('div')
    row.className = 'bili-row'
    row.dataset.bvid = it.bvid

    const main = document.createElement('button')
    main.type = 'button'
    main.className = 'bili-row-main'

    const title = document.createElement('span')
    title.className = 'bili-row-title'
    // ★ 分 P 视频里 B 站常常把 part 填成与主标题同一句 —— 不去重的话
    //   界面上就是「XXX · XXX」（用户 2026-10-22 截图里一眼就看到了）。
    //   只在两段**确实不同**时才拼。
    const part = String(it.pageTitle || '').trim()
    const fullTitle = String(it.title || '').trim()
    title.textContent = part && part !== fullTitle ? `${fullTitle} · ${part}` : fullTitle

    const sum = document.createElement('span')
    sum.className = 'bili-row-summary'
    const s = summaryOf(it)
    sum.textContent = s.text
    if (s.empty) sum.classList.add('is-empty')

    main.append(title, sum)

    // 喜欢的条目点进去看「理由 / 想说的话」（用户明确要求）；看过的点开 B 站。
    main.addEventListener('click', () => {
      if (block === 'liked') openNote(it)
      else openExternal(urlOf(it))
    })

    if (block === 'liked') {
      const hint = document.createElement('span')
      hint.className = 'bili-row-hint'
      hint.textContent = t('biliLikedHint')
      main.append(hint)
    }

    const acts = document.createElement('div')
    acts.className = 'bili-row-acts'
    const a = it.actions && typeof it.actions === 'object' ? it.actions : {}
    acts.append(
      chip({
        id: 'like',
        label: a.like === true ? t('biliActLiked') : t('biliActLike'),
        done: a.like === true,
        onTap: () => void doAct(it, 'like'),
      }),
      chip({
        id: 'coin',
        label: Number(a.coin) > 0 ? t('biliActCoined') : t('biliActCoin'),
        done: Number(a.coin) > 0,
        onTap: () => void doAct(it, 'coin'),
      }),
      chip({
        id: 'fav',
        label: a.fav === true ? t('biliActFaved') : t('biliActFav'),
        done: a.fav === true,
        onTap: () => void doAct(it, 'fav'),
      }),
    )
    // ★ 原来这一格是「B 站」按钮（用户 2026-10-21 深夜：这个位置放时间与时长）。
    //   「B 站」入口没丢 —— 看的块点标题即开；喜欢的块在二级面板里有「在 B 站看原片」。
    const when = document.createElement('span')
    when.className = 'bili-row-when'
    when.textContent = whenLine(it)
    acts.append(when)

    // 单条删除（用户 2026-10-22）：底部「刷新 / 清空记录」整条不要了，
    // 每条自己带一个删除 —— 页面因此腾出一整条高度，排版可以放松。
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'bili-row-del'
    del.dataset.del = keyOf(it)
    del.title = t('biliHistoryDelete')
    del.setAttribute('aria-label', t('biliHistoryDelete'))
    // 静态图标，不含任何第三方字符串 —— 用 innerHTML 只为少写十几行 createElementNS。
    del.innerHTML =
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
      '<path d="M3 4.6h10M6.4 4.6V3.2h3.2v1.4M4.6 4.6l.55 8.1h5.7l.55-8.1" ' +
      'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>'
    del.disabled = busy !== ''
    del.addEventListener('click', (event) => {
      event.stopPropagation()
      if (busy) return
      const ask = t('biliHistoryDeleteConfirm').replace('{title}', String(it.title || '').slice(0, 40))
      if (!window.confirm(ask)) return
      void doDelete(it)
    })
    acts.append(del)

    row.append(main, acts)
    return row
  }

  /** 一块 = 前两条 + 「更早的 N 条」下拉。 */
  function renderBlock(list, container, more, summary, older, emptyEl) {
    if (!container) return
    container.textContent = ''
    if (older) older.textContent = ''

    if (emptyEl) emptyEl.hidden = list.length !== 0
    if (!list.length) {
      if (more) more.hidden = true
      return
    }
    const head = list.slice(0, VISIBLE)
    const rest = list.slice(VISIBLE)
    for (const it of head) container.append(buildRow(it, container === likedList ? 'liked' : 'watched'))
    if (more && older && rest.length) {
      more.hidden = false
      if (summary) summary.textContent = t('biliMoreOlder').replace('{n}', String(rest.length))
      for (const it of rest) older.append(buildRow(it, container === likedList ? 'liked' : 'watched'))
    } else if (more) {
      more.hidden = true
      more.open = false
    }
  }

  function render() {
    renderBlock(liked, likedList, likedMore, likedMoreSummary, likedOlder, likedEmpty)
    renderBlock(items, watchedList, watchedMore, watchedMoreSummary, watchedOlder, watchedEmpty)
  }

  function renderNote() {
    if (!noteBox) return
    const on = Boolean(noteItem)
    noteBox.hidden = !on
    // 二级面板打开时状态只留在面板里，列表页那条收起来（同一句话不显示两遍）
    if (listStatus) listStatus.hidden = on || statusText === ''
    // 二级面板打开时，把两块列表让开（同一块地方只显示一样东西）。
    for (const el of document.querySelectorAll('#bili-history .bili-block')) el.hidden = on
    if (!on) return

    const it = noteItem
    if (noteTitle) noteTitle.textContent = it.title || ''
    if (noteSummary) {
      const s = summaryOf(it)
      noteSummary.textContent = s.text
      noteSummary.classList.toggle('is-empty', s.empty)
    }
    const note = it.liked && typeof it.liked === 'object' ? it.liked : {}
    if (noteReason) {
      const reason = String(note.reason || '').trim()
      noteReason.textContent = reason || (composing === keyOf(it) ? t('biliNoteComposing') : t('biliNoteEmpty'))
    }
    if (noteComment) {
      // 只在用户没在编辑时覆盖，免得她重写的时候把用户打了一半的字冲掉
      if (document.activeElement !== noteComment) noteComment.value = String(note.comment || '')
      noteComment.disabled = Boolean(note.sentAt)
    }
    if (noteSend) {
      noteSend.disabled = Boolean(note.sentAt) || busy !== ''
      noteSend.textContent = note.sentAt ? t('biliNoteSent') : t('biliNoteSend')
    }
    if (noteRegen) noteRegen.disabled = busy !== '' || composing !== ''
    if (noteCancel) noteCancel.disabled = false
    if (noteSummaryWrite) {
      const has = Boolean(String(it.summary || '').trim())
      noteSummaryWrite.disabled = busy !== '' || composing !== ''
      noteSummaryWrite.textContent = t(has ? 'biliNoteSummaryRewrite' : 'biliNoteSummaryWrite')
    }
    if (noteOpenBili) {
      noteOpenBili.disabled = false
      noteOpenBili.textContent = t('biliNoteOpenBili')
    }
    if (noteStatus) {
      noteStatus.textContent = statusText
      noteStatus.hidden = statusText === ''
    }
  }

  function openNote(it) {
    noteItem = it
    setStatus('')
    renderNote()
    if (noteComment) noteComment.scrollTop = 0
    // 还没写过理由 → 让她现想（放后台，面板先开出来）
    const note = it.liked && typeof it.liked === 'object' ? it.liked : {}
    if (!String(note.reason || '').trim() && !String(note.comment || '').trim()) void askCompose(it)
  }

  function closeNote() {
    noteItem = null
    setStatus('')
    renderNote()
    void reload()
  }

  async function reload() {
    try {
      const payload = await fetchHistory()
      if (payload && payload.ok === false) {
        items = []
        liked = []
      } else {
        items = Array.isArray(payload?.items) ? payload.items : []
        liked = Array.isArray(payload?.liked) ? payload.liked : []
      }
    } catch {
      items = []
      liked = []
    }
    // 二级面板里的那条要跟着新数据走（理由/概览/发送状态可能刚变）
    if (noteItem) {
      const fresh = [...liked, ...items].find((x) => keyOf(x) === keyOf(noteItem))
      if (fresh) noteItem = fresh
    }
    render()
    if (noteItem) renderNote()
  }

  /** 删一条（只删本地账本里这条，B 站那边的历史/点赞不受影响）。 */
  async function doDelete(it) {
    if (busy) return
    busy = keyOf(it)
    setStatus(t('biliDeleting'))
    render()
    try {
      const r = await removeItem({ bvid: it.bvid, cid: it.cid })
      setStatus(r?.ok === false ? String(r.error || t('biliDeleteFailed')) : t('biliDeleted'))
    } catch (err) {
      setStatus(String(err?.message || err))
    } finally {
      busy = ''
      await reload()
    }
  }

  async function doAct(it, action) {
    if (busy) return
    busy = keyOf(it)
    render()
    if (noteItem) renderNote()
    try {
      const r = await act({ bvid: it.bvid, cid: it.cid, action })
      if (!r?.ok) {
        setStatus(String(r?.error || t('biliActFailed')))
      } else {
        setStatus(String(r.message || ''))
      }
    } catch (err) {
      setStatus(String(err?.message || err))
    } finally {
      busy = ''
      await reload()
      // 赞完立刻让她写「为什么喜欢」——用户点开二级面板时内容已经在了
      if (action === 'like') void askCompose(it)
    }
  }

  async function askCompose(it) {
    const k = keyOf(it)
    if (composing === k) return
    composing = k
    render()
    if (noteItem && keyOf(noteItem) === k) renderNote()
    try {
      const r = await compose({ bvid: it.bvid, cid: it.cid })
      if (r?.ok === false) setStatus(String(r.error || t('biliNoteComposeFailed')))
    } catch (err) {
      setStatus(String(err?.message || err))
    } finally {
      composing = ''
      await reload()
    }
  }

  /** 补写/重写这条的「概览」（老条目没有画面时用元信息写，弱一点但不编）。 */
  async function askSummary(it, force = false) {
    if (busy || composing) return
    busy = keyOf(it)
    setStatus(t('biliNoteSummaryComposing'))
    render()
    if (noteItem) renderNote()
    try {
      const r = await summaryWrite({ bvid: it.bvid, cid: it.cid, force })
      if (!r?.ok) setStatus(String(r?.error || t('biliNoteSummaryFailed')))
      else setStatus(t('biliNoteSummaryDone'))
    } catch (err) {
      setStatus(String(err?.message || err))
    } finally {
      busy = ''
      await reload()
    }
  }

  async function sendComment() {
    if (!noteItem || busy) return
    const text = String(noteComment?.value || '').trim()
    if (!text) {
      setStatus(t('biliNoteEmptyComment'))
      return
    }
    // 公开发言，二次确认（评论会署用户的账号，发出去就删不掉）
    if (!window.confirm(t('biliNoteSendConfirm'))) return
    busy = keyOf(noteItem)
    setStatus(t('biliNoteSending'))
    render()
    renderNote()
    try {
      // 先把可能改过的文案存下来，再发（发失败也不丢用户改的内容）
      await noteSave({ bvid: noteItem.bvid, cid: noteItem.cid, comment: text })
      const r = await commentSend({ bvid: noteItem.bvid, cid: noteItem.cid, text })
      setStatus(r?.ok ? t('biliNoteSent') : String(r?.error || t('biliNoteSendFailed')))
    } catch (err) {
      setStatus(String(err?.message || err))
    } finally {
      busy = ''
      await reload()
    }
  }

  function setOpen(next) {
    // 与其它抽屉同一条纪律：**先互斥、后记账**。
    if (open === next) return
    if (next) setExclusiveOpen('bili-history')
    open = next
    if (root) root.hidden = !next
    document.body.classList.toggle('bili-history-open', next)
    onToggle(next)
    if (next) {
      noteItem = null
      setStatus('')
      renderNote()
      void reload()
    }
  }

  applyStatic()
  if (root) root.hidden = true
  render()

  closeBtn?.addEventListener('click', () => setOpen(false))
  noteCancel?.addEventListener('click', () => closeNote())
  noteSend?.addEventListener('click', () => void sendComment())
  noteRegen?.addEventListener('click', () => {
    if (noteItem) void askCompose(noteItem)
  })
  noteSummaryWrite?.addEventListener('click', () => {
    if (!noteItem) return
    const had = Boolean(String(noteItem.summary || '').trim())
    void askSummary(noteItem, had)
  })
  noteOpenBili?.addEventListener('click', () => {
    if (noteItem) openExternal(urlOf(noteItem))
  })

  return {
    setOpen,
    isOpen: () => open,
    setLocale: () => {
      applyStatic()
      render()
      renderNote()
    },
    reload,
  }
}
