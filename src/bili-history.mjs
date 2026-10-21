/**
 * bili-history.mjs —— 「她在 B 站看过什么」的账本。
 *
 * 为什么单独一层（而不是塞进 bili-watch）：这个账本有**两个读者**——
 *   ① 用户：环形菜单「看过的视频」抽屉（走 IPC `orb:bili-history`）；
 *   ② 她自己：`bili_history` 工具（「你上次看的那个视频讲了什么」）。
 * 两边读同一份盘上数据，形态必须稳定，所以落盘格式由本文件单独负责。
 *
 * 落盘：`<dataRoot>/bili-history.json`（data/ 不进发布包；出厂重置会一起搬走）。
 *
 * 三条纪律：
 *   1. **同一集只记一条**（`bvid + cid` 去重，分 P 是不同的 cid ⇒ 自然分开），
 *      重复看只累加 `watches` 与 `lastAt`，不把抽屉刷成一堆重复项。
 *   2. **只记"看过"**：`watch()` 成功才落账。失败、只取元信息（frames=0 且没给 times）
 *      也算看过（她确实读了标题/时长），但 `frames` 为空 —— 抽屉里据此显示「只看了信息」。
 *   3. **不存直链**：playurl 的 url 带 deadline，存下来第二天就是坏数据，只会误导后来的人。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 账本最多留多少条（超了丢最久没看的那条）。 */
export const MAX_ITEMS = 200

const FILE_NAME = 'bili-history.json'

function safeRead(file) {
  try {
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return null
    return raw
  } catch {
    // 坏文件不抛：账本是附属数据，坏了就当空的，别把她的启动拖死。
    return null
  }
}

/** `12:03` 这种给人看的时间，本地时区。 */
function clock(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** `今天 21:07` / `昨天 18:02` / `10-19 09:00`。 */
export function humanTime(ts, now = Date.now()) {
  const d = new Date(ts)
  const today = new Date(now)
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay) return `今天 ${clock(ts)}`
  const y = new Date(now - 86400_000)
  if (d.toDateString() === y.toDateString()) return `昨天 ${clock(ts)}`
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${clock(ts)}`
}

/**
 * @param {object} o
 * @param {string} o.dataRoot  `data/` 的绝对路径
 * @param {Function} [o.log]
 */
export function createBiliHistory({ dataRoot, log = () => {} } = {}) {
  if (!dataRoot) throw new Error('createBiliHistory 需要 dataRoot')
  const file = join(dataRoot, FILE_NAME)

  let cache = null

  function load() {
    if (cache) return cache
    const raw = safeRead(file)
    cache = { version: 1, items: Array.isArray(raw?.items) ? raw.items : [] }
    return cache
  }

  function save() {
    try {
      mkdirSync(dataRoot, { recursive: true })
      // tmp + rename：写到一半崩掉时旧账本仍完整（与 providers 的密钥写盘同一条纪律）。
      const tmp = `${file}.tmp-${process.pid}`
      writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
      renameSync(tmp, file)
      return true
    } catch (err) {
      log(`[bili-history] 写盘失败：${err?.message || err}`)
      return false
    }
  }

  /**
   * 记一次「看过」。
   *
   * @param {object} o
   * @param {string} o.bvid
   * @param {number} o.cid
   * @param {number} [o.aid]
   * @param {number} [o.page]
   * @param {string} o.title
   * @param {string} [o.pageTitle]
   * @param {number} [o.duration]
   * @param {number} [o.quality]
   * @param {string} [o.qualityLabel]
   * @param {number} [o.width]
   * @param {number} [o.height]
   * @param {string} [o.account]  看的时候用的是谁的身份（uname，未登录时给空串）
   * @param {number[]} [o.frameTimes] 这次取了哪几个时间点（秒）
   * @returns {{ok:boolean, item?:object, watches?:number, error?:string}}
   */
  function record(o = {}) {
    const bvid = String(o.bvid || '').trim()
    const cid = Number(o.cid || 0)
    if (!bvid || !cid) return { ok: false, error: '缺 bvid / cid，记不了' }
    const db = load()
    const key = (x) => `${x.bvid}#${x.cid}`
    const now = Date.now()
    const times = (Array.isArray(o.frameTimes) ? o.frameTimes : [])
      .map((t) => Number(t))
      .filter((t) => Number.isFinite(t) && t >= 0)

    const existing = db.items.find((x) => key(x) === key({ bvid, cid }))
    if (existing) {
      existing.lastAt = now
      existing.watches = Number(existing.watches || 1) + 1
      // 标题/画质会变（up 主改名、开了大会员），以最新一次为准。
      for (const k of ['title', 'pageTitle', 'duration', 'quality', 'qualityLabel', 'width', 'height', 'account', 'aid', 'page']) {
        if (o[k] !== undefined && o[k] !== null && o[k] !== '') existing[k] = o[k]
      }
      // 时间点取并集（「上次看的是 105s，这次又看了 10s」两个都留着才有用）。
      const merged = new Set([...(existing.frameTimes || []), ...times])
      existing.frameTimes = [...merged].sort((a, b) => a - b)
      save()
      log(`[bili-history] 又看了一次 ${bvid}（第 ${existing.watches} 次）`)
      return { ok: true, item: existing, watches: existing.watches }
    }

    const item = {
      at: now,
      lastAt: now,
      watches: 1,
      bvid,
      aid: Number(o.aid || 0),
      cid,
      page: Number(o.page || 1),
      title: String(o.title || ''),
      pageTitle: String(o.pageTitle || ''),
      duration: Number(o.duration || 0),
      quality: Number(o.quality || 0),
      qualityLabel: String(o.qualityLabel || ''),
      width: Number(o.width || 0),
      height: Number(o.height || 0),
      account: String(o.account || ''),
      frameTimes: times,
      // ── 概览：她看完之后自己写的一句「这视频大概讲了什么」（2026-10-21 加）──
      // 由主进程看完视频后调 LLM 生成（基于真实取到的关键帧），异步落盘。
      // 空串 = 还没写（老条目 / 只看了元信息没画面）。
      summary: '',
      // ── 「我喜欢的」与三个动作的状态（2026-10-21 加）──
      // liked 有值 = 这条进了「我喜欢的」板块：at 是她喜欢的时刻，reason/comment 是她写的两段话。
      liked: null,
      // 用户在这台机器上做过的动作（B 站不提供「我有没有赞过」的批量查询，
      // 所以本地记一份；重复点同一个按钮时用它做幂等提示）。
      actions: { like: false, coin: 0, fav: false },
    }
    db.items.unshift(item)
    if (db.items.length > MAX_ITEMS) db.items.length = MAX_ITEMS
    save()
    log(`[bili-history] 记下 ${bvid}《${item.title.slice(0, 24)}》`)
    return { ok: true, item, watches: 1 }
  }

  /** 最近看过的，最新在前。 */
  function list({ limit = 30 } = {}) {
    const db = load()
    const n = Math.max(1, Math.min(Number(limit) || 30, MAX_ITEMS))
    return db.items
      .slice()
      .sort((a, b) => Number(b.lastAt || b.at || 0) - Number(a.lastAt || a.at || 0))
      .slice(0, n)
      // 老条目（这次改版前记的）没有 liked/actions，补成缺省值，
      // 免得渲染层拿到 undefined 之后整块列表画不出来。
      .map((x) => ({
        ...x,
        liked: x.liked ?? null,
        actions: x.actions ?? { like: false, coin: 0, fav: false },
        summary: String(x.summary || ''),
        when: humanTime(Number(x.lastAt || x.at || 0)),
      }))
  }

  function count() {
    return load().items.length
  }

  /** 按 bvid+cid 找一条（找不到给 null）。 */
  function get(bvid, cid) {
    const key = `${String(bvid || '')}#${Number(cid) || 0}`
    return load().items.find((x) => `${x.bvid}#${x.cid}` === key) || null
  }

  /** 就地改一条并落盘；找不到就报错（不偷偷新建 —— 那会造出没有标题的空条目）。 */
  function patch(bvid, cid, fn) {
    const item = get(bvid, cid)
    if (!item) return { ok: false, error: '账本里没有这条视频（先看一遍再操作）' }
    fn(item)
    save()
    return { ok: true, item }
  }

  /**
   * 标记「我喜欢这条」，并带上她写的两段话。
   * `reason` = 她为什么喜欢；`comment` = 她想对作者说的那句话。
   *
   * ★ `by` 是**谁决定的喜欢**（2026-10-22 用户明确口径）：
   *   · `'orb'`  —— 她自己看完觉得好，主动记下的（**「我喜欢的」只认这一种**）
   *   · `'user'` —— 用户在抽屉里点了「赞」按钮（那只是替他执行一个动作，
   *                 不代表她的品味，所以不进「我喜欢的」栏）
   *   旧数据没有 `by` 字段 —— 一律当 `'user'`：那时候唯一的写入路径就是点赞按钮。
   */
  function markLiked(bvid, cid, { reason = '', comment = '', by = 'user' } = {}) {
    const who = by === 'orb' ? 'orb' : 'user'
    return patch(bvid, cid, (it) => {
      it.liked = {
        at: Date.now(),
        reason: String(reason || ''),
        comment: String(comment || ''),
        sentAt: it.liked?.sentAt ?? null,
        by: who,
      }
      it.actions = { ...(it.actions || {}), like: true }
    })
  }

  /** 记一笔动作（like/coin/fav）。coin 存枚数（0/1/2），like/fav 存布尔。 */
  function setAction(bvid, cid, next = {}) {
    return patch(bvid, cid, (it) => {
      const cur = it.actions && typeof it.actions === 'object' ? it.actions : { like: false, coin: 0, fav: false }
      it.actions = {
        like: next.like === undefined ? cur.like === true : next.like === true,
        coin: next.coin === undefined ? Number(cur.coin) || 0 : Number(next.coin) || 0,
        fav: next.fav === undefined ? cur.fav === true : next.fav === true,
      }
    })
  }

  /** 改她写的那两段话（用户可以在发出去之前编辑）。 */
  function updateNote(bvid, cid, { reason, comment } = {}) {
    return patch(bvid, cid, (it) => {
      if (!it.liked) it.liked = { at: Date.now(), reason: '', comment: '', sentAt: null }
      if (typeof reason === 'string') it.liked.reason = reason
      if (typeof comment === 'string') it.liked.comment = comment
    })
  }

  /** 记「评论真的发出去了」+ 发出去的原文（用户可能改过）。 */
  function markSent(bvid, cid, text) {
    return patch(bvid, cid, (it) => {
      if (!it.liked) it.liked = { at: Date.now(), reason: '', comment: '', sentAt: null }
      it.liked.sentAt = Date.now()
      it.liked.sentText = String(text || '')
    })
  }

  /**
   * 「我喜欢的」板块：只回**她自己决定的**那些（`liked.by === 'orb'`），最新喜欢的在前。
   *
   * ★ 2026-10-22 用户口径：「我喜欢的是它自己浏览 b 站看到的视频，而不是我点赞后
   *   才被加进来的」。所以用户点「赞」产生的那条（by='user' 或旧数据没有 by）
   *   **不在这里出现** —— 它只是账本里 `actions.like=true`，行内显示「已赞」。
   */
  function listLiked({ limit = 50 } = {}) {
    const n = Math.max(1, Math.min(Number(limit) || 50, MAX_ITEMS))
    return load()
      .items.filter((x) => x.liked && x.liked.at && x.liked.by === 'orb')
      .sort((a, b) => Number(b.liked.at) - Number(a.liked.at))
      .slice(0, n)
      .map((x) => ({
        ...x,
        actions: x.actions ?? { like: false, coin: 0, fav: false },
        summary: String(x.summary || ''),
        when: humanTime(Number(x.liked.at)),
      }))
  }

  /**
   * 写/改这条视频的「概览」（她看完之后自己总结的一句）。
   *
   * 与 liked 那两段话不同：概览是**看完画面之后**对内容的客观描述，
   * 「为什么喜欢」「想对作者说什么」是主观感受 —— 三个字段各管一件事，别混。
   */
  function setSummary(bvid, cid, text) {
    return patch(bvid, cid, (it) => {
      it.summary = String(text || '').trim().slice(0, 240)
    })
  }

  /**
   * 删掉一条（用户 2026-10-22：底部「刷新 / 清空记录」整条撤掉，改成每条自带删除）。
   * ★ 只动本地账本，B 站那边看过/点赞的记录不受影响 —— 返回里说清楚删了什么，
   *   免得她以为「删了就等于从来没看过」。
   */
  function remove(bvid, cid) {
    const db = load()
    const key = `${String(bvid || '')}#${Number(cid) || 0}`
    const i = db.items.findIndex((x) => `${x.bvid}#${x.cid}` === key)
    if (i < 0) return { ok: false, error: '账本里没有这条视频' }
    const [gone] = db.items.splice(i, 1)
    save()
    log(`[bili-history] 删除一条：${String(gone?.title || key).slice(0, 30)}`)
    return { ok: true, removed: 1, title: String(gone?.title || '') }
  }

  function clear() {
    const db = load()
    const n = db.items.length
    db.items = []
    save()
    log(`[bili-history] 清空（原 ${n} 条）`)
    return { ok: true, removed: n }
  }

  /** 给系统指南/状态面板看的一句话摘要。 */
  function describe() {
    const n = count()
    if (!n) return '浏览记录 0 条'
    const last = list({ limit: 1 })[0]
    return `浏览记录 ${n} 条（最近：${last?.when ?? '?'}《${(last?.title ?? '').slice(0, 20)}》）`
  }

  return { record, list, listLiked, get, markLiked, setAction, updateNote, markSent, setSummary, remove, count, clear, describe, file }
}
