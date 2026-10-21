/**
 * 审批 —— 工具动手前先问一句「准不准」。
 *
 * 复用球侧**现成**的提问卡 UI，一行 HTML/CSS/JS 都不改：
 *   host `send({type:'question', id, questions:[…]})`
 *     → helper `orb:question` → shell.js `showQuestion()`
 *   用户点选 + 提交 → `api.answerQuestion(id, answers)`
 *     → helper `{type:'question-answer', id, answers}` → 这里 resolve
 *   用户点「关掉」   → `{type:'question-cancel', id}`  → resolve 为拒绝
 *
 * 三条不变量，都是「确认框历史弹不出来 / 卡住对话」那笔债换来的：
 *
 *  P1 **每条路径都必须 resolve**。brain 里是 `await approve(...)`，一旦永不
 *     resolve，工具循环挂住 → 回合不收口 → 球永远转圈，用户以为卡死。
 *     所以超时 / 球掉线 / 球没鉴权 / 内部异常 / 卡片被别的东西顶掉，
 *     一律 resolve 成「拒绝」，并且**先 resolve 再清卡片**。
 *
 *  P2 **球没连上就立刻拒**，不能等。`send()` 在 ballSocket 为空或未鉴权时
 *     是静默丢弃（src/main.mjs:422），等一个永远不会来的答案纯属自杀。
 *
 *  P3 **同时只允许一张卡**。球侧 `pending` 是单例，第二张卡会把第一张顶掉，
 *     第一张的 id 从此没人应答。所以这里加互斥：已有挂起时直接拒绝新请求
 *     （并告诉模型「上一次还在等你」，它可以下一轮再试）。
 */

/** 用户不在电脑前的兜底：超过这个时间没点，按拒绝处理（回合继续，不卡）。 */
export const APPROVAL_TIMEOUT_MS = 120_000

/** 选项文案 —— 判定靠这个前缀，改文案时两边一起改。 */
const LABEL_ALLOW = '允许'
const LABEL_DENY = '拒绝'

let seq = 0

/**
 * @param {object} o
 * @param {(obj:object)=>void} o.send        往球写一条（main.mjs 的 send）
 * @param {()=>boolean} o.isConnected        球是否已连接且鉴权
 * @param {(s:string)=>void} [o.log]
 * @param {number} [o.timeoutMs]
 * @param {(evt:{id:string,toolName:string,head:string,reason:string})=>void} [o.onAsk]
 *        卡片发出时同步通知一次（微信通道拿它把同一件事说到手机上）
 * @param {(evt:{id:string,approved:boolean,reason:string})=>void} [o.onSettle]
 *        卡片收口时通知一次（桌面点了之后，手机要知道已经不用回了）
 */
export function createApprovalBroker({
  send,
  isConnected,
  log = () => {},
  timeoutMs = APPROVAL_TIMEOUT_MS,
  onAsk = null,
  onSettle = null,
}) {
  if (typeof send !== 'function') throw new Error('createApprovalBroker: 缺少 send')
  if (typeof isConnected !== 'function') throw new Error('createApprovalBroker: 缺少 isConnected')

  /** id → { resolve, timer, toolName } */
  const pending = new Map()

  function settle(id, verdict, reason) {
    const entry = pending.get(id)
    if (!entry) return false
    pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    // 先摘卡片再 resolve：球侧 hide 之后用户就不会再点到一张已经没人等的卡。
    try { send({ type: 'question-clear', id }) } catch { /* 球已走，忽略 */ }
    log(`[approval] ${id} → ${verdict ? '允许' : '拒绝'}（${reason}）`)
    entry.resolve({ approved: verdict, reason })
    // 收口之后才通知外部通道：桌面点完之后，手机上那张「回允许/拒绝」的提示要能对上账。
    try { onSettle?.({ id, approved: verdict, reason }) } catch { /* 通知失败不影响结果 */ }
    return true
  }

  /** 球说「允许/拒绝」。answers 形如 [{id:'q1', selected:['允许…']}]。 */
  function answer(id, answers) {
    if (!pending.has(id)) {
      log(`[approval] 收到未知的 question-answer（${id}），忽略`)
      return false
    }
    const picked = []
    for (const a of Array.isArray(answers) ? answers : []) {
      for (const s of Array.isArray(a?.selected) ? a.selected : []) picked.push(String(s))
    }
    const allowed = picked.some((s) => s.startsWith(LABEL_ALLOW))
    return settle(id, allowed, allowed ? '他点了允许' : '他点了拒绝')
  }

  /** 球说「关掉卡片」= 拒绝。 */
  function cancel(id) {
    if (!pending.has(id)) return false
    return settle(id, false, '他关掉了确认卡')
  }

  /** 球断开 —— 所有挂起的都按拒绝收口，别让回合吊死。 */
  function abort(reason = '球断开了') {
    for (const id of [...pending.keys()]) settle(id, false, reason)
  }

  /**
   * 问一句。永远 resolve，永不 reject。
   * @returns {Promise<{approved:boolean, reason:string}>}
   */
  function ask({ toolName, args, reason }) {
    if (!isConnected()) {
      log('[approval] 球没连上，直接拒（不能让模型干等）')
      return Promise.resolve({ approved: false, reason: '球没连上（界面没开或未鉴权）' })
    }
    if (pending.size > 0) {
      const busyId = [...pending.keys()][0]
      log(`[approval] 已有挂起请求 ${busyId}，本次拒绝`)
      return Promise.resolve({ approved: false, reason: '上一次确认还在等你，这一条先不动' })
    }

    const id = `apr_${Date.now().toString(36)}_${(seq += 1).toString(36)}`
    const card = buildCard({ toolName, args, reason })

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        settle(id, false, `等了 ${Math.round(timeoutMs / 1000)} 秒没人点`)
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      pending.set(id, { resolve, timer, toolName })
      // 先把「手机上要回什么」发出去，再发桌面卡：桌面卡不在（人不在电脑前）时，
      // 手机那条提示就是唯一能让他知道有事在等他的东西。
      try { onAsk?.({ id, toolName, head: card.question, reason: reason || '' }) } catch { /* 同上 */ }
      try {
        send({ type: 'question', id, questions: [card] })
      } catch (err) {
        settle(id, false, `发卡片失败: ${err.message}`)
      }
    })
  }

  /** 手机上回「允许/拒绝」——和桌面点卡片等效，谁先答谁生效。 */
  function answerFromChannel(channel, id, approved) {
    if (!pending.has(id)) {
      log(`[approval] ${channel} 想答 ${id}，但那张卡已经不在了`)
      return false
    }
    return settle(id, !!approved, channel === 'wechat'
      ? (approved ? '他在手机上回了允许' : '他在手机上回了拒绝')
      : `他在 ${channel} 上答了`)
  }

  /** 挂起中的审批 id（手机端只认唯一一条；多于一条就让他回电脑上点）。 */
  function pendingIds() {
    return [...pending.keys()]
  }

  return { ask, answer, answerFromChannel, cancel, abort, pendingIds, pendingCount: () => pending.size }
}

/** 把一次工具调用做成一张选择题卡（字段名照 shell.js renderQuestion 的契约）。 */
function buildCard({ toolName, args, reason }) {
  const verb = TOOL_VERBS[toolName] ?? toolName
  const target = String(args?.path ?? args?.query ?? '').trim()
  const head = target ? `${verb}：${target}` : verb
  return {
    id: 'q1',
    header: '她要动一下外面的东西',
    question: head,
    detail: renderDetail(toolName, args, reason),
    options: [
      { label: `${LABEL_ALLOW}（推荐）`, description: '只放行这一次，下次还会问' },
      { label: LABEL_DENY, description: '这次不执行，她会知道被你拦了' },
    ],
    multiSelect: false,
  }
}

const TOOL_VERBS = {
  read_file: '读文件',
  write_file: '写文件',
  list_dir: '看目录',
  glob_files: '找文件',
  search_web: '联网搜索',
  fetch_url: '打开网页',
  bili_watch: '看 B 站视频',
}

const DETAIL_MAX = 1200

function renderDetail(toolName, args, reason) {
  // 为什么问：白名单外写 / 覆盖已存在文件 —— 把策略给的理由原样带上，
  // 用户才知道自己批的是哪一种风险。
  const lines = [reason ? `为什么问：${reason}` : '位置：data/workspace/ 内']
  if (toolName === 'write_file') {
    const body = String(args?.content ?? '')
    lines.push(`要写 ${body.length} 字`)
    if (body) lines.push('', clamp(body, 800))
  } else if (toolName === 'read_file') {
    lines.push(`路径：${String(args?.path ?? '')}`)
  } else if (toolName === 'list_dir' || toolName === 'glob_files') {
    lines.push(`路径：${String(args?.path ?? args?.root ?? '.')}`)
  } else {
    lines.push('', clamp(JSON.stringify(args ?? {}, null, 2), 600))
  }
  return clamp(lines.join('\n'), DETAIL_MAX)
}

function clamp(text, max) {
  const s = String(text)
  return s.length > max ? `${s.slice(0, max)}…` : s
}
