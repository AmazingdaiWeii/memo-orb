/**
 * 对话隐私锁 —— 流程层（host 侧）。
 *
 * 状态层在 `src/lock.mjs`（凭证怎么存、考验怎么算）；
 * 本模块只回答三件事：**什么时候锁、锁住时给球看什么、球回了怎么判**。
 *
 * 设计依据：E:\Memo orb\对话加密_落地方案.md §4（软锁）/ §5（强锁）/ §9.2（改造点）/ §9.4（取消暗号）
 *
 * ⚠️ 数据层零改动：门禁只发生在「host 把历史推给球」这一层。
 *    `conversations/<id>/messages.jsonl` 始终明文，legacy 续聊与记忆反射完全不受影响。
 */

import { SOFT_MAX_ATTEMPTS, STRONG_MAX_ATTEMPTS, STRONG_COOLDOWN_MS, softMatches } from './lock.mjs'

/** 闲置检查周期（方案 §4.1：「每 30s 检查一次」）。 */
const IDLE_TICK_MS = 30_000

/**
 * 「取消暗号」意图识别（方案 §4.4）。**刻意不做菜单入口**，只在对话里说。
 * 用户原话示例：「取消暗号吧」「不想每次对暗号了」「把暗号去了」。
 */
const CANCEL_RE = /取消暗号|把暗号(去|删)了?|不要暗号|不想(每次)?对暗号|暗号.{0,2}(去掉|取消|删掉)/

/** 「约/改暗号」意图识别，用来把约定指针钉到本轮回复上（方案 §4.2）。 */
const AGREE_RE = /(约|设|定|换|重新|定个|立个).{0,3}暗号|暗号.{0,3}(约|设|定|换)/

/**
 * @param {object} deps
 * @param {object} deps.lock                  createLockStore() 的返回值
 * @param {(obj: object) => void} deps.send   往球发一条消息
 * @param {() => void} deps.refreshHistory    重新推一次历史列表（= main.mjs 的 sendHistory）
 * @param {(sessionId: string, opts?: object) => Promise<void>} deps.openConversation
 * @param {(sessionId: string) => {blocks: Array}|null} deps.readConversationBlocks
 * @param {(msg: string) => void} deps.log
 */
export function createLockFlow({ lock, send, refreshHistory, openConversation, readConversationBlocks, log }) {
  /** 用户最后一次说话的时间，每次 prompt 重置（方案 §4.1）。 */
  let lastActiveAt = Date.now()
  /** 全局软锁是否处于锁定态。**只存内存** —— 重启后从「未锁」开始，不拿旧状态烦人。 */
  let softLocked = false
  /** 锁定期间用户点开的那条会话，解锁后自动补开。 */
  let pendingOpen = null
  /** 刚识别到「约个暗号」，等本轮 assistant 收尾再钉指针。 */
  let pendingAgreement = false
  let idleTimer = null

  // ---------------------------------------------------------------- 闲置锁

  function touch() {
    lastActiveAt = Date.now()
  }

  /**
   * 超时锁布防。**只在「软锁已启用且已经约定过暗号」时才真的布防。**
   *
   * ⚠️ 这条闸门是方案 §8 的硬要求，不是可选优化：
   *    设置表里「软锁暗号」默认 = **空（未启用）**，§4.2 也写明约定仪式发生在
   *    「软锁**首次启用后**」。若无条件按 30 分钟上锁，一个从没约过暗号的用户
   *    离开半小时回来就会被遮罩，然后面对一个**无暗号可对**的输入框 ——
   *    连错 5 轮，还得挨一句「我希望你是一个诚实的人」。
   *    什么都没做错的人被道德教育，是这套设计里最不能接受的一种失败。
   *    所以：**没有可用的考验，就绝不主动上锁**，宁可少锁一次。
   *
   * 探针用 `ORB_LOCK_TICK_MS` / `ORB_LOCK_IDLE_MIN` 把等待压到秒级（30 分钟没法实测）。
   */
  function startIdleWatch() {
    if (idleTimer) return
    const tick = Number(process.env.ORB_LOCK_TICK_MS || IDLE_TICK_MS)
    const idleOverride = Number(process.env.ORB_LOCK_IDLE_MIN || 0)
    idleTimer = setInterval(() => {
      if (softLocked) return
      const st = lock.getSettings()
      if (st.softEnabled !== true) return            // 软锁没启用 → 不布防
      if (!lock.hasAgreement()) return               // 启用了但还没约暗号 → 无从考验，不布防
      const min = idleOverride > 0 ? idleOverride : Number(st.idleTimeoutMin ?? 0)
      if (!(min > 0)) return
      if (Date.now() - lastActiveAt < min * 60_000) return
      engage(`闲置超过 ${min} 分钟`)
    }, tick)
    // 别让这个定时器把进程钉住不退出（沙箱里的探针也要能收尾）。
    idleTimer.unref?.()
    const st = lock.getSettings()
    const armed = st.softEnabled === true && lock.hasAgreement()
    log(
      armed
        ? `闲置锁已布防：${idleOverride > 0 ? idleOverride : st.idleTimeoutMin} 分钟无交互即遮罩全部历史`
        : `闲置锁**未布防**（${st.softEnabled !== true ? '软锁未启用' : '尚未约定暗号'}）—— 没有暗号可对时不上锁`,
    )
  }

  function engage(reason) {
    if (softLocked) return
    softLocked = true
    lock.beginSoftChallenge()
    log(`软锁生效（${reason}）→ 全部历史与当前会话进遮罩态`)
    send({
      type: 'lock', state: 'locked', kind: 'soft',
      attemptsLeft: SOFT_MAX_ATTEMPTS,
      hasAgreement: lock.hasAgreement(),
    })
    refreshHistory() // 立刻把列表刷成遮罩态，别等用户手动刷新
  }

  function release(reason) {
    if (!softLocked) return
    softLocked = false
    // ⚠️ endSoftChallenge 只清**进程内**计数。磁盘上从头到尾没写过任何失败痕迹，
    //    这正是方案 §4.2 要的「零副作用」—— 下次超时锁是全新开始。
    lock.endSoftChallenge()
    lastActiveAt = Date.now()
    log(`软锁解除（${reason}）`)
    send({ type: 'lock', state: 'unlocked', kind: 'soft' })
    refreshHistory()
    const target = pendingOpen
    pendingOpen = null
    if (target) void openConversation(target, { force: true })
  }

  // ---------------------------------------------------------------- 给球看的列表

  /**
   * 锁定态下把历史条目抹成占位。
   *
   * ⚠️ 标题**刻意置空**。历史标题是首条用户消息截出来的（history.mjs titleFromMessages），
   *    原样推过去等于把内容漏给站在旁边的人 —— 与方案 §4.1「全部历史进锁定态」自相矛盾。
   *    字段形状仍按 §9.2（`{sessionId, title, locked:true}`），只是 title 是空串。
   *    球侧契约：见到 `locked:true` 就渲染占位行（小锁 + 「已锁定的对话」），**不得渲染 title**。
   */
  function maskHistory(items) {
    const list = Array.isArray(items) ? items : []
    return list.map((it) => {
      const strong = lock.isConvLocked(it.sessionId)
      if (!softLocked && !strong) return it
      return {
        sessionId: it.sessionId,
        title: '',
        locked: true,
        kind: strong ? 'strong' : 'soft',
      }
    })
  }

  // ---------------------------------------------------------------- 打开会话的闸门

  /**
   * 打开某条会话前先过闸。返回 `true` = 已拦下，调用方**必须直接 return**，别切 runtime、别回放。
   *
   * 顺序按方案 §5：先软后强。软锁下所有对话都进遮罩；解开软锁后，挂强锁的对话还要再输密码
   * —— 也就是「双重遮罩」。
   */
  function gateOpen(sessionId) {
    if (softLocked) {
      pendingOpen = sessionId
      log(`软锁中，拦下打开 ${sessionId} 的请求`)
      send({ type: 'lock', state: 'locked', kind: 'soft', attemptsLeft: lock.softAttemptsLeft(), hasAgreement: lock.hasAgreement() })
      return true
    }
    if (lock.isConvLocked(sessionId)) {
      pendingOpen = sessionId
      log(`对话 ${sessionId} 挂了强锁，拦下并推密码卡`)
      send({ type: 'lock', state: 'locked', kind: 'strong', convId: sessionId, attemptsLeft: STRONG_MAX_ATTEMPTS })
      return true
    }
    return false
  }

  // ---------------------------------------------------------------- 校验

  /**
   * 回读约定消息原文（方案 §6：软锁**零凭证存储**，解锁时回读原文比对）。
   *
   * 指针里的 messageId 是 host 钉上去的 assistant 消息段；磁盘重放出来的块 key
   * 形如 `local-conv-65|a:ui-msg-4:assistant:1`，所以按「key 里含 messageId」捞。
   *
   * ⚠️ 指针**不命中就直接判失败，不做「整段对话兜底比对」** ——
   *    一旦回退成「你打的字在该对话任意位置出现过就放行」，随便一个常用词都能开锁，
   *    等于把软锁废掉。指针失效的正确出路是那 5 轮自动解锁（方案 §4.2 本来就设计了）。
   */
  function readAgreementText() {
    const ptr = lock.getAgreement()
    if (!ptr) {
      log('软锁：从未约定过暗号，无法文字比对')
      return ''
    }
    let loaded = null
    try {
      loaded = readConversationBlocks(ptr.convId)
    } catch (err) {
      log(`软锁：回读约定对话失败 ${err.message}`)
      return ''
    }
    const blocks = loaded?.blocks ?? []
    const hit = blocks.find((b) => String(b.key).includes(ptr.messageId))
    if (!hit) {
      log(`软锁：约定指针未命中（conv=${ptr.convId} msg=${ptr.messageId}），本轮判失败`)
      return ''
    }
    return hit.text ?? ''
  }

  function verifySoft(input) {
    if (softMatches(input, readAgreementText())) {
      log('软锁：暗号命中')
      send({ type: 'lock-feedback', ok: true, kind: 'soft' })
      release('暗号命中')
      return true
    }
    const left = lock.noteSoftFailure()
    if (left > 0) {
      log(`软锁：没对上，还剩 ${left} 轮`)
      send({
        type: 'lock-feedback', ok: false, kind: 'soft', attemptsLeft: left,
        message: '再想想？',
      })
      return true
    }
    // 第 5 轮也没对上（方案 §4.2）：鲸鱼娘**主动解开**，给一段道德警告，然后**零副作用**收尾。
    // 不锁死、不惩罚、不写「疑似非本人」标记、不进记忆 —— 下次超时锁是全新开始。
    log(`软锁：${SOFT_MAX_ATTEMPTS} 轮全失败 → 主动解锁（不落标记、不进记忆、不留档）`)
    send({
      type: 'lock-feedback', ok: false, kind: 'soft', attemptsLeft: 0,
      message: '我给你解开了。但是我希望你是一个诚实的人，不要欺骗我。如果你不是他/她本人，这样做是不对的。',
    })
    release(`${SOFT_MAX_ATTEMPTS} 轮用光，主动解开`)
    return true
  }

  function verifyStrong(input, convId) {
    const wait = lock.strongLockoutRemaining(convId)
    if (wait > 0) {
      send({
        type: 'lock-feedback', ok: false, kind: 'strong',
        message: `错误次数已到上限，请等 ${Math.ceil(wait / 60_000)} 分钟再试`,
      })
      return true
    }
    if (lock.verifyStrongPassword(input, convId)) {
      lock.clearStrongFailures(convId)
      log(`强锁对话 ${convId} 密码通过`)
      pendingOpen = null
      send({ type: 'lock-feedback', ok: true, kind: 'strong' })
      send({ type: 'lock', state: 'unlocked', kind: 'strong', convId })
      void openConversation(convId, { force: true })
      return true
    }
    const r = lock.noteStrongFailure(convId)
    log(`强锁密码错误（第 ${r.count}/${STRONG_MAX_ATTEMPTS} 次）`)
    send({
      type: 'lock-feedback', ok: false, kind: 'strong',
      message: r.locked
        ? `密码错误次数已到上限，冷却 ${Math.round(STRONG_COOLDOWN_MS / 60_000)} 分钟（对话内容可以走「导出」自救）`
        : `密码不对，还能试 ${STRONG_MAX_ATTEMPTS - r.count} 次`,
    })
    return true
  }

  // ---------------------------------------------------------------- 球的来信

  /** @returns {boolean} true = 已处理 */
  function handleBallMessage(msg) {
    if (msg.type === 'lock-now') {
      engage('用户手动上锁')
      return true
    }
    if (msg.type !== 'unlock') return false

    const input = String(msg.input ?? '')
    const convId = typeof msg.convId === 'string' && msg.convId !== '' ? msg.convId : null

    if (softLocked) return verifySoft(input)          // 方案 §5：先软后强
    if (convId && lock.isConvLocked(convId)) return verifyStrong(input, convId)

    send({ type: 'lock-feedback', ok: false, message: '当前没有需要解锁的内容' })
    return true
  }

  // ---------------------------------------------------------------- 对话内意图

  /**
   * 从用户消息里认「取消暗号 / 约暗号」（方案 §4.4 / §4.2）。
   * 纯关键词，不调模型 —— 这条链路要能离线成立。
   */
  function noteUserIntent(text) {
    const t = String(text ?? '')
    if (CANCEL_RE.test(t)) {
      const had = lock.hasAgreement()
      lock.clearAgreement()
      pendingAgreement = false
      log(`用户在对话里取消暗号（原先${had ? '有' : '无'}约定）→ 超时锁随之关闭，历史直接可见`)
      if (softLocked) release('用户取消暗号')
      // 方案 §4.4：「未设暗号」是**状态标记不是凭证**，可以让鲸鱼娘在后续对话里读到。
      send({ type: 'soft-agreement', state: 'none' })
      return 'cancel'
    }
    if (AGREE_RE.test(t)) {
      pendingAgreement = true
      log('用户要求约暗号 → 等本轮 assistant 收尾后把指针钉上去')
      return 'agree'
    }
    return null
  }

  /**
   * 回合收尾时把约定指针钉到本轮最后一条 assistant 消息上（方案 §6）。
   * 只在刚识别到「约个暗号」后的那一轮生效，钉完立刻失效，不会钉到无关消息。
   *
   * @param {string|null} lastAssistantKey 形如 `local-conv-65|a:ui-msg-4:assistant:1`
   */
  function pinAgreement(lastAssistantKey) {
    if (!pendingAgreement) return false
    pendingAgreement = false
    if (!lastAssistantKey) {
      log('约暗号意图出现了，但本轮没有 assistant 正文，指针未钉')
      return false
    }
    const key = String(lastAssistantKey)
    const convId = key.split('|')[0]
    const seg = key.split('|').slice(1).join('|')
    const m = /^a:([^:]+)/.exec(seg)
    return lock.setAgreement({ convId, messageId: m ? m[1] : seg })
  }

  function status() {
    return {
      softLocked,
      pendingAgreement,
      pendingOpen,
      idleWatch: Boolean(idleTimer),
      idleForSec: Math.round((Date.now() - lastActiveAt) / 1000),
      ...lock.snapshot(),
    }
  }

  return {
    touch,
    startIdleWatch,
    maskHistory,
    gateOpen,
    handleBallMessage,
    noteUserIntent,
    pinAgreement,
    status,
    get locked() { return softLocked },
    /** 排障用：手动触发一次锁定。 */
    engageNow: () => engage('排障手动触发'),
  }
}
