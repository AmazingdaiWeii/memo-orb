/**
 * memstore-legacy.mjs ·旧后端实现的记忆内核封装
 *
 * 把 main.mjs 里第一类的 6 个旧后端记忆调用搬进来，用 memstore 接口的方法名包一层。
 *
 * ★ 铁律：行为零变化。同样参数 → 同样结果。这不是「优化」，是「搬家」。
 *
 * 对应关系：
 *   list        → legacy.request('list_memory')
 *   read        → legacy.request('read_memory_file')
 *   write       → legacy.request('write_memory_file')（自带 git commit）
 *   history     → legacy.request('memory_history')
 *   fileAtRef   → legacy.request('memory_file_at_ref')
 *   search      → 协议无 search，用 memory.mjs 的 searchMemory（本机直读，与 main.mjs 一致）
 *   commitAll   →旧后端 write 自带 commit，无需额外兜底，返回 {sha:null}
 */

import { searchMemory } from './memory.mjs'

/**
 * 创建旧后端实现的记忆内核。
 * @param {object} o
 * @param {object} o.legacy   LegacyConnection（有 request 方法）
 * @param {string} o.agentId 当前 agentId
 */
export function createLegacyMemoryStore({ legacy, agentId }) {
  if (!legacy) throw new Error('createLegacyMemoryStore: legacy connection is required')
  if (!agentId) throw new Error('createLegacyMemoryStore: agentId is required')

  /**
   * 统一请求包装：失败一律 throw，禁止静默吞错。
   */
  async function req(type, extra, timeoutMs) {
    const r = await legacy.request(type, extra, timeoutMs)
    if (!r || r.success !== true) {
      const err = String(r?.error ?? JSON.stringify(r ?? {}).slice(0, 300))
      throw new Error(`legacy.${type} failed: ${err}`)
    }
    return r
  }

  return {
    /**
     * 列出记忆文件。
     *旧后端协议返回 entries[{relative_path, content, size(字符数), ...}]，
     * 统一成接口格式 [{path, size(真字节数), mtime}]。
     * 协议不返回 mtime，设为 0（调用方应能处理）。
     */
    async list() {
      const r = await req('list_memory', { agent_id: agentId }, 15_000)
      return (r.entries ?? []).map((e) => {
        const content = e.content ?? ''
        return {
          path: String(e.relative_path ?? ''),
          size: e.kind === 'image'
            ? Number(e.size ?? 0)
            : Buffer.byteLength(content, 'utf8'),
          mtime: 0, // 协议不返回修改时间
        }
      })
    },

    /**
     * 读单个记忆文件内容。
     * 文件不存在时返回 null（与 main.mjs readMemoryText 的 ENOENT 处理一致）。
     */
    async read(path) {
      try {
        const r = await req('read_memory_file', { agent_id: agentId, path }, 15_000)
        return String(r.content ?? '')
      } catch (err) {
        // 不存在是正常情况（第一次还没有印象文件），不是错误
        if (/ENOENT|no such file/i.test(String(err.message))) return null
        throw err
      }
    },

    /**
     * 写记忆文件。write_memory_file 自带 git add + commit。
     * 返回 {sha} ——旧后端不返回新 commit 的 sha，返回空字符串占位。
     */
    async write(path, content) {
      await req('write_memory_file', { agent_id: agentId, path, content }, 60_000)
      return { sha: '' }
    },

    /**
     * 读某个文件的提交历史。
     * 支持 file_path 过滤（查不存在的文件返回空数组）。
     */
    async history(path, limit = 40) {
      const r = await req('memory_history',
        { agent_id: agentId, file_path: path, limit }, 30_000)
      return (r.commits ?? []).map((c) => ({
        sha: String(c.sha ?? ''),
        ts: c.timestamp ? Date.parse(c.timestamp) : 0,
        message: String(c.message ?? ''),
      }))
    },

    /**
     * 读任意 git SHA 下的文件内容（精确溯源/回滚预览）。
     */
    async fileAtRef(path, ref) {
      const r = await req('memory_file_at_ref',
        { agent_id: agentId, file_path: path, ref }, 15_000)
      return String(r.content ?? '')
    },

    /**
     * 全文搜索。旧后端协议没有 search 命令（实测 memory_search/search_memory 都无响应），
     * 用本机直读 searchMemory（与 main.mjs memory:search 处理一致）。
     */
    async search(query) {
      return searchMemory(agentId, query)
    },

    /**
     * 兜底归档。旧后端的 write_memory_file 自带 commit，不存在「写了但没提交」的脏改动，
     * 所以这里是空操作，返回 {sha:null}。
     * （原来的 archive.mjs 兜底也是走 write_memory_file，不是额外的 git commit。）
     */
    async commitAll(_label) {
      return { sha: null }
    },
  }
}
