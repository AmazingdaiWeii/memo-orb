<div align="center">

# Orb · 一颗会记事的桌面悬浮球助手

**Windows 桌面 AI 助手**：常驻屏幕右沿，不挡事。<br>
记忆是一堆 markdown 文件 + 一个 git 仓库 —— 重启之后它还是它，把文件夹拷到另一台机器也不会失忆。

[下载出厂版](https://github.com/AmazingdaiWeii/memo-orb/releases) · [从源码跑](#从源码跑) · [它和普通聊天窗口有什么不一样](#它和普通聊天窗口有什么不一样)

</div>

---

## 长什么样

<table>
<tr>
<td align="center"><img src="docs/assets/shots/01-ball.png" width="150" alt="桌面上的小球" /><br><sub>常驻在屏幕右沿的小球</sub></td>
<td align="center"><img src="docs/assets/shots/02-chat.png" width="330" alt="展开的对话面板" /><br><sub>左键展开就是对话面板</sub></td>
<td align="center"><img src="docs/assets/shots/03-ring.png" width="190" alt="右键环菜单" /><br><sub>右键是环菜单</sub></td>
</tr>
</table>

## 它是什么

一颗悬浮在桌面上的小球。左键展开是对话面板，右键是环菜单（换形象 / 看过的视频 / 设置 …）。

它不是一个网页套壳：大脑在本机跑（自建引擎，直连 OpenAI 兼容接口），会话、记忆、登录态全存在你自己的盘里；除了模型接口本身，不依赖任何外部服务。

三个设计红线：

1. **独立启动** —— 不依赖任何宿主进程，双击就能跑
2. **不干扰** —— 不与别的程序抢端口（控制 socket 用 `listen(0)` 动态端口）
3. **轻** —— 500 MB 量级

## 它和普通聊天窗口有什么不一样

**记忆是真的。** 不是「把聊天记录塞回上下文」那种记得。记忆是一份 git 版本化的 markdown 仓：`MEMORY.md`（四节固定：关于他 / 关于我自己 / 约好但还没做的 / 索引）、`about/印象.md`、`journal/YYYY-MM.md`（append-only）。你怎么称呼、它答应过你什么，都写在里面，每次改动都是一次 commit —— 所以能翻历史、能回滚。

**两条会话，一份记忆。** 桌面上找它，或者微信里找它，是同一个它。

**会自己看 B 站。** 丢一个视频链接过去，它真的会看画面（取关键帧，原生分辨率）；认真看还是快速看由它自己判断，不是给你一个「画质」菜单让你选。它记得自己看过什么，环菜单里有「看过的视频」。

**会说话。** 接上语音之后，它说的每句话都会念出来。文字 → 音频整条链路都在内存里走，磁盘上不会因为说话多出任何文件。

**知道自己的钱包。** 每轮上下文里有一行余额真数（问服务商接口，5 分钟缓存），贵的事做不做，它自己掂量。

**人格是一份 markdown。** `鲸鱼娘_persona.md` 就是它的性格正本，每轮全文注入。想换一个它，改这个文件。

## 三步装上（Windows x64）

1. **下载** —— 在 [Releases](https://github.com/AmazingdaiWeii/memo-orb/releases/latest) 里下 `Orb_v1.0_windows_x64.zip`（约 184 MB）。旁边那个 `.sha256` 是校验用的，想验就验
2. **解压** —— 解到一个**普通目录**，别放 `C:\Program Files` 这种要管理员权限的地方（首次启动会在 exe 旁边建 `data/`，那儿得能写）
3. **填模型** —— 双击 `Orb.exe` → 右键小球 → 设置 → 「API」分组 → 填 API Key 和模型名（DeepSeek，或任何 OpenAI 兼容网关）→ 保存

不用装 Node、不用装 Python、不用装任何运行库。首次启动 Windows 会弹 SmartScreen（没买代码签名证书），点「更多信息 → 仍要运行」。

界面上的 `data/` 是它自己建的，存会话、记忆仓、登录态。**包里不带任何人的私人凭据**：微信是可选的，不填就一个字节都不收发；模型 key 也只存在你自己这台机器的 `data/providers/auth.json` 里。

### 从源码跑

需要 Node ≥ 22.19。`package.json` 是**零依赖**的，不用 `npm install`。

差一个 Electron 运行时：`runtime/`（约 367 MB）不进 git，自己准备一份：

```powershell
# 任选其一：把 electron 放进 runtime/electron/，或直接指定路径
$env:ORB_ELECTRON = "D:\path\to\electron.exe"
node src\launch.mjs
```

启动失败不会闪退（`src\launch.mjs` 用普通 Node 跑，报错留在控制台），日志在 `logs\orb.log` —— 排障第一入口。

## 配置

全在 `config.json`，改完重启生效（部分项运行期改即生效）：

| 键 | 说明 |
|---|---|
| `model` | 模型名，`openai-compatible/<模型>` 或服务商自己的写法 |
| `agentName` / `theme` / `locale` | 显示名 / 主题 / 语言 |
| `electronPath` | Electron 可执行文件，**支持相对路径**（相对项目根），所以整个目录搬盘不用改配置 |
| `engine` | `local`（默认，自建引擎）\| `legacy`（旧后端，仅历史保留，跑不起来） |
| `contextBudgetTokens` | 上下文预算旋钮，默认 24 000，上限 = 模型上下文，**运行期改即生效** |
| `adoptHostWechatCreds` | 是否允许从本机 `~/.dsh` 搬微信凭据。**出厂默认 `false`** |

模型 Key 不进 `config.json`，落在 `data/providers/auth.json`（首次在设置页「API」分组里填，不用手改文件）。

## 目录

| 路径 | 作用 |
|---|---|
| `src/` | 后端全部源码：主进程、自建引擎、长记忆、会话、压缩、工具层、微信桥、TTS |
| `helper/` | 球的窗口层与渲染层（`assets/*.js` 是可读源码，直接改） |
| `鲸鱼娘_persona.md` | 人格正本，`src/persona.mjs` 每轮读它注入 system |
| `tools/` | 构建与运维脚本：打出厂包、造 agent、审计导出物 |
| `probe/` | 行为探针（自动化测试），一个功能一个文件 |
| `docs/` | 三篇可公开的开发笔记（00 从这里读起 / 01 开发手册 / 02 已趟过的坑）——出厂包里的 `开发笔记/` 就是它们的原样拷贝；另有 README 用的三张截图 |
| `data/` | **运行时生成**：会话、记忆仓、登录态、日志。不进 git |
| `runtime/` | 自带 Electron 运行时，不进 git |

## 已知限制

- 只打过 **Windows x64** 的包；macOS / Linux 没试过
- 没有安装器，就是解压即用（首次启动手工填一次模型 key）
- 微信桥要自己扫码配对；语音要自己的火山引擎（豆包）或 OpenAI 兼容 TTS 的 key
- **只能出声，不能听**：语音是单向的，没有语音输入
- 记忆是文件，不是训进权重里 —— 换机器要把 `data/` 一起搬走才不失忆（好在它是个 git 仓，能翻也能备份）
- B 站与微信都依赖第三方协议，随时可能失效，仅供个人学习用

## 素材与署名

默认球脸、6 张情绪装饰图、页面背景**全部为本项目自制**，可随仓库自由分发。上游 `dsh-orb` 的原素材未获授权，已从仓库移除。

第三方组件与素材清单见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)；素材规格与命名规则见 [`helper/assets/avatars/README.txt`](helper/assets/avatars/README.txt)。

> 本项目由个人开发者维护，与 DeepSeek AI 无任何隶属、认可或合作关系。代码与文档中出现的 "DeepSeek" 字样仅指其作为可选模型服务商之一，属描述性提及。

## 许可（License）

**随便玩，别拿去赚钱。**

本项目以 [PolyForm Noncommercial 1.0.0](LICENSE) 授权。简单说：

- ✅ 自己用、自己改、改完分享给别人、装在自己电脑上、教学、非营利机构使用 —— 都可以，不用问
- ❌ 商业用途 —— 打包进你卖的产品、放在收费服务里、公司内部当生产工具、拿它做二次开发去卖，都**需要先单独取得授权**
- 分发时请把 `LICENSE` 一起带上（里面的 `Required Notice` 那行不能删）

严格讲这不是 OSI 认可的开源许可（「禁止商用」这一条就把它挡在门外了），所以准确的说法是「**源码可见 · 非商业授权**」。要商用直接开个 issue 谈。

公开仓库里能看到的**发帖素材、设计文档、人格文档**同样适用这条；第三方组件仍按各自的许可证走（见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)）。

## 更多文档

- [从这里读起](docs/00_从这里读起.md) —— 接手前先知道的几件事、30 秒环境事实、文档怎么读
- [开发手册：架构与历史](docs/01_开发手册_架构与历史.md) —— 架构、目录职责、素材与署名、历史决策的来龙去脉
- [已趟过的坑：球侧问题清单](docs/02_已趟过的坑_球侧问题清单.md) —— 被推翻的错误结论、红线、事故复盘 —— **动手前必读**
- [第三方组件与素材](THIRD-PARTY-NOTICES.md) —— Electron、上游素材、各自的许可证
