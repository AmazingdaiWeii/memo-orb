/**
 * 把本工程复制一份到 D:\Orb（**复制，不是移动** —— E 盘母本原封不动）。
 *
 * 为什么要复制而不是直接改 E 盘：
 *   用户要「先实际用一段时间确认功能正常」，所以需要一份独立副本做试验田，
 *   母本留着随时对照 / 回滚。
 *
 * ★ 为什么不顺手做出厂化：
 *   出厂化会清 `~/.legacy`（**全局**，E/D 共用），E 盘母本的记忆也会一起归零。
 *   所以它必须是一个**独立的、用户明确点头的**动作，不该藏在拷贝脚本里偷偷做。
 *   本脚本只拷贝；出厂化交给 tools/reset-to-factory.mjs（预演 → --apply）。
 *
 * 用法：
 *   node tools/migrate-to-D.mjs                  # 预演：只列要拷什么、多大、够不够地
 *   node tools/migrate-to-D.mjs --apply          # 真拷
 *   node tools/migrate-to-D.mjs --apply --force  # 目标非空也照拷（会覆盖同名文件）
 *   node tools/migrate-to-D.mjs --dest D:\xxx    # 换目标目录
 */

import {
  cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const FORCE = argv.includes('--force')

const destIdx = argv.indexOf('--dest')
const DEST = resolve(destIdx >= 0 && argv[destIdx + 1] ? argv[destIdx + 1] : 'D:\\Orb')

/**
 * 要带走的清单（用户 2026-10-08 拍板：「精简 + 保留 dist」）。
 *
 * 跳过的东西及其理由 —— 别顺手加回来：
 *   probe/            88 MB 本机验证脚本与证据，D 盘副本不需要（要验在 E 盘验）
 *   helper-src/       68 MB 上游源码副本，只读参考
 *   deco-plan/        57 MB 素材制作过程目录，运行时不读
 *   generated-images/ 5 MB  出图中间产物
 *   .userdata/        4 MB  Electron 临时数据，启动会重建
 *   .workbuddy/       11 MB AI 助手工作记忆，私有
 *   logs/             运行日志，D 盘副本会重新长
 *   node_modules/     454 MB 与源码无关的依赖树（下面单独处理：要么拷、要么提示重装）
 */
const INCLUDE = [
  'runtime',        // 365 MB Electron，必须带（不然 run.cmd 起不来）
  'dist',           // 855 MB 已打好的包（用户选保留）
  'src',
  'helper',
  'tools',
  'docs',
  'deco-plan/CONFIG.md',   // 只带这一份用户已确认的落点文档，不带 57 MB 素材
  'package.json',
  'package-lock.json',
  'build.ps1',
  'run.cmd',
  'config.example.json',
  'config.json',
  'locks.json',
  '.gitignore',
  'README.md',
  '目录.md',
  '鲸鱼娘_persona.md',
]

// 跳过项 → 理由（列清单时要打给用户看，所以必须显式）
const SKIP_REASON = {
  'probe': '本机验证脚本与证据，D 盘副本不需要（要验就在 E 盘验）',
  'helper-src': '上游源码副本，只读参考',
  'generated-images': '出图中间产物',
  '.userdata': 'Electron 临时数据，首次启动会重建',
  '.workbuddy': 'AI 助手工作记忆，私有',
  'logs': '运行日志，D 盘副本会重新长',
  'preview-status-capsule': '预览草稿，非交付物',
  'node_modules': '与源码无关的依赖树（下面单独说明，重装即可）',
}
const SKIP = new Set(Object.keys(SKIP_REASON))

// ---------------------------------------------------------------- 工具
const USE_COLOR = !!process.stdout.isTTY && process.env.NO_COLOR == null
const paint = (c) => (s) => (USE_COLOR ? `\x1b[${c}m${s}\x1b[0m` : s)
const C = { dim: paint(2), ok: paint(32), warn: paint(33), bad: paint(31), b: paint(1) }
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`

function treeStat(p) {
  if (!existsSync(p)) return { files: 0, bytes: 0 }
  const st = statSync(p)
  if (!st.isDirectory()) return { files: 1, bytes: st.size }
  let files = 0, bytes = 0
  const walk = (d) => {
    let es
    try { es = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else { files += 1; try { bytes += statSync(full).size } catch { /* 跳过读不到的 */ } }
    }
  }
  walk(p)
  return { files, bytes }
}

/** 目标盘剩余空间（Node ≥18.15 有 statfsSync；拿不到就返回 null，不编数字） */
function freeSpace(p) {
  try {
    const st = statfsSync(p)
    return { free: st.bavail * st.bsize, total: st.blocks * st.bsize }
  } catch { return null }
}

// ---------------------------------------------------------------- 前置检查
console.log(C.b('\n===旧后端 Orb · 迁移到 D 盘（复制，不动母本）==='))
console.log(`  模式    : ${APPLY ? C.bad('执行（--apply）') : C.ok('预演（默认，不写任何文件）')}`)
console.log(`  源      : ${ROOT}`)
console.log(`  目标    : ${DEST}`)

const problems = []
if (resolve(ROOT).toLowerCase() === DEST.toLowerCase()) {
  problems.push('目标目录和源目录相同 —— 拒绝执行')
}
if (DEST.toLowerCase().startsWith(resolve(ROOT).toLowerCase() + '\\')) {
  problems.push('目标是源的子目录 —— 会无限递归，拒绝执行')
}
if (!existsSync(ROOT)) problems.push(`找不到源目录：${ROOT}`)

let destNonEmpty = false
if (existsSync(DEST)) {
  try { destNonEmpty = readdirSync(DEST).length > 0 } catch { /* 读不到当空 */ }
  // ★ 只有**真拷**时才因「目标非空」拦人。预演不带 --force 也应当能看清单 ——
  //   否则用户第一次跑完、想再看一眼清单，会被一句「非空」挡在门外。
  if (destNonEmpty && APPLY && !FORCE) {
    problems.push(`目标目录非空：${DEST}（加 --force 覆盖同名文件，或先清空）`)
  }
}

if (problems.length) {
  console.log(C.bad('\n✋ 先解决这几件事：'))
  for (const p of problems) console.log('   · ' + p)
  process.exit(1)
}

if (destNonEmpty && !APPLY) {
  console.log(C.warn(`\n注意：目标目录已非空（${DEST}）`))
  console.log(C.dim('  预演照常。真拷时脚本会覆盖同名文件；已拷好的会秒过（幂等）。'))
  console.log(C.dim('  目标里若有不该有的东西，执行前先自己清一下。'))
}

// ---------------------------------------------------------------- 列清单
console.log(C.b('\n── 要拷的东西 ──'))
let totalFiles = 0, totalBytes = 0
for (const rel of INCLUDE) {
  const src = join(ROOT, rel)
  if (!existsSync(src)) {
    console.log(`  ${C.dim('（没有）'.padEnd(9))} ${rel}`)
    continue
  }
  const { files, bytes } = treeStat(src)
  totalFiles += files
  totalBytes += bytes
  console.log(`  ${String(files).padStart(7)} 文件 ${mb(bytes).padStart(10)}  ${rel}`)
}
console.log(`  ${C.b('合计')} ${String(totalFiles).padStart(6)} 文件 ${mb(totalBytes).padStart(10)}`)

// 磁盘余量：D 盘还有没有地方放
{
  const drive = DEST.slice(0, 3) // "D:\"
  const fs1 = freeSpace(existsSync(drive) ? drive : ROOT)
  if (fs1) {
    const enough = fs1.free > totalBytes * 1.15
    console.log(
      `  ${C.dim('目标盘余量')} ${mb(fs1.free)} / ${mb(fs1.total)}` +
      `  ${enough ? C.ok('够') : C.bad('不够（差 ' + mb(totalBytes * 1.15 - fs1.free) + '）')}`
    )
  } else {
    console.log(`  ${C.dim('目标盘余量：读不到（不影响拷贝，自己确认一下）')}`)
  }
}

console.log(C.b('\n── 不带的（及其理由）──'))
for (const d of SKIP) {
  const p = join(ROOT, d)
  if (!existsSync(p)) continue
  const { files, bytes } = treeStat(p)
  console.log(`  ${String(files).padStart(7)} 文件 ${mb(bytes).padStart(10)}  ${d}/  ${C.dim(SKIP_REASON[d] ?? '')}`)
}

console.log(C.b('\n── node_modules ──'))
const nmSrc = join(ROOT, 'node_modules')
if (existsSync(nmSrc)) {
  const { files, bytes } = treeStat(nmSrc)
  console.log(`  源里有 ${files} 文件 / ${mb(bytes)}`)
  console.log(C.dim('  默认**不拷**：D 盘副本首次启动前，在 D 盘跑一次 `npm install` 重建即可'))
  console.log(C.dim('  （如坚持要拷，把 node_modules 加进 INCLUDE。但 454 MB + D 盘只剩 16.5 GB，不划算）'))
}

// ---------------------------------------------------------------- 干
if (!APPLY) {
  console.log(C.ok('\n预演结束，什么都没写。'))
  console.log(`确认无误后执行：${C.b('node tools/migrate-to-D.mjs --apply')}`)
  console.log(C.dim('（拷完再跑出厂化：factory_reset.cmd → 选 1 预演 → 选 4 执行）'))
  process.exit(0)
}

/**
 * ★★ 带重试的拷贝 —— 本机实测必需，不是保险起见。
 *
 * 2026-10-08 用户首次执行时在 `runtime` 上抛
 *   `EIO, Access is denied. '\\?\D:\Orb\runtime\electron'`
 * 复现排查结论：**360 主动防御（`ZhuDongFangYu.exe`）在拦**。
 *   注册表 `HKLM\SOFTWARE\WOW6432Node\360Safe\safemon`：
 *   `ExecAccess=0`（可执行监控开）、`FileMonAccess=1`、`AppMonAccess=1`。
 *   它逐文件嗅探**新落盘的可执行体**（`electron.exe` 244 MB 是最肥的目标），
 *   嗅探窗口内文件被独占 ⇒ Node 报 EIO/EACCES。
 *   **间歇性**：手工重跑同样的拷贝 3/3 全过，所以不能靠「运气好」蒙过去。
 *
 * 对策（三层，从轻到重）：
 *   ① 整个目录的 cpSync 失败 ⇒ **退化成逐文件拷**（不放弃整棵树）；
 *   ② 每个文件失败 ⇒ **退避重试**（200ms→400ms→800ms，嗅探一过就能写）；
 *   ③ 仍失败 ⇒ 记进 `failed[]`，**最后统一报告**，不静默丢。
 *
 * ⚠️ 睡眠必须用**同步**忙等（`sleepSync`），**不能用 `Atomics.wait`**：
 *   在本线程里 `Atomics.wait` 直接抛/立即返回，起不到退避作用，
 *   而且会让「本来成功」的拷贝被误判成失败
 *   （2026-10-08 实测：两个中文名 .md 明明拷好了，却被记进 failed[]）。
 */
function sleepSync(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) { /* 忙等，最多几百毫秒 */ }
}

function cpFileRetry(src, dst, tries = 4) {
  let lastErr = null
  for (let i = 0; i < tries; i += 1) {
    try {
      mkdirSync(dirname(dst), { recursive: true })
      // ★★ 目标已存在时**先自己删掉**，别让 cpSync 去删。
      //
      //   2026-10-08 实测：`cpSync(src, dst, {force:true})` 在目标已存在、且
      //   文件名含中文时，内部 `unlink` 抛出一个**畸形错误**：
      //       code:"" errno:0 syscall:"unlink"
      //       msg : ", The operation completed successfully. '\\?\D:\...\目录.md'"
      //   更要命的是：那个名字此后 **Node 自己 stat 不到**（ENOENT），
      //   文件在资源管理器里却在 —— 典型的 ANSI/UTF-8 名字解析不一致。
      //   先 unlink 再写（写的是**全新**路径），就绕开了这条坏分支。
      if (existsSync(dst)) {
        try { rmSync(dst, { force: true }) } catch { /* 删不掉就走下面的重试 */ }
      }
      cpSync(src, dst, { force: true, errorOnExist: false })
      const a = statSync(src).size
      const b = statSync(dst).size
      if (a === b) return null
      lastErr = Object.assign(new Error(`大小不符 src=${a} dst=${b}`), { code: 'ESIZE' })
    } catch (err) {
      lastErr = err
    }
    const transient = ['EIO', 'EACCES', 'EBUSY', 'EPERM', 'ESIZE', 'UNKNOWN', '', undefined]
      .includes(lastErr?.code)
    if (!transient) return lastErr
    if (i < tries - 1) sleepSync(200 * 2 ** i)
  }
  return lastErr
}

/** 逐文件拷一整棵树；返回 [okCount, failedList] */
function cpTreeWithRetry(src, dst, failed) {
  let ok = 0
  const walk = (s, d) => {
    let st
    try { st = statSync(s) } catch { return }
    if (!st.isDirectory()) {
      const err = cpFileRetry(s, d)
      if (err) failed.push({ path: s, code: err.code, msg: err.message })
      else ok += 1
      return
    }
    try { mkdirSync(d, { recursive: true }) } catch { /* 下面逐文件还会再报 */ }
    let es
    try { es = readdirSync(s, { withFileTypes: true }) } catch { return }
    for (const e of es) walk(join(s, e.name), join(d, e.name))
  }
  walk(src, dst)
  return ok
}

console.log(C.b('\n=== 开始拷贝 ==='))
mkdirSync(DEST, { recursive: true })
let done = 0
const failed = []
let usedFallback = 0

for (const rel of INCLUDE) {
  const src = join(ROOT, rel)
  if (!existsSync(src)) continue
  const dst = join(DEST, rel)
  const single = !statSync(src).isDirectory()
  try {
    mkdirSync(dirname(dst), { recursive: true })
    if (single) {
      // 单文件也走带重试+先删后写的路径（中文名在覆盖时会踩 unlink 的坑）
      const err = cpFileRetry(src, dst)
      if (err) throw err
    } else {
      cpSync(src, dst, { recursive: true, force: true, errorOnExist: false })
    }
    done += 1
    console.log(`  ${C.ok('✓')} ${rel}`)
  } catch (err) {
    // ① 整目录失败 ⇒ 退化成逐文件（360 拦的是单文件，逐文件重试就能过去）
    usedFallback += 1
    console.log(`  ${C.warn('!')} ${rel}  ${C.dim(`${err.code ?? ''} ${err.message}`)}`)
    console.log(`      ${C.dim('→ 退化成逐文件重试…')}`)
    const before = failed.length
    const ok = cpTreeWithRetry(src, dst, failed)
    done += 1
    const stillBad = failed.length - before
    console.log(`      ${C.ok(`逐文件完成：${ok} 个`)}${stillBad ? C.bad(` / 待重试 ${stillBad}`) : ''}`)
  }
}

// ---------------------------------------------------------------- 复核
// ★ 「拷贝没报错」≠「拷全了」。360 是**静默**挡一部分，所以必须回头数一遍。
console.log(C.b('\n=== 复核（对比源与目标）==='))
let missFiles = 0
let missBytes = 0
const missSamples = []
function verifyTree(src, dst, depth = 0) {
  let es
  try { es = readdirSync(src, { withFileTypes: true }) } catch { return }
  for (const e of es) {
    const s = join(src, e.name)
    const d = join(dst, e.name)
    if (e.isDirectory()) {
      verifyTree(s, d, depth + 1)
      continue
    }
    if (!existsSync(d)) {
      missFiles += 1
      if (missSamples.length < 12) missSamples.push(join(src.slice(ROOT.length + 1), e.name))
      continue
    }
    try {
      const a = statSync(s).size
      const b = statSync(d).size
      if (a !== b) {
        missFiles += 1
        missBytes += Math.abs(a - b)
        if (missSamples.length < 12) {
          missSamples.push(`[大小不符 ${a}≠${b}] ${join(src.slice(ROOT.length + 1), e.name)}`)
        }
      }
    } catch { /* 读不到就算了 */ }
  }
}
for (const rel of INCLUDE) {
  const s = join(ROOT, rel)
  const d = join(DEST, rel)
  if (!existsSync(s)) continue
  if (statSync(s).isDirectory()) verifyTree(s, d)
  else if (!existsSync(d)) { missFiles += 1; missSamples.push(rel) }
}

const retryFailed = failed.length
const issueCount = missFiles + retryFailed

if (issueCount === 0) {
  console.log(`  ${C.ok('✓ 源与目标逐文件一致（大小全对，无缺失）')}`)
} else {
  console.log(`  ${C.bad(`✗ 还差 ${missFiles} 个文件${missBytes ? ` / ${mb(missBytes)}` : ''}（另有 ${retryFailed} 个重试未过）`)}`)
  for (const s of missSamples) console.log(`     · ${s}`)
  if (missFiles > missSamples.length) console.log(`     · …还有 ${missFiles - missSamples.length} 个`)
  console.log('')
  console.log(C.warn('  这多半是杀软（360 主动防御）在间歇性拦新落盘的可执行体。'))
  console.log(C.dim('  重跑一次即可补上 —— 脚本是幂等的，已拷好的会秒过：'))
  console.log(`    ${C.b(`node tools/migrate-to-D.mjs --apply --force --dest "${DEST}"`)}`)
}

console.log(C.b('\n=== 收尾 ==='))
console.log(`  拷了 ${done}/${INCLUDE.length} 项，约 ${mb(totalBytes)}`)
if (usedFallback) console.log(C.dim(`  （其中 ${usedFallback} 项走了逐文件重试）`))
console.log(`  母本 ${C.ok('原封不动')}：${ROOT}`)
console.log('')
if (issueCount === 0) {
  console.log(C.b('  下一步（在 D 盘副本里做）：'))
  console.log(`    1. cd /d ${DEST}`)
  console.log('    2. npm install            ← 重建 node_modules')
  console.log('    3. run.cmd                ← 试跑，确认能起来')
  console.log('    4. factory_reset.cmd      ← 出厂化（选 1 预演，确认后选 4 执行）')
  console.log('')
  console.log(C.warn('  ⚠️ 出厂化清的是 ~/.legacy（全局），母本的记忆也会一起归零 —— 有备份可回滚。'))
} else {
  console.log(C.bad('  ⚠️ 先把上面缺的文件补齐，再往下走。'))
}
console.log('')
process.exit(issueCount === 0 ? 0 : 2)
