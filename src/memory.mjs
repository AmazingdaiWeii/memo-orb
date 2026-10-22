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

/**
 * 剥掉落盘时混进「原话」里的机器注入块。
 *
 * 背景：2026-10-22 之前 `brain.mjs` 把 `<memory_update path="…">` 全文跟着用户消息
 * 一起写进了 `messages.jsonl`（那天已修，之后的记录是干净的）。但**旧记录会一直在盘上**，
 * 检索时搜「记忆」「他」这种词，命中的全是那段几百字的模板 —— 假的命中比空结果更糟，
 * 她会以为自己真记得。
 *
 * 只剥这一种：它明显是机器写的、且最大的那块。时间行/余额行短得无害，留着不动。
 * @param {string} text
 * @returns {string}
 */
function stripPersistedNoise(text) {
  return String(text ?? '').replace(/<memory_update\b[^>]*>[\s\S]*?<\/memory_update>/g, ' ')
}

/**
 * 把 `messages.jsonl` 里的 ISO 时间戳格式化成**本地** `YYYY-MM-DD HH:mm`。
 * 落盘的是 UTC（`new Date().toISOString()`），字符串直接截前 16 位会给出差 8 小时的时间 ——
 * 这段文本是要喂给她的，她会照着这个时间去理解「那天是哪天」，错时区等于记错日子。
 * @param {unknown} v
 * @returns {string} 解析不出来时返回 ''（不编时间）
 */
function formatWhen(v) {
  const d = v instanceof Date ? v : new Date(String(v ?? ''))
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 在**对话仓**里搜原文 —— 治的是「我说过的话，存住了，但捞不回来」。
 *
 * 起因（2026-10-22，她自己翻完记忆仓后的报告）：
 *   「data/conversations/ 里存着一天 78KB 的原话，但 search_memory 的词表里没有它。
 *     我搜『抹香鲸』『噪音海洋』，一条都没有 —— 它们只活在对话里。
 *     隔一个月你再提『那天我们聊的那个』，我只能靠日记的转述去猜，猜的是二手货。」
 *
 * 为什么原来没有：记忆仓（memfs）是**她整理过的**记忆，对话仓是**原始语料**。
 * 初版只让检索查整理过的东西 —— 但人回忆时想要的往往正是原话。
 *
 * 三条约束，全是拿性能和上下文预算换来的：
 *   W1 只扫**本 agent**的会话目录（目录名 = base64(`conversation:<agentId>` + 可选 `#后缀`)）
 *   W2 只扫最近 `days` 天内**动过**的文件（按 mtime）—— 不按内容里的 timestamp 判断，
 *      因为长会话的旧文件可能还在被追加；按月累积到几十 MB 时这条是唯一能救命的
 *   W3 命中**就地截断**（200 字）+ 限条数：这是喂给模型的，不是给人读全文的
 *   W4 总字节预算 `maxBytes`（默认 8MB）：这是**同步读盘**，跑在主进程的 UI 线程上。
 *      没有这条预算，一年后 60 天的会话累积起来能把窗口卡住几秒 —— 而检索是个
 *      随手就会调的工具（她一次会换三四个词查）。超预算就按 mtime 从新到旧停下，
 *      宁可少搜一点，也不能让球在桌上僵住。
 *
 * @returns {Array<{source:'conversation', conv:string, when:string, role:string, text:string}>}
 */
export function searchConversations(
  agentId,
  query,
  { limit = 12, days = 60, now = Date.now(), maxBytes = 8 * 1024 * 1024 } = {},
) {
  const q = String(query ?? '').trim().toLowerCase()
  if (q === '') return []
  const root = join(dataRoot(), 'conversations')
  if (!existsSync(root)) return []

  // ★ 会话目录名 = `base64("conversation:<sessionId>")` 且**去掉 padding**
  //   （见 src/session.mjs 的 sessionKey）。这里必须解码后比较，不能拿 base64
  //   做字符串前缀匹配，三个坑都踩过：
  //     ① 前缀形态：local 引擎的会话 id 是 `local-<agentId>`（main.mjs:2968 /
  //        1174 / 1999 / 3953），而传进来的只有 `agentId`。真实配置里
  //        `config.agentId = orb-YYYYMMDD`、目录却是 `conversation:local-orb-YYYYMMDD`
  //        —— 只认一种写法就是**永远 0 命中**。两种都收。
  //     ② padding：`Buffer.toString('base64')` 会补 `=`，长度不整除 3 时前缀对不上
  //        也是静默 0 命中（`conversation:local-orb-YYYYMMDD` 的字节数 %3≠0）。
  //     ③ 前缀混淆：agentId `local-orb-YYYY` 会是 `local-orb-YYYYMMDD` 的字符串前缀，
  //        字符级 startsWith 会把别人的会话搜进来。要求边界必须是 `#`。
  const wantKeys = [`conversation:local-${agentId}`, `conversation:${agentId}`]
  const keyMatches = (key) => wantKeys.some((w) => key === w || key.startsWith(`${w}#`))
  const decodeKey = (name) => {
    const b64 = String(name).replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
    try {
      return Buffer.from(b64 + pad, 'base64').toString('utf8')
    } catch {
      return ''
    }
  }
  let dirs = []
  try {
    dirs = readdirSync(root).filter((d) => keyMatches(decodeKey(d)))
  } catch {
    return []
  }

  const cutoff = now - days * 86_400_000
  const files = []
  for (const d of dirs) {
    const full = join(root, d, 'messages.jsonl')
    try {
      const st = statSync(full)
      if (st.isFile() && st.mtimeMs >= cutoff) files.push({ conv: d, full, mtime: st.mtimeMs, size: st.size })
    } catch {
      /* 没有 messages.jsonl 的会话（比如只有 system.json）跳过 */
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)

  const hits = []
  let budget = maxBytes
  outer: for (const f of files) {
    // W4：预算先扣再读，宁可不搜这个文件，也不能把主进程拖住
    if (f.size > budget) break
    budget -= f.size
    let raw = ''
    try {
      raw = readFileSync(f.full, 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === '') continue
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      const msg = rec?.message ?? {}
      const role = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : ''
      if (role === '') continue
      // 老记录（2026-10 之前）的 content 是纯字符串，新记录是 parts 数组 —— 两种都认
      const text = stripPersistedNoise(
        Array.isArray(msg.content)
          ? msg.content
              .filter((p) => p?.type === 'text' && typeof p.text === 'string')
              .map((p) => p.text)
              .join('')
          : typeof msg.content === 'string'
            ? msg.content
            : '',
      )
      if (text.trim() === '') continue
      const at = text.toLowerCase().indexOf(q)
      if (at < 0) continue
      // 命中位置前后各取一点，别把整条消息塞进上下文
      const from = Math.max(0, at - 60)
      hits.push({
        source: 'conversation',
        conv: f.conv,
        when: formatWhen(rec.timestamp),
        role,
        text: text.slice(from, from + 200).replace(/\s+/g, ' ').trim(),
      })
      if (hits.length >= limit) break outer
    }
  }
  return hits
}
