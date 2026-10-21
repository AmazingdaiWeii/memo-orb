/**
 * files.mjs · 她的手（读写列/找文件，绝对路径语义）
 *
 * 2026-10-19 P2：`workspace.mjs` 那套「只许在 data/workspace 里」的沙箱被替换。
 * 用户拍板的是**读全盘（C/D/E/F）+ 写限白名单 + 危险动作必确认**，所以：
 *
 *   - 路径一律走 `policy.resolveInput()`：相对路径落到 `data/workspace/`，绝对路径原样，
 *     UNC（`\\server\share`）拒掉。
 *   - **读**只受黑名单（私钥/浏览器凭据/provider key/dsh token）与单次字节上限约束。
 *   - **写**的白名单判定不在这里做 —— 那是 `brain.mjs` 的事，因为白名单外要**弹卡**，
 *     而弹卡是异步的（等用户点）。本模块只负责「策略已经放行之后」真正落盘。
 *   - 没有 `delete_file`：删是唯一不可逆且没有任何留痕的操作，要删就走 `run_script` + 确认。
 *
 * 读大文件用 `offset`/`limit`（按行）分段，别指望一次读完一个 200MB 的日志。
 */

import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync, readdirSync, createReadStream } from 'node:fs'
import { join, dirname, basename, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { compileGlob } from './policy.mjs'

export const MAX_WRITE_BYTES = 512 * 1024
export const MAX_LIST_ENTRIES = 200
export const MAX_DEPTH = 4
export const MAX_GLOB_FILES = 200
export const MAX_GLOB_VISITED = 20000
export const MAX_GLOB_DEPTH = 8
export const MAX_READ_LINES = 2000

/** 走全盘 glob 时永远跳过的目录（跳进去只会把她和进程一起拖死）。 */
export const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'System Volume Information',
  '$RECYCLE.BIN',
  'Windows.old',
])

/** 显示用的路径：反斜杠换正斜杠（`E:/Memo orb/...` 更好读、也更好复制）。 */
export function displayPath(abs) {
  return String(abs).split(sep).join('/')
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true
  return false
}

function ensureReadable(abs, policy) {
  const deny = policy.readDenyReason(abs)
  if (deny) {
    throw new Error(`不能读这个（命中隐私规则 ${deny}）：${displayPath(abs)}`)
  }
}

function ensureNotDir(abs) {
  const st = statSync(abs)
  if (st.isDirectory()) throw new Error(`这是一个目录，不是文件：${displayPath(abs)}（要看里面的东西用 list_dir）`)
  return st
}

/** 按行切片读（offset 从 1 开始算第几行）。 */
async function readLineSlice(abs, { offset = 1, limit = 200, maxBytes }) {
  const start = Math.max(1, Number(offset) || 1)
  const take = Math.min(Math.max(1, Number(limit) || 200), MAX_READ_LINES)
  const stream = createReadStream(abs, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  const out = []
  let lineNo = 0
  let bytes = 0
  let truncated = false
  try {
    for await (const line of rl) {
      lineNo += 1
      if (lineNo < start) continue
      if (out.length >= take) {
        truncated = true
        break
      }
      bytes += Buffer.byteLength(line) + 1
      if (bytes > maxBytes) {
        truncated = true
        break
      }
      out.push(line)
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  return { text: out.join('\n'), fromLine: start, toLine: start + out.length - 1, truncated }
}

/**
 * 读一个文件。
 *
 * @param {string} rawPath 绝对路径，或相对 `data/workspace/` 的路径
 * @param {{policy: object, offset?: number, limit?: number}} o
 */
export async function readAnyFile(rawPath, { policy, offset, limit }) {
  const abs = policy.resolveInput(rawPath)
  ensureReadable(abs, policy)
  const st = ensureNotDir(abs)
  const maxBytes = policy.maxReadBytes
  const wantSlice = Number(offset) > 0 || Number(limit) > 0

  if (!wantSlice && st.size > maxBytes) {
    throw new Error(
      `这个文件有 ${st.size} 字节，超过单次读取上限 ${maxBytes}。` +
        `用 offset/limit 按行分段读（例如 offset=1, limit=200），或者先用 list_dir 看看有没有更小的。`
    )
  }

  if (wantSlice) {
    const slice = await readLineSlice(abs, { offset, limit, maxBytes })
    return {
      path: displayPath(abs),
      text: slice.text,
      bytes: st.size,
      lines: `${slice.fromLine}-${slice.toLine}`,
      truncated: slice.truncated,
      sliced: true,
    }
  }

  const buf = readFileSync(abs)
  if (looksBinary(buf)) {
    throw new Error(`看起来是二进制文件（${st.size} 字节），不是文本：${displayPath(abs)}`)
  }
  let text = buf.toString('utf8')
  let truncated = false
  // 单行超长（比如压缩过的 js）时按字符兜底裁一刀，别把上下文撑爆
  if (Buffer.byteLength(text) > maxBytes) {
    text = `${text.slice(0, maxBytes)}\n…（已截断：只给了前 ${maxBytes} 字节）`
    truncated = true
  }
  const lines = text.length ? text.split('\n').length : 0
  return { path: displayPath(abs), text, bytes: st.size, lines, truncated, sliced: false }
}

/**
 * 写一个文件（策略放行之后才调这里）。
 *
 * @param {string} rawPath
 * @param {string} content
 * @param {{policy: object}} o
 */
export function writeAnyFile(rawPath, content, { policy }) {
  const abs = policy.resolveInput(rawPath)
  ensureReadable(abs, policy)
  const text = String(content ?? '')
  const bytes = Buffer.byteLength(text)
  if (bytes > MAX_WRITE_BYTES) {
    throw new Error(`内容 ${bytes} 字节，超过单次写入上限 ${MAX_WRITE_BYTES}。分几次写，或者换个更省事的办法。`)
  }
  const created = !existsSync(abs)
  const st = created ? null : statSync(abs)
  if (st?.isDirectory()) throw new Error(`这个路径是个目录，不能当文件写：${displayPath(abs)}`)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text, 'utf8')
  return { path: displayPath(abs), bytes, created }
}

/**
 * 列目录。**非递归时是 shell `ls` 语义**：目录名带尾斜杠，只列直接子项。
 *
 * @param {string} rawPath
 * @param {{policy: object, recursive?: boolean, limit?: number}} o
 */
export function listAnyDir(rawPath, { policy, recursive = false, limit = MAX_LIST_ENTRIES }) {
  const abs = policy.resolveInput(rawPath ?? '.')
  ensureReadable(abs, policy)
  if (!existsSync(abs)) {
    // 空工作区是合法状态；别的地方不存在就是真不存在
    const ws = policy.resolveInput('.')
    if (abs === ws) return { path: displayPath(abs), entries: [], count: 0, truncated: false }
    throw new Error(`没有这个目录：${displayPath(abs)}`)
  }
  const st = statSync(abs)
  if (!st.isDirectory()) throw new Error(`不是一个目录：${displayPath(abs)}（要读内容用 read_file）`)

  const cap = Math.min(Math.max(1, Number(limit) || MAX_LIST_ENTRIES), MAX_LIST_ENTRIES)
  const out = []
  let truncated = false

  const readOne = (dir, prefix, depth) => {
    let items
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      out.push(`${prefix}[读不了：${err.code || err.message}]`)
      return
    }
    items.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1
      const bd = b.isDirectory() ? 0 : 1
      if (ad !== bd) return ad - bd
      return a.name.localeCompare(b.name, 'zh')
    })
    for (const it of items) {
      if (out.length >= cap) {
        truncated = true
        return
      }
      const full = join(dir, it.name)
      if (policy.readDenyReason(full)) {
        out.push(`${prefix}${it.name}${it.isDirectory() ? '/' : ''}（隐私，已略）`)
        continue
      }
      if (it.isDirectory()) {
        out.push(`${prefix}${it.name}/`)
        if (recursive && depth < MAX_DEPTH) readOne(full, `${prefix}${it.name}/`, depth + 1)
      } else {
        let size = ''
        try {
          size = `  ${statSync(full).size}B`
        } catch {
          size = ''
        }
        out.push(`${prefix}${it.name}${size}`)
      }
      if (truncated) return
    }
  }

  readOne(abs, '', 1)
  return { path: displayPath(abs), entries: out, count: out.length, truncated }
}

/**
 * 找文件。`pattern` 相对 `root` 匹配（同时试 basename，所以 `*.md` 也能用）。
 *
 * @param {string} pattern glob（`*` / `**` / `?`）
 * @param {{policy: object, root?: string, limit?: number}} o
 */
export function globFiles(pattern, { policy, root, limit = MAX_GLOB_FILES }) {
  const pat = String(pattern ?? '').trim()
  if (!pat) throw new Error('pattern 不能为空')
  const rootAbs = policy.resolveInput(root ?? '.')
  ensureReadable(rootAbs, policy)
  if (!existsSync(rootAbs)) throw new Error(`没有这个目录：${displayPath(rootAbs)}`)
  const re = compileGlob(pat)
  const cap = Math.min(Math.max(1, Number(limit) || MAX_GLOB_FILES), MAX_GLOB_FILES)

  const files = []
  let visited = 0
  let truncated = false

  const stack = [{ dir: rootAbs, rel: '', depth: 0 }]
  while (stack.length > 0) {
    const { dir, rel, depth } = stack.pop()
    let items
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const it of items) {
      visited += 1
      if (visited > MAX_GLOB_VISITED) {
        truncated = true
        stack.length = 0
        break
      }
      const full = join(dir, it.name)
      const childRel = rel ? `${rel}/${it.name}` : it.name
      if (it.isDirectory()) {
        if (SKIP_DIRS.has(it.name)) continue
        if (depth >= MAX_GLOB_DEPTH) continue
        if (policy.readDenyReason(full)) continue
        stack.push({ dir: full, rel: childRel, depth: depth + 1 })
        continue
      }
      if (policy.readDenyReason(full)) continue
      const lower = childRel.toLowerCase()
      if (!re.test(lower) && !re.test(basename(lower))) continue
      let size = 0
      try {
        size = statSync(full).size
      } catch {
        size = 0
      }
      files.push({ path: displayPath(full), rel: childRel, size })
      if (files.length >= cap) {
        truncated = true
        stack.length = 0
        break
      }
    }
  }

  files.sort((a, b) => a.rel.localeCompare(b.rel, 'zh'))
  return {
    root: displayPath(rootAbs),
    pattern: pat,
    files,
    count: files.length,
    truncated,
    visited,
  }
}
