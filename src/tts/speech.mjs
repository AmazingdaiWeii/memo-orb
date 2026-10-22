/**
 * 语音播报编排 —— 「她说话」的那一半。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 这一层解决什么
 * ═══════════════════════════════════════════════════════════════════
 * `src/tts/*.mjs` 只会把「一整段文字」变成「一坨 mp3 字节」。可她的回复是
 * **流式** 吐出来的，而且可能很长。直接等整条写完再合成，首字延迟就是
 * 「整条写完的时间 + 一次合成时间」，一次能让人等十几秒。
 *
 * 正确做法（DSH 的技术判断，已在本机实测 21 字 = 907ms）：
 *   **一边流一边按句切**，第一句一凑齐就送合成 → 边播边合成后面的。
 *   实测 24000 采样率 mp3 首块 400~600ms，短句总延迟 400ms 量级。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 三条边界（别越界）
 * ═══════════════════════════════════════════════════════════════════
 *   ✅ 切句、清洗（剥 markdown / 代码块 / 链接 / 情绪标记 / emoji）
 *   ✅ 排队、限并发、按序号保序输出
 *   ✅ 打断（新回合 / 用户点停止）
 *   ❌ 不播放（主进程没有音频输出，必须丢给渲染层 `new Audio(blobUrl)`）
 *   ❌ 不落盘（音频只在内存里走一趟：Buffer → base64 → IPC → Blob → play → revoke）
 *   ❌ 不管 UI（开关状态在 main.mjs，按钮在 shell.js）
 *
 * ─────────────────────────────────────────────────────────────────
 * 为什么**不落盘**（用户 2026-10-22 的问题：「mp3 能不能即用即抛」）
 * ─────────────────────────────────────────────────────────────────
 * 能，而且默认就是。整条链路里 mp3 只以三种形态存在，全都随用随灭：
 *   ① 主进程内存里的 `Buffer`（合成返回）
 *   ② IPC 上的 base64 字符串（走完就没人引用）
 *   ③ 渲染进程里的 `Blob` + `URL.createObjectURL()` 临时 URL
 * 播放 `ended` 那一刻 `URL.revokeObjectURL()` 一收，内存立刻还给系统。
 * **磁盘上不会多出任何一个文件。** 想留档才用 `probe/tts-say.mjs` 手动落盘。
 */

/**
 * 情绪标记。这里的词表比 `src/mood.mjs` 的 `MARKER` **宽**，故意的：
 *
 * `mood.mjs` 那条要精确提取「是哪个情绪」，所以词表窄（`[A-Za-z\u4e00-\u9fa5_-]{1,12}`），
 * 代价是她写 `（mood:楞了下，认真起来）` 时整条不匹配 —— 标记留在正文里（**已知 bug**，
 * 她写的中文逗号不在词表内）。
 *
 * 而播报这一侧的要求只有一条：**绝不能把 `mood:` 念出来**。
 * 所以这里用「括号里出现 mood: 到右括号为止全吃掉」，宽到不会漏。
 * 也就是说：即使 `mood.mjs` 那个 bug 还在，她也不会听到「mood 冒号」这几个字。
 */
const MOOD_ANY = /[（(]\s*mood\s*[:：][^)）]{0,60}[)）]/gi
const MOOD_UNCLOSED = /[（(]\s*mood\s*[:：][^)）]*$/i

/** 代码围栏（``` 或 ~~~）。围栏内的东西一律不念 —— 念出来是灾难。 */
const FENCE_LINE = /^\s*(?:```|~~~)/

/**
 * 句末标点。中文四个 + 英文四个。
 * `…` 按 1~2 个连写算一次，因为 `……` 是中文省略号的标准写法。
 */
const TERMINATOR = /[。！？!?；;]|…{1,2}|\.{3,}/g

/** 句末标点后面紧跟这些「收尾符号」时，要一起算进这一句（否则引号会被念丢）。 */
const CLOSERS = new Set(['」', '』', '”', '’', '）', ')', '】', '》', '〉', ']', '}', '〉'])

/** 软切点：一句话太长（超过 maxChars）时，在这些地方断开。 */
const SOFT_BREAK = /[，、,：:—～~]/

/**
 * 把一句「给人看」的正文，变成「给耳朵听」的正文。
 *
 * 不做这一步的后果，实测过：`**重点**` 会被念成「星号星号重点星号星号」，
 * 代码块会把整段 JS 念一遍，URL 会一个字母一个字母念过去。
 *
 * @param {string} text
 * @returns {string} 只剩下该念的字；全是标点/空白时返回空串（调用方据此跳过）
 */
export function cleanForSpeech(text) {
  let s = String(text ?? '')
  if (s === '') return ''

  // ① 情绪标记：第一个剥，因为它可能夹在句末标点里，先剥再切更干净
  s = s.replace(MOOD_ANY, '').replace(MOOD_UNCLOSED, '')

  // ② 图片/链接 → 只留文字部分（`[点这里](https://…)` → `点这里`）
  s = s.replace(/!?\[([^\]]*)\]\((?:[^()\s]|\([^)]*\))*\)/g, '$1')

  // ③ 裸 URL：念出来毫无意义，而且会占掉好几秒
  s = s.replace(/\b(?:https?:\/\/|www\.)[^\s，。；、）)】」』"'<>]+/gi, '')

  // ④ HTML / 自定义标签（她的正文里偶尔会有 `<b>` 这种残留）
  s = s.replace(/<\/?[a-zA-Z][^>]{0,200}>/g, '')

  // ⑤ 行首标记：标题 `### `、列表 `- ` `* ` `1. `、引用 `> `
  s = s.replace(/^[ \t>]*(?:#{1,6}[ \t]+|[-*+][ \t]+|\d+[.、)][ \t]+)/gm, '')

  // ⑥ 强调 / 行内代码的反引号与星号（连写两个的也一起吃掉）
  s = s.replace(/(\*\*|__|~~)/g, '')
  s = s.replace(/`+/g, '')
  // 单个 `*` / `_` 只在「贴着文字」时剥，避免把 `C_C++` 这类东西改坏 —— 宁可留着
  s = s.replace(/(^|[\s（(【「《“])[*_](?=\S)/g, '$1')
  s = s.replace(/(\S)[*_](?=$|[\s，。！？；、）)】」』”])/g, '$1')

  // ⑦ 表格竖线：念不出「竖线」，用停顿代替
  s = s.replace(/\|/g, '，')

  // ⑧ emoji / 装饰符号：TTS 会念成「笑脸」「星星」之类，非常出戏
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '')

  // ⑨ 水平线 / 空引用这类整行无意义的符号
  s = s.replace(/^[ \t]*[-=_*]{3,}[ \t]*$/gm, '')
  s = s.replace(/[#*~`^|]/g, '')

  // ⑩ 折叠空白：多行压成一行（播报不需要换行，换行在 TTS 里也不产生停顿）
  s = s.replace(/[ \t\u00a0\u3000]+/g, ' ')
  s = s.replace(/\s*\n\s*/g, ' ')
  s = s.trim()

  // 只剩标点/空白就别送去合成了（火山对空文本会报错，还白花一次调用）
  if (!/[\p{L}\p{N}]/u.test(s)) return ''
  return s
}

/**
 * 把一行切成「已完结的句子」+「尾巴」。
 *
 * 尾巴是**还没有句末标点**的那一截 —— 它必须留在缓冲里，等下一个 delta 来续，
 * 否则「因为」会被当成一句念出去，「因为什么」再来一句。
 *
 * @param {string} line
 * @returns {{done: string[], tail: string}}
 */
function cutLine(line) {
  const done = []
  const re = new RegExp(TERMINATOR.source, 'g')
  let start = 0
  let m
  while ((m = re.exec(line)) !== null) {
    let end = m.index + m[0].length
    // 句末标点后面紧跟的收尾符号一起带走：`他说：「好。」` 的 `」`
    while (end < line.length && CLOSERS.has(line[end])) end += 1
    const piece = line.slice(start, end).trim()
    if (piece !== '') done.push(piece)
    start = end
    re.lastIndex = end
  }
  return { done, tail: line.slice(start) }
}

/**
 * 一句太长就在逗号/顿号处软切，避免一次合成几十秒、用户等不下去。
 *
 * ⚠️ 不能写成「攒够 maxChars 且当前字是逗号才断」——那样逗号落在 maxChars 前一个字时
 * 永远断不了（实测 `一二三四五六七八，九十十一十二。` 配 maxChars 10 一句都没切开）。
 * 正确做法是**回头找**：从 maxChars 往前扫，取最近的一个软切点；
 * 一个都没有（比如一整串没有标点的数字）才硬切。
 */
function softSplit(text, maxChars) {
  if (text.length <= maxChars) return [text]
  const floor = Math.max(2, Math.ceil(maxChars * 0.4))
  const parts = []
  let rest = text
  while (rest.length > maxChars) {
    let cut = -1
    for (let i = Math.min(maxChars, rest.length - 1); i >= floor; i -= 1) {
      if (SOFT_BREAK.test(rest[i])) {
        cut = i + 1
        break
      }
    }
    if (cut <= 0) cut = maxChars
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest !== '') {
    // 最后一段太短就并进上一段（「…，了。」这种两字碎句听起来很怪）
    if (parts.length > 0 && rest.trim().length < 3) parts[parts.length - 1] += rest
    else parts.push(rest)
  }
  return parts
}

/**
 * 流式切句器。
 *
 * 只做一件事：吃增量文本，吐出「可以拿去合成了的整句」。
 * 状态全在闭包里：`lineBuf`（还没换行的残行）、`inFence`（在代码块里吗）。
 *
 * ⚠️ 代码块按**整行**判定（`^\s*``` `）。这是刻意的取舍：
 *    token 流可能把三个反引号切在两段里，按字符判会在半截围栏上翻车；
 *    按整行判最多多等一个 delta，代价可以忽略。
 *
 * @param {object} [o]
 * @param {number} [o.maxChars] 单句上限，超了在逗号处软切（默认 90）
 * @param {number} [o.minChars] 单句下限，太碎就往下并（默认 4）
 */
export function createSpeechSegmenter({ maxChars = 90, minChars = 4 } = {}) {
  let lineBuf = ''
  let inFence = false
  /** 太短还没够 minChars 的碎片，等下一句并进来 */
  let mergeBuf = ''
  /**
   * 本轮有没有已经吐出去过的句子。
   *
   * ★ 它决定「第一句要不要为了凑长度而等下一句」：
   *   播报的全部意义是**早点出声**，如果第一句因为只有三个字被扣住等下一句，
   *   那点延迟优势就白送了。所以第一句永远立刻走，之后的碎片才允许合并
   *   （合并是为了自然度：`嗯。` `好。` 这种单独合成听起来很机械）。
   */
  let emittedAny = false

  /** 一整句（可能还要软切）→ 过长度下限 → 收进 out */
  function accept(piece, out) {
    const cleaned = cleanForSpeech(piece)
    if (cleaned === '') return
    for (const part of softSplit(cleaned, maxChars)) {
      let s = part
      if (mergeBuf !== '') {
        s = mergeBuf + s
        mergeBuf = ''
      }
      if (!emittedAny && s.length < minChars) {
        // 第一句：宁可短也先出声
        out.push(s)
        emittedAny = true
        continue
      }
      if (s.length < minChars) {
        mergeBuf = s
        continue
      }
      out.push(s)
      emittedAny = true
    }
  }

  /** 处理一整行（已经含换行，说明它说完了） */
  function takeLine(line, out) {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence) return
    const { done, tail } = cutLine(line)
    for (const d of done) accept(d, out)
    // 行结束了，尾巴也算一句 —— 换行本身就是一个停顿，不必等句号
    if (tail.trim() !== '') accept(tail, out)
  }

  return {
    /**
     * 吃一段增量文本。
     * @param {string} delta
     * @returns {string[]} 本次凑齐的句子（可能为空数组）
     */
    feed(delta) {
      const out = []
      const text = String(delta ?? '')
      if (text === '') return out
      lineBuf += text
      const lines = lineBuf.split('\n')
      lineBuf = lines.pop() ?? ''
      for (const line of lines) takeLine(line, out)
      // 还没换行的那半行也要切：流式里很多 delta 根本不含换行，
      // 全靠句号断句。切出来的尾部留在 lineBuf 里等下一段。
      if (!inFence) {
        const { done, tail } = cutLine(lineBuf)
        for (const d of done) accept(d, out)
        lineBuf = tail
      }
      return out
    },

    /**
     * 回合结束：把缓冲里剩下的全都吐出来。
     * 不调用的话，一条不带句末标点的结尾会被永久扣住（用户会觉得「话没说完就断了」）。
     * @param {string} [tail] 追加到最后的一截（通常不需要）
     * @returns {string[]}
     */
    flush(tail = '') {
      const out = []
      const rest = `${lineBuf}${String(tail ?? '')}`
      lineBuf = ''
      // 围栏没闭合也把它丢掉：那说明这段是代码，本就不该念
      if (!inFence && rest.trim() !== '') accept(rest, out)
      inFence = false
      if (mergeBuf !== '' && cleanForSpeech(mergeBuf) !== '') {
        out.push(cleanForSpeech(mergeBuf))
      }
      mergeBuf = ''
      emittedAny = false
      return out
    },

    /** 新回合开始：丢弃所有未成句的残留（上一轮的话不该拼到这一轮里）。 */
    reset() {
      lineBuf = ''
      mergeBuf = ''
      inFence = false
      emittedAny = false
    },

    /** 给单测/探针看内部状态用。 */
    peek() {
      return { lineBuf, mergeBuf, inFence }
    },
  }
}

/**
 * 播报队列：切好的句子 → 逐句合成 → 保序发给渲染层。
 *
 * 为什么允许 `concurrency: 2` 而不是 1：
 *   纯串行时，第 2 句要等第 1 句合成完**并且**播完才开始，播放间隙明显；
 *   预取一句就能把间隙压到接近 0。但仍然要**按序号输出**，不能谁先回来谁先发 ——
 *   否则「第二句话说在前头」。
 *
 * @param {object} o
 * @param {(text:string)=>Promise<{ok:boolean,audio?:Buffer,mime?:string,error?:string,ms?:number}>} o.speak
 * @param {(payload:object)=>void} o.emit  发一包音频给渲染层
 * @param {(msg:string)=>void} [o.log]
 * @param {boolean} [o.enabled] 关着的时候 feed/flush 全是空操作
 * @param {number} [o.maxChars]
 * @param {number} [o.minChars]
 * @param {number} [o.concurrency] 同时合成的句数（默认 2）
 * @param {number} [o.maxPending] 排队上限，超了丢新句（默认 24）
 */
export function createSpeechQueue({
  speak,
  emit,
  log = () => {},
  /**
   * 合成失败时的回调（宿主用它在下一轮告诉模型「刚才那句没念出来」）。
   * ★ 2026-10-22 加：之前失败只写日志，模型侧零回执 —— 她会一直以为自己说过的话他都听见了。
   *   传进来的是 `{seq, error, failed}`；抛错在这里被吞掉，绝不影响队列。
   */
  onFail = null,
  enabled = false,
  maxChars = 90,
  minChars = 4,
  concurrency = 2,
  maxPending = 24,
} = {}) {
  const segmenter = createSpeechSegmenter({ maxChars, minChars })

  /** 每开一「代」就 +1：老代的结果回来时对不上号，一律丢弃。打断靠的就是它。 */
  let gen = 0
  /** 已发出去的最大序号（用于丢弃迟到结果） */
  let issued = 0
  /** 下一个该输出的序号 —— 保序的指针 */
  let nextEmit = 1
  /** 已完成、等着按序输出的结果 */
  const doneMap = new Map()
  /** 待合成的句子 */
  const queue = []
  let inflight = 0
  let warnedEmpty = false
  let failed = 0

  const isOn = () => enabled === true

  function emitStop(reason) {
    emit({ type: 'speech-stop', gen, reason })
  }

  /** 按序号把结果吐出去，遇到空洞就停（等那个序号回来） */
  function drain() {
    for (;;) {
      // `undefined` = 这一句还没回来；`null` = 这一句失败/被丢弃的墓碑，跳过但不发
      const hit = doneMap.get(nextEmit)
      if (hit === undefined) return
      doneMap.delete(nextEmit)
      nextEmit += 1
      if (hit !== null) emit(hit)
    }
  }

  async function synth(job) {
    const { seq, gen: jobGen, text } = job
    let r
    try {
      r = await speak(text)
    } catch (err) {
      r = { ok: false, error: String(err?.message ?? err) }
    }
    inflight -= 1
    // 这一代已经被打断了：结果直接扔，连日志都不用刷
    if (jobGen !== gen) return pump()
    if (!r || r.ok !== true || !r.audio) {
      failed += 1
      // 只报第一次和每第 5 次，免得一句话失败刷满日志
      if (failed === 1 || failed % 5 === 0) {
        log(`[speech] 合成失败（第 ${failed} 次）：${r?.error ?? '没有音频'}`)
      }
      try {
        onFail?.({ seq, error: String(r?.error ?? '没有音频'), failed })
      } catch {
        /* 回调自己的错不该影响说话队列 */
      }
      // 失败也要**占住这个序号**（`null` 是墓碑）：直接跳过会让 drain() 永远等它，
      // 后面所有句子全堵死 —— 症状是「她说了一句就再也不吭声了」。实测踩过。
      doneMap.set(seq, null)
      drain()
      return pump()
    }
    doneMap.set(seq, {
      type: 'speech',
      gen: jobGen,
      seq,
      mime: r.mime ?? 'audio/mpeg',
      // base64 走 IPC：Buffer 直接在 contextBridge 里过得去，但 base64 更稳
      //（TypedArray 在旧版 contextBridge 上会被转成普通对象，渲染层拿到就废了）
      audio: r.audio.toString('base64'),
      chars: text.length,
      ms: r.ms ?? 0,
    })
    drain()
    pump()
  }

  function pump() {
    while (inflight < concurrency && queue.length > 0) {
      const job = queue.shift()
      if (job.gen !== gen) continue
      inflight += 1
      void synth(job)
    }
  }

  function push(sentences) {
    if (!isOn()) return
    if (!Array.isArray(sentences) || sentences.length === 0) return
    if (typeof speak !== 'function') {
      if (!warnedEmpty) {
        warnedEmpty = true
        log('[speech] 没有可用的合成器（TTS 没配好），本次不播')
      }
      return
    }
    for (const text of sentences) {
      if (queue.length >= maxPending) {
        log(`[speech] 队列积压到 ${maxPending} 句，丢掉后面的话（说明合成比说话慢太多）`)
        return
      }
      issued += 1
      queue.push({ seq: issued, gen, text })
    }
    pump()
  }

  return {
    /** 流式：吃一段她的正文增量。 */
    feed(delta) {
      if (!isOn()) return
      push(segmenter.feed(delta))
    },

    /** 回合结束：把残句吐出来。 */
    finish(tail = '') {
      if (!isOn()) return
      push(segmenter.flush(tail))
    },

    /** 一次性说一整段（闹钟提醒这类「先有完整句子」的场景）。 */
    say(text) {
      if (!isOn()) return
      push(segmenter.feed(String(text ?? '')))
      push(segmenter.flush())
    },

    /**
     * 打断。新回合开始 / 用户点停止 / 关开关都走这里。
     * 正在路上的请求**不 abort**（fetch 已经发出去了，钱照花），
     * 只是把结果丢掉 —— 用户要的是「立刻安静」，不是「省下这一分钱」。
     */
    stop(reason = '') {
      gen += 1
      queue.length = 0
      doneMap.clear()
      nextEmit = issued + 1
      segmenter.reset()
      emitStop(reason)
      if (reason) log(`[speech] 打断（${reason}）`)
    },

    /** 开关切换。关掉时顺手打断 —— 不留半句念完的怪状态。 */
    setEnabled(next) {
      const on = next === true
      if (on === isOn()) return
      enabled = on
      if (!on) this.stop('开关关闭')
      else log('[speech] 已开启')
    },

    isEnabled: isOn,

    /** 给状态推送给 UI 用。 */
    status() {
      return { enabled: isOn(), pending: queue.length, inflight, gen, failed }
    },
  }
}
