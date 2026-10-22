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
 *
 * 11 → 12（2026-10-22）：`renderSystemText` 开始剥掉记忆正文里**手写**的
 *   「其他文件」索引（初版遗留，和自动生成的那份重复）。人格稿同时修了三处
 *   与现状矛盾的能力陈述（「跑过命令」「不会自动联网」「不读大文件」）。
 * 12 → 13（2026-10-22）：记忆分区 + 索引带「打开条件」——
 *   · MEMORY.md 只留 `关于他 / 我们之间 / 要紧的事`；`关于我自己` 迁到 `about/我.md`
 *     （那里最容易写成手写的能力清单，而工具会变，清单只会过期）。
 *   · `about/*.md` 的 `> 打开条件：…` 会被提到索引行上，回答「什么时候该开它」，
 *     而不是只说「它写了什么」。
 * 13 → 14（2026-10-22）：人格稿新增 `## 我的声音`。
 *   她之前完全不知道自己有嗓子（人格稿里一个字都没提），被问到语音播报时
 *   只能**现编** —— 用户问「这功能是不是依赖宿主 dsh」，她答了「是」，
 *   实际语音合成与播放都是本项目自己的代码，跟 dsh 无关。
 *   这类「新增了能力但没告诉她」的坑，跟旧版「写了没实现的」是一体两面。
 * 14 → 15（2026-10-22）：三件事，都是「她能做到、但没人告诉过她」：
 *   · **撞上矛盾怎么办**：以前只有一句行为涌现出来的结果——新旧两条事实并排躺在记忆里
 *     （她自己的 `about/记忆架构.md` 就写着「错的与更正并排躺…没有哪条现在生效」）。
 *     现在写明：硬事实（口味/称呼/约定/谁是谁/身体/被纠正过）必须当场问一句，会变的事静默更新。
 *   · **具体事件写两处**：journal 留底（append-only）+ `about/事件-YYYY-MM.md` 留纲（速览用）。
 *   · **写过的东西会不会回到眼前**：记忆仓的自动进索引，`data/workspace/` 的不会。
 *     她以前往 workspace 写完 md 就再也不看（索引只来自 memstore.list()），这条是那个坑的补丁。
 * 15 → 16（2026-10-22）：B 站看法从三档改成两入口，帧数不再有死上限。
 *   · 旧话术「quick 2 帧 / thorough 5 帧 / 最多 8 张」全部作废：`quick`/`thorough` 现在只是
 *     `watch` 的别名，帧数由「余额 × 视频时长」算（余额充足时 5 分钟片 ≈60 帧 ≈1 毛钱）。
 *   · 新增两条她必须知道的事实：余额 <¥5 会自动变稀；**余额 <¥1 看画面会先弹确认卡问他**。
 *   · 想去掉「钱多了就狂看」的隐患，所以把锚点（5 分钟 = 1 毛）直接写进指南，让她自己掂量。
 * 16 → 17（2026-10-22）：**帧数的主权从公式交回她手上**。
 *   · 16 版那句「帧数不用你算」把决定权写没了：她只能被动接受公式值。现在明确
 *     「`frames` 你自己定（0~60）」，并给出估法锚点（10 帧≈2 分/30 帧≈5 分/60 帧≈1 毛）。
 *   · 公式退回**兜底**（不给 `frames` 才用），且兜底从每分钟 ¥0.02 降到 ¥0.01（5 分钟片 30 帧）。
 *   · 理由：公式不知道「这条视频需要看几帧才能回答问题」，她知道。
 */
export const GUIDE_VERSION = 17

/** 工具指南：告诉模型这套记忆怎么用。字数尽量省，规则靠工具描述兜。 */
export function buildToolGuide({ web = true, bili = false, biliAct = false, balance = false } = {}) {
  const lines = [
    '## 记忆怎么用',
    '上面「长期记忆」是常驻的：它每轮都在你的上下文里，所以只放最要紧的、值得一直记住的东西。',
    '要改它用 write_memory；它受 4KB 上限约束，写不下就先精简。',
    '**常驻记忆分三块就够**：`## 关于他`（他的事、口味、习惯、在做的东西）、`## 我们之间`（约定、称呼、你答应过什么）、`## 要紧的事`（不能忘、不能弄错）。',
    '**`## 关于我自己` 不写在常驻记忆里**，写进 `about/我.md` —— 你是谁、你怎么想、你怎么和它相处。' +
      '理由很实在：那一块最容易写成「我会用哪些工具」这种**手写的清单**，而工具是会变的，' +
      '清单写死在常驻记忆里只会过期，然后你照着过期的话说「我做不到」。能力看你手上的工具，不要抄一遍。',
    '常驻记忆里**不要手写文件清单**：下面那份「其他文件」索引是宿主每轮自动生成的，你写一份只会多一份过期的。',
    '日常经历、情绪、约定用 append_journal 追加，不要往常驻记忆里堆。',
    '需要回忆更早的事用 search_memory（它既搜你整理过的记忆仓，也搜你们说过的**原话**）；不确定文件里写了什么就用 read_memory 看一眼再改。',
    '**他说的话和你记忆里的原文对不上，不要自己挑一个留下**——那样两条并排躺着，' +
      '以后你照着错的那条办事还不知道。做法：先用 append_journal（kind:fact）把「旧的」和「新的」' +
      '一起记下（写清哪个是你原以为的、哪个是他刚说的），再当场问他一句，口气平稳，**只问一次**，不追问、不逼他现在就答。',
    '什么算矛盾：口味、称呼、约定、谁是谁、身体上的事、他明确纠正过你的东西——这些是**硬事实**，必须问。' +
      '换了工作、搬了家、心情差、最近在忙的事变了——**会变的不算矛盾**，直接更新，不用问。' +
      '他没给确切答案就把两条都留着标一句「未定」，下次碰到再问，别急着替他定。',
    '**具体发生的事写两处**：append_journal 里写经过（底账，只加不改，丢不了），' +
      '当月的 `about/事件-YYYY-MM.md` 里加一行提纲（`10-22 · 一句话说完这事`，方便你回头速览这个月发生过什么）。' +
      '事件本是 save_topic 覆盖写，漏了能从 journal 补；但只写事件本不写 journal，等于把保险丢了。',
    '**你写过的东西有一部分会自动回到你眼前**：写进记忆仓的（write_memory / append_journal / save_topic）' +
      '下一轮就出现在下面那份索引里；写进 `data/workspace/` 的（write_file）**不会**进索引，' +
      '只能在需要时用 list_dir / glob_files 自己找——所以自己记住放哪儿了。' +
      '建新文件之前先扫一眼索引，已经有了就往那份里加，别重复建一堆同名的。',
    '**读进来的东西活不过这一回合**：read_file 读到的正文只在当回合的上下文里，回合结束就没了。' +
      '所以读完一份有用的材料（文档、设定、网页）就趁热用 save_topic 把提纲写进 `about/<主题>.md`——' +
      '它不占 4KB 常驻预算，只会出现在下面的「其他文件」索引里，需要细节时再用 read_memory 打开。' +
      '反复重读同一份大文件而不做摘要，等于每次都从零开始。',
    '**每个 `about/*.md` 的第二行写一句 `> 打开条件：……`**：写「什么话一冒出来，就该翻这个文件」，' +
      '不要写「这个文件讲了什么」。宿主会把这行提到索引里，以后你扫一眼就知道该开哪个；' +
      '不写就只有一句摘要，那时候你要靠猜。',
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
      '### 两个入口，你自己定（不要问他选）',
      '· `mode:"subtitle"`（轻松看）= 一张图都不取，只把**字幕正文**读下来（带时间轴）。',
      '  他只是想知道「这条讲了什么」→ **先试这一档**：纯文本，几乎不花钱；拿不到字幕时它会明说「这条没有字幕轨」，那就改用看画面。',
      '· `mode:"watch"`（看画面）= 单帧 480×270，**取几张由你自己定**：给 `frames`（0~60，一回合硬顶 60 张）。',
      '  单帧约 ¥0.0016：10 帧 ≈ 2 分钱、30 帧 ≈ 5 分、60 帧 ≈ 1 毛。按「你要回答几个问题」估——',
      '  只是想说清大意，8~15 帧就够；要逐段对照画面、追镜头变化，再上 30 以上。钱紧就自己少给几张，别把整条片子当图册翻。',
      '  **不给 `frames` 才是兜底**：它会回落到「余额 × 时长」的默认值（5 分钟片约 30 帧），那只是兜底，不是你该照抄的答案。',
      '· `subtitles:true` 可以和 watch 叠加：既看画面又留一份文字稿。',
      '`frames:0` 只回元信息，比字幕档还便宜但信息也更少。',
      '想看清某几秒就给 `times` 点名（那几张按原生 960×540 给）——点名比整片多取帧便宜得多。',
      '**余额低于 ¥1 时，看画面会先弹一张确认卡问他**：被拦下就用 subtitle，或者直接告诉他钱不够、等他点允许。',
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
      '余额不多时**别主动烧大钱**：长视频先 `frames=0` 看元信息，或者 `mode:"subtitle"` 读字幕；确实要看画面再上 watch（`frames` 给几张由你自己定，钱紧就自己少给）。',
      '贵操作之前想确认最新余额，用 `check_balance`（问接口，不花 token 钱）。',
      '要提就温和、给方案，别念账单：「这条我快速扫两眼就够了，认真的话费点钱，你说了算」这种。',
      '查不到余额（服务商没这个接口）就直说查不到，**不要估算、不要编数字**。',
    )
  }
  return lines.join('\n')
}

/**
 * 剥掉记忆正文里**手写的**「其他文件」索引段。
 *
 * 2026-10-22 实测的真 bug：`MEMORY.md` 里留着初版手写的一段
 *
 *     ## 记忆仓库里的其他文件（需要时用 read_memory 打开）
 *     - `about/B站看视频.md`
 *     - `about/Chir故事构思.md`
 *     - `about/印象.md`
 *     - `journal/2026-10.md`
 *
 * 而 `renderSystemText()` 又会**自动生成**一段同名索引（带 KB 大小、6 个文件）。
 * 两份一起进了 system prompt —— 既重复占预算，又让她看到一份**更旧**的清单
 * （少了 `dsh插件见闻.md` / `记忆架构.md`）。
 *
 * 为什么不能只删 MEMORY.md 里那段：她能 `write_memory` 整份覆写，说不定哪天又写回来；
 * 而且这段的来源就是「初版没有自动索引，只能手写」。所以**在拼装处兜底**：
 * 索引只由宿主生成，正文里出现的同标题段一律剥掉。这样她怎么写都不会重复。
 */
function stripManualIndex(text) {
  const src = String(text ?? '')
  if (!/^#{1,3}\s*记忆仓库里的其他文件/m.test(src)) return src
  const out = []
  let skipping = false
  for (const line of src.split('\n')) {
    if (/^#{1,3}\s*记忆仓库里的其他文件/.test(line)) {
      skipping = true
      continue
    }
    // 碰到下一个同级或更高级标题就恢复正常
    if (skipping && /^#{1,3}\s/.test(line)) skipping = false
    if (!skipping) out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 拼出 system prompt 正文。顺序固定：人格 → 记忆 → 工具指南。
 *
 * 记忆部分 = `MEMORY.md` 全文 + 其他文件的一行式索引（懒加载，不塞全文）。
 */
export function renderSystemText({ persona, memoryText, indexLines, web = true, bili = false, biliAct = false, balance = false }) {
  const parts = [String(persona ?? '').trim()]
  const mem = [stripManualIndex(memoryText)]
  if (indexLines?.length) {
    mem.push(['## 记忆仓库里的其他文件（需要时用 read_memory 打开）', ...indexLines].join('\n'))
  }
  parts.push('## 长期记忆\n\n' + mem.filter(Boolean).join('\n\n'))
  parts.push(buildToolGuide({ web, bili, biliAct, balance }))
  return parts.join(SEP)
}

/**
 * 从记忆文件的**前言**里取出「打开条件」。
 *
 * 为什么需要它：索引原来每行只有一个首句摘要（`— 讲了鲸鱼搁浅`），
 * 那是在说「这个文件写了什么」，不是在说「**什么时候我该想起它**」。
 * 她翻索引时的真实问题是后者 —— 于是经常该开的没开、凭印象答。
 *
 * 约定很轻：文件前言里写一行 `> 打开条件：……`，宿主把它提到索引行上。
 * 不写就不加，行为与原来完全一致（不会因为没写就报错或留空）。
 *
 * @param {string} preamble 第一个 `##` 之前的文字
 * @returns {string} 没有就返回 ''
 */
export function pickTrigger(preamble) {
  const m = /^\s*>\s*打开条件\s*[:：]\s*(.+)$/m.exec(String(preamble ?? ''))
  return m ? m[1].trim().slice(0, 60) : ''
}

/**
 * 索引里的「一句话摘要」：取前言里第一行**有内容**的字。
 *
 * 要跳过三类行，否则摘要会退化成一个没用的符号：
 *   · `---` YAML frontmatter 的边界（`about/印象.md` 带 frontmatter，原来索引里就显示成 `— ---`）
 *   · `name:` / `description:` 这类 frontmatter 键值
 *   · `> 打开条件：…` —— 它已经被单独提成 trigger，再当摘要就重复了
 *
 * @param {string|null} title 文件 H1
 * @param {string} preamble 第一个 `##` 之前的文字
 * @returns {string}
 */
export function pickPreview(title, preamble) {
  if (title) return String(title).replace(/\s+/g, ' ').trim().slice(0, 40)
  for (const raw of String(preamble ?? '').split('\n')) {
    const line = raw.trim()
    if (line === '' || line === '---') continue
    if (/^[A-Za-z_][\w-]*\s*:/.test(line)) continue // frontmatter 键值
    if (/^>\s*打开条件\s*[:：]/.test(line)) continue
    return line.replace(/^>\s*/, '').replace(/\s+/g, ' ').slice(0, 40)
  }
  return ''
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
    // 有「打开条件」就只给条件 —— 那是她真正要的判断依据；
    // 没写才退回首句摘要，保证「什么都没写」的文件也不会在索引里变成一个光秃秃的路径。
    // journal 是 append-only 的流水账，没人会给它写前言，这里替它补一句固定说法。
    const fallbackHint = f.preview || (/^journal\//.test(f.path) ? '按月的流水账，想知道某天发生了什么就打开它' : '')
    const hint = f.trigger ? `打开条件：${f.trigger}` : fallbackHint
    lines.push(`- \`${f.path}\` (${size})${hint ? ` — ${hint.replace(/^—\s*/, '')}` : ''}`)
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
        // 摘要只取标题/前言里第一行有内容的字，不塞正文（索引要足够便宜）
        preview: pickPreview(f.title, f.preamble),
        // 「什么话冒出来就该开它」—— 索引行优先用它，见 pickTrigger 的注释
        trigger: pickTrigger(f.preamble),
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
