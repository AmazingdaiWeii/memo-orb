/**
 * asar 单文件抽取工具（只读探查用，不是产品代码）。
 *
 * 用途：把 WorkBuddy 的 `E:/workbuddy/resources/app.asar` 里某个文件按清单里的
 *      offset/size 抠出来，便于阅读它的实现（本项目要参考它的图片发送做法）。
 *
 * 用法：node tools/asar-extract.mjs <asar内路径> [输出路径]
 *   node tools/asar-extract.mjs /renderer/assets/chat-uaUOOklS.js .workbuddy/_asar/chat.js
 *
 * 原理：asar 布局 = [4B 常量4][4B pickle长度][4B json长度][4B 保留] + json头 + 数据区。
 *   清单里每个文件给的是「相对数据区起点」的 offset，真实偏移 = dataStart + offset。
 *   ⚠️ 数据区起点 = 8 + pickle长度（不是 16 + 什么），这个偏移错一位就整片乱码。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HDR = join(ROOT, '.workbuddy/_asar/hdr.json')
const DATA_START = Number(readFileSync(join(ROOT, '.workbuddy/_asar/datastart.txt'), 'utf8').trim())

const ASAR = 'E:/workbuddy/resources/app.asar'
// ⚠️ Git Bash 会把 `/renderer/...` 这种「以斜杠开头的参数」当成 Windows 路径改写成
//    `E:/workbuddy/resources/vendor/PortableGit/renderer/...`（MSYS 路径转换）。
//    所以这里按「最后一个以常见 asar 顶层目录名开头的片段」来恢复，而不是直接用 argv。
const RAW_TOPS = ['cli', 'main', 'native', 'node_modules', 'preload', 'renderer', 'resources', 'tencent-docs']
function normalizeArg(a) {
  if (!a) return a
  const hit = RAW_TOPS.find((t) => a === t || a.startsWith(t + '/') || a.includes('/' + t + '/'))
  if (!hit) return a.replace(/\\/g, '/')
  const idx = a.lastIndexOf('/' + hit + '/')
  if (idx >= 0) return a.slice(idx)                       // 从 /renderer/ 开始截
  if (a.startsWith(hit + '/')) return '/' + a
  return a.replace(/\\/g, '/')
}
const target = normalizeArg(process.argv[2])
if (!target) {
  console.error('用法：node tools/asar-extract.mjs <asar内路径> [输出路径]')
  process.exit(1)
}

const hdr = JSON.parse(readFileSync(HDR, 'utf8'))
function find(node, parts, path = '') {
  if (parts.length === 0) return null
  const [head, ...rest] = parts
  const child = node.files?.[head]
  if (!child) return null
  if (rest.length === 0) return child
  return find(child, rest, path + '/' + head)
}

const entry = find(hdr, target.split('/').filter(Boolean))
if (!entry || entry.files) {
  console.error(`在 asar 里找不到文件：${target}`)
  process.exit(1)
}

const fd = readFileSync(ASAR)
const start = DATA_START + Number(entry.offset)
const buf = fd.subarray(start, start + Number(entry.size))

const out = process.argv[3]
if (out) {
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, buf)
  console.log(`✅ ${entry.size} B → ${out}`)
} else {
  process.stdout.write(buf)
}
