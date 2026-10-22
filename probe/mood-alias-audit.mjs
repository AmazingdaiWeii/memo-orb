#!/usr/bin/env node
/**
 * 情绪标记「认得出 / 认不出」实测审计（只读）。
 *
 * 起因（2026-10-22 用户报障）：
 *   「窗口侧的情绪 gif 表达不完整，只有思考和开心这两种，其它的都无法加载。」
 *
 * 本探针不猜，直接把 `data/conversations/**` 里她**真实写过**的每一条
 * `(mood:xxx)` 拿 `src/mood.mjs` 的 `coerceMood()` 过一遍，算出命中率，
 * 并把「认不出的原词」按频次列出来 —— 那些词就是被静默丢掉的表达。
 *
 * 用法：node probe/mood-alias-audit.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { coerceMoodPhrase, createMoodMarker, MOODS, MOOD_NAMES } from '../src/mood.mjs'

const ROOT = process.cwd()
const CONV = join(ROOT, 'data', 'conversations')

/**
 * ⚠️ 用产品那边导出的 `createMoodMarker()`，**别再复制字面量**。
 *
 * 以前这里抄了一份和 `src/mood.mjs` 一样的正则，看着"同源"其实会漂移：
 * 2026-10-22 产品放宽了值域（收中文逗号），这份副本没跟上，
 * 于是 5 条 `（mood:开心，松了口气）` 在审计里查无此人 —— 命中率虚高到 97.5%。
 * 审计工具一旦和产品不同步，它给的就是**虚假的安全感**。
 */
const MARKER = createMoodMarker()

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p, out)
    else if (/\.(jsonl|json)$/.test(name)) out.push(p)
  }
  return out
}

const files = walk(CONV)
const counts = new Map()   // 原词 → 次数
let total = 0

for (const f of files) {
  let text = ''
  try {
    text = readFileSync(f, 'utf8')
  } catch {
    continue
  }
  MARKER.lastIndex = 0
  let m
  while ((m = MARKER.exec(text)) !== null) {
    const raw = String(m[1]).trim()
    if (raw === '') continue
    total += 1
    counts.set(raw, (counts.get(raw) ?? 0) + 1)
  }
}

const hits = []
const misses = []
for (const [raw, n] of counts) {
  // 用 `coerceMoodPhrase` 而不是 `coerceMood`：值可能是「开心，松了口气」这种多个词。
  const mood = coerceMoodPhrase(raw)
  ;(mood ? hits : misses).push({ raw, n, mood })
}
hits.sort((a, b) => b.n - a.n)
misses.sort((a, b) => b.n - a.n)

const hitTotal = hits.reduce((s, x) => s + x.n, 0)
const missTotal = misses.reduce((s, x) => s + x.n, 0)
const pct = (a, b) => (b === 0 ? '0.0' : ((a / b) * 100).toFixed(1))

console.log('='.repeat(66))
console.log(`扫到 ${files.length} 个文件，共 ${total} 处 (mood:xxx) 标记`)
console.log(`  ✅ 认得出：${hitTotal} 处（${pct(hitTotal, total)}%）`)
console.log(`  ❌ 认不出：${missTotal} 处（${pct(missTotal, total)}%）—— 标记被剥掉，表情不变，且不报错`)
console.log('='.repeat(66))

console.log('\n【认得出的】按次数')
for (const h of hits) console.log(`  ${String(h.n).padStart(3)}  ${h.raw.padEnd(10)} → ${h.mood}`)

console.log('\n【认不出的】按次数（这些全是白写的）')
for (const x of misses) console.log(`  ${String(x.n).padStart(3)}  ${x.raw}`)

console.log('\n【每个情绪的「有效触发量」】')
for (const name of MOOD_NAMES) {
  const n = hits.filter((h) => h.mood === name).reduce((s, h) => s + h.n, 0)
  const bar = '█'.repeat(Math.min(40, n))
  console.log(`  ${name.padEnd(10)} ${String(n).padStart(3)}  ${bar}`)
}

console.log('\n【每个情绪在别名表里的词数】')
for (const name of MOOD_NAMES) {
  console.log(`  ${name.padEnd(10)} ${MOODS[name] ? '' : '?'}`)
}
