/**
 * 记忆中心 · host 侧数据层。
 *
 * 职责：把「记忆仓库里真实有什么」原样交给球，**不预设结构**。
 *
 * ⚠️ 为什么刻意不预设结构（踩过一次的坑）：
 *   `记忆中心_落地方案.md` 原设计是「五个文件五个卡片」
 *   （about-user.md / persona.md / relationship.md / memories.md / boundaries.md）。
 *   2026-10-07 实测：**这五个文件一个都不存在**，磁盘上只有一个 `MEMORY.md`，
 *   而 `鲸鱼娘_persona.md` 已经把「单文件两节（关于用户 / 关于我自己）」写死教给模型了。
 *   照原设计做面板 = 五个空卡片。
 *
 *   所以本模块吐的是「按 `##` 解析出的真实小节」，协议对布局保持无知：
 *   今天 1 文件 2 节 → 面板 1 个条目；将来真改成五文件 → 面板自动 5 个条目，
 *   **host 不改协议、UI 不改代码**。这是这里唯一不会白做的设计。
 *
 * ⚠️ 为什么**不用 `git` 命令**读历史（实测踩过）：
 *   沙箱里 `spawnSync('git')` 直接 `EBUSY`。但就算能跑也不该这么写 ——
 *   这会让「记忆中心」依赖用户机器上装了 git、且每次开面板都起一个子进程。
 *   git 的历史本来就是**几个纯文本文件**，直接读即可，零依赖、零进程开销：
 *     `.git/HEAD` → `ref: refs/heads/main` → `.git/refs/heads/main`（当前 revision）
 *     `.git/logs/HEAD` → reflog，每行含 `新hash 作者 时间戳 时区 \t 动作: 主题`
 *   实测 reflog 里 hash / 时间 / 主题齐全，正好够做「记忆变更时间线」。
 *
 *   ⚠️ **别拿会话里的 `memfsRevision` 当锚点 —— 实测证明它不成立。**
 *   101 个会话样本里，只有一部分 `memfsRevision` 等于记忆仓的 commit hash
 *   （`8627411…`×19、`1226f1a…`×9、`b19a462…`×4），其余 30+ 个取值
 *   （如 `b0b79ff…`、`80c0149…`）**在 `.git/objects` 里连对象都不存在**，pack 目录也是空的。
 *   也就是说它只是「有时碰巧等于 git commit」，不是稳定约定。
 *
 *   可靠的溯源做法是**按时间对**：会话产物里有 `compiledAt`（ISO 时间戳），
 *   记忆仓有 commit 时间线 → 「那一刻生效的是哪一版记忆」= `revisionAt(agentId, compiledAt)`。
 *   两个都是时间戳，这个映射不依赖任何未公开的字段语义。
 *
 * 数据源只有一个：`~/.legacy/lc-local-backend/memfs/<agentId>/memory/`（一个独立 git 仓）。
 * 全程只读；写入/git commit 属二期，本版不提供。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'

/**
 * 数据根。**每次调用都读环境变量**（不再在模块导入时冻结）。
 *
 * 优先级：`ORB_DATA`（应用自己的根，local 引擎用）> `ORB_LEGACY_DATA`
 * （旧旧后端数据根，兼容/考古用）> `~/.legacy/lc-local-backend`。
 *
 * 为什么必须惰性：`src/main.mjs` 是在 app ready 之后才决定 engine 的，
 * 进程启动早期 import 本模块时 `ORB_DATA` 还没设上。冻结一次就等于把
 * local 引擎钉死在旧后端的数据目录里（正是 R2 那个坑）。
 */
export function dataRoot() {
  const explicit = process.env.ORB_DATA
  if (explicit) return resolve(explicit)
  const legacy = process.env.ORB_LEGACY_DATA
  if (legacy) return resolve(legacy)
  return join(homedir(), '.legacy', 'lc-local-backend')
}

/** memfs 根：`<dataRoot>/memfs`。同样惰性。 */
export function memfsRoot() {
  return join(dataRoot(), 'memfs')
}

/** 只认这些后缀，避免把 `.git` 里的东西当记忆文件读出来。 */
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.jsonl'])
/** 单文件读入上限（防有人往仓库里丢大文件把球撑爆）。 */
const MAX_BYTES = 512 * 1024

/**
 * 记忆仓库目录。**不做任何 id→路径的编解码猜测** —— memfs 目录名就是 agentId 本身。
 * @param {string} agentId
 */
export function memoryDir(agentId) {
  return join(memfsRoot(), String(agentId ?? ''), 'memory')
}

/**
 * 按 `##` 切小节。上级 `#` 当标题，`###` 归进它所属的 `##` 正文。
 *
 * 为什么不用现成 markdown 解析器：这里只需要「标题 + 正文」，引一个依赖不划算，
 * 而且我们要的是**原样保留正文**（面板要能展示模型写的东西，不能被渲染器改写）。
 */
export function splitSections(text) {
  const lines = String(text).split(/\r?\n/)
  /** @type {string|null} */
  let title = null
  /** @type {Array<{heading: string, body: string}>} */
  const sections = []
  let cur = null
  const pre = []
  for (const line of lines) {
    const h2 = /^##\s+(.*)$/.exec(line)
    const h1 = /^#\s+(.*)$/.exec(line)
    if (h1 && !h2 && title === null) { title = h1[1].trim(); continue }
    if (h2) {
      if (cur) sections.push(cur)
      cur = { heading: h2[1].trim(), body: '' }
      continue
    }
    if (cur) cur.body += (cur.body === '' ? '' : '\n') + line
    else pre.push(line)
  }
  if (cur) sections.push(cur)
  for (const s of sections) s.body = s.body.replace(/^\n+|\s+$/g, '')
  return { title, preamble: pre.join('\n').trim(), sections }
}

// ---------------------------------------------------------------- git（纯文本读，零子进程）

/** 解析 `.git/HEAD` → 当前 commit hash；拿不到返回 null。 */
function resolveHeadHash(dir) {
  const gitDir = join(dir, '.git')
  let head
  try { head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim() } catch { return null }
  if (!head.startsWith('ref:')) return /^[0-9a-f]{7,40}$/i.test(head) ? head : null
  const ref = head.slice(4).trim()
  try { return readFileSync(join(gitDir, ...ref.split('/')), 'utf8').trim() } catch { /* 见下：可能被打包 */ }
  // packed-refs 兜底（仓库做过 gc 时 refs/ 下的文件会消失）
  try {
    const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8')
    for (const line of packed.split('\n')) {
      if (line.startsWith('#') || line.trim() === '') continue
      const [hash, name] = line.split(' ')
      if (name?.trim() === ref) return hash.trim()
    }
  } catch { /* 没有 packed-refs */ }
  return null
}

/** 把 `unix 秒 + 时区偏移` 渲染成 `git log --date=iso-strict` 那种 `2026-10-06T18:39:22+08:00`。 */
function isoWithOffset(unixSec, tz) {
  const m = /^([+-])(\d{2})(\d{2})$/.exec(String(tz ?? ''))
  const sign = m?.[1] === '-' ? -1 : 1
  const offMin = m ? sign * (Number(m[2]) * 60 + Number(m[3])) : 0
  const shifted = new Date((unixSec + offMin * 60) * 1000)
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}` +
    `T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}`
  return `${stamp}${m ? m[0] : 'Z'}`
}

/**
 * 读 reflog（`.git/logs/HEAD`）当记忆变更时间线。
 *
 * 行格式（tab 前是元数据、tab 后是动作说明）：
 *   `<old40> <new40> 作者 <邮箱> <unix秒> <时区>\t<动作>: <主题>`
 * 实测样本：
 *   `0000… 8627411… Orb <…@legacy.com> 1791283618 +0800\tcommit (initial): chore: initialize local memory`
 *
 * ⚠️ 只保留 `commit` 动作 —— `reset:` / `checkout:` 是 git 的内部走动，
 *    放进「记忆变更时间线」只会让用户困惑「我没改过啊」。
 */
function readReflog(dir, limit = 40) {
  let raw
  try { raw = readFileSync(join(dir, '.git', 'logs', 'HEAD'), 'utf8') } catch { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const [meta, note = ''] = line.split('\t')
    const parts = meta.trim().split(/\s+/)
    // [old, new, ...name words..., <email>, <unix>, <tz>]
    if (parts.length < 4) continue
    const newHash = parts[1]
    const tz = parts[parts.length - 1]
    const unixSec = Number(parts[parts.length - 2])
    if (!/^[0-9a-f]{7,40}$/i.test(newHash) || Number.isNaN(unixSec)) continue
    const actor = parts.slice(2, -2).join(' ').replace(/\s*<.*>$/, '').trim()
    const m = /^([a-z ]+?)(?:\s*\(initial\))?:\s*(.*)$/.exec(note.trim())
    const action = (m?.[1] ?? note).trim()
    const subject = (m?.[2] ?? '').trim()
    if (action !== 'commit') continue
    out.push({
      hash: newHash,
      short: newHash.slice(0, 7),
      date: isoWithOffset(unixSec, tz),
      unix: unixSec,
      actor,
      subject,
    })
  }
  // 最新在前，并按 hash 去重（reflog 里同一 commit 可能出现多次）
  const seen = new Set()
  const uniq = []
  for (const c of out.reverse()) {
    if (seen.has(c.hash)) continue
    seen.add(c.hash)
    uniq.push(c)
  }
  return uniq.slice(0, limit)
}

/** HEAD = 当前 revision。主题在 reflog 里取；reflog 被清过就只给 hash。 */
function readHead(dir) {
  const hash = resolveHeadHash(dir)
  if (!hash) return null
  const hit = readReflog(dir).find((c) => c.hash === hash)
  return {
    hash,
    short: hash.slice(0, 7),
    date: hit?.date ?? null,
    actor: hit?.actor ?? null,
    subject: hit?.subject ?? null,
  }
}

/** 递归收文件（跳过 `.git`），返回相对路径。 */
function walk(dir, base = dir) {
  /** @type {string[]} */
  const out = []
  let names
  try {
    names = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ent of names) {
    if (ent.name === '.git') continue
    const full = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walk(full, base))
    else if (ent.isFile()) out.push(relative(base, full).split('\\').join('/'))
  }
  return out
}

/**
 * 列出记忆仓库的真实内容。
 *
 * @param {string} agentId
 * @param {(msg: string) => void} [log]
 * @returns {{
 *   agentId: string, dir: string, exists: boolean, git: boolean,
 *   files: Array<{path: string, name: string, bytes: number, updatedAt: string, readable: boolean,
 *                 title: string|null, preamble: string, sections: Array<{heading: string, body: string}>}>,
 *   commits: Array<{hash: string, short: string, date: string, unix: number, actor: string, subject: string}>,
 *   head: object|null,
 *   totalBytes: number,
 * }}
 */
export function listMemory(agentId, log = () => {}) {
  const dir = memoryDir(agentId)
  const out = {
    agentId: String(agentId ?? ''),
    dir,
    exists: existsSync(dir),
    git: existsSync(join(dir, '.git')),
    files: [],
    commits: [],
    head: null,
    totalBytes: 0,
  }
  if (!out.exists) {
    log(`记忆仓库不存在：${dir}`)
    return out
  }

  for (const rel of walk(dir).sort()) {
    const full = join(dir, rel)
    const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase()
    let st
    try { st = statSync(full) } catch { continue }
    const entry = {
      path: rel,
      name: rel.slice(rel.lastIndexOf('/') + 1),
      bytes: st.size,
      updatedAt: new Date(st.mtimeMs).toISOString(),
      readable: false,
      title: null,
      preamble: '',
      sections: [],
    }
    if (TEXT_EXT.has(ext) && st.size <= MAX_BYTES) {
      entry.readable = true
      out.totalBytes += st.size
      try {
        const parsed = splitSections(readFileSync(full, 'utf8'))
        entry.title = parsed.title
        entry.preamble = parsed.preamble
        entry.sections = parsed.sections
      } catch (err) {
        entry.readable = false
        log(`记忆文件读取失败 ${rel}: ${err.message}`)
      }
    }
    out.files.push(entry)
  }

  out.commits = readReflog(dir)
  out.head = readHead(dir)
  return out
}

/** 路径里出现 `.git` 段一律拒绝 —— 那是 git 内部，不是记忆内容。 */
function hasGitSegment(rel) {
  return String(rel ?? '').split(/[\\/]/).some((seg) => seg === '.git')
}

/**
 * 这个相对路径能不能读？
 *
 * ⚠️ **走协议时也必须先过这一道**（不是只有本模块需要）：
 *   实测旧后端协议的 `read_memory_file` 只挡「逃出仓库根」
 *   （`../../agents/x.json` → 被拒，错误信息 `path must resolve inside the memory root`），
 *   但 **`.git/config` 它是放行的** —— 探针真拿到了 319 字节内容，里面是 remote 配置。
 *   所以「协议自己会管」是错的，host 必须自己兜住这一层。
 */
export function isBlockedMemoryPath(rel) {
  const s = String(rel ?? '')
  if (s.trim() === '') return true
  if (hasGitSegment(s)) return true
  // 上跳段：协议会拒（`path must resolve inside the memory root`），
  // 但不该把安全建立在别人的错误信息上 —— 自己先挡一遍，两条分支都安全。
  if (s.split(/[\\/]/).some((seg) => seg === '..')) return true
  // 绝对路径 / 盘符，一律不接
  if (/^[a-z]:/i.test(s) || s.startsWith('/') || s.startsWith('\\')) return true
  return false
}

/**
 * 溯源：某个时刻「生效的是哪一版记忆」。
 *
 * 为什么需要它：会话产物里的 `memfsRevision` 不可靠（见文件头 ⚠️），
 * 但会话产物里有 `compiledAt`（ISO 时间戳），记忆仓有 commit 时间线 —— 按时间对即可。
 *
 * @param {string} agentId
 * @param {string} isoTimestamp 目标时刻（通常是会话的 `compiledAt`）
 * @returns {object|null} 该时刻之前最近的一次 commit；早于全部 commit 则返回最早那条
 */
export function revisionAt(agentId, isoTimestamp) {
  const t = Date.parse(String(isoTimestamp ?? ''))
  const commits = listMemory(agentId).commits          // 最新在前
  if (commits.length === 0) return null
  if (Number.isNaN(t)) return commits[0]
  const atOrBefore = commits.find((c) => Date.parse(c.date) <= t)
  return atOrBefore ?? commits[commits.length - 1]
}

/**
 * 读单个记忆文件的原文。
 *
 * ⚠️ 两道关，缺一不可：
 *   1. **越界**：`relPath` 是从球来的字符串，`../..` 就能读到 `agents/<id>.json` 里的配置。
 *      resolve 后必须仍在仓库内。
 *   2. **`.git` 内部**：`.git/config` 是**在仓库内**的，所以第 1 道关拦不住它 ——
 *      而它可能带着 remote URL 和凭据。单列一道关，直接拒绝。
 *      （这条是写测试时发现的：原本只有越界检查，`.git/config` 被放行了。）
 *
 * @returns {{path: string, content: string} | null}
 */
export function readMemoryFile(agentId, relPath) {
  const dir = resolve(memoryDir(agentId))
  const full = resolve(dir, String(relPath ?? ''))
  const inside = full === dir ? false
    : (full.startsWith(dir + '\\') || full.startsWith(dir + '/'))
  if (!inside || hasGitSegment(relPath)) return null
  try {
    if (!existsSync(full) || !statSync(full).isFile()) return null
    const st = statSync(full)
    // `mtimeMs` 是给记忆中心用的：**「改文件」和「提交」没有绑在一起**。
    // 同一个文件可能被改了却长时间没有新的 commit（实测印象那条路径留下过
    // ≥19 分钟的脏改动），所以「这份文件上次什么时候被改过」只有 mtime 说得准；
    // commit 时间只能当「历史版本」的参考。详见 `src/main.mjs` 的 `touchedAtOf()`。
    // 加字段是纯增量，老的调用点都只读 `.content`。
    return { path: String(relPath), content: readFileSync(full, 'utf8'), mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

/**
 * 在记忆仓库里做全文搜索（大小写不敏感）。
 * @returns {Array<{path: string, heading: string|null, line: number, text: string}>}
 */
export function searchMemory(agentId, query, limit = 60) {
  const q = String(query ?? '').trim().toLowerCase()
  if (q === '') return []
  const hits = []
  for (const f of listMemory(agentId).files) {
    if (!f.readable) continue
    const raw = readMemoryFile(agentId, f.path)
    if (!raw) continue
    let heading = null
    const lines = raw.content.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const h = /^##\s+(.*)$/.exec(lines[i])
      if (h) heading = h[1].trim()
      if (lines[i].toLowerCase().includes(q)) {
        hits.push({ path: f.path, heading, line: i + 1, text: lines[i].trim().slice(0, 300) })
        if (hits.length >= limit) return hits
      }
    }
  }
  return hits
}
