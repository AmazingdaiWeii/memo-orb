/**
 * memstore-local.mjs · 新内核实现（原子写 / 串行队列 / 写即提交）
 *
 * ★ 它必须做到的三件事（对齐《记忆可靠性与长会话保真_设计》§3.1）：
 *   1. 原子写：写临时文件 → fs.rename()（同盘原子替换），绝不半截文件
 *   2. 单一写入队列：所有写操作串行过一条 Promise 队列
 *   3. 写即提交：write() 内部：写文件 → git add → git commit，在同一个 await 链里完成
 *
 * 关键洞察：
 *  旧后端的记忆模型是「她写 → 等 git 提交 → 编译器下一轮才发现」，中间有两个时间点，
 *   那段差就是「写了等于没写」的静默断层（实测留过 2058 秒 / 34 分钟的脏改动）。
 *   新内核是「写和提交是同一个动作」—— 少一个时间差，就少一整类 bug。
 *
 * 数据根：memfs/<agentId>/memory/（沿用现有路径与 markdown 格式，不换）。
 * 数据根由 memory.mjs 的 memoryDir() 计算（已支持 ORB_LEGACY_DATA 环境变量覆盖）。
 */

import {
  existsSync, readFileSync, readdirSync, statSync,
  writeFileSync, renameSync, mkdirSync, unlinkSync, appendFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, relative, resolve, dirname } from 'node:path'
import { memoryDir, searchMemory, isBlockedMemoryPath } from './memory.mjs'

// ── 片段替换的纯逻辑（无 IO，便于单测）───────────────────────
//
// patch_memory 的核心不是"替换"这个动作，而是**失败必须显式、含糊必须拒绝**。
// 2026-10-23 实测：write_memory 占工具调用 23.4%，且只能整文件覆盖 —— 为改一行，
// 她要先读全文（其中 92% 读的是 MEMORY.md，而它每轮已经全文注入系统提示）、
// 再把全文重抄一遍当输出。但换成"片段替换"会引入新风险：
//   old 记错 → 匹配不上 → 若静默退化成"整份重写"，就是凭记忆重构全文，
//   幻觉会顺着这条路直接进记忆仓。所以这里的每个拒绝都要给出**盘上真实内容**。

/** old 片段最短长度：太短的串几乎必然多处命中，是误改的头号来源。 */
export const PATCH_MIN_OLD = 4

/** 一条 patch 里最多几处改动；再多就不该用 patch，该整份重写。 */
export const PATCH_MAX_EDITS = 12

function lineOf(text, index) {
  let n = 1
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n += 1
  }
  return n
}

function countOccurrences(hay, needle) {
  const out = []
  let from = 0
  for (;;) {
    const at = hay.indexOf(needle, from)
    if (at < 0) break
    out.push(at)
    from = at + (needle.length || 1)
  }
  return out
}

/**
 * 找出与 needle 最像的几行（中文用 bigram 重合度，零依赖）。
 * 匹配失败时靠它把**真实内容**交回调用方 —— 否则模型只能凭记忆猜。
 */
export function findClosestLines(content, needle, limit = 3) {
  const grams = (s) => {
    const t = String(s).replace(/\s+/g, '')
    const set = new Set()
    for (let i = 0; i + 1 < t.length; i++) set.add(t.slice(i, i + 2))
    return set
  }
  const ng = grams(needle)
  if (ng.size === 0) return []
  const scored = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (text.trim() === '') continue
    const lg = grams(text)
    let hit = 0
    for (const g of ng) if (lg.has(g)) hit += 1
    const score = hit / ng.size
    if (score > 0.2) scored.push({ line: i + 1, text: text.slice(0, 200), score })
  }
  scored.sort((a, b) => b.score - a.score || a.line - b.line)
  return scored.slice(0, limit).map(({ line, text }) => ({ line, text }))
}

/**
 * 逐处唯一匹配替换。**任何一处不合法就整体失败，绝不部分替换。**
 * @returns {{ok:true,next:string,applied:Array}|{ok:false,error:string,detail?:object}}
 */
export function applyEdits(content, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: 'edits 不能为空：至少要给一处 {old, new}' }
  }
  if (edits.length > PATCH_MAX_EDITS) {
    return { ok: false, error: `edits 最多 ${PATCH_MAX_EDITS} 处；要改这么多就直接 write_memory 整份重写` }
  }

  let cur = content
  const applied = []
  for (let i = 0; i < edits.length; i++) {
    const at = i + 1
    const e = edits[i] || {}
    const oldText = typeof e.old === 'string' ? e.old : ''
    const newText = typeof e.new === 'string' ? e.new : null

    if (oldText === '') return { ok: false, error: `第 ${at} 处：old 不能为空` }
    if (newText === null) return { ok: false, error: `第 ${at} 处：new 必须是字符串（要删掉这段就给空串 ""）` }
    if (oldText === newText) return { ok: false, error: `第 ${at} 处：old 和 new 一模一样，改了等于没改` }
    if (oldText.length < PATCH_MIN_OLD) {
      return { ok: false, error: `第 ${at} 处：old 只有 ${oldText.length} 字，太短容易误伤（至少 ${PATCH_MIN_OLD} 字）` }
    }

    const hits = countOccurrences(cur, oldText)
    if (hits.length === 0) {
      return {
        ok: false,
        error: `第 ${at} 处：文件里找不到这段 old。**不要凭记忆重写**，看下面这几行真实内容再改`,
        detail: { closest: findClosestLines(cur, oldText) },
      }
    }
    if (hits.length > 1) {
      return {
        ok: false,
        error: `第 ${at} 处：old 在文件里命中 ${hits.length} 次，改哪一处不确定。把 old 写长一点（带上前后文）再试`,
        detail: {
          occurrences: hits.slice(0, 6).map((idx) => ({
            line: lineOf(cur, idx),
            text: cur.slice(idx, idx + 160).split('\n')[0],
          })),
        },
      }
    }

    const idx = hits[0]
    const line = lineOf(cur, idx)
    cur = cur.slice(0, idx) + newText + cur.slice(idx + oldText.length)
    applied.push({ index: at, line, removed: oldText.length, added: newText.length })
  }
  return { ok: true, next: cur, applied }
}

// ── git 工具函数 ─────────────────────────────────────────

/**
 * 在指定目录跑 git 命令，返回 {ok, stdout, stderr, code}。
 * 自动处理 Windows 路径和编码。
 */
function gitRun(cwd, args, { timeoutMs = 30000 } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      ...process.env,
      // 确保 git 输出和提交信息用 UTF-8
      LESSCHARSET: 'utf-8',
      GIT_TRACE: '0',
    },
  })

  return {
    ok: result.status === 0,
    code: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    error: result.error,
  }
}

/**
 * git 操作重试：处理 .git/index.lock 冲突和 EBUSY。
 * 最多重试 3 次，每次间隔 500ms。
 */
function gitWithRetry(cwd, args, opts = {}) {
  const maxRetries = opts.maxRetries ?? 3
  const retryDelay = opts.retryDelay ?? 500

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = gitRun(cwd, args, opts)
    if (r.ok) return r

    const isLockConflict = /index\.lock|Unable to create|File exists/i.test(r.stderr || '')
    const isBusy = /EBUSY|resource busy/i.test(r.stderr || '') || r.error?.code === 'EBUSY'

    if ((isLockConflict || isBusy) && attempt < maxRetries) {
      // 等一下再试
      const wait = new Promise((resolve) => setTimeout(resolve, retryDelay * (attempt + 1)))
      // 同步等待（因为整个函数是同步的）—— 用 Atomics.wait 或简单的忙等
      // 实际上 spawnSync 是同步的，我们用一个简单的自旋等待
      const end = Date.now() + retryDelay * (attempt + 1)
      while (Date.now() < end) { /* 忙等 */ }
      continue
    }

    return r
  }

  // 不应该到这里
  return { ok: false, code: -1, stdout: '', stderr: 'max retries exceeded', error: null }
}

/**
 * 组装 git 失败信息。
 *
 * stderr 为空时（spawn 拿不到进程、或 git 把话打在 stdout 上）只抛
 * `git commit failed: ` 等于把线索全丢了 —— 2026-10-19 真机冒烟就只拿到
 * 这一句空信息，没法判断是锁冲突还是「没有改动」。把 code / error / stdout
 * 一并带上，下次一眼能看出是哪一类。
 */
function describeGitFailure(prefix, r) {
  const parts = []
  if (r.code !== null && r.code !== undefined) parts.push(`exit=${r.code}`)
  if (r.error) parts.push(`spawn=${r.error.code || r.error.message}`)
  if (r.stderr) parts.push(`stderr=${r.stderr}`)
  if (r.stdout) parts.push(`stdout=${r.stdout.slice(0, 400)}`)
  return `${prefix}: ${parts.join(' | ') || '未知原因（git 无任何输出）'}`
}

/**
 * 确保 git 用户配置存在（否则 commit 会失败）。
 * 用 -c 参数临时指定，不修改全局配置。
 */
function gitCommitArgs(message) {
  return [
    '-c', 'user.name=Orb',
    '-c', 'user.email=orb@local',
    'commit',
    '-m', message,
  ]
}

// ── 文件工具 ─────────────────────────────────────────────

/** 递归列出文件（跳过 .git），返回相对路径。 */
function walkFiles(dir, base = dir) {
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
    if (ent.isDirectory()) {
      out.push(...walkFiles(full, base))
    } else if (ent.isFile()) {
      out.push(relative(base, full).split('\\').join('/'))
    }
  }
  return out
}

// ── 主实现 ───────────────────────────────────────────────

/**
 * 创建本地实现的记忆内核。
 * @param {object} o
 * @param {string} o.root     项目根（用于日志，实际数据根由 memoryDir 算）
 * @param {string} o.agentId  当前 agentId
 */
export function createLocalMemoryStore({ root, agentId }) {
  if (!agentId) throw new Error('createLocalMemoryStore: agentId is required')

  const repoDir = memoryDir(agentId)

  // ★ 单一写入队列：所有写操作串行
  let writeQueue = Promise.resolve()

  /**
   * 把一个写操作加入队列，确保串行执行。
   */
  function enqueueWrite(fn) {
    const result = writeQueue.then(() => fn())
    // 即使失败也继续队列（不让一个错误堵死后续）
    writeQueue = result.catch(() => {})
    return result
  }

  /**
   * 确保仓库目录和 .git 存在。
   */
  function ensureRepo() {
    if (!existsSync(repoDir)) {
      mkdirSync(repoDir, { recursive: true })
    }
    if (!existsSync(join(repoDir, '.git'))) {
      const r = gitRun(repoDir, ['init'])
      if (!r.ok) {
        throw new Error(`git init failed in ${repoDir}: ${r.stderr}`)
      }
      // ★ 关闭 autocrlf：记忆文件是纯文本，行尾符必须保持原样。
      // Windows git 默认 autocrlf=true 会在 checkout 时把 LF 转成 CRLF，
      // 导致「写进去是 LF、git 恢复后变成 CRLF」的逐字节不一致（V6 踩过）。
      gitRun(repoDir, ['config', 'core.autocrlf', 'false'])
      gitRun(repoDir, ['config', 'core.safecrlf', 'false'])
    }
  }

  /**
   * 读提交历史（`history` 与 `commitList` 共用一条实现）。
   * @param {string} path  文件路径；空 = 全仓
   * @param {number} limit 最多几条
   */
  async function historyOf(path, limit = 40) {
    if (!existsSync(join(repoDir, '.git'))) return []

    const args = ['log', `--max-count=${limit}`, '--pretty=format:%H|%ct|%s']
    if (path) {
      args.push('--', path.split('\\').join('/'))
    }

    const r = gitRun(repoDir, args)
    if (!r.ok) return []

    return r.stdout.split('\n').filter(Boolean).map((line) => {
      const [sha, ts, ...msgParts] = line.split('|')
      return {
        sha: sha || '',
        ts: Number(ts) || 0,
        message: msgParts.join('|') || '',
      }
    })
  }

  return {
    /**
     * 列出记忆文件。
     */
    async list() {
      if (!existsSync(repoDir)) return []
      const files = walkFiles(repoDir)
      return files.map((rel) => {
        const full = join(repoDir, rel)
        let st
        try { st = statSync(full) } catch { return null }
        return {
          path: rel,
          size: st.size,
          mtime: Math.floor(st.mtimeMs),
        }
      }).filter(Boolean)
    },

    /**
     * 读单个记忆文件。不存在返回 null。
     */
    async read(path) {
      const full = resolve(repoDir, path)
      // 越界检查
      const inside = full === repoDir
        ? false
        : (full.startsWith(repoDir + '\\') || full.startsWith(repoDir + '/'))
      if (!inside) return null
      if (!existsSync(full) || !statSync(full).isFile()) return null
      try {
        return readFileSync(full, 'utf8')
      } catch {
        return null
      }
    },

    /**
     * ★ 片段替换：读当前内容 → 逐处唯一匹配 → 落盘（内部走 write()，一次提交）。
     *
     * 为什么单独一个方法：`write()` 只能整文件覆盖，为改一行必须先把全文读进来、
     * 再把全文重抄一遍当输出。patch 把「读—改—写」的机械部分留给宿主，
     * 模型只需要给出改哪一段、改成什么。
     *
     * ★ 与幻觉的关系（设计时的第一约束）：
     *   old 对不上就**整体失败**，并把盘上真实内容回给调用方；
     *   绝不偷偷退化成整份重写 —— "匹配失败 → 凭记忆重构全文"
     *   正是幻觉进记忆仓的主入口。
     *
     * ★ 为什么不自己进队列：write() 内部已经排队，这里再排会嵌套死锁。
     *   读写之间的并发窗口由 expectHash（乐观锁）兜住。
     *
     * @param {string} path
     * @param {Array<{old:string,new:string}>} edits
     * @param {string} [label]
     * @param {{expectHash?:string, dryRun?:boolean, maxBytes?:number}} [opts]
     */
    async patch(path, edits, label = 'tool', opts = {}) {
      const { expectHash = null, dryRun = false, maxBytes = 0 } = opts || {}

      const cur = await this.read(path)
      if (cur === null) {
        return {
          ok: false,
          error: `文件不存在: ${path}（patch 只改已存在的文件；要新建请用 write_memory / save_topic）`,
        }
      }

      const hash = createHash('sha256').update(cur, 'utf8').digest('hex').slice(0, 16)
      if (expectHash) {
        const want = String(expectHash)
        if (hash !== want && !hash.startsWith(want)) {
          return {
            ok: false,
            error: `版本对不上（你要改的是 ${want}，盘上现在是 ${hash}）。先 read_memory 看一眼再改，别按记忆改`,
            detail: { hash },
          }
        }
      }

      const r = applyEdits(cur, edits)
      if (!r.ok) return { ...r, path, hash }

      const bytes = Buffer.byteLength(r.next, 'utf8')
      if (maxBytes > 0 && bytes > maxBytes) {
        return {
          ok: false,
          error: `改完会是 ${bytes}B，超过上限 ${maxBytes}B。先精简再改，或者把细节挪到 journal`,
          detail: { beforeBytes: Buffer.byteLength(cur, 'utf8'), afterBytes: bytes },
        }
      }

      if (dryRun) {
        return { ok: true, dryRun: true, path, hash, applied: r.applied, bytes }
      }

      const w = await this.write(path, r.next, label)
      return {
        ok: true,
        path,
        sha: w.sha,
        changed: w.changed !== false,
        applied: r.applied,
        hash,
        bytes,
        message:
          w.changed === false
            ? '改动与已保存的一致，没有产生新提交'
            : `改了 ${r.applied.length} 处（第 ${r.applied.map((a) => a.line).join('、')} 行）`,
      }
    },

    /**
     * ★ 原子写 + 写即提交。
     *
     * 流程：
     *   1. 确保目录存在
     *   2. 写临时文件（同目录，保证 rename 是同盘原子操作）
     *   3. fs.rename() 原子替换
     *   4. git add <path>
     *   5. git commit（无 diff 则不 commit）
     *
     * 全部在同一个 await 链里（通过 enqueueWrite 串行化）。
     */
    async write(path, content, label = 'tool') {
      return enqueueWrite(async () => {
        ensureRepo()

        const full = resolve(repoDir, path)
        const inside = full === repoDir
          ? false
          : (full.startsWith(repoDir + '\\') || full.startsWith(repoDir + '/'))
        if (!inside) {
          throw new Error(`memstore-local.write: path escapes repo: ${path}`)
        }

        // 确保父目录存在
        const parent = dirname(full)
        if (!existsSync(parent)) {
          mkdirSync(parent, { recursive: true })
        }

        // 1. 写临时文件（同目录）
        const tmpFile = `${full}.tmp-${process.pid}-${Date.now()}`
        writeFileSync(tmpFile, content, 'utf8')

        // 2. 原子替换
        try {
          renameSync(tmpFile, full)
        } catch (err) {
          // 清理临时文件
          try { unlinkSync(tmpFile) } catch { /* ignore */ }
          throw new Error(`memstore-local.write: atomic rename failed: ${err.message}`)
        }

        // 3. git add
        const gitPath = path.split('\\').join('/')
        const addResult = gitWithRetry(repoDir, ['add', '--', gitPath])
        if (!addResult.ok) {
          throw new Error(`memstore-local.write: git add failed: ${addResult.stderr}`)
        }

        // 4. 没有实际改动就不提交。
        //
        // ★ 为什么要先探一次 `git diff --cached --quiet`：
        //    她常把同一段记忆重写一遍（内容一字不差），此时 add 什么都没暂存，
        //    接着 `git commit` 会以 **exit 1 + stderr 为空** 收场（"nothing to
        //    commit" 打在 **stdout** 上，且随 git 语言本地化而变），于是被误判成
        //    「写记忆失败」，她就会对用户说「我写了两回都没写进去」—— 2026-10-19
        //    真机冒烟即栽在这里。用退出码判断，别匹配人话。
        const staged = gitRun(repoDir, ['diff', '--cached', '--quiet', '--', gitPath])
        if (staged.ok) {
          const headResult = gitRun(repoDir, ['rev-parse', 'HEAD'])
          return { sha: headResult.ok ? headResult.stdout : '', changed: false }
        }

        // 5. git commit
        //    提交信息格式固定：`mem: <path> @ <iso> (<label>)`
        //    —— 面板要按它区分「她写的」和「宿主归档的」，别随手改。
        const iso = new Date().toISOString()
        const commitMsg = `mem: ${gitPath} @ ${iso} (${label})`
        const commitResult = gitWithRetry(repoDir, gitCommitArgs(commitMsg))

        if (!commitResult.ok) {
          throw new Error(describeGitFailure('memstore-local.write: git commit failed', commitResult))
        }

        const revResult = gitRun(repoDir, ['rev-parse', 'HEAD'])
        return { sha: revResult.ok ? revResult.stdout : '', changed: true }
      })
    },

    /**
     * 读某个文件的提交历史。
     * 用 git log，支持路径过滤。
     */
    async history(path, limit = 40) {
      return historyOf(path, limit)
    },

    /**
     * 提交列表（面板「历史版本」用）。
     *
     * 与 `history` 的差别只在形状：面板要 `short` 与可直接显示的 `date`，
     * 别让渲染层再按秒数自己算时区。`ts` 保留秒数，方便排序/比较。
     *
     * @param {{path?:string, limit?:number}} o
     * @returns {Promise<Array<{sha:string, short:string, ts:number, date:string, subject:string}>>}
     */
    async commitList({ path = '', limit = 60 } = {}) {
      const rows = await historyOf(path, limit)
      return rows.map((r) => ({
        sha: r.sha,
        short: r.sha.slice(0, 7),
        ts: r.ts,
        date: r.ts ? new Date(r.ts * 1000).toISOString() : '',
        subject: r.message,
      }))
    },

    /**
     * 某次提交的 patch 文本（面板「这次改了什么」）。
     *
     * 只读命令，**不进写入队列**：git 的读操作不会碰 index.lock，
     * 排队反而会让她等一次写提交。
     */
    async diff(sha) {
      if (!sha) throw new Error('memstore-local.diff: sha is required')
      if (!existsSync(join(repoDir, '.git'))) return ''
      const r = gitRun(repoDir, ['show', '--patch', '--no-color', '--stat', sha])
      if (!r.ok) throw new Error(`memstore-local.diff: git show ${sha} 失败：${r.stderr}`)
      return r.stdout
    },

    /**
     * 读任意 git ref 下的文件内容。
     */
    async fileAtRef(path, ref) {
      if (!existsSync(join(repoDir, '.git'))) return ''

      const gitPath = path.split('\\').join('/')
      const r = gitRun(repoDir, ['show', `${ref}:${gitPath}`])
      if (!r.ok) return ''
      return r.stdout
    },

    /**
     * 全文搜索。复用 memory.mjs 的 searchMemory（纯文件读取，零依赖）。
     */
    async search(query) {
      return searchMemory(agentId, query)
    },

    /**
     * ★ 兜底归档：提交所有脏改动。
     * 对应现有 archive.mjs 干的事，但这里直接走 git（不走旧后端协议）。
     */
    async commitAll(label = 'host archive') {
      if (!existsSync(join(repoDir, '.git'))) return { sha: null }

      return enqueueWrite(async () => {
        // git add -A
        const addResult = gitWithRetry(repoDir, ['add', '-A'])
        if (!addResult.ok) {
          throw new Error(describeGitFailure('memstore-local.commitAll: git add failed', addResult))
        }

        // 检查有没有 diff（退出码 0 = 没差异；别去匹配 git 的人话，会被本地化骗）
        const diffResult = gitRun(repoDir, ['diff', '--cached', '--quiet'])
        if (diffResult.ok) {
          // 无 diff，不产生空 commit
          return { sha: null }
        }

        // git commit
        const commitMsg = `chore(memory): ${label}`
        const commitResult = gitWithRetry(repoDir, gitCommitArgs(commitMsg))
        if (!commitResult.ok) {
          throw new Error(describeGitFailure('memstore-local.commitAll: git commit failed', commitResult))
        }

        const revResult = gitRun(repoDir, ['rev-parse', 'HEAD'])
        return { sha: revResult.ok ? revResult.stdout : '' }
      })
    },

    /**
     * ★ 追加一条 journal（append-only，永不覆盖）。
     *
     * 为什么单独一个方法而不是复用 write()：`daily/` 这类文件是**只增长**的，
     * 用 write() 就等于「整文件重写」，一次并发或一次读-改-写就会吞掉中间那条。
     * 这里用 appendFileSync（O_APPEND 语义，单进程内不够原子，所以照样走同一队列）。
     *
     * @param {{text:string, kind?:string, tags?:string[]}} o
     * @returns {Promise<{path:string, sha:string, bytes:number}>}
     */
    async appendJournal({ text, kind = 'fact', tags = [] }) {
      if (typeof text !== 'string' || text.trim() === '') {
        throw new Error('memstore-local.appendJournal: text must be a non-empty string')
      }
      const KINDS = new Set(['fact', 'feel', 'promise', 'growth', 'compact'])
      if (!KINDS.has(kind)) {
        throw new Error(`memstore-local.appendJournal: unknown kind "${kind}"`)
      }

      return enqueueWrite(async () => {
        ensureRepo()
        const now = new Date()
        const iso = now.toISOString()
        const month = iso.slice(0, 7)
        const rel = `journal/${month}.md`
        const full = resolve(repoDir, rel)
        const inside = full.startsWith(repoDir + '\\') || full.startsWith(repoDir + '/')
        if (!inside) throw new Error(`memstore-local.appendJournal: path escapes repo: ${rel}`)

        const parent = dirname(full)
        if (!existsSync(parent)) mkdirSync(parent, { recursive: true })

        // 文件头只在创建时写一次（frontmatter 属于「文件级」属性，不属于某一条）
        if (!existsSync(full)) {
          writeFileSync(
            full,
            `---\ntype: journal\nmonth: ${month}\n---\n\n`,
            'utf8',
          )
        }

        const tagLine = tags.length ? `\ntags: ${tags.join(', ')}` : ''
        const entry = `\n## ${iso} · ${kind}${tagLine}\n\n${text.trim()}\n`
        appendFileSync(full, entry, 'utf8')

        const gitPath = rel
        const addResult = gitWithRetry(repoDir, ['add', '--', gitPath])
        if (!addResult.ok) {
          throw new Error(describeGitFailure('memstore-local.appendJournal: git add failed', addResult))
        }
        const commitMsg = `mem: ${gitPath} @ ${iso} (journal:${kind})`
        const commitResult = gitWithRetry(repoDir, gitCommitArgs(commitMsg))
        if (!commitResult.ok) {
          throw new Error(
            describeGitFailure('memstore-local.appendJournal: git commit failed', commitResult),
          )
        }
        const revResult = gitRun(repoDir, ['rev-parse', 'HEAD'])
        const sha = revResult.ok ? revResult.stdout : ''

        return { path: rel, sha, bytes: Buffer.byteLength(entry, 'utf8') }
      })
    },

    /**
     * path → sha256（跳过 .git 与临时文件）。
     *
     * 用途：注入漂移检测。**不比 mtime** —— mtime 会因为 checkout、touch、
     * 甚至杀毒软件改写而抖动，比出来的「变了」全是假阳性。
     */
    async digests() {
      if (!existsSync(repoDir)) return {}
      const out = {}
      for (const rel of walkFiles(repoDir)) {
        if (rel.includes('.tmp-')) continue
        try {
          const buf = readFileSync(join(repoDir, rel))
          out[rel] = createHash('sha256').update(buf).digest('hex')
        } catch {
          // 读不到就当不存在；不要因为一个文件失败就让整轮注入炸掉
        }
      }
      return out
    },

    /** 当前 HEAD；仓库还没提交过则返回 ''。 */
    async head() {
      if (!existsSync(join(repoDir, '.git'))) return ''
      const r = gitRun(repoDir, ['rev-parse', 'HEAD'])
      return r.ok ? r.stdout.trim() : ''
    },
  }
}
