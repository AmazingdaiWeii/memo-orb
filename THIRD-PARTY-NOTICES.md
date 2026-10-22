# 第三方来源披露

> 本仓库以 **MIT** 分发（见 `LICENSE`）。本文件说明代码层面的衍生来源。
> 结论先行：**本包不含 DeepSeek 的任何名称、Logo 与头像素材，也不含上游 dsh-orb 的球体美术素材**；
> 球脸、情绪图、背景图、托盘图标均为本项目自制。

---

## 一、上游项目：dsh-orb-cordis

- 来源：<https://github.com/mini-yifan/dsh-orb-cordis>（原作者 **mini-yifan**，MIT）
- ⚠️ `eugenewang5425/dsh-orb-cordis` 是该仓库的 GitHub **fork**（0 star），**不是原仓库**；引用一律指向 `mini-yifan/dsh-orb-cordis`。
- 关系：本项目最初是它的下游改造；2026-10-19 起后端整体重写（剥离 Letta，改为直连模型 + 自建长记忆），2026-10-21 起素材全部替换，**目前仅渲染层保留部分衍生代码**。

衍生部分（按影响面排序）：

| 文件 | 说明 |
|---|---|
| `helper/lib/main.js` | 上游 helper 的 TypeScript 源码编译产物（约 22 处 `dsh` 字样残留）。其 TS 源在本项目开发树内，不随发布包分发 |
| `helper/assets/shell.js` | 球侧主脚本，沿用上游结构与少量 `dsh` 命名残留，已大量重写 |
| `helper/assets/api-config.js`、`helper/assets/selection-toolbar.js` | 同上，含 `dsh` 命名残留 |

按 MIT 要求，上述衍生代码在再分发时保留版权声明与许可声明即可。

## 二、图标几何：`@deepseek-ai/dsh-client-ui-primitives`

- 文件：`helper/assets/icons.js`（首行已注明来源）
  ```js
  /** Shared current-color icons, ported from @deepseek-ai/dsh-client-ui-primitives. */
  ```
- 性质：**SVG path 几何数据**（线条图标的坐标），不是图片素材，也不含任何 DeepSeek 品牌标识（Logo、鲸鱼形象等）。
- 现状：环菜单已改为自绘内联 SVG（`helper/assets/ring-menu.js` 的 `ITEM_ICONS`），该文件目前主要供其它 UI 复用。

## 三、运行时：Electron

- `runtime/electron/` 是 Electron 官方发布物（**MIT**），随完整发布 zip 提供，**不进 Git 仓库**（单文件超 GitHub 上限，见 `.gitignore`）。
- 源码仓库版的获取方式见 `出厂说明.txt` §从仓库运行。

## 四、明确**不包含**的内容

- ❌ DeepSeek 名称、Logo、任何头像素材 —— 一个都没有。
- ❌ 上游 `dsh-orb` 的 6 张球形态 gif（`cheeks / cheer / heart / point / rice / smile`）—— 经逐字节 md5 比对确认来自上游、未获再分发授权，**已从发布包剔除**。
  那 6 张不随包分发；`helper/assets/avatars/` 里只带 3 张自制球形态（`orb-A.gif` 默认 / `orb-idle.gif` / `orb-pat.gif`），你可以换成自己的 gif。

---

## 许可与署名

- 本项目：MIT，`Copyright (c) Amazingdaiweii, 2026`（见 `LICENSE`）。
- 上游 dsh-orb-cordis：MIT，版权归 **mini-yifan**。
- Electron：MIT，版权归 GitHub Inc. 及贡献者；完整的第三方许可清单见 `runtime/electron/LICENSES.chromium.html`。
