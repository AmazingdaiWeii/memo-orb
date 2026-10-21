/**
 * persona 提取 —— CLI 注入器与 host 的**唯一**共同入口。
 *
 * 为什么单独抽一层:双模式要往**两个** agent 写两套人格。如果 CLI 用一套提取逻辑、
 * host 建 agent 时又自己写一套,两处迟早不一致 —— 而不一致的后果是「工作态的 agent
 * 拿到闲聊态的人格」,这种错很难肉眼发现。
 *
 * 为什么按**标记**取而不是行号:行号会随文档编辑漂移。
 * 为什么取「标记之后**第一个**围栏块」:`鲸鱼娘_persona.md` §二 A / §二 B 的正文
 * 本身就是围栏块,块外全是给人看的说明,不入 prompt。
 *
 * ⚠️ 写盘约定(踩过):agent json 必须**无 BOM UTF-8**,带 BOM 会让后端 JSON.parse 抛错。
 * 本模块只负责取文本,不负责写盘。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 项目根 —— 相对路径一律以此为基准,不写死绝对路径(整个目录要能搬盘)。 */
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

export const PERSONA_FILE = join(ROOT, '鲸鱼娘_persona.md')

/** mode → 文档里那一节的标题前缀。改文档标题就要改这里。 */
export const MODE_MARKERS = {
  chat: '## 二、A.',
  work: '## 二、B.',
}

export const MODES = Object.keys(MODE_MARKERS)

/**
 * 从 md 文本里取出某一种模式的 persona 正文。
 *
 * @param {string} md 整个 persona 文档
 * @param {'chat'|'work'} mode
 * @returns {string} 围栏块内的正文(已 trim)
 */
export function extractPersona(md, mode) {
  const marker = MODE_MARKERS[mode]
  if (!marker) throw new Error(`未知模式 ${mode}(支持 ${MODES.join(' / ')})`)

  const at = md.indexOf(marker)
  if (at < 0) throw new Error(`persona 文档里找不到标记「${marker}」`)

  // 从标记往后找第一个围栏块。用正则而不是 indexOf('```'),
  // 因为标记行本身可能带行内反引号(说明文字里常出现)。
  const rest = md.slice(at + marker.length)
  const m = /```[^\n]*\n([\s\S]*?)\n[ \t]*```/.exec(rest)
  if (!m) throw new Error(`标记「${marker}」之后没有找到成对的围栏块`)

  return m[1].trim()
}

/** 各模式的硬断言。宁可在这里炸,也不要把半截人格写进 agent。 */
export function assertPersona(text, mode) {
  if (!text || !text.trim()) throw new Error(`${mode}: persona 正文为空`)

  // 与 _inject_v2.ps1 保持同一套禁句 —— 身份声明句在 v2.0 已被废掉
  const banned = ['你是 DeepSeek', '一个大语言模型', '真实身份是 DeepSeek']
  for (const b of banned) {
    if (text.includes(b)) throw new Error(`${mode}: persona 含被禁句「${b}」`)
  }

  if (!text.startsWith('# 鲸鱼娘')) throw new Error(`${mode}: 首行不是「# 鲸鱼娘」`)
  if (!text.includes('## 保险丝')) throw new Error(`${mode}: 缺「## 保险丝」章节`)
  // v3（2026-10-08）把「最高准则」改写成第一人称的「只有一条准则，压过其他所有」。
  // 两种措辞都认 —— 只看语义在不在，不把标题的字面钉死（钉死了，改写人格就得改代码）。
  if (!text.includes('## 最高准则') && !text.includes('## 只有一条准则')) {
    throw new Error(`${mode}: 缺最高准则章节（「## 最高准则」或「## 只有一条准则」）`)
  }

  if (mode === 'work') {
    if (!text.includes('工作模式')) throw new Error('work: 标题里没写「工作模式」,会不会取错了块?')
    if (!text.includes('不推、不问、立即照做')) throw new Error('work: 缺「涉及你自己不推不问立即照做」这条分支')
  }
  if (mode === 'chat') {
    if (text.includes('工作模式')) throw new Error('chat: 取到的块里有「工作模式」,取错了')
  }

  return text
}

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

/**
 * 读文档 → 取块 → 断言 → 算指纹。
 *
 * @returns {{mode:string,file:string,marker:string,text:string,chars:number,bytes:number,sha256:string}}
 */
export function readPersona(mode, opts = {}) {
  const file = opts.file ? resolve(opts.file) : PERSONA_FILE
  const md = readFileSync(file, 'utf8')
  const text = assertPersona(extractPersona(md, mode), mode)
  return {
    mode,
    file,
    marker: MODE_MARKERS[mode],
    text,
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: sha(text),
  }
}

/** 只算指纹,不读文档 —— 用来比对「agent json 里现有的 system」。 */
export function fingerprint(text) {
  const s = typeof text === 'string' ? text : ''
  return { chars: s.length, bytes: Buffer.byteLength(s, 'utf8'), sha256: sha(s) }
}
