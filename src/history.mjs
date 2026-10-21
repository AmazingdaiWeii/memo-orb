/**
 * 历史对话读取（独立版新增，2026-10-06）。
 *
 * 为什么直接读磁盘而不走旧后端协议：
 *旧后端的 App Server 协议（runtime_start / input / abort_message）里
 * **没有「列出所有 conversation」这个请求** —— 它只给前端推送当前会话。
 * 而本地后端把所有 conversation 明文存在
 *   ~/.legacy/lc-local-backend/conversations/<base64(id)>/conversation.json
 * 目录名是 base64("conversation:<id>")，解码回真实 id。
 * 同目录的 messages.jsonl 是逐行 JSONL，可以取首条用户消息当标题。
 *
 * 好处：零协议改动、不用起额外进程。
 * 已知局限：只认本机 local backend —— 换成远端 backend 就读不到。
 * 将来要支持跨设备，得换成旧后端的 HTTP API。
 *
 * ⚠️ 本文件是纯 JS（.mjs），**不能用 TypeScript 语法**。
 *    踩过：写了 `interface` / `as X` / `name: string` 导致 SyntaxError。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataRoot } from './memory.mjs'

/** 项目根 —— 与 `src/` 其它模块同一套算法（`dirname` 两级），保证整个目录能搬盘。 */
const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 一条历史对话。
 * @typedef {{ sessionId: string, title: string, updatedAt: string }} HistoryItem
 */

/**
 * 会话目录。
 *
 * ★ 2026-10-19 剥离后改成**惰性**读 `dataRoot()`（src/memory.mjs）：
 *   - 模块顶层冻结会在 main.mjs 设 `ORB_DATA` 之前就把 `~/.legacy` 定死；
 *   - engine='local' 时 dataRoot() = 项目根 `data/`，历史面板才能看见新引擎写的会话。
 * 旧仓仍然是兜底（dataRoot 的默认值就是 `~/.legacy/lc-local-backend`），行为对老数据不变。
 */
function conversationsDir() {
  return join(dataRoot(), 'conversations')
}

/**
 * 删除记录放哪儿。
 *
 * ⚠️ **不能写死 `~/Orb`** —— 项目整个目录是可以搬盘的（这是项目铁律），
 * 写死 home 下的固定路径会跟实际项目位置脱节，删除记录会跑到别处去。
 * 所以优先用 `ORB_LOGS_DIR` 环境变量，其次退回项目根的 `logs/`。
 *
 * 只记元信息（id / 标题 / 时间 / 目录名），**不记消息正文** —— 免得
 * 记账文件本身变成一份没加密的对话导出。
 */
const LOG_DIR = process.env.ORB_LOGS_DIR
  ? join(process.env.ORB_LOGS_DIR, 'history-backups')
  : join(PROJECT_ROOT, 'logs', 'history-backups')

/**
 * 导出目录（对话隐私锁的逃生通道，方案 §7）。
 * 同样不写死 home 路径 —— 项目目录可搬盘，跟着 `resolve(ROOT, …)` 走。
 */
const EXPORT_DIR = process.env.ORB_EXPORT_DIR
  ? process.env.ORB_EXPORT_DIR
  : join(PROJECT_ROOT, 'exports')

/**
 * 扫出所有 conversation，附带它所在的**真实目录名**。
 *
 * ⚠️ 为什么不能按 id 反推目录名（踩过）：
 *  1.旧后端写的目录名是 **base64 无 padding**（`...LWNvbnYtMzc`），
 *     而 `Buffer.toString('base64')` 会补 `=`（`...LWNvbnYtMzc=`）→ 拼出来的路径必然不存在。
 *  2. 目录名的解码结果不总是 `conversation:<id>`。实测存在
 *     `ZGVmYXVsdDphZ2VudC1sb2NhbC1...` → `default:agent-local-<agentId>`，
 *     meta.id 是 `default`，它是旧后端给 agent 建的**默认会话占位**，没有 messages.jsonl。
 *
 * 所以一律「先扫盘、从 meta.id 反查目录」，不做任何路径拼接。
 *
 * @returns {Array<{ dir: string, meta: Record<string, unknown>, name: string }>}
 */
function scanConversations() {
  const dirRoot = conversationsDir()
  if (!existsSync(dirRoot)) return []
  let names
  try {
    names = readdirSync(dirRoot)
  } catch {
    return []
  }
  const rows = []
  for (const name of names) {
    const dir = join(dirRoot, name)
    const meta = readJson(join(dir, 'conversation.json'))
    if (!meta || typeof meta.id !== 'string') continue
    rows.push({ dir, meta, name })
  }
  return rows
}

/** 按 meta.id 找目录 —— 这是唯一可靠的定位方式。 */
function findById(sessionId) {
  const target = String(sessionId ?? '')
  if (target === '') return null
  for (const row of scanConversations()) {
    if (row.meta.id === target) return row
  }
  return null
}

function readJson(path) {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 剥掉旧后端注入的 `<system-reminder>…</system-reminder>` 环境说明块。 */
export function stripSystemReminder(text) {
  return String(text)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<system-reminder>[\s\S]*$/, '')
    .trim()
}

/**
 * 取首条真实用户消息当标题。
 *
 * 两个实测踩到的坑：
 *  1. 首条 user 消息前面挂着一大段 `<system-reminder>…</system-reminder>` 环境说明
 *     （本地时间、设备类型、cwd 等），不清掉的话标题就是一整屏环境变量。
 *  2. content 是数组，可能多个片段，也可能第一个是空的 —— 取第一个非空 text。
 */
function titleFromMessages(dir) {
  const file = join(dir, 'messages.jsonl')
  try {
    if (!existsSync(file)) return ''
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    for (const line of lines) {
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const message = entry.message
      if (!message || message.role !== 'user') continue
      const content = message.content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        if (!part || typeof part !== 'object') continue
        const text = part.text
        if (typeof text !== 'string' || text.trim() === '') continue
        const cleaned = stripSystemReminder(text)
        if (cleaned !== '') return cleaned.slice(0, 40)
      }
    }
  } catch {
    // 读不了就当没标题，不影响列表本身
  }
  return ''
}

/**
 * 列出本机的 conversation，按最后消息时间倒序（最近的在最前）。
 * @param {string | null | undefined} agentId 只列属于该 agent 的；不传则全列
 * @returns {HistoryItem[]}
 */
export function listConversations(agentId) {
  const rows = scanConversations()
  const items = []
  for (const { dir, meta } of rows) {
    if (meta.archived === true) continue                        // 归档的不进历史列表
    if (agentId && typeof meta.agent_id === 'string' && meta.agent_id !== agentId) continue
    // 只认真正聊过天的会话：旧后端给 agent 建的 `default` 占位会话没有
    // messages.jsonl，列出来只会得到一条点进去空白的「(无标题)」。
    if (!existsSync(join(dir, 'messages.jsonl'))) continue
    const summary = typeof meta.summary === 'string' ? meta.summary : ''
    items.push({
      sessionId: meta.id,
      title: summary !== '' ? summary : titleFromMessages(dir),
      updatedAt: typeof meta.last_message_at === 'string'
        ? meta.last_message_at
        : typeof meta.updated_at === 'string' ? meta.updated_at : '',
    })
  }
  items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  return items
}

/**
 * 重命名一条对话（改`conversation.json` 的 `summary`）。
 *
 * 为什么改summary 而不是标题文件：列表标题的取值优先级是
 * `summary` → 首条用户消息（见 `listConversations`），而`summary`
 * 本来就是「标题」这件事在旧后端侧的载体，改它最小侵入。
 *
 * ⚠️ 局限性：历史列表里那些**没有 summary** 的会话（标题来自首条消息），
 * 改summary 之后标题会变 —— 这是对的；但如果用户改回空串，列表会退回
 * 首条消息，所以「清空标题」这个操作实际上做不到，需要 UI 上明确说明。
 *
 * @param {string} sessionId
 * @param {string} title 新标题。会 trim，**空串视为无效**。
 * @returns {{ ok: true, title: string } | { ok: false, error: string }}
 */
export function renameConversation(sessionId, title) {
  const clean = String(title ?? '').trim()
  if (clean === '') return { ok: false, error: '标题不能为空' }
  if (clean.length > 200) return { ok: false, error: '标题太长了（上限 200 字）' }
  const row = findById(sessionId)
  if (!row) return { ok: false, error: '找不到这条对话' }

  const file = join(row.dir, 'conversation.json')
  const meta = readJson(file)
  if (!meta) return { ok: false, error: '对话元数据读不出来' }

  const next = { ...meta, summary: clean }
  try {
    // 无 BOM UTF-8 —— 带 BOM 会让后端 JSON.parse 直接抛错（这个坑踩过）
    writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    return { ok: false, error: `写入失败：${err.message}` }
  }
  return { ok: true, title: clean }
}

/**
 * 删除一条对话 —— **不可逆**，整个会话目录一起删。
 *
 * ⚠️ 两条安全约束（都是为了防止误删把自己的记忆一起搞没）：
 *  1. `default` 占位会话**拒绝删** —— 它属于 agent，删了后端会重新建。
 *  2. 先把要删的会话数出来写进 `logs/history-backups/` —— 不做能回滚的备份，
 *     用户点错了就真没了。备份是文本记录（id + 标题 + 时间），不是消息内容，
 *     所以不会额外泄漏隐私。
 *
 * @param {string} sessionId
 * @returns {{ ok: true, sessionId: string } | { ok: false, error: string }}
 */
export function deleteConversation(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, error: '缺少 sessionId' }
  }
  const row = findById(sessionId)
  if (!row) return { ok: false, error: '找不到这条对话' }
  if (row.meta.id === 'default') {
    return { ok: false, error: '这是 agent 的默认会话，不能删' }
  }
  // 只认有 messages.jsonl 的真实会话，避免手滑删掉不该动的目录
  if (!existsSync(join(row.dir, 'messages.jsonl'))) {
    return { ok: false, error: '这条对话没有消息记录，不删' }
  }

  const label = typeof row.meta.summary === 'string' && row.meta.summary !== ''
    ? row.meta.summary
    : '(无标题)'
  try {
    rmSync(row.dir, { recursive: true, force: false })
  } catch (err) {
    return { ok: false, error: `删除失败：${err.message}` }
  }
  // 删完再记：记的是「删过什么」，用于事后追溯
  appendDeleteLog({ sessionId, label, dir: row.name })
  return { ok: true, sessionId }
}

/** 往logs/history-backups/ 追加一条删除记录（只记元信息，不记消息正文）。 */
function appendDeleteLog(entry) {
  try {
    const dir = LOG_DIR
    // 目录不存在就建：删除是不可逆的，**记账必须可靠**，不能因为目录没预建就悄悄丢记录。
    mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({
      at: new Date().toISOString(),
      ...entry,
    })
    writeFileSync(join(dir, 'deleted.jsonl'), `${line}\n`, { encoding: 'utf8', flag: 'a' })
  } catch {
    // 记账失败不该让删除失败 —— 删除已经发生了。
    // 但这条 catch 意味着可能没有记录，所以上面已在文档里写明这是最后一道防线。
  }
}

/**
 * 读某个 conversation 的完整消息，转成球的 block 协议。
 * 球侧按 user 块切 turn，所以这里要把消息按顺序铺成 block 列表。
 *
 * @param {string} sessionId
 * @returns {{ blocks: Array<object>, participants: Array<object> } | null}
 */
/**
 * 从一条消息的 `content` 里挑出图片 part（P2-4 补）。
 *
 * 磁盘上落的是两代形状，都要认：
 *  1. 本地后端归一化后的 `{ type:'image', mimeType, data }` —— 真实 messages.jsonl 实测形状；
 *  2. 兼容旧形状：`{ type:'image', source:{ type:'base64', media_type, data } }`
 *     与 `{ type:'image_url'|'input_image', image_url:'data:…;base64,…' }`。
 * `data` 一律是**裸 base64**（不含 `data:` 前缀）。
 *
 * ⚠️ 磁盘上**没有原始文件名**（只存了图本身），所以历史回放只能还原「有几张」。
 */
function imagePartsOf(content) {
  const out = []
  if (!Array.isArray(content)) return out
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const type = typeof part.type === 'string' ? part.type : ''
    if (type === 'image') {
      // 归一化形状把 data/mimeType 放在 part 上；旧形状放在 part.source 里
      const src = part.source && typeof part.source === 'object' ? part.source : part
      const data = typeof src.data === 'string' ? src.data : ''
      if (data === '') continue
      const mime = typeof src.mimeType === 'string' && src.mimeType !== ''
        ? src.mimeType
        : (typeof src.media_type === 'string' && src.media_type !== '' ? src.media_type : 'image/png')
      out.push({ mimeType: mime, data })
      continue
    }
    if (type === 'image_url' || type === 'input_image') {
      const url = typeof part.image_url === 'string'
        ? part.image_url
        : (part.image_url && typeof part.image_url.url === 'string' ? part.image_url.url : '')
      const m = /^data:([^;,]+);base64,(.+)$/.exec(url)
      if (m) out.push({ mimeType: m[1], data: m[2] })
    }
  }
  return out
}

export function readConversationBlocks(sessionId) {
  const row = findById(sessionId)
  if (!row) return null
  const file = join(row.dir, 'messages.jsonl')
  if (!existsSync(file)) return null
  let lines
  try {
    lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  } catch {
    return null
  }
  const blocks = []
  const participants = []
  for (const line of lines) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const message = entry.message
    if (!message || typeof message.id !== 'string') continue
    const role = message.role
    if (role !== 'user' && role !== 'assistant') continue

    // 球侧只认 kind: 'user' / 'assistant'，正文走 block.text。
    //
    // ⚠️ 三个实测踩到的点（都来自真实 messages.jsonl）：
    //  1. 首行是 metadata（顶层只有 type/version/id/timestamp/cwd，没有 message）→ 已过滤。
    //  2. content 是**多 part 数组**，首条 user 被拆成 4 个 part，其中 3 个是
    //     `<system-reminder>` 环境说明。必须**逐 part** 剥壳，不能 join 之后再剥 ——
    //     join 完再剥一旦某个 reminder 没闭合，剩下半截就会污染正文。
    //  3. assistant 有 `type: 'thinking'` 的 part，text 为空 → 按 type 白名单取更保险。
    const textParts = []
    const content = message.content
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue
        const type = typeof part.type === 'string' ? part.type : 'text'
        if (type !== 'text') continue                      // 跳过 thinking / tool_call 等
        if (typeof part.text !== 'string' || part.text.trim() === '') continue
        const cleaned = role === 'user' ? stripSystemReminder(part.text) : part.text
        if (cleaned !== '') textParts.push(cleaned)
      }
    } else if (typeof content === 'string' && content.trim() !== '') {
      const cleaned = role === 'user' ? stripSystemReminder(content) : content
      if (cleaned !== '') textParts.push(cleaned)
    }
    const text = textParts.join('\n')
    if (text === '') continue

    if (role === 'user') {
      const k = `u:${message.id}`
      const rec = { key: k, kind: 'user', text, running: false }
      // 图片条数（P2-4 补）：不带这个字段，历史回放出来的块就「看起来从没带过图」，
      // 切走再切回时气泡里那张图直接消失（V6 实测故障）。
      const images = imagePartsOf(content)
      if (images.length > 0) rec.imageCount = images.length
      blocks.push(rec)
      participants.push({ id: k, name: '用户', kind: 'user' })
    } else {
      const k = `a:${message.id}`
      const rec = { key: k, kind: 'assistant', text, running: false }
      // usage 能还原就带上（球上会显示 token / 耗时），没有也不影响显示
      if (message.usage && typeof message.usage === 'object') rec.usage = message.usage
      blocks.push(rec)
    }
  }
  if (blocks.length === 0) return null
  // 最后一个 assistant 块标为最终答案 —— 折叠态球只显示带 data-response 的那条
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].kind === 'assistant') {
      blocks[i].response = true
      break
    }
  }
  return { blocks, participants }
}

/**
 * 按需取某条消息里的图片本体（P2-4 补，球点了「图片 ×N」占位才调）。
 *
 * ⚠️ 为什么不随块一起推：图是完整 base64，塞进块里走 innerHTML 级渲染会把面板
 *    卡死（见 `src/main.mjs` onUserPrompt 的注释）。所以只推张数，本体等点击再取。
 *
 * @param {string} sessionId 会话 id（= 块 key 里 `|` 之前那一段）
 * @param {string} messageId旧后端的消息 id（形如 `ui-msg-322`）
 * @returns {Array<{mimeType: string, data: string}> | null} 找不到返回 null
 */
export function readMessageImages(sessionId, messageId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  if (typeof messageId !== 'string' || messageId === '') return null
  const row = findById(sessionId)
  if (!row) return null
  const file = join(row.dir, 'messages.jsonl')
  if (!existsSync(file)) return null
  let lines
  try {
    lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  } catch {
    return null
  }
  for (const line of lines) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const message = entry.message
    if (!message || message.id !== messageId) continue
    return imagePartsOf(message.content)
  }
  return null
}

/**
 * 遗忘逃生通道（对话加密_落地方案.md §7）。
 *
 * 强锁密码忘了 → UI 上**进不去**（这是设计目标），但 `messages.jsonl` 始终是
 * 明文，所以这里直接把磁盘上的对话序列化成 txt —— **不经任何解锁**。
 *
 * ⚠️ 为什么这不是「把强锁废掉」：
 *   强锁的定位是「防君子不防小人」（方案 §1）。它挡的是**偷看屏幕的人**，
 *   本来就不承担磁盘级保密 —— 能读到本机文件的人，本来就能拿 vim 打开
 *   `messages.jsonl`。导出只是把「用记事本翻 JSONL」变成「点一个按钮」，
 *   不改变任何实际暴露面，但把「忘了密码 = 对话彻底读不了」这条死路解开了。
 *   用户原话就写在这儿：「由于架构的问题，对话是可以导出的」。
 *
 * 导出位置固定在项目根的 `exports/` —— 不弹「另存为」（这种无边框透明窗口里
 * 原生文件对话框不好伺候），导出完把路径回报给球，用户自己去找。
 *
 * @returns {{ok: boolean, path?: string, bytes?: number, blocks?: number, error?: string}}
 */
export function exportConversation(sessionId) {
  const row = findById(sessionId)
  if (!row) return { ok: false, error: '找不到这条对话' }
  const loaded = readConversationBlocks(sessionId)
  if (!loaded || loaded.blocks.length === 0) return { ok: false, error: '这条对话没有可导出的正文' }

  const lines = [
    `# 对话导出`,
    `# 会话：${sessionId}`,
    `# 导出时间：${new Date().toISOString()}`,
    `# 说明：强锁密码忘记时的自救通道，直读磁盘明文，不经解锁。`,
    '',
  ]
  for (const b of loaded.blocks) {
    const who = b.kind === 'user' ? '我' : '她'
    lines.push(`──── ${who} ────`)
    lines.push(b.text)
    lines.push('')
  }
  const body = `${lines.join('\n')}\n`

  try {
    const dir = join(EXPORT_DIR)
    mkdirSync(dir, { recursive: true })
    // 文件名带上时间戳，重复导出不覆盖（用户可能导好几次）
    const safeId = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const file = join(dir, `${safeId}_${stamp}.txt`)
    writeFileSync(file, body, 'utf8')
    return { ok: true, path: file, bytes: Buffer.byteLength(body, 'utf8'), blocks: loaded.blocks.length }
  } catch (err) {
    return { ok: false, error: `写入失败：${err.message}` }
  }
}
