/**
 * 对话隐私锁 —— 凭证与状态层（host 侧，无 UI）。
 *
 * 设计依据：对话加密落地方案（内部设计文档，不进公开仓库）
 *   §2   两把锁：软锁（超时暗号）/ 强锁（手动密码）
 *   §6   凭证存储：暗号原文本来就在对话文件里 → **零凭证存储**，只记指针；
 *        密码从未进过对话 → 存 scrypt 单向哈希才有意义
 *   §9.1 host 侧改动点
 *
 * ⚠️ 三条不可违反的约束（方案 §4.2 / §6 / §6.1）：
 *   1. **暗号不做任何持久化** —— 只存 `{convId, messageId}` 指针，解锁时回读原文比对。
 *      对一张已经公开的纸条上锁没有意义，暗号的安全性 100% 来自 UI 遮罩。
 *   2. **密码只存 scrypt 哈希 + 随机 salt** —— 任何路径都不落原文、不写日志、不进记忆。
 *   3. **软考验零副作用** —— 5 轮内失败几次都不落盘；第 5 轮失败只是「这次结束」，
 *      下次超时锁是全新开始，不累计、不挂「疑似非本人」标记。
 *      ⇒ 所以软考验的计数是**进程内变量**，刻意不写进 locks.json（见 softAttempts）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * scrypt 参数。N=16384 / r=8 / p=1 是 Node 的默认档，桌面机单次约 50~80ms ——
 * 对「翻文件的人」足够贵，又不会让正常解锁卡顿。
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }

/** 软考验机会数（方案 §4.2「考验 = 5 轮」）。 */
export const SOFT_MAX_ATTEMPTS = 5

/** 强锁连续输错上限与冷却（方案 §5）。 */
export const STRONG_MAX_ATTEMPTS = 5
export const STRONG_COOLDOWN_MS = 15 * 60 * 1000

/**
 * 暗号最短可判长度。低于这个长度不做命中判定 ——
 * 否则「的」「a」这种单字一定能蒙中，等于没有考验。
 */
const SOFT_MIN_LEN = 2

/**
 * 归一化：去所有空白 + 转小写 + **全角标点折成半角**。
 * 刻意不用 locale 相关的大小写规则（土耳其 i 之类），中英文都要能过。
 *
 * ★ 为什么要折全角标点（2026-10-07 实测踩到）：
 *   约定消息里写的是半角 `?`（模型输出习惯），但用户**手打中文时输入法默认出全角 `？`**。
 *   实测 `球上有几颗糖？` 判 false、`球上有几颗糖` 判 true —— 差一个问号就开不了锁，
 *   而界面上不会提示「你多了个全角符号」，用户只会以为「暗号记错了」。
 *   标点是**排版噪声不是暗号的语义**，两边统一折半角即可。
 *
 * ★ 全角字母数字也一起折（`Ａ１` → `a1`）：输入法在全角模式下会把整串都打成全角，
 *   只折标点会让「Ａ１」这类暗号依旧对不上。折的是**编码宽度，不是内容** ——
 *   真正的考验强度由 `SOFT_MIN_LEN`（≥2 字）与「必须在原文里出现」两条保证，
 *   与折宽度无关，所以不存在「折了就把锁放松」的问题。
 */
export function normalizeAnswer(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    .toLowerCase()
    // 全角 ASCII 段（！到～，U+FF01–U+FF5E）整体 −0xFEE0 折半角；全角空格 U+3000 已在上面被 \s 吃掉
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    // 中文习惯用的成对符号（不在 FF01–FF5E 段内，单独列）
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .replace(/[\u3001\u3002]/g, (c) => (c === '\u3001' ? ',' : '.'))
    .replace(/[\u300A\u3008\u300C\u3010]/g, '<')
    .replace(/[\u300B\u3009\u300D\u3011]/g, '>')
}

/**
 * 暗号命中判定：把用户输入归一化后，在「约定消息原文」里做子串匹配。
 *
 * 为什么是子串匹配而不是相等：约定消息是鲸鱼娘的一句人话
 * （例：「好呀，那我们的暗号就是『小饼干』，我记住啦。」），
 * 真正要认的是里面那截 **已经明文躺在 messages.jsonl 里的暗号**。
 * 拿它跟整句比一定不相等，所以只能判「用户说的那截在不在原文里」。
 *
 * 这是**软验证**：方案 §1 明确「防君子不防小人」，它防的是趁人离开偷看屏幕的人，
 * 不承担磁盘级保密，所以不做多轮哈希、不做盐。
 *
 * @param {string} input          用户在解锁框里敲的
 * @param {string} agreementText  从磁盘回读的约定消息原文
 */
export function softMatches(input, agreementText) {
  const a = normalizeAnswer(input)
  const b = normalizeAnswer(agreementText)
  if (a.length < SOFT_MIN_LEN) return false
  if (b.length === 0) return false
  return b.includes(a)
}

function defaultState() {
  return {
    version: 1,
    /** 强锁凭证。密码原文永不落盘，只有哈希 + salt。 */
    strong: {
      mode: 'global',          // global = 统一密码 / per = 每对话独立（方案 §5）
      passwordHash: null,      // hex
      salt: null,              // hex
      perConversation: {},     // convId -> { passwordHash, salt }
      /** convId -> { count, lockedUntil }；输错 N 次的冷却（方案 §5）。 */
      failures: {},
    },
    /** 挂了强锁的对话（方案 §5）。 */
    lockedConvIds: [],
    /**
     * 软锁约定指针：只记「约定发生在哪条消息」，不记暗号内容（方案 §6）。
     * { convId: string, messageId: string } | null
     */
    softAgreement: null,
    /** 锁自己的可调项。方案 §8 的设置项由 UI 助手暴露，取值落在这里。 */
    settings: {
      idleTimeoutMin: 30,      // 无交互 N 分钟后全部历史进锁定态
      softEnabled: false,      // 软锁是否启用（首次启用后才会有约定仪式）
    },
  }
}

function hashPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, 'hex')
  return scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  }).toString('hex')
}

/** 定长字符串比较，避免 `===` 的短路时序泄露。长度不同直接 false。 */
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ba.length === 0 || ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * 建一个锁状态仓库。文件不存在就按默认值建，解析失败也只回默认值（不抛，别拖垮 orb 启动）。
 *
 * @param {object} opts
 * @param {string} opts.path   locks.json 的绝对路径
 * @param {(msg: string) => void} [opts.log]
 */
export function createLockStore({ path, log = () => {} }) {
  let state = load()

  function load() {
    if (!existsSync(path)) return defaultState()
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      const base = defaultState()
      return {
        ...base,
        ...raw,
        strong: { ...base.strong, ...(raw.strong ?? {}) },
        settings: { ...base.settings, ...(raw.settings ?? {}) },
        lockedConvIds: Array.isArray(raw.lockedConvIds) ? [...raw.lockedConvIds] : [],
      }
    } catch (err) {
      log(`locks.json 解析失败，按空锁启动: ${err.message}`)
      return defaultState()
    }
  }

  function save() {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      return true
    } catch (err) {
      log(`locks.json 写入失败: ${err.message}`)
      return false
    }
  }

  // ------------------------------------------------------------ 强锁：凭证

  /**
   * 设/改密码。每次都用**新的随机 salt** —— 同一个密码两次设置产出不同哈希，
   * 文件被拷走也看不出「密码是不是换过」。
   */
  function setStrongPassword(password, convId = null) {
    const pw = String(password ?? '')
    if (pw.length === 0) return false
    const salt = randomBytes(16).toString('hex')
    const h = hashPassword(pw, salt)
    if (convId && state.strong.mode === 'per') {
      state.strong.perConversation[convId] = { passwordHash: h, salt }
    } else {
      state.strong.passwordHash = h
      state.strong.salt = salt
    }
    save()
    log(`强锁密码已设置（${convId && state.strong.mode === 'per' ? `对话 ${convId}` : '全局'}，scrypt 哈希入盘）`)
    return true
  }

  function clearStrongPassword(convId = null) {
    if (convId && state.strong.mode === 'per') {
      delete state.strong.perConversation[convId]
    } else {
      state.strong.passwordHash = null
      state.strong.salt = null
    }
    save()
  }

  function hasStrongPassword(convId = null) {
    if (convId && state.strong.mode === 'per') {
      return Boolean(state.strong.perConversation[convId]?.passwordHash)
    }
    return Boolean(state.strong.passwordHash)
  }

  /** 纯校验，不改任何状态。计时安全比较。 */
  function verifyStrongPassword(password, convId = null) {
    const slot = state.strong.mode === 'per' && convId ? state.strong.perConversation[convId] : state.strong
    if (!slot?.passwordHash || !slot?.salt) return false
    return safeEqualHex(hashPassword(String(password ?? ''), slot.salt), slot.passwordHash)
  }

  function setStrongMode(mode) {
    if (mode !== 'global' && mode !== 'per') return false
    state.strong.mode = mode
    save()
    return true
  }

  // ------------------------------------------------------------ 强锁：输错冷却

  function failureKey(convId) {
    return state.strong.mode === 'per' ? convId : 'global'
  }

  /** 该对话现在是否还在冷却期（方案 §5「输错 N 次后锁死，需等冷却」）。 */
  function strongLockoutRemaining(convId = null) {
    const rec = state.strong.failures[failureKey(convId)]
    if (!rec?.lockedUntil) return 0
    return Math.max(0, rec.lockedUntil - Date.now())
  }

  /**
   * 记一次密码错误。到上限就写一个 lockedUntil 时间戳（**这是强锁，允许落盘** ——
   * 强锁本来就是防小人的长期隔离，与软锁的「零副作用」是两套语义）。
   * @returns {{count: number, locked: boolean, remainingMs: number}}
   */
  function noteStrongFailure(convId = null) {
    const k = failureKey(convId)
    const rec = state.strong.failures[k] ?? { count: 0, lockedUntil: 0 }
    rec.count += 1
    if (rec.count >= STRONG_MAX_ATTEMPTS) {
      rec.lockedUntil = Date.now() + STRONG_COOLDOWN_MS
      rec.count = 0
    }
    state.strong.failures[k] = rec
    save()
    return {
      count: rec.count,
      locked: rec.lockedUntil > Date.now(),
      remainingMs: Math.max(0, rec.lockedUntil - Date.now()),
    }
  }

  function clearStrongFailures(convId = null) {
    delete state.strong.failures[failureKey(convId)]
    save()
  }

  // ------------------------------------------------------------ 强锁：对话清单

  const isConvLocked = (convId) => state.lockedConvIds.includes(convId)

  function lockConversation(convId) {
    if (!convId || isConvLocked(convId)) return false
    state.lockedConvIds.push(convId)
    save()
    log(`对话 ${convId} 已挂强锁（共 ${state.lockedConvIds.length} 条）`)
    return true
  }

  function unlockConversation(convId) {
    const i = state.lockedConvIds.indexOf(convId)
    if (i < 0) return false
    state.lockedConvIds.splice(i, 1)
    save()
    return true
  }

  // ------------------------------------------------------------ 软锁：约定指针

  /**
   * 记下「暗号约定在哪条消息」。**只存指针，不存内容** —— 方案 §6 的硬约束。
   * @returns {boolean} 入参不全就不写，避免留下半个指针把解锁流程卡死
   */
  function setAgreement({ convId, messageId } = {}) {
    if (!convId || !messageId) {
      log('setAgreement 缺 convId/messageId，忽略')
      return false
    }
    state.softAgreement = { convId: String(convId), messageId: String(messageId) }
    save()
    log(`软锁约定指针已记（conv=${convId} msg=${messageId}，不含暗号内容）`)
    return true
  }

  function clearAgreement() {
    if (state.softAgreement === null) return false
    state.softAgreement = null
    save()
    log('软锁约定指针已清空')
    return true
  }

  const getAgreement = () => (state.softAgreement ? { ...state.softAgreement } : null)
  const hasAgreement = () => state.softAgreement !== null

  // ------------------------------------------------------------ 软考验（进程内，刻意不落盘）

  /**
   * ⚠️ 这两个变量**故意是模块/闭包内变量而不是 state 字段**。
   * 方案 §4.2 要求「5 轮全失败零副作用、下次全新开始」——
   * 一旦写进 locks.json，重启就变成「累计失败」，对忘性大的用户是惩罚。
   * 所以每次都从 0 起，进程活着的期间才记住。
   */
  let softAttempts = 0

  function beginSoftChallenge() {
    softAttempts = 0
    return SOFT_MAX_ATTEMPTS
  }

  const softAttemptsLeft = () => Math.max(0, SOFT_MAX_ATTEMPTS - softAttempts)

  function noteSoftFailure() {
    softAttempts += 1
    return softAttemptsLeft()
  }

  /** 考验结束（命中 or 用光）就清零。不返回、不记录，调用方也拿不到「失败过」的证据。 */
  function endSoftChallenge() {
    softAttempts = 0
  }

  // ------------------------------------------------------------ 设置

  const getSettings = () => ({ ...state.settings })

  function updateSettings(patch = {}) {
    state.settings = { ...state.settings, ...patch }
    save()
    return getSettings()
  }

  /** 只读快照，给排障/探针用。**不含任何凭证原文**（本来也没存）。 */
  function snapshot() {
    return {
      strongMode: state.strong.mode,
      hasPassword: hasStrongPassword(),
      lockedConvIds: [...state.lockedConvIds],
      hasAgreement: hasAgreement(),
      agreement: getAgreement(),
      settings: getSettings(),
      softAttemptsLeft: softAttemptsLeft(),
    }
  }

  return {
    path,
    snapshot,
    // 强锁
    setStrongPassword, clearStrongPassword, hasStrongPassword, verifyStrongPassword,
    setStrongMode, strongLockoutRemaining, noteStrongFailure, clearStrongFailures,
    // 对话清单
    isConvLocked, lockConversation, unlockConversation,
    get lockedConvIds() { return [...state.lockedConvIds] },
    // 软锁
    setAgreement, clearAgreement, getAgreement, hasAgreement,
    // 软考验
    beginSoftChallenge, softAttemptsLeft, noteSoftFailure, endSoftChallenge,
    // 设置
    getSettings, updateSettings,
  }
}
