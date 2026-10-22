/**
 * 工作区文件工具 —— 她的手。
 *
 * 范围**只有** `<dataRoot>/workspace/` 一个目录（用户 2026-10-19 拍板：读写 +
 * 列目录，每次调用都要他点确认）。工作区之外的一切 —— 工程源码、`data/memfs`、
 * 用户家目录、系统盘 —— 一律碰不到。这不是「尽量别」，是路径在这里就被夹死：
 * 绝对路径、`..`、盘符、UNC 全部在 resolve 之后按「是否还在根下」复核。
 *
 * 为什么不用 shell：一旦给出 `run_command`，上面这些夹逼全部作废（一条
 * `cd ..` 就出去了）。所以这一版只给三个纯文件操作，能力边界与审批粒度都清楚。
 */
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises'
import { join, resolve, sep, isAbsolute } from 'node:path'
import { dataRoot } from './memory.mjs'

/** 单个文件读上限：够贴一份文档，又不至于把上下文撑爆。 */
export const MAX_READ_BYTES = 256 * 1024
/** 单次写上限。 */
export const MAX_WRITE_BYTES = 512 * 1024
/** 列目录一次最多给多少条。 */
export const MAX_LIST_ENTRIES = 200
/** 目录树递归深度（listDir 默认只列一层，递归时用）。 */
const MAX_DEPTH = 4

export function workspaceRoot() {
  return join(dataRoot(), 'workspace')
}

/**
 * 把工作区目录建出来。
 *
 * ★ 这是真机探针撞出来的：以前只在 `writeWorkspaceFile` 里 `mkdir` 父目录，
 *   所以**全新安装后第一次 `list_dir` 必然报「工作区里没有这个目录：.」**——她连
 *   自己手上有什么都看不到。空工作区是合法状态，不能表现成错误。
 *   现在两处兜底：启动时建一次（这里），列目录时缺了就当作空目录（见 listWorkspaceDir）。
 */
export async function ensureWorkspaceRoot() {
  await mkdir(workspaceRoot(), { recursive: true })
  return workspaceRoot()
}

/** 归一成 posix 风格的相对路径，用于展示与回传。 */
function toRel(root, full) {
  const rel = full.slice(root.length).replace(/^[\\/]+/, '')
  return rel.split(sep).join('/') || '.'
}

/**
 * 把模型给的路径解析成工作区内的绝对路径。
 * 越界、绝对路径、盘符、UNC 一律抛错 —— 错误信息会原样回到模型，它看得懂。
 */
export function resolveInWorkspace(raw) {
  const input = String(raw ?? '').trim()
  if (!input) throw new Error('path 不能为空（写 "." 表示工作区根）')
  if (input.includes('\u0000')) throw new Error('路径里有非法字符')

  const root = resolve(workspaceRoot())
  if (isAbsolute(input) || /^[a-zA-Z]:/.test(input) || input.startsWith('\\\\') || input.startsWith('//')) {
    throw new Error(`只接受工作区内的相对路径，不能给绝对路径：${input}`)
  }
  const full = resolve(root, input)
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`这个路径跑到工作区外面去了：${input}（只能在 data/workspace/ 里活动）`)
  }
  return { root, full, rel: toRel(root, full) }
}

/** 看起来像二进制就拒读 —— 免得把乱码灌进上下文。 */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true
  return false
}

export async function readWorkspaceFile(rawPath) {
  const { full, rel } = resolveInWorkspace(rawPath)
  let info
  try {
    info = await stat(full)
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`工作区里没有这个文件：${rel}`)
    throw err
  }
  if (info.isDirectory()) throw new Error(`${rel} 是个目录，用 list_dir 看它`)
  if (info.size > MAX_READ_BYTES) {
    throw new Error(`${rel} 有 ${info.size} 字节，超过单次读取上限 ${MAX_READ_BYTES}`)
  }
  const buf = await readFile(full)
  if (looksBinary(buf)) throw new Error(`${rel} 像是二进制文件，读不了`)
  return { path: rel, text: buf.toString('utf8'), bytes: info.size, mtime: info.mtime.toISOString() }
}

export async function writeWorkspaceFile(rawPath, content) {
  const { full, rel } = resolveInWorkspace(rawPath)
  const text = String(content ?? '')
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_WRITE_BYTES) {
    throw new Error(`要写 ${bytes} 字节，超过单次写入上限 ${MAX_WRITE_BYTES}`)
  }
  let existed = false
  try {
    existed = (await stat(full)).isFile()
  } catch { /* 不存在就是新建 */ }
  await mkdir(resolve(full, '..'), { recursive: true })
  await writeFile(full, text, 'utf8')
  return { path: rel, bytes, created: !existed }
}

/**
 * 写**二进制**文件（图片等）。路径夹逼规则与 `writeWorkspaceFile` 完全一样。
 *
 * 为什么要单开一个：`writeWorkspaceFile` 是 `utf8` 写的，把 JPEG 的 base64
 * 当文本写进去，盘上就是一个**看起来像 .jpg、实际是 base64 字符串**的文件 ——
 * 用户点开一片空白，而且不会报错。2026-10-22 加：她有画面却给不出画面
 * （图片只活在上下文里，回合结束就没了），所以关键帧必须真的落到盘上。
 *
 * @param {string} rawPath 工作区相对路径
 * @param {Buffer|Uint8Array} buf 原始字节
 * @returns {Promise<{path: string, bytes: number, created: boolean}>}
 */
export async function writeWorkspaceBinary(rawPath, buf) {
  const { full, rel } = resolveInWorkspace(rawPath)
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf ?? [])
  if (bytes.length === 0) throw new Error('要写的内容是空的')
  if (bytes.length > MAX_WRITE_BYTES) {
    throw new Error(`要写 ${bytes.length} 字节，超过单次写入上限 ${MAX_WRITE_BYTES}`)
  }
  let existed = false
  try {
    existed = (await stat(full)).isFile()
  } catch {
    /* 不存在就是新建 */
  }
  await mkdir(resolve(full, '..'), { recursive: true })
  await writeFile(full, bytes)
  return { path: rel, bytes: bytes.length, created: !existed }
}

export async function listWorkspaceDir(rawPath = '.', { recursive = false } = {}) {  const { root, full, rel } = resolveInWorkspace(rawPath ?? '.')
  let info
  try {
    info = await stat(full)
  } catch (err) {
    if (err.code === 'ENOENT') {
      // 根目录不存在 = 还没人写过东西，等于空工作区（不是错误）。
      if (full === root) return { path: '.', entries: [], truncated: false, root: 'data/workspace' }
      throw new Error(`工作区里没有这个目录：${rel}`)
    }
    throw err
  }
  if (!info.isDirectory()) throw new Error(`${rel} 是个文件，用 read_file 读它`)

  const out = []
  let truncated = false

  async function walk(dir, depth) {
    if (out.length >= MAX_LIST_ENTRIES) { truncated = true; return }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      out.push({ path: `${toRel(root, dir)}/`, type: 'error', note: err.code ?? err.message })
      return
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const e of entries) {
      if (out.length >= MAX_LIST_ENTRIES) { truncated = true; return }
      const childFull = join(dir, e.name)
      if (e.isDirectory()) {
        out.push({ path: `${toRel(root, childFull)}/`, type: 'dir' })
        if (recursive && depth < MAX_DEPTH) await walk(childFull, depth + 1)
      } else {
        let size = null
        try { size = (await stat(childFull)).size } catch { /* 竞态：刚被删 */ }
        out.push({ path: toRel(root, childFull), type: 'file', bytes: size })
      }
    }
  }

  await walk(full, 0)
  return { path: rel, entries: out, truncated, root: 'data/workspace' }
}

/** 给 system prompt 的一行现状说明（她得知道自己能在哪儿动手）。 */
export async function describeWorkspace() {
  try {
    const info = await stat(workspaceRoot())
    if (!info.isDirectory()) return '（工作区路径被一个同名文件占了）'
  } catch (err) {
    if (err.code === 'ENOENT') return '（工作区还空着，第一次 write_file 会自动建）'
    return `（工作区读不了：${err.code ?? err.message}）`
  }
  try {
    const { entries, truncated } = await listWorkspaceDir('.')
    if (entries.length === 0) return '（工作区还空着）'
    const preview = entries.slice(0, 12).map((e) => e.path).join('、')
    return `${entries.length}${truncated ? '+' : ''} 项：${preview}${entries.length > 12 ? ' …' : ''}`
  } catch {
    return '（工作区读不了）'
  }
}
