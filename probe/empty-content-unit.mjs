/**
 * probe/empty-content-unit.mjs · 「模型只思考、正文为空」的兜底自检（无头、不打真 API）
 *
 * 背景（2026-10-22 真机事故）：
 *   一次回合的用量是「思考=1810 / 输出=1810」—— completion 预算全烧在 reasoning 上，
 *   content 一个 token 都没有。旧代码三处缺口让这一轮彻底静默：
 *     ① brain.mjs `if (assistantText.trim())` ⇒ 不落盘；
 *     ② main.mjs `if (text === '' && !blocks.has(...)) break` ⇒ 不建块；
 *     ③ llm.mjs 产出的 stopReason 无人消费 ⇒ 日志里只剩「思考==输出」这个巧合。
 *   球窗口什么都没收到，用户看到的只有「思考了 11 秒」加一次表情回落。
 *
 * 验的四条：
 *   1. 空正文回合**必须**产出 notice（内容带 finish_reason），失败可见；
 *   2. 空正文回合**必须**落一条 assistant 记录（保住 user/assistant 交替，下一轮不迷路）；
 *   3. done 事件必须带 stopReason 与 emptyContent=true（可观测性）；
 *   4. 正常回合不受影响：有正文就照旧落盘，且不发 notice。
 *
 * 跑法：`node probe\empty-content-unit.mjs`
 * 沙箱：`_sandbox-empty-content/`（每次跑前清空，不碰真实记忆仓）
 */

import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SANDBOX = join(ROOT, '_sandbox-empty-content')
const AGENT = 'empty-content-probe'

// ★ 必须在 import src/* 之前设：memory.mjs / session.mjs 都按 env 算数据根。
process.env.ORB_DATA = SANDBOX
process.env.ORB_LEGACY_DATA = SANDBOX

rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(SANDBOX, { recursive: true })

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const { createBrain } = await import('../src/brain.mjs')
const { createMemoryStore } = await import('../src/memstore.mjs')
const { createSettings } = await import('../src/settings.mjs')
const { createSnapshotService } = await import('../src/snapshot.mjs')
const { createSessionStore } = await import('../src/session.mjs')

const log = () => {}

/** 假 LLM：只吐给定脚本里的那几件事，然后 done。 */
function fakeLLM(events) {
  return {
    async* stream() {
      for (const e of events) yield e
    },
  }
}

const memstore = await createMemoryStore({ engine: 'local', root: ROOT, agentId: AGENT })
const settings = createSettings({ configPath: join(SANDBOX, 'config.json'), log })
const snapshot = createSnapshotService({ memstore, settings, log })
const sessionStore = createSessionStore({ agentId: AGENT })

function makeBrain(llmEvents) {
  return createBrain({
    llm: fakeLLM(llmEvents),
    memstore,
    persona: '你是球。',
    sessionStore,
    agentId: AGENT,
    settings,
    snapshot,
    log,
  })
}

/** 跑干一回合，收齐事件 */
async function runTurn(brain, sessionId, userText) {
  const seen = { assistant: [], notices: [], done: null }
  for await (const ev of brain.run({ sessionId, userText })) {
    if (ev.type === 'assistant') seen.assistant.push(ev.text)
    else if (ev.type === 'notice') seen.notices.push(ev.text)
    else if (ev.type === 'done') seen.done = ev
  }
  return seen
}

// ── 场景 1：只思考、零正文（复现事故）────────────────────────
const s1 = 'probe-empty-1'
const t1 = await runTurn(
  makeBrain([
    { type: 'reasoning', text: '他问的是三个修改点…先把顺序理清…' },
    {
      type: 'done',
      stopReason: 'stop',
      // 真机那一轮的数字：思考 1810，输出 1810，正文 0
      usage: { promptTokens: 17851, completionTokens: 1810, totalTokens: 19661, reasoningTokens: 1810 },
    },
  ]),
  s1,
  '好的，我现在确定了需要修改的三个地方',
)

check('空正文回合没有产出 assistant 正文事件', t1.assistant.length === 0, `events=${t1.assistant.length}`)
check(
  '空正文回合产出 notice（失败可见）',
  t1.notices.length === 1 && /只想了没说话/.test(t1.notices[0] ?? ''),
  t1.notices[0] ?? '(无)',
)
check('notice 里带着 finish_reason', /finish_reason=stop/.test(t1.notices[0] ?? ''), t1.notices[0] ?? '')
check('done 事件标记 emptyContent=true', t1.done?.emptyContent === true)
check('done 事件带上 stopReason', t1.done?.stopReason === 'stop', String(t1.done?.stopReason))

const recs1 = sessionStore.readMessages(s1)
check(
  '空正文回合落了一条 assistant 记录（保住 user/assistant 交替）',
  recs1.length === 2 && recs1[0].role === 'user' && recs1[1].role === 'assistant',
  recs1.map((m) => m.role).join(','),
)
check(
  '落盘的那条是占位文本，不是空串',
  typeof recs1[1]?.text === 'string' && recs1[1].text.includes('只想了没说话'),
  String(recs1[1]?.text ?? '').slice(0, 60),
)
check('落盘的 usage 仍在（钱要算得清）', recs1[1]?.usage?.reasoningTokens === 1810, String(recs1[1]?.usage?.reasoningTokens))

// ── 场景 2：正常回合，不能被这次改动碰到 ────────────────────
const s2 = 'probe-empty-2'
const t2 = await runTurn(
  makeBrain([
    { type: 'content', text: '好呀，我在。' },
    {
      type: 'done',
      stopReason: 'stop',
      usage: { promptTokens: 900, completionTokens: 12, totalTokens: 912, reasoningTokens: 5 },
    },
  ]),
  s2,
  '在吗',
)

check('正常回合照旧产出正文', t2.assistant.join('') === '好呀，我在。', t2.assistant.join(''))
check('正常回合不发 notice', t2.notices.length === 0, t2.notices.join('|'))
check('正常回合 done.emptyContent=false', t2.done?.emptyContent === false)

const recs2 = sessionStore.readMessages(s2)
check(
  '正常回合落盘的是原文，不是占位文本',
  recs2.length === 2 && recs2[1].role === 'assistant' && recs2[1].text === '好呀，我在。',
  String(recs2[1]?.text ?? ''),
)

// ── 场景 3：上游没给 finish_reason ──────────────────────────
const s3 = 'probe-empty-3'
const t3 = await runTurn(
  makeBrain([
    { type: 'done', usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, reasoningTokens: 0 } },
  ]),
  s3,
  '随便说点什么',
)
check(
  '没给 stopReason 时 notice 说明「未知」而不是编一个值',
  /finish_reason 未知/.test(t3.notices[0] ?? ''),
  t3.notices[0] ?? '(无)',
)
check('这份「未知」也落进了盘', sessionStore.readMessages(s3)[1]?.text?.includes('finish_reason 未知') === true)

// ── 汇总 ────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} PASS`)
if (failed.length) {
  console.log('FAILED:')
  for (const f of failed) console.log(`  - ${f.name} ${f.detail}`)
  process.exitCode = 1
}
rmSync(SANDBOX, { recursive: true, force: true })
