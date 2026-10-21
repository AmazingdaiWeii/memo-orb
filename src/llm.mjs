/**
 * llm.mjs · OpenAI 兼容 LLM 客户端（流式 + tool call + 重试）
 *
 * 这是从 dc-01 / dc-02 探针里提炼出来的模块，是新引擎的通信底座。
 *
 * 接口：
 *   createLLM({ baseUrl, apiKey, model, timeoutMs })
 *     .stream({ messages, tools? }) → async generator
 *
 * 产出事件：
 *   { type:'reasoning', id, text }
 *   { type:'content',   id, text }           // 增量文本
 *   { type:'tool_call', id, name, args }     // args 已 JSON.parse（流结束时统一产出）
 *   { type:'done', stopReason, usage:{promptTokens,completionTokens,totalTokens} }
 *
 * 可靠性：
 *   - 429 / 5xx / 网络错误 → 指数退避重试（最多 3 次，仅在尚未产出任何事件时）
 *   - 超时 → AbortController 中止
 *   - 流中断 → 抛错（上层决定是否重试）
 *   - 失败一律 throw，禁止静默吞错
 */

// ── 工具函数 ──────────────────────────────────────────────

/** 缺省推理档位。用户 2026-10-20 明确要求「把推理模式打开」，取最高档。 */
export const DEFAULT_REASONING_EFFORT = 'max'
/** 缺省输出上限。思考 token 计入 completion，给小了会被思考吃掉。 */
export const DEFAULT_MAX_TOKENS = 32000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 指数退避：attempt 从 1 开始，1s → 2s → 4s，上限 8s */
function backoffMs(attempt) {
  return Math.min(1000 * 2 ** (attempt - 1), 8000)
}

// ── SSE 解析器（把 fetch ReadableStream 切成 SSE 事件） ───

async function* sseLines(reader) {
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // SSE 事件以 \n\n 分隔
    const parts = buffer.split('\n\n')
    buffer = parts.pop() || ''
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (data) yield data
        }
      }
    }
  }
  // 处理 buffer 里剩余的
  if (buffer.trim()) {
    for (const line of buffer.split('\n')) {
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim()
        if (data) yield data
      }
    }
  }
}

// ── 单次请求（不含重试） ──────────────────────────────────

/**
 * 发一次流式请求，产出事件。
 * 返回 { generator, hasYielded } 供外层判断是否可以重试。
 */
function requestOnce({ baseUrl, apiKey, model, messages, tools, timeoutMs, signal, reasoningEffort, maxTokens }) {
  const url = `${baseUrl}/chat/completions`
  // ── 思考（推理）档位 ────────────────────────────────────────
  // 2026-10-20 实测（deepseek-flash，api.deepseek.com）：
  //   · 不传任何字段时**服务端默认就在思考**（reasoning_tokens 实测 2598）；
  //   · OpenAI 兼容端点认 `reasoning_effort`，合法值来自 422 报文：
  //     none | minimal | low | medium | high | xhigh | ultra | max（传 'off' 直接 422）；
  //   · 关思考要显式 `thinking:{type:'disabled'}`（实测 reasoning_content 为空、正文正常）。
  // DSH 自己走的是 Anthropic 兼容端点（thinking + output_config.effort，缺省 high），
  // 本文件走 OpenAI 兼容端点，等价开关是下面这对字段。
  const effort = String(reasoningEffort || DEFAULT_REASONING_EFFORT).toLowerCase()
  const thinkingOff = effort === 'off' || effort === 'none'
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    temperature: 0.7,
    // 显式给足输出预算：思考 token 也算在 completion 里，不给上限时服务端默认值
    // 可能先被思考吃掉（长回合会被截成 finish_reason=length）。
    ...(Number(maxTokens) > 0 ? { max_tokens: Number(maxTokens) } : {}),
    ...(thinkingOff
      ? { thinking: { type: 'disabled' } }
      : { thinking: { type: 'enabled' }, reasoning_effort: effort }),
  }

  const controller = new AbortController()
  // 外部 signal + 内部超时
  const timeoutId = timeoutMs ? setTimeout(() => controller.abort(new Error('LLM request timeout')), timeoutMs) : null
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }

  const hasYielded = { value: false }
  // ★ 首字延迟与缓存命中都要可观测：没有这两个数字，「前缀稳定」这件事无法验证（见设计 §3.5）
  const startedAt = Date.now()
  let firstTokenMs = null
  const markFirstToken = () => { if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt }

  const generator = (async function* () {
    let resp
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      const err = new Error(`LLM HTTP ${resp.status} ${resp.statusText}: ${errText.slice(0, 500)}`)
      err.status = resp.status
      err.isRetryable = resp.status === 429 || resp.status >= 500
      throw err
    }

    const reader = resp.body.getReader()

    // 增量 tool_call 拼接：index → { id, name, argsPieces }
    const toolCallBuf = new Map()
    let responseId = null
    let usage = null
    let finishReason = null

    try {
      for await (const dataStr of sseLines(reader)) {
        if (dataStr === '[DONE]') continue

        let chunk
        try {
          chunk = JSON.parse(dataStr)
        } catch {
          continue // 跳过心跳 / 非 JSON
        }

        if (chunk.id) responseId = chunk.id
        if (chunk.usage) usage = chunk.usage

        const choice = chunk.choices?.[0]
        if (!choice) continue
        if (choice.finish_reason) finishReason = choice.finish_reason

        const delta = choice.delta
        if (!delta) continue

        // 内容增量
        if (delta.content) {
          markFirstToken()
          hasYielded.value = true
          yield { type: 'content', id: responseId, text: delta.content }
        }

        // 推理内容（DeepSeek reasoner 等）
        if (delta.reasoning_content) {
          markFirstToken()
          hasYielded.value = true
          yield { type: 'reasoning', id: responseId, text: delta.reasoning_content }
        }

        // tool_calls 增量（按 index 拼接 arguments）
        if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
          markFirstToken()
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            let buf = toolCallBuf.get(idx)
            if (!buf) {
              buf = { id: tc.id || null, name: tc.function?.name || '', argsPieces: [] }
              toolCallBuf.set(idx, buf)
            }
            if (tc.id) buf.id = tc.id
            if (tc.function?.name) buf.name = tc.function.name
            if (tc.function?.arguments) buf.argsPieces.push(tc.function.arguments)
          }
        }
      }
    } catch (err) {
      // 流中断
      if (!hasYielded.value) {
        err.isRetryable = true // 还没产出东西，可以重试
      }
      throw err
    }

    // 流结束：产出所有 tool_call（统一解析 arguments）
    if (toolCallBuf.size > 0) {
      hasYielded.value = true
      // 按 index 顺序产出
      const sorted = [...toolCallBuf.entries()].sort((a, b) => a[0] - b[0])
      for (const [, buf] of sorted) {
        const rawArgs = buf.argsPieces.join('')
        let args
        try {
          args = rawArgs ? JSON.parse(rawArgs) : {}
        } catch (err) {
          // arguments 不是合法 JSON —— 不静默吞，把原始字符串放进去并标注
          args = { _parseError: err.message, _raw: rawArgs }
        }
        yield { type: 'tool_call', id: buf.id, name: buf.name, args }
      }
    }

    // done 事件
    hasYielded.value = true
    yield {
      type: 'done',
      stopReason: finishReason,
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0,
            totalTokens: usage.total_tokens ?? 0,
            // DeepSeek 的缓存字段：命中（便宜）与未命中（贵）分开给，才能算命中率
            cacheHitTokens: usage.prompt_cache_hit_tokens ?? 0,
            cacheMissTokens: usage.prompt_cache_miss_tokens ?? 0,
            reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
            firstTokenMs,
          }
        : null,
    }
  })()

  return { generator, hasYielded }
}

// ── 对外类 ────────────────────────────────────────────────

class LLMClient {
  constructor({ baseUrl, apiKey, model, timeoutMs = 60000, maxRetries = 3, settings = null }) {
    if (!baseUrl) throw new Error('createLLM: baseUrl is required')
    if (!apiKey) throw new Error('createLLM: apiKey is required')
    if (!model) throw new Error('createLLM: model is required')
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.apiKey = String(apiKey)
    this.model = String(model)
    this.timeoutMs = Number(timeoutMs) || 60000
    this.maxRetries = Number(maxRetries) || 3
    // settings 是 createSettings() 的句柄。**每次 stream 读一次**，
    // 于是 config.json 里改 reasoningEffort/maxTokens 下一轮就生效，不用重启。
    this.settings = settings
  }

  /** 读本轮生效的思考档位与输出上限（settings 缺失/异常时退回缺省）。 */
  turnOptions() {
    let s = {}
    try {
      s = this.settings?.get?.() ?? {}
    } catch {
      s = {}
    }
    return {
      reasoningEffort: s.reasoningEffort || DEFAULT_REASONING_EFFORT,
      maxTokens: Number(s.maxTokens) > 0 ? Number(s.maxTokens) : DEFAULT_MAX_TOKENS,
    }
  }

  /**
   * 流式对话。
   * @param {object} o
   * @param {Array<{role:string,content:string}>} o.messages
   * @param {Array} [o.tools]  OpenAI 格式的 tools 定义
   * @param {AbortSignal} [o.signal]
   * @returns {AsyncGenerator} 产出事件（见文件头）
   */
  async *stream({ messages, tools, signal }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('LLM.stream: messages must be a non-empty array')
    }

    let lastError = null

    // 每轮开头读一次档位：config.json 改完不必重启
    const turnOpts = this.turnOptions()

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const wait = backoffMs(attempt)
        await sleep(wait)
      }

      const { generator, hasYielded } = requestOnce({
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        model: this.model,
        messages,
        tools,
        timeoutMs: this.timeoutMs,
        signal,
        reasoningEffort: turnOpts.reasoningEffort,
        maxTokens: turnOpts.maxTokens,
      })

      try {
        for await (const event of generator) {
          yield event
        }
        return // 成功完成
      } catch (err) {
        lastError = err

        // 已经产出过事件 → 不能重试（上层已经收到部分内容）
        if (hasYielded.value) {
          throw err
        }

        // 判断是否可重试
        const isRetryable = err.isRetryable || err.status === 429 || (err.status && err.status >= 500) || err.name === 'AbortError'
        if (!isRetryable || attempt >= this.maxRetries) {
          throw err
        }
        // 可重试，继续循环
      }
    }

    // 理论上不会到这里
    throw lastError || new Error('LLM.stream: unknown error')
  }
}

/**
 * 工厂函数。
 * @param {object} o
 * @param {string} o.baseUrl   API 基础 URL（如 https://api.deepseek.com/v1）
 * @param {string} o.apiKey    API 密钥
 * @param {string} o.model     模型名
 * @param {number} [o.timeoutMs=60000]  单次请求超时
 * @param {number} [o.maxRetries=3]     最大重试次数
 * @returns {LLMClient}
 */
export function createLLM(o) {
  return new LLMClient(o)
}
