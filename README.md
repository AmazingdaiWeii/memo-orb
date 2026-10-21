# Orb —— 交接文档

> **2026-10-19 重大变更（阅读下文前必看）**：旧后端已被整体剥离。`package.json` 现在**零依赖**，`node_modules/` 已删除（释放 454 MB），后端换成自建的 `src/llm.mjs` + `src/brain.mjs` + `src/memstore-local.mjs` + `src/snapshot.mjs` + `src/compact.mjs`，数据根改为项目内 `data/`。本文档下方「大脑：旧后端」等描述均为**剥离前的历史记录**，现状见 `docs/长记忆形态_v1_定稿_2026-10-19.md`。

> 交接时间：2026-10-06（原始项目 2026-10-06 建立，同日迁入本工作区）  
> **项目根目录：`E:\Memo orb`**（就是本仓库根，自此项目与工作区合一）
> 上游来源：`E:\dsh-workspace\02_插件开发\dsh-orb-cordis`（DSH 的悬浮球插件，**只读参考，不要改**）

---

## 〇、素材与署名（开源分发必读）

- **原 `dsh_orb` 的球体素材未获原作者授权，已从仓库移除。** 备份在 `bak/assets-original-20261021-185642/`（只作本地回退用，**不要提交、不要随发布包分发**）。
- 仓库自带**一张示例球脸**：`helper/assets/orb-idle.gif`（本项目自绘 + AI 生成 + 程序合成的 GIF，1.44MB）。
- **另自带 12 张作者自制的 GIF**（与上游无关，随仓库正常分发）：6 张球形态在 `helper/assets/avatars/`（smile / cheer / cheeks / heart / point / rice），6 张情绪装饰在 `helper/assets/deco/`（idle / thinking / happy / shy / sad / surprised）。**情绪图是球的唯一表情来源，不要删。**
- **用户可以自行导入**：把任意 `*.gif` 丢进 `helper/assets/avatars/`，环菜单「换形象」会自动列出来，**不需要改任何配置**。
  规格与命名规则见 `docs/素材说明_开源版_2026-10-21.md`。
- 角色形象、命名与界面美术均为本项目自有，与上游 `dsh-orb` 及其作者无关。二次分发时请确认没有残留的第三方素材。

---

## 一、这是什么

一个**完全独立于 DSH（DeepSeek Harness）启动的桌面悬浮球助手**。

- **前端/窗口**：自绘球体（`helper/`），不再复用上游素材
- **大脑**：本机自建引擎（`src/brain.mjs` + `src/llm.mjs` + 一份 git 版本化的 markdown 记忆仓）—— 2026-10-19 起已整体剥离旧后端，`package.json` 零依赖
- **两者关系**：球只是壳，记忆与回合都在本机跑；除了模型接口，不需要任何外部服务

用户的三条硬性要求（不可违背）：

1. **必须独立于 DSH 启动**，不能依赖 DSH 进程
2. **不能干扰 DSH 的正常使用**，不能占其它 agent 的端口
3. **轻量化**，预算 500MB 量级（已确认可接受）

用户已确认的其它决策：

- 大脑：**自建引擎**（不再依赖旧后端）
- 第一阶段范围：**悬浮球 + 对话流 + 流式输出**（不含 API 配置页、花费插件、记忆层）
- 球视觉：**上游球脸剥离在外；仓库自带一张自产示例 + 作者自制的 6 张球形态与 6 张情绪图，用户可自行替换**（见 §0）

---

## 二、怎么跑

```
双击 E:\Memo orb\run.cmd
（等价于 node src\launch.mjs；失败会pause 住不闪退）
```

配置全在 `config.json`：

```json
{
  "model": "openai-compatible/deepseek-flash",
  "agentName": "Orb",
  "theme": "dark",
  "locale": "zh",
  "agentId": null,
  "electronPath": "runtime/electron/electron.exe",
  "electronFlags": []
}
```

> `electronPath` **支持相对路径，一律相对项目根解析**（`src/launch.mjs` 里的 `resolve(ROOT, …)`）。
> 所以整个目录搬到任何盘都能直接跑，不用改配置。

运行时可选字段：

- `engine`：`local`（默认，自建引擎直连模型）或 `legacy`（旧后端，适配层仍在但早已跑不起来，仅作历史保留）
- `legacyUrl`：**仅 `engine=legacy` 时有意义**，填了就连已在运行的旧后端（`ws://127.0.0.1:PORT/ws`）；local 引擎不看这个字段
- `permission`：球权限档位，会被球上的下拉改写并持久化（见下）

**环境依赖**：Node ≥ 22.19 + 一个 Electron 运行时（仓库自带 `runtime/electron/`）。**零 npm 依赖**。  
模型接口的 key 在 `data/providers/auth.json`（首次运行时由设置页的「API」分组写入，不用手工改文件）。

### 从旧位置迁到这里时，做了哪些「独立性」加固

| 项 | 迁前 | 迁后 |
|---|---|---|
| 项目位置 | `E:\dsh-workspace\02_插件开发\orb-standalone` | `E:\Memo orb` |
| Electron 运行时 | **借用** `E:\dsh-home\dsh-orb\electron-runtime`（DSH 宿主下载的） | **自带副本** `runtime/electron/`（367MB） |
| `electronPath` | 绝对路径 `E:/dsh-home/...` | 相对路径 `runtime/electron/electron.exe` |
| Electron 用户数据 | `%LOCALAPPDATA%\orb-standalone` | `%LOCALAPPDATA%\orb` |
| probe 脚本路径 | 硬编码 `E:/orb-probe/...` | 全部相对项目根解析 |

**为什么必须切断 electron 运行时**：迁前 orb 会往 DSH home 的electron 目录里写 `debug.log`，
和 DSH 插件抢同一个 Electron 安装 —— DSH 升级/重装运行时会把 orb 一起弄坏，orb 崩溃也可能污染 DSH 的目录。
「独立」要独立到底。

---

## 三、架构

一个 Electron 进程里同时干两件事：

```
┌─────────────────────────── Electron 主进程 ───────────────────────────┐
│                                                                       │
│  【当 Host】                                                          │
│    createServer().listen(0)  ← 球的控制 socket（动态端口，永不撞口）  │
│    负责：把旧后端的 stream_delta 翻译成球的 block 消息               │
│                                                                       │
│  【当球】                                                             │
│    await import(helper/lib/main.js)│
│    ← helper 是上游 dsh-orb 的窗口/渲染层，原样复用                     │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
        │                                              │
        │ 本机回环 NDJSON（随机 32 字节 token 鉴权）    │ spawn
        ▼                                              ▼
   helper 窗口（球 + 对话流）                    legacy server --listen（动态端口）
```

### 启动顺序（很重要，别调换）

`helper/lib/main.js` 在**模块顶层**读 `ORB_SOCKET` / `ORB_TOKEN`，读不到就直接 `exit(1)`。
所以必须**先把 socket 起来、把环境变量设好，再import 它**：

```js
// src/main.mjs 的 boot()
await new Promise((resolve, reject) => {
  ballServer.once('error', reject)
  ballServer.listen(0, '127.0.0.1', resolve)      // 动态端口
})
process.env.ORB_SOCKET = `127.0.0.1:${port}`
process.env.ORB_TOKEN = token
process.env.ORB_WEB_PORT = ''
process.env.ORB_APPEARANCE = JSON.stringify({ theme, locale })
await import(pathToFileURL(HELPER_MAIN).href)     // ← env 必须在这之前设好
void startLegacy()
```

### 文件地图

| 路径                                  | 作用                                                              |
| ----------------------------------- | --------------------------------------------------------------- |
| `src/main.mjs`                      | **核心**。主进程入口：Host + 球 + 协议翻译                                    |
| `src/legacy-engine.mjs`                     | 拉起 `legacy server`（解析动态端口）+ WebSocket 客户端（按 `request_id` 关联响应）   |
| `src/launch.mjs`                    | 启动器。用**普通 Node** 跑，这样启动失败能看到报错而不是窗口一闪而过                         |
| `helper/`                           | 从 `dsh-orb-cordis/packages/bundle/dist/helper` 复制来的球（窗口层 + 渲染层）           |
| `helper/lib/main.js`                | 窗口层（**minified**，由上游 `src/*.ts` 编译而来）                           |
| `helper/assets/*.js\|css\|html`     | 渲染层（**未压缩的可读源码**，可直接改）                                          |
| `helper/assets/backgrounds/`        | **用户导入的三个页面背景**（主题页导入时复制进来，命名 `bg-<slot>-<时间戳>.<ext>`；槽位 `chat`/`history`/`recall`） |
| `runtime/electron/`                 | **自带**的 Electron 运行时（44.0.0，从 DSH home 复制而来后已脱钩）              |
| `config.json`                       | 配置                                                              |
| `logs/orb.log`                      | 运行日志（**排障第一入口**）                                                |
| `src/persona.mjs`                   | 读 persona 文件（注入 agent 的 `system`）                                  |
| `src/history.mjs`                   | 扫盘读历史会话（协议**没有**「列出所有 conversation」，只能扫磁盘）                       |
| `src/memory.mjs`                    | 读记忆仓库（列表 / 读文件 / 搜索 / 取某一版）                                     |
| `src/lock.mjs`                      | 对话加密·状态层（强锁 scrypt 哈希 / 软锁只存指针，**零凭证存储**）                        |
| `src/lock-flow.mjs`                 | 对话加密·流程层（何时锁 / 给球看什么 / 怎么判）                                     |
| `src/impression.mjs`                | **记忆中心**·纯逻辑（到没到期判定、frontmatter 守卫、cron 任务选取）                     |
| `src/mood.mjs`                      | **情绪 GIF**·纯逻辑（标记提取剥离、情绪词表、素材改名规则）                              |
| `src/bili-auth.mjs` / `bili-media.mjs` / `bili-watch.mjs` | **B 站**：扫码登录态 → 认片/取直链 → 取关键帧（组合层，brain 只跟 `bili-watch` 说话） |
| `src/bili-history.mjs`              | **看过的视频**账本（`data/bili-history.json`）：`bili_watch` 成功即记一条，抽屉与 `bili_history` 工具共用同一份 |
| `src/balance.mjs`                   | **账户余额**（问服务商 `/user/balance`，5 分钟缓存）。她靠这个自己决定贵的事做不做、怎么做 |
| `helper/assets/deco/`               | 装饰 GIF（六个情绪，**UI 助手的图层用**；由 `tools/copy-deco.mjs` 从 `deco-plan/output/` 拷来） |
| `tools/copy-deco.mjs`               | 把美术素材改成球能加载的文件名（球侧正则只吃小写安全字符，否则**静默丢弃**）                     |
| `tools/reset-to-factory.mjs`        | **出厂化重置**：清记忆/人格/对话/锁，默认预演、默认先备份（见 `docs/待办事项.md` P0-8）         |
| `factory_reset.cmd`                 | 出厂化的双击入口（菜单式，1/2 预演，3/4 才真动手）                                   |
| `reset_memory.cmd`                  | 只清记忆与对话（保留 agent / 人格 / config / 锁）                             |
| `build.ps1`                         | 打包成便携 `dist/`；**从 `config.example.json` 生成干净 config**，并做泄漏检查        |
| `deco-plan/`                        | 装饰 GIF 的生成计划、参考图、成品（见该目录 `TASKS.md` / `CONFIG.md`）              |
| `probe/`                            | 探针与测试脚本（见下）                                                     |
| `docs/`                             | **全部文档**（见下「文档地图」）                        |
| `tools/`                            | 一次性脚本（打包、出厂化、asar 解包、素材拷贝、锁演示）                          |
| `鲸鱼娘_persona.md`（根）                 | **运行期正本**：`src/persona.mjs` 读它注入 agent 的 `system`，**不能移进 docs/**    |

> ★★ **`.cmd` 一律写成纯 ASCII（0 个 > 0x7F 的字节）。**
> 新起的 `cmd.exe` 默认是 936 代码页，第二行的 `chcp 65001` **来不及** ——
> cmd 是按行流式解码批处理的，中文被按 GBK 误读后内部文件偏移会漂移，
> **把后面几行（含 `node` / `pause`）整个吞掉**，症状是「窗口一闪就关」且无报错。
> 中文解释写进 `.md`；中文运行时输出交给 Node 打印（真控制台上正常）。
> 自查：`node -e "console.log([...require('fs').readFileSync('x.cmd')].filter(b=>b>127).length)"` → 必须是 `0`。

### 文档地图（`docs/`）

根目录只留 `README.md`、`鲸鱼娘_persona.md` 与运行期文件（`config.json` / `.cmd` / `.ps1`）；所有方案/报告/待办都在 `docs/`：

| 类别 | 文档 |
| --- | --- |
| 交接与总览 | `README.open.md`、`功能落地_交接文档.md`、`迁移记录.md` |
| 待办与状态 | `收尾待办.md`（**离完成最近**）、`docs/待办事项.md`（全量+踩坑）、`待测清单.md`、`未完成事项盘点_2026-10-07.md` |
| 方案设计 | `豆包式双模式_落地方案.md`、`对话加密_落地方案.md`、`记忆中心_落地方案.md`、`对话风格_反AI感设计.md`、`docs/UI重构指南.md`、`情绪GIF_验证方案.md`、`官方功能可用性与省token方案.md` |
| 报告与取证 | `环形菜单复刻_MateEngine样式_2026-10-08.md`（**环形菜单主线**）、`主对话与上下文压缩_2026-10-08.md`（**主对话与压缩主线**：主对话口径、上下文压缩提示行、压缩即沉淀方案A、API 页思考与上下文窗口上限）、`勘察报告_环形菜单与美化现状_2026-10-07.md`、`MateEngine_环形菜单_取证报告.md`、`复刻与自制_合规说明.md`、`实测报告.md`、`实测报告_v1.4.md`、`docs/参考-协议与踩坑.md`、`参考-WorkBuddy图片实现.md` |
| persona | `鲸鱼娘_persona_Loomy版.md`、`persona_v2.1_vs_Loomy版_对照裁决.md` |
| 路线纪要 | `情绪可视化与人格交换_讨论纪要_2026-10-08.md`（**下一阶段主线**：情绪信号→VRM 桌宠 / 人格卡与社群交换。⚠️ 取证到 `.af` **已从 legacy-code 移除**；推翻多个旧结论——双模式 400 行残留**别拆**（且仍可达）、`history.lock` B1 **已接线应销账**、`_inject_v2.ps1` **已作废**。§2.5 记录了 persona **v3 第四批「我的脸」情绪通道**已落文档未注入） |
| 测试 | `测试提示词.md` |
| 打包 | `打包独立化可行性评估_2026-10-08.md` |

（`docs/` 里的历史设计文档按「不改」原则原样保留，其中部分结论已被后续实现推翻。）

### 与 DSH 的关系（重要）

DSH 里跑的 `dsh-orb` 插件装在 `E:\dsh-home\profiles\desktop\node_modules\dsh-orb`（npm 装的独立副本）。
本项目的 `helper/` 是**手工复制的另一份**，两者**互不共享文件**。

-改本项目的 `helper/` → 只影响 orb 独立版，**不影响 DSH 里的球**
- 改上游 `dsh-orb-cordis/` → **也不会**自动影响 DSH 里已装的插件（它是构建源，不是运行副本）
-唯一真正的共享点是 **Electron 运行时**，已经通过自带副本切断了（见第二节）

### 测试/探针（`probe/`）

> ⚠️ **本节两张表是历史记录**：凡是「起旧后端 / 直接对旧后端发协议帧」的脚本（`one-shot-test.mjs`、`e2e-visual.mjs`、`legacy-external.mjs`、`legacy-probe.mjs`、`isolate-open-bug.mjs`）已随旧后端一起删除。
> **现役探针**：`real-local-smoke.mjs`（真机冒烟，最重要）、`bili-*`、`qr-verify.mjs`、`*-unit.mjs`、`shell-boot-smoke.cjs`。

| 脚本                   | 作用                                              |
| -------------------- | ----------------------------------------------- |
| `one-shot-test.mjs`  | **回归测试首选**：一条命令跑完整链路（起旧后端 → 改 config → 起 orb → 两轮连发 → 第 2 轮收尾后截图 + 折叠态诊断）。沙箱里后台活不过单条命令，所以这些必须串在一条命令里 |
| `e2e-visual.mjs`     | 端到端验证：起旧后端 → 起 orb → 自动发一句 → 截图 → 清理现场             |
| `legacy-external.mjs` | 在普通 Node 里起旧后端服务端，把 ws 地址写到文件（Electron 里直接起会被 `spawn EPERM` 拦）|
| `legacy-probe.mjs`    | 纯 Node 的旧后端协议探针（零依赖），用来摸 delta 形状           |
| `reasoning-test.mjs` | 专门验证 reasoning delta 的编排脚本                      |
| `host-probe.mjs`     | 最早用来证明「球能脱离 DSH 独立启动」的最小 Host                   |
| `lock-test.mjs` / `lock-flow-test.mjs` | 对话加密·纯逻辑（58 + 59 条）                              |
| `lock-wire-probe.mjs` | 对话加密·走真 socket（21 条）                                  |
| `lock-ui-test.mjs` | 对话加密·**真渲染层**（71 条；jsdom 里跑真 shell.js + 真 floating.html，API 用 Proxy 自动应答） |
| `image-attach-test.mjs` | 发送图片·**真渲染层**（71 条；jsdom 里跑真 shell.js，canvas/createImageBitmap/objectURL 打桩但**产品逻辑全走真代码**） |
| `image-wire-probe.mjs` | 发送图片·**上送链路**（26 条；preload → helper/lib/main.js → src/main.mjs 三段源码断言，专抓「跨进程静默丢字段」） |
| `mode-wire-probe.mjs` | ~~双模式 host 侧（44 条）~~ 🔴 **已作废**（2026-10-07 双模式取消）                   |
| `impression-test.mjs` | 记忆中心·纯逻辑（128 条）                                      |
| `impression-wire-probe.mjs` | 记忆中心·端到端（走真 socket，会**真的跑一次印象整理**）                 |
| `mood-test.mjs` | 情绪 GIF·纯逻辑（131 条；**正则从 `helper/lib/main.js` 现读**，不抄一份）    |
| `mood-wire-probe.mjs` | 情绪 GIF·端到端（走真 socket，验「标记绝不漏进正文」+ 半截标记不漏）           |
| `webview2-probe.py`  | WebView2 路线的占用对照实验（历史遗留）                        |

`one-shot-test.mjs` 用法（回归测试就跑这个）：

```bash
node probe/one-shot-test.mjs
```

它会自动把 `config.json` 的 `legacyUrl` 指向自己起的旧后端，**跑完不会还原**（下次跑会再改一次）。
判定标准看 `logs/orb.log`：只出现一个 `runtime 就绪`；每条消息各有一次 `已发出` + 一次 `回合结束`；
最后一条 `loop_status=WAITING_ON_INPUT` 且队列为空。

`e2e-visual.mjs` 用法：

```bash
E2E_WAIT=90000 E2E_PROMPT="你的问题" node probe/e2e-visual.mjs
```

它会自动：备份 `config.json` → 注入 `legacyUrl` → 启动 orb（带 `ORB_SELFTEST` 自动输入、`ORB_SHOT` 定时截图）→ 等 → 杀进程树 → 还原 `config.json`。

### 探针清单

| 脚本 | 验什么 | 怎么跑 |
|---|---|---|
| `one-shot-test.mjs` | 常规对话链路（回归主力） | `node probe/one-shot-test.mjs` |
| `window-probe.mjs` | 窗口可调大小 + 尺寸持久化 | `node probe/window-probe.mjs` |
| `history-test.mjs` | 历史对话**数据层**（读盘、剥 system-reminder、还原块） | `node probe/history-test.mjs` |
| `history-e2e.mjs` | 历史对话**端到端**（冒充球走socket 收发） | `node probe/history-e2e.mjs` |
| `isolate-open-bug.mjs` | 直接对旧后端发协议帧，隔离「切会话」问题 | `node probe/isolate-open-bug.mjs [convId]` |
| `image-attach-test.mjs` | 发送图片·**球侧四步**（收进来 / 画出来 / 删得掉 / 送得走） | `node probe/image-attach-test.mjs` |
| `image-wire-probe.mjs` | 发送图片·**跨进程不丢字段**（preload → helper → src 三段） | `node probe/image-wire-probe.mjs` |
| `ring-geometry-test.mjs` | 环形菜单·几何纯函数（40 条） | `node probe/ring-geometry-test.mjs` |
| `ring-interaction-test.mjs` | 环形菜单·源码契约（69 条；含 §F–§J 与 7 条反向对照。B3 是**需求类断言**：左键必须「点一下钉住」，出处=用户 m01764 反翻 m00827；§J 是真 `import` `backgrounds.js` 验背景白名单与槽映射） | `node probe/ring-interaction-test.mjs` |
| `ring-menu-layout.cjs` | 环形菜单·**真 Electron 真窗口**（36 条；DPI 1.0 / 1.5 各一趟。跑前必须 `Remove-Item Env:ELECTRON_RUN_AS_NODE`，用 `Start-Process … -PassThru` + 轮询 `HasExited`，`-Wait` 会卡死） | `& runtime\electron\electron.exe probe\ring-menu-layout.cjs` |
| `shell-boot-smoke.cjs` | **渲染层装配冒烟**（29 条；真渲染进程 + 真点击 + 真拖拽 + 真 IPC，专抓「初始化期抛错 ⇒ 所有监听没注册」与「手柄贴在哪」。2026-10-08 左键/拖动全死那次事故的产物；S14–S22 覆盖主题页与三个页面背景，S23–S27 覆盖上下文压缩提示行（`kind=notice`）与 API 页「思考 / 上下文窗口上限」（点保存真的发出 `orb:api-config-set`，且没动过的字段不进 patch），详见 `docs/环形菜单复刻_MateEngine样式_2026-10-08.md` §11、§12、§13） | `& runtime\electron\electron.exe probe\shell-boot-smoke.cjs` |
| `main-runtime-once-test.mjs` | 渲染层装配**幂等性**（9 条；jsdom 里真 import 产品模块跑一遍 `main()`，再调一次装配量不得翻倍。注意它尾部必须无条件 `process.exit`，否则全绿时会一直挂着不退出） | `node probe/main-runtime-once-test.mjs` |
| `context-compaction-test.mjs` | 主对话与上下文压缩·**源码契约**（42 条；A 压缩 delta 接线 / B 文案生成器 / C 会话归属闸门 / D 球侧 `kind=notice` 渲染 / E 压缩即沉淀方案A / F `ORB_FAKE_COMPACTION` 注入点 / G 主对话挂回） | `node probe/context-compaction-test.mjs` |
| `model-settings-test.mjs` | API 页模型设置·**源码契约 + 内存 fs 上真跑两个 ipc handler**（51 条；思考开关开/关、`context_window_limit` 写入/清空/边界/非法值不落盘、chat+work 两个 agent 都改、写前备份可回滚） | `node probe/model-settings-test.mjs` |

> **写探针的第六条纪律（2026-10-08 新增，专治「断言自己过时」）**：
> 断言分两类 —— **不变量**（几何合法性、幂等性）与**需求**（交互手感、默认行为）。
> 需求类断言必须在注释里写清出处（`用户 mXXXXX`）：需求一反向，它就是一条必须**翻面**的红，
> 而不是「产品坏了」。实测：`ring-interaction-test.mjs` 的 B3 把「不许钉住」（m00827）写成契约，
> 用户 m01764 要回「点一下钉住」时，红的正是这条断言自己。
> 另：**jsdom 类探针测不到「贴在哪」** —— 没有布局引擎、`getBoundingClientRect()` 恒 0，
> 几何只能正则匹配源码字符串。手柄命中区与面板可见边界相差 12px 这种错位，
> 只有真浏览器（`shell-boot-smoke.cjs` 的 S9b）能量出来。

> **写探针的第四条纪律（2026-10-08 新增，专治「跨进程静默丢字段」）**：
> 记录型桩（`Proxy` 记下 `api.send` 的实参）**测不出 preload 有没有真的转发**。
> 凡是「渲染层 → preload → 主进程」的多跳链路，**必须再有一条源码断言型探针**
> 盯着每一跳的字段名与分支存在性（`image-wire-probe.mjs` 就是这条纪律的产物）。
> 这类 bug 的共同症状是「日志全正常、零报错、点了没反应」——
> 与主进程 `ReferenceError` 掐断回调、旧后端按 `otid` 去重是三兄弟，**靠症状分不出来**。

> **写探针的第五条纪律（2026-10-08 新增，专治「渲染层装配中断」）**：
> 渲染层初始化期抛异常（实测：`helper/assets/api-config.js` 里 `applyClose()` 只写调用不写定义）
> 会让 `shell.js` 的 `main()` 当场中断，**其后所有球窗口监听（左键 / 拖动 / 右键）全都没注册** ——
> 宿主 `logs/orb.log` 一行错都没有，只有 `ORB_ELECTRON_FLAGS='--enable-logging'` 才能在 stderr 里
> 看到 `INFO:CONSOLE` 那行 ReferenceError。⇒ **改完 `helper/assets/` 下任何脚本，必跑
> `probe/shell-boot-smoke.cjs`**（真起渲染进程、真点一下、看真 IPC：`dataset.shellReady` +
> 右键收到 `orb:ring-open` + 左键后 `body.expanded`）；纯源码扫描类探针在这一类事故上**必然是绿的**。

> **写探针的三条纪律**（都是踩出来的）：
> 1. **不要清空收包数组**，用游标 `mark()` / `since()` 取增量。
>    清空法会把「刚连上时推来的消息」一起抹掉，表现为「对方没响应」——
>    实测因此把探针 bug 当成产品 bug 查了半小时。
> 2. **每一步都要有连通性自检**。否则「消息没送到」和「对方不应答」在断言里长得一模一样。
> 3. **旧后端协议关联字段是 `request_id`，不是 `id`**；delta 正文在 `delta.content[].text`，
>    不是 `delta.text`。用错会导致所有请求永远等不到回包。

`src/main.mjs` 里的调试抓手（都由环境变量控制）：

- `ORB_SELFTEST="一句话"` —— 球鉴权通过后自动模拟用户输入
- `ORB_SELFTEST="A|||B|||C"` —— **多条**，用 `|||` 分隔，专门用来复现「第二次输入后卡住」
- `ORB_SELFTEST_DELAY=6000` —— 第一条延迟多少毫秒
- `ORB_SELFTEST_GAP=3000` —— 每条之间间隔多少毫秒
- `ORB_SHOT=9000` —— 启动后第 9 秒把球窗口 `capturePage()` 存到 `logs/shot-early-*.png`（沙箱/无显示器环境看 UI 的唯一手段）
- `ORB_SHOT_TURNS=2` —— **等第 2 轮的最终答案打上 `response` 标记后**才截图到`logs/shot-turns-*.png`，
  并同时打印折叠态诊断（含反向对照：临时摘掉 `data-response` 看 display 是否变`none`）。
  验证「历史轮次正文还在不在」必须用它 —— 固定时刻截图会拍错帧，说明不了问题
- `ORB_TRACE=1` —— 打印所有发往球的出站消息
- `ORB_TRACE_LEGACY=1` —— 打印收到的每一条旧后端消息（排查回合边界必备）
- `ORB_LEGACY_TALLY=1` —— 按类型统计旧后端消息条数。
  用途：出现过「loop 状态都收到了、唯独没有 `stream_delta`」的情况，
  只看日志尾部分不清是旧后端没推、还是推了被吞。**排查时优先开这个，比全量 trace 快得多**
- `ORB_SOCKET_PORT=25999` —— 固定球的控制 socket 端口（默认 0 = 动态）。给探针用

`launch.mjs` 支持的环境变量：

- `ORB_ELECTRON` —— 临时换一个 Electron 可执行文件
- `ORB_ELECTRON_FLAGS` —— 追加 Chromium 开关（空格分隔）
- `ORB_USER_DATA` —— 换Electron 用户数据目录

---

## 四、已完成的能力

| 能力                                         | 状态           | 证据                                               |
| ------------------------------------------ | ------------ | ------------------------------------------------ |
| 球窗口脱离 DSH 独立运行| ✅            | `logs/shot-*.png`                                |
| 对话流（user / reasoning / assistant / tool 块） | ✅            | 截图                                               |
| 逐字流式输出                                     | ✅            | 一轮 34+ 条同 id delta                               |
| 工具调用可见                                     | ✅            | `工具调用 · Write · C:\...`                          |
| 用量统计（为「花费插件」打底）| ✅            | 界面上的 `20.8K tok`                                 |
| 权限档位（球下拉 →旧后端 mode）                     | ✅ 代码通、UI 未实测 | 见 `docs/待办事项.md`|
| 端口不冲突| ✅            | 球 `listen(0)`、旧后端 `--listen` 省略 URL；7 次运行端口全不同 |
| 记忆持久化                                      | ✅            | agent 真的把内容写进 `memfs` 的 `MEMORY.md`              |
| 运行时与 DSH 完全脱钩| ✅            | 自带 `runtime/electron`，不写DSH home 任何文件           |
| **连续多条消息（快速连发不再卡死）**                   | ✅ 2026-10-06 | 三条连发实测：各发一次、各自拿到回复、只有一个 runtime   |
| **发送不再白等 3 秒**                              | ✅ 代码层，UI 待用户验收 | tcc 回包形状已从 helper 源码确认           |
| **B 站：真的看见画面**（取关键帧，原生分辨率）              | ✅ 2026-10-21 | `bili-frame-e2e` 21/21（853×480，只下整片 5.8%）    |
| **B 站：绑用户自己的账号**（画质随登录/大会员升级，结果里写明谁的身份） | ✅ 2026-10-21 | 匿名 480P → 登录 1080P（`bili-watch-unit` L1–L8）  |
| **B 站：她看过什么**（环菜单「看过的视频」抽屉 + `bili_history` 工具） | ✅ 2026-10-21 | `bili-history-unit` 31/31；`shell-boot-smoke` S28–S30 |
| **账户余额进上下文**（每轮一行真数，贵操作前用 `check_balance` 复核） | ✅ 2026-10-21 | `balance-unit` 27/27；实测 `¥8.62` 落进当轮 user 消息 |
| **认真看 / 快速看由她自己判断**（不做菜单让用户选） | ✅ 2026-10-21 | `mode:"quick"`=2 帧 480×270 / `"thorough"`=5 帧；`bili-watch-unit` M1–M7 |

日志时间线示例（工具调用场景）：

```
[06:56:03] 新块 u:1 (user)
[06:56:18] 新块 r:ui-msg-2:reasoning:0 (reasoning)
[06:56:19] 新块 tool:call_00_AbCStjb7XdYi62EeFMgQ1848 (tool)
[06:56:29] 新块 a:ui-msg-12 (assistant)
[06:56:30] 回合结束 stop_reason=end_turn
```

---

## 五、当前状态：卡死已修，还剩窗口不能调大小

| 状态 | 事项 |
|---|---|
| ✅ 已修（2026-10-06） | **第二次输入后 UI 卡住** —— 挖出 4 个坑，逐个实测验证。三条消息快速连发：各发一次、各自拿到回复、只建一个 runtime |
| ✅ 已修（代码层） | **每次发送白等 3 秒** —— tcc 回包。UI 延迟需用户桌面验收 |
| ⬜ 待做 | **对话窗口无法调整大小**（可读性差）。用户明确：功能修补做完后再做 |

卡死那 4 个坑的完整记录（含实测日志）→ 见 **`docs/待办事项.md`** 的 P0-1 章节  
UI 重构该怎么动、动哪里 → 见 **`docs/UI重构指南.md`**  
旧后端协议细节与踩坑 → 见 **`docs/参考-协议与踩坑.md`**

### 回合边界：唯一容易再踩的坑

**`stop_reason` 不是「回合结束」。** 实测它比 `loop_status=WAITING_ON_INPUT` 早到 **10~12 秒**，
那段时间 loop 还在收尾，发出去的 `input` 会被旧后端 **静默丢弃** ——
日志显示「已发出」，但一条 delta 都没有，界面表现就是「一直正在思考」。

所以 `src/main.mjs` 里放队列的出口只有一个：`onLoopIdle()`（由 `WAITING_ON_INPUT` 触发）。
`stop_reason` 只负责收尾块，不碰队列。**改这块之前先看这段。**

---

## 六、打包与出厂化

交付前必须让这一份里**没有开发者的痕迹** —— 记忆、人格、几十条测试对话、
40 多个测试期堆出来的僵尸 agent，以及写着你 `agentId` 的 `config.json`。

```bash
node tools/reset-to-factory.mjs              # 预演（默认，什么都不动）
node tools/reset-to-factory.mjs --apply      # 完整出厂化
node tools/reset-to-factory.mjs --apply --memory-only   # 只清记忆与对话
powershell -ExecutionPolicy Bypass -File build.ps1      # 打包成 dist/
```

双击入口是 `factory_reset.cmd`（菜单式）与 `reset_memory.cmd`（只清记忆）。

**三条要点：**

1. **老 `reset_memory.cmd` 的 `git reset --hard HEAD` 不是出厂化。** 记忆目录是个 git 仓库，
   `reset --hard HEAD` 只回到**最近一次提交**（＝已装满测试记忆的那版），更早的全在
   `.git/objects` 里，`git log` 一翻就有。正确做法是把整个 `memfs/` 搬走。
2. **真出厂路径是「删干净 + `config.agentId=null`」。** `ensureRuntime()` 里有
   `system: target ? undefined : personaFor(mode)` —— 没有 agentId 时会**新建 agent
   并把 persona 烤进 system**，于是下次启动自动长出一个带着新版人格的全新 agent。
3. **工具默认是「搬家」不是删除**：先整份拷到
   `E:\Memo orb_factory_backup_<时间戳>\`，再删原处，随时可回滚。
   orb 还开着时会拒绝执行（它退出时会把内存里的 config 写回去）。

`build.ps1` 也已修掉一个泄漏：原来它直接 `Copy-Item config.json`，
**会把你的 agentId 打进 dist**。现在改成从 `config.example.json` 生成干净 config，
并在打包末尾做 leak check（`dist/config.json` 出现 `agent-local-`、
或 dist 里出现 `logs/` `exports/` `.workbuddy/` `locks.json` 就 `exit 1`）。

完整清单与踩坑（含 `.cmd` 编码坑、`set /p` 死循环坑）→ `docs/待办事项.md` 的 **P0-8**。

---

## 七、不要做的事

- **不要删 `.workbuddy` 目录**（项目数据）
- **不要改 `E:\dsh-workspace\02_插件开发\dsh-orb-cordis`**：那是上游构建源，本项目只读它
- **不要把 `helper/` 与上游 `dsh-orb-cordis` 视作两个独立代码库**：`helper/` 是上游的**编译产物副本**。改渲染层（`assets/`）可以直接改；改窗口层（`lib/main.js`）要慎重，因为改的是 minified 产物（重构建议见 `docs/UI重构指南.md`）
- **不要把 `config.json` 的 `electronPath` 改回 `E:/dsh-home/...`**：那会重新和 DSH 抢运行时，破坏独立性
- **不要在 `stop_reason` 里放回合队列**：它比 `WAITING_ON_INPUT` 早到 10~12 秒，
  那期间发的消息会被静默丢弃。只有 `onLoopIdle()` 可以放队列（详见第五节）
- **不要往 `putBlock` 传已经带会话前缀的 key**：会变成 `conv|conv|r:...` 这种废 key。
  带前缀的完整 key 走 `resend()`，`putBlock()` 只吃裸 key
- **不要在排队期间现读 `userSeq` 生成 `client_message_id`**：id 必须在入队时定下来（见 `docs/待办事项.md` 坑 4）
- **不要在 `markTurnResponse()` 里遍历全部 `blocks`**：折叠态每个 turn 只有带`data-response` 的
  assistant 才显示正文（`helper/assets/chat.css:171`）。全量重发会把历史轮次已打好的标记**全擦掉** ——
  现象是「发出第 2 条消息后第 1 轮正文整块消失，只剩『用时 N秒』表头」。只碰 `[turnAssistantFrom, end]` 区间
- **不要往 `.cmd` / `.bat` 里写中文**。新起的 `cmd.exe` 默认 936 代码页，
  第二行的 `chcp 65001` 来不及 —— cmd 按行流式解码批处理，中文被按 GBK 误读后
  内部文件偏移会漂移，**把后面几行（含 `node` / `pause`）整个吞掉**，
  症状是「窗口一闪就关」且**无任何报错**。`.cmd` 一律纯 ASCII（0 个 > 0x7F 字节），
  中文解释写 `.md`、中文输出交给 Node 打印。自查：
  `node -e "console.log([...require('fs').readFileSync('x.cmd')].filter(b=>b>127).length)"`
- **不要在菜单式 `.cmd` 里让空输入 `goto menu`**：stdin 到 EOF 时 `set /p` 不给变量赋值，
  变量恒空 → 菜单无限重绘（实测刷到 5.6 MB 才被掐）。空输入必须退出。
  带参数时同理不能回菜单，否则会重新派发同一个选项（实测 353 KB 死循环）
- **不要为了「省内存」用 `--single-process`**：实测直接崩（exit code 2147483651）
- **不要建议用户去杀 `msedgewebview2` 进程**：那可能是 Windows 搜索组件（本机常驻 421MB），杀了会打断系统搜索
- **不要在沙箱里只给 `--no-sandbox` 给 Electron**：GPU 子进程照样起不来，会以
  `GPU process isn't usable. Goodbye.` FATAL 掉整个进程。必须 `--no-sandbox --disable-gpu` 一起给