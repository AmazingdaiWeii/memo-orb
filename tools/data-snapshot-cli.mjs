#!/usr/bin/env node
/**
 * tools/data-snapshot-cli.mjs · 命令行版存档工具
 *
 * 为什么在面板之前先有这个：面板要动 `main.mjs`（5000+ 行）和 helper 的球面 UI，
 * 风险面大。而"冻结 / 解冻"这件事**不需要**界面就能救急 —— 面板挂不上之前，
 * 命令行至少能让"此刻还能存一次"这件事成立。
 *
 * 用法：
 *   node tools/data-snapshot-cli.mjs                      # 等于 list
 *   node tools/data-snapshot-cli.mjs list
 *   node tools/data-snapshot-cli.mjs freeze [--layers memories,conversations] [--reason 备注]
 *   node tools/data-snapshot-cli.mjs verify <id> [--shallow]
 *   node tools/data-snapshot-cli.mjs thaw <id> [--layers ...] [--dry-run] [--yes]
 *   node tools/data-snapshot-cli.mjs discard <id> [<id>...]
 *
 * ⚠️ 数据根规则与 app 一致：`ORB_DATA` 优先，没设则用 `<项目>/data`。
 *    app 里 `main.mjs` 也是这么定的（`join(ROOT,'data')`），CLI 必须照抄，
 *    否则两边看到的不是同一份数据（`memory.mjs` 的 fallback 是 ~/.legacy，那是旧后端）。
 *
 * ⚠️ thaw 是破坏性的。不带 `--yes` 只打印计划。它自己会先存一份 pre-thaw 备份，
 *    但**仍然要求你确认** —— 双重保险永远不嫌多。
 */

import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJ = join(dirname(fileURLToPath(import.meta.url)), '..')
if (!process.env.ORB_DATA) process.env.ORB_DATA = join(PROJ, 'data')

const snap = await import('../src/data-snapshot.mjs')

const argv = process.argv.slice(2)
const cmd = (argv[0] && !argv[0].startsWith('-')) ? argv[0] : 'list'
const rest = (argv[0] && !argv[0].startsWith('-')) ? argv.slice(1) : argv

function flag(name) {
  return rest.includes(`--${name}`)
}
function opt(name, fallback = null) {
  const i = rest.indexOf(`--${name}`)
  if (i < 0) return fallback
  const v = rest[i + 1]
  return v && !v.startsWith('--') ? v : fallback
}
function positional() {
  const withVal = new Set(['layers', 'reason'])
  const out = []
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]
    if (a.startsWith('--')) {
      if (withVal.has(a.slice(2))) i += 1
      continue
    }
    out.push(a)
  }
  return out
}
function parseLayers(v) {
  if (!v) return null
  const arr = String(v).split(',').map((s) => s.trim()).filter(Boolean)
  for (const l of arr) {
    if (!snap.LAYERS[l]) {
      console.error(`未知层 "${l}"，可选：${Object.keys(snap.LAYERS).join(' / ')}`)
      process.exit(2)
    }
  }
  return arr
}

const mb = (n) => `${(n / 1048576).toFixed(1)}MB`

console.log(`\ndata 根：${snap.currentDataRoot()}`)
console.log(`存档根：${snap.snapshotRoot()}\n`)

if (cmd === 'list') {
  const rows = snap.list()
  if (rows.length === 0) {
    console.log('（还没有任何存档）')
  } else {
    for (const r of rows) {
      const d = snap.describe(r.id)
      const tags = [r.broken ? '⚠ 损坏' : '', r.hasSecrets ? '含凭据' : '', r.reason ? `原因=${r.reason}` : '']
        .filter(Boolean).join(' · ')
      console.log(`  ${r.id}  ${d.ok ? d.text : d.text}${tags ? `  [${tags}]` : ''}`)
    }
    const total = rows.reduce((s, r) => s + (r.bytes || 0), 0)
    console.log(`\n共 ${rows.length} 份，合计 ${mb(total)}`)
  }
  process.exit(0)
}

if (cmd === 'freeze') {
  const layers = parseLayers(opt('layers')) || undefined
  const reason = opt('reason', 'manual-cli')
  const t0 = Date.now()
  const r = await snap.freeze({ layers, reason, meta: { via: 'cli' } })
  console.log(`已存档：${r.id}`)
  console.log(`  ${r.fileCount} 个文件 · ${mb(r.bytes)} · 层：${r.layers.join(', ')}`)
  console.log(`  位置：${r.dir}`)
  console.log(`  耗时：${((Date.now() - t0) / 1000).toFixed(1)}s`)
  if (r.layers.includes('config')) {
    console.log('\n  ⚠️ 含 providers/auth.json、bili-auth.json、wechat.json —— 这份存档里有明文凭据，')
    console.log('     别把它拷到别处或发给别人。（.orb-snapshots/ 已进 .gitignore）')
  }
  process.exit(0)
}

if (cmd === 'verify') {
  const id = positional()[0]
  if (!id) { console.error('用法：verify <id> [--shallow]'); process.exit(2) }
  const deep = !flag('shallow')
  const v = await snap.verify(id, { deep })
  console.log(`${v.ok ? '✅ 通过' : '❌ 有问题'}（${deep ? '深校验' : '浅校验'}，查了 ${v.checked} 个文件）`)
  for (const [k, label] of [['missing', '缺失'], ['sizeMismatch', '大小不符'], ['hashMismatch', '内容不符']]) {
    if (v[k].length) console.log(`  ${label}：\n    ${v[k].slice(0, 20).join('\n    ')}`)
  }
  process.exit(v.ok ? 0 : 1)
}

if (cmd === 'thaw') {
  const id = positional()[0]
  if (!id) { console.error('用法：thaw <id> [--layers ...] [--dry-run] [--yes]'); process.exit(2) }
  const layers = parseLayers(opt('layers'))
  const dryRun = flag('dry-run') || !flag('yes')

  const m = snap.readManifest(id)
  if (!m) { console.error(`读不到快照 ${id}`); process.exit(2) }

  if (dryRun) {
    const plan = await snap.thaw(id, { layers, dryRun: true })
    console.log('将要恢复的条目：')
    for (const p of plan.plan) console.log(`  data/${p}`)
    console.log(`\n层：${plan.layers.join(', ')}`)
    console.log('\n⚠️ 这是预览。确认无误后加 --yes 真执行（执行前会自动给当前状态存档）。')
    process.exit(0)
  }

  console.log('解冻中…（会先把当前状态存一份 pre-thaw 备份）')
  const r = await snap.thaw(id, { layers, autoBackup: true, meta: { via: 'cli' } })
  console.log(`\n✅ 已恢复到 ${id}`)
  console.log(`  恢复：${r.swapped.join(', ')}`)
  console.log(`  当前状态备份：${r.backupId}`)
  if (r.note) console.log(`  备注：${r.note}`)
  console.log('\n如果回退后登录态/API key 不对，用上面那个备份再 thaw 回去即可。')
  process.exit(0)
}

if (cmd === 'discard') {
  const ids = positional()
  if (ids.length === 0) { console.error('用法：discard <id> [<id>...]'); process.exit(2) }
  const r = snap.discard(ids)
  console.log(`已挪走 ${r.moved.length} 份：${r.moved.join(', ') || '（无）'}`)
  console.log(`回收位置：${r.trashDir}`)
  console.log('（不是真删，确认没问题后再手工清掉这个目录）')
  process.exit(0)
}

console.log(`未知命令：${cmd}`)
console.log('可用：list / freeze / verify / thaw / discard')
process.exit(2)
