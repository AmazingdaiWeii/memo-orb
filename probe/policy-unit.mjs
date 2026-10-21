/**
 * probe/policy-unit.mjs · 「她的手」三级策略自检（无头、真文件、无网络）
 *
 * 验的是什么（P2 硬要求的六条）：
 *   1. **读黑名单真的挡得住**：私钥 / 浏览器凭据 / provider key / wechat token 这类路径
 *      既读不到文件，也**列不出目录**（`list_dir` 也要挡 —— 只挡文件的话，
 *      她仍能列出 `.ssh` 里的文件名，而文件名本身就是情报）。
 *   2. **白名单内新建免审批**（approve 调用 0 次）：写自己的桌面不该弹卡。
 *   3. **覆盖已存在文件必弹卡**：没有 delete_file，也没有 undo，覆盖是不可逆的。
 *   4. **白名单外必弹卡**：放行一次只对这一次有效（宿主不记住）。
 *   5. **拒绝就真的不写**：卡片被拒后文件不能存在 —— 这是「审批」和「通知」的区别。
 *   6. **`exec` 在 P2 是关的**：工具列表里根本没有 run_script / run_command
 *      （不存在才不会让她反复试；给了再拦，是两种完全不同的失败模式）。
 *
 * 另外顺带守住几条容易回归的细节：正/反斜杠等价、`list_dir('.')` 的 shell `ls` 语义
 * （目录带尾斜杠、只列直接子项）、`glob_files` 的条数/访问上限、`GUIDE_VERSION` 同步。
 *
 * 跑法：`node probe\policy-unit.mjs`
 * 沙箱：`_sandbox-policy/`（每次跑前清空，不碰真实记忆仓与真实磁盘）
 */

import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SANDBOX = join(ROOT, '_sandbox-policy')
const AGENT = 'policy-probe'
const WS = join(SANDBOX, 'workspace')

// ★ 必须在 import src/* 之前设：memory.mjs / session.mjs 都按 env 算数据根。
process.env.ORB_DATA = SANDBOX
process.env.ORB_LEGACY_DATA = SANDBOX

rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(WS, { recursive: true })

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 造一个文件（自动建父目录） */
function put(rel, text = 'x\n') {
  const abs = join(SANDBOX, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text, 'utf8')
  return abs
}

// ── 造场景 ────────────────────────────────────────────────
// 白名单内（= data/workspace）
put('workspace/notes/old.md', '第一行\n第二行\n第三行\n')
// 白名单外但可读（「读全盘」得真能读到外面去）
const outsideReadme = put('outside/readme.txt', '外面的文件\n')
// 黑名单样本
const blacklist = {
  sshKey: put('home/.ssh/id_rsa', 'PRIVATE KEY'),
  sshConfig: put('home/.ssh/config', 'Host *'),
  aws: put('home/.aws/credentials', '[default]'),
  dsh: put('home/.dsh/omni-bridge-config.json', '{}'),
  providerKey: put('providers/auth.json', '{"key":"sk-x"}'),
  loginData: put('browser/Login Data', 'sqlite'),
  cookies: put('browser/Cookies', 'sqlite'),
  pfx: put('certs/a.pfx', 'bin'),
  pem: put('certs/a.pem', 'PEM'),
  idRsaPub: put('keys/id_rsa.pub', 'ssh-rsa AAAA'),
  wechat: put('wechat.json', '{"botToken":"secret"}'),
}

const { createBrain } = await import('../src/brain.mjs')
const { createMemoryStore } = await import('../src/memstore.mjs')
const { createSettings } = await import('../src/settings.mjs')
const { createSnapshotService, GUIDE_VERSION } = await import('../src/snapshot.mjs')
const { createSessionStore } = await import('../src/session.mjs')
const { createPolicy, defaultPolicy, compileGlob, normalizePath, describePolicy } = await import('../src/policy.mjs')

const logs = []
const log = (m) => {
  logs.push(String(m))
  console.log(`  · ${m}`)
}

// ── 策略对象本身 ──────────────────────────────────────────
const policy = createPolicy({ dataRoot: SANDBOX, log })
check('缺省策略自动落盘 data/policy.json', existsSync(policy.path), policy.path)
const onDisk = JSON.parse(readFileSync(policy.path, 'utf8'))
check('落盘的 deny 条数 = 缺省', (onDisk.read?.deny ?? []).length === defaultPolicy(SANDBOX).read.deny.length, `${(onDisk.read?.deny ?? []).length} 条`)
check('exec 缺省关闭', policy.execEnabled === false)
check('describePolicy 说得清边界', /读：全盘/.test(describePolicy(policy)), describePolicy(policy))

// glob 编译（`**/` 允许零层是这里最容易写错的地方）
check('compileGlob 允许 **/ 零层', compileGlob('**/id_rsa*').test('/c/keys/id_rsa') && compileGlob('**/id_rsa*').test('c:/a/id_rsa.pub'))
check('compileGlob 不让 * 跨段', !compileGlob('**/*.pem').test('c:/a/b/c.pem.bak/x'))
check('normalizePath 吃掉正反斜杠差异', normalizePath('E:/Memo orb\\data') === normalizePath('e:\\Memo orb/data'), normalizePath('E:/Memo orb\\data'))

// resolveInput
function throws(fn) {
  try {
    fn()
    return null
  } catch (err) {
    return err.message
  }
}
check('UNC 路径拒绝', Boolean(throws(() => policy.resolveInput('\\\\server\\share\\x'))), throws(() => policy.resolveInput('\\\\server\\share\\x')) ?? '')
check('空路径拒绝', Boolean(throws(() => policy.resolveInput('   '))))
check('相对路径落到 workspace', policy.resolveInput('notes/old.md') === join(WS, 'notes', 'old.md'), policy.resolveInput('notes/old.md'))
const slashEq = policy.resolveInput('C:/Windows/win.ini') === policy.resolveInput('C:\\Windows\\win.ini')
check('绝对路径正/反斜杠等价', slashEq)

// writeVerdict 三级
const vNew = policy.writeVerdict(join(WS, 'brand-new.md'), { exists: false })
const vOver = policy.writeVerdict(join(WS, 'notes', 'old.md'), { exists: true })
const vOut = policy.writeVerdict(join(SANDBOX, 'outside', 'x.md'), { exists: false })
const vDeny = policy.writeVerdict(blacklist.sshKey, { exists: false })
check('白名单内新建 → free', vNew.mode === 'free', vNew.reason)
check('白名单内覆盖 → ask', vOver.mode === 'ask', vOver.reason)
check('白名单外 → ask', vOut.mode === 'ask', vOut.reason)
check('黑名单 → deny', vDeny.mode === 'deny', vDeny.reason)

// ── 假 LLM + 真工具循环 ───────────────────────────────────
function fakeLLM(script) {
  let round = 0
  return {
    lastTools: null,
    async* stream({ tools }) {
      this.lastTools = tools
      const events = script[round++] ?? [{ type: 'content', text: '（没有更多脚本了）' }]
      for (const e of events) yield e
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    },
  }
}

async function drain(brain, sessionId, userText) {
  const toolResults = []
  const text = []
  for await (const ev of brain.run({ sessionId, userText })) {
    if (ev.type === 'tool' && ev.phase === 'result') toolResults.push(ev)
    if (ev.type === 'assistant' && ev.text) text.push(ev.text)
  }
  return { toolResults, text: text.join(''), parsed: toolResults.map((r) => ({ name: r.name, json: safeJson(r.result) })) }
}

function safeJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    return { _raw: s }
  }
}

const memstore = await createMemoryStore({ engine: 'local', root: ROOT, agentId: AGENT })
const settings = createSettings({ configPath: join(SANDBOX, 'config.json'), log })
const snapshot = createSnapshotService({ memstore, settings, log })
const sessionStore = createSessionStore({ agentId: AGENT })

// 脚本：一串工具调用，最后一轮说句话收口
const script = [
  [{ type: 'tool_call', id: 't1', name: 'read_file', args: { path: outsideReadme.replace(/\\/g, '/') } }],
  [{ type: 'tool_call', id: 't2', name: 'write_file', args: { path: 'from-brain.md', content: '她写的\n' } }],
  [{ type: 'tool_call', id: 't3', name: 'write_file', args: { path: 'from-brain.md', content: '她改的\n' } }],
  [{ type: 'tool_call', id: 't4', name: 'write_file', args: { path: '../outside/from-brain.txt', content: '伸到外面\n' } }],
  [{ type: 'tool_call', id: 't5', name: 'write_file', args: { path: blacklist.providerKey, content: 'hacked' } }],
  [{ type: 'tool_call', id: 't6', name: 'read_file', args: { path: blacklist.sshKey } }],
  [{ type: 'tool_call', id: 't7', name: 'read_file', args: { path: '../providers/auth.json' } }],
  [{ type: 'tool_call', id: 't8', name: 'list_dir', args: { path: '.' } }],
  [{ type: 'tool_call', id: 't9', name: 'list_dir', args: { path: join(SANDBOX, 'home', '.ssh') } }],
  [{ type: 'tool_call', id: 't10', name: 'glob_files', args: { pattern: '*.md', root: WS } }],
  [{ type: 'content', text: '都试完了。' }],
]

let approveCalls = 0
const approveLog = []
const approve = async (req) => {
  approveCalls += 1
  approveLog.push(`${req?.toolName}：${req?.reason ?? ''}`)
  return { approved: true }
}

const brain = createBrain({
  llm: fakeLLM(script),
  memstore,
  persona: '你是球。',
  sessionStore,
  agentId: AGENT,
  settings,
  snapshot,
  log,
  approve,
  policy,
})

const names = brain.tools.map((t) => t.function?.name)
check('工具列表含 glob_files', names.includes('glob_files'), names.join(','))
check('工具列表**没有** run_script / run_command（exec 关）', !names.some((n) => /run_script|run_command|exec/.test(n)))
check('工具列表没有 delete_file', !names.some((n) => /delete|remove|rm_/.test(n)))

const R = await drain(brain, 'probe-policy', '自己找找外面有什么')
const by = (name, i = 0) => R.parsed.filter((r) => r.name === name)[i]?.json ?? {}

// 1) 读全盘
const rRead = by('read_file', 0)
check('read_file 读到 workspace 之外的文件', rRead.ok === true && String(rRead.text).includes('外面的文件'), `${rRead.path ?? ''} ${rRead.bytes ?? '?'}B`)

// 2) 白名单内新建免审批
const rW1 = by('write_file', 0)
check('白名单内新建成功', rW1.ok === true && rW1.created === true, rW1.path ?? rW1.error ?? '')
check('白名单内新建后文件真的在', existsSync(join(WS, 'from-brain.md')))

// 3) 覆盖弹卡
const rW2 = by('write_file', 1)
check('覆盖已存在文件成功（卡片放行）', rW2.ok === true && rW2.created === false, rW2.message ?? rW2.error ?? '')
check('覆盖后内容是最新那次', readFileSync(join(WS, 'from-brain.md'), 'utf8').trim() === '她改的')

// 4) 白名单外弹卡
const rW3 = by('write_file', 2)
check('白名单外写入成功（卡片放行）', rW3.ok === true, rW3.path ?? rW3.error ?? '')
check('白名单外文件真的写出来了', existsSync(join(SANDBOX, 'outside', 'from-brain.txt')))

// 5) 黑名单写 = deny，且不弹卡
const rW4 = by('write_file', 3)
check('黑名单路径写入被拒（不弹卡）', rW4.ok === false && /隐私|黑名单/.test(String(rW4.error)), String(rW4.error).slice(0, 60))
check('黑名单文件没被改', readFileSync(blacklist.providerKey, 'utf8') === '{"key":"sk-x"}')

// 6) 黑名单读
const rR2 = by('read_file', 1)
check('read_file 挡住 .ssh 私钥', rR2.ok === false && /隐私/.test(String(rR2.error)), String(rR2.error).slice(0, 70))
const rR3 = by('read_file', 2)
check('read_file 挡住 providers/auth.json（相对路径也一样）', rR3.ok === false && /隐私/.test(String(rR3.error)), String(rR3.error).slice(0, 70))

// 7) 审批只发生在该发生的地方：覆盖 1 次 + 白名单外 1 次
check('审批调用恰好 2 次（覆盖 + 白名单外）', approveCalls === 2, `${approveCalls} 次：${approveLog.join(' | ')}`)
check('审批理由说清了「为什么问」', /不可逆/.test(approveLog[0] ?? '') && /白名单外/.test(approveLog[1] ?? ''), approveLog.join(' | '))

// 8) list_dir('.') 的 shell ls 语义
const rL = by('list_dir', 0)
const entries = rL.entries ?? []
check('list_dir(\'.\') 是 workspace 根', String(rL.path ?? '').endsWith('/workspace'), rL.path ?? '')
check('目录条目带尾斜杠（shell ls 语义）', entries.includes('notes/'), entries.join(','))
check('list_dir(\'.\') 只列直接子项（不含 notes/old.md）', !entries.includes('notes/old.md'))
check('目录排在文件前面', entries.length >= 2 && entries[0] === 'notes/', entries.join(','))

// 9) 目录本身也要挡
const rL2 = by('list_dir', 1)
check('list_dir 挡住 .ssh 目录（列不出文件名）', rL2.ok === false && /隐私/.test(String(rL2.error)), String(rL2.error).slice(0, 70))

// 10) glob
const rG = by('glob_files', 0)
check('glob_files 找到 workspace 里的 md', rG.ok !== false && (rG.files ?? []).some((f) => f.rel === 'from-brain.md'), `${rG.count ?? 0} 个`)
check('glob_files 跳过 .git / node_modules 不是靠运气', Array.isArray(rG.files) && !(rG.files ?? []).some((f) => /(^|\/)(\.git|node_modules)\//.test(f.rel)))

// 11) 拒绝之后真的没写（换一个 approve 一律拒绝的 brain）
const deniedPath = join(SANDBOX, 'outside', 'denied.txt')
let denied = 0
const brainDeny = createBrain({
  llm: fakeLLM([
    [{ type: 'tool_call', id: 'd1', name: 'write_file', args: { path: '../outside/denied.txt', content: '不该存在' } }],
    [{ type: 'content', text: '好，那我不写了。' }],
  ]),
  memstore,
  persona: '你是球。',
  sessionStore,
  agentId: AGENT,
  settings,
  snapshot,
  log,
  approve: async () => {
    denied += 1
    return { approved: false }
  },
  policy,
})
const D = await drain(brainDeny, 'probe-policy-deny', '写到外面去')
const dJson = D.parsed[0]?.json ?? {}
check('卡片被拒 → 工具返回 ok:false', dJson.ok === false && dJson.denied === true, String(dJson.error).slice(0, 60))
check('卡片被拒 → 文件**不存在**', !existsSync(deniedPath))
check('被拒时 approve 被问了一次（不是静默跳过）', denied === 1, `${denied} 次`)

// 12) 指南与 schema 同源
const snap = await snapshot.capture({ persona: '你是球。', toolSchemas: brain.tools, web: false })
// 只看「≥3」而不是钉死具体值：指南每加一节就要升版，钉死会把本该绿的东西
// 变成一条要人跟着改的假失败（P3 加「时间与闹钟」那节就从 3 到了 4）。
// 真正要守的是「改了内容就得升版」，那由 snapshot.mjs 自己的常量守着。
check('GUIDE_VERSION ≥ 3（手改过就得升版）', GUIDE_VERSION >= 3, `GUIDE_VERSION=${GUIDE_VERSION}`)
check('快照带上 guideVersion', snap.guideVersion === GUIDE_VERSION, String(snap.guideVersion))
check('指南讲了「读全盘」与「白名单」', snap.content.includes('你的手') && /弹卡|确认/.test(snap.content))
check('指南说清楚覆盖前要先读', /覆盖/.test(snap.content) && /read_file/.test(snap.content))

// ── 汇总 ────────────────────────────────────────────────
const pass = results.filter((r) => r.ok).length
const fail = results.length - pass
console.log(`\n===== ${pass} PASS / ${fail} FAIL（共 ${results.length} 条）=====`)
if (fail > 0) {
  for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ ${r.name} ${r.detail}`)
  process.exit(1)
}
process.exit(0)
