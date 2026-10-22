#!/usr/bin/env node
/**
 * 火山引擎 · 声音复刻 2.0 批量合成（零依赖，Node ≥ 22，用全局 fetch）
 *
 * 目标：读 video/tts/chunks.json 的全部旁白段（当前 10 段），逐段调 API 合成，
 *       落盘 video/voiceover/01.mp3 ~ 10.mp3，顺手存字幕时间戳与原始响应回包。
 *
 * 用法：
 *   node video/tts/tts-batch.mjs              # 合成全部
 *   node video/tts/tts-batch.mjs 01 04 10     # 只重跑指定段
 *   node video/tts/tts-batch.mjs --dry-run    # 只打印将要发送的请求，不花钱
 *   node video/tts/tts-batch.mjs --concat     # 合成完顺手拼 narration_full.mp3（需 ffmpeg）
 *
 * 凭据（绝不写进任何会进 git 的文件）：
 *   环境变量 VOLC_APP_ID + VOLC_ACCESS_KEY    （控制台「API Key 管理」，推荐）
 *   或环境变量 VOLC_API_KEY                   （走 X-Api-Key 头，备用通道）
 *   环境变量 VOLC_SPEAKER                     （复刻音色 ID，控制台→音色库）
 *   也可以写 video/tts/local-config.json：{"appId":"...","accessKey":"...","speaker":"..."}
 *   （该文件已在 .gitignore 里；有环境变量时环境变量优先）
 *
 * 复刻 2.0 的两个硬点（踩过的坑）：
 *   1) X-Api-Resource-Id 必须是 seed-icl-2.0（1.0 是 volc.seedicl.default）
 *   2) additions 里必须带 "model_type":4，否则**静默回落 1.0**，context_texts 情绪指令直接失效
 *   3) 情绪走 additions.context_texts（官方明说该字段不参与朗读），
 *      不要用 req_params.model 字段——官方文档明说指定 model 后不支持 context_texts
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CHUNKS_FILE = join(__dirname, 'chunks.json')
const LOCAL_CONFIG = join(__dirname, 'local-config.json')
const OUT_DIR = join(__dirname, '..', 'voiceover')

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
const RESOURCE_ID = 'seed-icl-2.0' // 声音复刻大模型 2.0
const UID = 'orb-video-tts'

function loadSecrets() {
  const local = existsSync(LOCAL_CONFIG)
    ? JSON.parse(readFileSync(LOCAL_CONFIG, 'utf8'))
    : {}
  const secrets = {
    appId: process.env.VOLC_APP_ID || local.appId || '',
    accessKey: process.env.VOLC_ACCESS_KEY || local.accessKey || '',
    apiKey: process.env.VOLC_API_KEY || local.apiKey || '',
    speaker: process.env.VOLC_SPEAKER || local.speaker || '',
  }
  const hasAuth = (secrets.appId && secrets.accessKey) || secrets.apiKey
  if (!hasAuth || !secrets.speaker) {
    console.error('缺凭据。请设置环境变量 VOLC_APP_ID + VOLC_ACCESS_KEY（或 VOLC_API_KEY）与 VOLC_SPEAKER；')
    console.error('或写 video/tts/local-config.json：{"appId":"...","accessKey":"...","speaker":"..."}')
    process.exit(1)
  }
  return secrets
}

function buildHeaders(secrets) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Resource-Id': RESOURCE_ID,
    'X-Api-Request-Id': randomUUID(),
  }
  if (secrets.apiKey) headers['X-Api-Key'] = secrets.apiKey
  if (secrets.appId) headers['X-Api-App-Id'] = secrets.appId
  if (secrets.accessKey) headers['X-Api-Access-Key'] = secrets.accessKey
  return headers
}

function buildBody(chunk, secrets) {
  return {
    user: { uid: UID },
    req_params: {
      text: chunk.text,
      speaker: secrets.speaker,
      audio_params: { format: 'mp3', sample_rate: 24000, bit_rate: 160000 },
      speech_rate: chunk.speech_rate ?? 0,
      enable_subtitle: true,
      additions: JSON.stringify({
        context_texts: [chunk.emotion], // 情绪指令：不参与朗读
        model_type: 4,                  // 复刻 2.0 开关，漏了就静默走 1.0
      }),
    },
  }
}

/** 回包是 NDJSON：{"code":0,"data":"<base64 音频块>"} … 结束 {"code":20000000,"data":null} */
function parseNdjson(raw) {
  const audioParts = []
  const otherLines = []
  let ended = false
  let failCode = null
  let failMsg = null

  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let obj
    try { obj = JSON.parse(s) } catch { otherLines.push(s); continue }

    if (obj.code === 0 && typeof obj.data === 'string' && obj.data.length > 0) {
      audioParts.push(Buffer.from(obj.data, 'base64'))
    } else if (obj.code === 20000000) {
      ended = true
    } else if (typeof obj.code === 'number' && obj.code !== 0) {
      failCode = obj.code
      failMsg = obj.message || obj.msg || JSON.stringify(obj)
    } else {
      // 字幕/时间戳等旁路回包，整行留档
      otherLines.push(s)
    }
  }
  return { audioParts, otherLines, ended, failCode, failMsg }
}

/** 兼容个别网关返回「单个 JSON、data 为整段 base64」的情况 */
function parseSingleJson(raw) {
  try {
    const obj = JSON.parse(raw)
    if (obj && typeof obj.data === 'string' && obj.data.length > 100) {
      return { audioParts: [Buffer.from(obj.data, 'base64')], otherLines: [], ended: true, failCode: obj.code === 0 ? null : obj.code, failMsg: obj.message || null }
    }
    if (obj && obj.code && obj.code !== 0) {
      return { audioParts: [], otherLines: [], ended: false, failCode: obj.code, failMsg: obj.message || raw.slice(0, 300) }
    }
  } catch { /* 不是 JSON，走 NDJSON */ }
  return null
}

async function synthOne(chunk, secrets, dryRun) {
  const body = buildBody(chunk, secrets)
  const headers = buildHeaders(secrets)

  if (dryRun) {
    console.log(`--- [${chunk.id}] ${chunk.scene} ---`)
    console.log('POST', ENDPOINT)
    console.log('headers:', JSON.stringify({ ...headers, 'X-Api-Access-Key': '***', 'X-Api-Key': '***' }, null, 2))
    console.log('body:', JSON.stringify(body, null, 2))
    return
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const raw = await res.text()

  // 非 200 或空回包：原样留证，别静默吞
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  writeFileSync(join(OUT_DIR, `${chunk.id}.raw.jsonl`), raw, 'utf8')

  if (!res.ok) {
    throw new Error(`[${chunk.id}] HTTP ${res.status} ${res.statusText}\n${raw.slice(0, 500)}`)
  }

  let parsed = parseNdjson(raw)
  if (parsed.audioParts.length === 0) {
    const single = parseSingleJson(raw)
    if (single) parsed = single
  }

  if (parsed.failCode) {
    throw new Error(`[${chunk.id}] 业务错误 code=${parsed.failCode}: ${parsed.failMsg}`)
  }
  if (parsed.audioParts.length === 0) {
    throw new Error(`[${chunk.id}] 回包里没有音频数据，完整回包已存 ${chunk.id}.raw.jsonl（时间 ${stamp}）`)
  }

  const audio = Buffer.concat(parsed.audioParts)
  writeFileSync(join(OUT_DIR, `${chunk.id}.mp3`), audio)
  if (parsed.otherLines.length > 0) {
    writeFileSync(join(OUT_DIR, `${chunk.id}.sidecar.jsonl`), parsed.otherLines.join('\n'), 'utf8')
  }
  console.log(`✅ [${chunk.id}] ${chunk.scene} → ${chunk.id}.mp3（${(audio.length / 1024).toFixed(0)} KB，字数 ${chunk.text.length}）`)
}

function concatAll(ids) {
  const ffmpeg = process.platform === 'win32' ? 'ffmpeg' : 'ffmpeg'
  const probe = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) {
    console.log('（没找到 ffmpeg，跳过拼接；剪映里手动拖也一样）')
    return
  }
  // 每段之间垫 0.4s 静音（第 10 段前垫 0.6s）
  const parts = []
  const filters = []
  let idx = 0
  ids.forEach((id, i) => {
    parts.push('-i', join(OUT_DIR, `${id}.mp3`))
    filters.push(`[${idx}:a]`)
    idx += 1
    if (i < ids.length - 1) {
      const gap = 0.4 // 段间统一 0.4s；第 10 段若手工拆两条，拆口用 0.6s（在剪映里调）
      filters.push(`aevalsrc=0:d=${gap}:s=44100[g${i}]`, `[g${i}]`)
      idx += 1
    }
  })
  const n = filters.filter((f) => /^\[\d+:a\]$/.test(f)).length + filters.filter((f) => /^\[g\d+\]$/.test(f)).length
  const fc = `${filters.join('')}concat=n=${n}:v=0:a=1[out]`
  const outFile = join(OUT_DIR, 'narration_full.mp3')
  const r = spawnSync(ffmpeg, ['-y', ...parts, '-filter_complex', fc, '-map', '[out]', outFile], { encoding: 'utf8' })
  if (r.status === 0) console.log(`🎧 已拼接 → ${outFile}`)
  else console.log(`拼接失败：${(r.stderr || '').slice(-400)}`)
}

async function main() {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const doConcat = argv.includes('--concat')
  const wanted = argv.filter((a) => /^\d{2}$/.test(a))

  const { chunks } = JSON.parse(readFileSync(CHUNKS_FILE, 'utf8'))
  const selected = wanted.length > 0 ? chunks.filter((c) => wanted.includes(c.id)) : chunks
  if (selected.length === 0) {
    console.error('没匹配到任何段。可选 id：', chunks.map((c) => c.id).join(' '))
    process.exit(1)
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const secrets = dryRun ? { appId: 'DRY', accessKey: 'DRY', speaker: 'DRY' } : loadSecrets()

  console.log(`共 ${selected.length} 段 → ${OUT_DIR}`)
  for (const chunk of selected) {
    try {
      await synthOne(chunk, secrets, dryRun)
    } catch (err) {
      console.error(String(err.message || err))
      console.error('已停止（避免半套配音）。修好后用段号重跑，例如：node video/tts/tts-batch.mjs 05')
      process.exit(1)
    }
    if (!dryRun) await new Promise((r) => setTimeout(r, 400)) // 温柔一点，别锤接口
  }

  if (!dryRun && doConcat) {
    const ids = selected.map((c) => c.id)
    const have = ids.filter((id) => existsSync(join(OUT_DIR, `${id}.mp3`)))
    if (have.length === ids.length) concatAll(have)
    else console.log('有段落缺 mp3，跳过拼接')
  }

  if (!dryRun) {
    const done = readdirSync(OUT_DIR).filter((f) => /^\d{2}\.mp3$/.test(f)).sort()
    console.log(`完成。voiceover/ 现有：${done.join(' ') || '（无）'}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
