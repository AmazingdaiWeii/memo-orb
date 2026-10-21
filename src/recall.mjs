/**
 * 按需召回（recall）—— 零依赖 BM25。
 *
 * 为什么不用向量库：记忆仓一共 ~10KB 语料（MEMORY.md / about/*.md / journal/*.md），
 * 而向量库解决的是十万~百万级检索；DeepSeek 开放平台也没有 /v1/embeddings，
 * 本地嵌入要拖 onnxruntime，直接破坏「零依赖」这条硬约束。
 * 真正的缺口是**旧记忆从来不会主动出现在上下文里**（原来只有她主动调
 * search_memory 才发生，而字面子串匹配又常常查不到）。所以这里做两件事：
 *
 *   1. 把 about/*.md 与 journal/*.md 切块建索引；
 *   2. 每轮拿用户这句话去查，命中就把**摘录**塞到 user 消息的尾部。
 *
 * 三条闸门（防止每轮都塞、塞成噪声）：
 *   · 分数阈值：低于 `minScore` 一律不注入（宁可不提，也不要提一句不相干的旧事）；
 *   · 相对阈值：低于最高分 `relRatio` 倍的丢掉；
 *   · 冷却：同一会话两次注入之间至少隔 `cooldownTurns` 轮，且同一条块不重复注入。
 *
 * ★ 注入块**不能**跟着用户消息落盘。`src/brain.mjs` 里 `appendMessage` 落的是
 *   `persistText`（只有用户说过的话，不含召回块 / 时间 / 余额 / memory_update）。
 *   早先这里的注释写成「落的是 tailText」，与实现不符 —— 已按 2026-10-22 的口径更正。
 */

/** BM25 参数（取值惯例，语料才 10KB，不需要调参） */
const K1 = 1.2
const B = 0.75
/** 单条摘录的字符上限 */
const SNIPPET_MAX = 220
/** 一次最多注入几条 */
const TOP_K = 2
/** 整块注入的字符上限（约 300 token） */
const BLOCK_MAX = 460
/** 低于这个分数不注入（一条都不命中时是 0） */
const MIN_SCORE = 0.6
/** 单字词的权重：汉字单字（药/病/灯）常常是唯一能对上的信号，
 *  但它也太容易撞上，所以只给半个权重，且单字**不计入**「命中几个词」的门槛。 */
const CHAR_W = 0.5
/** 语料里只出现在不超过这么多个块里的词算「罕见词」——罕见词单命中就够可信 */
const RARE_DF_MAX = 2
/** 罕见词单命中时需要的分数（比 MIN_SCORE 高，防止一个常见词漏网当罕见词） */
const RARE_SCORE = 1.0
/** 单字词单命中时需要的分数；另配 CHAR_FALLBACK_SCORE 总闸，两条同时满足才放行 */
const RARE_SCORE_CHAR = 1.0
/** 只靠单字命中的回退通道总分门槛。
 *  实测：「我今天想跟你聊聊药的设定」命中块 2.17 / 1.19，而「今天天气不错啊」最高只有 0.88，
 *  1.2 落在中间且离两边都有余量。别往下调，会开始召回「只因为都有个『气』字」的块。 */
const CHAR_FALLBACK_SCORE = 1.2
/** 低于最高分的这个比例则丢掉（防止一条高分带一堆垃圾） */
const REL_RATIO = 0.42
/** 同一会话两次注入之间至少隔几轮 */
const COOLDOWN_TURNS = 3
/** 索引有效期（毫秒）—— 记忆仓变动不频繁，别每轮都重建 */
const INDEX_TTL_MS = 30_000
/**
 * 停用词：纯功能词，谁都会命中，留着只会制造假阳性。
 * 只放「没有内容信息」的词；「记得」「约好」这类有意涵的不放。
 */
const STOP = new Set([
  '今天', '现在', '什么', '我们', '你们', '他们', '这个', '那个', '可以', '一个',
  '就是', '不是', '还是', '但是', '因为', '所以', '已经', '真的', '觉得', '知道',
  '时候', '然后', '这样', '那样', '一下', '有点', '是不', '想和', '跟你', '跟我',
  '聊聊', '说说', '嗯嗯', '哈哈', '你好', '了吗', '的了',
])
/**
 * 单字停用表：这些字单独出现时没有信息量（它们几乎出现在任何一段中文里）。
 * 只用于「单字词」，bigram 另有 STOP 管。
 */
const CHAR_STOP = new Set(
  ('的了是在我你他她它们这那有和就不也都要会说得地着过个上下里又很吗呢吧啊呀嗯哦么什怎为以但而与及或被把让给对从到去来做时秒分天年月日一二三四五六七八九十' +
    '好没还想看说问点些样种东西自己他她这那哪谁什怎样多少几')
    .split(''),
)
/** 至少命中几个不同的查询词才算数（防止一个「今天」就把旧事翻出来） */
const MIN_MATCHED = 2
/** 命中词 / 查询词 的最低比例。
 * ★ 别调高：中文 bigram 会让一条短句炸出十几个词（「小说里村子」→ 小说/说里/里村/村子），
 *   其中一半是跨词边界的噪声，coverage 天然偏低。0.12 + 绝对下限 2 已经足够挡掉
 *   「只因为都有『今天』就召回」这种假阳性。 */
const MIN_COVERAGE = 0.12

/**
 * 分词：ASCII 词（≥2 字符）+ 汉字 bigram。
 *
 * 中文没有空格，用 bigram 是最省事又够用的做法：「村子是隐喻」→
 * 村子/子是/是隐/隐喻。单字成串（如「病」）也保留，否则单字查询永远查不到。
 */
export function tokenize(text) {
  const out = []
  const t = String(text ?? '').toLowerCase()
  for (const m of t.matchAll(/[a-z0-9_]{2,}/g)) out.push(m[0])
  for (const m of t.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0]
    if (run.length === 1) {
      if (!CHAR_STOP.has(run)) out.push(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2))
    // 单字也留：短名词（药/病/灯/墙）常常只能在单字上对上
    for (const ch of run) if (!CHAR_STOP.has(ch)) out.push(ch)
  }
  return out.filter((w) => (w.length === 1 ? !CHAR_STOP.has(w) : !STOP.has(w)))
}

/**
 * 把一份 markdown 按二级标题切块；没有标题就整篇算一块。
 * 太长的块（>1600 字）再按段落切开，免得一条命中就塞爆预算。
 */
function chunkText(path, content) {
  const text = String(content ?? '')
  if (text.trim() === '') return []
  const parts = []
  const lines = text.split(/\r?\n/)
  let heading = ''
  let buf = []
  const flush = () => {
    const body = buf.join('\n').trim()
    if (body !== '') parts.push({ heading, body })
    buf = []
  }
  for (const line of lines) {
    const m = /^##\s+(.*)$/.exec(line)
    if (m) {
      flush()
      heading = m[1].trim()
      continue
    }
    buf.push(line)
  }
  flush()

  const out = []
  for (const p of parts) {
    if (p.body.length <= 1600) {
      out.push(p)
      continue
    }
    for (const para of p.body.split(/\n{2,}/)) {
      const t = para.trim()
      if (t !== '') out.push({ heading: p.heading, body: t })
    }
  }
  return out.map((p, i) => ({
    path,
    heading: p.heading,
    body: p.body,
    key: `${path}#${i}`,
  }))
}

/** 一条块给模型看的摘要：压掉空白，取开头一段 */
function snippet(body) {
  const flat = String(body ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= SNIPPET_MAX ? flat : flat.slice(0, SNIPPET_MAX) + '…'
}

/**
 * 建索引。只索引 `about/` 与 `journal/`：
 * `MEMORY.md` 每轮已经全文注入，再「召回」它纯属浪费预算。
 */
export async function buildIndex({ memstore, log }) {
  const listing = await memstore.list()
  const files = Array.isArray(listing) ? listing : (listing?.files ?? [])
  const picked = files
    .map((f) => String(f.path ?? ''))
    .filter((p) => p.startsWith('about/') || p.startsWith('journal/'))
    // MemFS 的子目录索引文件不是内容，别索引
    .filter((p) => !p.endsWith('/MEMORY.md'))

  const chunks = []
  for (const path of picked) {
    let content = ''
    try {
      content = (await memstore.read(path)) ?? ''
    } catch (err) {
      log?.(`[recall] 读不了 ${path}：${err.message}`)
      continue
    }
    chunks.push(...chunkText(path, content))
  }

  // 词频与文档频次
  const postings = new Map() // term -> Map(chunkIndex -> tf)
  const lengths = new Array(chunks.length).fill(0)
  chunks.forEach((c, i) => {
    const toks = tokenize(`${c.heading}\n${c.body}`)
    lengths[i] = toks.length
    const tf = new Map()
    for (const tk of toks) tf.set(tk, (tf.get(tk) ?? 0) + 1)
    for (const [tk, n] of tf) {
      let m = postings.get(tk)
      if (!m) postings.set(tk, (m = new Map()))
      m.set(i, n)
    }
  })
  const avgLen = lengths.length === 0 ? 1 : lengths.reduce((a, b) => a + b, 0) / lengths.length
  // 语料签名：**所有**记忆文件的路径 + 长度，用来判断要不要重建。
  // 必须和 `forTurn` 里算的那份口径完全一致（否则永远不相等，等于每轮重建）。
  const signature = files.map((f) => `${f.path}:${f.bytes ?? f.size ?? 0}`).join('|')

  log?.(`[recall] 索引重建：${chunks.length} 块 / ${picked.length} 个文件`)
  return { chunks, postings, lengths, avgLen, signature }
}

/** BM25 打分：返回按分数降序的 [{chunk, score, matched, rare}] */
export function rank(index, query) {
  const terms = tokenize(query)
  if (terms.length === 0) return []
  const uniq = [...new Set(terms)]
  // 「命中几个词」只数双字以上的词：单字太容易撞，让它走 rare 通道单独判
  const longUniq = uniq.filter((t) => t.length >= 2)
  const N = index.chunks.length
  const scored = []
  /** 每块命中了几个**不同的**查询词（只数双字词） */
  const matched = []
  /** 罕见词单命中的最高贡献（双字词 / 单字词分开记，判据不同） */
  const rare = []
  const rareChar = []
  for (let i = 0; i < N; i++) {
    scored.push(0)
    matched.push(0)
    rare.push(0)
    rareChar.push(0)
  }
  for (const term of uniq) {
    const m = index.postings.get(term)
    if (!m) continue
    const df = m.size
    if (df === 0) continue
    const isChar = term.length === 1
    const w = isChar ? CHAR_W : 1
    // 语料小时 idf 容易被单条命中刷成巨大值，加 0.5 阻尼
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    for (const [i, tf] of m) {
      const len = index.lengths[i] || 1
      const norm = 1 - B + B * (len / (index.avgLen || 1))
      const contrib = w * idf * ((tf * (K1 + 1)) / (tf + K1 * norm))
      scored[i] += contrib
      if (isChar) {
        if (df <= RARE_DF_MAX && contrib > rareChar[i]) rareChar[i] = contrib
      } else {
        matched[i] += 1
        if (df <= RARE_DF_MAX && contrib > rare[i]) rare[i] = contrib
      }
    }
  }
  // 门槛按双字词算（单字不算分母，否则「药」这种短查询永远过不了）
  const needMatched = Math.max(MIN_MATCHED, Math.ceil(longUniq.length * MIN_COVERAGE))
  const out = []
  for (let i = 0; i < N; i++) {
    if (scored[i] < MIN_SCORE) continue
    const strongRare = rare[i] >= RARE_SCORE
    // 回退通道：一个双字词都没命中，但命中了一个罕见的单字名词（药/病/灯），
    // 且总分够高 —— 否则「今天天气不错啊」这种会被「气」带出来。
    const strongChar = matched[i] === 0 && rareChar[i] >= RARE_SCORE_CHAR && scored[i] >= CHAR_FALLBACK_SCORE
    if (matched[i] >= needMatched || strongRare || strongChar) {
      out.push({ chunk: index.chunks[i], score: scored[i], matched: matched[i], rare: rare[i], rareChar: rareChar[i] })
    }
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

/**
 * 创建召回器。
 *
 * @param {object} o
 * @param {object} o.memstore   需要 list/read
 * @param {(m:string)=>void} [o.log]
 */
export function createRecall({ memstore, log = () => {} }) {
  /** @type {null | {chunks:any[],postings:Map<string,Map<number,number>>,lengths:number[],avgLen:number,signature:string,at:number}} */
  let index = null
  /** 每个会话的注入状态：轮次计数 + 冷却 + 已用过的块 */
  const state = new Map()

  function stateOf(sessionId) {
    let s = state.get(sessionId)
    if (!s) state.set(sessionId, (s = { turn: 0, lastAt: -999, used: new Set() }))
    return s
  }

  async function ensureIndex({ filesSignature }) {
    const fresh = index && Date.now() - index.at < INDEX_TTL_MS && index.signature === filesSignature
    if (fresh) return index
    index = { ...(await buildIndex({ memstore, log })), at: Date.now() }
    return index
  }

  /**
   * 为本轮算一段可注入的召回块。
   *
   * @returns {Promise<{text: string, items: object[], skipped: string}>}
   *          `text === ''` 表示这轮不注入（`skipped` 说明原因，只进日志）。
   */
  async function forTurn({ sessionId = '', query = '' } = {}) {
    const st = stateOf(sessionId)
    st.turn += 1
    const q = String(query ?? '').trim()
    // 太短的一句（「嗯」「好」）不查 —— 白查还容易撞上不相干的块
    if (tokenize(q).length < 2) return { text: '', items: [], skipped: 'query-too-short' }
    if (st.turn - st.lastAt < COOLDOWN_TURNS) return { text: '', items: [], skipped: 'cooldown' }

    let sig = ''
    try {
      const listing = await memstore.list()
      const files = Array.isArray(listing) ? listing : (listing?.files ?? [])
      sig = files.map((f) => `${f.path}:${f.bytes ?? f.size ?? 0}`).join('|')
    } catch (err) {
      log(`[recall] 列目录失败，本轮不召回：${err.message}`)
      return { text: '', items: [], skipped: 'list-failed' }
    }

    let idx
    try {
      idx = await ensureIndex({ filesSignature: sig })
    } catch (err) {
      log(`[recall] 建索引失败，本轮不召回：${err.message}`)
      return { text: '', items: [], skipped: 'index-failed' }
    }

    const ranked = rank(idx, q).filter((r) => r.score >= MIN_SCORE)
    if (ranked.length === 0) return { text: '', items: [], skipped: 'no-hit' }

    const top = ranked[0].score
    const picked = []
    for (const r of ranked) {
      if (picked.length >= TOP_K) break
      if (r.score < top * REL_RATIO) break
      if (st.used.has(r.chunk.key)) continue
      picked.push(r)
    }
    if (picked.length === 0) return { text: '', items: [], skipped: 'all-used' }

    const lines = []
    for (const r of picked) {
      const head = r.chunk.heading ? `（${r.chunk.heading}）` : ''
      lines.push(`- \`${r.chunk.path}\`${head} ${snippet(r.chunk.body)}`)
    }
    let text =
      '【记忆仓里可能相关的旧记录】以下是自动检索出来的，只在与当下话题真的相关时自然提起，' +
      '不要逐字复述，也不要声明「我查了记忆」：\n' +
      lines.join('\n')
    if (text.length > BLOCK_MAX) text = text.slice(0, BLOCK_MAX) + '…'

    for (const r of picked) st.used.add(r.chunk.key)
    // 只保留最近 40 条去重记忆，免得这个集合无限长
    if (st.used.size > 40) st.used = new Set([...st.used].slice(-40))
    st.lastAt = st.turn
    log(`[recall] 注入 ${picked.length} 条（top=${top.toFixed(2)}）`)

    return {
      text,
      items: picked.map((r) => ({ path: r.chunk.path, heading: r.chunk.heading, score: Number(r.score.toFixed(3)) })),
      skipped: '',
    }
  }

  return { forTurn, _reset: () => { index = null; state.clear() } }
}

