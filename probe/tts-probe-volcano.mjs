#!/usr/bin/env node
/**
 * 火山 TTS 凭据探测 —— 回答「我这条 key 到底属于哪条产品线」。
 *
 * 为什么需要它：火山的几条线差异不在 model 名，而在**三处同时变**
 * （资源 ID / 鉴权头名字 / 请求体形状），光看 key 本身看不出来。
 * `src/tts/volcano.mjs` 里有一张变体矩阵，这个脚本就是把它跑一遍。
 *
 * ⚠️ **每次尝试都是一次真实计费**（合成一小段「你好」）。所以默认是 dry-run：
 *    只打印「将会试哪几个、每个发什么头」，一个字节都不发。
 *    加 --live 才真请求。
 *
 * 用法：
 *   node probe/tts-probe-volcano.mjs                          # dry-run，看矩阵
 *   node probe/tts-probe-volcano.mjs --live                    # 真试（花钱）
 *   node probe/tts-probe-volcano.mjs --live --speaker zh_female_xxx
 *   node probe/tts-probe-volcano.mjs --live --app-id A --access-key B
 *   node probe/tts-probe-volcano.mjs --live --key sk-xxx
 *
 * 凭据来源优先级：命令行 > 环境变量 > data/providers/tts.json
 *   VOLC_APP_ID / VOLC_ACCESS_KEY / VOLC_API_KEY / VOLC_SPEAKER
 *
 * ★ 本脚本**只读不写**。探到结果自己填进 tts.json 或设置页 ——
 *   它不会替你改任何配置（探针碰真实配置在这个项目里出过事）。
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 没显式指定数据根时，用项目自己的 data/（否则会读到 ~/.legacy，那不是本应用的家）
if (!process.env.ORB_DATA) process.env.ORB_DATA = join(ROOT, 'data')

const { loadTtsConfig, ttsConfigPath, VOLCANO_VARIANTS } = await import('../src/tts/index.mjs')
const { createVolcanoTts, candidatesFor, buildRequest, DEFAULT_SPEAKER } = await import('../src/tts/volcano.mjs')

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return fallback
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : 'true'
}

const LIVE = process.argv.includes('--live')
const cfg = loadTtsConfig()
const v = cfg.volcano ?? {}

const creds = {
  appId: arg('app-id') || process.env.VOLC_APP_ID || v.appId || '',
  accessKey: arg('access-key') || process.env.VOLC_ACCESS_KEY || v.accessKey || '',
  apiKey: arg('key') || process.env.VOLC_API_KEY || v.apiKey || '',
}
const speaker = arg('speaker') || process.env.VOLC_SPEAKER || v.speaker || ''

const mask = (s) => (s ? `${s.slice(0, 4)}…（${s.length} 字符）` : '<空>')

console.log('配置来源：' + ttsConfigPath())
console.log('appId     = ' + mask(creds.appId))
console.log('accessKey = ' + mask(creds.accessKey))
console.log('apiKey    = ' + mask(creds.apiKey))
console.log('speaker   = ' + (speaker || '<空，将用默认音色 ' + DEFAULT_SPEAKER + '>'))
if (v.variant) console.log('已记录的变体 = ' + v.variant)
console.log('')

const list = candidatesFor(creds)
if (list.length === 0) {
  console.error('没有任何可用的凭据。至少给一组：')
  console.error('  --app-id A --access-key B     （双头通道，火山的常规形态）')
  console.error('  --key sk-xxx                  （单 key 通道）')
  process.exit(2)
}

console.log(`凭据够跑 ${list.length} 个变体（共 ${VOLCANO_VARIANTS.length} 个）：`)
// 遮码映射必须**精确到每个头名**（别用「以 key 结尾」这种模糊判断：
// `X-Api-App-Key` 也以 key 结尾，但它装的是 appId，糊了会让她以为填错了字段）
const headerValue = (k) => {
  const low = k.toLowerCase()
  if (low === 'x-api-app-key' || low === 'x-api-app-id') return mask(creds.appId)
  if (low === 'x-api-access-key') return mask(creds.accessKey)
  if (low === 'x-api-key') return mask(creds.apiKey)
  return '***'
}
for (const [i, item] of list.entries()) {
  const req = buildRequest(item, { creds, text: '你好', speaker })
  const authHeader = Object.keys(req.headers)
    .filter((k) => /^X-Api-(App|Access|Key)/i.test(k))
    .map((k) => `${k}: ${headerValue(k)}`)
    .join(' · ')
  const needSpk = item.needsSpeaker ? (speaker ? '' : '  ⚠ 需要 speaker，现在没填 ⇒ 会跳过') : ''
  console.log(`  ${i + 1}. ${item.id.padEnd(20)} ${item.label}`)
  console.log(`     ${req.url}`)
  console.log(`     ${authHeader}${item.resourceId ? ` · X-Api-Resource-Id: ${item.resourceId}` : ''}${needSpk}`)
}

if (!LIVE) {
  console.log('')
  console.log('以上是 dry-run，没有发出任何请求。')
  console.log('要真试一次（**会真实计费**，每次合成一小段）：')
  console.log('  node probe/tts-probe-volcano.mjs --live')
  process.exit(0)
}

console.log('')
console.log('开始逐个尝试（探到一个就停，不会跑完整张表）…')
const tts = createVolcanoTts({ ...creds, speaker, log: () => {} })
const r = await tts.probe('你好')

console.log('')
console.log('── 结果 ─────────────────────────────────────────')
for (const item of r.tried) {
  const mark = item.ok ? 'OK  ' : 'FAIL'
  const tail = item.ok ? `${item.ms}ms` : `${item.ms}ms · ${item.error}`
  console.log(`  [${mark}] ${item.id.padEnd(20)} ${tail}`)
}

console.log('')
if (r.ok) {
  console.log(`✅ 这条凭据走的是：${r.label}`)
  console.log(`   把 "variant": "${r.variant}" 填进 ${ttsConfigPath()} 的 volcano 段，`)
  console.log('   以后就不用再探测了（每次探测都会计费）。')
  if (!speaker) {
    console.log('   注意：还没填 speaker。复刻类变体需要你自己的音色 id，否则有声但不是「她」。')
  }
} else {
  console.log('❌ 所有变体都没出音频。逐条原因见上。')
  console.log('   常见三种：')
  console.log('   · 45000010 = key 本身无效（不是头写错，别折腾参数）')
  console.log('   · 401/403  = 这条凭据没开通对应的服务或没有权限')
  console.log('   · 全是超时 = 本机网络到 openspeech.bytedance.com 不通')
}
process.exit(r.ok ? 0 : 1)
