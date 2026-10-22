/**
 * 情绪 GIF —— 纯逻辑层（不碰网络、不碰文件系统、不碰 Electron）。
 *
 * 分工（`功能落地_交接文档.md` §4 + §8）：
 *   · **host 侧（本文件 + main.mjs 的 `applyMood`）**：从她的回复里提取 `(mood:xxx)` 标记、
 *     把它从正文里剥掉（用户不可见），再把「该显示哪个情绪」推给球。
 *   · **球侧（UI 助手的活）**：拿到情绪后怎么渲染、放哪一层，不归本文件管。
 *
 * ============================ 两个硬约束 ============================
 *
 * ① **球侧只吃特定文件名**。`helper/lib/main.js` 里的预设校验是
 *
 *        const PRESET_SRC = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9_-]+)*\.gif$/;
 *
 *    也就是**只允许小写字母、数字、下划线、连字符**。
 *    素材目录里的原名叫 `happy@0.85x.gif` —— `@` 和 `0.85` 里的 `.` 都不合法，
 *    直接发过去会被球**静默丢弃**。所以这里统一改成 `deco/happy.gif` 这种朴素名字。
 *
 * ② **每个情绪的倍速是固定的**，所以每个情绪只需要**一个**文件 ——
 *    倍速在「挑素材」那一步就烤进文件里了，运行时不需要再选。
 *    本文件仍然保留倍速表：它是**这份选择的唯一记录**，也是拷贝脚本和单测的依据。
 *    以后想换某个情绪的倍速，改这里 → 重跑拷贝 → 名字不变，球侧一行都不用动。
 *
 * ===================================================================
 */

/** 球的 assets/ 下、放装饰 GIF 的子目录。 */
export const DECO_DIR = 'deco'

/**
 * 六个情绪 + 用户 2026-10-07 亲自敲定的播放速度。
 *
 * `speed` 对应 `deco-plan/output/<mood>@<speed>.gif`（挑素材用）。
 * 表里**故意不写 opacity** —— 透明度是图层的属性，整层一个值，见 `LAYER_OPACITY`。
 * （真需要某个情绪单独调，在对应项里加一个 `opacity` 数字即可，`assetFor()` 会优先用它。）
 */
export const MOODS = {
  idle: { speed: '0.85x' },
  thinking: { speed: '0.5x' },
  happy: { speed: '0.85x' },
  shy: { speed: '0.7x' },
  sad: { speed: '0.5x' },
  surprised: { speed: '0.5x' },
}

/**
 * 装饰图层的默认透明度 —— GIF 在独立的 deco-lane 区域，不遮挡文字，
 * 因此不需要半透明，完全不透明即可。
 */
export const LAYER_OPACITY = 1

export const MOOD_NAMES = Object.keys(MOODS)

/** 兜底情绪。认不出来的一律当 idle，绝不把球丢在一个「没有情绪」的空状态里。 */
export const DEFAULT_MOOD = 'idle'

/** 她在思考时用的情绪（由 host 的回合状态驱动，不是从回复里读的）。 */
export const THINKING_MOOD = 'thinking'

/**
 * 标记长什么样。**必须带冒号** —— 这是「无误切」的关键：
 * 不加冒号的话，正文里一句「mood 这个词」也会被当成标记吃掉。
 *
 * 中英文括号、中英文冒号都收，因为她不一定记得住该用哪个。
 *
 * ============ 2026-10-22 二次放宽：值里可以有逗号了（用户拍板） ============
 *
 * 旧捕获组是 `[A-Za-z\u4e00-\u9fa5_-]{1,12}` —— **不收中文逗号**。
 * 她真实写过这样的标记（`probe/mood-marker-gap.mjs` 从 30 个会话文件里扫出 5 处）：
 *
 *     （mood:愣了下，认真起来）   （mood:开心，松了口气）
 *     （mood:惊喜，眼睛都亮了）   （mood:有点窘，笑了）  （mood:乐了，好奇）
 *
 * 中文逗号一出现，**整条标记匹配失败**，后果是双重的：
 *   ① 情绪不切（表情不动，跟以前那个 47.5% 静默丢弃是同一类"安静地不工作"）；
 *   ② 标记没被剥掉，`（mood:开心，松了口气）` **原样显示给她看** —— 把内部协议泄漏了。
 *
 * 更阴的是它连 `probe/mood-alias-audit.mjs` 都统计不到：那支也用同一个正则扫，
 * 匹配不上的自然不入账，于是命中率一直显示 97.5%、看着很健康。缺口是隐形的。
 *
 * 现在的值域 = 「除右括号、换行之外的任意字符」，上限 48：
 *   · 逗号能进来了；
 *   · 上限只是防呆（防 `(mood:` 万一出现在正文里吞掉一整句），真实样本最长 9 字；
 *     48 是刻意给宽松的 —— 值太长时 `coerceMoodPhrase()` 仍会切出第一个词，
 *     但**上限太紧的代价是"整条不匹配 ⇒ 标记泄漏给她看"**，比多删几个字严重得多；
 *   · **值里多个词怎么取**不在这里管，交给 `coerceMoodPhrase()` —— 先整串试，再按标点切开逐个试。
 *
 * ⚠️ `src/main.mjs` 的 `MARKER_TAIL`（流式中扣住半截）和 `UNCLOSED_MARKER`（忘写右括号）
 *    是这条正则的**两个必须同步的兄弟**，值域上限也必须是同一个数。
 *    只改这里不改它们 ⇒ 流式过程中会闪出 `（mood:开心，` 这半截，回合结束才消失 ——
 *    用户看到的就是"球会吐奇怪的括号"。守这条的探针是 `probe/mood-stream-marker.mjs`。
 */
const MARKER_SRC = '[（(]\\s*mood\\s*[:：]\\s*([^)）\\n]{1,48}?)\\s*[)）]'

/**
 * 造一个新的标记正则（带 `g`，每次都是新实例，不共享 `lastIndex`）。
 *
 * 导出是为了让 `probe/mood-alias-audit.mjs` 与 `probe/mood-marker-gap.mjs`
 * **用同一份源**去扫真实数据 —— 以前它们各自复制一份字面量，
 * 产品这边一放宽、探针还拿着老的，审计就变成了自欺（这次正是这么漏掉 5 条的）。
 */
export function createMoodMarker() {
  return new RegExp(MARKER_SRC, 'gi')
}

const MARKER = createMoodMarker()

/**
 * 别名表。她自己写中文的概率不低，别逼她记英文单词。
 * ⚠️ 只收「明确指向某个情绪」的词，模棱两可的一律不收 —— 宁可不切，也别乱切。
 *
 * ================== 2026-10-22 扩表（用户报障的真凶） ==================
 *
 * 现象：用户报「情绪 GIF 表达不完整，只有思考和开心两种，其它的都无法加载」。
 * 实测（`probe/deco-decode-e2e.cjs`）六张 GIF 在真实渲染进程 **6/6 解码成功** ——
 * 素材与链路无罪。真凶在这里：`probe/mood-alias-audit.mjs` 扫她**真实写过**的
 * 80 处 `(mood:xxx)`，旧表只认得出 **3 个词**（认真31 / 开心10 / 难过1），
 * 命中率 52.5%，**47.5% 的标记被 `coerceMood` 判 null 后静默丢掉**。
 *
 * 根因不是代码 bug，是**覆盖面**：她是角色，不是词典，同一个心情会随手写
 * 「若有所思」「被说中了」「有点闷」—— 旧表每个情绪只收 4~6 个词，接不住。
 * 下面这些新词**全部来自日志里的真实用词**，不是拍脑袋想的近义词。
 *
 * ⚠️ 以后再加词，先跑 `node probe/mood-alias-audit.mjs` 看还漏哪些，
 *    别凭想象补 —— 她想出来的说法比我们能猜的野得多。
 *
 * ============ 2026-10-22 二次补词（来源：`probe/mood-marker-gap.mjs`） ============
 *
 * 上一次扩表之后，audit 显示命中率 97.5%、只剩「坦白」2 处 —— 看着已经收工了。
 * 但 audit 统计不到**正则压根没匹配上**的标记。补扫那 5 条带中文逗号的标记时，
 * 里面的词有一半不在表里，所以即使放宽了正则，它们仍然会「认不出 → 只剥不认」：
 *
 *     愣了下（surprised）  认真起来（thinking）  松了口气（happy）
 *     有点窘（shy）        乐了（happy）        笑了（happy）
 *
 * 这 6 个词**全部来自她的真实用词**，不是我们编的近义词。加进去之后，
 * 那 5 条标记从「切不出表情」变成「5/5 都切得出」。
 *
 * 注意 `coerceMoodPhrase()` 是**按顺序取第一个认得出的词**，所以「愣了下，认真起来」
 * 给出的是 surprised ——「愣了下」在前，先到的算数（跟"多个标记以最后一个为准"不同：
 * 那是标记级别，这是标记内部，先写的心情先落地）。
 */
const ALIASES = {
  idle: ['idle', 'calm', 'neutral', '平静', '日常', '普通', '无事', '发呆', '放空'],
  thinking: [
    'thinking', 'think', '思考', '沉思', '琢磨', '认真',
    '若有所思', '专注', '停顿', '出神',
    '认真起来', '认真了',
    // `坦白` 是 audit 剩下的最后 2 处。查了原文上下文，两处都是
    // 「我老实说，把不讨好的那半也讲清楚」这种沉稳陈述，不是害羞 —— 归认真。
    '坦白',
  ],
  happy: [
    'happy', 'joy', 'glad', 'smile', '开心', '高兴', '愉快', '快乐', '高兴的', '笑',
    '兴奋', '满意', '安心', '期待', '暖', '来劲', '雀跃', '得意', '舒服', '激动',
    '松了口气', '松了一口气', '乐了', '笑了', '放心', '轻松',
  ],
  shy: [
    'shy', 'bashful', '害羞', '羞涩', '腼腆', '不好意思',
    '被说中了', '被将了一军', '脸红', '心动', '紧张', '羞',
    '有点窘', '窘', '窘迫', '害臊',
  ],
  sad: [
    'sad', 'cry', 'down', '难过', '伤心', '低落', '委屈', '失落', '哭',
    '有点闷', '闷', '懊恼', '怀念', '心酸', '丧', '无奈', '叹气',
  ],
  surprised: [
    'surprised', 'surprise', 'shock', '惊讶', '吃惊', '震惊', '意外',
    '惊喜', '瞪眼', '发懵', '好奇', '诧异', '愣住', '被点醒', '恍然大悟',
    '愣了下', '愣了一下', '愣了一瞬', '没反应过来',
  ],
}

/** 别名 → 规范情绪名。反向索引，构造一次。 */
const ALIAS_INDEX = (() => {
  const map = new Map()
  for (const [mood, words] of Object.entries(ALIASES)) {
    for (const w of words) map.set(w.toLowerCase(), mood)
  }
  return map
})()

/**
 * 把任意写法收敛到六个情绪之一。
 * @returns {string|null} 认不出来返回 `null`（调用方据此「剥掉标记但不改情绪」）
 */
export function coerceMood(raw) {
  if (typeof raw !== 'string') return null
  const key = raw.trim().toLowerCase()
  if (key === '') return null
  if (Object.prototype.hasOwnProperty.call(MOODS, key)) return key
  return ALIAS_INDEX.get(key) ?? null
}

/**
 * 标记内部的分隔符。中文逗号是真实数据里唯一出现过的（5/5）；
 * 其余几个是顺手收的，免得她换成顿号或分号时又静默失效一次。
 *
 * ⚠️ **故意不把空格当分隔符**：`(mood:not happy)` 若按空格切开就会得到 `happy`，
 *    语义正好反了。多词必须靠标点分隔才允许拆。
 */
const PHRASE_SEP = /[，,、;；/|]/

/**
 * 一个标记**值**（可能是单个词，也可能是几个词用逗号连起来）→ 情绪。
 *
 * 为什么要这一层：她真实写过 `（mood:开心，松了口气）` 这种"两个心情一起给"的写法。
 * 整串丢给 `coerceMood()` 必然认不出（别名表里没有这个长串），
 * 结果就是标记被剥掉、表情不动 —— 又一次"安静地不工作"。
 *
 * 策略：**先整串试，再按标点切开逐个试，取第一个认得出的**。
 *   · 先试整串是为了尊重"整串本身就是一个别名"的可能（`被将了一军` 里没有标点，但保险）；
 *   · 取第一个而不是最后一个：她想表达的主情绪通常写在前面
 *     （`愣了下，认真起来` → 先愣住；`有点窘，笑了` → 窘才是重点）。
 *
 * @returns {string|null} 一个词都认不出时返回 `null`（调用方只剥不认）
 */
export function coerceMoodPhrase(phrase) {
  if (typeof phrase !== 'string') return null

  const whole = coerceMood(phrase)
  if (whole !== null) return whole

  for (const part of phrase.split(PHRASE_SEP)) {
    const hit = coerceMood(part)
    if (hit !== null) return hit
  }
  return null
}

/**
 * 从她的回复里提取情绪标记，并把标记从正文里**剥掉**。
 *
 * 契约（`功能落地_交接文档.md` §4 + 待测清单 2.1-2.5）：
 *   · 标记可以出现在**任意位置**，不只在末尾；
 *   · 一个回复里出现多个标记时，以**最后一个**为准（她中途改口是合理的）；
 *   · 无论认不认得出情绪，**标记本身都要剥掉** —— 那是给程序看的，用户不该看到；
 *   · 剥完要收拾一下残留的空白，别在正文里留下突兀的空行。
 *
 * @param {string} text
 * @returns {{ mood: string|null, text: string, found: boolean, raw: string|null }}
 */
export function extractMood(text) {
  const src = typeof text === 'string' ? text : ''
  if (src === '') return { mood: null, text: src, found: false, raw: null }

  let lastRaw = null
  let lastMood = null
  let found = false

  const cleaned = src.replace(MARKER, (_all, captured) => {
    found = true
    lastRaw = String(captured)
    // 用 `coerceMoodPhrase` 而不是 `coerceMood`：值里可能有好几个词用逗号连着。
    const mood = coerceMoodPhrase(captured)
    if (mood !== null) lastMood = mood      // 认不出的标记只剥不认
    return ''
  })

  if (!found) return { mood: null, text: src, found: false, raw: null }

  return { mood: lastMood, text: tidy(cleaned), found: true, raw: lastRaw }
}

/**
 * 收拾剥掉标记之后的残留：
 *   · 行尾被掏出来的空格 → 去掉（标记常常紧跟在句尾，剥完留一屁股空格）；
 *   · 连着的空行压成一个（标记常常独占一行，剥完会留个空洞）；
 *   · 整条首尾的空白 → 去掉。
 */
function tidy(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '')
}

/**
 * 情绪 → 球要的东西。
 *
 * `src` 是相对球 `assets/` 的路径，**必须**满足球侧那条 `PRESET_SRC` 正则
 * （小写字母/数字/`_`/`-`，`/` 分隔，`.gif` 结尾）。
 *
 * @param {string|null} mood 认不出的值会退化成 idle
 * @returns {{ mood: string, src: string, opacity: number, speed: string }}
 */
export function assetFor(mood) {
  const key = Object.prototype.hasOwnProperty.call(MOODS, mood) ? mood : DEFAULT_MOOD
  const cfg = MOODS[key]
  return {
    mood: key,
    src: `${DECO_DIR}/${key}.gif`,
    // 情绪项的 `opacity` 是可选的**单点覆盖**；不写就跟随图层默认值。
    opacity: typeof cfg.opacity === 'number' ? cfg.opacity : LAYER_OPACITY,
    speed: cfg.speed,
  }
}

/**
 * 校验一个 src 能不能过球侧那道正则。
 * 放在这里是为了**在 host 侧就拦下**，而不是发出去被球静默丢弃（那种最难查）。
 */
const SAFE_SRC = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9_-]+)*\.gif$/
export function isSafeAssetSrc(src) {
  return typeof src === 'string' && SAFE_SRC.test(src)
}

/** 拷贝脚本要用：把「美术给的素材文件名」算出来，例如 `happy@0.85x.gif`。 */
export function sourceFileName(mood) {
  const cfg = MOODS[mood]
  if (!cfg) return null
  return `${mood}@${cfg.speed}.gif`
}
