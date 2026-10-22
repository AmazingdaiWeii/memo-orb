/**
 * 复核「这份副本拷全了没有」。
 *
 * 起因（2026-10-08）：从 E 盘拷到 D 盘时，360 主动防御会**间歇性**拦新落盘的
 * 可执行体，Node 报 `EIO, Access is denied`；而 `cpSync` 在覆盖**中文名**文件时
 * 还会因内部 `unlink` 抛畸形错误**把文件悄悄删掉**。
 * ⇒ 「拷贝没报错」≠「拷全了」，必须回头逐项点一遍。
 *
 * 本脚本**只读**，不动任何文件，不需要参数。
 *   node tools/check-copy.mjs
 * 退出码 0 = 齐全，1 = 有缺。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEST = ROOT  // 本脚本住在被检查的那份副本里

const USE_COLOR = !!process.stdout.isTTY && process.env.NO_COLOR == null
const p = (c) => (s) => (USE_COLOR ? `\x1b[${c}m${s}\x1b[0m` : s)
const C = { dim: p(2), ok: p(32), warn: p(33), bad: p(31), b: p(1) }
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`

// 这份副本必须有的东西（缺一个就跑不起来）
const CRITICAL = [
  'package.json',
  'run.cmd',
  'src/launch.mjs',
  'src/main.mjs',
  'helper/assets/floating.html',
  'helper/assets/shell.js',
  'helper/assets/ring-menu.html',
  'helper/lib/main.js',
  'helper/preload.cjs',
  'runtime/electron/electron.exe',
  // node_modules 不再列为关键：local 引擎零依赖，没有它也能跑。
]

// 最好也要有（缺了不致命，但说明拷贝不全）
const EXPECTED = [
  'config.json',
  'config.example.json',
  'build.ps1',
  'tools/legacy/factory_reset.cmd',
  'dist/start.bat',
  'tools/reset-to-factory.mjs',
]

const INCLUDE_TREES = [
  'runtime', 'dist', 'src', 'helper', 'tools', 'docs',
]

console.log(C.b('\n=== 副本完整性复核 ==='))
console.log(`  这份副本 : ${DEST}`)
console.log('')

let fatal = 0
console.log(C.b('── 关键文件 ──'))
for (const rel of CRITICAL) {
  const f = join(DEST, rel.replace('/', '\\'))
  if (existsSync(f)) {
    const sz = statSync(f).size
    console.log(`  ${C.ok('✓')} ${rel}  ${C.dim(mb(sz))}`)
  } else {
    fatal += 1
    console.log(`  ${C.bad('✗')} ${rel}  ${C.bad('缺失')}`)
  }
}

let warn = 0
console.log(C.b('\n── 次要文件 ──'))
for (const rel of EXPECTED) {
  const f = join(DEST, rel.replace('/', '\\'))
  if (existsSync(f)) {
    console.log(`  ${C.ok('✓')} ${rel}`)
  } else {
    warn += 1
    console.log(`  ${C.warn('!')} ${rel}  ${C.warn('缺失（不致命）')}`)
  }
}

console.log(C.b('\n── 目录规模（跟源头对不上的话，多半是没拷完）──'))
function tree(p2) {
  let n = 0, b = 0
  const walk = (d) => {
    let es
    try { es = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else { n += 1; try { b += statSync(full).size } catch { /* skip */ } }
    }
  }
  walk(p2)
  return { n, b }
}
for (const t of INCLUDE_TREES) {
  const f = join(DEST, t)
  if (!existsSync(f)) { console.log(`  ${C.warn('!')} ${t}/ ${C.warn('整个目录缺失')}`); warn += 1; continue }
  const { n, b } = tree(f)
  console.log(`  ${t.padEnd(10)} ${String(n).padStart(7)} 文件  ${mb(b).padStart(11)}`)
}

// node_modules 单独说：local 引擎零依赖，没有它是正常的（只有 engine=legacy 才需要）
const nm = join(DEST, 'node_modules')
console.log('')
if (existsSync(nm)) {
  const { n, b } = tree(nm)
  console.log(`  ${C.ok('✓')} node_modules/ ${String(n).padStart(7)} 文件 ${mb(b)}`)
} else {
  console.log(`  ${C.dim('·')} node_modules/ 不存在 —— local 引擎零依赖，正常`)
}

console.log('')
if (fatal === 0 && warn === 0) {
  console.log(C.ok('✅ 齐全，这份副本可以直接跑。'))
  process.exit(0)
}
if (fatal === 0) {
  console.log(C.warn(`⚠️ 关键文件都在，但有 ${warn} 处小缺口（见上）。多半不影响启动。`))
  process.exit(0)
}
console.log(C.bad(`❌ 有 ${fatal} 个关键文件缺失 —— 这份副本不完整，跑不起来。`))
console.log(C.dim('   回到母本重跑一次迁移即可（幂等，已拷好的会秒过）：'))
console.log(C.dim('     migrate_to_D.cmd -> 选 3'))
process.exit(1)
