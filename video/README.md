# video/ · B 站介绍视频制作工作区

> 配套文档：`docs/B站介绍视频_分镜脚本_v1_2026-10-22.md`（分镜）、`docs/B站视频_TTS合成分段稿_v1_2026-10-22.md`（合成分段稿）
> 分工：**你跑配音 + 录屏 → 我抠贴纸、做字幕、混剪出片。** 海报卡生图（花积分）等你发话。

---

## 目录约定

```
video/
  tts/
    chunks.json        ← 10 段旁白（情绪指令 + 语速 + 纯正文），改稿就改这里
    tts-batch.mjs      ← 批量合成脚本（零依赖，Node ≥ 22）
    local-config.json  ← 你的凭据（已 gitignore，绝不进 git）
  voiceover/
    2026-10-22/        ← ✅ 配音已交付：01.mp3 ~ 10.mp3 + narration_full.mp3 + 时间轴 + _text/
  ai-gen/              ← AI 视频生成工作区（3 段视频的提示词 + 参考图，你去生成）
  assets/
    screen/            ← 你录的屏（按分镜表命名，见下）
    poster/            ← 海报卡成图（生图后放这里）
    sticker/           ← 贴纸（我从定妆 mp4 抠，或你给）
  build/               ← 我的中间产物与成片输出
```

---

## 一、你做：跑配音（10 分钟）

1. 准备凭据（控制台「API Key 管理」拿 App ID / Access Key，「音色库」拿你的复刻音色 ID）：

```bash
export VOLC_APP_ID=xxx
export VOLC_ACCESS_KEY=xxx
export VOLC_SPEAKER=你的复刻音色ID
```

或者写 `video/tts/local-config.json`（**别把内容发到任何会进 git 的地方**）：

```json
{ "appId": "xxx", "accessKey": "xxx", "speaker": "你的复刻音色ID" }
```

2. 先干跑看请求对不对（不花钱）：

```bash
node video/tts/tts-batch.mjs --dry-run
```

3. 正式合成全部（顺手拼整轨）：

```bash
node video/tts/tts-batch.mjs --concat
```

4. 不满意的段单独重跑，例如第 5、10 段：

```bash
node video/tts/tts-batch.mjs 05 10 --concat
```

**情绪怎么生效的**：每段的 `emotion` 走 `additions.context_texts`（官方明说不参与朗读，不会被念出来），并且强制 `model_type:4` 走复刻 2.0。你只需要在 `chunks.json` 里调情绪文案和 `speech_rate`（-50~100，0=原速）。

**听到情绪不对**：改 `chunks.json` 里那一段的 `emotion` 措辞（比如"更开心一点、带笑意"）→ 只重跑那几段。第 10 段如果情绪不理想，把它的 text 从"不过说实话"拆成两个 chunk。

---

## 二、你做：录屏（按分镜表）

按分镜脚本 §二 的镜头表录，文件丢进 `video/assets/screen/`，命名建议：

| 文件 | 内容 |
|---|---|
| `s1-github.mp4` | GitHub 仓库页滚动（`mini-yifan/dsh-orb-cordis`） |
| `s2-ball.mp4` | 桌面球：拖动、左键展开、右键环形菜单 |
| `s2-chat.mp4` | 流式对话 + 工具卡 + 表情切换 |
| `s3-memory.mp4` | 记忆中心：提交列表、diff、工具卡 |
| `s4-wechat.mp4` | 手机微信对话 + 审批卡（**打码**） |
| `s5-bili.mp4` | B 站看视频链路 + 看过的视频抽屉 + 赞/币/藏 |

打码清单见分镜脚本 §四。录屏分辨率 1080p、30fps 即可。

---

## 三、我做：成片

拿到配音和录屏后我来：

1. **抠贴纸**：从定妆 mp4 抽帧去背，做 2 秒循环贴纸（先试贴一段验表现力，0 积分）
2. **字幕**：用 `voiceover/*.sidecar.jsonl` 里的时间戳对轴（接口开了 `enable_subtitle`，字级时间戳），没时间戳就按分段估
3. **混剪**（ffmpeg）：海报卡 + 录屏裁切 + 贴纸叠加 + 转场 + 配音整轨 → `video/build/成片_v1.mp4`（1080p）
4. 能做到的上限：干净的混剪——卡间切换、Ken Burns 缓推、xfade 转场、贴纸叠加、字幕烧录、音画对齐。**不是 AE 级动效包装**；要重动效的段落我们用海报卡+字幕解决，或者你用剪映补。
5. 你审片 → 提修改 → 我出 v2。

---

## 四、海报卡（花积分，等你发话）

9 张卡的画面描述在分镜脚本 §三。建议顺序：先生成卡1 定色调 → 你过目 → 再铺其余 8 张。生成后放 `video/assets/poster/`。

---

## 五、当前状态

- [x] 分镜脚本 v1（含结尾升华回环）
- [x] 10 段合成分段稿 + 批量合成脚本
- [x] **配音跑出来（你，2026-10-22 交付 + 你验收通过 + 我复检通过）**
      → `video/voiceover/2026-10-22/`，10 段全成、文本逐字对上 chunks.json、
        响度 -17.4~-19.1 LUFS（波动 1.7）、峰值无削波、复刻 2.0 通道
- [ ] 录屏素材（你）
- [ ] **AI 视频 3 段**（你，去 `video/ai-gen/` 拿提示词生成）V1 踏浪 / V2 呆萌 / V3 球内呆毛
- [ ] 海报卡生图（待发话）
- [ ] 贴纸试贴（我，随时可做）
- [ ] 粗剪 → 精剪 → 成片（我）
- [ ] **彩蛋实录**（正式版后补，不阻塞投稿）：你录「她开口说话」的首段实录 → 给我 → 剪进 S6-5 插槽出 v2（旁白零占用）
