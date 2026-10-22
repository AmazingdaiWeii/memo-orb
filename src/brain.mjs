/**
 * brain.mjs · 会话循环（新引擎的「大脑」）
 *
 * 组装请求（冻结的 system 快照 + 历史 + 本轮输入）→ 流式 → 工具循环 → 结束。
 *
 * ★ 四条不许破的约定：
 *   1. **结束条件**只看「模型不再调工具且内容流已结束」，不看 stop_reason
 *      （实测 stop_reason 比真正结束早到 10~12 秒，中间发的东西会被静默丢弃）。
 *   2. **system prompt 字节稳定**：优先用会话里已存的快照；只有新会话 / 压缩 / 手动 rebuild
 *      才重新渲染。记忆在会话中途变了 → 作为 `<memory_update>` 追加到**本轮用户消息尾部**。
 *   3. **回合结束信号只有一个**：`finally` 里调 `onTurnIdle()`（= main 的 onLoopIdle）。
 *      这里自己放队列、自己改 turnInFlight 都是错的。
 *   4. 工具事件**必须带 id**，否则球侧 `tool:${id}` 拼不成一个块。
 *
 * 事件契约（映射到球侧 putBlock kind）：
 *   user | assistant | reasoning | tool | notice | done | usage
 */

import { isBlockedMemoryPath, searchConversations } from './memory.mjs'
import { createRecall } from './recall.mjs'
import { estimateContextTokens, pickBoundary, summarizeMessages } from './compact.mjs'
import { hashPrompt, hashPersona, GUIDE_VERSION } from './snapshot.mjs'
import { readAnyFile, writeAnyFile, listAnyDir, globFiles, displayPath } from './files.mjs'
import { parseWhen, describeWhen, describeNow } from './schedule.mjs'
import { formatMoney } from './balance.mjs'
import { existsSync } from 'node:fs'

const JOURNAL_KINDS = ['fact', 'feel', 'promise', 'growth', 'compact']

/**
 * 一回合最多把几张工具抓来的图塞进上下文。
 * 单张 480×270 关键帧约 300 视觉 token、30~60KB base64；2026-10-22 用户拍板从 8 提到 60，
 * 理由是「只看五帧等于没看」。60 张 ≈ 两万视觉 token，一回合只发一次（见下方 imageSink 守卫）。
 * ★ 必须和 `bili-watch.mjs` 的 `MAX_FRAMES` 保持一致，否则取回来的图会被这里悄悄砍掉。
 */
const MAX_TOOL_IMAGES = 60


/** 记忆文件的允许后缀/形态：只收 markdown 类文本，避免把二进制/脚本写进记忆仓。 */
function normalizeMemoryPath(raw) {
  const path = String(raw ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!path) throw new Error('path 不能为空')
  if (isBlockedMemoryPath(path)) throw new Error(`不允许写这个路径: ${path}`)
  if (!/\.(md|txt|json|jsonl)$/i.test(path)) throw new Error('记忆文件只允许 .md / .txt / .json / .jsonl')
  return path
}

// ── 工具定义 ─────────────────────────────────────────────

/**
 * 工具 schema。★ 检索规则写进 `search_memory` 的描述里（设计文档 §4）：
 * 模型看不到我们的代码，只看得见这段文字，规则不写这儿就等于没写。
 *
 * @param {{web?: boolean, bili?: boolean}} [o] web=false 时不给联网工具 —— 那时工具列表里没有它们，
 *        指南里也不能提（否则她会去调一个不存在的工具）。两处由同一份 `hasWeb` 驱动。
 *        bili 同理：没有 B 站登录/取帧能力时，`bili_watch` 不存在，指南里也不提。
 */
export function buildTools({ web = false, bili = false, biliHistory = false, biliAct = false, balance = false } = {}) {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'write_memory',
        description:
          '覆盖写一个记忆文件（原子写 + git 提交，立刻生效）。' +
          '`MEMORY.md` 是常驻记忆：它每轮都会被全文注入你的上下文，所以只放最要紧、值得一直记住的事（上限 4KB）。' +
          '长期累积的经历/情绪不要往 MEMORY.md 里堆，用 append_journal。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对路径，例如 MEMORY.md 或 about/偏好.md' },
            content: { type: 'string', description: '完整的新内容（会整体覆盖旧文件）' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_memory',
        description: '读取一个记忆文件的全文。改之前先读，别凭印象覆盖。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对路径，例如 journal/2026-10.md' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_memory',
        description:
          '全文搜索**两个地方**：记忆仓（你自己整理过的文件）和对话仓（你们说过的原话）。' +
          '什么时候用：想起某件事但不确定写在哪、要确认「我是不是记过这个」、他提到旧事时先查再答。' +
          '返回里 source=memory 的是记忆仓命中（带文件路径和行号，可用 read_memory 打开看全文）；' +
          'source=conversation 的是原话命中（带时间、说话人和上下文一小段）——' +
          '你整理过的记忆可能是转述、可能有偏差，原话才是当时到底怎么说的。' +
          '怎么用：用具体的名词/名字/短语查（例如「抹香鲸」「生日」「加班」「讨厌香菜」），不要用「以前的事」这种空词；' +
          '一次查不到就换一个更具体的词再查，不要凭印象编。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '具体的关键词或短语' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'append_journal',
        description:
          '往当月 journal 追加一条记录（append-only，永不覆盖）。' +
          '适合：今天发生了什么、他说的某句话让你有什么感觉、你们约好了什么、你自己想通了什么。' +
          '这是你留给以后的自己的东西，用第一人称写，可以短。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要记的内容，第一人称，几句话即可' },
            kind: {
              type: 'string',
              enum: JOURNAL_KINDS,
              description: 'fact=事实 / feel=情绪 / promise=约定 / growth=变化 / compact=压缩备忘（一般不用手动填）',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: '可选标签，便于以后检索',
            },
          },
          required: ['text'],
        },
      },
    },
    // ── 主题记忆槽：about/<主题>.md ──
    // 为什么需要它：read_file 读进来的正文**只在当前回合活着**，回合结束就没了
    // （工具结果不落盘，只落 user/assistant 正文）。28 万字的小说讨论文档读十次
    // 也留不下印象，唯一能活下来的是「读完之后自己写下的提纲」。
    // 不往 MEMORY.md 里塞：那 4KB 是常驻预算，塞满就挤掉别的东西；这里写的文件
    // 只占系统提示里的一行索引（`src/snapshot.mjs:126 buildIndexLines`）。
    {
      type: 'function',
      function: {
        name: 'save_topic',
        description:
          '把一个主题的长期资料写成 `about/<主题>.md`（新建或整体覆盖，自动提交）。' +
          '什么时候用：你 read_file 读了一大段材料（小说设定、项目文档、长网页），' +
          '或者他反复跟你聊同一件事 —— 把它压成 1~3KB 的提纲存进来：' +
          '这份材料是什么、关键设定/结论/人物、以及他明确说过的偏好。' +
          '为什么必须存：原文只在这一回合的上下文里，回合结束就没了；只有写进记忆仓的东西活得下去。' +
          '存好之后它的路径会出现在系统提示的「记忆仓库里的其他文件」索引里，需要细节时用 read_memory 打开。',
        parameters: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description: '主题名，会成为文件名，例如「小说设定」「工作安排」。不要带 .md、不要带斜杠',
            },
            content: {
              type: 'string',
              description: '完整的提纲内容（整体覆盖 about/<主题>.md）。用 markdown 小标题分段',
            },
          },
          required: ['topic', 'content'],
        },
      },
    },
    // ── 下面四个是「手」：读全盘、写限白名单、找文件 ──
    {
      type: 'function',
      function: {
        name: 'read_file',
        description:
          '读一个文本文件。' +
          'path 可以是绝对路径（例如 `docs/设计.md`、`D:/照片/说明.txt`），' +
          '也可以是相对 data/workspace/ 的路径。**读取不用他确认**，直接读。' +
          '大文件用 offset/limit 按行分段读（offset 从 1 开始算第几行）；' +
          '单次上限约 256KB，超了会报错告诉你怎么办。' +
          '私钥、浏览器密码、provider key 这类路径读不到（命中隐私黑名单会被挡，别试第二次）。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '绝对路径或相对 data/workspace/ 的路径' },
            offset: { type: 'number', description: '从第几行开始读（1 起），不给就是从头' },
            limit: { type: 'number', description: '读多少行，不给就是一整个文件（≤2000 行）' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description:
          '新建或整体覆盖一个文本文件（父目录自动建）。' +
          '在 data/workspace/ 里**新建**文件不用问；**覆盖已存在的文件、或者写到 workspace 外面**，' +
          '都会弹一张确认卡给他，他点了允许才落盘。' +
          '写是不可逆的（没有 delete_file，也没有 undo）：覆盖前先 read_file 看一眼原内容。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '绝对路径或相对 data/workspace/ 的路径' },
            content: { type: 'string', description: '完整的新内容（整体覆盖，不是追加）' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description:
          '列一个目录里有什么（默认只列一层；目录名带尾斜杠）。' +
          '不知道文件在哪、或者想确认刚才写的落没落地时先用它看。' +
          '绝对路径或相对 data/workspace/ 都可以；不用他确认。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '绝对路径或相对路径，"." 表示 data/workspace/' },
            recursive: { type: 'boolean', description: '是否递归往下列（最多 4 层）' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'glob_files',
        description:
          '按文件名找文件，返回路径和大小。glob 记法：`*` 段内任意、`**` 任意层级、`?` 单字符。' +
          '例：`**/*.md`、`docs/**/*.pdf`、`*.log`。' +
          'root 不给就相对 data/workspace/，也可以给绝对路径（如 `D:/照片`）。' +
          '不用他确认；会自动跳过 .git / node_modules，最多给 200 条。',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'glob，例如 **/*.md' },
            root: { type: 'string', description: '从哪个目录开始找，默认 data/workspace/' },
          },
          required: ['pattern'],
        },
      },
    },
    // ── 闹钟：到点由宿主自己说出来，不再跑模型 ──
    {
      type: 'function',
      function: {
        name: 'set_reminder',
        description:
          '排一条提醒。到点之后**宿主会直接把你写的 what 原样说出来**（不会再跑一次模型、' +
          '也不会再问你一遍），所以 what 要写成一句**能直接说出口的话**，' +
          '比如「该起来喝口水啦，坐了快两小时了」——不要写成「提醒他喝水」这种给系统看的备注。' +
          'when 用本机时间：`21:30`（今天，过了就算明天）、`+30m`、`+2h`、`10-21 09:00`、' +
          '`2026-10-21 09:00`。**不要自己换算 UTC**，也不要说「明天早上」——那是猜，猜错就是半夜响。' +
          '排的时候说一句「好，我记着了」，不要把它当成了已经做完的事。',
        parameters: {
          type: 'object',
          properties: {
            when: { type: 'string', description: '什么时候，如 "21:30"、"+30m"、"10-21 09:00"' },
            what: { type: 'string', description: '到点要说的那句话本身（可直接说出口，≤500 字）' },
            where: {
              type: 'string',
              enum: ['all', 'desktop', 'wechat'],
              description: '在哪说：all（默认，桌面和微信都说）、desktop、wechat',
            },
          },
          required: ['when', 'what'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_reminders',
        description:
          '看还有哪些提醒排着、什么时候说。他问「你还记得我要干什么吗」「我等下有什么事」时用它，' +
          '**不要凭印象答**。不用他确认。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'cancel_reminder',
        description:
          '取消一条还没说的提醒。id 可以只给前几位（唯一就行）。已经说过的取消不了。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'list_reminders 给的 id，前缀即可' } },
          required: ['id'],
        },
      },
    },
  ]

  // ── 眼睛：联网检索。★ 不需要审批（只读外网，不碰他的文件）──
  if (web) {
    tools.push(
      {
        type: 'function',
        function: {
          name: 'search_web',
          description:
            '联网搜索，返回若干条结果的标题、网址和摘要。' +
            '什么时候用：任何会变的事实（最新版本、价格、有没有发布、谁说了什么）——' +
            '以及你自己拿不准的事。你的记忆可能过期，网上的是当下的。' +
            '怎么用：query 写具体的关键词，不要写整句问句；可以用 `site:域名` 限定站点、' +
            '`-词` 排除、`"短语"` 精确匹配。摘要够用就别再去抓全文。',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: '关键词，1~128 字' },
              count: { type: 'number', description: '要几条，1~50，默认 5' },
              need_content: { type: 'boolean', description: '是否连正文一起要（更大更慢，一般不用）' },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'fetch_url',
          description:
            '打开一个网页，返回正文（Markdown，最多约 4 万字）。' +
            '只在 search_web 的摘要不够、需要看原文细节时用；不要一上来就抓。',
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'http/https 网址' },
            },
            required: ['url'],
          },
        },
      },
    )
  }

  // ── B 站：认片 + 取关键帧。★ 只读外网，不走审批；取帧是重活，描述里写清成本 ──
  if (bili) {
    tools.push({
      type: 'function',
      function: {
        name: 'bili_watch',
        description:
          '看一条 B 站视频。两个入口，**由你按需要自己挑，别让用户选**：\n' +
          '· `mode:"subtitle"`（轻松看）= 不取一张图，只把**字幕正文**读下来（带时间轴）。' +
          'B 站自带 AI 字幕，覆盖大多数热门片，纯文本几乎不花钱 —— **想知道「讲了什么」先用它**。' +
          '拿不到字幕时它会明说「这条没有字幕轨」，这时再改用看画面。\n' +
          '· `mode:"watch"`（看画面）= 帧数**不用你算**：工具自己按「余额 × 视频时长」定，单帧 480×270，一回合最多 60 帧。' +
          '锚点：余额充足时一部 5 分钟的片子约 60 帧、约 1 毛钱；余额低于 5 块会自动变稀。' +
          '`subtitles:true` 可以和 watch 叠加（既看画面又要字幕）。\n' +
          '结果第一行会写清这次是不是用了用户本人登录的 B 站账号（且是否刚向 B 站核实过）与实际画质——照那行说，别自己猜「我有没有登录」。' +
          '什么时候用：他发来 B 站链接让你「看这个视频」「这段讲了什么」「封面/画面里是什么」。' +
          '怎么用：url 直接给他发的整条链接就行（BV 号也行），多 P 记得 page。' +
          '**先 frames=0 看元信息或先 subtitle 读字幕**（都极便宜）；确定要看画面就给 mode:"watch"，不用猜该取几张。' +
          '余额低于 1 块时，看画面会先弹审批卡问到用户；被拦下就退到 subtitle，或者直接说明钱不够。' +
          '只看字幕 = 只是读了文字稿，你没看见画面；只看关键帧也不等于看完全片 —— 别声称「我看完了整段」，要说清你依据的是字幕还是哪几个时间点的画面。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'BV 号 / av 号 / 整条 bilibili 链接' },
            page: { type: 'number', description: '分 P 序号，默认从链接的 ?p= 读，再不然 1' },
            mode: {
              type: 'string',
              enum: ['subtitle', 'watch'],
              description:
                '看法档位：subtitle=只读字幕不取图（最省，先试它）/ watch=看画面（帧数按余额和时长自动算，480×270，最多 60 帧）。不给就不取帧。',
            },
            subtitles: {
              type: 'boolean',
              description: '顺带把字幕也读下来（任意档位可叠加）。mode:"subtitle" 时自动为 true，不用再给。',
            },
            frames: { type: 'number', description: '取几张关键帧，0 = 只看元信息；给了就压过自动算出来的帧数，上限 60' },
            times: {
              type: 'array',
              items: { type: 'number' },
              description: '指定秒数（会吸附到最近的关键帧，单张按原生 960×540 给），例如 [12, 45.5]；给了就忽略自动算出来的数量',
            },
            liked: {
              type: 'boolean',
              description:
                '**你自己**看完觉得这条值得，就设 true —— 它会进你那个「我喜欢的」栏（配 reason 写一句为什么）。' +
                '这不是替用户点赞、也不会发到 B 站，只是你自己的一笔偏好记录。没感觉就别设。',
            },
            reason: {
              type: 'string',
              description: '为什么喜欢（一句话，你自己写）。只在 liked:true 时有意义；别编画面里没有的东西。',
            },
          },
          required: ['url'],
        },
      },
    })
  }

  // ── B 站：她自己的浏览记录（只读本地账本，不联网、不花钱）──
  if (bili && biliHistory) {
    tools.push({
      type: 'function',
      function: {
        name: 'bili_history',
        description:
          '读你自己在 B 站看过什么的账本（本地记录，不联网、不花钱）。' +
          '什么时候用：他说「你上次看的那个视频」「刚才那个片子」而你记不清；' +
          '或者你想接着看/对比几条看过的视频。' +
          '返回最新的在前，每条带标题、看的时间、画质、你看过的那几个时间点、看过几次。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '要几条，默认 10，上限 50' },
          },
        },
      },
    })
  }

  // ── B 站：真的去点「赞 / 币 / 藏」（写接口，会动他的账号）──
  if (biliAct) {
    tools.push({
      type: 'function',
      function: {
        name: 'bili_act',
        description:
          '替他在 B 站上真的点一下：`like` 点赞 / `coin` 投币 / `fav` 收藏到默认收藏夹。' +
          '这三个都会**真的写进他本人的 B 站账号**（和他在抽屉里点按钮完全一样）。' +
          '什么时候用：他说「帮我把这条投个币」「这条收藏一下」「给他点个赞」时。' +
          '**投币要花他账户里的硬币**：一枚 = 1 币，一次最多两枚；他没明说「投币/给两个币」就别投，' +
          '想看成本就先问一句「投一枚还是两枚」。' +
          '`bvid` 给 BV 号即可（账本里能查到的那条就不用再给 cid）。' +
          '**发评论不在这个工具里**：公开发言一定要他本人看过文本再点头。' +
          '结果里 `ok:false` 时把 `error` 原样告诉他，别自己编理由 —— ' +
          'B 站有时会拒绝给某条稿件投币（`code:-401` 非法访问），这种就是说「这条不让投」，' +
          '不是你没登录、也不是网络问题。',
        parameters: {
          type: 'object',
          properties: {
            bvid: { type: 'string', description: 'BV 号（例如 BV1fUqdBmEc2）' },
            action: {
              type: 'string',
              enum: ['like', 'coin', 'fav'],
              description: 'like=点赞 / coin=投币（花钱）/ fav=收藏到默认收藏夹',
            },
            count: { type: 'number', description: '只对 coin 有意义：投几枚（1 或 2），默认 1' },
          },
          required: ['bvid', 'action'],
        },
      },
    })
  }

  // ── 钱：查这个账户还剩多少（只读服务商，不花钱）──
  if (balance) {
    tools.push({
      type: 'function',
      function: {
        name: 'check_balance',
        description:
          '查这个账户里还剩多少钱（问服务商的余额接口，不花 token 钱）。' +
          '每轮开头你已经能看到一个余额快照，所以**平时不必调**；' +
          '要在贵操作之前确认（比如想认真看一条长视频），或者刚花完一大笔想复核，再调它拿最新值。' +
          '查不到（服务商没这个接口）就如实说查不到，不要估算、不要编数字。',
        parameters: { type: 'object', properties: {} },
      },
    })
  }

  return tools
}

// ── 工具执行器 ───────────────────────────────────────────

/**
 * 执行一个工具调用，返回字符串结果。
 * 工具失败必须让模型知道（转成 `{ok:false,error}`），而不是把整个回合炸掉。
 */
/**
 * 写文件前的确认闸门：先问人，再动手。
 *
 * 三种「没放行」都要当成**他的选择**告诉模型，而不是报错让它重试 ——
 * 否则它会换个说法反复骚扰（历史经验：确认框弹不出来时它会一直重试到回合卡死）。
 *
 * 2026-10-20 P2 起：只有**白名单外写**和**覆盖已存在文件**才走这里（新建免问）。
 */
async function askApproval({ name, args, approve, log, reason }) {
  if (typeof approve !== 'function') {
    return { ok: false, payload: { ok: false, error: '审批通道没接上（宿主没提供 approve），这次不执行' } }
  }
  let verdict
  try {
    verdict = await approve({ toolName: name, args, reason })
  } catch (err) {
    log(`[brain] 审批异常 ${name}: ${err.message}`)
    return { ok: false, payload: { ok: false, error: `审批过程出错（${err.message}），这次不执行` } }
  }
  if (verdict?.approved !== true) {
    log(`[brain] 审批未放行 ${name}: ${verdict?.reason ?? ''}`)
    return {
      ok: false,
      payload: {
        ok: false,
        denied: true,
        error:
          `他没有放行这次 ${name}（${verdict?.reason || '没说明'}）。` +
          '这是他的选择，不是程序出错：不要重试，也不要换个写法绕过去。' +
          '如果这件事确实要做，先在正文里说清楚你要动哪个文件、为什么。',
      },
    }
  }
  return { ok: true }
}

async function executeTool(
  { name, args },
  { memstore, settings, log, approve, web, bili, biliHistory, balance, collect, policy, schedule, agentId, now = Date.now },
) {
  try {
    switch (name) {
      case 'write_memory': {
        const path = normalizeMemoryPath(args?.path)
        const content = args?.content
        if (typeof content !== 'string') {
          return JSON.stringify({ ok: false, error: 'content 必须是字符串' })
        }
        if (path === 'MEMORY.md') {
          const limit = settings.get().memorySoftLimitBytes
          const bytes = Buffer.byteLength(content, 'utf8')
          if (bytes > limit) {
            return JSON.stringify({
              ok: false,
              error:
                `MEMORY.md 现在 ${bytes}B，超过常驻上限 ${limit}B。` +
                '它每一轮都会被全文注入，太长了会挤掉对话本身。' +
                '请先精简（删掉过时的、把细节挪到 journal），再写一次。',
            })
          }
        }
        const result = await memstore.write(path, content, 'tool')
        log(`[brain] write_memory ${path} (${Buffer.byteLength(content, 'utf8')}B) changed=${result.changed !== false}`)
        // changed=false 表示盘上内容与已提交版本一字不差（她常整篇重写），
        // 这不是失败，但必须回一句显式说明 —— 否则她会以为「没写进去」。
        return JSON.stringify(
          result.changed === false
            ? { ok: true, path, sha: result.sha, changed: false, message: '内容与已保存的一致，没有产生新提交' }
            : { ok: true, path, sha: result.sha, changed: true, message: '已写入并提交' },
        )
      }
      case 'read_memory': {
        const path = normalizeMemoryPath(args?.path)
        const content = await memstore.read(path)
        if (content === null) return JSON.stringify({ ok: false, error: `文件不存在: ${path}` })
        return JSON.stringify({ ok: true, path, content })
      }
      case 'search_memory': {
        const query = String(args?.query ?? '').trim()
        if (!query) return JSON.stringify({ ok: false, error: 'query 必填' })
        // 2026-10-22：记忆仓 + 对话仓一起搜。
        //   记忆仓排前面 —— 那是她自己写下的结论，比一段二手原话更可能是她要的。
        //   对话仓失败绝不连累记忆仓（一个坏文件不该让整个检索报错）。
        //   ★ agentId 必须从 **参数** 拿：executeTool 是模块级函数，没有 this。
        //     这里曾经写成 `this.agentId`（= undefined），前缀变成
        //     `conversation:local-undefined` ⇒ 一条都搜不到且不报错，只是安静地少一半结果。
        const fileHits = (await memstore.search(query)).slice(0, 12)
        let talkHits = []
        try {
          if (agentId) talkHits = searchConversations(agentId, query, { limit: 8 })
        } catch (err) {
          log(`[brain] 对话仓检索失败（记忆仓结果照常返回）：${err.message}`)
        }
        const hits = [...fileHits.map((h) => ({ source: 'memory', ...h })), ...talkHits]
        return JSON.stringify({
          ok: true,
          query,
          count: hits.length,
          hits,
          ...(hits.length === 0
            ? { hint: '两个仓都没命中。换个更具体的词（人名/地名/物件名/原话里的某个词）再查一次，别直接说「我不记得」。' }
            : {}),
        })
      }
      case 'append_journal': {
        const text = String(args?.text ?? '').trim()
        if (!text) return JSON.stringify({ ok: false, error: 'text 必填' })
        const kind = JOURNAL_KINDS.includes(args?.kind) ? args.kind : 'fact'
        const tags = Array.isArray(args?.tags) ? args.tags.map((t) => String(t)).slice(0, 8) : []
        const r = await memstore.appendJournal({ text, kind, tags })
        log(`[brain] append_journal ${r.path} (${r.bytes}B)`)
        return JSON.stringify({ ok: true, path: r.path, sha: r.sha })
      }
      case 'save_topic': {
        const raw = String(args?.topic ?? '').trim()
        // 文件名净化：Windows 非法字符 + 路径分隔符 + 结尾 .md 都去掉。
        const topic = raw
          .replace(/[\\/:*?"<>|]/g, '')
          .replace(/\.md$/i, '')
          .replace(/^[.\s]+|[.\s]+$/g, '')
          .slice(0, 40)
        if (topic === '') return JSON.stringify({ ok: false, error: 'topic 必填（主题名会成为文件名）' })
        const content = args?.content
        if (typeof content !== 'string' || content.trim() === '') {
          return JSON.stringify({ ok: false, error: 'content 必填' })
        }
        const path = normalizeMemoryPath(`about/${topic}.md`)
        const r = await memstore.write(path, content, 'tool')
        log(`[brain] save_topic ${path} (${Buffer.byteLength(content, 'utf8')}B) changed=${r.changed !== false}`)
        return JSON.stringify({
          ok: true,
          path,
          sha: r.sha,
          changed: r.changed !== false,
          message:
            r.changed === false
              ? '内容与已保存的一致，没有产生新提交'
              : `已存进 ${path}；以后用 read_memory 就能读到，索引里也会出现它`,
        })
      }
      // ── 手：读全盘免审批、写按三级策略、找文件免审批 ──
      case 'read_file': {
        if (!policy) return JSON.stringify({ ok: false, error: '文件工具没接上（宿主没提供 policy），这次读不了' })
        const r = await readAnyFile(args?.path, { policy, offset: args?.offset, limit: args?.limit })
        log(`[brain] read_file ${r.path} (${r.bytes}B${r.sliced ? ` 行 ${r.lines}` : ''})`)
        // ★ 提醒她「这段正文活不过这一回合」：工具结果不落盘（只有 user/assistant 正文落盘），
        //   所以读完不写提纲 = 白读。只在「大文件/切片读」时提，小文件别打扰。
        const big = r.sliced === true || r.truncated === true || r.bytes > 20_000
        return JSON.stringify({
          ok: true,
          path: r.path,
          bytes: r.bytes,
          lines: r.lines,
          truncated: r.truncated,
          text: r.text,
          ...(big
            ? {
                hint:
                  '这份材料很大（这次是切片读的）。注意：工具读到的正文只在当前回合有效，' +
                  '回合结束就从上下文里消失了。如果它对以后有用，趁现在用 save_topic 把它压成提纲存下来（about/<主题>.md）；' +
                  '只会一遍遍重读同一份大文件是浪费。',
              }
            : {}),
        })
      }
      case 'write_file': {
        if (!policy) return JSON.stringify({ ok: false, error: '文件工具没接上（宿主没提供 policy），这次写不了' })
        if (typeof args?.content !== 'string') {
          return JSON.stringify({ ok: false, error: 'content 必须是字符串' })
        }
        const abs = policy.resolveInput(args?.path)
        const exists = existsSync(abs)
        const verdict = policy.writeVerdict(abs, { exists })
        if (verdict.mode === 'deny') {
          log(`[brain] write_file 拒绝 ${displayPath(abs)}（${verdict.reason}）`)
          return JSON.stringify({ ok: false, error: verdict.reason })
        }
        if (verdict.mode === 'ask') {
          const gated = await askApproval({
            name,
            args: { ...args, path: displayPath(abs) },
            approve,
            log,
            reason: verdict.reason,
          })
          if (!gated.ok) return JSON.stringify(gated.payload)
        }
        const r = writeAnyFile(abs, args.content, { policy })
        log(`[brain] write_file ${r.path} (${r.bytes}B) created=${r.created} [${verdict.mode}]`)
        return JSON.stringify({
          ok: true,
          path: r.path,
          bytes: r.bytes,
          created: r.created,
          message: r.created ? '新建并写入' : '已整体覆盖',
        })
      }
      case 'list_dir': {
        if (!policy) return JSON.stringify({ ok: false, error: '文件工具没接上（宿主没提供 policy），这次看不了' })
        const r = listAnyDir(args?.path ?? '.', { policy, recursive: args?.recursive === true })
        log(`[brain] list_dir ${r.path} → ${r.entries.length} 项`)
        return JSON.stringify({
          ok: true,
          path: r.path,
          count: r.entries.length,
          truncated: r.truncated,
          entries: r.entries,
        })
      }
      case 'glob_files': {
        if (!policy) return JSON.stringify({ ok: false, error: '文件工具没接上（宿主没提供 policy），这次找不了' })
        const r = globFiles(args?.pattern, { policy, root: args?.root })
        log(`[brain] glob_files ${r.pattern} @ ${r.root} → ${r.count} 个（看过 ${r.visited} 项）`)
        return JSON.stringify(r)
      }
      // ── 闹钟：宿主侧定时，到点不跑模型（见 src/schedule.mjs）──
      case 'set_reminder': {
        if (!schedule) return JSON.stringify({ ok: false, error: '闹钟没接上（宿主没提供 schedule），这次排不了' })
        const at = parseWhen(args?.when, { now })
        const item = schedule.add({
          when: at.toISOString(),
          text: args?.what,
          channel: args?.where,
        })
        log(`[brain] set_reminder ${item.id} ${item.at} "${item.text.slice(0, 40)}"`)
        return JSON.stringify({
          ok: true,
          id: item.id,
          at: item.at,
          when: describeWhen(at, { now }),
          text: item.text,
          message: `记下了：${describeWhen(at, { now })} 说「${item.text}」`,
        })
      }
      case 'list_reminders': {
        if (!schedule) return JSON.stringify({ ok: false, error: '闹钟没接上（宿主没提供 schedule），这次看不了' })
        const pending = schedule.pending()
        return JSON.stringify({
          ok: true,
          count: pending.length,
          items: pending.map((it) => ({
            id: it.id,
            at: it.at,
            when: describeWhen(new Date(it.at), { now }),
            text: it.text,
            where: it.channel,
          })),
          message: pending.length === 0 ? '没有排着的提醒' : undefined,
        })
      }
      case 'cancel_reminder': {
        if (!schedule) return JSON.stringify({ ok: false, error: '闹钟没接上（宿主没提供 schedule），这次删不了' })
        const item = schedule.cancel(args?.id)
        log(`[brain] cancel_reminder ${item.id}`)
        return JSON.stringify({
          ok: true,
          id: item.id,
          message: `删掉了：${describeWhen(new Date(item.at), { now })} 那条「${item.text}」`,
        })
      }
      // ── 眼睛：联网检索，只读，不走审批 ──
      case 'search_web': {
        if (!web) return JSON.stringify({ ok: false, error: '联网没接上（宿主没提供 web），这次查不了' })
        const query = String(args?.query ?? '').trim()
        if (!query) return JSON.stringify({ ok: false, error: 'query 必填' })
        const count = Number(args?.count)
        const r = await web.search(query, {
          count: Number.isFinite(count) ? count : undefined,
          needContent: args?.need_content === true,
        })
        log(`[brain] search_web "${query.slice(0, 40)}" → ${r.ok ? `${r.results.length} 条` : '失败'} ${r.ms}ms`)
        return JSON.stringify(r)
      }
      case 'fetch_url': {
        if (!web) return JSON.stringify({ ok: false, error: '联网没接上（宿主没提供 web），这次抓不了' })
        const url = String(args?.url ?? '').trim()
        if (!url) return JSON.stringify({ ok: false, error: 'url 必填' })
        const r = await web.fetchPage(url)
        log(`[brain] fetch_url ${url.slice(0, 60)} → ${r.ok ? `${r.content.length} 字` : '失败'} ${r.ms}ms`)
        return JSON.stringify(r)
      }
      case 'bili_watch': {
        if (!bili) return JSON.stringify({ ok: false, error: '看视频没接上（宿主没提供 bili），这次看不了' })
        const url = String(args?.url ?? '').trim()
        if (!url) return JSON.stringify({ ok: false, error: 'url 必填' })
        const r = await bili.watch({
          url,
          page: args?.page,
          mode: args?.mode,
          frames: args?.frames,
          times: args?.times,
          // 字幕：`mode:'subtitle'` 时 watch 自己会开；这里透传是为了让 quick/thorough 也能叠加。
          subtitles: args?.subtitles === true,
          // 她自己判定「这条我喜欢」——宿主侧据此写 liked.by='orb'（不进 B 站、不花钱）
          liked: args?.liked === true,
          reason: args?.reason,
        })
        // ★ 图片不走工具结果（工具结果是纯字符串），攒进 collect，由 run() 合成一条带图 user 消息。
        //   不这么做模型只会看到「取了 3 张」这行字，画面根本没进它的眼睛。
        if (r.ok && Array.isArray(r.images) && r.images.length && collect) {
          collect.images.push(...r.images)
        }
        log(
          `[brain] bili_watch ${url.slice(0, 48)} → ${r.ok ? 'ok' : '失败'} ` +
            `${r.ok ? `${r.meta?.title ?? ''} 帧 ${r.images?.length ?? 0}` : r.text}`
        )
        return JSON.stringify({
          ok: r.ok,
          text: r.text,
          ...(r.ok ? {} : { error: r.text }),
          ...(r.meta
            ? {
                video: {
                  title: r.meta.title,
                  duration: r.meta.duration,
                  page: r.meta.page,
                  quality: r.meta.qualityLabel,
                  width: r.meta.width,
                  height: r.meta.height,
                  aid: r.meta.aid,
                  bvid: r.meta.bvid,
                  cid: r.meta.cid,
                },
                frames: r.meta.frames,
                stats: r.meta.stats,
                // 字幕这一趟到底拿到了什么（没拿到时带 reason：no-subtitle / all-foreign / timeline-mismatch）
                ...(r.meta.subtitles ? { subtitles: r.meta.subtitles } : {}),
                // 这一趟用的是哪档看法（她后面解释成本时要引用）
                mode: r.meta.mode,
                maxOut: r.meta.maxOut,
                // 「谁的身份看的」必须跟着结果一起回到模型手里 ——
                // 少了这一块，它只能凭画质猜，实测猜成「我没登录你的账号」。
                ...(r.meta.account ? { account: r.meta.account } : {}),
              }
            : {}),
        })
      }
      case 'bili_history': {
        if (!biliHistory) return JSON.stringify({ ok: false, error: '浏览记录没接上，这次读不到' })
        const limit = Math.max(1, Math.min(Number(args?.limit) || 10, 50))
        const items = biliHistory.list({ limit })
        log(`[brain] bili_history → ${items.length} 条`)
        return JSON.stringify({
          ok: true,
          count: items.length,
          items: items.map((it) => ({
            bvid: it.bvid,
            title: it.title,
            page: it.page,
            pageTitle: it.pageTitle || undefined,
            duration: it.duration,
            quality: it.qualityLabel,
            watchedAt: it.when,
            watches: it.watches,
            frameTimes: it.frameTimes,
          })),
          message: items.length === 0 ? '账本还是空的 —— 你还没在 B 站看过任何视频' : undefined,
        })
      }
      case 'bili_act': {
        if (!biliAct) return JSON.stringify({ ok: false, error: '点赞/投币/收藏没接上（宿主没提供），这次做不了' })
        const bvid = String(args?.bvid ?? '').trim()
        const action = String(args?.action ?? '').trim()
        if (!bvid) return JSON.stringify({ ok: false, error: 'bvid 必填（哪一条视频？）' })
        if (!['like', 'coin', 'fav'].includes(action)) {
          return JSON.stringify({ ok: false, error: `action 只能是 like / coin / fav，你给的是「${action}」` })
        }
        // 投币上限是 2 枚，这里夹一下，别让模型手滑传个 9
        const count = action === 'coin' ? (Number(args?.count) === 2 ? 2 : 1) : undefined
        const r = await biliAct({ bvid, action, count })
        // ★ 日志只记「做了什么、成没成」，不记 cookie、不记 aid（记忆里那条硬规矩）
        log(`[brain] bili_act ${action} ${bvid}${count ? ` x${count}` : ''} → ${r?.ok ? 'ok' : r?.code || r?.error}`)
        if (!r?.ok) {
          return JSON.stringify({
            ok: false,
            code: r?.code,
            error: r?.error || '没成功',
            hint:
              r?.code === -401
                ? 'B 站拒绝给这条稿件这个操作（-401 非法访问）—— 常见于作者/版权限制。照实说「这条不让投/让收藏」，别说成「我没登录」。'
                : '把 error 原样告诉他，别自己编原因。',
          })
        }
        return JSON.stringify({
          ok: true,
          bvid,
          action,
          ...(count ? { count } : {}),
          message: r.message,
          // 让模型知道「这条现在在账本里是什么状态」，免得它下一句又说「还没投呢」
          state: r.item?.actions ? { ...r.item.actions, liked: r.item.liked ? true : undefined } : undefined,
        })
      }
      case 'check_balance': {
        if (!balance) return JSON.stringify({ ok: false, error: '这个服务商没有余额接口，查不到' })
        // force：这是用户/她自己主动要的，就别给 5 分钟前的旧数
        const s = await balance.snapshot({ force: true })
        if (!s?.ok) {
          return JSON.stringify({
            ok: false,
            unsupported: s?.unsupported === true,
            error: s?.error || '查不到余额',
            hint: '查不到就如实说查不到，不要估算。',
          })
        }
        const low = Number(s.total) < Number(balance.warnBelow)
        log(`[brain] check_balance → ${formatMoney(s.total, s.currency)}${low ? '（偏低）' : ''}`)
        return JSON.stringify({
          ok: true,
          currency: s.currency,
          total: s.total,
          granted: s.granted,
          toppedUp: s.toppedUp,
          available: s.available,
          low,
          message: `还剩 ${formatMoney(s.total, s.currency)}${low ? '，不多了' : ''}`,
        })
      }
      default:
        return JSON.stringify({ ok: false, error: `未知工具: ${name}` })
    }
  } catch (err) {
    log(`[brain] 工具失败 ${name}: ${err.message}`)
    return JSON.stringify({ ok: false, error: err.message })
  }
}

// ── 主类 ─────────────────────────────────────────────────

class Brain {
  /**
   * @param {object} o
   * @param {object} o.llm          createLLM() 返回的客户端
   * @param {object} o.memstore     createMemoryStore() 返回的记忆内核
   * @param {string} o.persona      persona 文本
   * @param {object} o.sessionStore createSessionStore() 返回的会话存储
   * @param {string} o.agentId      当前 agentId
   * @param {object} o.settings     createSettings() 返回的旋钮
   * @param {object} o.snapshot     createSnapshotService() 返回的快照服务
   * @param {(msg:string)=>void} [o.log]
   * @param {()=>void|Promise<void>} [o.onTurnIdle] 回合结束回调（★ I5）
   * @param {(req:{toolName:string,args:object})=>Promise<{approved:boolean,reason?:string}>} [o.approve]
   *        工作区工具的审批通道（main 的 approval broker）。不给 = 工作区工具一律不执行。
   * @param {object} [o.web]    createWeb() 返回的联网客户端。不给 = 没有 search_web / fetch_url。
   */
  constructor({
    llm,
    memstore,
    persona,
    sessionStore,
    agentId,
    settings,
    snapshot,
    log = () => {},
    onTurnIdle,
    approve,
    web = null,
    bili = null,
    biliHistory = null,
    /** 赞 / 币 / 藏的执行器（宿主注入，和抽屉按钮共用同一份实现）。 */
    biliAct = null,
    balance = null,
    /**
     * 嗓子状态（宿主注入）：每轮给她一行「我这轮到底有没有出声」。
     * ★ 2026-10-22 用户报：她不知道自己有没有嗓子 —— 语音是宿主念的、
     *   合成结果不回模型、失败只写日志，于是她默认「我说的话他当然听见了」。
     *   形状：`{ turnLine(): string|Promise<string> }`，没有就当她没这条通道。
     */
    voice = null,
    policy = null,
    schedule = null,
    now = Date.now,
  }) {
    if (!llm) throw new Error('Brain: llm is required')
    if (!memstore) throw new Error('Brain: memstore is required')
    if (!persona) throw new Error('Brain: persona is required')
    if (!sessionStore) throw new Error('Brain: sessionStore is required')
    if (!settings) throw new Error('Brain: settings is required')
    if (!snapshot) throw new Error('Brain: snapshot is required')
    this.llm = llm
    this.memstore = memstore
    this.persona = persona
    this.sessionStore = sessionStore
    this.agentId = agentId
    this.settings = settings
    this.snapshot = snapshot
    this.log = log
    this.onTurnIdle = onTurnIdle
    this.approve = approve
    this.web = web
    this.bili = bili
    this.biliHistory = biliHistory
    this.biliAct = biliAct
    this.balance = balance
    this.voice = voice
    this.policy = policy
    this.schedule = schedule
    this.now = now
    // ★ 工具列表与指南正文都由这两个布尔量决定：有位就给工具、指南也提；没有就两处都没有。
    this.hasWeb = Boolean(web)
    this.hasBili = Boolean(bili)
    // 「看过什么」是 bili 的附属能力：没有取帧能力就没有账本，两者一起有一起没有。
    this.hasBiliHistory = Boolean(biliHistory)
    // 赞 / 币 / 藏：和「看视频」不是一回事（纯写接口，不要取帧），所以单独一个开关。
    this.hasBiliAct = Boolean(biliAct)
    // 余额不是每个服务商都有（DeepSeek 有 /user/balance，多数中转站没有）。
    // 没法在建实例时就确定（要先发一次请求才知道），所以**工具照给**，
    // 真查不到时它返回 `unsupported:true`，让她如实说「查不到」而不是编一个数。
    this.hasBalance = Boolean(balance)
    this.tools = buildTools({
      web: this.hasWeb,
      bili: this.hasBili,
      biliHistory: this.hasBiliHistory,
      biliAct: this.hasBiliAct,
      balance: this.hasBalance,
    })
    // 按需召回：每轮拿用户这句话去记忆仓里捞旧记录，命中就塞到 user 消息尾部。
    // 放这里（而不是 main）是因为它要跟「轮次/冷却」绑定，跟着 Brain 生命周期最自然。
    this.recall = createRecall({ memstore: this.memstore, log: this.log })
  }

  /**
   * 拿这个会话的 system 快照：有就直接用（I3），没有才渲染并落盘。
   * @param {string} sessionId
   * @param {{force?: boolean, extra?: {boundaryMsgId?: string|null, summary?: string}}} [opts]
   */
  async ensureSnapshot(sessionId, opts = {}) {
    const existing = this.sessionStore.readSystem(sessionId)
    if (existing && !opts.force) {
      // ★ I3 的唯一显式例外（设计文档 §11）：工具指南换了版本（新增工具、改措辞），
      //   会话里冻结的旧话术会让它照着旧规则说话 —— 比如明明有 search_web，
      //   它还照旧回答「我不能联网」。只在回合边界重建一次，并把版本号打进日志。
      // ★ 第二个例外：人格换了。local 下切模式 = 换人格但共用同一个会话 id（记忆不换），
      //   这时旧的 system 快照里印的还是旧人格，不复用就等于「切了模式、说话方式没变」。
      //   老快照没有 personaHash 字段，此时按「没换过」处理，不动它（不制造无谓抖动）。
      const personaNow = hashPersona(this.persona)
      const personaChanged = Boolean(existing.personaHash) && existing.personaHash !== personaNow
      if (existing.guideVersion === GUIDE_VERSION && !personaChanged) return existing
      if (personaChanged) {
        this.log('[brain] 人格变了（换模式），本轮重建 system 快照；对话历史与记忆不动')
      } else {
        this.log(
          `[brain] 工具指南版本变化 ${existing.guideVersion ?? 0} → ${GUIDE_VERSION}，本轮重建 system 快照`,
        )
      }
    }

    const fresh = await this.snapshot.capture({
      persona: this.persona,
      toolSchemas: this.tools,
      web: this.hasWeb,
      bili: this.hasBili,
      biliAct: this.hasBiliAct,
      balance: this.hasBalance,
    })
    const summary = opts.extra?.summary ?? existing?.summary ?? ''
    const boundaryMsgId = opts.extra?.boundaryMsgId ?? existing?.boundaryMsgId ?? null
    const content = summary
      ? `${fresh.content}\n\n---\n\n## 更早的对话摘要\n\n${summary}`
      : fresh.content
    const snap = {
      ...fresh,
      content,
      hash: hashPrompt(content, this.tools),
      boundaryMsgId,
      summary,
    }
    this.sessionStore.writeSystem(sessionId, snap)
    return snap
  }

  /**
   * 压缩一次：把边界之前的对话压成备忘，写进 journal，重渲染 system 快照。
   * ★ messages.jsonl 一行不删（I1）。
   *
   * @returns {Promise<{summary:string, boundaryMsgId:string|null, dropped:number}|null>}
   */
  async compactNow(sessionId, { reason = 'auto' } = {}) {
    const all = this.sessionStore.readMessages(sessionId)
    const { boundaryMsgId, compactable } = pickBoundary({
      messages: all,
      keepRecent: this.settings.get().keepRecentMessages,
    })
    if (!compactable.length) return null

    const summary = await summarizeMessages({ llm: this.llm, messages: compactable, log: this.log })
    try {
      await this.memstore.appendJournal({
        text: `（${reason}）这之前的对话我压成了一份备忘：\n\n${summary}`,
        kind: 'compact',
        tags: ['compact', reason],
      })
    } catch (err) {
      // 摘要写不进 journal 不该让压缩整个失败：system 里仍然有摘要，只是记忆仓少一条。
      this.log(`[brain] 压缩备忘写入 journal 失败: ${err.message}`)
    }

    await this.ensureSnapshot(sessionId, {
      force: true,
      extra: { boundaryMsgId, summary },
    })
    this.log(`[brain] 压缩完成：丢掉 ${compactable.length} 条原文的视窗，摘要 ${summary.length} 字`)
    return { summary, boundaryMsgId, dropped: compactable.length }
  }

  /**
   * 跑一个回合。
   *
   * @param {object} o
   * @param {string} o.sessionId
   * @param {string} o.userText   允许为空（纯图片消息，R6-1）
   * @param {string} [o.extraTail] 追加到用户消息尾部的内容（图片说明、系统提示等）
   * @param {Array<{mimeType:string,data:string,name?:string}>} [o.images]
   *   用户这一轮发来的图片（裸 base64，不含 `data:` 前缀）。有图时 user 消息的
   *   content 变成 OpenAI 多模态数组 —— 实测 `deepseek-flash` 接受
   *   `{type:'image_url',image_url:{url:'data:…'}}`（HTTP 200，且能说出图里的内容）。
   * @returns {AsyncGenerator}
   */
  async *run({ sessionId, userText = '', extraTail = '', images = [] }) {
    if (!sessionId) throw new Error('Brain.run: sessionId is required')

    if (!this.sessionStore.exists(sessionId)) {
      this.sessionStore.create(sessionId, { summary: String(userText).slice(0, 40) })
    }

    try {
      let snap = await this.ensureSnapshot(sessionId)

      // ── 预算检查：超了就压，压完重取快照 ──
      const s = this.settings.get()
      let history = this.sessionStore.readMessages(sessionId)
      let windowed = snap.boundaryMsgId
        ? history.slice(history.findIndex((m) => m.id === snap.boundaryMsgId) + 1)
        : history
      if (s.compactMode === 'auto') {
        const est = estimateContextTokens({ systemText: snap.content, messages: windowed })
        if (est > s.contextBudgetTokens) {
          this.log(`[brain] 上下文估算 ${est} > 预算 ${s.contextBudgetTokens}，触发压缩`)
          const r = await this.compactNow(sessionId, { reason: 'auto' })
          if (r) yield { type: 'notice', text: '（把更早的对话压成了一份备忘）' }
          snap = await this.ensureSnapshot(sessionId)
          history = this.sessionStore.readMessages(sessionId)
          windowed = snap.boundaryMsgId
            ? history.slice(history.findIndex((m) => m.id === snap.boundaryMsgId) + 1)
            : history
        }
      }

      // ── 漂移：快照之后记忆变了吗？变了就从尾部补 ──
      let drift = { text: '', changed: [], overflow: false }
      try {
        drift = await this.snapshot.drift(snap)
      } catch (err) {
        this.log(`[brain] 漂移检测失败（不影响本轮）: ${err.message}`)
      }
      if (drift.overflow) {
        // 规则是「超了触发压缩，不截断」。这里的做法是重渲染快照把改动吸收进去。
        this.log('[brain] 漂移块超预算，改为重渲染快照')
        snap = await this.ensureSnapshot(sessionId, { force: true })
        drift = { text: '', changed: drift.changed, overflow: false }
      }

      // ── 组请求 ──
      const messages = [{ role: 'system', content: snap.content }]
      for (const m of windowed) {
        if (!m.text) continue
        messages.push({ role: m.role, content: m.text })
      }
      // ── 按需召回：把「记忆仓里可能相关的旧记录」拼到本轮 user 消息尾部 ──
      // ★ 分两份是必须的：`tailText` **发给模型**（含本轮全部上下文），
      //   `persistText` **落盘**（只有他说过的话）。
      //   召回块若跟着落盘，messages.jsonl 里会永久留着一段「自动检索出来的旧记录」，
      //   下一轮再被当成对话历史读回来 —— 这是污染，不是记忆。
      //   同理：时间行、余额行、`<memory_update>` 也不落盘（2026-10-22 修）。
      // 余额：每轮告诉她还剩多少钱，好让她自己决定「这条视频认真看还是快速看」。
      // ★ 放尾部（跟时间一样）而不是 system —— system 要字节稳定（I3），余额随时会变。
      //   查不到就返回空串，宁可不提，也不许她凭空估一个数。
      let balanceLine = ''
      try {
        if (this.balance) balanceLine = String((await this.balance.turnLine()) || '')
      } catch (err) {
        this.log(`[balance] 本轮取余额失败（不影响对话）：${err.message}`)
      }
      // 嗓子：每轮告诉她「这轮说的话会不会真的出声、上一句有没有念失败」。
      // ★ 她不知道有嗓子不是心理问题，是信息问题：合成在宿主侧、结果不回模型、
      //   失败只进日志。不给这行，她只能默认「他当然听见了」。
      let voiceLine = ''
      try {
        if (this.voice) voiceLine = String((await this.voice.turnLine()) || '')
      } catch (err) {
        this.log(`[voice] 本轮取语音状态失败（不影响对话）：${err.message}`)
      }
      const baseTailParts = [
        String(userText ?? '').trim(),
        String(extraTail ?? '').trim(),
        // 每轮告诉她现在几点：她需要一个可靠的时钟才能排提醒（自己猜时间必错）。
        // 放尾部而不是 system —— system 要字节稳定（I3），时间每轮都变。
        `（现在是 ${describeNow(this.now())}）`,
        balanceLine.trim(),
        voiceLine.trim(),
        drift.text.trim(),
      ].filter(Boolean)
      let recallText = ''
      try {
        const r = await this.recall.forTurn({ sessionId, query: String(userText ?? '') })
        recallText = r.text
      } catch (err) {
        // 召回失败绝不能影响对话本身
        this.log(`[recall] 本轮召回失败（不影响对话）：${err.message}`)
      }
      const tailText =
        (recallText === '' ? baseTailParts : [...baseTailParts, recallText]).join('\n\n') ||
        '（他什么也没说）'
      // ★ 落盘的**只有用户真正说过的话**（2026-10-22 用户报：
      //   「正在对话时提示词不显示，重新打开对话就出现了」）。
      //
      //   根因就是这一行：早先 persistText = baseTailParts.join()，把
      //   时间行、余额行、`<memory_update>` 全文一起写进了 messages.jsonl。
      //   而广播给 UI 的是干净的 userText（见下面的 yield）⇒ 实时干净、重开露馅。
      //   更贵的是：这些块下一轮会被当「历史对话」读回去再喂给模型，上下文白胖一圈。
      //
      //   口径：**时间 / 余额 / 记忆更新块 / 召回块 / extraTail 都是「这一轮看到的」，
      //   不是「他说过的话」** —— 一个字都不该进账。
      const persistText = String(userText ?? '').trim() || '（他什么也没说）'

      // ── 图片：有图就把 user content 换成 OpenAI 多模态数组 ──
      // 形状必须是 `{type:'image_url', image_url:{url:'data:<mime>;base64,<b64>'}}`：
      // `deepseek-flash` 实测认这一种（HTTP 200，能把图里的界面元素说出来），
      // 而旧后端时代的 legacy 形状 `{type:'image', source:{…}}` 在这里会 400。
      // 纯文本仍发字符串 —— 老会话的历史消息全是字符串，保持一致好排查。
      const imageList = Array.isArray(images)
        ? images.filter((im) => im && typeof im.data === 'string' && im.data !== '')
        : []
      const userContent = imageList.length === 0
        ? tailText
        : [
            { type: 'text', text: tailText },
            ...imageList.map((im) => ({
              type: 'image_url',
              image_url: {
                url: `data:${typeof im.mimeType === 'string' && im.mimeType !== '' ? im.mimeType : 'image/png'};base64,${im.data}`,
              },
            })),
          ]
      messages.push({ role: 'user', content: userContent })

      // 落盘的只有 `persistText`（= 他真正说过的话）。
      // ★ 2026-10-22 之前这里落的是 `tailText` 去掉召回块的版本，仍带着
      //   时间 / 余额 / `<memory_update>` —— 那些块重开对话就会被当成对话正文渲染出来。
      //   口径改成「只有他说的话才进账」，与 UI 气泡用的是同一份文本。
      // 图同时写成 content 的 image 片段，这样切走再切回时气泡里的「图片 ×N」
      // 占位与点开取图（image-request → readMessageImages）都还在。
      this.sessionStore.appendMessage(sessionId, { role: 'user', text: persistText, images: imageList })

      yield { type: 'user', text: String(userText ?? '') }

      // ── 工具循环 ──
      let assistantText = ''
      // 最后一轮的 finish_reason（llm.mjs:231 已经产出，此前无人消费 → 空正文回合无从查证）
      let lastStopReason = null
      // 工具抓到的图（bili_watch 的关键帧）攒在这里，循环里合成一条带图 user 消息喂回去。
      const imageSink = { images: [], sent: false }
      // promptTokens 是**各轮相加**（每个工具轮都是一次真实计费请求），firstTokenMs 只取首轮
      const totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0, firstTokenMs: null, rounds: 0 }
      const maxToolRounds = 10

      for (let round = 0; round < maxToolRounds; round++) {
        let roundText = ''
        let roundReasoning = ''
        /** @type {Array<{id:string,name:string,args:object}>} */
        const calls = []

        for await (const event of this.llm.stream({ messages, tools: this.tools })) {
          if (event.type === 'content') {
            roundText += event.text
            yield { type: 'assistant', text: event.text }
          } else if (event.type === 'reasoning') {
            roundReasoning += event.text
            yield { type: 'reasoning', text: event.text }
          } else if (event.type === 'tool_call') {
            calls.push({
              id: event.id || `call_${round}_${calls.length}_${Date.now().toString(36)}`,
              name: event.name,
              args: event.args,
            })
          } else if (event.type === 'done') {
            // ★ 2026-10-22：stopReason 必须往上带。之前这里只取 usage，导致「模型想了 1810 token
            //   却一个字没说」的回合在日志里只剩「思考==输出」这一个巧合可辨认。
            if (event.stopReason) lastStopReason = event.stopReason
            const u = event.usage
            if (u) {
              totalUsage.rounds += 1
              totalUsage.promptTokens += u.promptTokens || 0
              totalUsage.completionTokens += u.completionTokens || 0
              totalUsage.totalTokens += u.totalTokens || 0
              totalUsage.cacheHitTokens += u.cacheHitTokens || 0
              totalUsage.cacheMissTokens += u.cacheMissTokens || 0
              // 思考 token 必须往上带：llm.mjs:241 已经解出 reasoningTokens，但这里漏加会一路传到
              // toUiUsage() 变成「思考=0」——「看不出她在思考」的根因之一就是这个丢字段。
              totalUsage.reasoningTokens += u.reasoningTokens || 0
              if (totalUsage.firstTokenMs === null && typeof u.firstTokenMs === 'number') totalUsage.firstTokenMs = u.firstTokenMs
            }
          }
        }

        // ★ 本轮正文先落账，再决定要不要重置（R6：原来 238 行先清空、249 行才累加，正文丢了）
        assistantText += roundText

        if (calls.length === 0) break

        const assistantMsg = {
          role: 'assistant',
          content: roundText || null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
          })),
        }
        // ★ DeepSeek thinking 模式：带工具调用的 assistant 轮必须回传 reasoning_content，否则 400
        if (roundReasoning) assistantMsg.reasoning_content = roundReasoning
        messages.push(assistantMsg)

        for (const call of calls) {
          yield { type: 'tool', id: call.id, name: call.name, args: call.args, phase: 'call' }
          const result = await executeTool(call, {
            memstore: this.memstore,
            settings: this.settings,
            log: this.log,
            // 写文件的审批闸门（白名单外 / 覆盖已存在）。没接上时 executeTool 会直接拒绝执行，
            // 不会静默放行（「没接审批」不等于「默认允许」）。
            approve: this.approve,
            web: this.web,
            bili: this.bili,
            biliHistory: this.biliHistory,
            balance: this.balance,
            // 工具抓到的图片（如 bili_watch 的关键帧）攒在这里，循环末尾合成一条带图 user 消息。
            collect: imageSink,
            policy: this.policy,
            schedule: this.schedule,
            // ★ 检索要按 agent 分仓（对话目录名里有 agentId），必须真传下去
            agentId: this.agentId,
            now: this.now,
          })
          let parsed = null
          try { parsed = JSON.parse(result) } catch { /* 结果不是 JSON 就按成功处理 */ }
          yield {
            type: 'tool',
            id: call.id,
            name: call.name,
            result,
            phase: 'result',
            isError: parsed ? parsed.ok === false : false,
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: result })
        }

        // ★ 工具抓到的图片要真进模型的眼睛：工具结果只能是字符串，图只能挂在 user 消息上。
        //   一回合最多一次、最多 MAX_TOOL_IMAGES 张 —— 否则模型会一直「再抽几帧」，把上下文灌爆（钱也是这么烧的）。
        if (imageSink.images.length > 0 && !imageSink.sent) {
          const pics = imageSink.images.slice(0, MAX_TOOL_IMAGES)
          imageSink.sent = true
          messages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: `（这是工具刚取到的画面，共 ${pics.length} 张；你可以直接看。看完就用它们回答，别再重复抽帧。）`,
              },
              ...pics.map((im) => ({
                type: 'image_url',
                image_url: { url: `data:${im.mimeType || 'image/jpeg'};base64,${im.data}` },
              })),
            ],
          })
        }

        roundText = ''
        roundReasoning = ''
      }

      // ★ 2026-10-22 补：空正文也要落账（此前整轮静默丢弃）。
      //   实测一次「思考=1810 / 输出=1810」的回合：completion 预算全烧在 reasoning 上，
      //   content 一个 token 都没有。旧代码 `if (assistantText.trim())` 直接把这一轮扔掉，
      //   后果三层：① 球窗口什么都没有，用户只看到「思考了 11 秒」；
      //   ② messages.jsonl 停在 user 那条，下一轮模型看到「他连说两句、我没回」，上下文错位；
      //   ③ 零痕迹可查。
      //   现在：落一条带占位正文的 assistant 记录（保住 user/assistant 交替），
      //   并往 UI 推一条 notice，让失败看得见。
      const emptyContent = assistantText.trim() === ''
      if (!emptyContent) {
        this.sessionStore.appendMessage(sessionId, {
          role: 'assistant',
          text: assistantText,
          usage: totalUsage,
        })
      } else {
        const why = lastStopReason ? `finish_reason=${lastStopReason}` : 'finish_reason 未知'
        const note = `（这一轮我只想了没说话，正文是空的：${why}。）`
        this.log(`[brain] 空正文回合 ${sessionId} 思考=${totalUsage.reasoningTokens} 输出=${totalUsage.completionTokens} ${why}`)
        try {
          this.sessionStore.appendMessage(sessionId, {
            role: 'assistant',
            text: note,
            usage: totalUsage,
          })
        } catch (err) {
          this.log(`[brain] 空正文回合落盘失败: ${err.message}`)
        }
        yield { type: 'notice', text: note }
      }

      yield { type: 'usage', usage: totalUsage }
      yield { type: 'done', usage: totalUsage, sessionId, promptHash: snap.hash, stopReason: lastStopReason, emptyContent }
    } finally {
      // ★ I5：回合结束只有这一个出口。无论正常结束、抛错、还是被 abort，都要通知宿主。
      if (this.onTurnIdle) {
        try {
          await this.onTurnIdle()
        } catch (err) {
          this.log(`[brain] onTurnIdle 回调失败: ${err.message}`)
        }
      }
    }
  }
}

/**
 * 工厂函数。
 */
export function createBrain(o) {
  return new Brain(o)
}
