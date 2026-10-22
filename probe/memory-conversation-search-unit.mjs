#!/usr/bin/env node
/**
 * 对话仓检索 · 单测（只在临时沙箱里造数据，**绝不碰 data/**）。
 *
 * 守的是 `src/memory.mjs` 的 `searchConversations()` —— 让 `search_memory`
 * 除了她整理过的记忆仓，也能捞到「当时到底怎么说的」原话。
 *
 * 这个函数的失败方式全是**静默返回空数组**：没有异常、没有日志，看起来就是
 * 「她确实没提过」。所以下面每条断言都成对——正例必须命中，反例必须不命中，
 * 缺一半就测不出这类错。
 *
 * 重点钉住四个坑（前三个都在这份代码上真踩过）：
 *   ① 前缀形态：传进来的是 `agentId`（配置里 `orb-20261019`），但会话 id 是
 *      `local-<agentId>`（main.mjs:2968/1174/1999/3953）。只认一种写法 = 永远 0 命中。
 *   ② padding：目录名是**去掉 padding 的 base64**，长度不整除 3 时前缀对不上，
 *      同样静默 0 命中（`conversation:local-orb-20261019` 是 32 字节，%3=2，正好踩中）。
 *   ③ 前缀混淆：字符级 startsWith 会把 `local-orb-2026` 的检索带进 `local-orb-20261019`。
 *   ④ 时间戳落盘是 UTC，直接截字符串会给她差 8 小时的时间（= 记错日子）。
 *
 * ★ 每个夹具用**独立 sessionId**：同一 sessionId 会写同一个 messages.jsonl，
 *   后建的会把先建的整个覆盖掉，前面的断言就悄悄失去依据了（第一版栽在这）。
 *
 * 跑法：node probe/memory-conversation-search-unit.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'orb-convsearch-'))
process.env.ORB_DATA = TMP // dataRoot() 是惰性的，这里设完就生效
const { searchConversations } = await import('../src/memory.mjs')

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`PASS ${name}`)
    return
  }
  failed += 1
  console.log(`FAIL ${name}${detail ? `  —— ${detail}` : ''}`)
}

/** 与 src/session.mjs 的 sessionKey 完全一致：base64 且去掉 padding。 */
function sessionKey(sessionId) {
  return Buffer.from(`conversation:${sessionId}`, 'utf8')
    .toString('base64')
    .replace(/=+$/, '')
}

let seq = 0
/** 一条新格式记录（content 是 parts 数组）。 */
function line(role, text, timestamp = NOW) {
  seq += 1
  return JSON.stringify({
    message: { id: `m${seq}`, role, content: [{ type: 'text', text }] },
    timestamp,
  })
}
/** 一条老格式记录（content 是纯字符串）。 */
function lineLegacy(role, text, timestamp = NOW) {
  seq += 1
  return JSON.stringify({ message: { id: `m${seq}`, role, content: text }, timestamp })
}
/** 在沙箱里造一个会话目录，`lines` 逐行写进 messages.jsonl。 */
function makeConv(sessionId, lines, { ageDays = 0 } = {}) {
  const dir = join(TMP, 'conversations', sessionKey(sessionId))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'messages.jsonl')
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  if (ageDays > 0) {
    const t = (Date.now() - ageDays * 86_400_000) / 1000
    utimesSync(file, t, t)
  }
}

const NOW = '2026-10-21T23:45:12.000Z'
const AGENT = 'orb-20261019' // 配置里真实的值（config.agentId）
// 生产上会话 id 是 `local-<agentId>`，所以传进来的是 AGENT、盘上却是 SID()
const SID = (suffix = '') => `local-${AGENT}${suffix}`
const ODD = 'orb-xy' // 19 字节，%3=1，也带 padding
const textOf = (hits) => hits.map((h) => h.text)

// ══ 夹具：一次造齐，每个会话独立 ══════════════════════════════════
makeConv(SID(), [
  line('user', '我上次跟你说的那条抹香鲸，是搁浅在崇明东滩的那条。'),
  line('assistant', '记得，你说过它肚子里有一堆塑料袋。'),
  line('user', '今天天气不错。'),
])
makeConv(SID('#english'), [line('user', 'We talked about the Sperm Whale project.')])
makeConv(SID('#wechat'), [line('user', '微信这边也提过崇明东滩。')])
makeConv('somebody-else', [line('user', '别人的抹香鲸记录。')])
makeConv(`local-${ODD}`, [line('user', '短 agentId 也要能搜到：蓝鲸。')])
makeConv(SID('#old'), [line('user', '很久以前说过的渡鸦。')], { ageDays: 71 })
makeConv(SID('#long'), [line('user', `${'甲'.repeat(500)}座头鲸${'乙'.repeat(500)}`)])
makeConv(
  SID('#impression'),
  Array.from({ length: 20 }, (_, i) => line('user', `第 ${i} 次聊到虎鲸。`)),
)
makeConv(SID('#flat'), [line('user', '第一行\n第二行\n\n第三行 有 空格：独角鲸')])
makeConv(SID('#legacy'), [lineLegacy('user', '2026-10 之前的老记录：白鲸。')])
makeConv(SID('#broken'), [
  '{"message":{"id":"x1","role":"user","content":[{"type":"text","text":"坏行前面的抹香鲸"}]},"timestamp":"' +
    NOW +
    '"}',
  '{ 这不是合法 JSON',
  '{"message":{"id":"x2","role":"user","content":[{"type":"text","text":"坏行后面的抹香鲸"}]},"timestamp":"' +
    NOW +
    '"}',
])
makeConv(SID('#image'), [
  JSON.stringify({
    message: { id: 'img1', role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] },
    timestamp: NOW,
  }),
])
// 2026-10-22 之前的老记录：`<memory_update>` 全文跟着他的一句话一起落盘了
makeConv(SID('#mupdate'), [
  line(
    'user',
    '有点冷。\n<memory_update path="MEMORY.md">\n# 记忆\n## 关于他\n- 喝冰美式，不加糖。\n</memory_update>',
  ),
])
// 老后端（legacy）的会话 id 没有 `local-` 前缀 —— 两种形态都得认
makeConv('orb-plain', [line('user', '老后端形态的会话：信天翁。')])

// ══ S1-S4 基本命中 ═══════════════════════════════════════════════
const s1 = searchConversations(AGENT, '崇明东滩')
check(
  'S1 他说过的原话能搜到（role=user）',
  s1.length === 2 && s1.some((h) => h.role === 'user') && textOf(s1).every((t) => t.includes('崇明东滩')),
  JSON.stringify(textOf(s1)),
)

const s2 = searchConversations(AGENT, '塑料袋')
check(
  'S2 她自己说过的话也能搜到（role=assistant）',
  s2.length === 1 && s2[0].role === 'assistant' && s2[0].text.includes('塑料袋'),
  JSON.stringify(s2),
)

check('S3 搜不到的词返回空数组', searchConversations(AGENT, '北太平洋').length === 0)

const s4 = searchConversations(AGENT, 'sperm whale')
check(
  'S4 英文大小写不敏感（且只命中英文那条）',
  s4.length === 1 && s4[0].conv === sessionKey(SID('#english')),
  JSON.stringify(s4.map((h) => h.conv)),
)

// ══ S5-S9 目录归属（四个坑）══════════════════════════════════════
// ★ 这条同时是「前缀形态」的钉子：传 AGENT，盘上是 local-AGENT
const s5 = searchConversations(AGENT, '崇明东滩')
check(
  'S5 ★ 传 agentId 也能找到 local-<agentId> 的会话（生产真实形态）',
  s5.some((h) => h.conv === sessionKey(SID())),
  JSON.stringify(s5.map((h) => h.conv)),
)
check(
  'S6 同 agent 的 # 后缀会话（#wechat）能被搜到',
  s5.some((h) => h.conv === sessionKey(SID('#wechat'))),
  JSON.stringify(s5.map((h) => h.conv)),
)

const s7 = searchConversations(ODD, '蓝鲸')
check('S7 ★ agentId 长度不整除 3 时仍能命中（padding 已正确处理）', s7.length === 1, JSON.stringify(s7))

const s8 = searchConversations('local-orb-2026', '崇明东滩')
check('S8 ★ 相似 agentId 不串仓（local-orb-2026 ≠ local-orb-20261019）', s8.length === 0, JSON.stringify(s8))

const s9a = searchConversations(AGENT, '别人的')
const s9b = searchConversations('somebody-else', '别人的')
check(
  'S9 别人的会话不进来（反向对照：换成它的主人就能搜到，证明不是永远为空）',
  s9a.length === 0 && s9b.length === 1,
  `self=${s9a.length} owner=${s9b.length}`,
)

check(
  'S10 老后端形态（会话 id 没有 local- 前缀）也能搜到',
  searchConversations('orb-plain', '信天翁').length === 1,
)

// ══ S11-S12 mtime 窗口 ═══════════════════════════════════════════
check('S11 超出 days 窗口（71 天）的文件不搜', searchConversations(AGENT, '渡鸦').length === 0)
check(
  'S12 days 放宽后同一个文件能搜到（反向对照）',
  searchConversations(AGENT, '渡鸦', { days: 90 }).length === 1,
)

// ══ S13-S14 上下文预算 ═══════════════════════════════════════════
const s13 = searchConversations(AGENT, '座头鲸')
check(
  'S13 命中就地截断到 200 字，且保留命中词',
  s13.length === 1 && s13[0].text.length <= 200 && s13[0].text.includes('座头鲸'),
  `len=${s13[0]?.text.length}`,
)
check(
  'S14 ★ maxBytes 预算不足时跳过该文件（不读盘、不卡主进程）',
  searchConversations(AGENT, '座头鲸', { maxBytes: 10 }).length === 0,
)

// ══ S15-S16 条数与清洗 ═══════════════════════════════════════════
const s15 = searchConversations(AGENT, '虎鲸', { limit: 3 })
check('S15 limit 生效（20 条里只取 3 条）', s15.length === 3, `got ${s15.length}`)

const s16 = searchConversations(AGENT, '独角鲸')
check(
  'S16 换行/连续空格被压平成单行',
  s16.length === 1 && !/[\r\n]/.test(s16[0].text) && !/ {2}/.test(s16[0].text),
  JSON.stringify(s16[0]?.text),
)

// ══ S17-S20 老格式 / 坏数据 / 机器注入块 ═════════════════════════
check('S17 老格式（content 是纯字符串）也能命中', searchConversations(AGENT, '白鲸').length === 1)

const s18 = searchConversations(AGENT, '坏行')
check(
  'S18 ★ 坏 JSON 行不炸，前后好行照常命中',
  s18.length === 2 && textOf(s18).some((t) => t.includes('前面')) && textOf(s18).some((t) => t.includes('后面')),
  JSON.stringify(textOf(s18)),
)

check('S19 纯图片消息（没有 text part）被安静跳过', searchConversations(AGENT, 'AAAA').length === 0)

// 假的命中比空结果更糟：她会以为「我真记得他说过这句」。
const s20a = searchConversations(AGENT, '不加糖') // 只在 <memory_update> 块里
const s20b = searchConversations(AGENT, '有点冷') // 他自己说的话
check('S20 ★ <memory_update> 块里的内容搜不到（不是他说的）', s20a.length === 0, JSON.stringify(textOf(s20a)))
check(
  'S21 ★ 同一句里块外的原话照常搜到，且返回文本里不带 memory_update',
  s20b.length === 1 && !s20b[0].text.includes('memory_update'),
  JSON.stringify(s20b[0]?.text),
)

// ══ S22-S25 返回值形状与边界 ═════════════════════════════════════
const s22 = searchConversations(AGENT, '塑料袋')
check(
  'S22 每条都带 source/conv/when/role/text 五个字段',
  s22.length === 1 &&
    s22.every(
      (h) =>
        h.source === 'conversation' &&
        typeof h.conv === 'string' &&
        h.conv !== '' &&
        typeof h.when === 'string' &&
        typeof h.role === 'string' &&
        typeof h.text === 'string',
    ),
  JSON.stringify(s22[0]),
)

// ★ 时间戳是 UTC 落盘的，返回给她的必须是本地时间（差 8 小时 = 记错日子）
const expectWhen = (() => {
  const d = new Date(NOW)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
})()
check(
  'S23 ★ when 是本地时区的 YYYY-MM-DD HH:mm，不是 UTC 字符串截断',
  s22[0]?.when === expectWhen,
  `${s22[0]?.when} ≠ ${expectWhen}`,
)

check(
  'S24 空 query / 纯空格 query 返回空数组（不扫盘）',
  searchConversations(AGENT, '').length === 0 && searchConversations(AGENT, '   ').length === 0,
)

const EMPTY_ROOT = mkdtempSync(join(tmpdir(), 'orb-convsearch-empty-'))
process.env.ORB_DATA = EMPTY_ROOT
check('S25 data/conversations 不存在时返回空数组（不抛错）', searchConversations(AGENT, '抹香鲸').length === 0)
process.env.ORB_DATA = TMP

// ══ 收尾 ════════════════════════════════════════════════════════
rmSync(TMP, { recursive: true, force: true })
rmSync(EMPTY_ROOT, { recursive: true, force: true })

console.log(`\n${passed} PASS / ${failed} FAIL`)
if (failed > 0) process.exit(1)
