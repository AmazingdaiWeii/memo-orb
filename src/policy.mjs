/**
 * policy.mjs · 她能把「手」伸多远（三级策略：读 / 写 / 执行）
 *
 * 2026-10-19 用户拍板：**读全盘（C/D/E/F）+ 写限白名单 + 危险动作必确认**。
 * 所以这里不是「沙箱」，是「有边界的自由」：
 *
 *   read   黑名单制 —— 全盘都能看，只挡「看一眼就可能被泄露出去」的东西
 *          （私钥、浏览器凭据、本项目的 provider key、DSH 自己的 token）。
 *   write  白名单制 + 白名单外弹卡（一次性放行，宿主不记住）。
 *   exec   默认关闭（P2 阶段连工具都不给；给了也只能跑 data/sandbox/ 下的脚本）。
 *
 * ★ 两个踩过的坑，写在这里免得重犯：
 *   1. **路径要归一化后再比**。本项目已踩过一次：`resolve('E:/…') !== resolve('E:\\…')`
 *      在字符串层面看着不同。这里统一 `resolve()` → 反斜杠换正斜杠 → 小写，再比。
 *      这也是为什么黑名单用 glob 匹配「小写正斜杠绝对路径」而不是字符串包含。
 *   2. **目录本身也要挡住**。`**\/.ssh/**` 只挡得住在 `.ssh/` 里面的文件；若只比对
 *      完整路径，她仍能 `list_dir('.ssh')` 把文件名列出来。所以匹配时把每一级祖先
 *      目录都加尾斜杠试一遍。
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve, sep, isAbsolute, dirname } from 'node:path'
import { homedir } from 'node:os'

/** 缺省策略。`data/policy.json` 不存在时自动落一份，用户可以直接改。 */
export function defaultPolicy(dataRoot) {
  return {
    read: {
      deny: [
        '**/.ssh/**',
        '**/.aws/**',
        '**/.dsh/**',
        '**/providers/auth.json',
        '**/Login Data',
        '**/Cookies',
        '**/*.pfx',
        '**/*.pem',
        '**/id_rsa*',
        '**/wechat.json',
        // B 站登录态（2026-10-21）：SESSDATA 等于账号凭据，agent 读走就等于把号交出去。
        // 注意这是「缺省策略」——磁盘上已存在的 data/policy.json 不会自动长出新条目，
        // 需要手动补（见 data/policy.json 的 read.deny）。
        '**/bili-auth.json',
      ],
      maxBytes: 262144,
    },
    write: {
      allow: [join(dataRoot, 'workspace').split(sep).join('\\')],
      askOutside: true,
    },
    exec: {
      enabled: false,
      timeoutMs: 60000,
      maxOutputBytes: 8192,
    },
  }
}

/**
 * 把 glob 编译成正则。只支持本项目需要的四种记法，不做完整 glob：
 *   `**` 任意层级、`*` 段内任意、`?` 单字符、其余原样（已小写+正斜杠）。
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function compileGlob(pattern) {
  const p = String(pattern ?? '').replace(/\\/g, '/').toLowerCase()
  let re = ''
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        re += '.*'
        i += 1
        // `**/` 允许零层（`/a/**/b` 能匹配 `/a/b`）
        if (p[i + 1] === '/') i += 1
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('\\^$+.()|{}[]'.includes(c)) {
      re += `\\${c}`
    } else {
      re += c
    }
  }
  return new RegExp(`^${re}$`)
}

/** 归一化成「小写正斜杠绝对路径」——所有比较都在这一个形态上做。 */
export function normalizePath(p) {
  return resolve(String(p ?? '')).split(sep).join('/').toLowerCase()
}

/** 路径 + 每一级祖先目录（带尾斜杠），用于「目录本身也要挡」。 */
function pathVariants(absPath) {
  const norm = normalizePath(absPath)
  // ★ 第一条必须是 `norm + '/'`：`**\/.ssh/**` 这种规则要求「.ssh 后面还有东西」，
  //   而目录本身没有。不加这一条，`list_dir('.ssh')` 就能把里面的文件名列出来。
  const out = [`${norm}/`, norm]
  let cur = norm
  while (cur.length > 2) {
    const cut = cur.lastIndexOf('/')
    if (cut <= 0) break
    cur = cur.slice(0, cut)
    out.push(`${cur}/`)
  }
  return out
}

/**
 * 创建策略对象。
 *
 * @param {object} o
 * @param {string} o.dataRoot  数据根（`data/`）
 * @param {Function} [o.log]
 */
export function createPolicy({ dataRoot, log = () => {} }) {
  if (!dataRoot) throw new Error('createPolicy: dataRoot is required')
  const configPath = join(dataRoot, 'policy.json')

  let cache = null
  let cacheMtime = -1

  /** 读策略（按 mtime 自动重载 ⇒ 「改完即生效」，不用重启）。 */
  function get() {
    let mtime = -1
    try {
      mtime = statSync(configPath).mtimeMs
    } catch {
      mtime = -1
    }
    if (cache && mtime === cacheMtime) return cache

    if (mtime < 0) {
      // 首次运行：落一份缺省，让用户看得见、改得动。
      const dft = defaultPolicy(dataRoot)
      try {
        mkdirSync(dirname(configPath), { recursive: true })
        writeFileSync(configPath, `${JSON.stringify(dft, null, 2)}\n`, 'utf8')
        log(`[policy] 生成了缺省策略 ${configPath}`)
      } catch (err) {
        log(`[policy] 缺省策略落盘失败（用内存里的）：${err.message}`)
      }
      cache = dft
      cacheMtime = -1
      return cache
    }

    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
      const dft = defaultPolicy(dataRoot)
      cache = {
        read: { ...dft.read, ...(parsed.read ?? {}) },
        write: { ...dft.write, ...(parsed.write ?? {}) },
        exec: { ...dft.exec, ...(parsed.exec ?? {}) },
      }
      cacheMtime = mtime
      return cache
    } catch (err) {
      log(`[policy] 解析 ${configPath} 失败（退回缺省）：${err.message}`)
      cache = defaultPolicy(dataRoot)
      cacheMtime = mtime
      return cache
    }
  }

  // 建的时候就把缺省策略落盘（用户能立刻看见 `data/policy.json` 并改它，
  // 而不是等第一次读写才「悄悄」生成）。
  get()

  /**
   * 把模型给的路径变成绝对路径。
   * - 相对路径 → 一律相对 `data/workspace/`（她的桌面）
   * - `~` → 用户主目录
   * - UNC 一律拒（`\\server\share` 会走网络，不在「本机全盘」语义里）
   *
   * @param {string} raw
   * @param {{base?: string}} [o]
   */
  function resolveInput(raw, { base } = {}) {
    const s0 = String(raw ?? '').trim()
    if (!s0) throw new Error('path 不能为空（写 "." 表示当前目录）')
    if (s0.includes('\u0000')) throw new Error('路径里有非法字符')
    if (s0.startsWith('\\\\') || s0.startsWith('//')) {
      throw new Error(`网络路径（UNC）不碰：${s0}`)
    }
    let s = s0
    if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = join(homedir(), s.slice(1))
    const root = base ?? join(dataRoot, 'workspace')
    return isAbsolute(s) ? resolve(s) : resolve(root, s)
  }

  /** 读：命中黑名单就返回**命中的那条规则**（给她看，好让她知道为什么），放行返回 null。 */
  function readDenyReason(absPath) {
    const rules = (get().read.deny ?? []).map((p) => ({ p, re: compileGlob(p) }))
    if (rules.length === 0) return null
    const variants = pathVariants(absPath)
    for (const rule of rules) {
      if (variants.some((v) => rule.re.test(v))) return rule.p
    }
    return null
  }

  /** 是否落在写白名单内。 */
  function insideWriteRoot(absPath) {
    const norm = normalizePath(absPath)
    for (const root of get().write.allow ?? []) {
      const r = normalizePath(root).replace(/\/+$/, '')
      if (!r) continue
      if (norm === r || norm.startsWith(`${r}/`)) return root
    }
    return null
  }

  /**
   * 写：`free` 免审批 / `ask` 弹卡 / `deny` 直接拒。
   *
   * ★ 「白名单内免审批」只对**新建**成立。覆盖一个已存在的文件仍要问一次：
   *   新建最坏是多一个文件，覆盖是不可逆的（我们没有 delete_file，也没有 undo）。
   *
   * @param {string} absPath
   * @param {{exists?: boolean}} [o]
   */
  function writeVerdict(absPath, { exists = false } = {}) {
    if (readDenyReason(absPath)) {
      return { mode: 'deny', reason: `这个路径在隐私黑名单里，不写：${normalizePath(absPath)}` }
    }
    const root = insideWriteRoot(absPath)
    if (root && !exists) return { mode: 'free', reason: `在白名单内（${root}）` }
    if (root && exists) return { mode: 'ask', reason: '覆盖一个已存在的文件（不可逆）' }
    if (get().write.askOutside) return { mode: 'ask', reason: '在白名单外，只放行这一次' }
    return { mode: 'deny', reason: '在白名单外，且策略不允许放行' }
  }

  return {
    path: configPath,
    get,
    resolveInput,
    readDenyReason,
    insideWriteRoot,
    writeVerdict,
    get maxReadBytes() {
      return Number(get().read.maxBytes) || 262144
    },
    get execEnabled() {
      return get().exec.enabled === true
    },
    get execOptions() {
      return get().exec
    },
  }
}

/** 给 system prompt 用的一行现状（她得知道自己能碰到哪儿）。 */
export function describePolicy(policy) {
  const p = policy.get()
  const roots = (p.write.allow ?? []).map((r) => r.split('\\').join('/'))
  const denyCount = (p.read.deny ?? []).length
  return (
    `读：全盘（${denyCount} 类隐私路径除外）· ` +
    `写：${roots.length ? roots.join('、') : '（无白名单）'}${p.write.askOutside ? '（外面临时放行需确认）' : '（外面一律不写）'} · ` +
    `执行：${p.exec.enabled ? '可跑 data/sandbox 下的脚本' : '关闭'}`
  )
}
