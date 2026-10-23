/**
 * probe/memory-patch-unit.mjs · patch_memory / memory_batch 的单元验收
 *
 * 原则（本项目踩过"假健康"）：**import 产品函数，不复刻逻辑**。
 * 所以这里测的是 `memstore-local.mjs` 的 applyEdits / patch()、
 * `brain.mjs` 的 executeTool、`snapshot.mjs` 的 buildToolGuide —— 全是真代码。
 *
 * 全程在一个**临时 ORB_DATA** 里跑，不碰真实记忆仓。
 * 运行：node probe/memory-patch-unit.mjs
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// ★ 必须在 import 产品模块之前设好数据根
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'orb-probe-patch-'))
process.env.ORB_DATA = TMP_ROOT
process.env.ORB_LEGACY_DATA = TMP_ROOT

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log('  PASS  ' + m) }
const no = (m, extra) => { fail++; console.log('  FAIL  ' + m + (extra ? '\n         → ' + extra : '')) }

const { applyEdits, PATCH_MIN_OLD } = await import('../src/memstore-local.mjs')
const { createMemoryStore } = await import('../src/memstore.mjs')
const { executeTool, buildTools } = await import('../src/brain.mjs')
const { buildToolGuide, GUIDE_VERSION } = await import('../src/snapshot.mjs')

// ── 0. 纯逻辑：applyEdits ────────────────────────────────
console.log('\n[0] 片段替换纯逻辑（无 IO）')
const DOC = [
  '# 记忆',
  '',
  '## 关于他',
  '- 河南三门峡，1994 年生',
  '- 喜欢冰美式，不加糖',
  '- 讨厌香菜',
  '',
  '## 我们之间',
  '- 叫我用户',
  '- 喜欢冰美式，不加糖',
  '',
].join('\n')

let r = applyEdits(DOC, [{ old: '河南三门峡，1994 年生', new: '河南三门峡，94 年生' }])
r.ok && r.applied.length === 1 && r.applied[0].line === 4
  ? ok('唯一匹配 → 替换成功且行号正确')
  : no('唯一匹配', JSON.stringify(r).slice(0, 160))

r = applyEdits(DOC, [{ old: '喜欢冰美式，不加糖', new: '喜欢美式' }])
!r.ok && /命中 2 次/.test(r.error) && r.detail?.occurrences?.length === 2
  ? ok('多处命中 → 拒绝并报两处行号')
  : no('多处命中', JSON.stringify(r).slice(0, 160))

r = applyEdits(DOC, [{ old: '他喜欢冰美式不加糖', new: 'x' }])
!r.ok && r.detail?.closest?.length > 0 && /冰美式/.test(r.detail.closest[0].text)
  ? ok('找不到 → 回盘上最接近的真实行（不让她凭记忆猜）')
  : no('找不到时的兜底', JSON.stringify(r).slice(0, 160))

r = applyEdits(DOC, [{ old: '冰美', new: 'x' }])
!r.ok && /太短/.test(r.error) ? ok(`old 短于 ${PATCH_MIN_OLD} 字 → 拒绝`) : no('old 过短未拦')

r = applyEdits(DOC, [{ old: '河南三门峡', new: '三门峡' }, { old: '根本没有这一段呀', new: 'x' }])
!r.ok && r.next === undefined ? ok('第 2 处失败 → 整次不生效（无部分替换）') : no('原子性')

r = applyEdits(DOC, [{ old: '- 讨厌香菜\n', new: '' }])
r.ok && !r.next.includes('讨厌香菜') ? ok('new 给空串 = 删除该段') : no('删除语义')

// ── 1. memstore 层：真实 git 仓库 ────────────────────────
console.log('\n[1] memstore.patch()（真 git 仓库，临时目录）')
const mem = await createMemoryStore({ engine: 'local', root: TMP_ROOT, agentId: 'probe' })
const REPO = join(TMP_ROOT, 'memfs', 'probe', 'memory')
const MEM = join(REPO, 'MEMORY.md')
const disk = () => readFileSync(MEM, 'utf8')

function commits() {
  const g = spawnSync('git', ['-C', REPO, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' })
  return g.status === 0 ? Number(g.stdout.trim()) : 0
}

await mem.write('MEMORY.md', DOC, 'probe')

let n0 = commits()
r = await mem.patch('MEMORY.md', [{ old: '讨厌香菜', new: '讨厌香菜（但他自己吃）' }], 'tool')
r.ok && disk().includes('讨厌香菜（但他自己吃）') && commits() === n0 + 1
  ? ok('patch 落盘并**只产生 1 个提交**')
  : no('patch 落盘/提交数', `ok=${r.ok} commits ${n0}→${commits()}`)

n0 = commits()
const before = disk()
r = await mem.patch('MEMORY.md', [{ old: '喜欢冰美式，不加糖', new: 'x' }])
!r.ok && disk() === before && commits() === n0
  ? ok('歧义 patch 被拒 → 文件字节不变、无新提交')
  : no('歧义 patch 竟然改动了文件')

r = await mem.patch('MEMORY.md', [{ old: '讨厌香菜', new: '随便什么' }], 'tool', { expectHash: 'deadbeef' })
!r.ok && /版本对不上/.test(r.error) ? ok('expectHash 不匹配 → 拒绝') : no('乐观锁未生效')

const h = (await mem.patch('MEMORY.md', [{ old: '叫我用户', new: '叫我用户' }], 'tool')).hash
r = await mem.patch('MEMORY.md', [{ old: '叫我用户', new: '叫我用户呀' }], 'tool', { expectHash: h })
r.ok ? ok('expectHash 匹配 → 放行') : no('正确 hash 反被拒', r.error)

n0 = commits()
r = await mem.patch('MEMORY.md', [{ old: '叫我用户呀', new: '叫我用户啊' }], 'tool', { dryRun: true })
r.ok && r.dryRun && commits() === n0 && disk().includes('叫我用户呀')
  ? ok('dryRun → 只预演不落盘')
  : no('dryRun 竟然写了盘')

r = await mem.patch('MEMORY.md', [{ old: '叫我用户呀', new: 'x'.repeat(9000) }], 'tool', { maxBytes: 4096 })
!r.ok && /超过上限/.test(r.error) ? ok('maxBytes 超限 → 拒绝（不写超 4KB 的常驻记忆）') : no('体积上限未拦')

r = await mem.patch('不存在的文件.md', [{ old: '一二三四', new: 'x' }])
!r.ok && !existsSync(join(REPO, '不存在的文件.md')) ? ok('文件不存在 → 拒绝且不凭空创建') : no('凭空创建了文件')

// ── 2. executeTool 层：真工具分支 ───────────────────────
console.log('\n[2] executeTool 分支（patch_memory / memory_batch）')
const settings = { get: () => ({ memorySoftLimitBytes: 4096 }) }
const base = {
  memstore: mem, settings, log: () => {}, approve: async () => ({ approved: true }),
  web: false, policy: null, schedule: null, now: Date.now,
}
const call = async (name, args) => JSON.parse(await executeTool({ name, args }, base))
const realLine = (kw) => disk().split('\n').find((l) => l.includes(kw))

// 2.1 成功路径：old 取自盘上真实内容
const target = realLine('河南三门峡')
r = await call('patch_memory', { path: 'MEMORY.md', edits: [{ old: target, new: '- 河南三门峡（豫西）' }] })
r.ok && /改了 1 处/.test(r.message) && disk().includes('河南三门峡（豫西）')
  ? ok('patch_memory 成功：回执含"改了几处"，盘上已变')
  : no('patch_memory 成功路径', JSON.stringify(r).slice(0, 200))

// 2.2 关键防幻觉：old 记错了 → 拒绝 + 回真实行
r = await call('patch_memory', { path: 'MEMORY.md', edits: [{ old: '- 河南三门峡（豫西）1994 年出生', new: 'x' }] })
r.ok === false && r.detail?.closest?.length > 0 && r.detail.closest[0].text.includes('河南三门峡（豫西）')
  ? ok('old 记错 → 拒绝，并把盘上真实行回给她（防幻觉的核心）')
  : no('失败回执缺真实内容', JSON.stringify(r).slice(0, 200))

// 2.3 完全不搭的 old 也必须拒绝，不能顺手改
r = await call('patch_memory', { path: 'MEMORY.md', edits: [{ old: 'zzz 完全没有这段 zzz', new: 'x' }] })
r.ok === false ? ok('完全对不上的 old → 拒绝（绝不猜着改）') : no('对不上的 old 竟然成功')

r = await call('patch_memory', { path: 'MEMORY.md' })
r.ok === false && /edits 必填/.test(r.error) ? ok('缺 edits → 明确报错') : no('缺 edits 未拦')

// 2.4 memory_batch 成功路径（append + patch 混合）
n0 = commits()
const curName = realLine('叫我用户')
r = await call('memory_batch', {
  ops: [
    { op: 'append', text: '今天他自己把记忆接口改了。', kind: 'fact' },
    { op: 'patch', path: 'MEMORY.md', edits: [{ old: curName, new: '- 叫我用户' }] },
  ],
})
const journalPath = r.applied?.find((a) => a.op === 'append')?.path
r.ok && r.count === 2 && journalPath && readFileSync(join(REPO, journalPath), 'utf8').includes('他自己把记忆接口改了')
  ? ok('memory_batch 混合 op 全部生效（journal + 常驻记忆）')
  : no('memory_batch 成功路径', JSON.stringify(r).slice(0, 220))

// 2.5 原子性：第 1 个 op 预演失败 → 第 2 个 append 也不能落地
const journalBefore = journalPath ? readFileSync(join(REPO, journalPath), 'utf8') : ''
r = await call('memory_batch', {
  ops: [
    { op: 'patch', path: 'MEMORY.md', edits: [{ old: '不存在的段落啊啊', new: 'x' }] },
    { op: 'append', text: '不该被写进去的一条' },
  ],
})
const journalAfter = journalPath ? readFileSync(join(REPO, journalPath), 'utf8') : ''
!r.ok && Array.isArray(r.applied) && r.applied.length === 0 && journalAfter === journalBefore
  ? ok('预演失败 → 整批不落盘（append 也没写）')
  : no('预演失败仍有 op 落盘', JSON.stringify(r).slice(0, 220))

r = await call('memory_batch', { ops: [{ op: '瞎写的op' }] })
!r.ok && /只支持/.test(r.error) ? ok('未知 op → 拒绝并说明支持哪些') : no('未知 op 未拦')

r = await call('memory_batch', { ops: [] })
!r.ok ? ok('空 ops → 拒绝') : no('空 ops 未拦')

r = await call('memory_batch', { ops: [{ op: 'write', path: 'MEMORY.md', content: 'x'.repeat(9000) }] })
!r.ok && /超过上限/.test(r.error) ? ok('write 超过常驻上限 → 整批拒绝') : no('write 上限未拦')

// ── 3. 静态断言：注册与指南 ──────────────────────────────
console.log('\n[3] 工具注册与指南一致性')
const names = buildTools({ web: false }).map((t) => t.function.name)
names.includes('patch_memory') ? ok('buildTools 含 patch_memory') : no('patch_memory 未注册')
names.includes('memory_batch') ? ok('buildTools 含 memory_batch') : no('memory_batch 未注册')

const guide = buildToolGuide({ web: true })
guide.includes('patch_memory') ? ok('指南提到 patch_memory') : no('指南没提 patch_memory（她会不知道有这东西）')
!guide.includes('不确定文件里写了什么就用 read_memory 看一眼再改')
  ? ok('指南已移除"改前必读"的诱导（冗余 read 的根因）')
  : no('旧诱导句还在')
guide.includes('不要因为匹配不上就改用 write_memory')
  ? ok('指南写死"匹配失败别整份重写"（幻觉主入口已堵）')
  : no('缺"别整份重写"的约束')
guide.includes('memory_batch') ? ok('指南提到 memory_batch 一次收口') : no('指南没提 memory_batch')

GUIDE_VERSION >= 18 ? ok(`GUIDE_VERSION = ${GUIDE_VERSION}（≥18，老会话会重建）`) : no(`GUIDE_VERSION 仍是 ${GUIDE_VERSION}`)

// ── 收尾 ────────────────────────────────────────────────
rmSync(TMP_ROOT, { recursive: true, force: true })
console.log(`\n== ${pass} PASS / ${fail} FAIL ==`)
process.exit(fail ? 1 : 0)
