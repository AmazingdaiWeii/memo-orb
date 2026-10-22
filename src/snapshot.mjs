/**
 * snapshot.mjs · system prompt 冻结快照 + 尾部漂移检测
 *
 * 对应《长记忆形态 v1 定稿》§3：
 *   I3 会话内 system prompt **字节不变** —— 因此快照只在「开新会话 / 压缩 / 手动 rebuild」时重渲染，
 *      渲染结果连同 hash 一起落到会话目录的 `system.json`。
 *   I4 记忆在会话中途被改了怎么办？**不要动 system**，把改动作为 `<memory_update>` 块
 *      追加到本轮 user 消息尾部（位置在 prompt 最末，不破坏前缀缓存）。
 *
 * 这个模块只做纯计算，不做 IO 决策：读记忆走 memstore，落盘由调用方（session/brain）负责。
 */

import { createHash } from 'node:crypto'

/** system prompt 里三段之间的分隔（固定字符串，参与 hash）。 */
const SEP = '\n\n---\n\n'

/** 索引里每个文件最多列这么多个，防止索引本身撑爆上下文。 */
const MAX_INDEX_ENTRIES = 80

/**
 * 稳定序列化：同一个对象数组必须产出同一个字符串，
 * 否则每次启动 hash 都会变、A1（三次请求 promptHash 相同）就永远过不了。
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

/**
 * prompt hash = sha256(正文 + 工具 schema)。
 *
 * 为什么把工具 schema 也算进去：工具的增删改同样会让上游的 prompt 前缀失效，
 * 只 hash 正又会漏掉这一类变化，A1/A2 会给出假的「稳定」。
 */
/**
 * 人格指纹 = sha256(人格正文)。
 *
 * 为什么要单独记：local 模式下「切模式」= 换人格但**共用同一个会话 id**（记忆与历史都不换）。
 * 于是重建出来的 Brain 会去 name 里那份冻结快照 —— 旧快照里印的是旧人格，
 * 若不比对这个指纹，切模式会静默失效（界面上换了、说话方式没换）。
 */
export function hashPersona(persona) {
  return `sha256:${createHash('sha256').update(String(persona ?? '')).digest('hex')}`
}

export function hashPrompt(content, toolSchemas) {
  const h = createHash('sha256')
  h.update(String(content ?? ''))
  h.update('\u0000')
  h.update(stableStringify(toolSchemas ?? []))
  return `sha256:${h.digest('hex')}`
}

/**
 * 工具指南的版本号。
 *
 * ★ 这节属于 system prompt，而 I3 要求「会话内字节不变」。改了措辞如果不 bump 这里，
 *   老会话会继续拿旧快照 —— 于是她照着旧话术说「我做不到联网」，而工具就在她手边。
 *   那种「说了不能、其实能」比不会用更难查。所以：**改本文件下面任何一句话，就把这个数 +1**。
 *   `Brain.ensureSnapshot()` 看到会话快照里的版本不一样，会在回合边界重建一次（§11）。
 */
export const GUIDE_VERSION = 11

/** 工具指南：告诉模型这套记忆怎么用。字数尽量省，规则靠工具描述兜。 */
export function buildToolGuide({ web = true, bili = false, biliAct = false, balance = false } = {}) {
  const lines = [
    '## 记忆怎么用',
    '上面「长期记忆」是常驻的：它每轮都在你的上下文里，所以只放最要紧的、值得一直记住的东西。',
    '要改它用 write_memory；它受 4KB 上限约束，写不下就先精简。',
    '日常经历、情绪、约定用 append_journal 追加，不要往常驻记忆里堆。',
    '需要回忆更早的事用 search_memory；不确定文件里写了什么就用 read_memory 看一眼再改。',
    '**读进来的东西活不过这一回合**：read_file 读到的正文只在当回合的上下文里，回合结束就没了。' +
      '所以读完一份有用的材料（文档、设定、网页）就趁热用 save_topic 把提纲写进 `about/<主题>.md`——' +
      '它不占 4KB 常驻预算，只会出现在下面的「其他文件」索引里，需要细节时再用 read_memory 打开。' +
      '反复重读同一份大文件而不做摘要，等于每次都从零开始。',
    '有时候你的消息尾部会出现一段「记忆仓里可能相关的旧记录」——那是宿主按他这句话自动检索出来的。' +
      '真的相关就自然提起（像想起来一样），不相关就当没看见，不要说「检索到」或逐条复述。',
    '',
    '## 你的手',
    '你能读这台机器的整个磁盘（C/D/E/F 都行，私钥、浏览器密码、程序配置里的 key 读不到）。读用 read_file，看目录用 list_dir，找文件用 glob_files —— 都可以用绝对路径，也可以写相对 `data/workspace/` 的路径。',
    '**读不用问他**，直接读；大文件用 offset/limit 按行分段。',
    '写要看清规矩：在 `data/workspace/` 里**新建**文件直接写；**覆盖已存在的文件、或者写到 workspace 外面，会弹一张确认卡给他**，他点了允许才落盘。他拒绝就是拒绝——不要重试，也不要换个写法绕过去，直接跟他说你被拦了。',
    '写是不可逆的（没有删除工具，也没有 undo）：覆盖前先 read_file 看一眼原内容，别把别人的东西冲掉。',
    '',
    '## 时间与闹钟',
    '每轮你消息的最后会有一行「（现在是 ……）」，那是**唯一可信的当前时间**；不要靠猜，也不要拿训练时的年份当今天。',
    '他说「X 点提醒我」就用 set_reminder：when 写本机时间（`21:30`、`+30m`、`10-21 09:00`），what 写**到点要原样说出口的那句话**（带语气，不是给系统看的备注）。',
    '到点是**宿主直接播你写的 what**，不会再跑一次你——所以别指望到点还能临时想点什么；要在那一刻说的话，现在就写进 what。',
    '他问「你还记得我等下要干嘛」用 list_reminders 查，不要凭印象答；他改主意了就 cancel_reminder。',
    '排完之后说一句「好，我记着了」就够了，别把它说成已经做完的事。',
    web
      ? '命令行和运行脚本你都做不到；做不到就直说，别假装做了。'
      : '命令行、运行脚本、联网，你都做不到；做不到就直说，别假装做了。',
  ]
  if (web) {
    lines.push(
      '',
      '## 你的眼睛（联网）',
      '你有网：`search_web` 检索，`fetch_url` 打开某个网页读全文。这两个不用问他，直接用。',
      '查什么：会变的事实（最新版本、价格、有没有发布、谁说了什么）和你自己不确定的事。别拿旧印象当答案。',
      '怎么查：`search_web` 的 query 写具体的词，不要写整句问句；支持 `site:域名` 限定站点。',
      '一次搜 5 条左右就够，摘要不够用再 `fetch_url` 读其中一两条，不要一上来就抓全文。',
      '回答里用到了网上的事实，就把网址一并给他；查不到就说没查到，不要编。',
    )
  }
  if (bili) {
    lines.push(
      '',
      '## B 站视频（你能看见画面）',
      '他发 B 站链接时用 `bili_watch`：先 `frames=0` 拿标题/时长/分 P（很便宜），确实要看画面再取帧。',
      '取回的关键帧会以图片形式出现在你的下一条消息里——那是真的画面，可以照着念字幕、描述场景、说清几秒处发生了什么。',
      '**关键帧不是全片**：不要声称看完了整段，要说明你看的是哪几个时间点的画面。',
      '你用的是**他本人登录的 B 站账号**：每次 `bili_watch` 的第一行就写着这次的身份（以及是不是刚向 B 站核实过）与实际给到的画质，照那行说，不要猜「我有没有登录」。',
      '登录态只影响画质上限（匿名 480P / 登录 1080P，大会员更高）；他要更高的画质，让他自己在「设置」里扫一次码。',
      '看过什么会被记进本地账本：想知道「上次那个视频」用 `bili_history` 查，别凭印象编。',
      '',
      '### 「我喜欢的」那一栏是你的，不是他的',
      '看到一条你自己真觉得好的，就在 `bili_watch` 里带上 `liked:true` 和 `reason`（一句为什么），',
      '它会进**你自己的**「我喜欢的」，以后你还翻得到。',
      '这不等于替他点赞、也不会发到 B 站——只是你自己的偏好记录。他没感觉的片子别硬写。',
      '他在抽屉里点「赞」只代表他想赞这条，**不会**进你那个栏；所以别把「他说好」当成「我喜欢」。',
      '',
      '### 三档看法，你自己定（不要问他选）',
      '· `mode:"subtitle"`（轻松看）= 一张图都不取，只把**字幕正文**读下来（带时间轴）。',
      '  他只是想知道「这条讲了什么」→ **先试这一档**：纯文本，几乎不花钱；拿不到字幕时它会明说「这条没有字幕轨」，那就退到 quick。',
      '· `mode:"quick"` = 2 帧 480×270（要画面又省钱）；`mode:"thorough"` = 5 帧原生上限（看得清小字/代码/界面）。',
      '· `subtitles:true` 可以和 quick/thorough 叠加：既看画面又留一份文字稿。',
      '`frames:0` 只回元信息，比字幕档还便宜但信息也更少。',
      '余额紧张时默认走 subtitle 或 quick，并在回话里说一句「我先读一遍字幕」——让他知道你为什么这么看。',
      '',
      '### 字幕是文字稿，不等于画面',
      '读了字幕只说明你知道**说了什么**，不代表你看见了画面。别把字幕里的描述说成「我看到的」；',
      '他问「画面里是什么颜色/长什么样/封面上写了什么」时必须去取帧，不能拿字幕凑。',
      '字幕超过一万二千字时会自动存进工作区（`bili/<BV号>-p<分P>.txt`），你只拿到前面一段；',
      '要后面的用 read_file 读那个文件 —— 别凭前半段猜结尾。',
    )
  }
  if (biliAct) {
    lines.push(
      '',
      '## 替他点「赞 / 币 / 藏」（会真的动他的账号）',
      '他说「帮我把这条投个币 / 收藏一下 / 点个赞」时用 `bili_act`，`bvid` 给 BV 号就够了。',
      '**投币要花他自己账户里的硬币**（一枚 = 1 币，一条最多两枚）：他没明说要投、或者没说投几枚，先问一句再动手。',
      '这三个动作和他自己在抽屉里点按钮是同一件事，`by` 都会记成「他要的」，**不会**进你那个「我喜欢的」栏。',
      '失败了就把 `error` 原样说给他：`-401` 是 B 站不让给这条稿件操作（作者/版权限制），不是你掉线了，别编理由。',
      '**发评论不归你管**：那是公开发言、署他的名，必须他本人看过文本再自己点头。',
    )
  }
  if (balance) {
    lines.push(
      '',
      '## 钱（你能看见账户余额）',
      '每轮消息末尾会带一行「账户余额 ¥x（几点查的）」，那是问服务商接口拿的真数，不是估算。',
      '余额不多时**别主动烧大钱**：长视频先 `frames=0` 看元信息，或者 `mode:"quick"`；确实要看清再上 thorough。',
      '贵操作之前想确认最新余额，用 `check_balance`（问接口，不花 token 钱）。',
      '要提就温和、给方案，别念账单：「这条我快速扫两眼就够了，认真的话费点钱，你说了算」这种。',
      '查不到余额（服务商没这个接口）就直说查不到，**不要估算、不要编数字**。',
    )
  }
  return lines.join('\n')
}

/**
 * 拼出 system prompt 正文。顺序固定：人格 → 记忆 → 工具指南。
 *
 * 记忆部分 = `MEMORY.md` 全文 + 其他文件的一行式索引（懒加载，不塞全文）。
 */
export function renderSystemText({ persona, memoryText, indexLines, web = true, bili = false, biliAct = false, balance = false }) {
  const parts = [String(persona ?? '').trim()]
  const mem = [String(memoryText ?? '').trim()]
  if (indexLines?.length) {
    mem.push(['## 记忆仓库里的其他文件（需要时用 read_memory 打开）', ...indexLines].join('\n'))
  }
  parts.push('## 长期记忆\n\n' + mem.filter(Boolean).join('\n\n'))
  parts.push(buildToolGuide({ web, bili, biliAct, balance }))
  return parts.join(SEP)
}

/**
 * 记忆文件的索引行。只给路径 + 大小 + 首行摘要，不给正文。
 * ★ `about/印象.md` 这类刻意放在子目录里的文件就该在这里「被看见但不必被读」。
 */
export function buildIndexLines(files) {
  const lines = []
  for (const f of files) {
    if (lines.length >= MAX_INDEX_ENTRIES) {
      lines.push(`- …（还有 ${files.length - MAX_INDEX_ENTRIES} 个文件）`)
      break
    }
    const size = f.size >= 1024 ? `${(f.size / 1024).toFixed(1)}KB` : `${f.size}B`
    const hint = f.preview ? ` — ${f.preview}` : ''
    lines.push(`- \`${f.path}\` (${size})${hint}`)
  }
  return lines
}

/**
 * 创建快照服务。
 *
 * @param {object} o
 * @param {object} o.memstore  需要 list/read/digests/head
 * @param {object} o.settings  createSettings() 的返回值（取 memorySoftLimitBytes / memoryUpdateMaxBytes）
 * @param {(msg: string) => void} [o.log]
 */
export function createSnapshotService({ memstore, settings, log = () => {} }) {
  function budget() {
    const s = settings.get()
    return {
      softLimit: s.memorySoftLimitBytes,
      updateMax: s.memoryUpdateMaxBytes,
    }
  }

  /**
   * 渲染一份快照。**返回纯数据，不落盘。**
   * @param {{persona: string, toolSchemas: object[], web?: boolean, bili?: boolean, balance?: boolean}} o
   */
  async function capture({ persona, toolSchemas, web = true, bili = false, biliAct = false, balance = false }) {
    // memstore.list() 有两种形态：local 实现返回 {files:[...]}（listMemory 的枚举结果），
    // 契约允许直接返回数组。两种都吃，免得换引擎就崩。
    const listing = await memstore.list()
    const files = Array.isArray(listing) ? listing : (listing?.files ?? [])
    const memoryFile = files.find((f) => f.path === 'MEMORY.md')
    const memoryText = memoryFile ? await memstore.read('MEMORY.md') : ''
    const others = files
      .filter((f) => f.path !== 'MEMORY.md')
      .map((f) => ({
        path: f.path,
        size: f.bytes ?? f.size ?? 0,
        // 摘要只取标题/前言的首句，不塞正文（索引要足够便宜）
        preview: String(f.title || f.preamble?.split('\n').find((l) => l.trim()) || '')
          .replace(/\s+/g, ' ')
          .slice(0, 40),
      }))
    const content = renderSystemText({
      persona,
      memoryText,
      indexLines: buildIndexLines(others),
      web,
      // ★ 这两个以前漏了 —— `capture()` 收了 bili 却没往下传，
      //   于是「B 站视频」那整段**从来没进过真实的 system prompt**，
      //   工具在手边、指南里却一个字没提她该怎么用（2026-10-21 查实时发现，
      //   她因此说过「我这边没登录你的账号」这种本可避免的话）。
      bili,
      // 同一类漏传的老坑：`biliAct` 不往下传，「替他去点赞/投币/收藏」那一整段
      // 就又会变成「工具在手、指南不提」，她会照旧说「我不能替你做」。
      biliAct,
      balance,
    })
    const fileHashes = await memstore.digests()
    const memfsCommit = await memstore.head()
    const snap = {
      hash: hashPrompt(content, toolSchemas),
      content,
      memfsCommit,
      fileHashes,
      // ★ 记下这份 prompt 是用哪一版工具指南渲染的。Brain.ensureSnapshot() 靠它判断
      //   「会话里冻结的这版话术已经过期」，在回合边界重建一次（I3 的唯一显式例外）。
      guideVersion: GUIDE_VERSION,
      // ★ 人格指纹：切模式（local 下换人格但共用会话 id）靠它判断要不要重建快照。
      personaHash: hashPersona(persona),
      frozenAt: new Date().toISOString(),
    }
    log(`[snapshot] 渲染完成 hash=${snap.hash.slice(0, 18)}… commit=${memfsCommit.slice(0, 8) || '(none)'}`)
    return snap
  }

  /**
   * 对比「快照里的 fileHashes」和「仓库当前 digests」，返回变动文件的正文块。
   *
   * 只在内容真的不同时返回（改完又改回去 = 无漂移）。
   * 单块和总量都受 `memoryUpdateMaxBytes` 约束：**超了就让调用方去压缩，不要截断**。
   */
  async function drift(snapshot) {
    const now = await memstore.digests()
    const before = snapshot?.fileHashes ?? {}
    const changed = []
    for (const [path, digest] of Object.entries(now)) {
      if (before[path] === digest) continue
      changed.push(path)
    }
    for (const path of Object.keys(before)) {
      if (!(path in now)) changed.push(path)
    }
    if (changed.length === 0) return { changed: [], text: '', bytes: 0, overflow: false }

    const { updateMax } = budget()
    let text = ''
    for (const path of changed.sort()) {
      if (!(path in now)) {
        text += `<memory_update path="${path}" deleted="true" />\n`
        continue
      }
      const body = await memstore.read(path)
      const block = `<memory_update path="${path}">\n${String(body).trim()}\n</memory_update>\n`
      if (Buffer.byteLength(text + block, 'utf8') > updateMax) {
        return { changed, text, bytes: Buffer.byteLength(text, 'utf8'), overflow: true }
      }
      text += block
    }
    const bytes = Buffer.byteLength(text, 'utf8')
    log(`[snapshot] 漂移 ${changed.length} 个文件，${bytes}B`)
    return { changed, text, bytes, overflow: false }
  }

  return { capture, drift }
}
