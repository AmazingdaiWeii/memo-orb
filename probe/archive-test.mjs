/**
 * 记忆归档器单测 —— **纯逻辑，不起 Letta、不碰真实记忆仓**。
 *
 * 依赖全部注入（见 `src/archive.mjs` 的 `createArchiver`），所以这里能：
 *   · 用假 mtime 精确控制「静默期」边界；
 *   · 用假 `request` 断言「到底发了什么、发了几次」；
 *   · 造出「她改了但没提交」的场景，验其被兜底。
 *
 * 跑法：node probe/archive-test.mjs
 */

import { createArchiver, isArchivable, ARCHIVE_ALLOW, ARCHIVE_QUIET_MS } from '../src/archive.mjs'

let pass = 0
let fail = 0
const failures = []

function check(label, cond, extra = '') {
  if (cond) { pass += 1; console.log(`✅ ${label}${extra ? `   ${extra}` : ''}`) }
  else { fail += 1; failures.push(label); console.log(`❌ ${label}${extra ? `   ${extra}` : ''}`) }
}
function note(label, value) { console.log(`·  ${label}   ${value}`) }
function section(t) { console.log(`\n=== ${t} ===`) }

/** 造一个受控的 world。 */
function makeWorld({ files = [], quietMs = ARCHIVE_QUIET_MS, floorMs = 0 } = {}) {
  const logLines = []
  const requests = []
  // files: [{path, content, ageMs}]  ageMs = 距现在多久没被动过
  const world = {
    logLines,
    requests,
    files,
    // ⚠️ 必须用**真实** `Date.now()`：归档器内部 `run()` 取的是 `Date.now()`，
    //    测试若冻一个假时钟，两边的基准就错开了（踩过：age 被算成 6e10 ms）。
    //    这里只在「构造 mtime」时用同一个真实基准。
    readMemoryFile(_agentId, relPath) {
      const f = files.find((x) => x.path === relPath)
      if (!f) return null
      return { content: f.content, mtimeMs: Date.now() - f.ageMs }
    },
    listMemory() { return { files: files.map((f) => ({ path: f.path, updatedAt: new Date(Date.now() - f.ageMs).toISOString() })) } },
    async request(type, payload) {
      requests.push({ type, payload })
      // 默认模型：有 diff（即被当成脏改动）就提交成功
      const f = files.find((x) => x.path === payload.path)
      const committed = f ? f.dirty !== false : false
      return { success: true, committed, commit_sha: committed ? 'a'.repeat(40) : undefined }
    },
  }
  return world
}

function mkArchiver(world, opts = {}) {
  return createArchiver({
    log: (m) => world.logLines.push(m),
    request: world.request,
    readMemoryFile: world.readMemoryFile,
    listMemory: world.listMemory,
    ...opts,
  })
}

// ─────────────────────────────────────────────
section('1. 白名单：只归档印象那条链路')

check('about/印象.md 在范围内', isArchivable('about/印象.md') === true)
check('about/ 下她自建的文件在范围内', isArchivable('about/2026-10-07.md') === true)
check('about/MEMORY.md 不在范围内（host 写的目录索引，自带 commit）', isArchivable('about/MEMORY.md') === false)
check('MEMORY.md 不在范围内（基线不许动）', isArchivable('MEMORY.md') === false)
check('persona 不在范围内', isArchivable('persona.md') === false)
check('.git/config 不在范围内', isArchivable('.git/config') === false)
check('反斜杠路径也归一化', isArchivable('about\\印象.md') === true)
check('.. 穿越被拒', isArchivable('about/../MEMORY.md') === false)
check('about/ 本身（目录）不算文件', isArchivable('about/') === false)
check('空字符串被拒', isArchivable('') === false)
note('ARCHIVE_ALLOW =', JSON.stringify(ARCHIVE_ALLOW))

// ─────────────────────────────────────────────
section('2. 静默期：文件刚被改过就不能提交')

{
  const world = makeWorld({
    files: [
      { path: 'about/印象.md', content: '刚写的', ageMs: 500 },      // 500ms 前 → 太新
    ],
  })
  const a = mkArchiver(world)
  const r = await a.run('agent-x', { reason: 'test', force: true })
  check('太新的文件不提交', world.requests.length === 0, `请求数 ${world.requests.length}`)
  check('返回值标 skipped', r.skipped === 'nothing-pending', r.skipped)
  check('hot 计数 = 1（改过但还热着）', r.hot === 1, `hot=${r.hot}`)
}

{
  const world = makeWorld({
    files: [{ path: 'about/印象.md', content: '安静了', ageMs: ARCHIVE_QUIET_MS + 1 }],
  })
  const a = mkArchiver(world)
  const r = await a.run('agent-x', { reason: 'test', force: true })
  check('过了静默期就提交', world.requests.length === 1, `请求数 ${world.requests.length}`)
  check('committed = 1', r.committed === 1, `committed=${r.committed}`)
  check('发的是 write_memory_file', world.requests[0]?.type === 'write_memory_file')
  check('带 agent_id', world.requests[0]?.payload?.agent_id === 'agent-x')
  check('带 path', world.requests[0]?.payload?.path === 'about/印象.md')
  check('内容是原样（不加工）', world.requests[0]?.payload?.content === '安静了')
  check('commit message 标明 host 归档', /host 归档/.test(String(world.requests[0]?.payload?.commit_message)), String(world.requests[0]?.payload?.commit_message))
  check('commit message 带 reason', /test/.test(String(world.requests[0]?.payload?.commit_message)))
}

// ─────────────────────────────────────────────
section('3. 幂等：没 diff 就不产生 commit')

{
  const world = makeWorld({
    files: [{ path: 'about/印象.md', content: '没变', ageMs: 60_000, dirty: false }],
  })
  const a = mkArchiver(world)
  const r = await a.run('agent-x', { reason: 'test', force: true })
  check('请求发了（要问 git 有没有 diff）', world.requests.length === 1)
  check('但 committed = 0', r.committed === 0, `committed=${r.committed}`)
  check('skipped = no-diff', r.skipped === 'no-diff', r.skipped)
}

// ─────────────────────────────────────────────
section('4. 节流：同一时刻不重复跑（但主路径不受限）')

{
  const world = makeWorld({
    files: [{ path: 'about/印象.md', content: 'x', ageMs: 60_000 }],
  })
  const a = mkArchiver(world, { floorMs: 5 * 60 * 1000 })
  // 用非主路径（'idle'）测节流
  const r1 = await a.run('agent-x', { reason: 'idle' })
  const r2 = await a.run('agent-x', { reason: 'idle' })
  check('第一次跑（没有节流记录）', r1.skipped !== 'throttled', `skipped=${r1.skipped}`)
  check('第二次被节流', r2.skipped === 'throttled', `skipped=${r2.skipped}`)
  check('总共只发了 1 次请求', world.requests.length === 1, `请求数 ${world.requests.length}`)
  a.resetFloor()
  const r3 = await a.run('agent-x', { reason: 'idle' })
  check('resetFloor 后可以再跑', r3.skipped !== 'throttled', `skipped=${r3.skipped}`)
  check('总共 2 次请求', world.requests.length === 2, `请求数 ${world.requests.length}`)
}

{
  const world = makeWorld({ files: [{ path: 'about/印象.md', content: 'x', ageMs: 60_000 }] })
  const a = mkArchiver(world, { floorMs: 5 * 60 * 1000 })
  await a.run('agent-x', { reason: 'idle' })
  const rForce = await a.run('agent-x', { reason: 'idle', force: true })
  check('force 绕过节流', rForce.skipped !== 'throttled', `skipped=${rForce.skipped}`)
  check('force 真的发了请求', world.requests.length === 2, `请求数 ${world.requests.length}`)
}

{
  // ★ 主路径不受节流限制 —— 踩过的真 bug：一个非主路径的触发先吃掉额度，
  //   12 秒后真正的 turn-end 被节流掉，她这一回合写的记忆要等下一回合才归档。
  //   （现在 `memory_updated` 已不再触发归档，但节流的这条边界仍要守住 ——
  //     未来再加非主路径触发时不能再踩。）
  const world = makeWorld({ files: [{ path: 'about/印象.md', content: 'x', ageMs: 60_000 }] })
  const a = mkArchiver(world, { floorMs: 5 * 60 * 1000 })
  await a.run('agent-x', { reason: 'some-future-trigger' })     // 先跑一次，吃掉额度
  const r1 = await a.run('agent-x', { reason: 'turn-end' })      // 主路径
  check('★ turn-end 不被别人吃掉的额度饿死', r1.skipped !== 'throttled', `skipped=${r1.skipped}`)
  check('★ turn-end 真的跑了', world.requests.length === 2, `请求数 ${world.requests.length}`)
  const r2 = await a.run('agent-x', { reason: 'ready' })         // ready 也是主路径
  check('★ ready 同样不受限', r2.skipped !== 'throttled', `skipped=${r2.skipped}`)
  check('★ ready 真的跑了', world.requests.length === 3, `请求数 ${world.requests.length}`)
}

{
  // 没有脏文件时，连节流都不用看 —— 直接 return，省掉记账
  const world = makeWorld({ files: [{ path: 'about/印象.md', content: 'x', ageMs: 100 }] })
  const a = mkArchiver(world, { floorMs: 5 * 60 * 1000 })
  const r1 = await a.run('agent-x', { reason: 'idle' })
  const r2 = await a.run('agent-x', { reason: 'turn-end' })
  check('没脏文件时两次都是 nothing-pending（不是 throttled）',
    r1.skipped === 'nothing-pending' && r2.skipped === 'nothing-pending',
    `${r1.skipped} / ${r2.skipped}`)
  check('一次请求都没发', world.requests.length === 0, `请求数 ${world.requests.length}`)
}

// ─────────────────────────────────────────────
section('5. 防重入：并发调用只跑一轮')

{
  const world = makeWorld({ files: [{ path: 'about/印象.md', content: 'x', ageMs: 60_000 }] })
  // 让 request 挂住，模拟慢 git
  let release
  const gate = new Promise((res) => { release = res })
  const origReq = world.request
  world.request = async (type, payload) => { await gate; return origReq(type, payload) }
  const a = mkArchiver(world, { floorMs: 0 })
  const p1 = a.run('agent-x', { reason: 'one', force: true })
  const p2 = a.run('agent-x', { reason: 'two', force: true })
  release()
  const [r1, r2] = await Promise.all([p1, p2])
  check('两个并发调用都返回', r1 && r2)
  check('只发了 1 次请求（第二个复用了 in-flight）', world.requests.length === 1, `请求数 ${world.requests.length}`)
}

// ─────────────────────────────────────────────
section('6. 容错：请求抛异常不外抛')

{
  const world = makeWorld({ files: [{ path: 'about/印象.md', content: 'x', ageMs: 60_000 }] })
  world.request = async () => { throw new Error('git index locked') }
  const a = mkArchiver(world, { floorMs: 0 })
  let threw = null
  let r = null
  try { r = await a.run('agent-x', { reason: 'x', force: true }) } catch (e) { threw = e }
  check('异常被吞掉（不外抛）', threw === null, threw ? String(threw.message) : '')
  check('返回 committed=0', r?.committed === 0, `committed=${r?.committed}`)
  check('日志里留了痕', world.logLines.some((l) => /失败（下一轮重试）/.test(l)))
}

{
  const world = makeWorld({ files: [{ path: 'about/印象.md', content: 'x', ageMs: 60_000 }] })
  world.listMemory = () => { throw new Error('ENOENT') }
  const a = mkArchiver(world, { floorMs: 0 })
  let threw = null
  try { await a.run('agent-x', { reason: 'x', force: true }) } catch (e) { threw = e }
  check('listMemory 崩了也不外抛', threw === null, threw ? String(threw.message) : '')
}

// ─────────────────────────────────────────────
section('7. 真场景：她改了但没提交 → 被兜底')

{
  // 模拟实测遇到的情况：印象正文被改，mtime 是 34 分钟前，没有新 commit
  const world = makeWorld({
    files: [
      { path: 'about/印象.md', content: '# 印象\n\n她今天提到在做一个桌面助手。', ageMs: 2058 * 1000 },
      { path: 'about/MEMORY.md', content: '# 关于', ageMs: 3 * 86400 * 1000 },
      { path: 'MEMORY.md', content: '# 基线（不该被动）', ageMs: 60_000 },
    ],
  })
  const a = mkArchiver(world, { floorMs: 0 })
  const r = await a.run('agent-x', { reason: 'turn-end', force: true })
  check('只提交了印象文件', world.requests.length === 1, `请求数 ${world.requests.length}`)
  check('提交的正是 about/印象.md', world.requests[0]?.payload?.path === 'about/印象.md')
  check('MEMORY.md 没被碰', !world.requests.some((q) => q.payload?.path === 'MEMORY.md'))
  check('committed = 1', r.committed === 1)
  note('归档后 revision 前进 ⇒ 下一轮后端自动注入 <memory_update>', '（无需额外触发重编译）')
}

// ─────────────────────────────────────────────
console.log(`\n${'='.repeat(52)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail > 0) { console.log(`失败项：\n  - ${failures.join('\n  - ')}`); process.exit(1) }
