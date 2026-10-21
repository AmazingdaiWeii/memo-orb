/**
 * 主对话挂回 + 上下文压缩显示 + 压缩即沉淀 · 契约断言（纯 node，不需要 Electron）
 *
 * 跑法：`node probe/context-compaction-test.mjs`
 *
 * 为什么要有这支探针（用户 m02698 的三件事，三条都「界面上看不见就等于没做」）：
 *   ① 主对话口径：进程启动**不建 runtime**，用户第一条消息才建 —— 所以「每次打开
 *      默认进主对话」的真实含义是「本次第一条消息落在主对话上」。这条链路上任何一处
 *      退回 `conversationId: null`，症状都是「她又不记得昨天了」，而日志里看不出来。
 *   ② 压缩显示：`event_message` / `summary_message` 以前在 `src/` 下**零命中**，
 *      直接掉进 `onDelta` 末尾的「未映射 delta」日志 —— 用户以为压根没有上下文压缩。
 *   ③ 压缩即沉淀（方案 A）：压缩后顺带跑一次**项目已有的**印象管线，不碰旧后端自己的
 *      `reflectionTrigger`。
 *
 * ★ 纪律：断言里的正则只认「产品里真实存在的字符串」。抽不到就 FAIL ——
 *   那本身就是契约断了，而不是探针写错了。每条尽量配一个反向对照
 *   （把修复换回旧写法，断言必须变红）。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// ⚠️ 本机产品文件是 CRLF：先归一成 LF，下面按 '\n' 写的切片点才抽得到
//    （踩过的坑：正则 `/**\n *` 在 CRLF 文件里永远不匹配 → 探针自己抛错）。
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n')

const HOST = read('src', 'main.mjs')
const SHELL = read('helper', 'assets', 'shell.js')
const CHAT_CSS = read('helper', 'assets', 'chat.css')
const ICONS = read('helper', 'assets', 'icons.js')

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 抽一段源码。抽不到就抛 —— 契约断了要让探针自己红，不要静默跳过。 */
function slice(source, from, to, label) {
  const i = source.indexOf(from)
  if (i < 0) throw new Error(`抽不到起点：${label} —— ${from}`)
  const j = to === '' ? source.length : source.indexOf(to, i + from.length)
  if (j < 0) throw new Error(`抽不到终点：${label} —— ${to}`)
  return source.slice(i, j)
}

console.log('# 主对话 / 上下文压缩 / 压缩即沉淀 · 纯源码断言（用户 m02698）')
console.log('')

/* ── A. 两条压缩 delta 真的接进了 onDelta ──────────────────────────────── */
console.log('## A. 压缩 delta 的接线（以前掉进「未映射 delta」）')
const deltaBody = slice(HOST, 'function onDelta(delta) {', '\nasync function startLegacy()', 'onDelta')
check('A1：onDelta 认 event_message，且内部判 event_type===\'compaction\'',
  /if \(type === 'event_message'\)[\s\S]{0,160}?delta\.event_type === 'compaction'/.test(deltaBody))
check('A2：onDelta 认 summary_message',
  /if \(type === 'summary_message'\)/.test(deltaBody))
check('A3：两条分支都在「---- 工具调用 ----」之前（否则会被后面的分支吞掉）',
  deltaBody.indexOf("type === 'event_message'") > 0 &&
  deltaBody.indexOf("type === 'summary_message'") > 0 &&
  deltaBody.indexOf('// ---- 上下文压缩') < deltaBody.indexOf('// ---- 工具调用 ----'))
check('A4：两条分支都 return（不再往下掉进工具分支）',
  /\n    return\n  \}\n  if \(type === 'summary_message'\)/.test(deltaBody) &&
  /onCompactionSummary\(delta\)\n    return\n  \}/.test(deltaBody))
check('A5（反向对照）：两条分支各只有一处 —— 多一处就有一处永远走不到',
  (deltaBody.match(/type === 'event_message'/g) ?? []).length === 1 &&
  (deltaBody.match(/type === 'summary_message'/g) ?? []).length === 1)
check('A6：非压缩的 event_message 仍落 logRaw（不静默丢弃）',
  /logRaw\(`event_message\[\$\{delta\.event_type \?\? '\?'\}\]:`/.test(deltaBody))
check('A7：两条分支都过会话归属闸门 compactionInCurrentConversation',
  (deltaBody.match(/compactionInCurrentConversation\(delta\)/g) ?? []).length === 2)

/* ── B. 提示文案生成器（把产品函数抠出来真跑）──────────────────────────── */
console.log('')
console.log('## B. 文案生成器（抠出真函数跑，不只比字符串）')
const textFns = slice(HOST, '/** 压缩触发原因 → 人话', '/**\n * 压缩事件属于当前会话吗？', 'compaction text fns')
const { formatTokens, compactionTriggerLabel, compactionNoticeText } =
  new Function(`${textFns}; return { formatTokens, compactionTriggerLabel, compactionNoticeText }`)()
check('B1：formatTokens 量级与非法值（987654→987.7k / 12000000→12.0M / 0 与 NaN→空串）',
  formatTokens(987654) === '987.7k' && formatTokens(12000000) === '12.0M' &&
  formatTokens(0) === '' && formatTokens('x') === '' && formatTokens(-5) === '')
check('B2：trigger 翻人话，未知取值原样回显、缺失给「未知原因」',
  compactionTriggerLabel('context_window_limit') === '上下文压力' &&
  compactionTriggerLabel('context_window_overflow') === '超出模型上下文' &&
  compactionTriggerLabel('manual') === '手动触发' &&
  compactionTriggerLabel('other') === 'other' && compactionTriggerLabel('') === '未知原因')
const full = compactionNoticeText('context_window_limit', {
  messagesBefore: 42, messagesAfter: 8, contextTokensBefore: 987654, contextTokensAfter: 12345,
})
check('B3：完整一行含 4 段（已压缩 / 触发原因 / 隐藏条数 / token 前后）',
  full === '上下文已压缩 · 触发：上下文压力 · 隐藏 34 条早期消息 · 上下文 987.7k → 12.3k tokens',
  full)
check('B4（反向对照）：messagesBefore <= messagesAfter 时不写「隐藏」（别印负数）',
  !compactionNoticeText('manual', { messagesBefore: 5, messagesAfter: 9 }).includes('隐藏'))
check('B5（反向对照）：统计缺项 / 非法 token 不写 NaN、不写半截',
  compactionNoticeText('manual', null) === '上下文已压缩 · 触发：手动触发' &&
  !compactionNoticeText('manual', { contextTokensBefore: 'x', contextTokensAfter: 1 }).includes('tokens'))

/* ── C. 会话归属闸门 ──────────────────────────────────────────────────── */
console.log('')
console.log('## C. 压缩事件落错会话的闸门（印象任务那条隔离会话也会压缩）')
const gate = slice(HOST, 'function compactionInCurrentConversation(delta) {', '\nfunction onCompactionEvent', 'gate')
check('C1：拿 delta.conversation_id 与当前会话（runtime?.conversation_id ?? blockScope）比',
  /delta\.conversation_id/.test(gate) && /runtime\?\.conversation_id \?\? blockScope/.test(gate))
check('C2：delta 没带 conversation_id 时放行（老后端不带这个字段，别把提示吞了）',
  /if \(!conv\) return true/.test(gate))
check('C3：落错会话时记日志（排障时要能看见「我拦了一条」）',
  /压缩事件属于别的会话/.test(gate))

/* ── D. 球侧把 notice 画成一条系统提示行 ──────────────────────────────── */
console.log('')
console.log('## D. 球侧渲染（kind=notice）')
check('D1：shell.js 有 createNoticeNode / updateNoticeNode',
  /function createNoticeNode\(node\) \{/.test(SHELL) && /function updateNoticeNode\(node, block\) \{/.test(SHELL))
const upsertBody = slice(SHELL, 'function upsertBlock(block) {', '\n  function removeBlock', 'upsertBlock')
check('D2：upsertBlock 里 notice 的建节点分支排在「else → reasoning」之前（否则永远进 reasoning）',
  upsertBody.includes("} else if (block.kind === 'notice') {") &&
  upsertBody.indexOf("block.kind === 'notice'") < upsertBody.indexOf("node.dataset.kind = 'reasoning'"))
check('D3：upsertBlock 里 notice 的更新分支排在最后的 else（assistant）之前',
  upsertBody.includes('updateNoticeNode(node, block)') &&
  upsertBody.indexOf('updateNoticeNode(node, block)') < upsertBody.lastIndexOf('updateAssistantNode(node, block)'))
const placeBody = slice(SHELL, 'function placeBlock(node, kind) {', '\n  function ', 'placeBlock')
check('D4：placeBlock 把 notice 当「不属于任何一轮」——先 closeProcess 再直接挂 transcript',
  /if \(kind === 'user' \|\| kind === 'notice'\) \{[\s\S]{0,120}?closeProcess\(\)[\s\S]{0,120}?transcript\.append\(node\)/.test(placeBody))
const processBody = slice(SHELL, 'function ensureProcess() {', '\n  function syncThinkPreview', 'ensureProcess')
check('D5（反向对照）：过程组只吸 user/assistant 两种 kind —— notice 不会被吸进折叠组',
  /child\.dataset\?\.kind === 'user'/.test(processBody) && /child\.dataset\?\.kind === 'assistant'/.test(processBody) &&
  !/dataset\?\.kind === 'notice'/.test(processBody) && !/dataset\?\.kind === 'reasoning'/.test(processBody))
check('D6：摘要默认收起、有摘要才可点（data-has-summary 控 aria-expanded 与 chevron）',
  /toggleAttribute\('data-has-summary', summary !== ''\)/.test(SHELL) &&
  /if \(!node\.hasAttribute\('data-has-summary'\)\) return/.test(SHELL))
check('D7：摘要正文走 renderMarkdownBody，notice 段不碰 innerHTML',
  /renderMarkdownBody\(body, summary, \{ compact: true, live: block\.running === true \}\)/.test(SHELL) &&
  !/notice[\s\S]{0,400}?\.innerHTML/.test(SHELL))
const noticeCss = slice(CHAT_CSS, '.block[data-kind="notice"]', '/* ----- TextShimmer', 'notice css')
check('D8：chat.css 有 notice 段，且含 .notice-body 与 [hidden] 复位',
  noticeCss.includes('.notice-body') && /\[hidden\][\s\S]{0,80}?display:\s*none/.test(noticeCss))
check('D9：图标 COMPACT 是自绘（注释里写明与上游素材无关）',
  /export const COMPACT/.test(ICONS) && /自绘/.test(ICONS))

/* ── E. 压缩即沉淀（方案 A）────────────────────────────────────────────── */
console.log('')
console.log('## E. 压缩即沉淀（方案 A：跑自己那条印象管线，不动旧后端的 reflectionTrigger）')
check('E1：onCompactionEvent 在放好提示之后调 maybeSettleMemoryAfterCompaction',
  /putBlock\(raw, 'notice'[\s\S]{0,200}?maybeSettleMemoryAfterCompaction\(trigger\)/.test(HOST))
const settleBody = slice(HOST, 'function maybeSettleMemoryAfterCompaction(trigger) {', '\n/** 探针用', 'settle')
check('E2：走的是既有管线 maybeRunImpression("compaction", { force, followUp })',
  /void maybeRunImpression\('compaction', \{ force: true, followUp: true \}\)/.test(settleBody))
check('E3：三条守卫都在（探针态 / 用户关了自动总结 / 10 分钟去抖）',
  settleBody.includes('if (FAKE_COMPACTION)') &&
  settleBody.includes('if (impressionEveryHours() === 0)') &&
  /COMPACTION_SETTLE_FLOOR_MS/.test(settleBody) &&
  /const COMPACTION_SETTLE_FLOOR_MS = 10 \* 60 \* 1000/.test(HOST))
check('E4：不写旧后端的 reflectionTrigger（只在注释里提到，代码里零赋值）',
  (HOST.match(/reflectionTrigger/g) ?? []).length === 1 &&
  (HOST.match(/reflection_trigger/g) ?? []).length === 0)
check('E5（反向对照）：不 await —— 这条链路要几分钟，不能卡住 delta 分发',
  /\/\/ 不 await/.test(settleBody) && /void maybeRunImpression/.test(settleBody))

/* ── F. 探针注入点（真压缩要 ~98 万 tokens，本机造不出来）──────────────── */
console.log('')
console.log('## F. ORB_FAKE_COMPACTION 注入点')
check('F1：开关只认 ORB_FAKE_COMPACTION=1',
  /const FAKE_COMPACTION = process\.env\.ORB_FAKE_COMPACTION === '1'/.test(HOST))
const readyBody = slice(HOST, 'function onLegacyReady() {', '\nfunction pushLegacyEndpoint()', 'onLegacyReady')
check('F2：onLegacyReady 里条件注入（此时 socket 已鉴权）',
  /if \(FAKE_COMPACTION\) injectFakeCompaction\(\)/.test(readyBody))
const fakeBody = slice(HOST, 'function injectFakeCompaction() {', '\nfunction onDelta', 'fake')
check('F3：注入的是完整两段（event_message + summary_message，带 compaction_stats）',
  /message_type: 'event_message'/.test(fakeBody) && /event_type: 'compaction'/.test(fakeBody) &&
  /message_type: 'summary_message'/.test(fakeBody) && /compaction_stats: \{/.test(fakeBody))
check('F4：探针态下跳过真实沉淀（别在探针里踢一次印象任务）',
  /if \(FAKE_COMPACTION\) \{[\s\S]{0,120}?压缩沉淀：ORB_FAKE_COMPACTION 探针态，跳过真实沉淀/.test(settleBody))

/* ── G. 主对话口径（固定不变 + 首条消息时恢复）────────────────────────── */
console.log('')
console.log('## G. 主对话挂回')
check('G1：config 有 mainConversations 槽（按模式分桶）',
  /mainConversations: \{\}/.test(HOST) && /config\.mainConversations\?\.\[forMode\]/.test(HOST))
check('G2：mainConversationOf 把空值/非法值归成 null',
  /const pinned = config\.mainConversations\?\.\[forMode\][\s\S]{0,120}?return typeof pinned === 'string' && pinned !== '' \? pinned : null/.test(HOST))
check('G3：rememberMainConversation 幂等 + 落盘（saveConfig）',
  /function rememberMainConversation\(forMode, sessionId\) \{[\s\S]{0,200}?mainConversationOf\(forMode\) === sessionId\) return false[\s\S]{0,300}?saveConfig\(\)/.test(HOST))
check('G4：「新对话」只在空位时认领主对话（用户口径：新对话不夺指针）',
  /function claimMainConversationIfEmpty\(forMode, sessionId\) \{[\s\S]{0,160}?if \(mainConversationOf\(forMode\)\) return false[\s\S]{0,80}?return rememberMainConversation\(forMode, sessionId\)/.test(HOST) &&
  /claimMainConversationIfEmpty\(mode, runtime\.conversation_id\)/.test(HOST))
check('G5：liveMainConversation 用前校验会话还在磁盘上（删过/换 agent 后别指向幽灵）',
  /function liveMainConversation\(forMode\) \{[\s\S]{0,600}?listConversations\(agentId\)\.some\(/.test(HOST))
check('G6：ensureRuntime 挂回主对话（首条消息才走到这里 —— 启动不白付 8~40 秒）',
  /resumedMainConversation = liveMainConversation\(mode\)/.test(HOST) &&
  /conversationId: resumedMainConversation/.test(HOST))
check('G7（反向对照）：ensureRuntime 的 startRuntime 里不再硬编码 conversationId: null',
  !/conversationId: null/.test(slice(HOST, 'async function ensureRuntime() {', '\n  const started = await runtimePromise', 'ensureRuntime')))
check('G8：挂回成功补一次历史回放；新建则立刻记成主对话',
  /if \(resumedMainConversation && readyConv === resumedMainConversation\) \{[\s\S]{0,160}?replayHistory\(readyConv\)[\s\S]{0,120}?\} else \{[\s\S]{0,120}?rememberMainConversation\(mode, readyConv\)/.test(HOST))
check('G9：挂回成功/失败都在日志里留痕（排障：她到底进了哪条会话）',
  /准备挂回主对话/.test(HOST) && /已挂回主对话/.test(HOST))

console.log('')
console.log(`${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
