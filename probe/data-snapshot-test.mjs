/**
 * probe/data-snapshot-test.mjs · data-snapshot 的判红探针
 *
 * ★ 红线：**绝不碰真实 data / config**。全程在 `_sandbox-data-snap/` 里造一份假 data，
 *   通过 ORB_DATA 指过去（`memory.mjs` 的 dataRoot() 每次调用都读环境变量，所以能生效）。
 *
 * ⚠️ 本机跑法：`NODE_OPTIONS= node probe/data-snapshot-test.mjs`
 *   NODE_OPTIONS 里挂着 node-language-shim（safe-delete 垫片），它删目录会 ETIMEDOUT，
 *   于是"沙盒清不干净"那条判红会误报成环境问题。清空 NODE_OPTIONS 即正常。
 *
 * 要回答的不是「跑通了吗」，而是**「它能不能判红」**：
 *   T1 冻结产出完整 manifest（sha256 全在），且**默认既不含凭据也不含 workspace**
 *   T2 解冻能否真把内容退回去（改的、新增的、删的三种变化）
 *   T3 解冻前是否自动给"现在"存档（C2，不许省）
 *   T4 快照被篡改时 verify 必须报错、thaw 必须拒绝（不能"看起来成功"）
 *   T5 分层解冻：只退 memories 时，config 必须保持当前值
 *   T6 快照目录若被指进 data 内，必须拒绝
 *   T7 凭据层默认不冻；只有显式点名才进去，且必须被标成含敏感信息
 */

import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJ = join(HERE, '..')
const SANDBOX = join(PROJ, '_sandbox-data-snap')
const DATA = join(SANDBOX, 'data')

process.env.ORB_DATA = DATA
process.env.ORB_LEGACY_DATA = ''
delete process.env.ORB_SNAPSHOT_DIR

const snap = await import('../src/data-snapshot.mjs')

// ─────────────────────────────────────────────── 小工具

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`) }
  else { fail += 1; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

function put(rel, content) {
  const full = join(DATA, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

function get(rel) {
  try { return readFileSync(join(DATA, rel), 'utf8') } catch { return null }
}

/** 造一份最小但有代表性的 data：四层都非空，memfs 带 .git，且**带凭据**。 */
function makeData() {
  put('memfs/orb-test/memory/MEMORY.md', '# 记忆\n\n## 关于他\n- 喝冰美式，不加糖。\n')
  put('memfs/orb-test/memory/.git/HEAD', 'ref: refs/heads/main\n')
  put('memfs/orb-test/memory/.git/refs/heads/main', 'a'.repeat(40) + '\n')
  put('conversations/Y29udjE/messages.jsonl', '{"timestamp":"2026-10-23T01:00:00Z","message":{"role":"user","content":"第一句"}}\n')
  put('conversations/Y29udjE/system.json', '{"content":"persona-v1"}\n')
  put('workspace/notes.txt', 'alpha\n')
  put('policy.json', '{"mode":"local"}\n')
  put('providers/auth.json', '{"deepseek":"sk-REAL-1"}\n')
  put('wechat.json', '{"botToken":"TOKEN-SECRET"}\n')
}

console.log('\n=== data-snapshot 判红探针 ===\n')

// 沙盒必须真清空：删不掉就当场判红，别在上一轮的残留上跑出一堆假结论。
try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 下面统一判 */ }
if (existsSync(SANDBOX)) {
  console.error(`沙盒清不掉：${SANDBOX}（可能有进程占用），先手工删掉再跑`)
  process.exit(2)
}
makeData()
console.log(`沙盒 data：${DATA}\n`)

// T6 快照目录被指进 data 内必须拒绝
console.log('[T6] 快照目录不能落在 data 内')
ok('默认位置与 data 同级', snap.snapshotRoot() === join(SANDBOX, '.orb-snapshots'), snap.snapshotRoot())
process.env.ORB_SNAPSHOT_DIR = join(DATA, 'snapshots')
let guardFired = false
try { await snap.freeze({ reason: 'guard-test', layers: ['workspace'] }) } catch { guardFired = true }
ok('把存档塞进 data 里时 freeze 拒绝执行', guardFired)
ok('拒绝时没留下半截目录', !existsSync(join(DATA, 'snapshots', '.tmp-guard')))
delete process.env.ORB_SNAPSHOT_DIR

// T1 冻结
console.log('\n[T1] 冻结产出完整 manifest，且默认既不含凭据也不含 workspace')
const a = await snap.freeze({ reason: 'manual-test', meta: { appVersion: 'test', agentId: 'orb-test' } })
const man = snap.readManifest(a.id)
const files = Object.keys(man.files)
ok('返回了 id', typeof a.id === 'string' && a.id.length > 10, a.id)
ok('默认三层：memories / conversations / config',
  a.layers.length === 3 && a.layers.includes('memories') && a.layers.includes('conversations') && a.layers.includes('config'),
  a.layers.join(','))
ok('文件数 >= 6', a.fileCount >= 6, String(a.fileCount))
ok('manifest 里有 sha256', Object.values(man.files).every((f) => /^sha256:[0-9a-f]{64}$/.test(f.sha256)))
ok('含 .git（历史必须一起走）', existsSync(join(a.dir, 'memfs/orb-test/memory/.git/HEAD')))
ok('没有把 manifest 自己算进 files', !files.includes('manifest.json'))

// ★ 两条边界：存档要能安全放云盘 + 要能在几十秒内完成
ok('存档里没有 workspace/（杂物间不跟着走）', !files.some((f) => f.startsWith('workspace/')))
ok('存档里没有 providers/（API key）', !files.some((f) => f.startsWith('providers/')))
ok('存档里没有 bili-auth.json / wechat.json', !files.some((f) => /bili-auth|wechat/.test(f)))
ok('manifest 标记为不含敏感信息', man.hasSecrets === false, String(man.hasSecrets))

// ★ 存档要自带一份给人看的排障指南（用户 2026-10-23 要求）
const readmePath = join(a.dir, '说明.txt')
ok('存档里有一份「说明.txt」', existsSync(readmePath))
const readmeTxt = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : ''
ok('说明里讲了「没存什么」', readmeTxt.includes('没存什么'))
ok('说明里讲了唤醒只认 manifest.json', readmeTxt.includes('manifest.json'))
ok('说明里写了换机代价（Key / 扫码 / 配对）',
  readmeTxt.includes('Key') && readmeTxt.includes('扫码') && readmeTxt.includes('配对'))
ok('说明.txt 不参与指纹（不在 manifest.files 里）', !files.includes('说明.txt'))

const lst = snap.list()
ok('list 能列出这一条', lst.length === 1 && lst[0].id === a.id)
ok('list 标明不含凭据', lst[0].hasSecrets === false)

// T2/T3 破坏 → 解冻 → 还原
console.log('\n[T2/T3] 破坏 → 解冻 → 还原（含解冻前自动存档）')
put('memfs/orb-test/memory/MEMORY.md', '# 记忆\n\n## 关于他\n- 改过了。\n')
appendFileSync(join(DATA, 'conversations/Y29udjE/messages.jsonl'), '{"timestamp":"2026-10-23T02:00:00Z","message":{"role":"assistant","content":"伪造的"}}\n', 'utf8')
put('conversations/Y29udjE/system.json', '{"content":"persona-v2"}\n')
put('conversations/Y29udjE/junk.jsonl', '{"junk":true}\n')
put('policy.json', '{"mode":"changed"}\n')
put('providers/auth.json', '{"deepseek":"sk-ROTATED"}\n')
rmSync(join(DATA, 'workspace/notes.txt'))
put('workspace/new-junk.txt', 'i am not frozen\n')

const beforeThawMem = get('memfs/orb-test/memory/MEMORY.md')
const r = await snap.thaw(a.id)
ok('返回了 pre-thaw 备份 id', typeof r.backupId === 'string' && r.backupId.length > 10, String(r.backupId))
ok('备份确实落盘', existsSync(snap.snapshotDir(r.backupId)))
ok('MEMORY.md 回到旧值', get('memfs/orb-test/memory/MEMORY.md').includes('冰美式'))
ok('messages.jsonl 回到单行', get('conversations/Y29udjE/messages.jsonl').split('\n').filter(Boolean).length === 1)
ok('被改的 system.json 回到 persona-v1', get('conversations/Y29udjE/system.json').includes('persona-v1'))
ok('新增的 junk.jsonl 不见了（整目录替换）', !existsSync(join(DATA, 'conversations/Y29udjE/junk.jsonl')))
ok('偏好设置也退回去了（policy.json）', get('policy.json').includes('local'))

// ★ workspace 没被冻的证据：删掉的不会回来、新增的不会被抹掉
ok('workspace 没被冻：删掉的 notes.txt 依然不在', !existsSync(join(DATA, 'workspace/notes.txt')))
ok('workspace 没被冻：新增的 new-junk.txt 依然在', existsSync(join(DATA, 'workspace/new-junk.txt')))

// ★ 凭据没被存过，所以也不会被"退回去"
ok('凭据保持当前值（sk-ROTATED 还在，没被存档回滚）', get('providers/auth.json').includes('sk-ROTATED'))
ok('备份里留着被改后的版本（能反悔）', readFileSync(join(snap.snapshotDir(r.backupId), 'memfs/orb-test/memory/MEMORY.md'), 'utf8') === beforeThawMem)
ok('暂存目录：清掉了，或者如实报告了没清掉',
  !existsSync(join(DATA, `.orb-thaw-${a.id}`)) || Boolean(r.stageLeft),
  r.stageLeft ? `留在 ${r.stageLeft}` : '')

// T4 篡改检测必须判红
console.log('\n[T4] 快照被篡改 → verify 报错、thaw 拒绝')
const victim = join(a.dir, 'conversations/Y29udjE/system.json')
writeFileSync(victim, '{"content":"persona-vX"}\n', 'utf8')   // 同长度改一个字节
const vd = await snap.verify(a.id, { deep: true })
ok('deep verify 判红', vd.ok === false && vd.hashMismatch.length === 1, JSON.stringify(vd.hashMismatch))
const vs = await snap.verify(a.id, { deep: false })
ok('浅 verify 看不出来（同大小）——如实说明它只管缺失与大小', vs.ok === true)
let refused = false
try { await snap.thaw(a.id, { layers: ['conversations'], autoBackup: false }) } catch { refused = true }
ok('thaw 拒绝执行被篡改的快照', refused)
writeFileSync(victim, '{"content":"persona-v1"}\n', 'utf8')
ok('修回后 verify 通过', (await snap.verify(a.id, { deep: true })).ok === true)

// T5 分层解冻不能一把全退
console.log('\n[T5] 只退 memories：config 必须保持当前值')
put('memfs/orb-test/memory/MEMORY.md', '# 记忆\n\n## 关于他\n- 改过了2。\n')
put('policy.json', '{"mode":"keep-me"}\n')
const r2 = await snap.thaw(a.id, { layers: ['memories'], autoBackup: false })
ok('memories 退回去了', get('memfs/orb-test/memory/MEMORY.md').includes('冰美式'))
ok('偏好设置没被动（保持当前值）', get('policy.json').includes('keep-me'))
ok('plan 只含 memfs', r2.plan.every((p) => p === 'memfs'), JSON.stringify(r2.plan))

// T7 凭据层：默认不冻，显式点名才进
console.log('\n[T7] 凭据层默认不冻；显式点名才进')
const s = await snap.freeze({ layers: ['secrets'], reason: 'secrets-test' })
const sMan = snap.readManifest(s.id)
ok('显式点名后 providers/ 才进存档', Object.keys(sMan.files).some((f) => f.startsWith('providers/')))
ok('显式点名后 wechat.json 也进', Object.keys(sMan.files).some((f) => f.includes('wechat.json')))
ok('manifest 标记为含敏感信息（能被 UI 拦下）', sMan.hasSecrets === true)
ok('默认层里没有 secrets', !snap.DEFAULT_LAYERS.includes('secrets'))
ok('默认层里没有 workspace', !snap.DEFAULT_LAYERS.includes('workspace'))

// 清理：discard 是挪走不是真删
console.log('\n[清理] discard 挪到 .trash 而不是删')
const d = snap.discard([a.id])
ok('返回了 moved', d.moved.includes(a.id))
ok('原位置已不在', !existsSync(snap.snapshotDir(a.id)))
ok('trash 里能找到', existsSync(join(d.trashDir, a.id)))

// 汇总
console.log(`\n=== ${pass} passed, ${fail} failed ===`)
if (fail) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  - ' + f)
  console.log(`\n沙盒留在 ${SANDBOX} 供复核`)
} else {
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 留着也无害 */ }
}
process.exit(fail ? 1 : 0)
