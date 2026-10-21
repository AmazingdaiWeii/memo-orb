/**
 * 定时提醒 —— 她说「X 点提醒你」之后，到点**由宿主直接说出来**，不再跑模型。
 *
 * 为什么不让模型到点再跑一遍：
 *   1. 到点要跑一次完整回合（8~40 秒启动 + 全量 system prompt），只为说一句「该喝水了」，
 *      成本与延迟都不合理；
 *   2. 模型每轮都看到「现在几点」会诱发它自己排时间，而它没有可靠的时钟；
 *   3. 掉线/重启后未触发的提醒必须能补上——这只有把时间写在盘上才做得到。
 *
 * 落点：`<dataRoot>/schedule.json`
 *   { version: 1, items: [ { id, at, text, channel, createdAt, firedAt, late, note } ] }
 *
 * 三态（别混）：
 *   - 未触发：`firedAt === null`
 *   - 已说过：`firedAt` 有值、`late === false`
 *   - 迟到了才说：`firedAt` 有值、`late === true`（宿主会加前缀「本来该 X 点说」）
 *   - 太迟了（超过 LATE_SPEAK_MS）：`firedAt` 有值、`late === true`、`note` 记原因，
 *     但**不发声**——半夜三点点醒她说「九点该吃药」是骚扰，不是帮忙。
 */

import {
  existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export const SCHEDULE_VERSION = 1
/** 未触发的提醒上限：再多就不是「提醒」而是日历了，而且列表会撑爆上下文 */
export const MAX_PENDING = 50
/** 最多排到一年后（再远记不准，也没有意义） */
export const MAX_AHEAD_MS = 366 * 24 * 3600 * 1000
/** 迟到多少还算「该说」——超过这个时长只记账不发声 */
export const LATE_SPEAK_MS = 6 * 3600 * 1000
/** 允许「5 秒后提醒我」这种即时用法，但已经把时间设到过去的不收 */
export const GRACE_PAST_MS = 60 * 1000
export const MAX_TEXT_CHARS = 500
/** 宿主 tick 间隔（30 秒：误差可接受，空转成本可忽略） */
export const TICK_MS = 30 * 1000

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * id = `r-` + 5 位随机 + 时间戳（base36）。
 *
 * 随机段放**前面**是刻意的：`cancel_reminder` 允许只给前几位（她不会完整抄
 * `r-mvf9hr40a54` 这种），而时间戳在前时，同一毫秒里排的几条前缀完全一样 ——
 * 探针实录过「这个前缀对上 5 条，说完整一点」。随机在前，任取 2 位就能区分。
 * 时间戳仍留在后半段，排障时一眼看得出是什么时候排的。
 */
function newId(nowMs) {
  const rand = Math.random().toString(36).slice(2, 7).padEnd(5, '0')
  return `r-${rand}${nowMs.toString(36)}`
}

/**
 * 「什么时候」→ Date。
 *
 * 支持（都用**本机本地时区**，跟她说话的口径一致）：
 *   `+30m` `+2h` `+3d`            —— 相对现在
 *   `21:30` / `21:30:00`          —— 今天这个点；已经过了就明天
 *   `10-21 09:00`                 —— 今年；已经过了就明年
 *   `2026-10-21 09:00`            —— 完整日期（也收 `2026-10-21T09:00`）
 *   带时区的 ISO 原样交给 Date
 *
 * 故意**不做**「明天早上」这类自然语言解析：那是模型的活，它该把话说成具体时刻，
 * 解析器猜错一次就是半夜响铃。猜不出来时报错并给出正确写法，让它自己改。
 */
export function parseWhen(raw, { now = Date.now() } = {}) {
  const s = String(raw ?? '').trim()
  if (!s) throw new Error('没说要什么时候提醒（比如 "21:30" 或 "+30m"）')
  const nowMs = typeof now === 'function' ? now() : now

  // 相对时间
  const rel = /^\+(\d+(?:\.\d+)?)\s*(s|m|h|d|秒|分|小时|天)$/.exec(s)
  if (rel) {
    const unit = { s: 1000, m: 60_000, h: 3600_000, d: 86400_000, 秒: 1000, 分: 60_000, 小时: 3600_000, 天: 86400_000 }[rel[2]]
    const at = new Date(nowMs + Number(rel[1]) * unit)
    if (!Number.isFinite(at.getTime())) throw new Error(`看不懂这个时间：${s}`)
    return at
  }

  // 带时区的 ISO（含 Z 或 +08:00）：交给 Date，别自己算
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(s) && s.includes('T')) {
    const at = new Date(s)
    if (Number.isNaN(at.getTime())) throw new Error(`看不懂这个时间：${s}`)
    return at
  }

  const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s)
  if (hm) {
    const d = new Date(nowMs)
    d.setSeconds(0, 0)
    d.setHours(Number(hm[1]), Number(hm[2]), Number(hm[3] ?? 0), 0)
    // 今天这个点已经（快）过了 → 明天。留 60 秒余量，免得「21:30」在 21:29:50 被推到明天。
    if (d.getTime() <= nowMs - GRACE_PAST_MS) d.setDate(d.getDate() + 1)
    return d
  }

  const md = /^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s)
  if (md) {
    const base = new Date(nowMs)
    const d = new Date(base.getFullYear(), Number(md[1]) - 1, Number(md[2]),
      Number(md[3]), Number(md[4]), Number(md[5] ?? 0), 0)
    if (Number.isNaN(d.getTime())) throw new Error(`没有这一天：${s}`)
    // 跨年：写成「10-21」而现在是 12 月，指的是明年
    if (d.getTime() <= nowMs - GRACE_PAST_MS) d.setFullYear(d.getFullYear() + 1)
    return d
  }

  const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s)
  if (ymd) {
    const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]),
      Number(ymd[4]), Number(ymd[5]), Number(ymd[6] ?? 0), 0)
    if (Number.isNaN(d.getTime())) throw new Error(`没有这一天：${s}`)
    return d
  }

  throw new Error(`看不懂这个时间：${s}。写成 "21:30"、"+30m"、"10-21 09:00" 或 "2026-10-21 09:00"`)
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function dayStart(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 「今天 21:30」/「明天 08:00」/「10月21日 09:00（周三）」 */
export function describeWhen(date, { now = Date.now() } = {}) {
  const nowMs = typeof now === 'function' ? now() : now
  const t = date.getTime()
  const diffDays = Math.round((dayStart(t) - dayStart(nowMs)) / 86400_000)
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  if (diffDays === 0) return `今天 ${clock}`
  if (diffDays === 1) return `明天 ${clock}`
  if (diffDays === -1) return `昨天 ${clock}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}（${WEEK[date.getDay()]}）`
}

/** 「9 点 05 分」—— 「本来该 X 点说」里那个 X */
export function describeClock(date) {
  const m = date.getMinutes()
  return m === 0 ? `${date.getHours()} 点` : `${date.getHours()} 点 ${pad2(m)} 分`
}

/**
 * 「2026-10-19 21:33（周日）」—— 每轮附在用户消息尾部的当前时间。
 *
 * ★ 为什么放**用户消息尾部**而不是 system prompt：I3 要求会话内 system 字节不变，
 *   而时间是每轮都变的。放尾部既满足 I3，又不会污染前缀缓存。
 */
export function describeNow(ms = Date.now()) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}（${WEEK[d.getDay()]}）`
}

/**
 * 提醒仓。
 *
 * 每次操作都重读盘（文件极小，几十行），所以**手工改 schedule.json 立即生效**，
 * 不需要重启。写盘走 tmp + rename：写一半被杀不会留下坏文件。
 */
export function createScheduleStore({ dataRoot, log = () => {}, now = Date.now } = {}) {
  if (!dataRoot) throw new Error('createScheduleStore: 需要 dataRoot')
  const file = join(dataRoot, 'schedule.json')

  const empty = () => ({ version: SCHEDULE_VERSION, items: [] })

  function read() {
    if (!existsSync(file)) return empty()
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      log(`[schedule] 读不动 ${file}: ${err.message}`)
      return empty()
    }
    if (!raw.trim()) return empty()
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      // 坏文件不能静默清空——那是用户排的提醒，先留证据再重来
      const broken = `${file}.broken-${Date.now()}`
      try { renameSync(file, broken) } catch { /* 留不下证据也不能卡住 */ }
      log(`[schedule] 解析失败，原件已改名 ${broken}: ${err.message}`)
      return empty()
    }
    const items = Array.isArray(parsed?.items) ? parsed.items : []
    return { version: SCHEDULE_VERSION, items: items.filter((it) => it && it.at && it.text) }
  }

  function write(state) {
    const dir = dirname(file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, file)
  }

  const api = {
    file,

    /** 全部提醒，按触发时间升序（含已触发过的，供 list_reminders 用） */
    list() {
      return read().items.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    },

    /** 还没说出口的 */
    pending() {
      return api.list().filter((it) => !it.firedAt)
    },

    /**
     * 排一条。`when` 已经是**解析后的字符串**（ISO），日期解析在工具层做——
     * 让这一层只管存，不猜自然语言。
     */
    add({ when, text, channel = 'all' }) {
      const body = String(text ?? '').trim()
      if (!body) throw new Error('没说提醒什么事')
      if (body.length > MAX_TEXT_CHARS) throw new Error(`太长了（超过 ${MAX_TEXT_CHARS} 字），说短一点`)
      const at = new Date(when)
      if (Number.isNaN(at.getTime())) throw new Error(`时间不合法：${when}`)

      const state = read()
      const nowMs = now()
      const t = at.getTime()
      if (t < nowMs - GRACE_PAST_MS) {
        throw new Error(`那个时间已经过去了（现在是 ${describeWhen(new Date(nowMs), { now: nowMs })}）`)
      }
      if (t > nowMs + MAX_AHEAD_MS) throw new Error('排得太远了（最多一年）')

      const waiting = state.items.filter((it) => !it.firedAt)
      if (waiting.length >= MAX_PENDING) {
        throw new Error(`还没说的提醒已经有 ${MAX_PENDING} 条了，先说掉或删掉几条`)
      }

      const item = {
        id: newId(nowMs),
        at: at.toISOString(),
        text: body,
        channel: channel === 'wechat' || channel === 'desktop' ? channel : 'all',
        createdAt: new Date(nowMs).toISOString(),
        firedAt: null,
        late: false,
      }
      state.items.push(item)
      write({ version: SCHEDULE_VERSION, items: state.items })
      return item
    },

    /**
     * 删一条：完整 id 或唯一前缀都认（她未必会完整抄 8 位）。
     * 已经说过的不能删——那已经是对话历史的一部分了。
     */
    cancel(idOrPrefix) {
      const q = String(idOrPrefix ?? '').trim().toLowerCase()
      if (!q) throw new Error('要删哪一条？给个 id')
      const state = read()
      const hits = state.items.filter((it) => String(it.id).toLowerCase().startsWith(q))
      if (hits.length === 0) throw new Error(`没有这个 id：${idOrPrefix}`)
      if (hits.length > 1) throw new Error(`这个前缀对上 ${hits.length} 条，说完整一点：${hits.map((h) => h.id).join('、')}`)
      const item = hits[0]
      if (item.firedAt) throw new Error(`这条已经说过了（${describeWhen(new Date(item.at))}），不用删`)
      state.items = state.items.filter((it) => it.id !== item.id)
      write({ version: SCHEDULE_VERSION, items: state.items })
      return item
    },

    /**
     * 取走到点的，并**立刻**标记 firedAt。
     *
     * 先标记再说话：说的时候崩了，宁可少说一句，也不要重启后重复说（重复的骚扰更糟）。
     */
    takeDue(nowMs = now()) {
      const state = read()
      const due = state.items
        .filter((it) => !it.firedAt && new Date(it.at).getTime() <= nowMs)
        .sort((a, b) => (a.at < b.at ? -1 : 1))
      if (due.length === 0) return []
      const out = []
      for (const it of due) {
        const atMs = new Date(it.at).getTime()
        const lateMs = Math.max(0, nowMs - atMs)
        it.firedAt = new Date(nowMs).toISOString()
        it.late = lateMs > 60_000
        if (lateMs > LATE_SPEAK_MS) it.note = '迟到太久，只记账没打扰'
        out.push({ ...it, at: new Date(atMs), lateMs, silent: lateMs > LATE_SPEAK_MS })
      }
      write({ version: SCHEDULE_VERSION, items: state.items })
      return out
    },

    /** 给工具/日志看的一行摘要 */
    describe() {
      const p = api.pending()
      if (p.length === 0) return '没有排着的提醒'
      return p.map((it) => `${it.id} ${describeWhen(new Date(it.at))} ${it.text}`).join('\n')
    },
  }

  // 首次调用就把空文件落盘（同 policy.json：她要能直接打开看和改，而不是等第一条提醒才出现）
  if (!existsSync(file)) write(empty())

  return api
}

/**
 * 宿主侧的 30 秒 tick。
 *
 * `tick()` 单独暴露出来是给探针用的——测试里不想等真实的 30 秒。
 * 返回 { tick, stop }。
 */
export function startReminderTicker({
  store, onFire, log = () => {}, everyMs = TICK_MS, now = Date.now, immediate = true,
} = {}) {
  if (!store) throw new Error('startReminderTicker: 需要 store')
  if (typeof onFire !== 'function') throw new Error('startReminderTicker: 需要 onFire')

  let stopped = false
  const tick = async () => {
    if (stopped) return []
    let due = []
    try {
      due = store.takeDue(typeof now === 'function' ? now() : now)
    } catch (err) {
      log(`[schedule] 取到点提醒失败: ${err.message}`)
      return []
    }
    for (const item of due) {
      try {
        await onFire(item)
      } catch (err) {
        log(`[schedule] 投递 ${item.id} 失败: ${err.message}`)
      }
    }
    return due
  }

  const timer = setInterval(() => { void tick() }, everyMs)
  // 别让一个后台计时器把 Electron 进程按住不退出
  if (typeof timer.unref === 'function') timer.unref()
  // 启动即补一次：关机期间到点的提醒要马上补上，不能等到下一个 30 秒
  if (immediate) void tick()

  return {
    tick,
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}
