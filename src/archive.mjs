/**
 * 记忆归档 —— host 兜底把她在回合里写的记忆提交进 git。
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么需要这个模块（一句话）
 * ─────────────────────────────────────────────────────────────
 * **本地后端的 system prompt 只认「已提交」的 revision。**
 *
 * 实测证据（2026-10-07，`logs/tmp/inspect-memrepo.py` + 直读 git 对象）：
 *   `conversations/<conv>/system-prompt.json` 的 `coreMemory`，去掉编译器加的
 *   `<deferred-memory>…</deferred-memory>` 尾巴后，与 `HEAD:MEMORY.md` 的 git blob
 *   **逐字节相同**（HEAD 版 2870 / 工作树 4163 / 编译版 2959 字符，`memfsRevision` 恰等于 HEAD）。
 *
 * 而「她改了文件」**不保证**紧接着有 commit —— 印象那条路径实测留下过
 * 2058 秒（34 分钟）的脏改动。所以她会遇到「写了等于没写」的静默断层：
 * 工作树里有新内容，但她自己的上下文**看不见**。
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么不自己跑 git（重要，别改回去）
 * ─────────────────────────────────────────────────────────────
 * `write_memory_file`（legacy.js:238142）已经做全了：
 *   · 路径白名单（绝对路径 / `..` 穿越 一律拒）
 *   · `git add` + `commit`（`commitMemoryWrite` → `commitMemoryPaths`，可传 message）
 *   · 无 diff 时不产生空 commit（`committed:false`）
 *   · 成功后推 `memory_updated { affected_paths, timestamp }` 给客户端
 * 而且它**自带跨进程串行**（走的是后端那个长驻进程里的 git 锁）。
 * host 侧自己 spawn `git` 有两个坏处：① 沙箱里 `EBUSY`（已经踩过）；
 * ② 与她的提交抢 `.git/index.lock`。所以**一律走协议**。
 *
 * ─────────────────────────────────────────────────────────────
 * ★ 归档 = 提交 = 推进 revision = 下一轮自动生效
 * ─────────────────────────────────────────────────────────────
 * 不需要额外触发「重编译」。本地后端每轮开头都会：
 *   `getOrCompileSystemPrompt()`（legacy.js:118557）
 *     比较 `existing.memfsRevision` 与 `getCommittedMemfsRevision()`
 *     不等 → 重新编译 → `formatMidConversationMemoryUpdate()` 生成 `<memory_update>` 块
 *     → 该块被当作一条 `role:"system"` 消息 push 进本轮 messages（legacy.js:117517）
 * **这就是「她的新记忆立刻在当前会话生效」的全部实现。**
 *
 * ⚠️ 我上一轮把 `promptRecompile` 记成 `false` 是**看错了后端** ——
 *    那是 `HEADLESS_BACKEND_CAPABILITIES`（开发用）。`LocalBackend.capabilities`
 *    里明确写着 `promptRecompile: true`（legacy.js:118189）。
 */

/**
 * 归档范围白名单：**只碰印象那条链路里「她会写的」那些文件**。
 *
 * ⚠️ 为什么要精确到文件、而不是「`about/` 整个目录」：
 *   目录里还有一个 `about/MEMORY.md` —— 那是 MemFS v2 要求的**目录索引**，
 *   **由 host 自己写**（`ensureImpressionFiles()`，`write_memory_file` 自带 commit）。
 *   host 写的东西本来就一定在 git 里，再让它进归档范围只会平白多一次 git 调用。
 *
 * ⚠️ 为什么不放 `MEMORY.md` / `persona*`：
 *   · `MEMORY.md` 是基线。`reset_memory.cmd` 的语义就是「把它 `reset --hard` 回干净基线」，
 *     host 主动提交它会让「哪些是测试期写进去的」变得不可分辨；
 *   · `persona*` 由 `_inject_v2.ps1` 管（走 agent json 的 `system` 字段），
 *     记忆仓里的副本只是投影，host 不该替它做决定。
 */
export const ARCHIVE_ALLOW = [
  'about/印象.md',
]

/**
 * 目录级白名单：`about/` 下**她可能自建**的子文件也算（比如她按日期分文件写）。
 * 但**排除目录索引本身**（理由见上）。
 */
export const ARCHIVE_ALLOW_DIRS = [
  { dir: 'about/', exclude: ['about/MEMORY.md'] },
]

/** 静默期：文件 mtime 距今 ≥ 这个毫秒数，才认为「这一笔写完了」。 */
export const ARCHIVE_QUIET_MS = Number(process.env.ORB_ARCHIVE_QUIET_MS ?? 4000)

/**
 * 归档两次之间的最小间隔。
 *
 * ⚠️ 必须有：`turn_finished` 每次回合结束都来一把，而一次归档要发协议请求
 *    （`read_memory_file` + 可能一次 `write_memory_file`，后者内部跑 git）。
 *    不节流 = 每轮都白跑。
 *    但它**不能太保守** —— 太保守就退化成「等下一个定时器」，等于没兜底。
 *    5 分钟：一次连续对话里最多多跑几次 git，成本可忽略。
 */
export const ARCHIVE_FLOOR_MS = 5 * 60 * 1000

/** 这个相对路径在归档范围内吗？ */
export function isArchivable(relPath) {
  const p = String(relPath ?? '').replace(/\\/g, '/')
  if (!p) return false
  if (p.split('/').some((seg) => seg === '..' || seg === '.git')) return false
  if (ARCHIVE_ALLOW.includes(p)) return true
  for (const { dir, exclude = [] } of ARCHIVE_ALLOW_DIRS) {
    if (!p.startsWith(dir)) continue
    if (p.length <= dir.length) continue          // 目录本身不是文件
    if (exclude.includes(p)) continue             // 目录索引是 host 写的，别管
    return true
  }
  return false
}

/**
 * 造一个归档器。依赖全部注入，**不 import 别的 src 模块** ——
 * 这样单测（`probe/archive-test.mjs`）能把依赖全换成假的，不用起旧后端。
 *
 * @param {{
 *   log: (msg: string) => void,
 *   request: (type: string, payload: object, timeoutMs?: number) => Promise<any>,
 *   readMemoryFile: (agentId: string, relPath: string) => {content: string, mtimeMs: number} | null,
 *   listMemory: (agentId: string) => {files: Array<{path: string, updatedAt: string}>},
 *   floorMs?: number,
 *   quietMs?: number,
 * }}
 */
export function createArchiver(deps) {
  const {
    log,
    request,
    readMemoryFile,
    listMemory,
    floorMs = ARCHIVE_FLOOR_MS,
    quietMs = ARCHIVE_QUIET_MS,
  } = deps

  let lastRunAt = 0
  /** @type {Promise<{committed: number, skipped: string}> | null} 同一时刻只跑一个，防重入。 */
  let inFlight = null

  /**
   * 挑出「改过、且已经安静下来」的文件。
   *
   * 判据全部建立在 **mtime** 上，不依赖 commit —— 因为要兜的正是「改了但没 commit」。
   */
  function pickPending(agentId, now = Date.now()) {
    let files
    try {
      files = listMemory(agentId)?.files ?? []
    } catch (err) {
      log(`归档：列记忆文件失败 ${err.message}`)
      return { pending: [], stale: 0, hot: 0 }
    }
    const pending = []
    let stale = 0
    let hot = 0
    for (const f of files) {
      if (!isArchivable(f.path)) continue
      const rel = readMemoryFile(agentId, f.path)
      if (rel === null) continue
      const age = now - rel.mtimeMs
      if (age >= quietMs) { pending.push({ path: f.path, content: rel.content, age }) } else { hot += 1 }
      // 「stale」= 已经提交过但工作树里 mtime 还更新 —— 需要靠 git 自己判断有没有 diff，
      // 这里数不出来，交给 writeMemoryFile 的返回值。占位统计留 0。
      stale += 0
    }
    return { pending, stale, hot }
  }

  /**
   * 跑一轮归档。
   *
   * ★ 顺序很重要：**先看有没有活干（本地读盘，几乎免费），再看节流。**
   *   反过来会把主路径饿死 —— 实测踩过：`memory_updated`（host 刚写的 commit 推来的）
   *   先跑了一次、把 5 分钟额度吃掉，12 秒后真正的 `turn-end` 就被节流掉了，
   *   于是「她这个回合写的记忆」要等到下一个回合才归档。
   *
   * ★ 因此**主路径（`ready` / `turn-end`）绕过节流** —— 它们是功能正确性所依赖的触发点，
   *   而节流本来只是为了省掉高频空转（次数由「有没有脏文件」这一层已经挡掉大半）。
   *
   * @param {string} agentId
   * @param {{reason?: string, force?: boolean}} [opts]
   * @returns {Promise<{committed: number, checked: number, hot: number, skipped: string}>}
   */
  async function run(agentId, { reason = 'idle', force = false } = {}) {
    if (inFlight) return inFlight
    const now = Date.now()

    // ① 先做便宜的判断：这一轮到底有没有「改过且已安静」的文件？
    const { pending, hot } = pickPending(agentId, now)
    if (pending.length === 0) {
      return { committed: 0, checked: 0, hot, skipped: 'nothing-pending' }
    }

    // ② 有活干，才看节流。主路径不受限。
    const isPrimary = reason === 'ready' || reason === 'turn-end'
    if (!force && !isPrimary && now - lastRunAt < floorMs) {
      return { committed: 0, checked: 0, hot, skipped: 'throttled' }
    }
    lastRunAt = now

    inFlight = (async () => {
      let committed = 0
      for (const f of pending) {
        try {
          // ⚠️ 用**整段原样内容**覆盖写回。`write_memory_file` 是覆盖语义，
          //    内容与工作树一致时 `commitMemoryPaths` 只会把那一路径 `git add`，
          //    有 diff 才有 commit；无 diff 返回 `committed:false` —— 正好是我们要的幂等。
          const r = await request('write_memory_file', {
            agent_id: agentId,
            path: f.path,
            content: f.content,
            // 标题写清楚是谁干的：看一眼 reflog 就能区分
            // `Orb`(host 兜底) / `旧后端 Agent`(她自己) 两种提交。
            commit_message: `chore(memory): host 归档 ${f.path}（${reason}）`,
          }, 60_000)
          if (r?.success === true && r?.committed === true) {
            committed += 1
            log(`归档：${f.path} 已提交 ${String(r.commit_sha ?? '').slice(0, 7)}（静默 ${Math.round(f.age / 1000)}s，${reason}）`)
          }
        } catch (err) {
          // 失败不算错：可能是 git 索引正被她占着 —— 下一轮重试即可。
          log(`归档：${f.path} 失败（下一轮重试）${err.message}`)
        }
      }
      return { committed, checked: pending.length, hot, skipped: committed > 0 ? '' : 'no-diff' }
    })()

    try {
      return await inFlight
    } finally {
      inFlight = null
    }
  }

  /** 重置节流（测试 / 用户点「立即归档」时用）。 */
  function resetFloor() {
    lastRunAt = 0
  }

  return { run, resetFloor, _pickPending: pickPending }
}
