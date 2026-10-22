/**
 * OpenAI 兼容 TTS 适配器（`POST {baseUrl}/audio/speech`）。
 *
 * ─────────────────────────────────────────────────────────────────
 * 为什么单独做这一个
 * ─────────────────────────────────────────────────────────────────
 * 语音合成**没有行业标准**，但有一个事实标准：OpenAI 的这个端点。
 * 因为它太常见，一堆第三方都照着它做——聚合网关（one-api / new-api 之类）、
 * 自建服务、甚至不少厂商的「OpenAI 兼容模式」。所以：
 *
 *   做火山的适配 → 只服务「有火山 key 的人」
 *   做这个适配   → 一次覆盖「绝大多数别家」
 *
 * 开源出去以后，别人想接 MiniMax / Azure / 硅基流动 / 自建，八成不用改代码，
 * 只要在设置里填对 `baseUrl` + `model` + `voice` 三个字段。
 *
 * ─────────────────────────────────────────────────────────────────
 * 与火山的形状差异（别照抄火山的写法）
 * ─────────────────────────────────────────────────────────────────
 *   · 鉴权是单个 `Authorization: Bearer <key>`，不是「appId + accessKey + resource 头」三件套
 *   · **返回的是二进制音频**，不是 JSON + base64。所以这里读 `arrayBuffer()`，
 *     绝不能 `res.text()`（那样会得到一个 500KB 的乱码字符串，还看不出错在哪）
 *   · 出错时才返回 JSON `{error:{message}}` ⇒ 先看 content-type，再看 status
 */

const DEFAULT_TIMEOUT_MS = 30_000

/** 缺省值：按 OpenAI 官方端点写，用户改 baseUrl 就能指向别家。 */
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_MODEL = 'tts-1'
export const DEFAULT_VOICE = 'alloy'

/** OpenAI 只认这几种；填错了它不会帮你降级，直接 400。 */
export const OPENAI_FORMATS = ['mp3', 'opus', 'aac', 'flac', 'wav']

const FORMAT_MIME = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
}

/**
 * 拼端点。用户很可能把 baseUrl 填成这几种之一，全都要接住：
 *   `https://api.openai.com`                 → `/v1/audio/speech`
 *   `https://api.openai.com/v1`              → `/v1/audio/speech`
 *   `https://api.openai.com/v1/`             → `/v1/audio/speech`
 *   `https://gw.example.com/v1/audio/speech` → 原样用（有人习惯填全路径）
 *
 * @param {string} baseUrl
 * @returns {string}
 */
export function speechUrl(baseUrl) {
  const raw = String(baseUrl ?? '').trim()
  if (raw === '') return `${DEFAULT_BASE_URL}/audio/speech`
  const trimmed = raw.replace(/\/+$/, '')
  if (/\/audio\/speech$/i.test(trimmed)) return trimmed
  if (/\/v\d+$/i.test(trimmed)) return `${trimmed}/audio/speech`
  return `${trimmed}/v1/audio/speech`
}

/**
 * 构造请求体。纯函数，便于单测「发出去的到底是什么形状」。
 *
 * @param {object} o
 * @param {string} o.text
 * @param {string} [o.model]
 * @param {string} [o.voice]
 * @param {string} [o.format]  OPENAI_FORMATS 之一
 * @param {number} [o.speed]   0.25 ~ 4.0，超出会被服务端拒
 */
export function buildSpeechBody(o = {}) {
  const format = OPENAI_FORMATS.includes(o.format) ? o.format : 'mp3'
  const speed = Number(o.speed)
  const body = {
    model: o.model || DEFAULT_MODEL,
    input: String(o.text ?? ''),
    voice: o.voice || o.speaker || DEFAULT_VOICE,
    response_format: format,
  }
  // 只在用户真给了速度时才带这个字段：有的网关对 speed 支持不好，
  // 默认带上 1.0 反而可能被拒（实测过某些代理会 400）。
  if (Number.isFinite(speed) && speed > 0) body.speed = Math.min(4, Math.max(0.25, speed))
  return body
}

/**
 * 创建一个 OpenAI 兼容适配器。对外契约与 `volcano.mjs` 完全一致：
 * `{ speak, probe, describe }`。
 *
 * @param {object} o
 * @param {string} [o.baseUrl]
 * @param {string} [o.apiKey]
 * @param {string} [o.model]
 * @param {string} [o.voice]
 * @param {string} [o.format]
 * @param {Function} [o.fetchImpl]
 * @param {Function} [o.log]
 * @param {number} [o.timeoutMs]
 */
export function createOpenaiTts({
  baseUrl = DEFAULT_BASE_URL,
  apiKey = '',
  model = DEFAULT_MODEL,
  voice = DEFAULT_VOICE,
  format = 'mp3',
  fetchImpl,
  log = () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch
  const url = speechUrl(baseUrl)

  async function speak(text, o = {}) {
    const t0 = Date.now()
    const src = String(text ?? '').trim()
    if (src === '') return { ok: false, ms: 0, error: '要合成的文字是空的' }
    if (!apiKey) return { ok: false, ms: 0, error: '没填 API Key' }

    const fmt = o.format || format
    const body = buildSpeechBody({
      text: src,
      model: o.model || model,
      voice: o.voice || o.speaker || voice,
      format: fmt,
      speed: o.speed,
    })

    let res
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      return {
        ok: false,
        ms: Date.now() - t0,
        timedOut,
        error: timedOut ? `请求超时（${timeoutMs}ms）` : `网络层失败：${String(err?.message || err)}`,
      }
    }

    const ms = Date.now() - t0
    const ctype = String(res.headers?.get?.('content-type') || '').toLowerCase()

    // 成功 = 二进制。有些网关会谎报 application/json 却回音频，
    // 所以判据是「不是 JSON 就当音频」，而不是「必须是 audio/*」。
    if (res.ok && !ctype.includes('application/json')) {
      let buf
      try {
        buf = Buffer.from(await res.arrayBuffer())
      } catch (err) {
        return { ok: false, ms, error: `读音频字节失败：${String(err?.message || err)}` }
      }
      if (buf.length === 0) {
        return { ok: false, ms, error: '服务端返回 200，但音频是空的' }
      }
      log(`[tts] openai 合成 ${src.length} 字 → ${buf.length}B / ${ms}ms（${url}）`)
      return {
        ok: true,
        audio: buf,
        mime: FORMAT_MIME[fmt] || 'audio/mpeg',
        ms,
        variant: 'openai',
        bytes: buf.length,
        url,
      }
    }

    // 失败：这里是 JSON，读出 message
    let detail = ''
    let code = null
    try {
      const raw = await res.text()
      try {
        const obj = JSON.parse(raw)
        detail = obj?.error?.message || obj?.message || raw.slice(0, 200)
        code = obj?.error?.code ?? obj?.code ?? null
      } catch {
        detail = raw.slice(0, 200)
      }
    } catch {
      /* 连错误体都读不到，就用状态码说事 */
    }

    const hint =
      res.status === 404
        ? `（404：端点不对。当前拼出来的是 ${url}，检查 baseUrl 是否漏了 /v1 或多了路径）`
        : res.status === 401
          ? '（401：API Key 无效或没带上）'
          : res.status === 400
            ? '（400：参数被拒，常见是 model / voice / response_format 这家的值不一样）'
            : ''

    return {
      ok: false,
      ms,
      code,
      error: `HTTP ${res.status}${hint}：${detail || '（无错误说明）'}`,
      url,
    }
  }

  /**
   * 探测：OpenAI 兼容通道只有一条路，所以「探」= 真合成一小段。
   * 返回形状与火山对齐，方便上层用同一套逻辑展示。
   */
  async function probe(probeText = '你好') {
    const r = await speak(probeText)
    return {
      ok: r.ok === true,
      variant: r.ok ? 'openai' : undefined,
      label: r.ok ? `OpenAI 兼容 · ${model} / ${voice}` : undefined,
      error: r.ok ? undefined : r.error,
      tried: [{ id: 'openai', label: `${url}`, ok: r.ok === true, code: r.code ?? null, ms: r.ms, error: r.ok ? '' : r.error }],
    }
  }

  function describe() {
    return {
      provider: 'openai',
      url,
      hasKey: Boolean(apiKey),
      model,
      voice,
      format,
      candidates: ['openai'],
      // 同 volcano.mjs：这个字段描述「取到字节后有没有播放层」，与本适配器无关。
      playable: true,
    }
  }

  return { speak, probe, describe }
}
