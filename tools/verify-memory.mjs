/**
 * verify-memory —— 长记忆形态 v1 的验收自检（A1~A8，A7 需 GUI，标 SKIP）。
 *
 * 设计原则：
 *   1. **全部在沙箱里跑**：数据根 `<应用根>/_sandbox-data`，每次一个带时间戳的 agentId，
 *      所以永远从零建仓，不碰 `data/` 也不碰 `~/.legacy`。
 *   2. **走真实模型**：不用 stub。缓存命中率、function calling、压缩摘要这些结论
 *      只有真实 API 才作数（stub 只能验形状）。
 *   3. **每条判据对应一件可复核的事实**，失败就报具体数字，不报「大概不对」。
 *
 * 判据来源：长记忆形态定稿 §304-311（内部文档，不进公开仓库）。
 *
 * 用法：
 *   node tools/verify-memory.mjs              # 全跑，报告写到 _sandbox-data/verify-<stamp>.log
 *   node tools/verify-memory.mjs --only A1,A2 # 只跑指定几条（省 token）
 *   node tools/verify-memory.mjs --keep       # 跑完不删沙箱 data（默认也不删，这里只是显式）
 *
 * 成本提示：全跑约 6~8 次真实请求（含 1 次摘要、1 次压缩后的追问），≈30~60 秒。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const SANDBOX = process.env.ORB_DATA || join(ROOT, '_sandbox-data')
process.env.ORB_DATA = SANDBOX // ★ 必须在 import 业务模块之前设

const { dataRoot, memoryDir } = await import('../src/memory.mjs')
const { createLLM } = await import('../src/llm.mjs')
const { createMemoryStore } = await import('../src/memstore.mjs')
const { createSessionStore } = await import('../src/session.mjs')
const { createSettings } = await import('../src/settings.mjs')
const { createSnapshotService } = await import('../src/snapshot.mjs')
const { createBrain } = await import('../src/brain.mjs')
const { readPersona } = await import('../src/persona.mjs')
const { estimateContextTokens } = await import('../src/compact.mjs')

// ── 参数 ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const onlyIdx = argv.indexOf('--only')
const only = onlyIdx >= 0 && argv[onlyIdx + 1]
  ? new Set(argv[onlyIdx + 1].split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))
  : null
const want = (id) => !only || only.has(id)

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const AGENT_ID = `orb-verify-${stamp}`

const logLines = []
function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`
  logLines.push(line)
  console.log(line)
}

const results = []
function verdict(id, ok, name, detail = '') {
  const state = ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'
  results.push({ id, state, name, detail })
  log(`${state.padEnd(4)} ${id} ${name}${detail ? ' — ' + detail : ''}`)
}

// ── 环境 ─────────────────────────────────────────────────────────────
function readConfig() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}
const cfg = readConfig()

function readAuth() {
  const candidates = [
    join(SANDBOX, 'providers', 'auth.json'),
    join(homedir(), '.legacy', 'lc-local-backend', 'providers', 'auth.json'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    const provider = raw.providers?.deepseek || raw.providers?.['openai-compatible']
    if (!provider?.base_url || !provider?.auth?.key) continue
    return { baseUrl: provider.base_url.replace(/\/+$/, ''), apiKey: provider.auth.key, file: p }
  }
  throw new Error('找不到可用的 providers/auth.json（试过 ' + candidates.join(' / ') + '）')
}

const auth = readAuth()
const model = String(cfg.model || 'deepseek/deepseek-flash').split('/').pop() || 'deepseek-flash'

mkdirSync(SANDBOX, { recursive: true })
log(`数据根 ${SANDBOX}（= dataRoot() ${dataRoot()}）`)
log(`agentId ${AGENT_ID}`)
log(`模型 ${model} @ ${auth.baseUrl}`)

// 沙箱配置：从真实 config.json 抄一份再改，绝不动真配置。
const sandboxCfgPath = join(SANDBOX, `verify-config-${stamp}.json`)
function writeSandboxConfig(overrides) {
  const merged = { ...cfg, ...overrides }
  writeFileSync(sandboxCfgPath, JSON.stringify(merged, null, 2), 'utf8')
  return merged
}
writeSandboxConfig({})

const llm = createLLM({ baseUrl: auth.baseUrl, apiKey: auth.apiKey, model, timeoutMs: 120000 })
const memstore = await createMemoryStore({ engine: 'local', root: ROOT, agentId: AGENT_ID })
const sessionStore = createSessionStore({ agentId: AGENT_ID })
const persona = readPersona('chat', {})
log(`persona ${persona.chars} 字 / sha ${persona.sha256.slice(0, 12)}`)

const settings = createSettings({ configPath: sandboxCfgPath, log })
const snapshot = createSnapshotService({ memstore, settings, log })

let idleCount = 0
function makeBrain(settingsOverride) {
  return createBrain({
    llm,
    memstore,
    persona: persona.text,
    sessionStore,
    agentId: AGENT_ID,
    settings: settingsOverride || settings,
    snapshot,
    log,
    onTurnIdle: () => { idleCount += 1 },
  })
}
const brain = makeBrain()

// 种子：与 main.mjs 一致，空 MEMORY.md，不预设章节。
{
  const listing = await memstore.list()
  const files = Array.isArray(listing) ? listing : listing?.files ?? []
  if (!files.some((f) => f.path === 'MEMORY.md')) {
    await memstore.write('MEMORY.md', '# 记忆\n\n<!-- 这里放你希望每一轮都记得的事。日常流水写到 journal/。 -->\n', 'init')
    log('已写入空 MEMORY.md 种子')
  }
}

/** 跑一轮，收集 text/usage/hash 与日志区间。 */
async function turn(b, sessionId, text, tag) {
  const started = Date.now()
  const logStart = logLines.length
  let assistant = ''
  let usage = null
  let hash = null
  for await (const ev of b.run({ sessionId, userText: text })) {
    if (ev.type === 'assistant') assistant += ev.text
    else if (ev.type === 'tool') {
      if (ev.phase === 'call') log(`   ↳ ${ev.name}(${JSON.stringify(ev.args).slice(0, 120)})`)
    } else if (ev.type === 'notice') log(`   ! ${ev.text}`)
    else if (ev.type === 'usage') usage = ev.usage
    else if (ev.type === 'done') {
      hash = ev.promptHash
      usage = ev.usage || usage
    }
  }
  const turnLog = logLines.slice(logStart)
  log(`—— ${tag} 用时 ${Date.now() - started}ms｜prompt=${usage?.promptTokens} hit=${usage?.cacheHitTokens} out=${usage?.completionTokens}`)
  log(`—— ${tag} 她：${assistant.replace(/\n/g, ' ⏎ ').slice(0, 300)}`)
  return { text: assistant, usage, hash, turnLog }
}

function snapHash(sessionId) {
  return sessionStore.readSystem(sessionId)?.hash ?? null
}
function hitsRatio(u) {
  if (!u?.promptTokens) return 0
  return (u.cacheHitTokens || 0) / u.promptTokens
}

// ── A1 / A2 / A3 / A4：前缀稳定、缓存命中、尾部增量、新会话生效 ─────
const S1 = `verify-a-${stamp}`
const S2 = `verify-b-${stamp}`
const FACT_NAME = '阿澈'
const FACT_DRINK = '冰美式'
const FACT_HATE = '香菜'

if (want('A1') || want('A2') || want('A3') || want('A4')) {
  log('════ A1/A2/A3/A4 ════')
  const t1 = await turn(
    brain,
    S1,
    '你好呀。请把这几件事写进你的 MEMORY.md：我叫阿澈，喜欢冰美式不加糖，最讨厌香菜。写进记忆之后再用你自己的话说一遍。',
    'S1 第 1 轮',
  )
  const h1 = snapHash(S1)

  const t2 = await turn(brain, S1, '我叫什么？喜欢喝什么？有什么忌口？', 'S1 第 2 轮')
  const h2 = snapHash(S1)

  const t3 = await turn(brain, S1, '再说一次：我的名字和忌口分别是什么？', 'S1 第 3 轮')
  const h3 = snapHash(S1)

  if (want('A1')) {
    const same = h1 && h1 === h2 && h2 === h3
    verdict('A1', !!same, '同一会话 3 轮 promptHash 不变', `${String(h1).slice(0, 24)} / ${String(h2).slice(0, 24)} / ${String(h3).slice(0, 24)}`)
  }
  if (want('A2')) {
    // 判定「冻结前缀被完整缓存」，而不是「整包 prompt 的命中率」。
    // 后者在只有三轮的短会话里会被上一轮回复的正文稀释：那部分字数在上一轮请求里
    // 还没出现过，必然算 miss（实测第 2 轮 89.2% 就是这么来的），与本条要验的东西无关。
    // 前缀覆盖率 = 命中 token / 冻结前缀的估算 token，≈1 才说明 I3 真的省到了钱。
    const sysText = sessionStore.readSystem(S1)?.content ?? ''
    const estPrefix = estimateContextTokens({ systemText: sysText })
    const cov = (u) => (estPrefix > 0 ? (u?.cacheHitTokens || 0) / estPrefix : 0)
    const r2 = hitsRatio(t2.usage)
    const r3 = hitsRatio(t3.usage)
    const ok = cov(t2.usage) >= 0.95 && cov(t3.usage) >= 0.95
    verdict(
      'A2',
      ok,
      '第 2 轮起冻结前缀被缓存命中 ≥95%（附整包命中率）',
      `前缀 ${estPrefix} token｜第2轮 命中 ${t2.usage?.cacheHitTokens}（覆盖 ${(cov(t2.usage) * 100).toFixed(1)}% / 整包 ${(r2 * 100).toFixed(1)}%）· 第3轮 命中 ${t3.usage?.cacheHitTokens}（覆盖 ${(cov(t3.usage) * 100).toFixed(1)}% / 整包 ${(r3 * 100).toFixed(1)}%）`,
    )
  }
  if (want('A3')) {
    // 写记忆后的下一轮应出现尾部漂移块，且前缀 hash 不变
    const driftRounds = [t2, t3].filter((t) => t.turnLog.some((l) => l.includes('漂移')))
    const hashKept = h2 === h1 || h3 === h1
    verdict('A3', driftRounds.length > 0 && hashKept && t2.text.includes(FACT_NAME),
      '写记忆后下一轮出现尾部增量且前缀不变',
      `漂移轮次 ${driftRounds.length}${driftRounds[0] ? `（${driftRounds[0].turnLog.find((l) => l.includes('漂移')).split('] ').pop()}）` : '（无，可能这轮她没写记忆）'}`)
  }
  if (want('A4')) {
    const t4 = await turn(brain, S2, '我之前跟你说过我喜欢喝什么、忌口是什么？', 'S2 第 1 轮（新会话）')
    const h4 = snapHash(S2)
    const recalled = t4.text.includes(FACT_DRINK) && t4.text.includes(FACT_HATE)
    verdict('A4', !!h4 && h4 !== h1 && recalled,
      '新会话 promptHash 变化且能答出旧会话写的事实',
      `新 hash ${String(h4).slice(0, 24)}（${h4 === h1 ? '与旧会话相同，异常' : '已变化'}）· 答出冰美式/香菜 ${recalled}`)
  }
}

// ── A5：生产仓 commit 数不变 ────────────────────────────────────────
if (want('A5')) {
  const prodAgent = String(cfg.agentId || '')
  const prodRepo = join(ROOT, 'data', 'memfs', prodAgent, 'memory')
  let prodCommits = null
  if (prodAgent && existsSync(join(prodRepo, '.git'))) {
    const r = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: prodRepo, encoding: 'utf8' })
    prodCommits = r.status === 0 ? String(r.stdout).trim() : null
  }
  const isolated = !String(dataRoot()).startsWith(join(ROOT, 'data'))
  verdict('A5', prodCommits === null || isolated,
    '真实 data/ 记忆仓未被触碰',
    prodCommits === null
      ? '生产仓尚不存在（engine=local 还没在 GUI 跑过），本轮全程沙箱'
      : `生产仓 ${prodCommits} 个 commit，本次数据根 ${dataRoot()} 与之隔离`)
}

// ── A6：压缩不丢 + 能重建 ───────────────────────────────────────────
if (want('A6')) {
  log('════ A6 压缩与重建 ════')
  writeSandboxConfig({ contextBudgetTokens: 4000, compactMode: 'auto', keepRecentMessages: 2 })
  const tightSettings = createSettings({ configPath: sandboxCfgPath, log })
  log(`沙箱旋钮：预算 ${tightSettings.get().contextBudgetTokens} / 模式 ${tightSettings.get().compactMode} / 保留 ${tightSettings.get().keepRecentMessages}`)
  const tightBrain = makeBrain(tightSettings)

  const S3 = `verify-c-${stamp}`
  const filler = '这些是背景资料，不用复述，只要回我一句「收到」。' + Array.from({ length: 40 },
    (_, i) => `第${i + 1}条：周末的采购清单里有牛奶、鸡蛋、面包、青菜、豆腐、酱油，还有一包纸巾和两盒酸奶。`).join('')
  log(`填充消息 ${filler.length} 字 ≈${estimateContextTokens({ systemText: '', messages: [{ text: filler }] })} token`)

  await turn(tightBrain, S3, filler, 'S3 第 1 轮（长消息）')
  await turn(tightBrain, S3, '收到就好。顺便说一句，我的忌口是香菜。', 'S3 第 2 轮')
  const beforeLines = readMsgLines(S3).length
  const t3c = await turn(tightBrain, S3, '把采购清单里的东西挑三样说给我听。', 'S3 第 3 轮（应触发自动压缩）')
  const afterLines = readMsgLines(S3).length

  const compacted = t3c.turnLog.some((l) => l.includes('触发压缩')) || t3c.turnLog.some((l) => l.includes('压缩完成'))
  const journalHit = findJournalEntry('· compact')
  const snap3 = sessionStore.readSystem(S3)
  const linesKept = afterLines >= beforeLines

  // 重建：调 rebuild-context 预览（子进程，模拟人工入口）
  const rebuild = spawnSync(process.execPath, [join(HERE, 'rebuild-context.mjs'), '--session', S3, '--agent', AGENT_ID, '--data', SANDBOX], { encoding: 'utf8' })
  const rebuildOk = rebuild.status === 0 && /promptHash/.test(rebuild.stdout || '')

  verdict('A6', compacted && linesKept && !!journalHit && !!snap3?.boundaryMsgId && rebuildOk,
    '压缩触发、原文不删、journal 有备忘、边界落盘、可重建',
    `压缩=${compacted} 行数 ${beforeLines}→${afterLines} journal=${journalHit ?? '无'} 边界=${snap3?.boundaryMsgId ?? '无'} 重建=${rebuildOk}`)

  if (!rebuildOk) log(`   rebuild-context stderr: ${String(rebuild.stderr || '').slice(0, 400)}`)
}

function readMsgLines(sessionId) {
  return sessionStore.readMessages(sessionId)
}
function findJournalEntry(marker) {
  const month = new Date().toISOString().slice(0, 7)
  const file = join(memoryDir(AGENT_ID), 'journal', `${month}.md`)
  if (!existsSync(file)) return null
  const hit = readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.includes(marker))
  return hit ? hit.trim().slice(0, 80) : null
}

// ── A7：GUI 真机，无法在 node 里验 ─────────────────────────────────
if (want('A7')) {
  verdict('A7', null, 'local 模式 3 秒内有输出、界面不永久「正在思考」', '需 GUI 真机（切 engine:"local" 后跑一次），node 自检不覆盖')
}

// ── A8：旋钮改完即生效（不重启） ───────────────────────────────────
if (want('A8')) {
  log('════ A8 旋钮热生效 ════')
  const cfgA8 = join(SANDBOX, `verify-config-a8-${stamp}.json`)
  writeFileSync(cfgA8, JSON.stringify({ ...cfg, contextBudgetTokens: 8000, compactMode: 'auto' }, null, 2), 'utf8')
  const s = createSettings({ configPath: cfgA8, log })
  const v1 = s.get()
  const mtime1 = statSync(cfgA8).mtimeMs
  // 改盘：预算翻倍 + 关压缩
  writeFileSync(cfgA8, JSON.stringify({ ...cfg, contextBudgetTokens: 16000, compactMode: 'off' }, null, 2), 'utf8')
  const mtime2 = statSync(cfgA8).mtimeMs
  const v2 = s.get()
  // 越界夹取
  writeFileSync(cfgA8, JSON.stringify({ ...cfg, contextBudgetTokens: 999999999, compactMode: 'bogus' }, null, 2), 'utf8')
  const v3 = s.get()
  verdict('A8',
    v1.contextBudgetTokens === 8000 && v2.contextBudgetTokens === 16000 && v2.compactMode === 'off'
      && v3.contextBudgetTokens === v3.modelContextTokens && v3.compactMode === 'auto',
    '同一 settings 实例：改盘即生效、非法值被夹取',
    `8000→${v1.contextBudgetTokens}·16000/off→${v2.contextBudgetTokens}/${v2.compactMode}·越界→${v3.contextBudgetTokens}/${v3.compactMode}` +
    (mtime1 === mtime2 ? '（⚠ 两次写入 mtime 相同，缓存可能未失效）' : ''))
}

// ── A9：重复写同一内容不算失败（2026-10-19 真机冒烟踩过的坑） ──────
//
// 她常把同一段记忆整篇重写一遍。此时 git add 无事可做，`git commit` 以
// exit 1 + 空 stderr 收场（"nothing to commit" 打在 stdout 上），旧实现把它
// 当失败抛出，于是她对用户说「我写了两回都没写进去」。这条钉住正确行为：
// 内容没变 → ok 且 changed=false、head 不动；内容变了 → changed=true、有新提交。
if (want('A9')) {
  log('════ A9 幂等写 ════')
  const p = 'about/a9.md'
  const head0 = await memstore.head()
  const w1 = await memstore.write(p, '# A9\n\n同一段内容。\n', 'verify-a9')
  const head1 = await memstore.head()
  const w2 = await memstore.write(p, '# A9\n\n同一段内容。\n', 'verify-a9')
  const head2 = await memstore.head()
  const w3 = await memstore.write(p, '# A9\n\n换了内容。\n', 'verify-a9')
  const head3 = await memstore.head()
  log(`A9 首次 changed=${w1.changed} head ${head0.slice(0, 7)}→${head1.slice(0, 7)}`)
  log(`A9 重复 changed=${w2.changed} head ${head1.slice(0, 7)}→${head2.slice(0, 7)}`)
  log(`A9 换内容 changed=${w3.changed} head ${head2.slice(0, 7)}→${head3.slice(0, 7)}`)
  verdict('A9',
    w1.changed === true && head1 !== head0
      && w2.changed === false && head2 === head1
      && w3.changed === true && head3 !== head2,
    '重复写同一内容不报错、不造空提交；内容真变了才提交',
    `首次 changed=${w1.changed}·重复 changed=${w2.changed}（head 未动=${head2 === head1}）·换内容 changed=${w3.changed}`)
}

// ── 收尾 ─────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.state === 'PASS').length
const fail = results.filter((r) => r.state === 'FAIL').length
const skip = results.filter((r) => r.state === 'SKIP').length
const report = [
  `# verify-memory ${new Date().toISOString()}`,
  `agentId ${AGENT_ID} · 数据根 ${SANDBOX} · 模型 ${model}`,
  '',
  '| 判据 | 结果 | 说明 | 细节 |',
  '| --- | --- | --- | --- |',
  ...results.map((r) => `| ${r.id} | ${r.state} | ${r.name} | ${r.detail} |`),
  '',
  `合计 PASS ${pass} · FAIL ${fail} · SKIP ${skip}`,
  '',
  '## 完整日志',
  '```',
  ...logLines,
  '```',
].join('\n')
const reportPath = join(SANDBOX, `verify-${stamp}.log`)
writeFileSync(reportPath, report, 'utf8')
log(`报告 ${reportPath}`)
log(`==== PASS ${pass} · FAIL ${fail} · SKIP ${skip} ====`)
if (fail > 0) process.exitCode = 1
