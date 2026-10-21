/**
 * 微信双向桥（iLink / ClawBot 协议）。
 *
 * 目标只有一句：他在手机上说话，她在手机上也听得见、答得上。
 *
 * 协议取证自 `E:\dsh-workspace\02_插件开发\dsh-omni-bridge\lib\index.js`（同机可跑的
 * 现成实现），这里只抄三个调用：
 *
 *   POST {base}/ilink/bot/getupdates   { get_updates_buf, base_info:{channel_version} }
 *   POST {base}/ilink/bot/sendmessage  { msg:{ to_user_id, message_type:2, message_state:2,
 *                                            client_id, item_list:[{type:1,text_item:{text}}],
 *                                            context_token? }, base_info:{…} }
 *   头：{ 'content-type':'application/json', AuthorizationType:'ilink_bot_token',
 *         'X-WECHAT-UIN': btoa(String(uint32)), Authorization: 'Bearer <botToken>' }
 *
 * 四条不变量，都是「重复回复 / 沉默 / 白等」换来的：
 *
 *  W1 **游标（get_updates_buf）必须落盘**。它不落盘，重启后第一轮会把整段历史再取一遍，
 *     于是同一条消息被回两遍。所以 state 文件每次取到新游标都原子写。
 *
 *  W2 **只认主人**。`from_user_id !== userId` 的一律不回，只记一行日志 ——
 *     这个 botId 是扫码配对的产物，谁都能给它发消息，回了就成了公开应答机。
 *
 *  W3 **永不放弃轮询，但要退避**。网络断、服务端 5xx、请求超时都很正常，
 *     连续失败按 1s→2s→4s→…→60s 退避；成功后立刻回到 1s。401/403 单记一行
 *     「token 可能失效」，不刷屏。
 *
 *  W4 **本模块只管收发**。「跑一轮对话」和「审批第二通道」在 `createWechatFront` 里，
 *     因为那两块要碰 brain / 审批器，放这里会把传输层拖成宿主逻辑。
 *     （本文件内 front 与 transport 同住，但互不 import 宿主模块，探针可以单独跑。）
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 服务端认的渠道版本，抄现成实现。 */
export const CHANNEL_VERSION = '1.0.2'
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** 长轮询一次最多挂多久。服务端大约 30s 回空，给到 70s 留余量。 */
export const POLL_TIMEOUT_MS = 70_000
export const BACKOFF_MIN_MS = 1_000
export const BACKOFF_MAX_MS = 60_000

/** 单条外发上限。微信气泡塞不下长文，截断比发失败好。 */
export const MAX_SEND_CHARS = 1_800

/** 待回队列上限。超了就直接说「稍后再回你」，不排无限长的队。 */
export const QUEUE_MAX = 8

/** 已见 message_id 的记忆条数。游标是主锁，这个只是重发批次的第二道网。 */
export const SEEN_MAX = 500

/** 首次启动时唯一会去读的外部凭据（之后只认 data/wechat.json）。 */
export const DSH_CONFIG_PATH = join(homedir(), '.dsh', 'omni-bridge-config.json')

/** 默认状态：游标空 = 从此刻起的新消息开始，不补历史。 */
const EMPTY_STATE = { cursor: '', lastPollAt: 0, botId: '', userId: '' }

/**
 * 读写一个小 json，坏了不静默清空（改名留证），写用 tmp+rename。
 * 和 schedule.mjs / policy.mjs 同一种写法：用户随时能在盘上看见并手改。
 */
function readJsonSafe(file, log) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    const broken = `${file}.broken-${Date.now()}`
    try { renameSync(file, broken) } catch { /* 改名失败就算了，下面返回 null */ }
    log?.(`[wechat] ${file} 解析失败（${err.message}），已改名 ${broken}，这次当空配置`)
    return null
  }
}

function writeJsonAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/** 请求头。X-WECHAT-UIN 是随机设备号，服务端只当区分用，稳定与否无所谓。 */
export function weixinHeaders(token) {
  const uin = Buffer.from(String((Math.random() * 0xffffffff) >>> 0)).toString('base64')
  const h = {
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': uin,
  }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

/** 从宿主自己的 omni-bridge 配置里搬一次凭据（只在 data/wechat.json 不存在时）。 */
export function migrateCreds(log = () => {}) {
  const raw = readJsonSafe(DSH_CONFIG_PATH, log)
  const c = raw?.channels?.weixin
  if (!c || typeof c !== 'object') return null
  const creds = {
    enabled: !!c.enabled,
    baseUrl: String(c.baseUrl || DEFAULT_BASE_URL),
    botToken: String(c.botToken || ''),
    botId: String(c.botId || ''),
    userId: String(c.userId || ''),
  }
  if (!creds.botToken) return null
  log('[wechat] 从 ~/.dsh/omni-bridge-config.json 搬了一次微信凭据（之后只认 data/wechat.json）')
  return creds
}

/**
 * 凭据仓。第一次启动会把 `data/wechat.json` 写出来（哪怕 disabled），
 * 理由同 policy.json：用户得看得见它在哪、改得动它。
 */
export function createWechatCreds({ dataRoot, log = () => {} }) {
  const file = join(dataRoot, 'wechat.json')

  function load() {
    const raw = readJsonSafe(file, log)
    if (!raw) {
      const migrated = migrateCreds(log)
      const creds = { enabled: false, baseUrl: DEFAULT_BASE_URL, botToken: '', botId: '', userId: '', ...(migrated || {}) }
      writeJsonAtomic(file, creds)
      return creds
    }
    return {
      enabled: !!raw.enabled,
      baseUrl: String(raw.baseUrl || DEFAULT_BASE_URL),
      botToken: String(raw.botToken || ''),
      botId: String(raw.botId || ''),
      userId: String(raw.userId || ''),
    }
  }

  /**
   * 合并写入（只改传进来的键）。给「设置」抽屉用：用户改一项就存一项，
   * 不把没动过的字段整份覆写回盘（同 api-config 的 patch 纪律）。
   */
  function save(patch) {
    const next = { ...load() }
    if (patch && typeof patch === 'object') {
      if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
      if (typeof patch.botToken === 'string') next.botToken = patch.botToken.trim()
      if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim() !== '') next.baseUrl = patch.baseUrl.trim()
      if (typeof patch.botId === 'string') next.botId = patch.botId
      if (typeof patch.userId === 'string') next.userId = patch.userId.trim()
    }
    writeJsonAtomic(file, next)
    return next
  }

  return { file, load, save, describe: () => describeCreds(load()) }
}

export function describeCreds(c) {
  if (!c.enabled) return '微信：关闭'
  if (!c.botToken) return '微信：已开启但没填 botToken'
  if (!c.userId) return '微信：已开启但没有接收人（userId 为空）'
  return `微信：开启（${c.botId || '未配对'} → ${c.userId}）`
}

/**
 * 传输层。start() 立刻返回，轮询在后台自己转；stop() 断掉在途请求。
 *
 * @param {object} o
 * @param {string} o.dataRoot
 * @param {(msg:{text:string,msgId:string,fromUserId:string,contextToken:string,at:number})=>any} o.onMessage
 * @param {(s:string)=>void} [o.log]
 * @param {typeof fetch} [o.fetchImpl]
 * @param {()=>number} [o.now]
 */
export function createWechatBridge({ dataRoot, onMessage, log = () => {}, fetchImpl = fetch, now = Date.now }) {
  if (typeof onMessage !== 'function') throw new Error('createWechatBridge: 缺少 onMessage')

  const credsStore = createWechatCreds({ dataRoot, log })
  const stateFile = join(dataRoot, 'wechat-state.json')

  let state = { ...EMPTY_STATE }
  let running = false
  let loopPromise = null
  let inFlight = null
  const seen = new Set()
  const stats = { polls: 0, delivered: 0, dropped: 0, errors: 0, lastError: '' }

  function loadState() {
    const raw = readJsonSafe(stateFile, log)
    state = {
      cursor: typeof raw?.cursor === 'string' ? raw.cursor : '',
      lastPollAt: Number(raw?.lastPollAt) || 0,
      botId: typeof raw?.botId === 'string' ? raw.botId : '',
      userId: typeof raw?.userId === 'string' ? raw.userId : '',
    }
    return state
  }

  function saveState(patch = {}) {
    state = { ...state, ...patch, lastPollAt: now() }
    writeJsonAtomic(stateFile, state)
    return state
  }

  if (existsSync(stateFile)) loadState()

  async function request(url, body) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), POLL_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    inFlight = ac
    // token 每次现读：用户手改 data/wechat.json 换 token 后，不用重启进程
    // （原先这里闭包了一个不存在的 creds，探针一跑就撞 ReferenceError）。
    const token = credsStore.load().botToken
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: weixinHeaders(token),
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      const text = await res.text()
      let data = null
      try { data = JSON.parse(text) } catch { data = null }
      return { status: res.status, data, text }
    } finally {
      clearTimeout(timer)
      if (inFlight === ac) inFlight = null
    }
  }

  async function getUpdates(cursor) {
    // baseUrl 也现读（同 token）：换服务地址不该需要重启。
    return request(`${credsStore.load().baseUrl}/ilink/bot/getupdates`, {
      get_updates_buf: cursor || '',
      base_info: { channel_version: CHANNEL_VERSION },
    })
  }

  /** 发一条文本。返回 {ok, error?}，不抛（调用方多半在 fire-and-forget）。 */
  async function send({ text, contextToken = '', to = '' }) {
    const creds = credsStore.load()
    if (!creds.botToken) return { ok: false, error: '没配微信 botToken' }
    const target = to || creds.userId
    if (!target) return { ok: false, error: '没有接收人（userId 为空）' }

    let body = String(text ?? '')
    if (body.trim() === '') return { ok: false, error: '正文是空的' }
    if (body.length > MAX_SEND_CHARS) body = `${body.slice(0, MAX_SEND_CHARS - 1)}…`

    const clientId = `orb-${((Math.random() * 0xffffffff) >>> 0).toString(16)}`
    const msg = {
      to_user_id: target,
      message_type: 2,
      message_state: 2,
      client_id: clientId,
      item_list: [{ type: 1, text_item: { text: body } }],
    }
    // context_token 拿不到就只能当首条主动消息发；有了它服务端才认这是接着刚才说的。
    if (contextToken) msg.context_token = contextToken

    try {
      const r = await request(`${creds.baseUrl}/ilink/bot/sendmessage`, {
        msg,
        base_info: { channel_version: CHANNEL_VERSION },
      })
      if (r.status === 401 || r.status === 403) {
        stats.lastError = `sendmessage HTTP ${r.status}（token 可能失效）`
        log(`[wechat] ${stats.lastError}`)
        return { ok: false, error: stats.lastError }
      }
      if (r.status < 200 || r.status >= 300) {
        stats.lastError = `sendmessage HTTP ${r.status}`
        log(`[wechat] ${stats.lastError}`)
        return { ok: false, error: stats.lastError }
      }
      if (r.data && typeof r.data.ret === 'number' && r.data.ret !== 0) {
        stats.lastError = `sendmessage ret=${r.data.ret} ${r.data.errmsg || ''}`.trim()
        log(`[wechat] ${stats.lastError}`)
        return { ok: false, error: stats.lastError }
      }
      return { ok: true }
    } catch (err) {
      stats.lastError = `sendmessage 失败: ${err.message}`
      log(`[wechat] ${stats.lastError}`)
      return { ok: false, error: stats.lastError }
    }
  }

  /** 一批消息里挑出该回的。抽出来是为了探针能直接验过滤/去重，不必起轮询。 */
  function pickInbound(data, selfUserId) {
    const out = []
    if (!Array.isArray(data?.msgs)) return out
    for (const m of data.msgs) {
      if (!m || m.message_type !== 1) continue
      const msgId = String(m.message_id || `${m.seq}:${m.from_user_id}:${m.context_token}`)
      if (seen.has(msgId)) { stats.dropped += 1; continue }
      seen.add(msgId)
      if (seen.size > SEEN_MAX) {
        const it = seen.values()
        while (seen.size > SEEN_MAX) seen.delete(it.next().value)
      }
      const text = m.item_list?.[0]?.text_item?.text || ''
      if (!text) { stats.dropped += 1; continue }
      const fromUserId = String(m.from_user_id || '')
      if (selfUserId && fromUserId !== selfUserId) {
        // W2：陌生人一律不回。只记一句（截断，别把人家 id 拼进日志太长）。
        log(`[wechat] 收到非主人的消息（from=${fromUserId.slice(0, 24)}…），不回`)
        stats.dropped += 1
        continue
      }
      out.push({ text, msgId, fromUserId, contextToken: String(m.context_token || ''), at: now() })
    }
    return out
  }

  async function pollOnce() {
    const creds = credsStore.load()
    stats.polls += 1
    const r = await getUpdates(state.cursor)
    if (r.status === 401 || r.status === 403) {
      stats.lastError = `getupdates HTTP ${r.status}（token 可能失效）`
      throw new Error(stats.lastError)
    }
    if (r.status < 200 || r.status >= 300) throw new Error(`getupdates HTTP ${r.status}`)
    if (!r.data) throw new Error('getupdates 返回的不是 json')

    const batch = pickInbound(r.data, creds.userId)
    // 先落游标再派发：宁可这一批里有一条没回（下一批也取不回来），
    // 也不要重启后把整批再回一遍（W1）。
    const next = typeof r.data.get_updates_buf === 'string' && r.data.get_updates_buf
      ? r.data.get_updates_buf
      : state.cursor
    saveState({ cursor: next, botId: creds.botId || state.botId, userId: creds.userId || state.userId })

    for (const item of batch) {
      stats.delivered += 1
      try {
        await onMessage(item)
      } catch (err) {
        log(`[wechat] 处理来消息失败: ${err.message}`)
      }
    }
    return batch.length
  }

  async function loop() {
    let backoff = BACKOFF_MIN_MS
    while (running) {
      try {
        await pollOnce()
        if (backoff !== BACKOFF_MIN_MS) log('[wechat] 轮询恢复正常')
        backoff = BACKOFF_MIN_MS
      } catch (err) {
        stats.errors += 1
        stats.lastError = err.message
        log(`[wechat] 轮询失败（${err.message}），${Math.round(backoff / 1000)}s 后重试`)
        await new Promise((r) => setTimeout(r, backoff))
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
    }
  }

  /** 起轮询。返回 {started, reason}；凭据不全就只记一行，不抛。 */
  function start() {
    if (running) return { started: false, reason: '已经在跑了' }
    const creds = credsStore.load()
    if (!creds.enabled) {
      log('[wechat] 桥没开（data/wechat.json 里 enabled=false），不连微信')
      return { started: false, reason: '未启用' }
    }
    if (!creds.botToken) {
      log('[wechat] 配了开启但没 botToken，不连')
      return { started: false, reason: '缺 botToken' }
    }
    running = true
    log(`[wechat] 开始轮询 ${creds.baseUrl}（${describeCreds(creds)}，游标 ${state.cursor ? '有' : '空'}）`)
    loopPromise = loop().catch((err) => log(`[wechat] 轮询循环意外退出: ${err.message}`))
    return { started: true, reason: '' }
  }

  async function stop() {
    if (!running) return
    running = false
    try { inFlight?.abort() } catch { /* 已结束 */ }
    await Promise.race([loopPromise, new Promise((r) => setTimeout(r, 1500))])
    log('[wechat] 轮询已停')
  }

  return {
    start,
    stop,
    send,
    pollOnce,
    pickInbound,
    state: () => ({ ...state }),
    loadState,
    stats: () => ({ ...stats }),
    creds: () => credsStore.load(),
    credsFile: credsStore.file,
    describe: () => describeCreds(credsStore.load()),
  }
}

/**
 * 会话侧：把来消息变成一轮对话，并把审批卡搬到他手机上。
 *
 * 与 transport 分开的理由：这里要 await 一整轮模型（几秒到几十秒），
 * 而轮询必须在那期间继续跑（否则他在电脑上聊着的这段时间，手机消息会积压到超时）。
 *
 * 回合互斥（同一时刻只跑一轮）：她只有一个脑，两轮并行会互相踩 sessionStore
 * 和记忆文件。忙时入队，满了直接回一句「稍后回你」，不排长队。
 */
export function createWechatFront({
  bridge,
  runTurn,
  approval = null,
  log = () => {},
  queueMax = QUEUE_MAX,
  now = Date.now,
}) {
  if (typeof runTurn !== 'function') throw new Error('createWechatFront: 缺少 runTurn')

  let busy = false
  const queue = []
  const stats = { turns: 0, queued: 0, dropped: 0, approvals: 0, errors: 0 }

  const VERDICT_ALLOW = ['允许', '准许', '同意', '可以', '好', '1', 'yes', 'y', 'ok', '行']
  const VERDICT_DENY = ['拒绝', '不许', '不行', '不要', '别', '2', 'no', 'n', '算了']

  /** 判一句话是不是在回答审批卡。返回 true / false / null（不是答案）。 */
  function verdictOf(text) {
    const s = String(text ?? '').trim().toLowerCase().replace(/[。！!，,～~]+$/u, '')
    if (VERDICT_ALLOW.includes(s)) return true
    if (VERDICT_DENY.includes(s)) return false
    return null
  }

  /** 审批卡的手机版文案。不带 args 全文 —— 手机上一屏就几句，细节留给桌面卡。 */
  function notifyAsk({ id, head, reason }) {
    const why = reason ? `\n（因为：${reason}）` : ''
    void bridge.send({ text: `⚠️ 她要${head}。${why}\n回「允许」或「拒绝」。` })
    return id
  }

  async function handleApprovalReply(item) {
    const verdict = verdictOf(item.text)
    if (verdict === null) return false
    const ids = typeof approval?.pendingIds === 'function' ? approval.pendingIds() : []
    if (ids.length === 0) {
      // 没有待批的事却回了个「好」—— 这是普通对话，交给模型去答。
      return false
    }
    if (ids.length > 1) {
      await bridge.send({ text: '现在有好几件事在等确认，请在电脑上点一下。', contextToken: item.contextToken })
      return true
    }
    const ok = approval.answerFromChannel('wechat', ids[0], verdict)
    stats.approvals += 1
    await bridge.send({
      text: ok ? (verdict ? '好，我按你说的办。' : '好，这次不动。') : '那张卡已经有人答过了。',
      contextToken: item.contextToken,
    })
    return true
  }

  async function runOne(item) {
    busy = true
    stats.turns += 1
    try {
      const reply = await runTurn({ text: item.text, contextToken: item.contextToken, msgId: item.msgId, at: item.at ?? now() })
      const text = typeof reply === 'string' ? reply.trim() : ''
      if (text) await bridge.send({ text, contextToken: item.contextToken })
    } catch (err) {
      stats.errors += 1
      log(`[wechat] 回合失败: ${err.message}`)
      await bridge.send({ text: '我这边刚出了点岔子，等下再说。', contextToken: item.contextToken })
    } finally {
      busy = false
      if (queue.length > 0) {
        const next = queue.shift()
        void runOne(next)
      }
    }
  }

  /** 一条入站消息的入口。返回 'approval' | 'ran' | 'queued' | 'dropped'。 */
  async function receive(item) {
    if (await handleApprovalReply(item)) return 'approval'
    if (busy) {
      if (queue.length >= queueMax) {
        stats.dropped += 1
        log(`[wechat] 队列满了（${queue.length}），丢掉一条`)
        await bridge.send({ text: '我这会儿在处理别的事，稍后回你。', contextToken: item.contextToken })
        return 'dropped'
      }
      queue.push(item)
      stats.queued += 1
      return 'queued'
    }
    void runOne(item)
    return 'ran'
  }

  return {
    receive,
    verdictOf,
    notifyAsk,
    stats: () => ({ ...stats, busy, queued: queue.length }),
  }
}
