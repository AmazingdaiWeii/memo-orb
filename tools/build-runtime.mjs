/**
 * 把母本（E:\Memo orb）构建成一个**可直接双击运行的干净目录**。
 *
 * ★ 目标形态（用户 2026-10-08 拍板）：
 *   ① 目录绝对干净 —— 只有「依赖 + 程序 + 美术素材」。
 *      任何工程过程文档（docs/、*.md 说明、deco-plan/、tools/、dist/、*.cmd、
 *      *.ps1、.gitignore、locks.json…）一概不带 —— 她是**会读磁盘文件**的，
 *      带过去等于让她看见不该看见的东西。
 *   ② 最终是一个 exe，双击就跑，不需要敲命令。
 *
 * 为什么是「Electron 运行时整包 + resources\app\」这个形态：
 *   Electron 的 exe **必须与它的 pak / dll / locales / resources 同级**
 *   （实测：pak 和 dll 在 exe 所在目录根，不在 resources\ 里），
 *   所以它不能被塞进 `runtime\electron\` 子目录然后指望从根目录双击。
 *   双击 exe 时 **没有命令行参数**，Electron 于是按老规矩去找
 *   `<exe同目录>\resources\app\package.json` 的 `main`。
 *   这就是 electron-builder / electron-packager 产物的标准形态。
 *
 *   ```
 *   D:\Orb\
 *     orb.exe              ← electron.exe 改名（★ 顺带绕开 360 按文件名拦截）
 *     *.dll *.pak *.bin    ← 依赖（Electron 运行时）
 *     locales\ resources\
 *     resources\app\       ← 程序 + 美术素材 + 依赖
 *       package.json  config.json  鲸鱼娘_persona.md
 *       src\  helper\  node_modules\
 *   ```
 *
 * 为什么敢给 electron.exe 改名：`src/launch.mjs` 里那套 360 自愈
 * （`orb-runtime.exe`）已经实测证明「Electron 不依赖 exe 名字，
 * Chromium 从 resources/ 加载资源，exe 只是入口」。这里直接一步到位。
 *
 * 用法：
 *   node tools/build-runtime.mjs                       # 预演
 *   node tools/build-runtime.mjs --apply               # 真建
 *   node tools/build-runtime.mjs --apply --dest D:\X   # 换目标
 *   node tools/build-runtime.mjs --apply --smoke       # 建完顺手冒烟（起 12 秒再杀）
 *
 * ⚠️ 目标目录若已非空，会被**改名搬走**成 `_old_<名字>_<时间戳>`（同盘改名是瞬时的，
 *    可回滚），不会直接删。
 */

import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync, statfsSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractPersona } from '../src/persona.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const SMOKE = argv.includes('--smoke')
const KEEP_OLD = argv.includes('--keep-old')

const destIdx = argv.indexOf('--dest')
const DEST = resolve(destIdx >= 0 && argv[destIdx + 1] ? argv[destIdx + 1] : 'D:\\Orb')

/** 应用目录（Electron 双击时唯一会去找的地方）。 */
const APP = join(DEST, 'resources', 'app')

// ---------------------------------------------------------------- 显示
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
      else { files += 1; try { bytes += statSync(full).size } catch { /* 读不到跳过 */ } }
    }
  }
  walk(p)
  return { files, bytes }
}

// ---------------------------------------------------------------- 拷贝（带重试）
/**
 * ★★ 这两个坑都是 2026-10-08 本机实测，不是保险起见：
 *   ① 360 主动防御会**间歇性**独占新落盘的可执行体 ⇒ EIO / EACCES。
 *      对策是重试 + 退避，**不是关杀软**。
 *   ② `cpSync(dst 已存在, {force:true})` 在**中文文件名**上会走坏掉的 unlink 分支：
 *      抛一个 `code:""` 的畸形错误，且**文件已被删掉、写入却失败** ⇒ 静默丢文件。
 *      对策：**自己先 rmSync**，往全新路径写。
 *   ③ 退避必须**同步忙等**，`Atomics.wait` 在同线程立即返回，等于没退避，
 *      还会把成功的文件误记成失败。
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
      if (existsSync(dst)) {
        try { rmSync(dst, { force: true }) } catch { /* 删不掉就走重试 */ }
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
    try { mkdirSync(d, { recursive: true }) } catch { /* 逐文件时还会报 */ }
    let es
    try { es = readdirSync(s, { withFileTypes: true }) } catch { return }
    for (const e of es) walk(join(s, e.name), join(d, e.name))
  }
  walk(src, dst)
  return ok
}

/** 拷一项（文件或目录）：整拷失败就退化成逐文件重试。 */
function copyItem(src, dst, label, failed) {
  if (!existsSync(src)) {
    console.log(`  ${C.dim('（没有）'.padEnd(9))} ${label}`)
    return false
  }
  const single = !statSync(src).isDirectory()
  try {
    mkdirSync(dirname(dst), { recursive: true })
    if (single) {
      const err = cpFileRetry(src, dst)
      if (err) throw err
    } else {
      cpSync(src, dst, { recursive: true, force: true, errorOnExist: false })
    }
    return true
  } catch (err) {
    console.log(`      ${C.dim(`→ ${label} 整拷受阻（${err.code ?? ''}），退化成逐文件…`)}`)
    const ok = cpTreeWithRetry(src, dst, failed)
    console.log(`      ${C.dim(`   逐文件完成 ${ok} 个`)}`)
    return true
  }
}

// ---------------------------------------------------------------- persona 剥离
/**
 * ★ 母本那份 `鲸鱼娘_persona.md` 是 **536 行 / 40 KB**，其中真正进 prompt 的
 *   只有两个围栏块；其余全是**给人看的**设计说明 —— 而且里面写着
 *   「v3 改了什么」「她自己的诊断（conv-62 原话）」「注入落盘记录（含 agent id）」。
 *   她是**会读磁盘文件**的，整份带过去等于把这些一起递给她。
 *
 *   所以这里只导出**正文**，说明留在母本。
 *   验收：`readPersona(mode, {file: 剥离版})` 的 sha256 必须与母本**逐字节相同**。
 */
function buildStrippedPersona() {
  const src = readFileSync(join(ROOT, '鲸鱼娘_persona.md'), 'utf8')
  const chat = extractPersona(src, 'chat')
  return [
    '# 鲸鱼娘 · 人格正文（运行时副本）',
    '',
    '> 本文件**只有正文**（一个围栏块）。设计说明、版本演进、注入记录已剥离 ——',
    '> 那些是给人看的，而她会读这个文件。母本保留完整版，不随程序分发。',
    '',
    '## 二、A. 初始人格全文',
    '',
    '```',
    chat,
    '```',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------- 前置检查
console.log(C.b('\n=== Orb · 构建干净运行目录 ==='))
console.log(`  模式 : ${APPLY ? C.bad('执行（--apply）') : C.ok('预演（默认，不写任何文件）')}`)
console.log(`  源   : ${ROOT}`)
console.log(`  目标 : ${DEST}`)

const problems = []
if (resolve(ROOT).toLowerCase() === DEST.toLowerCase()) {
  problems.push('目标和源是同一个目录 —— 拒绝执行')
}
if (DEST.toLowerCase().startsWith(resolve(ROOT).toLowerCase() + '\\')) {
  problems.push('目标是源的子目录 —— 会无限递归，拒绝执行')
}
for (const must of ['package.json', 'src/main.mjs', 'helper/lib/main.js', 'config.json', '鲸鱼娘_persona.md']) {
  if (!existsSync(join(ROOT, must))) problems.push(`母本缺 ${must}`)
}
const ELEC = join(ROOT, 'runtime', 'electron')
if (!existsSync(join(ELEC, 'electron.exe'))) problems.push(`母本缺 runtime/electron/electron.exe`)

if (problems.length) {
  console.log(C.bad('\n✋ 先解决这几件事：'))
  for (const p of problems) console.log('   · ' + p)
  process.exit(1)
}

// ---------------------------------------------------------------- 清单
// ★ Electron 运行时里**不该带**的东西
const ELEC_SKIP = new Set(['debug.log'])
const isElecSkip = (n) => ELEC_SKIP.has(n) || n.startsWith('.complete')
// ★ Electron 自身的 resources/ 单独处理（要往里塞我们的 app）
const ELEC_RESOURCES = 'resources'

// node_modules 在 local 引擎下不需要（零依赖）。存在才收，不存在不报错 ——
// 否则 treeStat 会对着一个不存在的目录当场抛 ENOENT。
const APP_DIRS = ['src', 'helper', ...(existsSync(join(ROOT, 'node_modules')) ? ['node_modules'] : [])]
const APP_FILES = ['package.json', 'package-lock.json', 'config.json']

console.log(C.b('\n── 会进去的东西 ──'))
let totalFiles = 0, totalBytes = 0
const plan = []
{
  // Electron 运行时（到目标根，electron.exe 改名 orb.exe）
  const es = readdirSync(ELEC, { withFileTypes: true })
  for (const e of es) {
    if (e.isDirectory() && e.name === ELEC_RESOURCES) continue
    if (isElecSkip(e.name)) continue
    const { files, bytes } = treeStat(join(ELEC, e.name))
    totalFiles += files
    totalBytes += bytes
    const out = e.name === 'electron.exe' ? 'orb.exe' : e.name
    plan.push({ kind: 'root', src: join(ELEC, e.name), dst: join(DEST, out), label: out })
  }
  // Electron 自带 resources/
  {
    const { files, bytes } = treeStat(join(ELEC, ELEC_RESOURCES))
    totalFiles += files
    totalBytes += bytes
    plan.push({
      kind: 'root', src: join(ELEC, ELEC_RESOURCES), dst: join(DEST, 'resources'),
      label: 'resources\\（Electron 自带）',
    })
  }
  // 程序 + 美术素材 + 依赖
  for (const d of APP_DIRS) {
    const { files, bytes } = treeStat(join(ROOT, d))
    totalFiles += files
    totalBytes += bytes
    plan.push({ kind: 'app', src: join(ROOT, d), dst: join(APP, d), label: `resources\\app\\${d}\\` })
  }
  for (const f of APP_FILES) {
    const { files, bytes } = treeStat(join(ROOT, f))
    totalFiles += files
    totalBytes += bytes
    plan.push({ kind: 'app', src: join(ROOT, f), dst: join(APP, f), label: `resources\\app\\${f}` })
  }
  plan.push({ kind: 'persona', label: 'resources\\app\\鲸鱼娘_persona.md（★ 已剥离说明）' })

  for (const p of plan) {
    const { files, bytes } = p.src ? treeStat(p.src) : { files: 1, bytes: 0 }
    console.log(`  ${String(files).padStart(6)} 文件 ${mb(bytes).padStart(10)}  ${p.label}`)
  }
  console.log(`  ${C.b('合计')} ${String(totalFiles).padStart(5)} 文件 ${mb(totalBytes).padStart(10)}`)
}

{
  const st = statfsSync(existsSync(DEST.slice(0, 3)) ? DEST.slice(0, 3) : ROOT)
  const enough = st.bavail * st.bsize > totalBytes * 1.1
  console.log(`  ${C.dim('目标盘余量')} ${mb(st.bavail * st.bsize)} / ${mb(st.blocks * st.bsize)}  ${enough ? C.ok('够') : C.bad('不够')}`)
}

// ★ 明确列出**不带**的 —— 这是本脚本存在的理由
console.log(C.b('\n── 不带（她是会读磁盘文件的，这些都会让她看见不该看见的）──'))
const NOT_SHIPPED = [
  ['docs\\', '工程讨论纪要 / 协议笔记 / bug 复盘'],
  ['*.md（根目录）', 'README.md · 目录.md · 鲸鱼娘_persona.md 全量稿 · .bak'],
  ['deco-plan\\', '情绪素材制作过程目录（56.7 MB，运行时不读）'],
  ['tools\\', '开发工具（出厂化 / 打包 / 迁移）—— 这些在母本跑，目标是本目录内的 data\\'],
  ['dist\\', '构建产物，且与本目录重复 891 MB'],
  ['probe\\', '本机验证脚本与证据'],
  ['*.cmd / *.ps1 / .gitignore', '开发期启动器与构建脚本 —— 改成双击 orb.exe'],
  ['locks.json', '运行态锁，开机自会长'],
]
for (const [name, why] of NOT_SHIPPED) {
  console.log(`  ${C.bad('✗')} ${name.padEnd(26)} ${C.dim(why)}`)
}

// persona 验收（预演也做 —— 早发现）
{
  const stripped = buildStrippedPersona()
  const { extractPersona: _e } = { extractPersona }
  const chatA = _e(readFileSync(join(ROOT, '鲸鱼娘_persona.md'), 'utf8'), 'chat')
  const chatB = _e(stripped, 'chat')
  const same = chatA === chatB
  console.log(C.b('\n── persona 剥离校验 ──'))
  console.log(`  母本 ${mb(Buffer.byteLength(readFileSync(join(ROOT, '鲸鱼娘_persona.md'), 'utf8')))} → 剥离后 ${mb(Buffer.byteLength(stripped))}`)
  console.log(`  正文逐字节一致：${same ? C.ok('✓（chat 块对得上）') : C.bad('✗ 不一致，别发')}`)
  if (!same) process.exit(1)
}

if (!APPLY) {
  console.log(C.ok('\n预演结束，什么都没写。'))
  console.log(`确认后执行：${C.b(`node tools/build-runtime.mjs --apply --dest "${DEST}"`)}`)
  process.exit(0)
}

// ---------------------------------------------------------------- 动手
console.log(C.b('\n=== 开始构建 ==='))

// 旧目标目录：改名搬走（同盘瞬时，可回滚），不直接删
if (existsSync(DEST)) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  const backup = `${DEST}_old_${stamp}`
  if (KEEP_OLD) {
    console.log(C.warn(`  --keep-old：保留原目录，直接覆盖同名文件`))
  } else {
    console.log(`  原目录已存在 → 先改名搬走：${backup}`)
    renameSync(DEST, backup)
    console.log(C.dim(`  （确认新目录没问题后，自己删掉它）`))
  }
}
mkdirSync(DEST, { recursive: true })
mkdirSync(APP, { recursive: true })

const failed = []
for (const p of plan) {
  if (p.kind === 'persona') {
    writeFileSync(join(APP, '鲸鱼娘_persona.md'), buildStrippedPersona(), 'utf8')
    console.log(`  ${C.ok('✓')} ${p.label}`)
    continue
  }
  const ok = copyItem(p.src, p.dst, p.label, failed)
  console.log(`  ${ok ? C.ok('✓') : C.dim('·')} ${p.label}`)
}

// ---------------------------------------------------------------- 复核
console.log(C.b('\n=== 复核 ==='))
const CRITICAL = [
  ['orb.exe', join(DEST, 'orb.exe')],
  ['resources\\app\\package.json', join(APP, 'package.json')],
  ['resources\\app\\config.json', join(APP, 'config.json')],
  ['resources\\app\\鲸鱼娘_persona.md', join(APP, '鲸鱼娘_persona.md')],
  ['resources\\app\\src\\main.mjs', join(APP, 'src', 'main.mjs')],
  ['resources\\app\\helper\\lib\\main.js', join(APP, 'helper', 'lib', 'main.js')],
  ['resources\\app\\helper\\assets\\floating.html', join(APP, 'helper', 'assets', 'floating.html')],
]

let bad = 0
for (const [name, p] of CRITICAL) {
  const ok = existsSync(p)
  if (!ok) bad += 1
  console.log(`  ${ok ? C.ok('✓') : C.bad('✗')} ${name}`)
}

// ★ 「干净」验收：目标里不该出现任何文档/工具残留
console.log(C.b('\n── 干净度验收 ──'))
let dirty = 0
const topEntries = readdirSync(DEST, { withFileTypes: true })
for (const e of topEntries) {
  if (e.isDirectory()) continue
  if (/\.(md|cmd|ps1|log)$/i.test(e.name) || e.name === '.gitignore') {
    console.log(`  ${C.bad('✗')} 顶层不该有 ${e.name}`)
    dirty += 1
  }
}
for (const d of ['docs', 'tools', 'dist', 'probe', 'deco-plan', 'logs', '.workbuddy']) {
  if (existsSync(join(DEST, d))) { console.log(`  ${C.bad('✗')} 顶层不该有 ${d}\\`); dirty += 1 }
}
// app 目录里也不该有 md（persona 除外）
for (const f of readdirSync(APP, { withFileTypes: true })) {
  if (!f.isFile()) continue
  if (/\.(md|cmd|ps1)$/i.test(f.name) && f.name !== '鲸鱼娘_persona.md') {
    console.log(`  ${C.bad('✗')} app\\ 不该有 ${f.name}`)
    dirty += 1
  }
}
if (dirty === 0) console.log(`  ${C.ok('✓ 无文档 / 无脚本 / 无构建产物 / 无日志残留')}`)

const issueCount = bad + dirty + failed.length
console.log(C.b('\n=== 收尾 ==='))
console.log(`  目标：${DEST}`)
console.log(`  启动：${C.b('双击 orb.exe')}`)
if (failed.length) {
  console.log(C.bad(`  ✗ ${failed.length} 个文件重试未过（多半是杀软短暂占用，重跑一次即可）`))
  for (const f of failed.slice(0, 10)) console.log(`     · ${f.path}  ${f.code ?? ''}`)
}
console.log('')

if (issueCount > 0) {
  console.log(C.bad('  ⚠️ 有问题，先别用。'))
  process.exit(2)
}

// ---------------------------------------------------------------- 冒烟
if (SMOKE) {
  console.log(C.b('=== 冒烟（起 12 秒后杀掉）==='))
  const { spawn } = await import('node:child_process')
  const logFile = join(APP, 'logs', 'orb.log')
  const child = spawn(join(DEST, 'orb.exe'), [], { cwd: DEST, stdio: 'ignore', detached: false })
  await new Promise((r) => setTimeout(r, 12000))
  try { process.kill(child.pid) } catch { /* 已经退了 */ }
  try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* noop */ }
  await new Promise((r) => setTimeout(r, 1500))
  const logOk = existsSync(logFile)
  console.log(`  ${logOk ? C.ok('✓') : C.bad('✗')} ${join('resources', 'app', 'logs', 'orb.log')} ${logOk ? '已生成 —— Electron 确实加载了 app' : '没生成 —— app 没起来'}`)
  if (logOk) {
    const lines = readFileSync(logFile, 'utf8').trim().split('\n')
    console.log(C.dim(`     共 ${lines.length} 行，末 3 行：`))
    for (const l of lines.slice(-3)) console.log(C.dim(`     ${l}`))
  }
  console.log('')
}

console.log(C.ok('  构建完成。'))
console.log('')
process.exit(0)
