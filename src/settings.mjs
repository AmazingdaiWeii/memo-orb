/**
 * settings.mjs · 运行期旋钮（每轮读一次，改完即生效，不重启）
 *
 * 为什么单独一个模块：压缩阈值这类参数**必须要能在使用过程中调**。
 * 用户的原话是「先不定死，做成滑动模块，初始 24K，上限 DeepSeek 的 1M」——
 * 也就是他要靠真实长会话去试出拐点，而不是信一个拍脑袋的常数。
 *
 * 数据源只有一个：项目根的 `config.json`（与现有配置同文件，不另开一份）。
 * 读法带 mtime 缓存：同一轮里多个调用点不会重复读盘，但文件一改下一轮就生效。
 *
 * ★ 硬性要求：非法值必须**纠正并记录**，不许静默采用（这个项目吃过静默丢弃的亏）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'

/** 缺省值。改这里等于改出厂值。 */
export const SETTINGS_DEFAULTS = Object.freeze({
  /** 触发压缩的上下文预算（token）。24 000 = 用户 2026-10-19 拍板的初始值。 */
  contextBudgetTokens: 24000,
  /** 模型上下文天花板（token）。1 000 000 = DeepSeek V3.2 / flash 的标称上限。 */
  modelContextTokens: 1000000,
  /** auto = 超预算自动压；off = 永不压（会撞墙）；manual = 只在手动命令时压。 */
  compactMode: 'auto',
  /** 压缩时保留的最近消息条数（不动，原样进 prompt）。 */
  keepRecentMessages: 12,
  /** MEMORY.md 软上限（字节）。超了 write_memory 直接拒绝，逼她先精简。 */
  memorySoftLimitBytes: 4096,
  /** 单轮尾部漂移块上限（字节）。超了触发压缩而不是截断。 */
  memoryUpdateMaxBytes: 3072,
  /** 模型上下文长度报错时，预算自动减半重试一次。 */
  contextOverflowAutoHalf: true,
  /**
   * 推理（思考）档位。2026-10-20 用户明确要求「把推理模式打开」，缺省取最高档。
   * 合法值来自 DeepSeek OpenAI 兼容端点 422 报文的枚举；`off` 是本地别名
   * （真发出去会 422，llm.mjs 会把它翻成 `thinking:{type:'disabled'}`）。
   */
  reasoningEffort: 'max',
  /** 单次输出 token 上限。**思考 token 也计入 completion**，给小了会被思考吃掉。 */
  maxTokens: 32000,
})

const MODES = new Set(['auto', 'off', 'manual'])
const EFFORTS = new Set(['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'])

/**
 * 合法思考档位的**有序**列表，供设置抽屉校验与提示文案复用。
 * 与上面 `EFFORTS` 同源（这里只是去重排序后的数组版本），不要在别处另写一份。
 */
export const EFFORT_VALUES = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'])

/**
 * 思考档位校验。非法值不静默采用 —— 记一行并用缺省 max（项目吃过静默丢弃的亏）。
 * @param {unknown} value config.json 里的原值
 * @param {(msg:string)=>void} log
 */
function normalizeEffort(value, log) {
  if (value === undefined || value === null) return SETTINGS_DEFAULTS.reasoningEffort
  const v = String(value).toLowerCase()
  if (EFFORTS.has(v)) return v
  log(`settings: reasoningEffort=${JSON.stringify(value)} 非法（可用 ${[...EFFORTS].join('|')}），用 ${SETTINGS_DEFAULTS.reasoningEffort}`)
  return SETTINGS_DEFAULTS.reasoningEffort
}

function clampInt(value, min, max, fallback, name, log) {
  const n = Number(value)
  if (!Number.isFinite(n)) {
    if (value !== undefined) log(`settings: ${name}=${JSON.stringify(value)} 不是数字，用缺省 ${fallback}`)
    return fallback
  }
  const i = Math.round(n)
  if (i < min || i > max) {
    log(`settings: ${name}=${i} 越界（${min}~${max}），已夹取`)
    return Math.min(max, Math.max(min, i))
  }
  return i
}

/**
 * @param {object} o
 * @param {string} o.configPath  config.json 的绝对路径
 * @param {(msg:string)=>void} [o.log]
 */
export function createSettings({ configPath, log = () => {} }) {
  let cached = null
  let cachedMtime = -1

  function readRaw() {
    if (!existsSync(configPath)) return {}
    try {
      const st = statSync(configPath)
      if (cached && st.mtimeMs === cachedMtime) return cached
      const raw = JSON.parse(readFileSync(configPath, 'utf8'))
      cached = raw && typeof raw === 'object' ? raw : {}
      cachedMtime = st.mtimeMs
      return cached
    } catch (err) {
      // 读失败不清掉上一次成功的结果 —— 配置文件半截写入时不该让运行中的旋钮跳变
      log(`settings: 读 ${configPath} 失败：${err.message}（沿用上一版）`)
      return cached ?? {}
    }
  }

  function get() {
    const raw = readRaw()
    const modelContextTokens = clampInt(
      raw.modelContextTokens, 8000, 4000000, SETTINGS_DEFAULTS.modelContextTokens, 'modelContextTokens', log,
    )
    const budgetDefault = Math.min(SETTINGS_DEFAULTS.contextBudgetTokens, modelContextTokens)
    const contextBudgetTokens = clampInt(
      raw.contextBudgetTokens, 4000, modelContextTokens, budgetDefault, 'contextBudgetTokens', log,
    )
    let compactMode = raw.compactMode
    if (!MODES.has(compactMode)) {
      if (compactMode !== undefined) log(`settings: compactMode=${JSON.stringify(compactMode)} 非法，用 auto`)
      compactMode = SETTINGS_DEFAULTS.compactMode
    }
    return {
      contextBudgetTokens,
      modelContextTokens,
      compactMode,
      keepRecentMessages: clampInt(
        raw.keepRecentMessages, 2, 200, SETTINGS_DEFAULTS.keepRecentMessages, 'keepRecentMessages', log,
      ),
      memorySoftLimitBytes: clampInt(
        raw.memorySoftLimitBytes, 512, 65536, SETTINGS_DEFAULTS.memorySoftLimitBytes, 'memorySoftLimitBytes', log,
      ),
      memoryUpdateMaxBytes: clampInt(
        raw.memoryUpdateMaxBytes, 256, 65536, SETTINGS_DEFAULTS.memoryUpdateMaxBytes, 'memoryUpdateMaxBytes', log,
      ),
      contextOverflowAutoHalf: raw.contextOverflowAutoHalf !== false,
      reasoningEffort: normalizeEffort(raw.reasoningEffort, log),
      maxTokens: clampInt(raw.maxTokens, 256, 200000, SETTINGS_DEFAULTS.maxTokens, 'maxTokens', log),
    }
  }

  return { get, configPath }
}

/** 全角标点、假名、汉字、CJK 兼容区、全角形式；这些字符按 1 字≈1 token 计。 */
function isCjkCodePoint(cp) {
  return (
    (cp >= 0x3000 && cp <= 0x303f) // 全角标点
    || (cp >= 0x3040 && cp <= 0x30ff) // 假名
    || (cp >= 0x3400 && cp <= 0x4dbf) // 扩展 A
    || (cp >= 0x4e00 && cp <= 0x9fff) // 基本汉字
    || (cp >= 0xf900 && cp <= 0xfaff) // 兼容汉字
    || (cp >= 0xff00 && cp <= 0xffef) // 全角形式
  )
}

/**
 * 粗略 token 估算：CJK 一个字符 ≈1 token，其余 ≈3.5 字符/token。
 *
 * 为什么不用「总长度 / 1.8」：实测千问/DeepSeek 的中文会话里，system 4865 字对应
 * 真实 prompt=4415 token，比值 ≈1.10 字/token；用 1.8 会把中文低估约 1.6 倍，
 * 于是「contextBudgetTokens: 24000」实际要到 ≈39000 真实 token 才触发压缩 ——
 * 旋钮标注的单位和真实 token 对不上，收敛实验就白做了。
 *
 * 它只用来决定「该不该压」，不用于计费，所以不追求精确；宁可略高估（早压一点），
 * 也不要低估（撞上下文墙）。
 */
export function estimateTokens(text) {
  const s = String(text ?? '')
  if (!s) return 0
  let cjk = 0
  let other = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (isCjkCodePoint(cp)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / 3.5)
}
