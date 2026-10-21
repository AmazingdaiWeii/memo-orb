/**
 * 出厂化重置 —— 把 orb 恢复到「刚装上、还没跟任何人说过话」的状态。
 *
 * 什么时候用：
 *   打包/开源前必须保证发出去的那一份里**没有开发者的痕迹**。这台机器上，
 *   她的记忆、几十条测试对话、微信机器人 token、B 站登录态、以及 API key
 *   全都躺在 `data/` 里，而 `config.json` 还写着开发者的 agentId。
 *
 * ★★ 为什么必须整个目录搬走，而不是 `git reset --hard`（`reset_memory.cmd` 干的事）：
 *   记忆目录 `data/memfs/<agentId>/memory` 本身是个 git 仓库，`reset --hard HEAD`
 *   只会回到**最近一次提交** —— 也就是「装满了测试记忆」的那一版，不是出厂状态。
 *   整段历史仍然躺在 `.git/objects` 里，`git log` 就能翻出来。唯一干净的做法
 *   是把整个 memfs 目录搬走。
 *
 * ★ 为什么连 agent 一起删、而不是只清记忆：
 *   `src/main.mjs` 的 `ensureRuntime()` 在 config 没有 agentId 时会**新建 agent**，
 *   并把人格文档烤进 system prompt。所以「清干净 + agentId=null」= 下次启动自动
 *   长出一个带当前人格的全新 agent。这比「清空记忆但留着旧 agent」干净得多。
 *
 * ★ 默认是**搬家不是删除**：先 cp 到备份目录再 rm 原处，反悔了拷回来即可。
 *   `--no-backup` 才是真删，别轻易用。
 *
 * 用法：
 *   node tools/reset-to-factory.mjs                # 预演（默认）：只列清单，不动任何文件
 *   node tools/reset-to-factory.mjs --apply        # 执行：先备份，再搬走
 *   node tools/reset-to-factory.mjs --apply --memory-only   # 只清记忆与对话
 *   node tools/reset-to-factory.mjs --apply --no-backup
 *   node tools/reset-to-factory.mjs --apply --force         # orb 还开着也照做（不推荐）
 *
 * ⚠️ 跑之前**先关掉 orb**。它还开着的话：① 文件可能被占用；
 *    ② 它退出时会把内存里的 config 写回去，把 agentId 又填上，白做。
 */

import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
/** 数据根 —— 与 `src/settings.mjs` 同一套解析：env ORB_DATA 优先，否则项目内 data/。 */
const DATA = process.env.ORB_DATA || join(ROOT, 'data')
/**
 * Electron 的 userData —— 由 `src/launch.mjs` 以 `--user-data-dir` 指定。
 * 装着 Local Storage（面板尺寸/透明度这类 UI 状态）、Network（cookie/缓存）、
 * Preferences。不留它的话，重置完窗口状态还是「旧的那一套」。
 * 删掉是安全的：下次启动 Electron 自己重建。
 */
const USERDATA = process.env.ORB_USER_DATA ?? join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local'), 'orb')

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const NO_BACKUP = argv.includes('--no-backup')
const FORCE = argv.includes('--force')
/** 只清「记忆 + 对话」，保留登录态 / API key / 设置。 */
const MEMORY_ONLY = argv.includes('--memory-only')

/** 本地时间戳 —— 用 toISOString 会显示成 UTC，和用户表差 8 小时，看着像日期错了。 */
function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
const stamp = localStamp()
const BACKUP_ROOT = process.env.ORB_FACTORY_BACKUP || join(dirname(ROOT), `Orb_factory_backup_${stamp}`)

// ---------------------------------------------------------------- 小工具
// 输出重定向到文件/管道时不要吐 ANSI 转义 —— 会变成 `←[1m` 这种糊眼的字符。
// 真控制台下 Node 会自行打开 VT 处理，颜色正常显示。
const USE_COLOR = !!process.stdout.isTTY && process.env.NO_COLOR == null
const paint = (code) => (s) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s)
const C = { dim: paint(2), ok: paint(32), warn: paint(33), bad: paint(31), b: paint(1) }

function treeSize(p) {
  if (!existsSync(p)) return { files: 0, bytes: 0 }
  let files = 0
  let bytes = 0
  const walk = (d) => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else {
        files += 1
        try { bytes += statSync(full).size } catch { /* 忽略读不到的 */ }
      }
    }
  }
  walk(p)
  return { files, bytes }
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`

/** 一次「搬走」：先整份拷到备份里，再删原处。跨盘也能用。 */
function moveAway(src, relTo) {
  if (!existsSync(src)) return { skipped: true, files: 0, bytes: 0 }
  const { files, bytes } = treeSize(src)
  if (!APPLY) return { skipped: false, files, bytes }
  if (!NO_BACKUP) {
    const dst = join(BACKUP_ROOT, relTo)
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(src, dst, { recursive: true, force: true })
  }
  rmSync(src, { recursive: true, force: true })
  return { skipped: false, files, bytes }
}

// ---------------------------------------------------------------- 前置检查
function orbRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq electron.exe" /FO CSV /NH', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000,
    })
    return /electron\.exe/i.test(out)
  } catch { return false }
}

const problems = []
const alive = orbRunning()
if (alive && !FORCE) problems.push('检测到 electron.exe 还在跑 —— 先关掉 orb（或加 --force 硬来）')

console.log(C.b('\n=== Orb · 出厂化重置 ==='))
console.log(`  模式      : ${APPLY ? C.bad('执行（--apply）') : C.ok('预演（默认，不动任何文件）')}`)
console.log(`  范围      : ${MEMORY_ONLY ? '只清记忆与对话（保留登录态 / API key / 设置）' : '完整出厂化'}`)
console.log(`  数据根    : ${DATA}`)
console.log(`  项目根    : ${ROOT}`)
console.log(`  备份到    : ${NO_BACKUP && APPLY ? C.bad('不备份（--no-backup）') : BACKUP_ROOT}`)

if (problems.length) {
  console.log(C.bad('\n✋ 先解决这几件事：'))
  for (const p of problems) console.log('   · ' + p)
  if (!APPLY) console.log(C.dim('\n   （预演也会拦，是为了让你先看到真实前提）'))
  process.exit(1)
}

// ---------------------------------------------------------------- 清单
// 每一项：[标题, 绝对路径, 备份里的相对名, 适用范围]
// 适用范围：'mem' = 只清记忆时也清；'all' = 只有完整出厂化才清。
const JOBS = [
  ['memfs/             记忆仓（★ 内含 .git 历史 —— 光 reset 清不掉）', join(DATA, 'memfs'), 'data/memfs', 'mem'],
  ['conversations/     本地聊天记录与会话元数据', join(DATA, 'conversations'), 'data/conversations', 'mem'],
  ['schedule.json      定时提醒', join(DATA, 'schedule.json'), 'data/schedule.json', 'mem'],
  ['workspace/         agent 干活留下的文件', join(DATA, 'workspace'), 'data/workspace', 'all'],
  ['providers/auth.json  API key（★ 绝不能跟着发布包出去）', join(DATA, 'providers'), 'data/providers', 'all'],
  ['wechat.json        微信机器人 token 与配对状态', join(DATA, 'wechat.json'), 'data/wechat.json', 'all'],
  ['wechat-state.json  微信桥运行状态', join(DATA, 'wechat-state.json'), 'data/wechat-state.json', 'all'],
  ['bili-auth.json     B 站登录态（SESSDATA = 账号凭据）', join(DATA, 'bili-auth.json'), 'data/bili-auth.json', 'all'],
  ['dispatch*.json     远程派活记录与目标注册表', join(DATA, 'dispatch.jsonl'), 'data/dispatch.jsonl', 'all'],
  ['logs/              运行日志 + 截图 + 导出的对话', join(ROOT, 'logs'), 'project/logs', 'mem'],
  ['exports/           对话导出（整段明文）', join(ROOT, 'exports'), 'project/exports', 'mem'],
  ['orb/         Electron userData（UI 状态 / cookie / 缓存）', USERDATA, 'appdata/orb', 'all'],
]
const activeJobs = JOBS.filter(([, , , scope]) => (MEMORY_ONLY ? scope === 'mem' : true))

console.log(C.b('\n── 要搬走的东西 ──'))
const plan = []
for (const [label, p, rel] of activeJobs) {
  const existed = existsSync(p)
  const { files, bytes } = existed ? treeSize(p) : { files: 0, bytes: 0 }
  // ★ 记下列清单那一刻它**在不在**。执行阶段要用它区分两件完全不同的事：
  //   「本来就没有」（无害）vs「清单里有、执行时却没了」（= 没备份就丢了，必须喊出来）。
  plan.push({ label, p, rel, existed })
  console.log(`  ${files === 0 ? C.dim('（本来就没有）') : `${String(files).padStart(6)} 文件  ${mb(bytes).padStart(9)}`}  ${label}`)
}
// 派活的状态文件与目标注册表可能不存在（没配过远程派活）
for (const name of ['dispatch-state.json', 'agents-remote.json']) {
  const p = join(DATA, name)
  if (existsSync(p) && !MEMORY_ONLY) {
    plan.push({ label: `${name}  远程派活状态`, p, rel: `data/${name}`, existed: true })
    console.log(`  ${mb(statSync(p).size).padStart(9)}  ${name}`)
  }
}

console.log(C.b('\n── 要重置的项目文件 ──'))
const examplePath = join(ROOT, 'config.example.json')
const configPath = join(ROOT, 'config.json')
const locksPath = join(ROOT, 'locks.json')
if (MEMORY_ONLY) {
  console.log(C.dim('  （--memory-only：config.json / locks.json 都不动）'))
} else {
  const cfgNow = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}
  console.log(`  config.json  → agentId=null（现在：${JSON.stringify(cfgNow.agentId ?? null)}），模型/主题/路径等偏好保留`)
  console.log(`  locks.json   → 删除（含真实密码 hash）${existsSync(locksPath) ? '' : C.dim('（无）')}`)
}

console.log(C.b('\n── 不动的（故意保留）──'))
console.log(`  data/policy.json     权限策略（出厂默认值，缺了会自己重建）`)
console.log(`  config.json 的模型名 / 主题 / locale / electronPath`)
console.log(`  源码、人格文档、helper/ 渲染层  交付内容本身`)

// ---------------------------------------------------------------- 干不干
if (!APPLY) {
  console.log(C.ok('\n预演结束，什么都没动。'))
  const flags = ['--apply', ...(MEMORY_ONLY ? ['--memory-only'] : [])].join(' ')
  console.log(`确认无误后执行：${C.b(`node tools/reset-to-factory.mjs ${flags}`)}`)
  console.log(C.dim('（记得先关掉 orb。）'))
  process.exit(0)
}

// ---------------------------------------------------------------- 执行
console.log(C.b('\n=== 开始执行 ==='))
if (!NO_BACKUP) {
  mkdirSync(BACKUP_ROOT, { recursive: true })
  console.log(C.dim(`备份目录已建：${BACKUP_ROOT}`))
}

let movedFiles = 0
let movedBytes = 0
let vanished = 0
for (const { label, p, rel, existed } of plan) {
  const r = moveAway(p, rel)
  if (r.skipped) {
    // 「本来就没有」和「清单里有、执行时却没了」绝不能混为一谈：
    // 前者无害，后者是「丢了且无法回滚」（2026-10-08 实测踩过）。
    if (existed) {
      vanished += 1
      console.log(`  ${C.bad('⚠ 消失')}  ${label.split(/\s{2,}/)[0]}`)
      console.log(`      ${C.bad('清单里明明有，执行时却没了 —— 没备份就丢了，无法回滚。')}`)
    } else {
      console.log(`  ${C.dim('跳过')}  ${label.split(/\s{2,}/)[0]}`)
    }
    continue
  }
  movedFiles += r.files
  movedBytes += r.bytes
  console.log(`  ${C.ok('搬走')}  ${label.split(/\s{2,}/)[0]}  (${r.files} 文件 / ${mb(r.bytes)})`)
}

if (!MEMORY_ONLY) {
  // config.json：保留原有模型/主题等偏好，只把 agent 归零。
  // ★ agentId=null 是「下次启动新建 agent」的开关，不能省。
  const example = existsSync(examplePath) ? JSON.parse(readFileSync(examplePath, 'utf8')) : {}
  const cfgNow = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}
  const cfgNext = {
    ...example,
    model: cfgNow.model ?? example.model,
    engine: cfgNow.engine ?? example.engine ?? 'local',
    agentName: cfgNow.agentName ?? example.agentName,
    theme: cfgNow.theme ?? example.theme,
    locale: cfgNow.locale ?? example.locale,
    reasoningEffort: cfgNow.reasoningEffort ?? example.reasoningEffort,
    impression: cfgNow.impression ?? example.impression,
    electronPath: cfgNow.electronPath ?? example.electronPath,
    electronFlags: cfgNow.electronFlags ?? example.electronFlags ?? [],
    mainConversations: {},
    agentId: null,
    mode: 'chat',
  }
  if (!NO_BACKUP && existsSync(configPath)) {
    cpSync(configPath, join(BACKUP_ROOT, 'project/config.json'), { force: true })
  }
  writeFileSync(configPath, JSON.stringify(cfgNext, null, 2) + '\n', { encoding: 'utf8' })
  console.log(`  ${C.ok('已重置')}  config.json（agentId=null）`)

  if (existsSync(locksPath)) {
    if (!NO_BACKUP) cpSync(locksPath, join(BACKUP_ROOT, 'project/locks.json'), { force: true })
    rmSync(locksPath, { force: true })
    console.log(`  ${C.ok('已删除')}  locks.json`)
  }
}

// ---------------------------------------------------------------- 复核
console.log(C.b('\n=== 复核（读完再信）==='))
const checks = [
  ['memfs/ 已空', () => !existsSync(join(DATA, 'memfs')) || readdirSync(join(DATA, 'memfs')).length === 0],
  ['conversations/ 已空', () => !existsSync(join(DATA, 'conversations')) || readdirSync(join(DATA, 'conversations')).length === 0],
  ['providers/ 已空（API key 不在包里）', () => MEMORY_ONLY || !existsSync(join(DATA, 'providers'))],
  ['bili-auth.json 已无', () => MEMORY_ONLY || !existsSync(join(DATA, 'bili-auth.json'))],
  ['wechat.json 已无', () => MEMORY_ONLY || !existsSync(join(DATA, 'wechat.json'))],
  ['config.agentId 为 null', () => MEMORY_ONLY || JSON.parse(readFileSync(configPath, 'utf8')).agentId === null],
  ['locks.json 已删', () => MEMORY_ONLY || !existsSync(locksPath)],
  ['orb userData 已清', () => MEMORY_ONLY || !existsSync(USERDATA)],
]
let allOk = true
for (const [name, fn] of checks) {
  let pass = false
  try { pass = fn() } catch { pass = false }
  if (!pass) allOk = false
  console.log(`  ${pass ? C.ok('✅') : C.bad('❌')} ${name}`)
}

console.log(C.b('\n=== 收尾 ==='))
console.log(`  共搬走 ${movedFiles} 个文件 / ${mb(movedBytes)}`)
if (vanished) console.log(C.bad(`  有 ${vanished} 项在执行时已消失（见上面的 ⚠）`))
console.log(`  备份在：${BACKUP_ROOT}`)
console.log(C.dim('  ← 反悔就把备份里的 data/ 与 appdata/ 拷回原位'))
console.log('')
if (!allOk) {
  console.log(C.bad('⚠️ 有复核项没过，先别打包。'))
  process.exit(1)
}
console.log(C.ok(`\n✅ ${MEMORY_ONLY ? '记忆与对话已归零（登录态与设置保留）。' : '已回到出厂状态。'}`))
console.log(MEMORY_ONLY
  ? '   下一步：重启 orb —— 她会**沿用同一个 agent**，但记忆是空的。'
  : '   下一步：跑 run.cmd —— 她会**新建一个 agent 并把当前人格烤进 system**，然后说句话确认通了。')
