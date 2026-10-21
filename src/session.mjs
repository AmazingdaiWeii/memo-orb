/**
 * session.mjs · 会话存储（新引擎用）
 *
 * ★ 先复用 history.mjs 的磁盘格式（读它、写同格式），不要另起一套。
 *
 * 磁盘格式（与旧后端本地后端一致）：
 *   DATA_ROOT/conversations/<base64("conversation:<id>")>/
 *     ├── conversation.json   元数据：{id, agent_id, summary, created_at, updated_at, last_message_at}
 *     └── messages.jsonl      逐行 JSONL，每行 {message:{id, role, content:[{type,text}], usage?}, ...}
 *
 * 这样新引擎写的会话，history.mjs 的 listConversations() / readConversationBlocks() 能直接读。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataRoot } from './memory.mjs'

// 与 history.mjs 保持一致的数据根算法；但**惰性求值**（见 memory.mjs dataRoot 注释），
// 否则 main.mjs 后设的 ORB_DATA 对这个模块不生效，local 会话会写进 ~/.legacy。
function conversationsDir() {
  return join(dataRoot(), 'conversations')
}

/**
 * base64 无 padding 编码（与旧后端本地后端的目录名算法一致）。
 *旧后端写的目录名是无 padding 的，Buffer.toString('base64') 会补 =，必须去掉。
 */
function dirNameFor(sessionId) {
  return Buffer.from(`conversation:${sessionId}`, 'utf8').toString('base64').replace(/=+$/, '')
}

/** 会话目录路径。 */
function sessionDir(sessionId) {
  return join(conversationsDir(), dirNameFor(sessionId))
}

/**
 * 生成一个简单的会话 id。
 * 格式：conv-<timestamp>-<random4>，足够唯一且可读。
 */
export function generateSessionId() {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 6)
  return `conv-${ts}-${rand}`
}

/**
 * 创建会话存储。
 * @param {object} o
 * @param {string} o.agentId
 */
export function createSessionStore({ agentId }) {
  if (!agentId) throw new Error('createSessionStore: agentId is required')

  return {
    /**
     * 创建一个新会话，写入 conversation.json。
     * 如果会话已存在，不覆盖，直接返回已有元数据。
     * @param {string} sessionId
     * @param {{summary?: string}} [opts]
     * @returns {object} conversation.json 的内容
     */
    create(sessionId, opts = {}) {
      const dir = sessionDir(sessionId)
      const metaFile = join(dir, 'conversation.json')

      // 已存在则不覆盖
      if (existsSync(metaFile)) {
        return JSON.parse(readFileSync(metaFile, 'utf8'))
      }

      mkdirSync(dir, { recursive: true })
      const now = new Date().toISOString()
      const meta = {
        id: sessionId,
        agent_id: agentId,
        summary: opts.summary || '',
        created_at: now,
        updated_at: now,
        last_message_at: now,
        archived: false,
      }
      // 无 BOM UTF-8（history.mjs 的注释明确说带 BOM 会让后端 JSON.parse 抛错）
      writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8')
      // ★ 会话一建出来就得有 messages.jsonl（可以是空文件）。
      //   history.mjs:178 的 listConversations 以「这个文件存在」当作「这条会话有内容」的判据，
      //   只写 conversation.json 的新会话永远不进历史抽屉（历史对话 bug D2/D5 的一半根因）。
      //   空文件对 readMessages / readConversationBlocks 都是安全的空列表。
      const msgFile = join(dir, 'messages.jsonl')
      if (!existsSync(msgFile)) writeFileSync(msgFile, '', 'utf8')
      return meta
    },

    /**
     * 追加一条消息到 messages.jsonl。
     * 同时更新 conversation.json 的 last_message_at / updated_at。
     *
     * @param {string} sessionId
     * @param {{id?: string, role: 'user'|'assistant', text: string, usage?: object,
     *          images?: Array<{mimeType: string, data: string}>}} msg
     *   `images` 是用户发来的图片（裸 base64）。它们会被写成 content 的
     *   `{type:'image', mimeType, data}` 片段 —— 与 history.mjs 的 `imagePartsOf`
     *   认的归一化形状一致，这样切走再切回时气泡里的「图片 ×N」和点开取图都还在。
     */
    appendMessage(sessionId, msg) {
      if (!msg || typeof msg.role !== 'string') {
        throw new Error('session.appendMessage: msg.role is required')
      }
      if (typeof msg.text !== 'string') {
        throw new Error('session.appendMessage: msg.text must be string')
      }

      const dir = sessionDir(sessionId)
      if (!existsSync(dir)) {
        // 自动创建会话
        this.create(sessionId)
      }

      const msgFile = join(dir, 'messages.jsonl')
      const messageId = msg.id || `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

      const content = [{ type: 'text', text: msg.text }]
      if (Array.isArray(msg.images)) {
        for (const img of msg.images) {
          const data = typeof img?.data === 'string' ? img.data : ''
          if (data === '') continue
          content.push({
            type: 'image',
            mimeType: typeof img.mimeType === 'string' && img.mimeType !== '' ? img.mimeType : 'image/png',
            data,
          })
        }
      }

      const entry = {
        message: {
          id: messageId,
          role: msg.role,
          content,
          ...(msg.usage ? { usage: msg.usage } : {}),
        },
        timestamp: new Date().toISOString(),
      }

      // 追加写入（UTF-8，每行一个 JSON）
      appendFileSync(msgFile, JSON.stringify(entry) + '\n', 'utf8')

      // 更新 conversation.json 的时间戳
      const metaFile = join(dir, 'conversation.json')
      try {
        const meta = JSON.parse(readFileSync(metaFile, 'utf8'))
        meta.updated_at = new Date().toISOString()
        meta.last_message_at = meta.updated_at
        writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8')
      } catch {
        // 更新元数据失败不影响消息本身（消息已经落盘了）
      }

      return messageId
    },

    /**
     * 读取会话的所有消息（原始格式，不做球侧 block 转换）。
     * @param {string} sessionId
     * @returns {Array<{role:string, text:string, id:string, usage?:object}>}
     */
    readMessages(sessionId) {
      const dir = sessionDir(sessionId)
      const msgFile = join(dir, 'messages.jsonl')
      if (!existsSync(msgFile)) return []

      const lines = readFileSync(msgFile, 'utf8').split(/\r?\n/).filter(Boolean)
      const out = []
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

        // 提取 text 内容（与 history.mjs 的逻辑一致，但不剥 system-reminder——那是球侧的事）
        let text = ''
        const content = message.content
        if (Array.isArray(content)) {
          const parts = []
          for (const part of content) {
            if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
              parts.push(part.text)
            }
          }
          text = parts.join('\n')
        } else if (typeof content === 'string') {
          text = content
        }

        out.push({
          id: message.id,
          role,
          text,
          usage: message.usage || null,
        })
      }
      return out
    },

    /**
     * 读取会话的 system 快照（`system.json`）。
     *
     * 为什么快照跟着会话走、而不是每次重算：I3 要求同一个会话里 system prompt
     * **字节不变**，否则上游前缀缓存每轮都失效、成本翻倍。
     * 返回 null 表示这个会话还没有快照（新会话），调用方应该渲染一份并写回。
     */
    readSystem(sessionId) {
      const file = join(sessionDir(sessionId), 'system.json')
      if (!existsSync(file)) return null
      try {
        const obj = JSON.parse(readFileSync(file, 'utf8'))
        return obj && typeof obj.content === 'string' ? obj : null
      } catch {
        return null
      }
    },

    /** 写入/覆盖会话的 system 快照。只在新建会话、压缩、手动 rebuild 时调用。 */
    writeSystem(sessionId, snapshot) {
      if (!snapshot || typeof snapshot.content !== 'string') {
        throw new Error('session.writeSystem: snapshot.content is required')
      }
      const dir = sessionDir(sessionId)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'system.json'), JSON.stringify(snapshot, null, 2), 'utf8')
      return snapshot
    },

    /**
     * 读取会话元数据。
     */
    getMeta(sessionId) {
      const metaFile = join(sessionDir(sessionId), 'conversation.json')
      if (!existsSync(metaFile)) return null
      try {
        return JSON.parse(readFileSync(metaFile, 'utf8'))
      } catch {
        return null
      }
    },

    /**
     * 会话是否存在。
     */
    exists(sessionId) {
      return existsSync(join(sessionDir(sessionId), 'conversation.json'))
    },
  }
}
