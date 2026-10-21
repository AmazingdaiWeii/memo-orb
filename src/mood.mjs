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
 */
const MARKER = /[（(]\s*mood\s*[:：]\s*([A-Za-z\u4e00-\u9fa5_-]{1,12})\s*[)）]/gi

/**
 * 别名表。她自己写中文的概率不低，别逼她记英文单词。
 * ⚠️ 只收「明确指向某个情绪」的词，模棱两可的一律不收 —— 宁可不切，也别乱切。
 */
const ALIASES = {
  idle: ['idle', 'calm', 'neutral', '平静', '日常', '普通', '无事'],
  thinking: ['thinking', 'think', '思考', '沉思', '琢磨', '认真'],
  happy: ['happy', 'joy', 'glad', 'smile', '开心', '高兴', '愉快', '快乐', '高兴的', '笑'],
  shy: ['shy', 'bashful', '害羞', '羞涩', '腼腆', '不好意思'],
  sad: ['sad', 'cry', 'down', '难过', '伤心', '低落', '委屈', '失落', '哭'],
  surprised: ['surprised', 'surprise', 'shock', '惊讶', '吃惊', '震惊', '意外'],
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
    const mood = coerceMood(captured)
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
