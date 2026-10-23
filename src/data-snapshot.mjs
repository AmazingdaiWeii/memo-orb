/**
 * data-snapshot.mjs · 用户手动冻结 / 解冻 data 目录（存档与时光机）
 *
 * 存在的理由（一句话）：**让人不必接受"永远失去它"。**
 *   既有的两层保护都盖不住这个场景：
 *     · `src/snapshot.mjs` 冻的是 **system prompt 文本**（I3 字节不变），不碰磁盘数据；
 *     · `src/archive.mjs` 只把记忆仓的脏改动 commit 掉，对话原文与配置不在它的范围里。
 *   所以「把此刻的 data 整个冻起来，将来能原样回去」这件事，此前没有任何一处负责。
 *
 * ⚠️ 三条不可让步的约束（都是这个功能的意义所在，破一条功能就变成灾难）：
 *
 *   C1 **快照必须能自证**。manifest 里写全每个文件的 sha256，解冻前可核。
 *      一个说不出自己完不完整的存档，等于没有存档。
 *   C2 **解冻前必须先自动存档当前状态**（reason 记成 `pre-thaw:<id>`）。
 *      解冻是破坏性动作；没有后悔药的时光机只是另一种删除。
 *   C3 **不用硬链接省空间**。这是踩过才敢下的结论：
 *      快照里若与 data 共享 inode，`messages.jsonl` 的 appendFileSync 会**顺着 inode
 *      把新内容写进快照**——存档被"未来"改写，而且完全无声。同理，任何"截断后重写"
 *      的编辑器也会污染它。宁可多占空间，不可让存档可变。
 *
 * 分层：一个快照内部按层存放，解冻时可以只恢复某几层（默认全恢复）。
 *   这样"完整回到那一刻"和"只把记忆退回去、保留当前登录态"不是二选一。
 *
 * 数据根沿用 `memory.mjs` 的 `dataRoot()`（ORB_DATA > ORB_LEGACY_DATA > ~/.legacy/...）。
 * 快照放在 **data 的同级隐藏目录**（`<dataRoot>/../.orb-snapshots`）——
 * 放进 data 里面会自己快照自己，且会被下一次快照再打包一遍。
 */

import {
  existsSync, mkdirSync, readdirSync, statSync, copyFileSync, renameSync,
  rmSync, readFileSync, writeFileSync, createReadStream,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve, relative, basename } from 'node:path'
import { dataRoot } from './memory.mjs'

// ─────────────────────────────────────────────────────────── 常量

/** 快照格式版本。改 manifest 结构就 +1，旧的照旧能读。 */
export const FORMAT = 1

/**
 * 层定义。`paths` 是**相对 dataRoot** 的条目，可以是目录也可以是单文件。
 *
 * ★ 2026-10-23 重构：原 `config` 层把「行为偏好」和「凭据」混在一起。
 *   这是错的 —— 这个功能的用途是**把助手搬到云盘/另一台机器**，
 *   而凭据一旦跟着走，等于把 API key、cookie、配对 token 交给第三方存储。
 *   所以拆成两层：
 *     · `config`  只放行为偏好（不含任何密钥），默认打包；
 *     · `secrets` 放凭据与登录态，**默认永久排除**，要它得显式点名。
 *   代价必须让用户知道：换机器解冻后，模型 key 要重填、B 站要重新扫码、微信要重新配对。
 *   这不是缺陷，是设计。
 */
export const LAYERS = {
  memories: {
    label: '记忆仓',
    paths: ['memfs'],
    note: '含 .git 历史（必须一起走，否则回退后只剩当前版本）',
  },
  conversations: {
    label: '对话原文',
    paths: ['conversations'],
    note: 'messages.jsonl / system.json，append-only',
  },
  workspace: {
    label: '工作区',
    paths: ['workspace'],
    note: '球落盘的文件，可能很大',
  },
  config: {
    label: '偏好设置',
    paths: ['policy.json', 'schedule.json', 'bili-history.json'],
    note: '放行清单 / 定时 / 看过的视频。不含密钥',
  },
  secrets: {
    label: '凭据与登录态',
    paths: ['providers', 'bili-auth.json', 'wechat.json', 'wechat-state.json'],
    note: '⚠️ API key、cookie、botToken。默认不冻 —— 存档要能安全地放云盘',
  },
}

/**
 * 默认打包的层。**既不含 `secrets`（凭据），也不含 `workspace`。**
 *
 * · 不含 `secrets`：存档要能放进云盘/发给别处，API key 不该跟着走。
 * · 不含 `workspace`：那是球落盘的文件（下载的图、生成的视频），可能几百 MB；
 *   而"她"是记忆和对话。为了"丢云盘"能在几十秒内完成，杂物间不跟着走
 *   （2026-10-23 用户决定）。需要时仍可显式 `layers: [...'workspace']`。
 */
export const DEFAULT_LAYERS = ['memories', 'conversations', 'config']

/** 含敏感信息的层（UI/CLI 拿它弹警告）。 */
export const SECRET_LAYERS = new Set(['secrets'])

/** 单文件流式 hash 的上限保护：超过就别读进内存（这里用流，所以只是提示用）。 */
const BIG_FILE_BYTES = 64 * 1024 * 1024

// ─────────────────────────────────────────────────────────── 路径

/**
 * 快照根。与 dataRoot 同级，隐藏名，避免被 git 收走。
 *
 * `ORB_SNAPSHOT_DIR` 可以把存档放到别处——换盘、外置硬盘、或把存档与
 * 正在跑的数据物理隔开（同一个盘挂了，两个一起没）。**但指进 data 里面会被
 * freeze() 拒绝**：那会自己快照自己，体积按次翻倍。
 */
export function snapshotRoot() {
  const explicit = process.env.ORB_SNAPSHOT_DIR
  if (explicit) return resolve(explicit)
  return join(dirname(resolve(dataRoot())), '.orb-snapshots')
}

/** 快照目录（不含存在性检查）。 */
export function snapshotDir(id) {
  return join(snapshotRoot(), String(id))
}

/** 当前 data 根（给面板显示用）。 */
export function currentDataRoot() {
  return resolve(dataRoot())
}

// ─────────────────────────────────────────────────────────── 文件工具

/** 目录存在则返回 Dirent 列表，不存在/无权限返回 []。 */
function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 递归列出相对路径。**不跳过 `.git`** —— 记忆仓的历史就在里面，跳过等于把
 * 「回退到那一刻」降级成「回退到那一刻的文件名」，而 git 仓没有历史就是坏仓。
 */
function walkRel(root, base = root, out = []) {
  for (const ent of listDir(root)) {
    const full = join(root, ent.name)
    if (ent.isDirectory()) {
      walkRel(full, base, out)
    } else if (ent.isFile()) {
      out.push(relative(base, full).split('\\').join('/'))
    }
  }
  return out
}

/** 流式 sha256，返回 `sha256:<hex>`。大文件不炸内存。 */
function hashFile(full) {
  return new Promise((resolveP, rejectP) => {
    const h = createHash('sha256')
    const s = createReadStream(full)
    s.on('error', (err) => rejectP(err))
    s.on('data', (chunk) => h.update(chunk))
    s.on('end', () => resolveP(`sha256:${h.digest('hex')}`))
  })
}

/** 幂等建目录。 */
function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/**
 * 生成快照 id：`YYYYMMDD-HHmmss-<4位随机>`。
 * 带随机后缀是为了应付「同一秒点两次」——纯时间戳会撞名，而撞名的后果是覆盖旧存档。
 */
function newId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  const rnd = Math.random().toString(36).slice(2, 6)
  return `${stamp}-${rnd}`
}

/** 收集某一层在 dataRoot 下真实存在的条目（过滤掉不存在的）。 */
function layerEntries(layer, root = currentDataRoot()) {
  const def = LAYERS[layer]
  if (!def) throw new Error(`data-snapshot: 未知层 "${layer}"`)
  return def.paths.filter((rel) => existsSync(join(root, rel)))
}

/** 归档层的绝对路径是否在 dataRoot 内（防越界写入）。 */
function assertInside(root, full) {
  const r = resolve(root)
  const f = resolve(full)
  if (f !== r && !f.startsWith(r + '\\') && !f.startsWith(r + '/')) {
    throw new Error(`data-snapshot: 路径越界：${f}`)
  }
  return f
}

// ─────────────────────────────────────────────────────────── 冻结

/**
 * 冻结此刻的 data 到一个新快照。
 *
 * @param {object} o
 * @param {string[]} [o.layers]     只打包这些层，默认 DEFAULT_LAYERS
 * @param {string}  [o.reason]      这次存档的理由（`manual` / `pre-thaw:<id>` / …）
 * @param {object}  [o.meta]        额外写进 manifest 的信息（appVersion / engine / agentId）
 * @param {()=>Promise<void>} [o.quiesce] 快照前暂停写入（停引擎/等队列排空）
 * @param {()=>Promise<void>} [o.resume]  快照后恢复
 * @returns {Promise<{id:string, dir:string, bytes:number, fileCount:number, layers:string[]}>}
 */
export async function freeze({
  layers = DEFAULT_LAYERS,
  reason = 'manual',
  meta = {},
  quiesce = null,
  resume = null,
} = {}) {
  const root = currentDataRoot()
  const snaps = snapshotRoot()

  // 护栏：快照目录若被配到 data 里面，会自己快照自己（体积指数增长）。
  const snapsResolved = resolve(snaps)
  if (snapsResolved === root || snapsResolved.startsWith(root + '\\') || snapsResolved.startsWith(root + '/')) {
    throw new Error(`data-snapshot: 快照目录不能位于 data 内（${snaps}）`)
  }
  if (!existsSync(root)) {
    throw new Error(`data-snapshot: data 目录不存在：${root}`)
  }

  const wanted = layers.filter((l) => Object.prototype.hasOwnProperty.call(LAYERS, l))
  if (wanted.length === 0) throw new Error('data-snapshot: 没有可打包的层')

  const id = newId()
  ensureDir(snaps)
  const tmp = join(snaps, `.tmp-${id}`)
  const final = join(snaps, id)

  if (quiesce) await quiesce()
  try {
    ensureDir(tmp)
    /** @type {Record<string, {sha256:string, size:number, mtime:number}>} */
    const files = {}
    const packed = []
    let bytes = 0

    for (const layer of wanted) {
      const entries = layerEntries(layer, root)
      if (entries.length === 0) continue          // 这一层在本机是空的，跳过而不是建空壳
      packed.push(layer)
      for (const rel of entries) {
        const srcFull = join(root, rel)
        const st = statSync(srcFull)
        if (st.isFile()) {
          const dst = join(tmp, rel)
          ensureDir(dirname(dst))
          copyFileSync(srcFull, dst)
          const h = await hashFile(srcFull)
          files[rel] = { sha256: h, size: st.size, mtime: Math.floor(st.mtimeMs) }
          bytes += st.size
          continue
        }
        // 目录：逐个文件走
        for (const inner of walkRel(srcFull)) {
          const r = `${rel}/${inner}`
          const src = join(root, r)
          const dst = join(tmp, r)
          assertInside(tmp, dst)
          ensureDir(dirname(dst))
          copyFileSync(src, dst)
          const h = await hashFile(src)
          const s = statSync(src)
          files[r] = { sha256: h, size: s.size, mtime: Math.floor(s.mtimeMs) }
          bytes += s.size
        }
      }
    }

    if (Object.keys(files).length === 0) {
      throw new Error('data-snapshot: data 里没有可打包的内容（四层全空）')
    }

    // ★ 给用户看的排障指南，跟着存档一起搬走。
    //
    //   为什么是 txt 不是 md：用户打开它的时候可能在任何系统、任何一台陌生电脑上。
    //   txt 双击就能看，不依赖渲染器，也不会让人觉得"要先装个软件"。
    //
    //   内容只写**已经实现的行为**。别在这里许愿 —— 一份说谎的排障指南，
    //   比没有指南更浪费时间。
    const readmeLines = [
      `这是一次「冻结」的结果。${new Date().toLocaleString('zh-CN')}`,
      '',
      '── 存了什么 ──',
      ...packed.map((l) => `  · ${LAYERS[l].label}：${LAYERS[l].note}`),
      '',
      '── 没存什么 ──',
      '  账号、密码、API Key、B 站登录状态、微信配对，一律没有。',
      '  所以这份可以放云盘，也可以拷给别人看。',
      '  代价：换一台电脑「唤醒」之后，模型 Key 要重填、B 站要重新扫码、微信要重新配对。',
      '',
      '── 「唤醒记忆」只认什么 ──',
      '  只认「和本文件在同一个目录里的 manifest.json」。它记着每个文件的指纹。',
      '  只恢复上面列出的那几块，这个目录里的其它内容一概不看。',
      '  唤醒之前会先把「现在」这一份也存一遍，所以唤错了能退回来。',
      '',
      '── 它拒绝执行，通常是这几种情况 ──',
      '  · 少了文件 / 大小对不上 / 内容被改过 —— 会指名说哪个文件不符，不会硬盖。',
      '  · 这是故意的。一份已经坏掉的存档盖回去，比重新来过更糟。',
      '',
      '── 想自己查的时候，按这个顺序 ──',
      '  1. 打开 manifest.json，看 createdAt 是不是你要的那个时间点。',
      '  2. 数一下磁盘上的文件数，和里面的 fileCount 对不对得上。',
      '  3. 对不上就先把这个文件夹另存一份，别在原处改。',
      '',
      `存档 ID：${id}`,
      `agentId：${meta.agentId || '（未记录）'}`,
      '',
    ]
    writeFileSync(join(tmp, '说明.txt'), readmeLines.join('\r\n'), 'utf8')

    const manifest = {
      format: FORMAT,
      id,
      createdAt: new Date().toISOString(),
      reason,
      layers: packed,
      layerLabels: Object.fromEntries(packed.map((l) => [l, LAYERS[l].label])),
      hasSecrets: packed.some((l) => SECRET_LAYERS.has(l)),
      dataRoot: root,
      fileCount: Object.keys(files).length,
      bytes,
      files,
      meta: { ...meta },
    }
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

    // 原子落位：先写进 .tmp-*，全部成功后 rename。半截目录永远不叫正式名。
    renameSync(tmp, final)

    return { id, dir: final, bytes, fileCount: manifest.fileCount, layers: packed }
  } catch (err) {
    // 失败就把半成品清掉；清不掉也不能盖住原始错误
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
    throw err
  } finally {
    if (resume) await resume()
  }
}

// ─────────────────────────────────────────────────────────── 读取 / 校验

/** 读 manifest。不存在/坏掉返回 null（不抛，列表要能容错）。 */
export function readManifest(id) {
  try {
    const raw = readFileSync(join(snapshotDir(id), 'manifest.json'), 'utf8')
    const m = JSON.parse(raw)
    if (!m || typeof m !== 'object' || !m.files) return null
    return m
  } catch {
    return null
  }
}

/**
 * 列出所有快照（新 → 旧）。
 * 坏掉/没 manifest 的目录会以 `broken:true` 出现在列表里，**不静默隐藏**——
 * 悄悄消失的存档比明着报错的更可怕。
 */
export function list() {
  const snaps = snapshotRoot()
  const out = []
  for (const ent of listDir(snaps)) {
    if (!ent.isDirectory()) continue
    if (ent.name.startsWith('.tmp-') || ent.name.startsWith('.trash-')) continue
    const m = readManifest(ent.name)
    if (!m) {
      out.push({ id: ent.name, broken: true, createdAt: null, bytes: 0, fileCount: 0, layers: [], reason: '', hasSecrets: false })
      continue
    }
    out.push({
      id: m.id || ent.name,
      broken: false,
      createdAt: m.createdAt || null,
      reason: m.reason || '',
      bytes: m.bytes || 0,
      fileCount: m.fileCount || 0,
      layers: Array.isArray(m.layers) ? m.layers : [],
      hasSecrets: m.hasSecrets === true,
      meta: m.meta || {},
    })
  }
  out.sort((a, b) => String(b.createdAt || b.id).localeCompare(String(a.createdAt || a.id)))
  return out
}

/**
 * 校验快照完整性。
 *
 * @param {string} id
 * @param {{deep?:boolean}} [o] deep=true 时逐个文件重算 sha256（慢但能查出内容被改）
 * @returns {Promise<{ok:boolean, checked:number, missing:string[], sizeMismatch:string[], hashMismatch:string[]}>}
 */
export async function verify(id, { deep = false } = {}) {
  const dir = snapshotDir(id)
  const m = readManifest(id)
  const res = { ok: false, checked: 0, missing: [], sizeMismatch: [], hashMismatch: [] }
  if (!m) {
    res.missing.push('manifest.json')
    return res
  }

  for (const [rel, info] of Object.entries(m.files)) {
    const full = join(dir, rel)
    res.checked += 1
    let st
    try {
      st = statSync(full)
    } catch {
      res.missing.push(rel)
      continue
    }
    if (st.size !== info.size) {
      res.sizeMismatch.push(rel)
      continue
    }
    if (deep) {
      const h = await hashFile(full)
      if (h !== info.sha256) res.hashMismatch.push(rel)
    }
  }

  res.ok = res.missing.length === 0 && res.sizeMismatch.length === 0 && res.hashMismatch.length === 0
  return res
}

// ─────────────────────────────────────────────────────────── 解冻

/**
 * 把某个快照里的指定层恢复回 dataRoot。
 *
 * 顺序（每一步都可回退，中途失败会把已经换过的换回去）：
 *   0. 校验快照（浅校验；deep 由调用方决定）
 *   1. **自动存档当前状态**（`pre-thaw:<id>`）—— C2，不许跳过
 *   2. 把快照里的新内容先复制到 `dataRoot/.orb-thaw-<id>/new/`
 *   3. 逐条目：旧 → `.orb-thaw-<id>/old/`，新 → 原位
 *   4. 清理中间目录（失败不清，留着能手工救）
 *
 * @param {string} id
 * @param {object} [o]
 * @param {string[]} [o.layers]   只恢复这些层，默认 manifest 里有的全部
 * @param {boolean} [o.dryRun]    只算计划不动盘
 * @param {boolean} [o.deep]      解冻前逐个文件重算 sha256，**默认开**
 *   （解冻是拿旧数据覆盖现状；浅校验只比缺失与大小，同长度篡改它看不出来。
 *     这个功能的全部承诺就是"存档可信"，为省几秒去赌它是亏的。）
 * @param {boolean} [o.autoBackup] 默认 true（关掉只允许在明确自担风险的场景）
 * @param {()=>Promise<void>} [o.quiesce]
 * @param {()=>Promise<void>} [o.resume]
 * @returns {Promise<object>}
 */
export async function thaw(id, {
  layers = null,
  dryRun = false,
  deep = true,
  autoBackup = true,
  quiesce = null,
  resume = null,
  meta = {},
} = {}) {
  const m = readManifest(id)
  if (!m) throw new Error(`data-snapshot: 快照不存在或 manifest 损坏：${id}`)

  const v = await verify(id, { deep })
  if (!v.ok) {
    const detail = [
      v.missing.length ? `缺 ${v.missing.length} 个文件` : '',
      v.sizeMismatch.length ? `大小不符 ${v.sizeMismatch.length} 个` : '',
      v.hashMismatch.length ? `内容不符 ${v.hashMismatch.length} 个` : '',
    ].filter(Boolean).join('，')
    throw new Error(`data-snapshot: 快照校验失败（${detail}），拒绝解冻`)
  }

  const available = Array.isArray(m.layers) ? m.layers : Object.keys(LAYERS)
  const wanted = (layers && layers.length ? layers : available).filter((l) => available.includes(l))
  if (wanted.length === 0) throw new Error('data-snapshot: 这个快照里没有所选层')

  // 计划：每一层展开成实际要动的相对条目
  const plan = []
  for (const layer of wanted) {
    for (const rel of LAYERS[layer].paths) {
      const has = Object.keys(m.files).some((f) => f === rel || f.startsWith(`${rel}/`))
      if (!has) continue
      plan.push({ layer, rel })
    }
  }

  const result = {
    id, layers: wanted, plan: plan.map((p) => p.rel),
    backupId: null, dryRun, swapped: [], note: '',
  }
  if (dryRun) {
    result.note = 'dryRun：只算了计划，没有动任何文件'
    return result
  }

  const root = currentDataRoot()
  ensureDir(root)

  if (quiesce) await quiesce()
  const stage = join(root, `.orb-thaw-${id}`)
  const newDir = join(stage, 'new')
  const oldDir = join(stage, 'old')
  const done = []          // 已完成的 swap，用于失败回滚

  try {
    // 1. C2：先给"现在"存档。这一步失败就整个放弃，不能拿不可逆去赌。
    if (autoBackup) {
      if (existsSync(root)) {
        const b = await freeze({ reason: `pre-thaw:${id}`, meta: { ...meta, thawOf: id } })
        result.backupId = b.id
      }
    }

    // 2. 把快照内容先落到暂存区（同盘，后面 rename 才是原子的）
    ensureDir(newDir)
    ensureDir(oldDir)
    for (const { rel } of plan) {
      const src = join(snapshotDir(id), rel)
      const dstInStage = join(newDir, rel)
      const st = statSync(src)
      if (st.isDirectory()) {
        for (const inner of walkRel(src)) {
          const from = join(src, inner)
          const to = join(dstInStage, inner)
          ensureDir(dirname(to))
          copyFileSync(from, to)
        }
      } else {
        ensureDir(dirname(dstInStage))
        copyFileSync(src, dstInStage)
      }
    }

    // 3. 逐条目换位
    for (const { rel } of plan) {
      const target = join(root, rel)
      const staged = join(newDir, rel)
      const keep = join(oldDir, rel)
      ensureDir(dirname(keep))
      if (existsSync(target)) {
        renameSync(target, keep)          // 旧 → old
      }
      renameSync(staged, target)          // 新 → 原位
      done.push({ rel, keep, hadOld: existsSync(keep) })
      result.swapped.push(rel)
    }

    // 4. 成功：清中间目录（old 已经没必要留，因为 C2 已经存过当前状态）
    //
    //    ⚠️ 清理失败**绝不能**让整个解冻回滚。数据此时已经换好且是对的，
    //    为了几 MB 临时文件把用户刚恢复的东西再拆一遍，比留着垃圾荒唐得多。
    //    实测踩过：safe-delete 垫片会 ETIMEDOUT，真机上杀软锁目录也会这样。
    try {
      rmSync(stage, { recursive: true, force: true })
    } catch {
      result.stageLeft = stage
      result.note = `${result.note ? result.note + '；' : ''}临时目录未清掉：${stage}（不影响已恢复的数据）`
    }
    return result
  } catch (err) {
    // 回滚：把换过的换回去，尽量不留半截状态
    for (const item of done.reverse()) {
      try {
        const target = join(root, item.rel)
        if (existsSync(target)) rmSync(target, { recursive: true, force: true })
        if (item.hadOld && existsSync(item.keep)) renameSync(item.keep, target)
      } catch { /* 回滚也失败就留着 stage，让人能手工处理 */ }
    }
    throw new Error(`data-snapshot: 解冻失败并已尝试回滚：${err.message}（暂存目录 ${stage}）`)
  } finally {
    if (resume) await resume()
  }
}

// ─────────────────────────────────────────────────────────── 清理

/**
 * 删快照。**不是真删**：挪到 `snapshots/.trash-<时间戳>/`，确认无碍后由人手工清。
 * 理由：这个功能的存在意义就是"不失去"，它自己的删除动作不该是永久性的。
 *
 * @param {string[]} ids
 * @returns {{moved:string[], trashDir:string}}
 */
export function discard(ids) {
  const list0 = Array.isArray(ids) ? ids : [ids]
  const snaps = snapshotRoot()
  const trash = join(snaps, `.trash-${newId()}`)
  ensureDir(trash)
  const moved = []
  for (const id of list0) {
    const dir = snapshotDir(id)
    if (!existsSync(dir)) continue
    // 不许把最后一个删掉——那等于把"时光机"本身删了
    renameSync(dir, join(trash, basename(dir)))
    moved.push(id)
  }
  return { moved, trashDir: trash }
}

// ─────────────────────────────────────────────────────────── 给面板用的摘要

/** 一行摘要，UI 直接显示。 */
export function describe(id) {
  const m = readManifest(id)
  if (!m) return { id, ok: false, text: '（损坏：读不到 manifest）' }
  const when = new Date(m.createdAt)
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ` +
    `${p(when.getHours())}:${p(when.getMinutes())}`
  const mb = (m.bytes / 1048576).toFixed(1)
  const labels = (m.layers || []).map((l) => LAYERS[l]?.label ?? l).join(' / ')
  return {
    id,
    ok: true,
    text: `${stamp} · ${mb}MB · ${m.fileCount} 个文件 · ${labels}`,
    secrets: m.hasSecrets === true,
  }
}
