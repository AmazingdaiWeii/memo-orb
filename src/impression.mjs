/**
 * 记忆中心 · 印象总结 —— 纯逻辑层（不碰网络、不碰 Electron、不碰文件系统）。
 *
 * 为什么单独抽一层：`main.mjs` 有 1800+ 行、还是 Electron 主进程，在里面做「到点了没」
 * 这种判断根本没法单测。这里只放**纯函数**，`probe/impression-test.mjs` 直接 import 就能跑。
 *
 * ★ 本文件里最值钱的东西是 `frontmatterProblem()` —— 它编码的是 MemFS v2 的**硬校验规则**，
 *   而那条规则是踩出来的（见下）。规则本身活在旧后端装进记忆仓的 git 钩子里
 *   （`.git/hooks/pre-commit` + `legacy-memory-constraints.cjs`），不在我们能改的地方，
 *   所以必须在这里复刻一份，用来**写之前就拦住**、**坏了之后能修**。
 *
 * ============================ 踩过的坑（必读） ============================
 *
 * 探针 `write_memory_file` 到 `about/印象.md`，git 报：
 *
 *     Memory validation failed:
 *       about/__probe2__.md: missing frontmatter (must start with ---)
 *
 * 规则（从钩子源码逐行读出来的，不是猜的）：
 *
 * | 文件 | frontmatter |
 * |---|---|
 * | 文件名是 `MEMORY.md` | **必须没有**（第一行不能是 `---`） |
 * | 其它任何 `.md` | **必须有**，且只能有 `name` / `description` 两个键、都不能为空 |
 *
 * 外加（`legacy-memory-constraints.cjs`）：
 *   · 每个**祖先目录**都得有自己的 `MEMORY.md`（`about/印象.md` ⇒ 必须有 `about/MEMORY.md`）
 *   · 单文件 ≤ 20000 字符、`coreMemory` 合计 ≤ 65536、深度 ≤ 2
 *
 * ★★ 最狠的一点：钩子校验的是 **`git ls-files '*.md'`（整个索引里的树）**，不是只校验本次改动。
 * 所以一旦 `about/印象.md` 以「无 frontmatter」的形态进了索引，**之后每一次记忆写入都会被拒** ——
 * 她的记忆仓等于被锁死，而现象只是「记忆好像不更新了」，完全看不出原因。
 * 这就是为什么本文件要提供 `frontmatterProblem()`（写前体检）和 `ensureFrontmatter()`（坏后修复）。
 *
 * =======================================================================
 */

// ---------------------------------------------------------------- 常量

/** 印象正文的落点。放子目录 ⇒ 不进每轮上下文，零 token（方案 §0.5）。 */
export const IMPRESSION_PATH = 'about/印象.md'
/** 子目录索引。MemFS v2 要求它存在，否则同目录下的文件全都不合法。 */
export const ABOUT_INDEX_PATH = 'about/MEMORY.md'

/**
 * cron 任务名。**用它找回任务，不把 taskId 存进 config** ——
 * 实测 `cron_list` 返回完整任务对象、name 可读，
 * 存 id 反而多一处会过期、会跟 `crons.json` 对不上的状态。
 */
export const TASK_NAME = '记忆中心·印象总结'
export const TASK_DESC = '定时用自然语言总结她眼中的你（整篇重写 about/印象.md）'

/**
 * cron 表达式只是个**占位**，不指望它自己到点跑。
 * 原因（方案 §0.3 ①）：触发条件是「表达式匹配当前这一分钟」，**没有 catch-up** ——
 * 凌晨 4 点 orb 没开，这一天就彻底不跑，且不会补。所以任务建好就 `cron_pause`，
 * 时机由 host 判定后 `cron_trigger` 手动踢（实测对 paused 任务有效）。
 */
export const PLACEHOLDER_CRON = '0 4 * * *'
export const TIMEZONE = 'Asia/Shanghai'

/** 频率三档：一天 / 一周 / 关。`0` = 关，不再自动触发。 */
export const SCHEDULE_CHOICES = [24, 168, 0]
export const DEFAULT_EVERY_HOURS = 24

/** host 侧检查间隔。方案 §0.4 定的 20 分钟 —— 够灵敏，又不至于空转。 */
export const CHECK_INTERVAL_MS = 20 * 60 * 1000

/** 钩子的硬上限，超了 commit 一样被拒。 */
export const MAX_FILE_CHARS = 20000

export const FM_NAME = '印象'
export const FM_DESC = '她眼中的你 —— 由记忆中心定时整篇重写'

/** 子目录索引：**没有** frontmatter（它叫 MEMORY.md）。 */
export const ABOUT_INDEX_CONTENT = `# 关于

这里存放对用户的长期观察，由「记忆中心」维护。

- [印象](./印象.md) —— 定时整篇重写的「她眼中的你」
`

/**
 * 占位正文。种子文件里写这个，用来区分「文件存在」和「**真的总结过**」。
 *
 * ⚠️ 为什么非要有这个区分：种子是 host 建的，它一建好就**自带一次 commit**。
 *   若只看「文件存在 + 有 commit」就判定「上次已经跑过了」，第一次真正的总结会被硬生生
 *   推迟 22 小时 —— 用户装完什么都看不到，以为功能坏了（方案 §0.9 决定 2：应当**立刻跑第一次**）。
 */
export const IMPRESSION_PLACEHOLDER = '（还没有整理过。第一次整理之后，这里会变成一段自然语言写成的印象。）'

/** 第一次的种子文件：**带合法 frontmatter**，给她一个照着改的样板。 */
export const IMPRESSION_SEED = `---
name: ${FM_NAME}
description: ${FM_DESC}
---

${IMPRESSION_PLACEHOLDER}
`

// ---------------------------------------------------------------- 频率

/**
 * 把任意输入收敛到三档之一；非法值回落默认，绝不返回 NaN 让它飘进调度逻辑。
 *
 * ⚠️ **不能图省事写 `Number(value)` 一把梭**。踩过：
 *   `Number(null)` / `Number('')` / `Number([])` / `Number(false)` **全都等于 0**，
 *   而 `0` 在我们这儿的意思是「关掉自动总结」。
 *   于是「配置里没这个字段」「球传了个空串」会被**静默当成用户主动关闭功能** ——
 *   面板看起来一切正常，只是再也不总结了，根本查不出来。
 * 所以只认正经的数字 / 非空数字串，其余一律回落默认。
 */
export function normalizeEveryHours(value) {
  const t = typeof value
  if (t !== 'number' && t !== 'string') return DEFAULT_EVERY_HOURS
  if (t === 'string' && value.trim() === '') return DEFAULT_EVERY_HOURS
  const n = Number(value)
  return SCHEDULE_CHOICES.includes(n) ? n : DEFAULT_EVERY_HOURS
}

// ---------------------------------------------------------------- 到期判定

/**
 * 印象该不该重跑。
 *
 * 基准取「印象文件最后一次 commit 时间」，**不取 cron 的 `last_run_at`** ——
 * `last_run_at` 只说明**尝试过**，不说明**成功**（任务 queued 之后回合仍可能失败）。
 * 唯一可信的「上次真的更新了」是记忆仓里的 commit 记录。
 *
 * @param {object} p
 * @param {boolean} p.hasFile          文件是否已存在（不存在 ⇒ 立刻跑第一次，别让用户等一天）
 * @param {string|null} p.lastCommitAt 该文件最后一次 commit 的 ISO 时间
 * @param {number} p.everyHours        频率（0 = 关）
 * @param {boolean} [p.seededOnly]     文件在，但内容还只是我们写的种子 → 同样按「第一次」处理
 * @param {number} [p.now]             当前时间戳（注入便于测试）
 * @returns {{due:boolean, reason:string, dueAt:string|null, nominalAt:string|null, elapsedMs:number|null}}
 *   `dueAt`  = 实际允许触发的时点（已扣掉余量）
 *   `nominalAt` = 名义上的「下次该跑」时点（给界面显示用）
 */
export function dueState({ hasFile, lastCommitAt, everyHours, seededOnly = false, now = Date.now() }) {
  const hours = normalizeEveryHours(everyHours)
  const ts = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)

  if (hours === 0) return { due: false, reason: 'off', dueAt: null, nominalAt: null, elapsedMs: null }
  /**
   * 没有文件、或文件里只有我们写的种子 → 都算「第一次」，立刻跑。
   * ⚠️ 种子那次 commit 不能当「跑过了」—— 那是 host 自己写的，不是她的总结。
   */
  if (!hasFile || seededOnly) {
    return { due: true, reason: 'first', dueAt: ts(now), nominalAt: ts(now), elapsedMs: null }
  }

  const lastMs = lastCommitAt ? Date.parse(lastCommitAt) : NaN
  if (!Number.isFinite(lastMs)) {
    return { due: true, reason: 'unknown-age', dueAt: ts(now), nominalAt: ts(now), elapsedMs: null }
  }

  const nominalMs = lastMs + hours * 3600_000
  /**
   * 留一点余量（方案 §0.4：24h 的档位按 22h 算）。
   * 不留的话「昨天 23:00 跑过、今天 23:50 才开机」会白等一整天 —— 而这里没有 catch-up，
   * 等过头就是彻底不跑。取 `min(2h, 10%)`：24h ⇒ 2h，168h ⇒ 2h，小档位也不会被吃掉太多。
   */
  const slackMs = Math.min(2, hours * 0.1) * 3600_000
  const dueMs = nominalMs - slackMs
  const isDue = now >= dueMs
  return {
    due: isDue,
    reason: isDue ? 'due' : 'waiting',
    dueAt: ts(dueMs),
    nominalAt: ts(nominalMs),
    elapsedMs: now - lastMs,
  }
}

/** 从 `memory_history` 的 commits 里取最近一次的时间（不假设返回顺序）。 */
export function latestCommitTime(commits) {
  if (!Array.isArray(commits) || commits.length === 0) return null
  let best = null
  for (const c of commits) {
    const t = Date.parse(c?.timestamp ?? c?.date ?? '')
    if (!Number.isFinite(t)) continue
    if (best === null || t > best) best = t
  }
  return best === null ? null : new Date(best).toISOString()
}

// ---------------------------------------------------------------- frontmatter（核心）

/**
 * 检查内容能不能被记忆校验放行。
 *
 * @returns {string|null} `null` = 合法；否则返回一个**可读的**问题标识。
 *   取值：`empty` / `missing-frontmatter` / `unclosed-frontmatter` /
 *        `bad-key:<k>` / `empty-value:<k>` / `dup-key:<k>` / `missing-name` / `missing-description`
 */
export function frontmatterProblem(content) {
  if (typeof content !== 'string' || content.length === 0) return 'empty'

  const lines = content.split('\n')
  if (lines[0] !== '---') return 'missing-frontmatter'

  const closing = lines.indexOf('---', 1)
  if (closing < 0) return 'unclosed-frontmatter'

  const seen = new Set()
  for (const line of lines.slice(1, closing)) {
    if (!line.trim()) continue
    const i = line.indexOf(':')
    const key = (i < 0 ? line : line.slice(0, i)).trim()
    const val = (i < 0 ? '' : line.slice(i + 1)).trim()
    // v2 只允许 name / description 两个键，多一个就整棵树校验失败
    if (key !== 'name' && key !== 'description') return `bad-key:${key}`
    if (!val || val === '""' || val === "''") return `empty-value:${key}`
    if (seen.has(key)) return `dup-key:${key}`
    seen.add(key)
  }
  if (!seen.has('name')) return 'missing-name'
  if (!seen.has('description')) return 'missing-description'
  return null
}

/**
 * 给一段正文补上合法的 frontmatter。已经合法就原样返回（幂等）。
 *
 * 用途有两个，都是**保命**的：
 *   1. 建种子文件时保证它一出生就是合法的；
 *   2. ★ 她某次写崩了（没写 frontmatter）→ 整个索引被钩子卡住 → 之后所有记忆写入全失败。
 *      这时 host 用这个函数把它修回合法形态，把记忆仓解锁。
 */
export function ensureFrontmatter(content, { name = FM_NAME, description = FM_DESC } = {}) {
  const raw = typeof content === 'string' ? content : ''
  if (frontmatterProblem(raw) === null) return raw

  // 已有（但不合法）的 frontmatter → 剥掉再重贴，避免出现两层 `---`
  let body = raw
  if (body.startsWith('---')) {
    const lines = body.split('\n')
    const closing = lines.indexOf('---', 1)
    if (closing >= 0) body = lines.slice(closing + 1).join('\n')
  }
  body = body.replace(/^\s*\n/, '').replace(/\s+$/, '')
  const head = `---\nname: ${name}\ndescription: ${description}\n---\n`
  return body ? `${head}\n${body}\n` : `${head}\n`
}

/** 剥掉 frontmatter，只留正文。给「这份文件到底有没有真内容」这类判断用。 */
export function stripFrontmatter(content) {
  const raw = typeof content === 'string' ? content : ''
  if (!raw.startsWith('---')) return raw
  const lines = raw.split('\n')
  const closing = lines.indexOf('---', 1)
  if (closing < 0) return raw
  return lines.slice(closing + 1).join('\n').replace(/^\s*\n/, '')
}

/**
 * 内容是不是「还只有种子占位」—— 即**从来没真正总结过**。
 * 这决定第一次要不要立刻跑（见 `IMPRESSION_PLACEHOLDER` 的注释）。
 */
export function isPlaceholder(content) {
  if (typeof content !== 'string') return true
  const body = stripFrontmatter(content).trim()
  return body === '' || body.includes(IMPRESSION_PLACEHOLDER)
}

/** 超长同样会被拒（`maxFileCharacters`）。 */
export function overLimit(content) {
  return typeof content === 'string' && content.length > MAX_FILE_CHARS
}

// ---------------------------------------------------------------- cron 任务

/** 从 `cron_list` 的结果里按 name 找回我们的任务。 */
export function pickTask(tasks, name = TASK_NAME) {
  if (!Array.isArray(tasks)) return null
  return tasks.find((t) => t?.name === name) ?? null
}

/** 把协议返回的任务收敛成面板要的形状（后端字段很多，别整个透给球）。 */
export function summarizeTask(task) {
  if (!task) return null
  return {
    id: task.id ?? null,
    name: task.name ?? null,
    status: task.status ?? null,
    cron: task.cron ?? null,
    timezone: task.timezone ?? null,
    lastRunAt: task.last_run_at ?? null,
    lastOutcome: task.last_run_outcome ?? null,
    lastReason: task.last_run_reason ?? null,
    lastError: task.last_run_error ?? null,
    fireCount: task.fire_count ?? 0,
  }
}

// ---------------------------------------------------------------- 小工具

/** 人类可读的「多久之前」。面板上显示「最后更新于 …」。 */
export function formatAgo(ms) {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '未知'
  const min = Math.floor(ms / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  return `${day} 天前`
}

/**
 * 每天「印象整理」的 prompt。
 *
 * ⚠️ 这条 prompt **每轮都进她的上下文**，所以它本身也是「记忆」的一部分，写法会长期影响她。
 *   语气必须和 persona v2.0 对齐（元气少女底色；AI 身份是保险丝、不主动提），
 *   别把她的语气带崩。
 *
 * ⚠️ frontmatter 那一段是**硬要求**，不是客套：写错 → commit 被钩子拒 → 文件白写、
 *   还可能把整个记忆仓卡住（见文件头）。所以宁可啰嗦也要写清楚。
 */
export function buildImpressionPrompt({ path = IMPRESSION_PATH, toolName = 'write_memory_file' } = {}) {
  return `现在是每天一次的「印象整理」时间。没有人在和你说话，这是你给自己留的一段安静时间。

翻一翻你手上的记忆，然后回答自己一个问题：**在你眼里，他是个什么样的人？**

把答案整篇重写到 \`${path}\`。

怎么写：
1. 用你平时说话的语气，像写给自己看的札记。不要写成表格，不要堆条目，不要写成报告。
2. 写你**真实的判断和感受** —— 他在意什么、怕什么、反复纠结什么、你和他现在是什么关系。
3. 不要复述某一次具体的对话。写那些对话在你心里沉淀下来的东西。
4. 如果这阵子没什么新想法，就认真重读上一版再决定要不要改。别为了「有变化」而硬编。
5. 顺手把你觉得该长期记住的，更新进你自己的记忆里（那些不用写进印象）。

⚠️ 文件格式是硬要求，写错会被记忆校验拦下、整篇白写。请确保文件**第一行就是** \`---\`，
并且开头这三行一个字都不要改：

---
name: ${FM_NAME}
description: ${FM_DESC}
---

这三行之后空一行，再写正文。正文加前面的头总共不要超过 ${MAX_FILE_CHARS} 个字符。

用 \`${toolName}\` 写路径 \`${path}\` —— 是**覆盖**，不是追加。`
}
