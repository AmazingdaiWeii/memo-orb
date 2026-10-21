/**
 * P1 验收（端到端）：**真模型**被要求查一件会变的事 → 回合内真的调 `search_web` → 正文带来源。
 *
 *   node probe/web-tools-e2e.mjs
 *
 * 与 `web-tools-unit.mjs` 的分工：
 *   - unit 打桩 LLM，验的是「工具处理器怎么解析参数、怎么处理失败」；
 *   - 这个验的是「她**会不会**去用」——设计原则 4 要的是「能查到就用」，而不是「模块能跑」。
 *
 * 沙箱 `_sandbox-data-web/` + 一次性 agentId；端口 25973。
 */
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { boot, ROOT_DIR } from './_gui-e2e.mjs'

const DATA = join(ROOT_DIR, '_sandbox-data-web')

const h = await boot({
  port: 25973,
  tag: 'orb-web-e2e',
  sandbox: '_sandbox-data-web',
  prepare: () => {
    // 联网配置在 dataRoot 里按需生成；每次从干净状态起，避免上次的坏配置影响判定
    for (const f of ['policy.json', 'schedule.json', 'wechat.json']) {
      try { rmSync(join(DATA, f), { force: true }) } catch { /* 本来没有 */ }
    }
    mkdirSync(join(DATA, 'workspace'), { recursive: true })
  },
})

const from = h.received.length
const t0 = Date.now()
h.send({
  type: 'prompt',
  text: '帮我在网上查一下今天有什么科技新闻。用 search_web 查，query 写关键词（别写整句），然后告诉我最相关的两三条标题和网址。',
})
const turn = await h.settleTurn(from, 240_000)
h.check('回合正常收口', turn.ok, turn.ok ? `全程 ${Date.now() - t0}ms` : '240 秒内没有 turn=false')

const blocks = h.lastByKey(h.blocksOf(from))
const toolBlocks = blocks.filter((b) => b.kind === 'tool')
const searched = toolBlocks.filter((b) => String(b.text) === 'search_web')
const parsed = searched.map((b) => h.parseResult(b)).filter(Boolean)

h.check('回合里真的调了 search_web（不是凭记忆答）', searched.length > 0,
  searched.length ? `${searched.length} 次：${searched.map((b) => b.key).join(', ')}` : `工具块=${toolBlocks.map((b) => b.text).join(',') || '无'}`)
h.check('search_web 都已收口（running=false）', searched.length > 0 && searched.every((b) => b.running === false),
  searched.map((b) => `running=${b.running}`).join(','))
h.check('search_web 成功且真拿到结果', parsed.some((r) => r.ok === true && Array.isArray(r.results) && r.results.length > 0),
  parsed.length ? `ok=${parsed.map((r) => r.ok).join(',')} 条数=${parsed.map((r) => r.results?.length ?? 0).join(',')}` : '没有可解析的结果')

const text = blocks.filter((b) => b.kind === 'assistant').map((b) => String(b.text ?? '')).join('\n').trim()
h.check('正文里有回复', text.length > 0, text.replace(/\n/g, ' ').slice(0, 120))
h.check('正文给了来源（网址或「来源/出处」）', /https?:\/\//.test(text) || /来源|出处|据.{0,6}(报道|消息)/.test(text),
  text.replace(/\n/g, ' ').slice(0, 160))
h.check('日志里有 search_web 的查询与条数', /\[brain\] search_web ".+?" → (\d+ 条|失败)/.test(h.tailLog()),
  (h.lastMatch(/\[brain\] search_web .+/) ?? ['（没有）'])[0])
h.check('没有未捕获异常', !/未捕获|uncaughtException|Uncaught/.test(h.tailLog()))
h.check('agentId 是本探针的一次性 id', h.agent.startsWith('orb-web-e2e-'), h.agent)

h.finish()
