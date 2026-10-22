// 头像链路自检（只读）：不启动 Electron，直接把 helper/lib/main.js 里的
// AVATAR_PRESETS / PRESET_SRC / 目录扫描正则 抠出来跑一遍，
// 结论是「环菜单实际会列出哪几项」+「默认头像文件在不在」。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.argv[2] ? resolve(process.argv[2]) : dirname(dirname(fileURLToPath(import.meta.url)))
const main = readFileSync(join(ROOT, 'helper/lib/main.js'), 'utf8')
const shell = readFileSync(join(ROOT, 'helper/assets/shell.js'), 'utf8')

const pick = (re, what) => {
  const m = main.match(re)
  if (!m) throw new Error(`抠不到 ${what}`)
  return m[1]
}
const presetSrcRe = eval(pick(/const PRESET_SRC = (\/[^\n]*?\/);/, 'PRESET_SRC'))
const scanRe = eval(pick(/if \(!(\/\^[^\n]*?\.gif\$\/)\.test\(file\)\) continue;/, '扫描正则'))
const defaultSrc = pick(/const DEFAULT_AVATAR_SRC = "([^"]+)";/, 'DEFAULT_AVATAR_SRC')

const presetsBlock = main.slice(main.indexOf('const AVATAR_PRESETS = ['), main.indexOf('];', main.indexOf('const AVATAR_PRESETS = [')))
const presets = [...presetsBlock.matchAll(/src:\s*"([^"]+)"[\s\S]*?name:\s*"([^"]+)"/g)].map((m) => ({ src: m[1], name: m[2] }))

const dir = join(ROOT, 'helper/assets/avatars')
const scanned = readdirSync(dir).filter((f) => scanRe.test(f)).map((f) => ({ src: `avatars/${f}`, name: f.slice(0, -4) }))
const list = [...presets.map((p) => ({ ...p }))]
for (const s of scanned) if (!list.some((i) => i.src === s.src)) list.push(s)

const fails = []
console.log('PRESET_SRC      =', presetSrcRe)
console.log('扫描正则        =', scanRe)
console.log('DEFAULT_AVATAR  =', defaultSrc)
console.log('\n环菜单实际会列出：')
for (const i of list) {
  const ok = existsSync(join(ROOT, 'helper/assets', i.src))
  const safe = presetSrcRe.test(i.src)
  console.log(`  ${ok && safe ? '✓' : '✗'} ${i.src.padEnd(24)} 「${i.name}」${i.src === defaultSrc ? '  ← 默认' : ''}`)
  if (!ok) fails.push(`清单项指向的文件不存在：${i.src}`)
  if (!safe) fails.push(`清单项没过 PRESET_SRC 校验：${i.src}`)
}
console.log('\n被正则挡掉的文件：', readdirSync(dir).filter((f) => !scanRe.test(f)).join(', ') || '（无）')

// 默认头像三处必须一致，且裁脸表要有它，否则托盘图标会走兜底裁切
if (!presets[0] || presets[0].src !== defaultSrc) fails.push(`AVATAR_PRESETS[0]=${presets[0]?.src} 与 DEFAULT_AVATAR_SRC=${defaultSrc} 不一致`)
if (!existsSync(join(ROOT, 'helper/assets', defaultSrc))) fails.push(`默认头像文件不存在：${defaultSrc}`)
const shellDefaults = [...shell.matchAll(/'(orb-idle\.gif|avatars\/orb-[A-Za-z]+\.gif)'/g)].map((m) => m[1])
const shellLiteralDefaults = [...shell.matchAll(/\|\| '([^']+\.gif)'|\?\s*src\s*:\s*'([^']+\.gif)'|avatarSrc = '([^']+\.gif)'/g)].map((m) => m[1] || m[2] || m[3]).filter(Boolean)
if (!shellLiteralDefaults.every((v) => v === defaultSrc)) fails.push(`shell.js 还有别的默认值：${[...new Set(shellLiteralDefaults)].join(', ')}`)
if (!shell.includes(`'${defaultSrc}': {`)) fails.push(`TRAY_FACE_CROP 里没有 ${defaultSrc} 的裁脸参数`)

console.log('\nshell.js 里的 gif 默认值：', [...new Set(shellLiteralDefaults)].join(', '))
console.log(fails.length ? `\n✗ ${fails.length} 项不合格：\n - ` + fails.join('\n - ') : '\n✓ 全部检查通过')
process.exit(fails.length ? 1 : 0)
