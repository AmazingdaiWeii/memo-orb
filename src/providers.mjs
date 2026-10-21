/**
 * providers.mjs · API 密钥的归属与搬迁
 *
 * 背景（2026-10-19 剥离旧后端）：
 *   改造前密钥存在 `~/.legacy/lc-local-backend/providers/auth.json` —— 那是 **旧后端的数据根**。
 *   剥离之后本应用不能再依赖 `~/.legacy` 存在（用户可能整个删掉它），所以：
 *     - 新家：`<dataRoot>/providers/auth.json`（engine=local 时 dataRoot = 项目根 `data/`）；
 *     - 老家的文件**只读不删**：首次找到就复制过来，之后不再读它。
 *   这样「用户删掉 ~/.legacy」不会让应用失去密钥，也不会悄悄写到旧后端的目录里去。
 *
 * 为什么密钥算「配置」而不是「数据」：重装应用后应该能直接复用，不该跟记忆一起被弃用。
 * 但它的落点必须属于本应用自己的根，所以放 `data/providers/` 而不是 `~/.legacy`。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { dataRoot } from './memory.mjs'

/** 本应用自己的密钥文件路径（可能还不存在）。 */
export function ownAuthPath() {
  return join(dataRoot(), 'providers', 'auth.json')
}

/** 旧旧后端数据根里的密钥文件（迁移来源；只读，绝不改写）。 */
export function legacyAuthPath() {
  return join(homedir(), '.legacy', 'lc-local-backend', 'providers', 'auth.json')
}

/**
 * 确保 `<dataRoot>/providers/auth.json` 存在：不存在就从旧位置搬一份。
 *
 * 迁移是**复制**不是移动 —— 旧位置留着不动，用户原来的旧后端安装仍然可用。
 * 返回实际使用的路径；两条路都没有就返回 null（由调用方决定怎么报错）。
 *
 * @param {{log?: Function}} [o]
 * @returns {string|null}
 */
export function ensureAuthFile({ log = () => {} } = {}) {
  const own = ownAuthPath()
  if (existsSync(own)) return own

  const candidates = []
  if (process.env.ORB_AUTH) candidates.push([process.env.ORB_AUTH, 'ORB_AUTH'])
  candidates.push([legacyAuthPath(), '旧旧后端数据根'])

  for (const [src, whence] of candidates) {
    if (!src || !existsSync(src)) continue
    try {
      mkdirSync(dirname(own), { recursive: true })
      copyFileSync(src, own)
      log(`密钥已从${whence}复制到 ${own}（原文件保留）`)
      return own
    } catch (err) {
      log(`密钥复制失败（${whence} → ${own}）：${err.message}`)
    }
  }
  return null
}

/**
 * 读出当前生效的 provider 配置。
 *
 * 形状沿用旧后端的 auth.json：`{ providers: { <name>: { base_url, auth: { key } } } }`。
 * 选谁：优先 config.json 里 `model` 的前缀（`deepseek/xxx` ⇒ providers.deepseek），
 * 找不到再退 deepseek → openai-compatible（这两个是本机用过的）。
 *
 * @param {object} o
 * @param {string} o.modelName  config.json 的 model（可能带 `provider/` 前缀）
 * @param {Function} [o.log]
 * @returns {{baseUrl: string, apiKey: string, model: string, provider: string, source: string}}
 */
export function readProviderAuth({ modelName, log = () => {} }) {
  const file = ensureAuthFile({ log })
  if (!file) {
    throw new Error(
      '没找到 API 配置。放一份 auth.json 到 ' +
        ownAuthPath() +
        '（形如 {"providers":{"deepseek":{"base_url":"https://api.deepseek.com/v1","auth":{"key":"sk-..."}}}}），' +
        '或用环境变量 ORB_AUTH 指向已有文件。',
    )
  }

  let auth
  try {
    auth = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (err) {
    throw new Error(`${file} 不是合法 JSON：${err.message}`)
  }

  const providers = auth?.providers ?? {}
  const raw = String(modelName ?? '')
  const prefix = raw.includes('/') ? raw.split('/')[0] : ''
  const name = [prefix, 'deepseek', 'openai-compatible'].find((n) => n && providers[n]) || Object.keys(providers)[0]
  if (!name) throw new Error(`${file} 里没有任何 provider`)

  const p = providers[name]
  const baseUrl = String(p.base_url ?? '').replace(/\/+$/, '')
  const apiKey = p.auth?.key
  if (!baseUrl) throw new Error(`${file} 的 providers.${name} 缺 base_url`)
  if (!apiKey) throw new Error(`${file} 的 providers.${name}.auth.key 是空的（没填密钥）`)

  return {
    baseUrl,
    apiKey,
    // 直连上游要用官方模型名：`deepseek/deepseek-flash` → `deepseek-flash`
    model: raw.includes('/') ? raw.split('/').pop() : raw,
    provider: name,
    source: file,
  }
}

/**
 * 挑出应该被写的那一条 provider（与 readProviderAuth 同一套选择规则）。
 *
 * 抽出来是因为「设置」面板要**原地改**而不是新建一条：写错条目名会出现
 * 「面板显示 deepseek、运行时读的却是 openai-compatible」这种对不上的状态。
 */
function pickProviderName(auth, modelName) {
  const providers = auth?.providers ?? {}
  const raw = String(modelName ?? '')
  const prefix = raw.includes('/') ? raw.split('/')[0] : ''
  return [prefix, 'deepseek', 'openai-compatible'].find((n) => n && providers[n])
    || Object.keys(providers)[0]
    || prefix
    || 'deepseek'
}

/**
 * 读出「面板用」的当前值 —— **绝不抛异常**。
 *
 * 面板打开时必须能显示「还没配密钥」这种状态；用 readProviderAuth 会让
 * 整个抽屉变成一个错误框，用户连填密钥的地方都看不见。
 *
 * @param {{modelName: string, log?: Function}} o
 * @returns {{baseUrl: string, apiKey: string, provider: string, file: string|null, error: string|null}}
 */
export function describeProviderAuth({ modelName, log = () => {} }) {
  const file = ensureAuthFile({ log })
  if (!file) return { baseUrl: '', apiKey: '', provider: 'deepseek', file: null, error: '没找到 auth.json' }
  try {
    const auth = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const provider = pickProviderName(auth, modelName)
    const p = auth?.providers?.[provider] ?? {}
    return {
      baseUrl: String(p.base_url ?? ''),
      apiKey: String(p.auth?.key ?? ''),
      provider,
      file,
      error: null,
    }
  } catch (err) {
    return { baseUrl: '', apiKey: '', provider: 'deepseek', file, error: `${file} 不是合法 JSON：${err.message}` }
  }
}

/**
 * 把面板提交的值写回 `<dataRoot>/providers/auth.json`（原地改，不动别的 provider）。
 *
 * 写盘用 tmp + rename：写到一半崩掉时旧文件仍然完整 —— 密钥文件被截断
 * 等于应用再也不通，比配置写错严重得多。
 *
 * @param {{modelName: string, baseUrl?: string, apiKey?: string, log?: Function}} o
 * @returns {{file: string, provider: string}}
 */
export function writeProviderAuth({ modelName, baseUrl, apiKey, log = () => {} }) {
  const file = ensureAuthFile({ log }) || ownAuthPath()
  mkdirSync(dirname(file), { recursive: true })

  let auth = { providers: {} }
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) auth = parsed
    } catch {
      // 旧文件坏了：不能因为「读不懂」就拒绝用户在新面板里重建密钥，
      // 但也不覆盖它 —— 先备份成 .broken-<ts>，用户还能自己捞回来。
      const backup = `${file}.broken-${Date.now()}`
      try {
        copyFileSync(file, backup)
        log(`auth.json 无法解析，已备份到 ${backup}`)
      } catch (err) {
        log(`auth.json 备份失败：${err.message}`)
      }
    }
  }
  if (!auth.providers || typeof auth.providers !== 'object') auth.providers = {}

  const provider = pickProviderName(auth, modelName)
  const entry = auth.providers[provider] && typeof auth.providers[provider] === 'object'
    ? auth.providers[provider]
    : {}
  if (typeof baseUrl === 'string' && baseUrl !== '') entry.base_url = baseUrl.replace(/\/+$/, '')
  if (typeof apiKey === 'string' && apiKey !== '') {
    entry.auth = { ...(entry.auth && typeof entry.auth === 'object' ? entry.auth : {}), key: apiKey }
  }
  auth.providers[provider] = entry

  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(auth, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  log(`已写入 API 配置（${provider}）→ ${file}`)
  return { file, provider }
}
