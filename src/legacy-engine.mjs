/**
 *旧后端 App Server 的客户端。
 *
 * 两层：
 *   startLegacyServer()  —— 拉起 legacy server 子进程，从 stdout 解析实际端口（动态端口，不占固定口）
 *   LegacyConnection     —— 一条 WebSocket，按 request_id 关联命令响应，事件走 EventEmitter
 *
 * 协议细节全部来自本机实测（见 docs/legacy-protocol.md）。
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'

const t = () => new Date().toISOString().slice(11, 19)
const stamp = (msg) => `[${t()}] ${msg}`

/**
 * 拉起 `legacy server --backend local --listen --openai-api`。
 * 省略 --listen 的 URL，让旧后端自己挑空闲端口，避免和别的 agent 撞口。
 */
export function startLegacyServer({ legacyJs, cwd, env = {}, log = console.log, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    if (!existsSync(legacyJs)) {
      reject(new Error(`找不到旧后端入口: ${legacyJs}`))
      return
    }
    const child = spawn(process.execPath, [legacyJs, 'server', '--backend', 'local', '--listen', '--openai-api'], {
      cwd,
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let settled = false
    let buf = ''
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`旧后端服务端 ${timeoutMs}ms 内没报出监听地址`))
    }, timeoutMs)

    const scan = (chunk) => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const s = line.trim()
        if (s) log(stamp(`legacy: ${s}`))
        const m = /^WebSocket:\s*(ws:\/\/\S+)$/.exec(s)
        if (m && !settled) {
          settled = true
          clearTimeout(timer)
          resolve({ child, wsUrl: m[1] })
        }
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', scan)
    child.stderr.on('data', scan)
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`旧后端服务端启动即退出，code=${code}`))
    })
  })
}

/** 一条 App Server WebSocket 连接。 */
export class LegacyConnection extends EventEmitter {
  #socket
  #url
  #pending = new Map()
  #seq = 0
  #closed = false

  constructor(url) {
    super()
    this.#url = url
  }

  get url() {
    return this.#url
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.#url)
      this.#socket = socket
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', () => reject(new Error(`连不上 ${this.#url}`)))
      socket.addEventListener('close', () => {
        this.#closed = true
        this.emit('closed')
      })
      socket.addEventListener('message', (event) => {
        let msg
        try {
          msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
        } catch {
          return
        }
        if (msg.request_id && this.#pending.has(msg.request_id)) {
          const { resolve: done, timer } = this.#pending.get(msg.request_id)
          this.#pending.delete(msg.request_id)
          clearTimeout(timer)
          done(msg)
          return
        }
        this.emit('event', msg)
      })
    })
  }

  /** 发一条带 request_id 的命令，等它的直接响应。 */
  request(type, extra = {}, timeoutMs = 30_000) {
    const id = `req-${++this.#seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`${type} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, timer })
      this.#send({ type, request_id: id, ...extra })
    })
  }

  /** 发一条不需要响应的命令。 */
  send(type, extra = {}) {
    this.#send({ type, ...extra })
  }

  #send(obj) {
    if (this.#closed || this.#socket?.readyState !== 1) {
      this.emit('dropped', obj)
      return
    }
    this.#socket.send(JSON.stringify(obj))
  }

  close() {
    try {
      this.#socket?.close()
    } catch {}
  }
}

// 球的权限下拉是 Claude Code 风格的三档，翻译成旧后端的 DevicePermissionMode。
// 注意 'standard' 会逐次弹审批，而球只有权限下拉、没有审批弹窗 —— 选错档位就会卡死。
const PERMISSION_MODES = {
  'read-only': 'strict',
  'workspace-write': 'acceptEdits',
  'danger-full-access': 'unrestricted',
}

/**
 * 建一个 agent 时**必须**带全的参数。
 *
 * ⚠️ 之前的 `create_agent.body` 只有 `{ name, memory_blocks: [], model }` ——
 * 缺 `system` / `tags` / `tools`。后果：
 *   ① 新 agent 拿不到人格（只能事后手工粘 system）；
 *   ② 没有 `git-memory-enabled` 标签就可能不挂 MemFS，记忆直接丢；
 *   ③ 没有 `agent_type: 'letta_v1_agent'`，建出来的和官方客户端建的不是一种东西。
 *
 * 字段名与取值**逐条对齐**官方 `buildCreateAgentRequest()`（`dist/agent-presets.js`）：
 *   - `DEFAULT_CREATED_AGENT_BASE_TOOLS = ['web_search','fetch_webpage']` + `include_base_tools:false`
 *   - `DEFAULT_ROOT_MEMORY_BLOCK = { label:'MEMORY', value:'# Memory\n', description:'Root memory index.' }`
 *   - `buildCreatedAgentTags({enableMemfs:true}) = ['origin:legacy-code','git-memory-enabled']`
 *   - `compaction_settings.model = 'legacy/auto'`
 *
 * memfs 不是 body 里的布尔字段，是靠 `git-memory-enabled` 这个 tag 开的 ——
 * **所以 tag 不能少**。
 */
export function buildCreateAgentBody({ name, system, model, description, enableMemfs = true }) {
  return {
    agent_type: 'letta_v1_agent',
    name: name ?? 'Orb',
    ...(description ? { description } : {}),
    model,
    // system 为空时**不要**塞空串 —— 空串会覆盖掉后端的默认预设。缺就整个字段不传。
    ...(system ? { system } : {}),
    memory_blocks: [
      { label: 'MEMORY', value: '# Memory\n', description: 'Root memory index.' },
    ],
    tags: enableMemfs ? ['origin:legacy-code', 'git-memory-enabled'] : ['origin:legacy-code'],
    tools: ['web_search', 'fetch_webpage'],
    include_base_tools: false,
    include_base_tool_rules: false,
    initial_message_sequence: [],
    parallel_tool_calls: true,
    compaction_settings: { model: 'legacy/auto' },
  }
}

/**
 * 协议里跟「开一个 runtime」有关的封装。
 *
 * @param {object} o
 * @param {string} [o.agentId]   传了就复用它；不传就现建一个
 * @param {string} [o.system]    建新 agent 时写进 system 字段（persona）
 * @param {string} [o.description]
 * @param {boolean} [o.enableMemfs]
 */
export async function startRuntime(conn, { agentId, model, name, system, description, enableMemfs, conversationId, permission }) {
  const payload = {
    mode: PERMISSION_MODES[permission] ?? 'unrestricted',
    client_info: { name: 'orb-standalone', title: 'Orb', version: '0.1.0' },
    recover_approvals: true,
    force_device_status: true,
  }
  if (agentId) payload.agent_id = agentId
  else payload.create_agent = { body: buildCreateAgentBody({ name, model, system, description, enableMemfs }) }
  if (conversationId) payload.conversation_id = conversationId
  else payload.create_conversation = { body: {} }

  const res = await conn.request('runtime_start', payload, 120_000)
  if (!res.success) throw new Error(`runtime_start 失败: ${JSON.stringify(res).slice(0, 300)}`)
  return { runtime: res.runtime, agent: res.agent, created: res.created }
}
