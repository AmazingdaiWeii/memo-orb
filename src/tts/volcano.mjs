/**
 * 火山引擎（豆包语音）TTS 适配器 —— 取音频的那一半。
 *
 * ⚠️ 本文件**只负责「文字 → 音频字节」**，不播放、不落盘、不碰 UI。
 *    播放层（渲染进程 new Audio）是下一轮的事，见 `src/tts/index.mjs` 头注释。
 *
 * ─────────────────────────────────────────────────────────────────
 * 为什么要有「变体矩阵」这一层
 * ─────────────────────────────────────────────────────────────────
 * 用户手里有一条火山 key，但**不知道它属于哪条产品线**（她原话）。
 * 而火山这几条线的差异不是「改个 model 名」，是三处都会变：
 *
 *   ① 资源 ID（`X-Api-Resource-Id`）
 *        大模型语音合成  → `volc.service_type.10029`
 *        声音复刻 2.0    → `seed-icl-2.0`
 *        声音复刻 1.0    → `volc.megatts.default`
 *   ② 鉴权头 —— **同一个厂商，文档前后改名过**
 *        现行豆包文档：`X-Api-App-Key` + `X-Api-Access-Key`
 *        早期 v3 文档：`X-Api-App-Id`  + `X-Api-Access-Key`
 *        单 key 通道：`X-Api-Key`
 *        ⇒ 光这一条就能让「代码明明一样」的两份实现一个通一个不通。
 *   ③ 请求体形状
 *        `req_params` 型（unidirectional）
 *        `text_prompt` 型（create / seed-audio）
 *
 * 所以这里不做「猜一个最可能」，而是**把有意义的组合列出来逐个试**，
 * 试通的那个记住（`probe()` 返回变体 id，调用方持久化，之后 `speak()` 直接用）。
 *
 * ─────────────────────────────────────────────────────────────────
 * 给要适配「别的家」的人
 * ─────────────────────────────────────────────────────────────────
 * 不要改这个文件。新开一个同级文件实现 `{ speak, probe, describe }` 三个方法，
 * 在 `index.mjs` 的 `PROVIDERS` 里注册即可。`speak` 的返回契约见 `index.mjs`。
 */

import { randomUUID } from 'node:crypto'
import { parseVolcanoResponse, explainVolcanoError } from './parse.mjs'

export const VOLCANO_BASE = 'https://openspeech.bytedance.com'

/** 缺省音色：豆包通用女声（控制台「音色库」可换）。复刻音色要填自己的 speaker id。 */
export const DEFAULT_SPEAKER = 'zh_female_shuangkuaisisi_moon_bigtts'

/** 请求头的 uid，火山用它做调用方标识；写死一个稳定值即可，不影响计费。 */
const UID = 'orb-tts'

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 变体矩阵。**顺序即优先级**：越可能成功的排越前。
 *
 * `auth`：
 *   `app` = 需要 appId + accessKey
 *   `key` = 只需要 apiKey
 * `headerStyle`：
 *   `appKey` → `X-Api-App-Key`（现行文档）
 *   `appId`  → `X-Api-App-Id`（早期 v3 文档）
 *   `apiKey` → `X-Api-Key`
 * `bodyKind`：
 *   `reqParams`  → `{ user, req_params: { text, speaker, … } }`
 *   `textPrompt` → `{ model, text_prompt, audio_config }`
 */
export const VARIANTS = [
  {
    id: 'llm-appkey',
    label: '大模型语音合成 · X-Api-App-Key',
    auth: 'app',
    headerStyle: 'appKey',
    resourceId: 'volc.service_type.10029',
    bodyKind: 'reqParams',
  },
  {
    id: 'llm-appid',
    label: '大模型语音合成 · X-Api-App-Id（早期文档）',
    auth: 'app',
    headerStyle: 'appId',
    resourceId: 'volc.service_type.10029',
    bodyKind: 'reqParams',
  },
  {
    id: 'llm-apikey',
    label: '大模型语音合成 · X-Api-Key',
    auth: 'key',
    headerStyle: 'apiKey',
    resourceId: 'volc.service_type.10029',
    bodyKind: 'reqParams',
  },
  {
    id: 'icl2-appkey',
    label: '声音复刻 2.0 · X-Api-App-Key',
    auth: 'app',
    headerStyle: 'appKey',
    resourceId: 'seed-icl-2.0',
    bodyKind: 'reqParams',
    needsSpeaker: true,
    // ★ 复刻 2.0 的硬点：additions 里不带 model_type:4 会**静默回落 1.0**，
    //   context_texts（情绪指令）随之失效，而且不报错 —— 只有听感变差。
    additions: { model_type: 4 },
  },
  {
    id: 'icl2-appid',
    label: '声音复刻 2.0 · X-Api-App-Id（早期文档）',
    auth: 'app',
    headerStyle: 'appId',
    resourceId: 'seed-icl-2.0',
    bodyKind: 'reqParams',
    needsSpeaker: true,
    additions: { model_type: 4 },
  },
  {
    id: 'icl2-apikey',
    label: '声音复刻 2.0 · X-Api-Key',
    auth: 'key',
    headerStyle: 'apiKey',
    resourceId: 'seed-icl-2.0',
    bodyKind: 'reqParams',
    needsSpeaker: true,
    additions: { model_type: 4 },
  },
  {
    id: 'icl1-appkey',
    label: '声音复刻 1.0 · X-Api-App-Key',
    auth: 'app',
    headerStyle: 'appKey',
    resourceId: 'volc.megatts.default',
    bodyKind: 'reqParams',
    needsSpeaker: true,
  },
  {
    id: 'seed-audio-apikey',
    label: 'seed-audio（create 型） · X-Api-Key',
    auth: 'key',
    headerStyle: 'apiKey',
    resourceId: null,
    bodyKind: 'textPrompt',
    path: '/api/v3/tts/create',
  },
]

const PATH_UNIDIRECTIONAL = '/api/v3/tts/unidirectional'

/** 这个变体的凭据够不够。不够就别浪费一次请求。 */
export function hasCreds(variant, creds = {}) {
  if (!variant) return false
  if (variant.auth === 'key') return Boolean(creds.apiKey)
  return Boolean(creds.appId && creds.accessKey)
}

/**
 * 这个凭据配置下，**值得一试**的变体（按优先级）。
 *
 * 注意不返回「凭据不够」的变体 —— 那不是接口不兼容，是根本没填，试了只会拿到 401，
 * 让探测结果变得难读。
 */
export function candidatesFor(creds = {}) {
  return VARIANTS.filter((v) => hasCreds(v, creds))
}

/**
 * 构造一次请求。纯函数，便于把「发出去的到底是什么」单测住。
 *
 * @param {object} variant VARIANTS 里的一项
 * @param {object} o
 * @param {object} o.creds   `{ appId, accessKey, apiKey }`
 * @param {string} o.text
 * @param {string} [o.speaker]
 * @param {number} [o.speechRate] -50~100，0 = 原速
 * @param {string} [o.emotion]    情绪指令（走 context_texts，不参与朗读）
 * @param {string} [o.format]     默认 mp3
 * @param {number} [o.sampleRate] 默认 24000
 * @returns {{url: string, headers: Record<string,string>, body: object}}
 */
export function buildRequest(variant, o = {}) {
  const creds = o.creds ?? {}
  const format = o.format || 'mp3'
  const sampleRate = Number(o.sampleRate) || 24_000

  const headers = {
    'Content-Type': 'application/json',
    // 缺了它火山会 400；每次都新生成，重试不会撞上「重复请求」
    'X-Api-Request-Id': randomUUID(),
  }
  if (variant.resourceId) headers['X-Api-Resource-Id'] = variant.resourceId
  if (variant.headerStyle === 'appKey') headers['X-Api-App-Key'] = creds.appId ?? ''
  if (variant.headerStyle === 'appId') headers['X-Api-App-Id'] = creds.appId ?? ''
  if (variant.headerStyle === 'apiKey') headers['X-Api-Key'] = creds.apiKey ?? ''
  // 双头通道还要 accessKey；单 key 通道不要
  if (variant.auth === 'app') headers['X-Api-Access-Key'] = creds.accessKey ?? ''

  let body
  if (variant.bodyKind === 'textPrompt') {
    body = {
      model: 'seed-audio-1.0',
      text_prompt: o.text,
      audio_config: { format, sample_rate: sampleRate },
    }
  } else {
    const reqParams = {
      text: o.text,
      speaker: o.speaker || DEFAULT_SPEAKER,
      audio_params: { format, sample_rate: sampleRate },
      speech_rate: Number.isFinite(Number(o.speechRate)) ? Number(o.speechRate) : 0,
    }
    if (variant.additions) {
      const additions = { ...variant.additions }
      // 情绪指令：官方明说该字段**不参与朗读**，只影响语气
      if (o.emotion) additions.context_texts = [o.emotion]
      reqParams.additions = JSON.stringify(additions)
    }
    body = { user: { uid: UID }, req_params: reqParams }
  }

  return {
    url: VOLCANO_BASE + (variant.path || PATH_UNIDIRECTIONAL),
    headers,
    body,
  }
}

/**
 * 创建一个火山 TTS 适配器。
 *
 * @param {object} o
 * @param {string} [o.appId]
 * @param {string} [o.accessKey]
 * @param {string} [o.apiKey]
 * @param {string} [o.speaker]
 * @param {string} [o.variant]  已探测到的变体 id（持久化后回填，省掉探测）
 * @param {Function} [o.fetchImpl] 探针注入假 fetch
 * @param {Function} [o.log]
 * @param {number} [o.timeoutMs]
 */
export function createVolcanoTts({
  appId = '',
  accessKey = '',
  apiKey = '',
  speaker = '',
  variant = '',
  fetchImpl,
  log = () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const creds = { appId, accessKey, apiKey }
  const doFetch = fetchImpl ?? globalThis.fetch
  // 探测结果记在闭包里：同一个进程里探一次就够，不必每句话都探
  let active = variant || ''

  /** 取一个变体对象；给的是未知 id 就返回 null（不静默退回默认值）。 */
  const variantById = (id) => VARIANTS.find((v) => v.id === id) ?? null

  /**
   * 合成一段文字。
   *
   * @param {string} text
   * @param {object} [o]
   * @param {string} [o.variant]  临时指定变体（探测时用）
   * @param {string} [o.speaker]
   * @param {string} [o.emotion]
   * @param {number} [o.speechRate]
   * @returns {Promise<{ok:boolean, audio?:Buffer, mime?:string, ms:number, variant?:string,
   *                    blocks?:number, error?:string, code?:number|null, timedOut?:boolean}>}
   */
  async function speak(text, o = {}) {
    const t0 = Date.now()
    const src = String(text ?? '').trim()
    if (src === '') return { ok: false, ms: 0, error: '要合成的文字是空的' }

    const wantId = o.variant || active
    let v = wantId ? variantById(wantId) : null
    if (wantId && !v) {
      return { ok: false, ms: 0, error: `未知的变体 id：${wantId}` }
    }
    if (!v) {
      // 没探过也没指定：用第一个凭据够的变体
      v = candidatesFor(creds)[0] ?? null
      if (!v) return { ok: false, ms: 0, error: '没有可用的火山凭据（需要 appId+accessKey 或 apiKey）' }
    }
    if (!hasCreds(v, creds)) {
      return { ok: false, ms: 0, error: `变体 ${v.id} 需要的凭据没填全（${v.auth === 'key' ? 'apiKey' : 'appId + accessKey'}）` }
    }
    if (v.needsSpeaker && !(o.speaker || speaker)) {
      return { ok: false, ms: 0, error: `变体 ${v.id} 需要 speaker（复刻音色 id），现在没填` }
    }

    const req = buildRequest(v, {
      creds,
      text: src,
      speaker: o.speaker || speaker,
      emotion: o.emotion,
      speechRate: o.speechRate,
    })

    let res
    let raw = ''
    try {
      res = await doFetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      raw = await res.text()
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      return {
        ok: false,
        ms: Date.now() - t0,
        variant: v.id,
        timedOut,
        error: timedOut ? `请求超时（${timeoutMs}ms）` : `网络层失败：${String(err?.message || err)}`,
      }
    }

    const parsed = parseVolcanoResponse(raw)
    const ms = Date.now() - t0

    if (parsed.audio && parsed.audio.length > 0) {
      log(`[tts] ${v.id} 合成 ${src.length} 字 → ${parsed.audio.length}B / ${parsed.blocks} 块 / ${ms}ms`)
      return {
        ok: true,
        audio: parsed.audio,
        mime: 'audio/mpeg', // 火山目前只出 mp3（audio_params.format='mp3'）
        ms,
        variant: v.id,
        blocks: parsed.blocks,
        bytes: parsed.audio.length,
      }
    }

    // 没音频：优先用业务码解释，其次看 HTTP 状态
    const code = parsed.failCode
    const explain = explainVolcanoError(code, parsed.failMsg)
    const httpNote = res && res.status !== 200 && code === null ? `（HTTP ${res.status}）` : ''
    return {
      ok: false,
      ms,
      variant: v.id,
      code,
      error: explain + httpNote,
      raw: raw.slice(0, 300),
    }
  }

  /**
   * 探测：依次试所有「凭据够」的变体，第一个出的来音频的就是答案。
   *
   * ⚠️ 每次探测都会**真实计费**（合成一小段）。所以：
   *   · 文本用最短的「你好」，成本可以忽略但不为零；
   *   · 探到就 break，不会把矩阵跑完；
   *   · 结果（variant id）应当由调用方持久化，别每次启动都探。
   *
   * @param {string} [probeText]
   * @returns {Promise<{ok:boolean, variant?:string, label?:string, tried:Array<object>, error?:string}>}
   */
  async function probe(probeText = '你好') {
    const list = candidatesFor(creds)
    if (list.length === 0) {
      return {
        ok: false,
        tried: [],
        error: '没有任何可用的凭据：既没有 appId + accessKey，也没有 apiKey。去设置里填，或写 data/providers/tts.json。',
      }
    }
    const tried = []
    for (const v of list) {
      const r = await speak(probeText, { variant: v.id })
      tried.push({
        id: v.id,
        label: v.label,
        ok: r.ok === true,
        code: r.code ?? null,
        ms: r.ms,
        error: r.ok ? '' : r.error,
      })
      if (r.ok) {
        active = v.id
        log(`[tts] 探测成功：${v.id}（${v.label}）`)
        return { ok: true, variant: v.id, label: v.label, tried }
      }
    }
    return { ok: false, tried, error: '所有变体都没出音频，见 tried 里的逐条原因' }
  }

  /**
   * 给设置页/日志用的自述。**不要**在这里暴露 key 内容。
   */
  function describe() {
    return {
      provider: 'volcano',
      hasAppPair: Boolean(appId && accessKey),
      hasApiKey: Boolean(apiKey),
      speaker: speaker || '',
      activeVariant: active || '',
      candidates: candidatesFor(creds).map((v) => v.id),
      // 播放层的存在与这一层无关（它只产字节）。这个字段留给上层判断
      // 「取到字节之后有没有人能放」—— 2026-10-22 起是真的，见 src/tts/speech.mjs。
      playable: true,
    }
  }

  return { speak, probe, describe, setVariant: (id) => { active = String(id || '') } }
}
