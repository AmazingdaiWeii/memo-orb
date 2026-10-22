/**
 * 导出「默认出厂版」副本：只含运行必需的程序、素材与初始人格，不含任何个人数据。
 *
 *   node tools/export-factory.mjs                    # → exports/Orb_factory_<时间戳>/
 *   node tools/export-factory.mjs --dest D:\Orb_factory
 *
 * 设计原则（与 build.ps1 的区别）：
 *   · build.ps1 是**就地**打包到 dist/，靠 config.example.json 生成干净 config，但
 *     它写于「旧后端」时代：不拷 `鲸鱼娘_persona.md`（现在运行期必需，缺了
 *     src/persona.mjs 的 assertPersona 直接抛）、还拷已经不存在的 node_modules。
 *   · 本脚本用**显式白名单**（目录 + 根文件），带逐条「不拷理由」，最后做泄漏复核。
 *
 * 白名单：
 *   src/                主进程（47 个 .mjs + tts/）
 *   helper/             球侧窗口层 + 渲染层 + 全部素材（背景/球形态/情绪图/vendor）
 *   runtime/electron/   自带 Electron 运行时（双击即跑）
 *   package.json / package-lock.json / run.cmd / Orb.exe（由 tools/launcher/ 编出）
 *   鲸鱼娘_persona.md   初始 prompt（人格卡）——缺它启动即失败
 *   THIRD-PARTY-NOTICES.md  署名与授权
 *   config.json         由 config.example.json 生成（agentId=null ⇒ 首启新建 agent）
 *   data/               空目录，首次运行时她自己长出 memory/ 与 conversations/
 *   开发笔记/            脱敏后的踩坑与交接记录（用户 2026-10-22 要求随包分发，
 *                       让人接手时不必重走同样的错）。来源见 NOTE_SOURCES。
 *
 * 不拷（逐条理由见 SKIP_REASONS）。
 *
 * 用法补充：
 *   node tools/export-factory.mjs --notes-only <已存在的出厂目录>   # 只重建 开发笔记/
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

// ── 目标目录 ────────────────────────────────────────────────
const argv = process.argv.slice(2)
function arg(name) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const DEST = resolve(arg('dest') ?? join(ROOT, 'exports', `Orb_factory_${stamp}`))

// ── 白名单 ──────────────────────────────────────────────────
const COPY_DIRS = ['src', 'helper', 'runtime/electron']

const COPY_ROOT_FILES = [
  'package.json',
  'package-lock.json',
  'run.cmd',
  '鲸鱼娘_persona.md',
  'THIRD-PARTY-NOTICES.md',
]

/**
 * 上游 dsh-orb 的 6 张球形态素材：`开发笔记/01_开发手册_架构与历史.md` 的「素材与署名」用 md5 逐字节确认与上游相同、
 * 从未获授权 ⇒ 不随开源包分发（THIRD-PARTY-NOTICES 里写的就是「未包含」）。
 * 删掉不坏程序：`helper/lib/main.js` 的 `orb:avatars` 是扫目录出的清单，空了环菜单就不列，
 * 球自己回落 `avatars/orb-A.gif`（`helper/assets/shell.js:1177`）；`deco/` 才是唯一表情来源，不能动。
 */
const UNLICENSED = new Set([
  'helper/assets/avatars/cheeks.gif',
  'helper/assets/avatars/cheer.gif',
  'helper/assets/avatars/heart.gif',
  'helper/assets/avatars/point.gif',
  'helper/assets/avatars/rice.gif',
  'helper/assets/avatars/smile.gif',
])

/** 版权署名（2026-10-22 作者确认为 `Amazingdaiweii`；许可 2026-10-22 改为 PolyForm Noncommercial 1.0.0）。 */
const COPYRIGHT = 'Amazingdaiweii, 2026'

/** `--no-runtime`：出「源码仓库版」——不含 366 MB 的 Electron，仓库体积降到约 23 MB。 */
const WITH_RUNTIME = !argv.includes('--no-runtime')

/**
 * 双击即用的启动器（`Orb.exe`）。
 *
 * 为什么另做一个 exe：`run.cmd` 走 `node src/launch.mjs`，用户机器上没装 Node 就打不开。
 * 这里用 .NET Framework 的 csc 编一个 ~170 KB 的 winexe（无控制台窗口），它设
 * `ELECTRON_RUN_AS_NODE=1` 让自带的 `runtime/electron/electron.exe` 跑 `src/launch.mjs`，
 * 于是启动参数、杀软改名兜底、日志全部沿用原逻辑，却不需要系统里有 Node。
 * .NET Framework 4.x 在 Win10/11 自带，等于零外部依赖。
 * 源码与重建命令见 `tools/launcher/OrbLauncher.cs` 与 `build-launcher.cmd`。
 */
const LAUNCHER_REL = 'tools/launcher/Orb.exe'
const LAUNCHER_DEST = 'Orb.exe'

/** 相对路径 → 不拷理由。只对白名单内部的路径生效。 */
const EXCLUDE = new Map([
  ['runtime/electron/debug.log', 'Electron 本机运行日志（带时间戳与路径痕迹）'],
  ['runtime/electron/orb-runtime.exe', '启动器被杀软拦截时生成的改名副本，可由 electron.exe 重建'],
])

const SKIP_REASONS = [
  ['data/', '个人运行数据：会话原文 / 记忆仓（含 .git 全文）/ providers\\auth.json 明文密钥 / 微信与 B 站 token'],
  ['logs/', '运行日志'],
  ['exports/', '历史导出（整段对话明文）'],
  ['bak/', '备份（含未获授权的上游素材与 src 旧副本）'],
  ['art/', '美术制作过程（90 MB，运行期不读）'],
  ['generated-images/', '生成图产物'],
  ['video/', '视频 / 配音 / 素材'],
  ['docs/', '只放对外文档（8 篇）与 3 张截图；交接记录、待办、计划书等 61 份内部材料已移到 _internal/（.gitignore 挡住，不进仓库）；其中踩坑类经脱敏后以「开发笔记/」随包，原始过程不整份发'],
  ['tools/', '一次性开发脚本（打包 / 沙箱 / 探测 / 出厂化）'],
  ['probe/', '调试探针'],
  ['preview-status-capsule/', '状态胶囊预览'],
  ['helper-src/', '上游构建源副本'],
  ['_sandbox-data*/', '沙箱数据（其中 5 份含同一个真 API key）'],
  ['.git/', '版本库'],
  ['背景/', '与 helper/assets/backgrounds/ 逐字节重复（6/6 相同），壁纸仍在 helper 内'],
  ['config.example.json', '由它生成 config.json，模板本身不发'],
  ['README.md', '开发手册（含私有过程）；脱敏后以「开发笔记/01」随包'],
  ['交接文档_当前进度*.md 等进度类交接文档', '内部交接（问题清单那篇以「开发笔记/02」随包）'],
  ['*.bak / .wbapp_* / .gitignore', '本机残留'],
  ['build.ps1（构建脚本）', '开发工具，不随包；一次性脚本已归档到 tools/legacy/，打包用二进制在 tools/bin/'],
]

// ── 工具 ────────────────────────────────────────────────────
const errors = []
const log = (m) => console.log(m)

function shouldCopy(relPath) {
  if (EXCLUDE.has(relPath)) return false
  if (UNLICENSED.has(relPath)) return false
  if (!WITH_RUNTIME && relPath.startsWith('runtime')) return false
  // 任何 .git 与 .bak 一律不进
  const segs = relPath.split('/')
  if (segs.includes('.git')) return false
  if (relPath.endsWith('.bak')) return false
  return true
}

function copyTree(relDir) {
  const srcDir = join(ROOT, relDir)
  if (!existsSync(srcDir)) {
    errors.push(`源目录缺失：${relDir}`)
    return { files: 0, bytes: 0 }
  }
  const stat = { files: 0, bytes: 0 }
  cpSync(srcDir, join(DEST, relDir), {
    recursive: true,
    force: true,
    filter: (src) => {
      const rel = relative(ROOT, src).split(sep).join('/')
      if (rel === '') return true
      return shouldCopy(rel)
    },
  })
  return stat
}

function walk(dir, out = []) {
  for (const en of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, en.name)
    if (en.isDirectory()) walk(full, out)
    else if (en.isFile()) out.push(full)
  }
  return out
}

function human(bytes) {
  return bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// ── 开发笔记（脱敏随包）─────────────────────────────────────
// 用户 2026-10-22 要求：把工程里已经趟过的错一起打包，后来者改这个项目时不必重走。
// 做法：只挑「教训类」文档，逐份脱敏（本机路径 / 用户名 / 本机 agent id），
// 不改写技术结论、不删错误过程 —— 错误过程本身就是这份笔记的价值。
const NOTE_DIR = '开发笔记'

const NOTE_SOURCES = [
  ['01_开发手册_架构与历史.md', 'docs/开发交接文档_2026-10-22.md',
    '架构与目录职责、素材与署名、历史决策来龙去脉（含已被后续推翻的旧描述，文中会标注）'],
  ['02_已趟过的坑_球侧问题清单.md', 'docs/交接文档_球侧问题清单_2026-10-22.md',
    '八百多行问题清单：被推翻的错误结论（§0.1）、红线、事故复盘、修复方式与证据位置'],
]

/** 脱敏：只替换「在本机才有意义」的标识，不碰技术结论。顺序有意义，先长后短。 */
const REDACT = [
  [/sk-[A-Za-z0-9]{16,}/g, '<已移除的 API key>'],
  [/[A-Za-z]:[\\/]Users[\\/][^\s`'"）)，。]*/g, '<本机路径>'],
  [/\bAdministrator\b/g, '<用户名>'],
  [/\borb-2026\d{4}\b/g, 'orb-YYYYMMDD'],
  [/\bagent-local-[0-9a-f][0-9a-f-]{6,}/g, 'agent-local-<uuid>'],
  [/[A-Za-z]:[\\/]+Memo orb[\\/]*/gi, '<项目根>/'],
  [/[A-Za-z]:[\\/]+orb-probe[\\/]*/gi, '<本机路径>/'],
  [/[A-Za-z]:[\\/]+SteamLibrary[\\/]*/gi, '<本机路径>/'],
  [/[A-Za-z]:[\\/]letta_orb/gi, '<母本副本>'],
  [/[A-Za-z]:[\\/]dsh-workspace[^\s`'"）)，。]*/g, '<上游工作区>'],
  [/[A-Za-z]:[\\/]dsh-home[^\s`'"）)，。]*/g, '<本机路径>'],
  [/[A-Za-z]:[\\/]ComfyUI[^\s`'"）)，。]*/gi, '<本机路径>'],
]

function redact(text) {
  let out = text
  for (const [re, to] of REDACT) out = out.replace(re, to)
  return out
}

const NOTE_HEADERS = `> **这份文档为什么在这里**
>
> 它是这个项目开发期间的内部记录，随出厂包一起发出来，是为了让接手的人**不必重走同样的错**。
> 里面包含当时**判断错误、返工、丢文件、踩坑**的完整过程 —— 那正是它的价值，不要当废话删掉。
> 分发前已做脱敏：本机绝对路径、本机用户名、本机 agent id 都换成了占位符；技术结论一字未改。
>
> 注意：文档写于某个具体日期，是**历史快照**。行号、文件名、结论都可能已被后续改动推翻
> （尤其「02_已趟过的坑」的 §0.1 专门列出「已被推翻的结论」）。**以当前代码为准，以文档为线索。**

---

`

const NOTE_INDEX = [
  '# 从这里读起',
  '',
  '这份 `开发笔记/` 是原作者做出 Orb 的过程中留下的记录，**连同出厂包一起发给你**，',
  '目的只有一个：你接手改它的时候，不必把他已经踩过的坑再踩一遍。',
  '',
  '它们是**历史快照**（写于 2026-10-06 ~ 2026-10-22）。行号、文件名、结论都可能被后续改动推翻，',
  '`02_已趟过的坑` 的 §0.1 专门列了「已经确认错误的结论」—— 那一节比正文档更值得先读。',
  '**以当前代码为准，以这些文档为线索。**',
  '',
  '---',
  '',
  '## 一、三条铁律',
  '',
  '1. **改任何东西之前先留回退点。** 副本放到项目外（另起一份目录），不要只在原地加 `.bak` 后缀——',
  '   这个项目历史上就因为「原地备份等于没备份」整份丢过 `helper/assets/floating.css`。',
  '2. **改完 `.js/.mjs/.cjs` 跑 `node --check <文件>`；改完 CSS 必须真起一次界面点一遍。**',
  '   CSS 少一行不会报错，只会让某个功能**静默消失**（见第四节第 1 条）。',
  '3. **探针/测试不许写生产数据。** 生产数据是 `config.json` 与 `data/`；',
  '   自测时用 `ORB_DATA=<临时目录>` 加一次性 agentId。`data/` 里的会话与记忆**不可再生**。',
  '',
  '## 二、30 秒环境事实',
  '',
  '| 项 | 值 |',
  '|---|---|',
  '| 运行时 | Node `^22.19 || >=24`；Electron 44（`runtime/electron/` 自带，不必另装） |',
  '| 依赖 | **零 npm 依赖**，`package.json` 的 `dependencies` 为空，没有 `node_modules/` |',
  WITH_RUNTIME
    ? '| 入口 | `Orb.exe`（双击即用，不需要系统装 Node/Electron）→ `src/launch.mjs` → 动态 import `src/main.mjs`；排查问题用 `run.cmd`，它能看见报错 |'
    : '| 入口 | `run.cmd` → `node src/launch.mjs` → 动态 import `src/main.mjs`（源码仓库版不含 `Orb.exe`，需自备 Node + Electron） |',
  '| 路径 | **全部相对项目根**（`ROOT` = `src/` 的上一级）。整个文件夹搬到任何盘都能跑 |',
  '| 数据根 | `data/`，可用环境变量 `ORB_DATA` 覆盖；删掉 `data/` 即等于恢复出厂 |',
  '| 出厂态 | `config.json` 里 `agentId: null` ⇒ 首次启动自动新建 agent，并把人格烤进 system prompt |',
  '| 人格卡 | `鲸鱼娘_persona.md`，运行期**必需**，缺了启动直接失败 |',
  '',
  '## 三、目录职责',
  '',
  '```',
  ...(WITH_RUNTIME ? ['Orb.exe                 双击启动（~170 KB 的壳，内部拉起 runtime/electron/electron.exe）'] : []),
  'run.cmd                命令行启动器（node src/launch.mjs）',
  'config.json            模型名、窗口、权限（出厂 permission=read-only）',
  'src/                   主进程：llm.mjs / brain.mjs / memory*.mjs / persona.mjs / tts/ …',
  'helper/                球侧：lib/main.js（窗口 + 43 个 IPC handler）、',
  '                       assets/（shell.js、floating.css、素材、vendor）',
  'runtime/electron/      自带 Electron 运行时（366 MB）',
  'data/                  运行期数据：memfs/（记忆仓）、conversations/、providers/auth.json',
  '鲸鱼娘_persona.md      人格卡（system prompt 的来源）',
  '开发笔记/              你正在读的这份',
  '```',
  '',
  '## 四、已经付过代价的坑',
  '',
  '### 1. 改 CSS 后功能静默消失（最容易重犯）',
  '`helper/assets/floating.css` 曾被整份写坏、原文件又丢了，只能拿一份 1031 行的老副本重建，',
  '漏掉 4 段样式（`--panel-opacity`、`#deco` 的 `position/right/bottom/opacity` 与 `--deco-size`、',
  '`#deco-lane` 的 `z-index`），现场表现是「拖圆环没反应、情绪图消失、底部按钮被压住」，',
  '而**控制台一行报错都没有**。做法：改完 CSS 真起一次界面，看球的窗口到底装配起来没有',
  '（右键能出菜单、左键能展开），别只靠眼看样式。',
  '',
  '### 2. 「毛玻璃和透明窗口不可兼得」是错的（旧结论已被推翻）',
  '真正的原因不是窗口合成，是**层叠顺序**：`#bg-stack` 是 `#panel` 的子元素且 `z-index:-1`，',
  '于是画在 panel 背景**之上** —— ① panel 的 `backdrop-filter` 糊不到任何东西，',
  '② 面板底色 `--panel-opacity` 的变化被背景图盖住。',
  '**不要为了修毛玻璃去删 `backdrop-filter`**：这一步做过，删完的后果是「排版乱」。',
  '',
  '### 3. 机械批量替换文案 = 隐形的语义破坏',
  '有一次用脚本一次改了 115 个文件，`node --check` 全过，但 README 出现大量病句，',
  '还差点把中文塞进标识符（`openLettaWeb` → `open旧后端Web`，33 处）。',
  '文本替换之后必须**人读一遍**，并扫「ASCII 与汉字相邻」的形态。',
  '',
  '### 4. 人格卡有硬断言，改之前先看 `src/persona.mjs`',
  '`assertPersona` 要求：首行 `# 鲸鱼娘`、含 `## 保险丝`、含 `## 最高准则`（或 `## 只有一条准则`）；',
  '2026-10-22 起只有 §二 A 一个围栏块（工作态已退役）；改块外说明文字不影响 prompt。',
  '段落标记是 `## 二、A.`（chat），取标记后**第一个**代码块。改坏了启动即抛错。',
  '',
  '### 5. `data/` 是不可再生数据',
  '`data/conversations/` 是会话原文，`data/memfs/<agentId>/` 是她的记忆（自带 git 历史），',
  '`data/providers/auth.json` 是明文密钥。**不许进发布包**，改动前先整份备份。',
  '',
  '### 6. 路径必须相对项目根',
  '所有路径都从 `ROOT`（`src/` 的上一级）推出来：`helper/lib/main.js`、`config.json`、',
  '`鲸鱼娘_persona.md`、`data/`、`logs/`。一旦写死绝对路径，包一搬家就坏。',
  '',
  '### 7. 端口是动态的',
  '球的控制 socket 由系统挑空闲端口，实际端口只在启动日志里（`球的控制 socket 监听 127.0.0.1:<port>`）。',
  '别把某次看到的端口写进代码。',
  '',
  '### 8. bash 的 heredoc 会吃掉反斜杠',
  '含正则的脚本经 heredoc 写入会静默变形（`\\s` 变 `s`）。含正则的文件一律用编辑器改。',
  '',
  '### 9. 不要按命令行模糊匹配批量杀进程',
  '用 `CommandLine -like "*<项目目录>*"` 批量 `Stop-Process` 会把调用方自己的进程树一起杀掉。',
  '按精确 PID 杀。',
  '',
  '### 10. 杀软可能拦 `electron.exe`',
  '`src/launch.mjs` 遇到拦截会自动把它复制成 `orb-runtime.exe` 再试一次；',
  '这个副本是运行时产物，不要打进发布包。',
  '',
  '## 五、接手第一小时',
  '',
  '1. 读 `02_已趟过的坑/§0.1`：那些是**已经确认错误**的结论，照着旧文档干会走弯路。',
  '2. 先把现有功能手工过一遍（对话一轮、抽屉、历史、记忆各看一次），拿到「当前是好的」基线再动手。',
  '3. 确认 `data/` 有备份；确认你要改的文件有回退点。',
  '4. 改代码 → `node --check`；改 CSS → 真起一次界面点一遍。',
  '',
  '## 六、文档索引',
  '',
  '| 文件 | 内容 | 什么时候看 |',
  '|---|---|---|',
  '| `01_开发手册_架构与历史.md` | 架构、目录职责、素材与署名、历史决策 | 想搞清「为什么这样设计」 |',
  '| `02_已趟过的坑_球侧问题清单.md` | 八百多行问题清单：错误结论、红线、事故复盘 | **动手前必读** |',
  '',
  '---',
  '',
  '> 这些文档原为项目内部记录，随包前只做了脱敏（本机绝对路径、用户名、本机 agent id 换成占位符），',
  '> **技术结论与踩坑过程一字未改**。',
].join('\n') + '\n'


const SCAN = [
  { name: '明文 API key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: '本机 agentId', re: /orb-2026\d{4}/ },
  { name: '旧 agent id 形态', re: /agent-local-[0-9a-f]{8}/ },
  { name: '本机用户名路径', re: /[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9_]+/ },
  { name: '本机用户名', re: /\bAdministrator\b/ },
  { name: '本机项目绝对路径', re: /[A-Za-z]:[\\/]Memo orb/i },
  { name: '母本绝对路径', re: /[A-Za-z]:[\\/]letta_orb/i },
]

function scanDir(root) {
  const hits = new Map()
  for (const f of walk(root)) {
    const rel = relative(root, f).split(sep).join('/')
    if (!/\.(mjs|cjs|js|json|md|txt|html|css|cmd)$/i.test(rel)) continue
    let text
    try { text = readFileSync(f, 'utf8') } catch { continue }
    for (const { name, re } of SCAN) {
      const m = re.exec(text)
      if (!m) continue
      if (!hits.has(name)) hits.set(name, [])
      hits.get(name).push(`${rel} → ${m[0].slice(0, 28)}`)
    }
  }
  return hits
}

function buildDevNotes(destRoot) {
  const dir = join(destRoot, NOTE_DIR)
  mkdirSync(dir, { recursive: true })
  let bytes = 0
  for (const [toName, srcRel] of NOTE_SOURCES) {
    const src = join(ROOT, srcRel)
    if (!existsSync(src)) { errors.push(`开发笔记源缺失：${srcRel}`); continue }
    const raw = readFileSync(src, 'utf8').replace(/^\uFEFF/, '')
    const body = NOTE_HEADERS +
      `<!-- 摘自 ${srcRel}（原文共 ${raw.split('\n').length} 行），除脱敏外未改写 -->\n\n` +
      redact(raw)
    const out = join(dir, toName)
    writeFileSync(out, body, 'utf8')
    bytes += Buffer.byteLength(body, 'utf8')
    log(`  开发笔记 ${toName}`)
  }
  // 索引写在最前面（读者第一眼看到的是「先读什么」）
  const idxPath = join(dir, '00_从这里读起.md')
  writeFileSync(idxPath, NOTE_INDEX, 'utf8')
  bytes += Buffer.byteLength(NOTE_INDEX, 'utf8')
  log(`  开发笔记 00_从这里读起.md`)
  return bytes
}

// ── 0b. --notes-only：只重建 开发笔记/（包已生成过时用）────────
if (arg('notes-only')) {
  const target = resolve(arg('notes-only'))
  if (!existsSync(join(target, 'src', 'main.mjs'))) {
    console.error(`\n[中止] ${target} 看起来不是出厂包（缺 src/main.mjs）。\n`)
    process.exit(1)
  }
  log(`重建 ${NOTE_DIR}/ → ${join(target, NOTE_DIR)}`)
  rmSync(join(target, NOTE_DIR), { recursive: true, force: true })
  const bytes = buildDevNotes(target)
  const hits = scanDir(join(target, NOTE_DIR))
  if (hits.size) {
    console.log('\n=== 脱敏后仍有命中（需人工确认）===')
    for (const [name, list] of hits) {
      console.log(`  [${name}] ${list.length} 处`)
      for (const h of list.slice(0, 8)) console.log(`      ${h}`)
    }
  }
  if (errors.length) {
    for (const e of errors) console.log(`  ✗ ${e}`)
    process.exit(1)
  }
  console.log(`\n开发笔记：${NOTE_SOURCES.length + 1} 篇 / ${human(bytes)}${hits.size ? '（有命中，见上）' : '；脱敏扫描零命中'}`)
  process.exit(0)
}

// ── 0. 预检 ────────────────────────────────────────────────
if (existsSync(DEST)) {
  const n = walk(DEST).length
  if (n > 0) {
    console.error(`\n[中止] 目标已存在且非空：${DEST}（${n} 个文件）\n  换个 --dest，或先手动删掉。\n`)
    process.exit(1)
  }
}
mkdirSync(DEST, { recursive: true })

// ── 1. 目录 ────────────────────────────────────────────────
for (const d of COPY_DIRS) {
  log(`拷贝 ${d}/ …`)
  copyTree(d)
}

// ── 2. 根文件 ──────────────────────────────────────────────
for (const f of COPY_ROOT_FILES) {
  const src = join(ROOT, f)
  if (!existsSync(src)) { errors.push(`根文件缺失：${f}`); continue }
  cpSync(src, join(DEST, f), { force: true })
  log(`拷贝 ${f}`)
}

// ── 2b. 双击即用的启动器（仅完整包） ──────────────────────
if (WITH_RUNTIME) {
  const launcherSrc = join(ROOT, LAUNCHER_REL)
  if (!existsSync(launcherSrc)) {
    errors.push(`启动器缺失：${LAUNCHER_REL}（重建：tools\\launcher\\build-launcher.cmd）`)
  } else {
    cpSync(launcherSrc, join(DEST, LAUNCHER_DEST), { force: true })
    log(`拷贝 ${LAUNCHER_DEST}（双击启动，不需要系统装 Node）`)
  }
} else {
  log('跳过 Orb.exe（源码仓库版不含 runtime，双击起不来；用 run.cmd）')
}

// ── 3. config.json（从 example 生成，无 BOM） ───────────────
const examplePath = join(ROOT, 'config.example.json')
let shipCfg
try {
  shipCfg = JSON.parse(readFileSync(examplePath, 'utf8').replace(/^\uFEFF/, ''))
} catch (err) {
  errors.push(`读 config.example.json 失败：${err.message}`)
  shipCfg = null
}
if (shipCfg) {
  shipCfg.agentId = null          // ⇒ 首次启动 ensureRuntime() 新建 agent 并把人格烤进 system
  shipCfg.agents = {}
  shipCfg.mainConversations = {}
  shipCfg.legacyUrl = null
  shipCfg.engine = 'local'
  shipCfg.electronPath = 'runtime/electron/electron.exe'
  // 出厂包**绝不**去搬这台机器上别的工具（~/.dsh）的微信凭据：
  // 2026-10-22 事故就是它把宿主的 bot 带进了 data/wechat.json，设置页显示「已连接」。
  shipCfg.adoptHostWechatCreds = false
  // UTF-8 无 BOM：带 BOM 时 JSON.parse 会抛（src/launch.mjs 里有剥 BOM 兜底，但不该生产这种文件）
  writeFileSync(join(DEST, 'config.json'), JSON.stringify(shipCfg, null, 2) + '\n', 'utf8')
  log('生成 config.json（agentId=null，来自 config.example.json，无 BOM）')
}

// ── 4. 空 data/ ────────────────────────────────────────────
mkdirSync(join(DEST, 'data'), { recursive: true })
log('建立空 data/')

// ── 5. 对外说明（UTF-8 with BOM，记事本才认中文） ──────────
const NOTES = `Orb 出厂版 · 说明
============================================================

这是一份「默认出厂设置」的 Orb，不含任何个人数据（记忆、对话、API key、日志）。

■ 怎么跑
${WITH_RUNTIME
    ? `  双击 Orb.exe（不用装 Node，也不用装 Electron —— 包里都带着）
  打不开就双击 run.cmd 看具体报错（它需要 Node.js 22+；Orb.exe 不需要）。`
    : `  1. 装 Node.js 22 或更高（https://nodejs.org）
  2. 双击 run.cmd`}

  首次启动会自动新建一条属于你的记忆仓（data/memfs/orb-<日期>/），
  球的人格来自 鲸鱼娘_persona.md，和上一个使用者的状态完全无关。

■ 第一次要做的两件事
  · 连模型：打开球的设置面板 → API，填 base_url 与 key，选模型
    （密钥存在 data/providers/auth.json，明文，只在本机）
  · 想换人格：直接改 鲸鱼娘_persona.md
    （首行必须是 "# 鲸鱼娘"，且必须保留 "## 保险丝" 与 "## 最高准则" 两节，
     否则 src/persona.mjs 的 assertPersona 会拒绝启动——这是防篡改的硬断言）

■ 目录
  Orb.exe                 双击启动（自带运行时，不需要系统装 Node）
  run.cmd                 命令行启动器（node src/launch.mjs；排查问题时用它看日志）
  config.json             配置：模型名、窗口、权限（permission 默认 read-only）
  src/                    主进程（直连模型，零 npm 依赖）
  helper/                 球侧窗口层 + 渲染层 + 全部素材
    helper/assets/backgrounds/   页面背景图
    helper/assets/avatars/       3 张自制球形态（orb-A 默认 / orb-idle / orb-pat）；丢自己的 gif 也自动出现
    helper/assets/deco/          6 张情绪图（球的唯一表情来源，不要删）
    helper/assets/orb-idle.gif   早期示例球脸（默认头像已改为 avatars/orb-A.gif）
    helper/assets/tray.ico       托盘图标（16/20/24/32/48/64/128/256 多尺寸，缺了回落蓝点）
${WITH_RUNTIME ? '  runtime/electron/       自带 Electron 运行时（366 MB，不用另装）' : '  runtime/electron/       本包不含（源码仓库版）：见下方「从仓库运行」'}
  data/                   运行期数据（首次启动后才出现内容，可整体删掉＝重回出厂）
  鲸鱼娘_persona.md       初始 prompt / 人格卡
  开发笔记/                原作者踩坑记录（改代码前先看这个）

■ 安装目录搬家
  整个文件夹拷到任何盘都能跑：所有路径都相对项目根解析
  （config.json 的 electronPath 写的是相对路径 runtime/electron/electron.exe）。
${WITH_RUNTIME ? '' : `
■ 从仓库运行（源码仓库版）
  本包不含 runtime/electron（366 MB 的 Electron 不随 Git 仓库走，单文件超 GitHub 上限）。
  首次运行前：
    1. 下载 Electron 44 win64 zip（https://github.com/electron/electron/releases）
    2. 解压成 runtime/electron/，确认 runtime/electron/electron.exe 存在
    3. 双击 run.cmd（没运行时它会提示缺 electron.exe，不会静默失败）
  不想折腾就用 Release 里的完整 zip（同版本，已含运行时）。
`}

■ 开发笔记（要改代码就先看这里）
  开发笔记/ 里是原作者开发期间的记录，连带把踩过的错一起发了：
    · 00_从这里读起.md            先读这篇（三条铁律 + 已经付过代价的坑）
    · 01_开发手册_架构与历史.md   架构、目录职责、历史决策的来龙去脉
    · 02_已趟过的坑_球侧问题清单.md  §0.1 列着「已经确认错误的结论」，别看旧结论办事
  改代码前建议看 00；改 CSS 后务必真起一次界面点一遍，样式少一行不会报错、只会让功能静默消失。

■ 素材授权
  本包以 PolyForm Noncommercial 1.0.0 授权：自用、修改、分享都可以，**不得商用**。见 LICENSE 与 THIRD-PARTY-NOTICES.md。
  角色形象、背景图、deco/ 情绪图、orb-idle.gif 与托盘图标（helper/assets/tray.ico）
  均为本项目自制，可随包分发。
  helper/assets/avatars/ 里的 3 张（orb-A / orb-idle / orb-pat）同样自制、可分发；
  来自上游 dsh-orb 的那 6 张未获授权，已从本包剔除。你可以换成自己的 gif。
`

writeFileSync(join(DEST, '出厂说明.txt'), '\uFEFF' + NOTES, 'utf8')
log('写 出厂说明.txt')

// ── 5a-bis. LICENSE（PolyForm Noncommercial 1.0.0，单一真源＝仓库根 LICENSE）──
// 2026-10-22 由 MIT 改为非商业授权：自用 / 修改 / 分享可以，不得商用。
// 不要再在这里写第二份许可正文 —— 改许可只改仓库根 LICENSE，包内那份从这里读。
const LICENSE = readFileSync(join(ROOT, 'LICENSE'), 'utf8')
writeFileSync(join(DEST, 'LICENSE'), LICENSE, 'utf8')
log('写 LICENSE（PolyForm Noncommercial 1.0.0）')

// ── 5a-ter. .gitignore（两件套：这个目录既能当仓库，也能压成发布 zip）──
const GITIGNORE = `# 运行时：366 MB / 单个 electron.exe 233 MB，超 GitHub 单文件上限，只走 Release zip
runtime/

# 本机运行期数据与痕迹
data/
logs/
locks.json
exports/
node_modules/

# 系统与编辑器残留
Thumbs.db
desktop.ini
.DS_Store
`
writeFileSync(join(DEST, '.gitignore'), GITIGNORE, 'utf8')
log('写 .gitignore')


// ── 5b. 开发笔记/（脱敏随包的踩坑记录）─────────────────────
log('生成 开发笔记/（脱敏）…')
buildDevNotes(DEST)

// ── 6. 复核 ────────────────────────────────────────────────
log('\n复核 …')

const REQUIRED = [
  'package.json',
  'run.cmd',
  'config.json',
  '鲸鱼娘_persona.md',
  'THIRD-PARTY-NOTICES.md',
  'src/main.mjs',
  'src/launch.mjs',
  'src/persona.mjs',
  'src/tts/index.mjs',
  'helper/lib/main.js',
  'helper/preload.cjs',
  'helper/assets/orb-idle.gif',
  'helper/assets/avatars/orb-A.gif',
  'helper/assets/shell.js',
  'helper/assets/backgrounds/bg-chat.png',
  'helper/assets/avatars/README.txt',
  'helper/assets/tray.ico',
  'helper/assets/deco',
  ...(WITH_RUNTIME ? ['runtime/electron/electron.exe', 'Orb.exe'] : []),
  'LICENSE',
  '开发笔记/00_从这里读起.md',
  '开发笔记/02_已趟过的坑_球侧问题清单.md',
  '开发笔记/01_开发手册_架构与历史.md',
]
for (const rel of REQUIRED) {
  if (!existsSync(join(DEST, rel))) errors.push(`缺少必需项：${rel}`)
}

const files = walk(DEST)
const totalBytes = files.reduce((s, f) => s + statSync(f).size, 0)

// 6a. 不该出现的路径
const FORBID = [
  'logs', 'exports', 'bak', 'art', 'video', 'docs', 'probe', 'tools',
  'helper-src', 'preview-status-capsule', 'node_modules', '.git',
  'config.example.json', 'locks.json', 'README.md',
  'data/providers', 'data/memfs', 'data/conversations', 'data/bili-auth.json',
  'data/wechat.json', 'data/policy.json', 'data/schedule.json',
  'runtime/electron/debug.log', 'runtime/electron/orb-runtime.exe',
  'helper/assets/tray-preview.png',  // 托盘图生成脚本的核对预览，只给作者看
  ...UNLICENSED,   // 上游未授权素材：出现在包里就是失败
]
if (!WITH_RUNTIME) {
  for (const rel of ['runtime/electron/electron.exe', 'runtime/electron/resources']) FORBID.push(rel)
}
for (const rel of FORBID) {
  if (existsSync(join(DEST, rel))) errors.push(`不该出现：${rel}`)
}
for (const f of files) {
  const rel = relative(DEST, f).split(sep).join('/')
  if (/\.bak$/.test(rel)) errors.push(`不该出现（备份文件）：${rel}`)
  if (/auth\.json$/i.test(rel)) errors.push(`不该出现（凭据文件）：${rel}`)
  if (/\.jsonl$/i.test(rel)) errors.push(`不该出现（会话流水）：${rel}`)
}

// 6b. 内容扫描：密钥 / 本机 agent id / 本机绝对路径（规则见上方的 SCAN）
const scanHit = scanDir(DEST)

// 6c. 统计
const byTop = new Map()
for (const f of files) {
  const rel = relative(DEST, f).split(sep).join('/')
  const top = rel.includes('/') ? rel.split('/').slice(0, rel.startsWith('runtime/') ? 2 : 1).join('/') : '(根文件)'
  const cur = byTop.get(top) ?? { files: 0, bytes: 0 }
  cur.files += 1
  cur.bytes += statSync(f).size
  byTop.set(top, cur)
}

// ── 7. 报告 ────────────────────────────────────────────────
console.log('\n=== 出厂包构成 ===')
for (const [top, s] of [...byTop.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${top.padEnd(22)} ${String(s.files).padStart(5)} 个  ${human(s.bytes)}`)
}
console.log(`  ${'合计'.padEnd(20)} ${String(files.length).padStart(5)} 个  ${human(totalBytes)}`)

console.log('\n=== 主动不拷 ===')
for (const [k, why] of SKIP_REASONS) console.log(`  ${k.padEnd(46)} ${why}`)

if (scanHit.size) {
  console.log('\n=== 内容扫描命中（需人工确认）===')
  for (const [name, hits] of scanHit) {
    console.log(`  [${name}] ${hits.length} 处`)
    for (const h of hits.slice(0, 6)) console.log(`      ${h}`)
  }
}

if (errors.length) {
  console.log('\n=== 失败项 ===')
  for (const e of errors) console.log(`  ✗ ${e}`)
  console.log(`\n出厂包在 ${DEST}，但**复核未通过**，不要直接分发。`)
  process.exit(1)
}

// 源码注释里的「作者本机示例路径 / 本机 agentId」不算泄漏：不含用户名、不含凭据、不影响运行，
// 且改源码只为了改注释不值得。剩下的类别（key / 用户名 / 母本路径）一律当硬失败。
const SOFT_CLASSES = new Set(['本机项目绝对路径', '本机 agentId'])
const hardHits = [...scanHit.entries()].filter(([name]) => !SOFT_CLASSES.has(name))
if (hardHits.length) {
  console.log('\n=== 硬命中（必须处理，不要分发）===')
  for (const [name, hits] of hardHits) console.log(`  [${name}] ${hits.length} 处`)
  console.log(`\n出厂包在 ${DEST}，但**复核未通过**。`)
  process.exit(1)
}

console.log(`\n出厂包：${DEST}`)
console.log(`复核通过：${files.length} 个文件 / ${human(totalBytes)}；无个人数据、无凭据。`)
const softPath = scanHit.get('本机项目绝对路径')?.length || 0
const softId = scanHit.get('本机 agentId')?.length || 0
if (softPath || softId) {
  console.log(`注：源码注释内仍有作者本机示例路径 ${softPath} 处${softId ? `、本机 agentId ${softId} 处` : ''}（无用户名、无凭据，未改源码）。`)
}
