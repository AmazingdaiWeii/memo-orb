#!/usr/bin/env node
/**
 * 找「MARKER 正则根本没匹配上」的情绪标记。
 *
 * 为什么需要这支：
 *   `probe/mood-alias-audit.mjs` 只能审计**已经匹配到**的标记（它自己就用 MARKER 扫），
 *   所以像 `(mood:开心，笑了)` 这种因为捕获组不收中文逗号而**整体匹配失败**的，
 *   在 audit 里是查无此人 —— 命中率显示 97.5%，实际却有一批标记压根没进统计。
 *
 * 做法：
 *   1. 用一个「宽松到几乎不会失败」的括号嗅探：`[（(] ... mood ... [)）]`；
 *   2. 逐条拿真正在用的 MARKER 去测；
 *   3. 没测上的，原样列出来 —— 这些就是用户看不见的漏网标记（会**泄漏到正文**里给她看到）。
 *
 * 用法：node probe/mood-marker-gap.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createMoodMarker } from '../src/mood.mjs'

const ROOT = process.cwd()
const CONV_DIR = join(ROOT, 'data', 'conversations')

/**
 * 「正式」正则 —— 直接用产品导出的那一份，不复制字面量。
 * 这支脚本存在的意义就是「找正式正则的漏」，副本一漂移就失去意义了。
 */
const MARKER = createMoodMarker()

/**
 * 宽松嗅探：只要括号里有 mood 加冒号就先抓出来，不管里面有什么字符、有多长。
 * 故意比正式正则宽（80 vs 32），这样「超长导致匹配失败」也能被看见。
 */
const SNIFF = /[（(]\s*mood\s*[:：][^)）\n]{0,80}[)）]/gi

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
    else if (/\.(json|jsonl|md|txt)$/i.test(name)) out.push(p)
  }
  return out
}

const files = walk(CONV_DIR)
const gaps = new Map() // 原文 -> { count, files:Set }
let sniffed = 0
let matched = 0

for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  if (!text.includes('mood')) continue

  SNIFF.lastIndex = 0
  let m
  while ((m = SNIFF.exec(text)) !== null) {
    const raw = m[0]
    sniffed += 1
    MARKER.lastIndex = 0
    if (MARKER.test(raw)) {
      matched += 1
      continue
    }
    if (!gaps.has(raw)) gaps.set(raw, { count: 0, files: new Set() })
    const hit = gaps.get(raw)
    hit.count += 1
    hit.files.add(file.slice(ROOT.length + 1))
  }
}

console.log('='.repeat(66))
console.log(`扫到 ${files.length} 个文件`)
console.log(`宽松嗅探命中 ${sniffed} 处「看起来像标记」的片段`)
console.log(`  正式 MARKER 匹配上：${matched}`)
console.log(`  ❌ 匹配不上：${gaps.size} 种 / ${sniffed - matched} 处`)
console.log('='.repeat(66))

if (gaps.size === 0) {
  console.log('\n没有缺口。')
  process.exit(0)
}

const rows = [...gaps.entries()].sort((a, b) => b[1].count - a[1].count)
for (const [raw, info] of rows) {
  console.log(`\n×${info.count}  ${JSON.stringify(raw)}`)
  // 逐字符指出「第一个不被捕获组接受的字符」，那才是断点
  const inner = raw.replace(/^[（(]\s*mood\s*[:：]\s*/i, '').replace(/\s*[)）]$/, '')
  const bad = [...inner].find((ch) => !/[A-Za-z\u4e00-\u9fa5_-]/.test(ch))
  if (bad !== undefined) {
    console.log(`        断点字符：${JSON.stringify(bad)}（U+${bad.codePointAt(0).toString(16).toUpperCase()}）`)
  }
  console.log(`        样例文件：${[...info.files][0]}`)
}

// 按「断点字符」归类，告诉我们该往捕获组里补哪些字符
const byChar = new Map()
for (const [raw] of rows) {
  const inner = raw.replace(/^[（(]\s*mood\s*[:：]\s*/i, '').replace(/\s*[)）]$/, '')
  const bad = [...inner].find((ch) => !/[A-Za-z\u4e00-\u9fa5_-]/.test(ch))
  if (bad === undefined) continue
  byChar.set(bad, (byChar.get(bad) ?? 0) + 1)
}
console.log('\n' + '-'.repeat(66))
console.log('要补进捕获组的字符（按出现种类数排序）：')
for (const [ch, n] of [...byChar.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${JSON.stringify(ch)}  U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}  ${n} 种`)
}
