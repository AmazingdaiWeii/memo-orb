# Orb —— 交接文档

> **2026-10-19 重大变更（阅读下文前必看）**：旧后端已被整体剥离。`package.json` 现在**零依赖**，`node_modules/` 已删除（释放 454 MB），后端换成自建的 `src/llm.mjs` + `src/brain.mjs` + `src/memstore-local.mjs` + `src/snapshot.mjs` + `src/compact.mjs`，数据根改为项目内 `data/`。本文档下方「大脑：旧后端」等描述均为**剥离前的历史记录**。

> 交接时间：2026-10-06（原始项目 2026-10-06 建立，同日迁入本工作区）  
> **项目根目录：`E:\Memo orb`**（就是本仓库根，自此项目与工作区合一）
> 上游来源：`E:\dsh-workspace\02_插件开发\dsh-orb-cordis`（DSH 的悬浮球插件，**只读参考，不要改**）

---

## 〇、素材与署名（开源分发必读）

- **原 `dsh_orb` 的球体素材未获原作者授权，已从仓库移除。** 
- 仓库自带 **3 张自制球形态**：`helper/assets/avatars/orb-A.gif`（默认头像）、`orb-idle.gif`、`orb-pat.gif`（本项目自绘 + AI 生成 + 程序合成）。
- **另自带 6 张情绪装饰**（与上游无关，随仓库正常分发）：`helper/assets/deco/`（idle / thinking / happy / shy / sad / surprised）。**情绪图是球的唯一表情来源，不要删。**
- **用户可以自行导入**：把你**自己制作或已取得授权**的 `*.gif` 丢进 `helper/assets/avatars/`，环菜单「换形象」会自动列出来，**不需要改任何配置**。请确认你对导入的素材拥有相应权利——本仓库不提供、也不指引任何第三方素材的获取途径。
  素材的规格与命名规则见 `helper/assets/avatars/README.txt`。
- 角色形象、命名与界面美术均为本项目自有，与上游 `dsh-orb` 及其作者无关。二次分发时请确认没有残留的第三方素材。

### 声明（商标与素材归属）

> **本项目由个人开发者维护，与 DeepSeek AI 无任何隶属、认可或合作关系。**
>
> 本仓库**不包含** DeepSeek 的名称、Logo 或任何头像素材。默认球脸 `helper/assets/avatars/orb-A.gif`（另有 `orb-idle.gif`、`orb-pat.gif`）与 `deco/`（6 张情绪图）下的动图，**全部为本项目作者自制**，可随仓库自由分发。
>
> 代码与文档中出现的 "DeepSeek" 字样，**仅指其作为可选模型服务商之一**（通过 OpenAI 兼容接口接入），属描述性提及，不构成商标性使用。
>

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
| `helper/`                           | 从 上游 `dsh-orb-cordis` 的构建产物复制来的球（窗口层 + 渲染层）           |
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
| `helper/assets/deco/`               | 装饰 GIF（六个情绪，**UI 助手的图层用**） |
| `鲸鱼娘_persona.md`（根）                 | **运行期正本**：`src/persona.mjs` 读它注入 agent 的 `system`，**不要放错位置**    |

> ★★ **`.cmd` 一律写成纯 ASCII（0 个 > 0x7F 的字节）。**
> 新起的 `cmd.exe` 默认是 936 代码页，第二行的 `chcp 65001` **来不及** ——
> cmd 是按行流式解码批处理的，中文被按 GBK 误读后内部文件偏移会漂移，
> **把后面几行（含 `node` / `pause`）整个吞掉**，症状是「窗口一闪就关」且无报错。
> 中文解释写进 `.md`；中文运行时输出交给 Node 打印（真控制台上正常）。
> 自查：`node -e "console.log([...require('fs').readFileSync('x.cmd')].filter(b=>b>127).length)"` → 必须是 `0`。

### 与 DSH 的关系（重要）

DSH 里跑的 `dsh-orb` 插件装在 `E:\dsh-home\profiles\desktop\node_modules\dsh-orb`（npm 装的独立副本）。
本项目的 `helper/` 是**手工复制的另一份**，两者**互不共享文件**。

-改本项目的 `helper/` → 只影响 orb 独立版，**不影响 DSH 里的球**
- 改上游 `dsh-orb-cordis/` → **也不会**自动影响 DSH 里已装的插件（它是构建源，不是运行副本）
-唯一真正的共享点是 **Electron 运行时**，已经通过自带副本切断了（见第二节）

> **写探针的几条纪律**（都是踩出来的）：
>
> 1. **不要清空收包数组**，用游标 `mark()` / `since()` 取增量。清空法会把「刚连上时推来的消息」一起抹掉，表现为「对方没响应」——实测因此把探针 bug 当成产品 bug 查了半小时。
> 2. **每一步都要有连通性自检**。否则「消息没送到」和「对方不应答」在断言里长得一模一样。
> 3. **断言分两类**：**不变量**（几何合法性、幂等性）与**需求**（交互手感、默认行为）。需求类断言必须在注释里写清出处（`用户 mXXXXX`）：需求一反向，它就是一条必须**翻面**的红，而不是「产品坏了」。
> 4. **记录型桩测不出来的，要用源码断言再钉一遍**。凡是「渲染层 → preload → 主进程」的多跳链路，Proxy 记下实参 **不代表 preload 真的转发了**；必须再有一条源码断言型探针盯着每一跳的字段名与分支存在性。这类 bug 的共同症状是「日志全正常、零报错、点了没反应」。
> 5. **渲染层初始化期抛异常会让整个装配中断**。实测 `helper/assets/api-config.js` 里一个「只写调用不写定义」就让 `shell.js` 的 `main()` 当场中断，**其后所有球窗口监听（左键 / 拖动 / 右键）全都没注册**，而宿主 `logs/orb.log` 一行错都没有——只有 `ORB_ELECTRON_FLAGS='--enable-logging'` 才能在 stderr 看到 `INFO:CONSOLE` 那行 ReferenceError。**改完 `helper/assets/` 下任何脚本，必须真起渲染进程点一下看真 IPC**（`dataset.shellReady` + 右键收到 `orb:ring-open` + 左键后 `body.expanded`）；纯源码扫描类检查在这一类事故上**必然是绿的**。
> 6. **jsdom 类探针测不到「贴在哪」** —— 没有布局引擎、`getBoundingClientRect()` 恒 0，几何只能正则匹配源码字符串。手柄命中区与面板可见边界差 12px 这种错位，只有真浏览器能量出来。

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
| 权限档位（球下拉 →旧后端 mode）                     | ✅ 代码通、UI 未实测 | — |
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
| **她真的开口说话**（切句 → 合成 → 播放，边说边合成） | ✅ 2026-10-22 | `speech-unit` 44/44、`speech-wiring-unit` 71/71、`speech-playback-e2e` 24/24 |
| **语音 mp3 不落盘**（即用即抛，磁盘零增长） | ✅ 2026-10-22 | `speech-playback-e2e` V7（created === revokes） |

### 语音播报（2026-10-22）

她说完的话会用**你自己的音色**念出来。三段结构：

```
src/tts/volcano.mjs · openai.mjs    文字 → 音频字节（不播、不落盘）
src/tts/speech.mjs                  切句 / 清洗 / 排队 / 保序 / 打断
helper/assets/shell.js              渲染层 new Audio(blobUrl)，播完 revoke
```

**怎么配**：设置 → 「语音播报」。

- `火山引擎`（豆包语音）：`API Key` + `音色 ID` 就能通（单 key 通道）；
  若你的账号走双头通道，再填 `App ID` / `Access Key`。通道（`variant`）**不用手选**，
  第一次试听时会自动探测并记下来。
- `OpenAI 兼容`：任何 `POST {baseUrl}/v1/audio/speech` 的网关都能用（聚合站、自建、别家的兼容模式）。
  填 `baseUrl` / `apiKey` / `model` / `voice` 即可。

**怎么接别家**：不要改 `volcano.mjs`。新开 `src/tts/<名字>.mjs`，导出
`{ speak, probe, describe }`（契约见 `src/tts/index.mjs` 头注释），
在 `index.mjs` 的 `PROVIDERS` 里注册一行。上层（切句、队列、播放、设置页）一行都不用改。

**关于 mp3**：整条链路上音频只在内存里走一趟 ——
主进程 `Buffer` → IPC 的 base64 → 渲染层 `Blob` + `createObjectURL` → 播完
`revokeObjectURL`。**磁盘上不会因为说话多出任何文件。**

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

卡死那 4 个坑、UI 重构该怎么动、旧后端协议的细节，完整记录都在开发笔记的 01 / 02 两篇里。

### 回合边界：唯一容易再踩的坑

**`stop_reason` 不是「回合结束」。** 实测它比 `loop_status=WAITING_ON_INPUT` 早到 **10~12 秒**，
那段时间 loop 还在收尾，发出去的 `input` 会被旧后端 **静默丢弃** ——
日志显示「已发出」，但一条 delta 都没有，界面表现就是「一直正在思考」。

所以 `src/main.mjs` 里放队列的出口只有一个：`onLoopIdle()`（由 `WAITING_ON_INPUT` 触发）。
`stop_reason` 只负责收尾块，不碰队列。**改这块之前先看这段。**

---

## 六、打包与出厂化

交付前必须让这一份里**没有开发者的痕迹** —— 记忆、人格、几十条测试对话、一大堆测试期堆出来的僵尸 agent，以及写着你 `agentId` 的 `config.json`。

**三条要点：**

1. **换记忆 = 搬走整个 `memfs/`，不是 `git reset`。** 记忆目录是个 git 仓库，`reset --hard HEAD` 只回到**最近一次提交**（＝已装满测试记忆的那版），更早的全在 `.git/objects` 里，`git log` 一翻就有。
2. **真出厂路径是「删干净 + `config.agentId=null`」。** `ensureRuntime()` 里有 `system: target ? undefined : personaFor(mode)` —— 没有 agentId 时会**新建 agent 并把 persona 烤进 system**，于是下次启动自动长出一个带着新版人格的全新 agent。
3. **动手前先整体备份一份**，再删原处，随时可回滚；orb 还开着时要先退出（它退出时会把内存里的 config 写回去）。

---

## 七、不要做的事

- **不要改 `E:\dsh-workspace\02_插件开发\dsh-orb-cordis`**：那是上游构建源，本项目只读它
- **不要把 `helper/` 与上游 `dsh-orb-cordis` 视作两个独立代码库**：`helper/` 是上游的**编译产物副本**。改渲染层（`assets/`）可以直接改；改窗口层（`lib/main.js`）要慎重，因为改的是 minified 产物（重构建议写在开发笔记 01 里）
- **不要把 `config.json` 的 `electronPath` 改回 `E:/dsh-home/...`**：那会重新和 DSH 抢运行时，破坏独立性
- **不要在 `stop_reason` 里放回合队列**：它比 `WAITING_ON_INPUT` 早到 10~12 秒，
  那期间发的消息会被静默丢弃。只有 `onLoopIdle()` 可以放队列（详见第五节）
- **不要往 `putBlock` 传已经带会话前缀的 key**：会变成 `conv|conv|r:...` 这种废 key。
  带前缀的完整 key 走 `resend()`，`putBlock()` 只吃裸 key
- **不要在排队期间现读 `userSeq` 生成 `client_message_id`**：id 必须在入队时定下来
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