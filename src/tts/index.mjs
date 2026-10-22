/**
 * TTS 适配层 —— 统一入口。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 这一层做什么、不做什么（2026-10-22 定的边界，别越界）
 * ═══════════════════════════════════════════════════════════════════
 *
 *   ✅ 做：把一段文字变成**音频字节**（Buffer）+ 统一的错误说明
 *   ✅ 做：多家 provider 的差异吸收（火山的三件套 vs OpenAI 的 Bearer）
 *   ✅ 做：探测「这条 key 属于哪条产品线」（用户自己也不知道）
 *   ❌ 不做：播放。主进程没有音频输出能力，必须丢给渲染层
 *      （渲染层 `new Audio(blobUrl)`，还需要先补 CSP 的 `media-src`）
 *   ❌ 不做：分句 / 排队 / 打断。那是播报编排层的事
 *   ❌ 不做：IPC、设置页、开关按钮。**这一层现在还没有被任何地方调用**
 *      —— 别以为「文件在 = 功能通了」，接线是下一轮。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 给要加新 provider 的人
 * ═══════════════════════════════════════════════════════════════════
 * 新开 `src/tts/<名字>.mjs`，导出一个 `createXxxTts(配置)`，返回：
 *
 *     {
 *       speak(text, opts?) -> Promise<SpeakResult>
 *       probe(probeText?)  -> Promise<ProbeResult>
 *       describe()         -> object（给设置页/日志，**不许带密钥原文**）
 *     }
 *
 * 然后在下面的 `PROVIDERS` 里加一行。上层不用改。
 *
 * SpeakResult：
 *   { ok:true,  audio:Buffer, mime:string, ms:number, bytes:number, variant:string }
 *   { ok:false, ms:number, error:string, code?:number|null, timedOut?:boolean }
 *
 * ProbeResult：
 *   { ok:boolean, variant?:string, label?:string, error?:string,
 *     tried:Array<{id:string, label:string, ok:boolean, code:number|null, ms:number, error:string}> }
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataRoot } from '../memory.mjs'
import { createVolcanoTts, VARIANTS as VOLCANO_VARIANTS } from './volcano.mjs'
import { createOpenaiTts, DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_VOICE } from './openai.mjs'

export { parseVolcanoResponse, explainVolcanoError } from './parse.mjs'
export { VARIANTS as VOLCANO_VARIANTS } from './volcano.mjs'
export { speechUrl, buildSpeechBody } from './openai.mjs'

/**
 * 已支持的 provider。
 *
 * key 同时就是配置文件里 `provider` 字段的取值 —— 用户改这个值就能换服务商，
 * 不需要改代码。这正是「开源出去、别人自己改适配口径」的落点。
 */
export const PROVIDERS = {
  volcano: {
    id: 'volcano',
    label: '火山引擎（豆包语音）',
    // 设置页据此渲染输入框：**三件套**，不是一个 apiKey
    fields: ['appId', 'accessKey', 'apiKey', 'speaker'],
    note: 'App ID + Access Key 走双头通道；只有一条 key 就填 apiKey 那格。复刻音色要填 speaker。',
    create: (cfg, opts) =>
      createVolcanoTts({
        appId: cfg.appId ?? '',
        accessKey: cfg.accessKey ?? '',
        apiKey: cfg.apiKey ?? '',
        speaker: cfg.speaker ?? '',
        variant: cfg.variant ?? '',
        fetchImpl: opts.fetchImpl,
        log: opts.log,
      }),
  },
  openai: {
    id: 'openai',
    label: 'OpenAI 兼容（任何 /v1/audio/speech 网关）',
    fields: ['baseUrl', 'apiKey', 'model', 'voice', 'format'],
    note: '聚合网关、自建服务、别家的兼容模式都用这一条。填对 baseUrl + model + voice 即可。',
    create: (cfg, opts) =>
      createOpenaiTts({
        baseUrl: cfg.baseUrl || DEFAULT_BASE_URL,
        apiKey: cfg.apiKey ?? '',
        model: cfg.model || DEFAULT_MODEL,
        voice: cfg.voice || DEFAULT_VOICE,
        format: cfg.format || 'mp3',
        fetchImpl: opts.fetchImpl,
        log: opts.log,
      }),
  },
}

/**
 * 配置文件的缺省形状。
 *
 * `enabled` 默认 **false** —— 这条不是形式主义：开源出去以后，若默认开启又带着作者的 key，
 * 每个下载的人都白用作者的钱。默认关、key 留空，是这类项目唯一负责任的做法。
 */
export function defaultTtsConfig() {
  return {
    enabled: false,
    provider: 'volcano',
    volcano: { appId: '', accessKey: '', apiKey: '', speaker: '', variant: '' },
    openai: { baseUrl: DEFAULT_BASE_URL, apiKey: '', model: DEFAULT_MODEL, voice: DEFAULT_VOICE, format: 'mp3' },
  }
}

/** `<dataRoot>/providers/tts.json` —— 和模型密钥同目录（该目录已 gitignore）。 */
export function ttsConfigPath(root = dataRoot()) {
  return join(root, 'providers', 'tts.json')
}

/**
 * 读配置。坏文件/缺字段一律回落缺省值，**绝不抛**：
 * 一个写坏的 json 不该让整个应用起不来（这个项目在这类地方栽过）。
 *
 * @param {string} [root] dataRoot
 * @returns {object} 一定形状完整
 */
export function loadTtsConfig(root = dataRoot()) {
  const base = defaultTtsConfig()
  const file = ttsConfigPath(root)
  if (!existsSync(file)) return base
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return base
  }
  if (!raw || typeof raw !== 'object') return base
  return {
    enabled: raw.enabled === true,
    provider: typeof raw.provider === 'string' && PROVIDERS[raw.provider] ? raw.provider : base.provider,
    volcano: { ...base.volcano, ...(raw.volcano && typeof raw.volcano === 'object' ? raw.volcano : {}) },
    openai: { ...base.openai, ...(raw.openai && typeof raw.openai === 'object' ? raw.openai : {}) },
  }
}

/**
 * 按配置造出适配器。
 *
 * @param {object} cfg   `loadTtsConfig()` 的返回值
 * @param {object} [opts] `{ fetchImpl, log }`
 * @returns {{speak:Function, probe:Function, describe:Function}|null}
 *   配置不可用时返回 null（而不是抛），由调用方决定怎么说。
 */
export function createTts(cfg, opts = {}) {
  const conf = cfg && typeof cfg === 'object' ? cfg : defaultTtsConfig()
  const entry = PROVIDERS[conf.provider]
  if (!entry) return null
  const providerCfg = conf[conf.provider] ?? {}
  const instance = entry.create(providerCfg, { fetchImpl: opts.fetchImpl, log: opts.log ?? (() => {}) })
  // 用展开保留 provider 自己的额外方法（比如火山的 setVariant），只替换 describe。
  const describeBase = instance.describe.bind(instance)
  return {
    ...instance,
    describe: () => ({
      ...describeBase(),
      provider: entry.id,
      providerLabel: entry.label,
      enabled: conf.enabled === true,
    }),
  }
}

/**
 * 写配置。
 *
 * 三个约束，都是被这个项目的旧伤逼出来的：
 *   ① **保留以 `_` 开头的键**（`_note` / `_status`）。那些是给人看的备注，
 *      被一次「保存设置」抹掉的话，下次排障就没有线索了；
 *   ② **未知键也保留** —— 用户可能手写了一些字段，程序不认识不代表可以删；
 *   ③ **tmp + rename 原子写**。半截写入会让下次启动读到一个坏 JSON，
 *      而 `loadTtsConfig()` 对坏文件是「静默回缺省」——那等于用户配的东西凭空消失。
 *
 * 返回**实际落盘的内容**，调用方拿它刷新界面，避免「界面显示 A、盘上是 B」。
 *
 * @param {object} cfg 期望的完整配置（会按缺省形状归一化一次）
 * @param {string} [root]
 * @returns {object}
 */
export function saveTtsConfig(cfg, root = dataRoot()) {
  const file = ttsConfigPath(root)
  let previous = {}
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (raw && typeof raw === 'object') previous = raw
    } catch {
      previous = {}
    }
  }
  const base = defaultTtsConfig()
  const src = cfg && typeof cfg === 'object' ? cfg : {}
  const keepMeta = {}
  for (const [k, v] of Object.entries(previous)) {
    if (k.startsWith('_')) keepMeta[k] = v
  }
  const out = {
    ...previous,
    ...keepMeta,
    enabled: src.enabled === true,
    provider: PROVIDERS[src.provider] ? src.provider : base.provider,
    volcano: { ...base.volcano, ...(previous.volcano ?? {}), ...(src.volcano ?? {}) },
    openai: { ...base.openai, ...(previous.openai ?? {}), ...(src.openai ?? {}) },
  }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return out
}

/**
 * 一句话说清「现在能不能出声」——给日志和设置页用。
 *
 * ⚠️ 2026-10-22 改口：播放层已经接上了（主进程 `src/tts/speech.mjs` 切句排队 →
 *    渲染层 `new Audio(blobUrl)`）。所以这里不再写「播放层未接」，
 *    但也不能说「一定能听见」—— 开关关着、凭据空着、CSP 被改坏，都听不见。
 *    只如实描述**配置状态**，别替用户下结论。
 * @param {object} d `describe()` 的结果
 * @returns {string}
 */
export function describeTtsState(d) {
  if (!d) return 'TTS：没配置'
  if (!d.enabled) return 'TTS：已关闭（默认关）'
  const cred = d.provider === 'volcano' ? d.hasAppPair || d.hasApiKey : d.hasKey
  if (!cred) return `TTS：${d.providerLabel ?? d.provider} 的凭据是空的`
  return `TTS：${d.providerLabel ?? d.provider} 已配好`
}

/** 供设置页渲染用：每个 provider 需要哪些字段。 */
export function describeTtsConfig(cfg = defaultTtsConfig()) {
  const conf = cfg && typeof cfg === 'object' ? cfg : defaultTtsConfig()
  return {
    enabled: conf.enabled === true,
    provider: conf.provider,
    providers: Object.values(PROVIDERS).map((p) => ({
      id: p.id,
      label: p.label,
      fields: p.fields,
      note: p.note,
    })),
  }
}
