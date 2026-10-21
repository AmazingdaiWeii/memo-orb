/**
 * 把「美术给的情绪素材」拷成「球能加载的文件名」。
 *
 * 为什么需要这一步：素材叫 `happy@0.85x.gif`，而球侧那条预设正则是
 *
 *     /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9_-]+)*\.gif$/
 *
 * `@` 和 `0.85` 里的 `.` 都不合法 —— 直接发过去会被球**静默丢弃**（没报错、没日志），
 * 是最难查的那种失败。所以统一改名成 `deco/<mood>.gif`，倍速在挑素材时就烤进文件了。
 *
 * 命名规则**只在 `src/mood.mjs` 里定义一次**（`assetFor` / `sourceFileName`），
 * 本脚本只是执行它 —— 这样「单测验的规则」和「实际拷的文件」不可能对不上。
 *
 * 跑法：
 *   node tools/copy-deco.mjs            # 拷贝（已存在且内容相同的会跳过）
 *   node tools/copy-deco.mjs --dry-run  # 只看会做什么
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MOOD_NAMES, assetFor, isSafeAssetSrc, sourceFileName } from '../src/mood.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC_DIR = join(ROOT, 'deco-plan', 'output')
const DST_DIR = join(ROOT, 'helper', 'assets', 'deco')

const dryRun = process.argv.includes('--dry-run')
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

console.log(`源目录  ${SRC_DIR}`)
console.log(`目标    ${DST_DIR}`)
console.log(dryRun ? '模式    dry-run（不写盘）\n' : '模式    实际拷贝\n')

if (!dryRun) mkdirSync(DST_DIR, { recursive: true })

let copied = 0
let skipped = 0
let failed = 0

for (const mood of MOOD_NAMES) {
  const { src } = assetFor(mood)
  const name = `${mood}.gif`
  const from = join(SRC_DIR, sourceFileName(mood))
  const to = join(DST_DIR, name)

  // 第一道闸：文案里那个 src 必须过球侧正则。过不了就别拷 —— 拷了也是白拷。
  if (!isSafeAssetSrc(src)) {
    console.log(`  ✗ ${mood}  src 不合规：${src}`)
    failed += 1
    continue
  }
  if (!existsSync(from)) {
    console.log(`  ✗ ${mood}  源素材不存在：${sourceFileName(mood)}`)
    failed += 1
    continue
  }

  if (existsSync(to) && sha(from) === sha(to)) {
    console.log(`  = ${mood}  ${name} 已是最新（${statSync(to).size} 字节），跳过`)
    skipped += 1
    continue
  }

  if (!dryRun) copyFileSync(from, to)

  // 第二道闸：拷完**复读**目标文件确认字节一致。
  // 光看 copyFileSync 没抛异常不算数 —— 落到磁盘上的东西必须亲眼核一遍。
  const same = dryRun ? true : sha(from) === sha(to)
  if (!same) {
    console.log(`  ✗ ${mood}  拷贝后校验不一致！`)
    failed += 1
    continue
  }
  console.log(`  ✓ ${mood}  ${sourceFileName(mood)}  →  ${name}  (${statSync(from).size} 字节)`)
  copied += 1
}

console.log(`\n拷贝 ${copied} / 跳过 ${skipped} / 失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
