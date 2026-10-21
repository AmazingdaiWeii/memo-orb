/**
 * 把 Orb 打包成隔离工作区 E:\Memo orb   v3
 *
 * 三代演进（都在这一行前面留痕，因为每一条都是踩出来的）：
 *  v1：用一个全局 SKIP_EXT 排除 png/gif/mp4 —— 误伤了 helper/ 的前端素材（42 MB，
 *      运行期必需）和 node_modules 里 8 个文件。**只对 probe/ 排除截图。**
 *  v2：改成目录白名单 + 文件白名单。**又错了**：根目录文件是硬编码列表
 *      （只有 4 个 json），漏掉了 `鲸鱼娘_persona.md`（*运行期必需*，
 *      src/persona.mjs:24 要读它）；而复核只遍历 FULL_DIRS + probe，
 *      **从不检查根文件** ⇒ 报告写「全部一致，打包成功」，实际缺关键文件。
 *  v3（本版）：
 *      ① 根目录 **不再用白名单** —— 遍历顶层，除显式 SKIP 外**一律拷**。
 *      ② 复核改成 **全树逐文件核对**（源有的每个文件，在目标里必须存在且字节数相同），
 *         并把「主动跳过」逐条列出来 —— 让「100% 覆盖」这句话有意义。
 *      ③ 带上 runtime/（执行方要能真跑起 orb，才验得了 UI 集成）。
 *
 * 教训（记牢）：**复核函数必须覆盖「你实际改动的东西」，否则它是安慰剂。**
 *
 * 用法：node tools/pack-sandbox.mjs
 */

import { mkdirSync, readdirSync, statSync, copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'

const SRC = 'E:\\Orb'
const DST = 'E:\\Memo orb'

// ── 顶层整目录：完整拷贝，不排除任何扩展名 ─────────────────────────
// runtime/ 也带：执行方要能真启动 orb（否则 UI 集成改了没处验）。
const FULL_DIRS = [
  'src', 'helper', 'helper-src', 'node_modules', 'tools', 'docs',
  'runtime', 'generated-images', 'preview-status-capsule', 'logs',
]
// probe：只排除大体积截图/录像，其余全留（含 .html/.css/.py/.log/.txt）
const PROBE_SKIP = new Set(['.png', '.gif', '.mp4', '.webp', '.jpg', '.jpeg', '.ico'])

// ── 顶层「显式不拷」清单（必须逐条写出理由，复核报告里会列出来） ──────
const SKIP_TOP = new Map([
  ['dist', '925 MB 旧打包产物，已过时，要发布重新打'],
  ['.workbuddy', 'WorkBuddy 自己的工作区记忆/元数据，与 orb 运行无关（11 MB）'],
  ['.userdata', 'Electron 的用户数据缓存（含 Local Storage / Network cookie），运行期垃圾且可能藏会话凭证'],
  ['deco-plan', '情绪动效素材源（57 MB，运行期不用，真素材在 helper/assets/deco/）。★ 故意不带：它下面的 backup/ 躺着 src/main.mjs 等**旧副本**，带了会误导执行方 grep 到错版本'],
])
// 根目录下的零散文件里，只有这两个不拷（其余一律拷）
const SKIP_ROOT_FILES = new Map([
  ['_pack-report.md', '本脚本自己的产物'],
])

const errors = []
const stats = { copied: 0, bytes: 0, skipped: 0 }
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`)

/** 拷一个目录树。skipExt 为 null 表示不排除任何扩展名。 */
function copyTree(srcDir, dstDir, skipExt) {
  mkdirSync(dstDir, { recursive: true })
  let entries
  try { entries = readdirSync(srcDir, { withFileTypes: true }) }
  catch (e) { errors.push({ path: srcDir, err: String(e.code || e.message) }); return }
  for (const en of entries) {
    const s = join(srcDir, en.name)
    const d = join(dstDir, en.name)
    if (en.isDirectory()) { copyTree(s, d, skipExt); continue }
    if (!en.isFile()) continue
    if (skipExt && skipExt.has(extname(en.name).toLowerCase())) { stats.skipped++; continue }
    // ★ 不做任何删除：本沙箱的 safe-delete 守卫会拦「一轮内 >50 个删除」。
    //   copyFileSync 默认就是覆盖写，不需要先删。
    let ok = false
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        copyFileSync(s, d)
        const a = statSync(s).size, b = statSync(d).size
        if (a !== b) throw new Error(`大小不符 ${a} != ${b}`)
        ok = true; stats.copied++; stats.bytes += b
      } catch (e) { if (attempt === 3) errors.push({ path: s, err: String(e.code || e.message) }) }
    }
    if (stats.copied > 0 && stats.copied % 5000 === 0) log(`已拷 ${stats.copied} 个文件…`)
  }
}

/**
 * ★ v3 的复核：**全树逐文件核对**，不是抽样、不是只查白名单里的目录。
 * 源里存在的每个文件（除显式跳过项），目标里必须存在且字节数相同。
 */
function verifyTree() {
  const missing = [], mismatch = []
  let checked = 0, skippedByExt = 0, skippedExplicit = 0, bytes = 0
  ;(function walk(rel) {
    const s = rel ? join(SRC, rel) : SRC
    let es
    try { es = readdirSync(s, { withFileTypes: true }) } catch { return }
    for (const en of es) {
      const r = rel ? `${rel}/${en.name}` : en.name
      if (!rel && SKIP_TOP.has(en.name)) { skippedExplicit++; continue }
      if (!rel && SKIP_ROOT_FILES.has(en.name)) { skippedExplicit++; continue }
      // probe 的截图排除：**只在 probe/ 下生效**（v1 的教训）
      if (r.startsWith('probe/') && PROBE_SKIP.has(extname(en.name).toLowerCase())) {
        skippedByExt++; continue
      }
      if (en.isDirectory()) { walk(r); continue }
      if (!en.isFile()) continue
      checked++
      const a = statSync(join(SRC, r)).size
      bytes += a
      try {
        const b = statSync(join(DST, r)).size
        if (a !== b) mismatch.push(`- \`${r}\`：源 ${a} B ≠ 目标 ${b} B`)
      } catch { missing.push(`- \`${r}\`（源 ${a} B）`) }
    }
  })('')
  return { checked, skippedByExt, skippedExplicit, bytes, missing, mismatch }
}

// ============ 不用预先清空 ============
// ★ 环境实测：本沙箱有 safe-delete 守卫，一次 rmSync 删除超过 50 个文件会被直接拒绝
//   （报 SAFE_DELETE_BULK_CONFIRM_REQUIRED）。copyFileSync 本来就是覆盖写，直接拷即可。
//   本版清单是 v2 的**超集**，不会留下过期文件。
if (!existsSync(DST)) mkdirSync(DST, { recursive: true })

// ============ 拷：顶层目录 ============
for (const d of FULL_DIRS) {
  const s = join(SRC, d)
  if (!existsSync(s)) { log(`跳过（不存在）：${d}/`); continue }
  log(`拷贝 ${d}/ （完整）…`)
  copyTree(s, join(DST, d), null)
}
log('拷贝 probe/ （排除截图素材）…')
copyTree(join(SRC, 'probe'), join(DST, 'probe'), PROBE_SKIP)

// ============ 拷：根目录零散文件（★ 除显式 SKIP 外全拷，不再用白名单） ============
log('拷贝根目录文件（除显式 SKIP）…')
for (const en of readdirSync(SRC, { withFileTypes: true })) {
  if (!en.isFile()) continue
  if (SKIP_ROOT_FILES.has(en.name) || SKIP_TOP.has(en.name)) continue
  const s = join(SRC, en.name), d = join(DST, en.name)
  let ok = false
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    try {
      copyFileSync(s, d)
      const a = statSync(s).size, b = statSync(d).size
      if (a !== b) throw new Error(`大小不符 ${a} != ${b}`)
      ok = true; stats.copied++; stats.bytes += b
    } catch (e) { if (attempt === 3) errors.push({ path: s, err: String(e.code || e.message) }) }
  }
}
mkdirSync(join(DST, 'logs'), { recursive: true })

// ============ 复核：全树 ============
log('复核中（全树逐文件）…')
const R = verifyTree()
const ok = R.missing.length === 0 && R.mismatch.length === 0 && errors.length === 0

const lines = [
  '# 打包复核报告（v3 · 全树逐文件核对）', '',
  `源：${SRC}`, `目标：${DST}`, '',
  '## 总量', '',
  `- 核对文件数：**${R.checked}**（源树里除显式跳过外的每一个文件）`,
  `- 核对字节数：**${R.bytes}**（${(R.bytes / 1048576).toFixed(1)} MB）`,
  `- 本次实际拷贝：${stats.copied} 个 / ${stats.bytes} 字节（${(stats.bytes / 1048576).toFixed(1)} MB）`,
  `- 主动跳过：probe 截图 **${R.skippedByExt}** 个｜显式排除的顶层条目 **${R.skippedExplicit}** 个`,
  `- 缺失：**${R.missing.length}**｜字节不符：**${R.mismatch.length}**｜拷贝报错：**${errors.length}**`,
  '', '## 显式排除清单（为什么没带）', '',
]
for (const [k, why] of SKIP_TOP) lines.push(`- \`${k}/\` —— ${why}`)
lines.push(`- \`probe/\` 下的 ${[...PROBE_SKIP].join(' ')} —— 截图/录像素材，共 ${R.skippedByExt} 个`)
for (const [k, why] of SKIP_ROOT_FILES) lines.push(`- \`${k}\` —— ${why}`)

if (R.missing.length) {
  lines.push('', `## ✗ 源有但目标没有（${R.missing.length} 个，前 100 条）`, '', ...R.missing.slice(0, 100))
}
if (R.mismatch.length) {
  lines.push('', `## ✗ 字节数不符（${R.mismatch.length} 个，前 100 条）`, '', ...R.mismatch.slice(0, 100))
}
if (errors.length) {
  lines.push('', `## ✗ 拷贝报错（${errors.length} 个，前 100 条）`, '', ...errors.slice(0, 100).map(e => `- ${e.path} ⇒ ${e.err}`))
}
lines.push('', ok
  ? '**结论：源树里除上面逐条列出的显式排除项外，全部文件都在目标里、字节数一致。**'
  : '**结论：存在缺失/不符，见上（这就是不能用抽样复核的理由）。**')

writeFileSync(join(DST, '_pack-report.md'), lines.join('\n'), 'utf8')
console.log(lines.join('\n'))
process.exitCode = ok ? 0 : 1
