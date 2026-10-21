/**
 * compact.mjs · 上下文压缩
 *
 * 三条铁律（《长记忆形态 v1 定稿》§6）：
 *   1. `messages.jsonl` **一行都不删** —— 原文是唯一可信的东西，压缩只是换一个「看哪一段」的视窗。
 *   2. 摘要必须落到 `journal/` 里做 `kind:compact` —— 否则她下次读记忆时看不到「过去发生过什么」。
 *   3. 压缩是**唯一允许动 system prompt 的时机之一**（重渲染快照），除此之外 system 字节不变。
 *
 * 触发预算来自 settings 的 `contextBudgetTokens`（旋钮，改完即生效）。
 */

import { estimateTokens } from './settings.mjs'

/** 单条消息进摘要时的最大字符数，防止一条超长消息把摘要请求本身撑爆。 */
const MAX_MSG_CHARS = 2000

/**
 * 估算「这一轮要发出去的 prompt」有多大。
 * 只用于判断该不该压缩，不需要精确 —— 宁可早压，不要撞墙。
 */
export function estimateContextTokens({ systemText = '', messages = [] }) {
  let total = estimateTokens(systemText)
  // ★ 会话消息的正文是 `text`（session.mjs 的 readMessages 产出的形状），
  //   不是 OpenAI 的 `content`。写成 m.content 会让整段历史按 0 计入，
  //   压缩永远不触发（A6 首轮实测：1775 字的历史被估成 4 token）。
  for (const m of messages) total += estimateTokens(m.text ?? m.content) + 4
  return total
}

/**
 * 选出压缩边界：保留最后 `keepRecent` 条原文，之前的都可以进摘要。
 *
 * @param {{messages: Array<{id:string,role:string,text:string}>, keepRecent:number}} o
 * @returns {{boundaryMsgId: string|null, compactable: Array, recent: Array}}
 */
export function pickBoundary({ messages, keepRecent }) {
  const keep = Math.max(2, Number(keepRecent) || 12)
  if (messages.length <= keep) {
    return { boundaryMsgId: null, compactable: [], recent: messages }
  }
  const cut = messages.length - keep
  const compactable = messages.slice(0, cut)
  const recent = messages.slice(cut)
  return {
    boundaryMsgId: compactable[compactable.length - 1]?.id ?? null,
    compactable,
    recent,
  }
}

/**
 * 让模型把一段对话压成摘要。
 *
 * 为什么单独一次调用而不是「顺手在工具轮里问」：压缩必须**确定性、可重跑**，
 * 混在业务对话里会让两边都变得不可预测。
 */
export async function summarizeMessages({ llm, messages, log = () => {} }) {
  const transcript = messages
    .map((m) => {
      const text = String(m.text ?? '').slice(0, MAX_MSG_CHARS)
      const who = m.role === 'user' ? '他' : m.role === 'assistant' ? '我' : m.role
      return `[${who}] ${text}`
    })
    .join('\n\n')

  const prompt = [
    '把下面这段对话压成一份备忘，供你以后回忆时使用。',
    '要求：',
    '- 用第一人称、口语，像你自己写的笔记，不要写成会议纪要。',
    '- 保留：他说过的事实、约定、偏好、情绪变化、没做完的事、你答应过的事。',
    '- 丢掉：客套、重复、已经被后续内容覆盖的中间过程。',
    '- 不超过 600 字。只输出备忘正文，不要任何前言。',
    '',
    '=== 对话 ===',
    transcript,
  ].join('\n')

  let text = ''
  for await (const ev of llm.stream({
    messages: [{ role: 'user', content: prompt }],
    tools: [],
  })) {
    if (ev.type === 'content') text += ev.text
  }
  text = text.trim()
  if (!text) {
    throw new Error('compact.summarizeMessages: 模型没有返回摘要')
  }
  log(`[compact] 摘要完成 ${messages.length} 条 → ${text.length} 字`)
  return text
}
