/**
 * 审批通道 + 工作区文件工具的**无头**自检（不需要 GUI）。
 *
 *   node probe/approval-unit.mjs
 *
 * 只验两件事，但都是硬骨头：
 *   1. `createApprovalBroker` 的**每一条路径都会 resolve**（P1）——
 *      超时 / 断线 / 取消 / 没人连 / 已有挂起，全部必须是「拒绝」而不是
 *      永远挂着（历史上「确认框弹不出来」就是挂着，回合不收口）。
 *   2. `workspace.mjs` 的路径夹逼真的挡得住（`..`、绝对路径、盘符、反斜杠）
 *      —— 用户拍板的边界是「只能碰 data/workspace/」。
 *
 * 沙箱数据根：`_sandbox-approval/`，跑之前删掉即可从零开始。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SANDBOX = join(ROOT, '_sandbox-approval')
rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(SANDBOX, { recursive: true })
process.env.ORB_DATA = SANDBOX

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log(`  PASS  ${name}${extra ? `  ${extra}` : ''}`) } else { fail += 1; console.log(`  FAIL  ${name}${extra ? `  ${extra}` : ''}`) }
}

const { createApprovalBroker } = await import('../src/approval.mjs')
const ws = await import('../src/workspace.mjs')

// ---------------------------------------------------------------- 审批 broker
console.log('\n[1] approval: 没连上就立刻拒（P2）')
{
  let sent = 0
  const b = createApprovalBroker({ send: () => { sent += 1 }, isConnected: () => false })
  const t0 = Date.now()
  const v = await b.ask({ toolName: 'read_file', args: { path: 'a.md' } })
  const ms = Date.now() - t0
  check('立刻返回 approved=false', v.approved === false, `${ms}ms ${v.reason}`)
  check('一张卡都没发', sent === 0, `sent=${sent}`)
  check('没留挂起', b.pendingCount() === 0)
}

console.log('\n[2] approval: 点「允许」→ approved=true，且卡片被收回')
{
  const out = []
  const b = createApprovalBroker({ send: (o) => out.push(o), isConnected: () => true })
  const p = b.ask({ toolName: 'write_file', args: { path: 'notes/a.md', content: '你好' } })
  const q = out.find((o) => o.type === 'question')
  check('发出 question 卡', Boolean(q), q ? `id=${q.id}` : '')
  const card = q?.questions?.[0]
  check('卡片字段齐全', Boolean(card?.header && card?.question && card?.detail && Array.isArray(card?.options) && card.options.length === 2))
  check('有「允许」选项', card?.options?.[0]?.label?.startsWith('允许') === true, card?.options?.[0]?.label)
  check('挂起 1 条', b.pendingCount() === 1)
  b.answer(q.id, [{ id: 'q1', selected: [card.options[0].label] }])
  const v = await p
  check('approved=true', v.approved === true, v.reason)
  check('发了 question-clear', out.some((o) => o.type === 'question-clear' && o.id === q.id))
  check('挂起清空', b.pendingCount() === 0)
  check('重复 answer 返回 false', b.answer(q.id, []) === false)
}

console.log('\n[3] approval: 点「拒绝」/ 关卡片 → approved=false')
{
  const out = []
  const b = createApprovalBroker({ send: (o) => out.push(o), isConnected: () => true })
  const p1 = b.ask({ toolName: 'list_dir', args: { path: '.' } })
  const id1 = out.find((o) => o.type === 'question').id
  b.answer(id1, [{ id: 'q1', selected: ['拒绝'] }])
  check('拒绝 → false', (await p1).approved === false)

  const p2 = b.ask({ toolName: 'list_dir', args: { path: '.' } })
  const id2 = out.filter((o) => o.type === 'question').at(-1).id
  b.cancel(id2)
  const v2 = await p2
  check('取消 → false', v2.approved === false, v2.reason)
}

console.log('\n[4] approval: 已有挂起时第二张直接被拒（P3，球侧卡片是单例）')
{
  const out = []
  const b = createApprovalBroker({ send: (o) => out.push(o), isConnected: () => true })
  const p1 = b.ask({ toolName: 'read_file', args: { path: 'a.md' } })
  const v2 = await b.ask({ toolName: 'read_file', args: { path: 'b.md' } })
  check('第二个 approved=false', v2.approved === false, v2.reason)
  check('只发了一张卡', out.filter((o) => o.type === 'question').length === 1)
  b.abort('测试收尾')
  check('abort 后第一个也收口', (await p1).approved === false)
  check('挂起清空', b.pendingCount() === 0)
}

console.log('\n[5] approval: 超时自动拒（P1，绝不永久挂住）')
{
  const out = []
  const b = createApprovalBroker({ send: (o) => out.push(o), isConnected: () => true, timeoutMs: 120 })
  // broker 的超时定时器是 unref 的（应用里 Electron 事件循环常驻，没问题），
  // 但这个探针本身就是事件循环的全部 —— 不自己撑住的话 unref 定时器永远不会触发。
  const keepAlive = setInterval(() => {}, 50)
  const t0 = Date.now()
  const v = await b.ask({ toolName: 'read_file', args: { path: 'slow.md' } })
  const ms = Date.now() - t0
  clearInterval(keepAlive)
  check('超时后 approved=false', v.approved === false, `${ms}ms ${v.reason}`)
  check('超时后发了 question-clear', out.some((o) => o.type === 'question-clear'))
  check('挂起清空', b.pendingCount() === 0)
}

// ---------------------------------------------------------------- 工作区夹逼
console.log('\n[6] workspace: 越界路径必须挡住')
{
  const bad = ['../x.md', 'a/../../x.md', 'C:/Windows/win.ini', 'C:\\Windows\\win.ini', '\\\\server\\share\\a.md', '/etc/passwd', '', '   ', 'a\u0000b']
  for (const p of bad) {
    let threw = false
    let msg = ''
    try { ws.resolveInWorkspace(p) } catch (err) { threw = true; msg = err.message }
    check(`拒绝 ${JSON.stringify(p)}`, threw, msg.slice(0, 40))
  }
  for (const p of ['a.md', 'notes/2026/x.md', './a.md']) {
    let ok = true
    try { ws.resolveInWorkspace(p) } catch { ok = false }
    check(`接受 ${JSON.stringify(p)}`, ok)
  }
}

console.log('\n[7] workspace: 读写列进出（真文件系统）')
{
  const w1 = await ws.writeWorkspaceFile('notes/a.md', '# 你好\n\n第一行。\n')
  check('写入 created=true', w1.created === true, `${w1.bytes}B`)
  const r1 = await ws.readWorkspaceFile('notes/a.md')
  check('读回内容一致', r1.text.includes('第一行'), `${r1.bytes}B`)
  const w2 = await ws.writeWorkspaceFile('notes/a.md', '# 你好\n\n第二版。\n')
  check('覆盖 created=false', w2.created === false)
  await ws.writeWorkspaceFile('root.txt', 'x')
  // 非递归只列直接子项（目录带尾斜杠）—— 这是 shell `ls` 的语义，别指望它递归。
  const ls = await ws.listWorkspaceDir('.')
  const names = ls.entries.map((e) => e.path).sort()
  check('非递归只列直接子项', names.includes('notes/') && names.includes('root.txt'), names.join(','))
  const deep = await ws.listWorkspaceDir('.', { recursive: true })
  const deepNames = deep.entries.map((e) => e.path).sort()
  check('递归能列到子文件', deepNames.includes('notes/a.md'), deepNames.join(','))
  const desc = await ws.describeWorkspace()
  check('describeWorkspace 有内容', typeof desc === 'string' && desc.length > 0, desc.slice(0, 50))
}

console.log('\n[8] workspace: 不存在的文件给中文错误')
{
  let msg = ''
  try { await ws.readWorkspaceFile('nope.md') } catch (err) { msg = err.message }
  check('ENOENT → 中文提示', msg.includes('工作区里没有'), msg)
}

console.log('\n[9] workspace: 全新安装（目录还不存在）时 list_dir 是空目录，不是错误')
{
  // ★ 真机探针撞到过：只在 write 时建目录 ⇒ 第一次 list_dir 报「工作区里没有这个目录：.」。
  const fresh = join(SANDBOX, 'fresh')
  const before = process.env.ORB_DATA
  process.env.ORB_DATA = fresh
  try {
    const ls0 = await ws.listWorkspaceDir('.')
    check('目录不存在时列根目录 → 空列表', Array.isArray(ls0.entries) && ls0.entries.length === 0,
      JSON.stringify(ls0.entries))
    check('目录不存在时 describeWorkspace 说「还空着」',
      /空着/.test(await ws.describeWorkspace()))
    let msg = ''
    try { await ws.listWorkspaceDir('sub') } catch (err) { msg = err.message }
    check('但列不存在的子目录仍然报错', msg.includes('工作区里没有这个目录'), msg)
    await ws.ensureWorkspaceRoot()
    const ls1 = await ws.listWorkspaceDir('.')
    check('ensureWorkspaceRoot 之后照常可列', Array.isArray(ls1.entries))
  } finally {
    process.env.ORB_DATA = before
    rmSync(fresh, { recursive: true, force: true })
  }
}

rmSync(SANDBOX, { recursive: true, force: true })
console.log(`\n=== PASS ${pass} · FAIL ${fail} ===`)
process.exit(fail === 0 ? 0 : 1)
