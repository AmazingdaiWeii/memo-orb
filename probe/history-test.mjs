// 验证 listConversations 能不能真读到本机的 conversation。
// 这是历史对话功能的唯一数据源，读不到就等于功能没接通。
import { listConversations, stripSystemReminder, readConversationBlocks } from '../src/history.mjs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))

console.log(`config.agentId = ${cfg.agentId}`)
const all = listConversations()
const mine = listConversations(cfg.agentId)
console.log(`全部 conversation: ${all.length} 个`)
console.log(`属于本 agent 的: ${mine.length} 个`)
console.log('--- 最近 8 个 ---')
for (const it of (mine.length >= 8 ? mine : all).slice(0, 8)) {
  console.log(`  ${it.sessionId}  ${it.updatedAt}  「${it.title || '(无标题)'}」`)
}

// ---------------------------------------------------------------- 剥壳
// 验证剥 system-reminder 是否真的有效
const sample = `<system-reminder>
This is an automated message providing context about the user's environment.
- **Local time**: 2026年10月6日
</system-reminder>
请只回一句话：甲`
const cleaned = stripSystemReminder(sample)
console.log('--- stripSystemReminder 验证 ---')
console.log(`  原文 ${sample.length} 字 → 清洗后「${cleaned}」`)
if (cleaned !== '请只回一句话：甲') {
  console.log('  !! 剥壳不干净')
  process.exit(1)
}

// ---------------------------------------------------------------- 还原块
console.log('--- readConversationBlocks 验证 ---')
const source = mine[0] ?? all[0]
if (!source) {
  console.log('本机没有任何 conversation，跳过')
  process.exit(0)
}
const loaded = readConversationBlocks(source.sessionId)
if (!loaded) {
  console.log(`  !! 读不回 ${source.sessionId}`)
  process.exit(1)
}
console.log(`  ${source.sessionId} → ${loaded.blocks.length} 个块`)
for (const b of loaded.blocks) {
  const flag = b.response ? '  ←response' : ''
  const preview = b.text.replace(/\n/g, '\\n').slice(0, 46)
  console.log(`    [${b.kind}] ${b.key}${flag}  「${preview}」`)
}

// 断言 1：块必须成对（user/assistant 交替）
const kinds = loaded.blocks.map((b) => b.kind)
if (kinds.length < 2) {
  console.log('  !! 块太少，不是有效会话')
  process.exit(1)
}
// 断言 2：正文里绝不能残留 system-reminder（剥壳不干净会在这里暴露）
const dirty = loaded.blocks.filter((b) => b.text.includes('<system-reminder>'))
if (dirty.length > 0) {
  console.log(`  !! ${dirty.length} 个块还残留 <system-reminder>，剥壳不干净`)
  process.exit(1)
}
// 断言 3：user 块不能是空的（剥过头了会把真实提问也削掉）
const emptyUser = loaded.blocks.find((b) => b.kind === 'user' && b.text === '')
if (emptyUser) {
  console.log('  !! user 块正文为空，剥过头了')
  process.exit(1)
}
// 断言 4：最后一个 assistant 必须带 response（折叠态球靠它显示最终答案）
const lastAssistant = [...loaded.blocks].reverse().find((b) => b.kind === 'assistant')
if (!lastAssistant?.response) {
  console.log('  !! 最后一条 assistant 没标 response，折叠态会显示为空')
  process.exit(1)
}
console.log('OK')
