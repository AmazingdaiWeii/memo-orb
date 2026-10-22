#!/usr/bin/env node
/**
 * 豆包语音合成 · 凭据与链路体检（零依赖，Node ≥ 22，用全局 fetch）
 *
 * 目的：在花时间合成之前，先用 3 组最小的真实请求判定「这把 key 到底能不能用、属于哪套鉴权」。
 *       全部失败也不花钱（鉴权失败在计费之前就被拒）。
 *
 * 用法：
 *   node video/tts/tts-verify.mjs                    # 用 local-config.json / 环境变量
 *   node video/tts/tts-verify.mjs --key xxx --speaker yyy
 *   node video/tts/tts-verify.mjs --save out.mp3     # 成功时把音频落盘
 *
 * 判定逻辑：
 *   A) v3 /tts/create      + X-Api-Key                      —— 新版控制台「语音合成 2.0」鉴权
 *   B) v3 /tts/unidirectional + X-Api-Key + Resource-Id     —— 新版控制台流式（项目 tts-batch 走这条）
 *   C) v3 /tts/unidirectional + X-Api-App-Id/X-Api-Access-Key —— 旧版控制台双头鉴权（有 appId+accessKey 时才跑）
 *
 * 退出码：0 = 至少一条通路鉴权通过；1 = 全部被拒（key 无效或类型不对）
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOCAL_CONFIG = join(__dirname, 'local-config.json')
const BASE = 'https://openspeech.bytedance.com'
const TIMEOUT_MS = 45_000

// 语音合成 2.0 / 声音复刻 2.0 的 Resource-Id
const RES_T2 = 'volc.service_type.10029'
const RES_ICL2 = 'seed-icl-2.0'
const UID = 'orb-video-tts'

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name)
  return i > -1 ? (process.argv[i + 1] || '') : fallback
}

function loadSecrets() {
  const local = existsSync(LOCAL_CONFIG) ? JSON.parse(readFileSync(LOCAL_CONFIG, 'utf8')) : {}
  return {
    apiKey: arg('key') || process.env.VOLC_API_KEY || local.apiKey || '',
    appId: process.env.VOLC_APP_ID || local.appId || '',
    accessKey: process.env.VOLC_ACCESS_KEY || local.accessKey || '',
    speaker: arg('speaker') || process.env.VOLC_SPEAKER || local.speaker || 'zh_female_shuangkuaisisi_moon_bigtts',
  }
}

async function call(name, path, headers, body) {
  const t0 = Date.now()
  let res, text = ''
  try {
    res = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Request-Id': randomUUID(), ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    text = await res.text()
  } catch (e) {
    return { name, http: 0, code: null, msg: '网络层失败: ' + (e?.message || e), ms: Date.now() - t0, audio: null }
  }

  // 先按整段 JSON 解析；失败再按 NDJSON 逐行取
  let audio = null, code = null, msg = ''
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean)
  const chunks = []
  for (const line of lines) {
    let o
    try { o = JSON.parse(line) } catch { continue }
    const c = o?.header?.code ?? o?.code
    if (c === 0 && typeof o.data === 'string' && o.data) chunks.push(o.data)
    else if (typeof c === 'number' && c !== 0 && c !== 20000000) { code = c; msg = o?.header?.message || o.message || '' }
  }
  if (chunks.length) audio = Buffer.concat(chunks.map(b => Buffer.from(b, 'base64')))

  if (code === null && res.status !== 200) {
    // 兜底：整体 JSON 里取 code/message
    try { const o = JSON.parse(text); code = o.code ?? null; msg = o.message || o.error || '' } catch { msg = text.slice(0, 160) }
  }
  return { name, http: res.status, code, msg, ms: Date.now() - t0, audio, raw: text.slice(0, 200) }
}

const LONG = '你好，这是一次豆包语音合成的连通性测试。'
const secrets = loadSecrets()

const probes = []

probes.push(['A v3/create + X-Api-Key', '/api/v3/tts/create',
  { 'X-Api-Key': secrets.apiKey },
  { model: 'seed-audio-1.0', text_prompt: LONG, audio_config: { format: 'mp3', sample_rate: 24000 } }])

probes.push(['B v3/uni + X-Api-Key(2.0)', '/api/v3/tts/unidirectional',
  { 'X-Api-Key': secrets.apiKey, 'X-Api-Resource-Id': RES_T2 },
  { user: { uid: UID }, req_params: { text: LONG, speaker: secrets.speaker, audio_params: { format: 'mp3', sample_rate: 24000 } } }])

if (secrets.appId && secrets.accessKey) {
  // 头部名字有历史分歧：现行豆包文档写 X-Api-App-Key，早期 v3 文档写 X-Api-App-Id。两个都试。
  for (const hk of ['X-Api-App-Key', 'X-Api-App-Id']) {
    probes.push(['C v3/uni + 旧版双头(' + hk + ')', '/api/v3/tts/unidirectional',
      { [hk]: secrets.appId, 'X-Api-Access-Key': secrets.accessKey, 'X-Api-Resource-Id': RES_T2 },
      { user: { uid: UID }, req_params: { text: LONG, speaker: secrets.speaker, audio_params: { format: 'mp3', sample_rate: 24000 } } }])
  }
}

if (!secrets.apiKey && !(secrets.appId && secrets.accessKey)) {
  console.error('没有任何凭据：local-config.json 或 VOLC_API_KEY / VOLC_APP_ID+VOLC_ACCESS_KEY 都要么为空。')
  process.exit(1)
}

console.log('凭据来源：' + (arg('key') ? '--key 参数' : (process.env.VOLC_API_KEY ? '环境变量 VOLC_API_KEY' : 'video/tts/local-config.json')))
console.log('apiKey  = ' + (secrets.apiKey ? secrets.apiKey.slice(0, 12) + '…' + ' (' + secrets.apiKey.length + ' 字符)' : '<空>'))
console.log('speaker = ' + secrets.speaker)
console.log('')

let ok = 0
for (const [name, path, headers, body] of probes) {
  const r = await call(name, path, headers, body)
  const pass = r.http === 200 && r.code === null
  if (pass) ok++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`)
  console.log(`       HTTP=${r.http} code=${r.code ?? '-'} ${r.msg || ''} ${r.ms}ms`)
  if (pass) {
    console.log(`       音频 ${r.audio ? r.audio.length : 0} 字节`)
    const save = arg('save')
    if (save && r.audio) { writeFileSync(save, r.audio); console.log(`       已保存 → ${save}`) }
  } else if (r.code === 45000010) {
    console.log('       → 45000010 是「X-Api-Key 本身不合法」，不是头写错、不是网络问题。换 key。')
  } else if (r.code) {
    console.log('       → 鉴权已过、参数或音色问题：' + (r.raw || ''))
  }
  console.log('')
}

if (ok === 0) {
  console.log('结论：全部通路被拒。请看 接入说明_豆包语音合成.md 第 5 节「去拿真 key」。')
  process.exit(1)
}
console.log(`结论：${ok} 条通路可用，可以跑 node video/tts/tts-batch.mjs。`)
