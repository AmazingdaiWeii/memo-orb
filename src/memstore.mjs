/**
 * memstore.mjs · 记忆内核接口 + 工厂
 *
 * 设计意图：把「记忆怎么存」从 main.mjs 里彻底摘出来。
 * 今天后面接的是旧后端实现，将来换自建实现时，只换实现，不改调用方。
 *
 * 这是接口文件：只定义契约与工厂分派，不写具体实现。
 * 实现见：
 *   - memstore-legacy.mjs（现有旧后端行为的封装，行为零变化）
 *   - memstore-local.mjs（新内核：原子写 / 串行队列 / 写即提交）
 *
 * ★ 硬性要求：
 *   1. 失败必须 throw，禁止静默吞错（这个项目吃过「静默丢弃族」的亏）
 *   2. write/read 必须先过 isBlockedMemoryPath()，不许绕过
 *   3. write 语义 = 原子 + 立即可见（写完立刻能读到）
 *   4. list 返回相对路径（与 memory.mjs 的 listMemory 口径一致）
 */

import { isBlockedMemoryPath } from './memory.mjs'

/**
 * 记忆内核工厂。
 *
 * @param {object} o
 * @param {'legacy'|'local'} o.engine   实现选择
 * @param {string} o.root               项目根（E:\Memo orb）
 * @param {string} o.agentId            当前 agent（legacy 实现要用；local 实现可忽略）
 * @param {object} [o.legacy]            engine='legacy' 时传入的 LegacyConnection
 * @returns {Promise<MemoryStore>}
 */
export async function createMemoryStore({ engine, root, agentId, legacy }) {
  if (!engine) throw new Error('createMemoryStore: engine is required')
  if (!root) throw new Error('createMemoryStore: root is required')

  let impl
  switch (engine) {
    case 'legacy': {
      if (!legacy) throw new Error('createMemoryStore: engine=legacy requires legacy connection')
      const mod = await import('./memstore-legacy.mjs')
      impl = mod.createLegacyMemoryStore({ legacy, agentId })
      break
    }
    case 'local': {
      if (!agentId) throw new Error('createMemoryStore: engine=local requires agentId')
      const mod = await import('./memstore-local.mjs')
      impl = mod.createLocalMemoryStore({ root, agentId })
      break
    }
    default:
      throw new Error(`createMemoryStore: unknown engine "${engine}" (expected 'legacy' or 'local')`)
  }

  // 包装一层：统一路径守卫 + 确保所有方法都返回 Promise
  return wrapWithGuards(impl)
}

/**
 * 给实现包一层统一的路径守卫和异常透传。
 * 实现本身也应该做守卫，但这里是最后一道防线。
 */
function wrapWithGuards(impl) {
  const guardPath = (method, path) => {
    if (isBlockedMemoryPath(path)) {
      throw new Error(`memstore.${method}: blocked memory path: ${JSON.stringify(path)}`)
    }
  }

  return {
    async list() {
      return impl.list()
    },
    async read(path) {
      guardPath('read', path)
      return impl.read(path)
    },
    async write(path, content, label) {
      guardPath('write', path)
      if (typeof content !== 'string') {
        throw new Error(`memstore.write: content must be string, got ${typeof content}`)
      }
      return impl.write(path, content, label)
    },
    async history(path, limit) {
      guardPath('history', path)
      return impl.history(path, limit)
    },
    async fileAtRef(path, ref) {
      guardPath('fileAtRef', path)
      if (!ref) throw new Error('memstore.fileAtRef: ref is required')
      return impl.fileAtRef(path, ref)
    },
    async search(query) {
      if (typeof query !== 'string' || query.trim() === '') {
        throw new Error('memstore.search: query must be a non-empty string')
      }
      return impl.search(query)
    },
    async commitAll(label) {
      return impl.commitAll(label)
    },
    /** 追加一条 journal（宿主/工具共用同一条串行队列，不绕过队列直接写盘）。 */
    async appendJournal({ text, kind, tags }) {
      if (typeof text !== 'string' || text.trim() === '') {
        throw new Error('memstore.appendJournal: text must be a non-empty string')
      }
      return impl.appendJournal({ text, kind, tags })
    },
    /** path → sha256。用于漂移检测（快照里存一份，之后每次比）。 */
    async digests() {
      return impl.digests()
    },
    /** 当前 HEAD commit。记忆仓可能还没有提交 → 返回 ''。 */
    async head() {
      return impl.head()
    },
    /** ★ 提交列表（面板「历史版本」）。`path` 给定时只看这个文件。 */
    async commitList({ path, limit } = {}) {
      if (path) guardPath('commitList', path)
      if (typeof impl.commitList !== 'function') {
        throw new Error('memstore.commitList: 当前实现没有这个方法（engine=legacy 请走协议 memory_history）')
      }
      return impl.commitList({ path, limit })
    },
    /** ★ 某次提交的 patch（面板「这次改了什么」）。 */
    async diff(sha) {
      if (typeof sha !== 'string' || sha.trim() === '') {
        throw new Error('memstore.diff: sha must be a non-empty string')
      }
      if (typeof impl.diff !== 'function') {
        throw new Error('memstore.diff: 当前实现没有这个方法（engine=legacy 请走协议 memory_commit_diff）')
      }
      return impl.diff(sha)
    },
  }
}

/**
 * @typedef {object} MemoryStore
 * @property {() => Promise<Array<{path:string,size:number,mtime:number}>>} list
 * @property {(path:string) => Promise<string>} read
 * @property {(path:string, content:string) => Promise<{sha:string}>} write   ★ 原子 + 写即提交
 * @property {(path:string, limit:number) => Promise<Array<{sha:string,ts:number,message:string}>>} history
 * @property {(path:string, ref:string) => Promise<string>} fileAtRef
 * @property {(query:string) => Promise<Array<{path:string,line:number,text:string}>>} search
 * @property {(label:string) => Promise<{sha:string|null}>} commitAll          ★ 兜底归档
 * @property {(o:{text:string,kind?:string,tags?:string[]}) => Promise<{path:string,sha:string,bytes:number}>} appendJournal  ★ append-only journal
 * @property {() => Promise<Record<string,string>>} digests                    ★ path → sha256（漂移检测）
 * @property {() => Promise<string>} head                                      ★ 当前 HEAD（可能为 ''）
 * @property {(o?:{path?:string, limit?:number}) => Promise<Array<{sha:string, short:string, ts:number, date:string, subject:string}>>} commitList  ★ 提交列表
 * @property {(sha:string) => Promise<string>} diff                             ★ 某次提交的 patch 文本
 */
