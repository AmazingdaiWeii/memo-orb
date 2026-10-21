/**
 * P3 验收（端到端）：**真模型**被要求「5 秒后提醒我」→ 工具真的排上 → 到点宿主自己说出口。
 *
 *   node probe/schedule-e2e.mjs
 *
 * 与 `schedule-unit.mjs` 的分工：
 *   - unit 验 parser / 存储 / 迟到边界（71 条断言，不启动 Electron）；
 *   - 这个验的是链路：模型肯调 `set_reminder` → `data/schedule.json` 真有这条 →
 *     30 秒心跳把它捞出来 → 球上真的冒出一条**不是回合回复**的正文（key 形如 `a:rem-<id>`）
 *     → `firedAt` 落盘（重启不会重播）。
 *
 * 沙箱 `_sandbox-data-sch/` + 一次性 agentId；端口 25974。
 */
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { boot, sleep, ROOT_DIR } from './_gui-e2e.mjs'

const DATA = join(ROOT_DIR, '_sandbox-data-sch')
const STORE = join(DATA, 'schedule.json')

const h = await boot({
  port: 25974,
  tag: 'orb-sch-e2e',
  sandbox: '_sandbox-data-sch',
  prepare: () => {
    for (const f of ['policy.json', 'schedule.json', 'wechat.json']) {
      try { rmSync(join(DATA, f), { force: true }) } catch { /* 本来没有 */ }
    }
    mkdirSync(join(DATA, 'workspace'), { recursive: true })
  },
})

const readStore = () => {
  try { return JSON.parse(readFileSync(STORE, 'utf8')) } catch { return null }
}

const from = h.received.length
const t0 = Date.now()
h.send({
  type: 'prompt',
  text: '帮我设个提醒：5 秒后提醒我喝水。用 set_reminder，when 写 +5s，what 写成一句能直接说出口的话。',
})
const turn = await h.settleTurn(from, 180_000)
h.check('回合正常收口', turn.ok, turn.ok ? `全程 ${Date.now() - t0}ms` : '180 秒内没有 turn=false')

const blocks = h.lastByKey(h.blocksOf(from))
const tools = blocks.filter((b) => b.kind === 'tool')
const setBlocks = tools.filter((b) => String(b.text) === 'set_reminder')
h.check('回合里真的调了 set_reminder', setBlocks.length > 0,
  setBlocks.length ? setBlocks.map((b) => b.key).join(', ') : `工具块=${tools.map((b) => b.text).join(',') || '无'}`)

// 存储层：这条必须真的落盘（不是只在回复里答应一句）
await sleep(500)
const store = readStore()
const items = Array.isArray(store?.items) ? store.items : []
h.check('data/schedule.json 里真有一条', items.length === 1,
  items.length ? `id=${items[0].id} at=${items[0].at} text=${String(items[0].text).slice(0, 40)}` : `文件${existsSync(STORE) ? '存在但没条目' : '不存在'}`)
h.check('那一条还没触发（firedAt=null）', items.length === 1 && items[0].firedAt === null,
  items[0] ? `firedAt=${items[0].firedAt}` : '无条目')

// 到点：心跳 30 秒对一次表，所以最坏要等 ~35 秒。
// ★ 球侧收到的 key 带会话前缀（`local-<agentId>|a:rem-<id>`），所以按「包含」判，不能按开头判。
const remId = items[0]?.id ?? null
const isRemBlock = (m) => m.type === 'block' && String(m.key ?? '').includes('a:rem-')
const fired = await h.waitForNew(from, isRemBlock, 90_000)
h.check('到点真的在球上冒出一条（不是回合回复）', Boolean(fired),
  fired ? `key=${fired.key} 用时 ${Date.now() - t0}ms` : '90 秒内没有 a:rem-* 正文块')
h.check('冒出来的 key 对得上那条提醒',
  Boolean(fired) && Boolean(remId) && String(fired.key).endsWith(`a:rem-${remId}`),
  fired ? `key=${fired.key} 期望以 a:rem-${remId} 结尾` : '没冒出来')
const remText = String(fired?.text ?? '').trim()
h.check('那条正文不是空话（就是要他喝水这件事）', remText.length > 0 && /水|喝/.test(remText),
  remText.slice(0, 120) || '（空）')

// 已经说过 → firedAt 落盘，重启不会重播
const after = readStore()
const it = after?.items?.find((x) => x.id === remId)
h.check('说过之后 firedAt 已落盘（不会重播）', Boolean(it?.firedAt), it ? `firedAt=${it.firedAt}` : '条目不见了')
h.check('日志里有「闹钟播出」', /闹钟播出 /.test(h.tailLog()),
  (h.lastMatch(/闹钟播出 .+/) ?? ['（没有）'])[0])
h.check('没有未捕获异常', !/未捕获|uncaughtException|Uncaught/.test(h.tailLog()))
h.check('agentId 是本探针的一次性 id', h.agent.startsWith('orb-sch-e2e-'), h.agent)

h.finish()
