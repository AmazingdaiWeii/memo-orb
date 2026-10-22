#!/usr/bin/env node
/**
 * 让她说一句话 —— 把适配层取到的音频**落成一个 mp3**，用来人耳验收。
 *
 * 为什么要有这个脚本：适配层的单测只能证明「请求构造对了、回包解析对了」，
 * 证明不了「听起来是不是她」。这条只能靠听。
 *
 * ⚠️ 每次运行都会**真实计费**（按字数算）。
 *
 * 用法：
 *   node probe/tts-say.mjs "喂，你在忙什么"
 *   node probe/tts-say.mjs "喂，你在忙什么" --out art/tts/a.mp3
 *   node probe/tts-say.mjs "喂" --emotion 撒娇 --rate -10      # 情绪 + 语速
 *   node probe/tts-say.mjs --text-file some.txt                 # 长文本
 *
 * 默认输出到 art/tts/<时间戳>.mp3（art/ 已 gitignore，不会进仓库）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (!process.env.ORB_DATA) process.env.ORB_DATA = join(ROOT, 'data')

const { loadTtsConfig, createTts, describeTtsState } = await import('../src/tts/index.mjs')

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return fallback
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : 'true'
}

// 第一个不是 --flag 的位置参数就是正文
const positional = process.argv.slice(2).filter((a, i, arr) => {
  if (a.startsWith('--')) return false
  const prev = arr[i - 1]
  return !(prev && prev.startsWith('--')) // 跳过 --xxx 的取值
})
let text = positional[0] || ''
const textFile = arg('text-file')
if (!text && textFile) {
  const { readFileSync } = await import('node:fs')
  text = readFileSync(textFile, 'utf8')
}
text = String(text || '').trim()

if (!text) {
  console.error('要合成的文字是空的。用法： node probe/tts-say.mjs "喂，你在忙什么"')
  process.exit(2)
}

const cfg = loadTtsConfig()
const tts = createTts(cfg, { log: (m) => console.log(m) })
console.log('状态：' + describeTtsState(tts.describe()))

const emotion = arg('emotion')
const rate = arg('rate')
const r = await tts.speak(text, {
  emotion: emotion || undefined,
  speechRate: rate ? Number(rate) : undefined,
})

if (!r.ok) {
  console.error('')
  console.error('❌ 失败：' + r.error + (r.code != null ? `（业务码 ${r.code}）` : ''))
  if (r.raw) console.error('原始回包片段：' + r.raw)
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const out = arg('out') || join(ROOT, 'art', 'tts', `${stamp}.mp3`)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, r.audio)

console.log('')
console.log(`✅ ${text.length} 字 → ${r.bytes}B（${r.blocks} 块）· ${r.ms}ms · 变体 ${r.variant}`)
console.log('   存到：' + out)
console.log('   （art/ 已 gitignore，不会被提交）')
