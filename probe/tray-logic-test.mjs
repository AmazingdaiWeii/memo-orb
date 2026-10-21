/**
 * 托盘图标的**纯逻辑**验证（不需要 Electron）。
 *
 * ★ 为什么「图标必须由渲染层解码」这条要单独钉住：
 *   实测（probe/tray-icon-bench.cjs）发现 `nativeImage.createFromPath()` 对 **GIF
 *   返回空图**（isEmpty=true / 0×0）—— Electron 的 nativeImage 不解析 GIF，而本
 *   项目的头像素材**全是 GIF**。更阴的是 `Tray` / `setImage()` 拿到空图**不报错**，
 *   症状只是「托盘一个空白格子 + 日志全干净」（静默失败族）。
 *   所以托盘图标必须走渲染层 canvas → PNG → createFromDataURL，
 *   本探针就是防它被「优化」回 createFromPath。
 *
 * 注意：本探针验的是**接口与路径**，不验「真机看得见、点得到吗」。
 *       托盘是否出现、菜单是否弹得出来，仍必须由用户在桌面上真点一次。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (!ok) failed += 1;
}

// ---- 从 main.js 里镜像过来的规则（必须与源码逐字一致）----
const PRESET_SRC = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9_-]+)*\.gif$/;
const DEFAULT_AVATAR_SRC = "orb-idle.gif";
const AVATAR_PRESETS = [
  "orb-idle.gif",
  "avatars/smile.gif",
  "avatars/cheer.gif",
  "avatars/cheeks.gif",
  "avatars/heart.gif",
  "avatars/point.gif",
  "avatars/rice.gif"
];

// 1) 源码里的字面量没被改动（防手滑改路径）
const mainSrc = readFileSync(join(PROJECT_ROOT, "helper", "lib", "main.js"), "utf8");
check("main.js 有 DEFAULT_AVATAR_SRC 常量", mainSrc.includes('const DEFAULT_AVATAR_SRC = "orb-idle.gif"'));
check("main.js 里 TRAY_ICON_SIZE = 16", /const TRAY_ICON_SIZE = 16;/.test(mainSrc));
check("main.js 导入了 Tray/nativeImage", /import \{[^}]*\bTray\b[^}]*\} from "electron"/.test(mainSrc) && /import \{[^}]*\bnativeImage\b[^}]*\} from "electron"/.test(mainSrc));
check("main.js 调用了 createTray()", mainSrc.includes("createTray()"));
check("托盘在 app.whenReady 内创建", /whenReady\(\)[\s\S]{0,300}createTray\(\)/.test(mainSrc));

// 2) 托盘菜单**恰好两项**：显示·隐藏悬浮球 / 退出程序
//
// ★ 这个数字改过两次，两次都是用户的判断，记录在此防「优化」回去：
//
//   原定：显示主页面 / 退出程序（两项）
//   → 加隐藏功能后变三项（显示主页面 / 显示·隐藏悬浮球 / 退出程序）——
//     理由：球窗是 skipTaskbar:true，藏起来后任务栏没有入口，
//     托盘是唯一能把它叫回来的地方，所以「显示/隐藏」这项是**必要配套**。
//   → 用户 2026-10-08 指出「显示主页面」冗余，删回两项：
//     **「既然托盘图标做了显示球，那么显示主界面这个选项也可以一并删除了」**。
//     这个判断成立：球一回来，右键球就能进 旧后端 界面，中间那一跳多余。
//
//   ⚠️ 注意：删的是**托盘这一份入口**，主进程的 `openMainPageFromTray()` 仍在 ——
//   原生右键菜单的「打开 旧后端 界面」还在用它。所以下面那条断言检查的是
//   「trayMenuTemplate 里不再出现 openMainPageFromTray」，而不是「源码里不再有它」。
const menuBlock = mainSrc.slice(mainSrc.indexOf("function trayMenuTemplate()"), mainSrc.indexOf("function trayImageFromDataUrl"));
check("托盘菜单不再含「显示主页面」", !menuBlock.includes('"显示主页面"'));
check("托盘菜单含「隐藏悬浮球」", menuBlock.includes('"隐藏悬浮球"'));
check("托盘菜单含「显示悬浮球」", menuBlock.includes('"显示悬浮球"'));
check("托盘菜单含「退出程序」", menuBlock.includes('"退出程序"'));
check("托盘不再调用 openMainPageFromTray", !menuBlock.includes("openMainPageFromTray"));
check("退出程序 → app.quit", menuBlock.includes("app.quit()"));
check("退出程序单独分组（前面有 separator）", menuBlock.includes('{ type: "separator" }'));
const itemCount = (menuBlock.match(/label:/g) || []).length;
check("托盘菜单恰好 2 项", itemCount === 2, `实际 ${itemCount}`);
// 但「显示主页面」的能力本身必须还在（原生右键菜单还在用它）
check("★ openMainPageFromTray 仍然存在（删的只是托盘入口，不是能力）", mainSrc.includes("function openMainPageFromTray("));

// 3) ★ 托盘图标必须走渲染层（nativeImage 不解析 GIF，已实测）
check("托盘不再用 createFromPath 读头像", !/createFromPath\(\s*avatarFilePath/.test(mainSrc));
check("托盘走 createFromDataURL", mainSrc.includes("nativeImage.createFromDataURL"));
check("调用了渲染层的 __orbTrayIconPng", mainSrc.includes("__orbTrayIconPng"));
check("有兜底图标常量", mainSrc.includes("TRAY_FALLBACK_PNG"));

// 4) 渲染层那一半确实存在（shell.js）
const shellSrc = readFileSync(join(PROJECT_ROOT, "helper", "assets", "shell.js"), "utf8");
check("shell.js 注册了 __orbTrayIconPng", shellSrc.includes("window.__orbTrayIconPng"));
check("shell.js 用 canvas 取帧", shellSrc.includes("toDataURL('image/png')"));

// 4b) ★★ 托盘只吃单张 NativeImage —— 数组会抛错（probe/tray-api-check.cjs 实测）
//     `setImage(NativeImage[])` / `new Tray(NativeImage[])` 都抛
//     `Argument must be a file path or a NativeImage`。
check(
  "没有把 NativeImage[] 塞给托盘（数组 API 不存在）",
  !/TRAY_ICON_SIZES/.test(mainSrc) && !/trayImageSetFromDataUrl/.test(mainSrc) && !/new Tray\([^)]*\[\s*0\s*\]/.test(mainSrc)
);
check("托盘走单图路径 trayImageFromDataUrl", mainSrc.includes("function trayImageFromDataUrl("));

// 4d) ★★ 双击托盘崩溃的回归锁（2026-10-08 用户真机报错）
//
//     实测报错：`TypeError: tray?.popupContextMenu is not a function`
//     —— `popupContextMenu` 是 **BrowserWindow** 的方法，Tray 上根本没有。
//     我一度在 `tray.on("click")` 里调它，四类探针**全绿**却仍然崩，
//     因为那是个事件回调里的运行时错误，只有「人真去双击」才触发。
//     → 这是「探针测接口通不通 ≠ 用户点得到」的又一例。
//     现在断言：主进程源码里**不许再出现** `popupContextMenu` 的调用。
check(
  "托盘不再调用不存在的 popupContextMenu（双击崩溃根因）",
  !/\.popupContextMenu\(/.test(mainSrc)
);
check("托盘保留 setContextMenu（Windows 左键单击即弹它设的菜单）", mainSrc.includes("tray.setContextMenu("));

// 4e) 隐藏悬浮球（用户 2026-10-08 新增需求）—— 三个出口 + 一个状态
check("有 ballHidden 状态", /let ballHidden = false/.test(mainSrc));
check("有 hideBall()", mainSrc.includes("function hideBall()"));
check("有 showBall()", mainSrc.includes("function showBall()"));
check("hideBall 走 win.hide()", /function hideBall\(\)[\s\S]*?win\.hide\(\)/.test(mainSrc));
check("showBall 走 win.showInactive()", /function showBall\(\)[\s\S]*?win\.showInactive\(\)/.test(mainSrc));
check(
  "hideBall 先关鼠标穿透再隐藏（否则留一块看不见但吃鼠标的幽灵热区）",
  /function hideBall\(\)[\s\S]*?setIgnoreMouseEvents\(true\)[\s\S]*?win\.hide\(\)/.test(mainSrc)
);
check(
  "showBall 通过 overlays.invalidateClickThrough 恢复穿透（不自己写字面值，避免与单一所有者打架）",
  /function showBall\(\)[\s\S]*?invalidateClickThrough/.test(mainSrc)
);

// 4f) ★★ 「显示主页面」不许静默失败（用户 2026-10-08 报「打开 旧后端 是无效的」）
//
//     现象：点托盘「显示主页面」什么都不发生。
//     真因：`openLegacyWeb()` 在拿不到地址时只写一条 console.error 就 return；
//          渲染层本来有兜底（`shell.js` 的 openLegacyWeb → 开「API 配置」抽屉），
//          但那要经过 `orb:open-letta-web` 信道，而托盘是**主进程直连**，绕过了它。
//     → 又一个「静默丢弃族」成员：日志干净、零报错、就是不发生。
//     修法：主进程先让渲染层跑它那份带兜底的实现；渲染层够不到才自己直开；
//          直开也失败就弹原生对话框 —— 总之**失败必须有去处**。
{
  const entry = mainSrc.slice(mainSrc.indexOf("function openMainPageFromTray"), mainSrc.indexOf("function openHistoryPanel"));
  check("有 openMainPageFromTray 入口", entry.length > 0);
  check("入口里先 showBall（球藏起来时点它是为了「重新看到东西」）", entry.includes("showBall()"));
  check("入口走渲染层钩子 __orbOpenLegacyWeb", entry.includes("__orbOpenLegacyWeb"));
  check("入口在直开失败时弹原生对话框", entry.includes("notifyNoLegacyAddress()"));
  check("有 notifyNoLegacyAddress 实现（原生 dialog，而不是 console）", /function notifyNoLegacyAddress\(\)[\s\S]*?dialog\.showMessageBox/.test(mainSrc));
  // 关键：openLegacyWeb 必须返回布尔，否则调用方无法区分「开成了」和「静默失败」。
  check(
    "openLegacyWeb 返回布尔（没地址 false / 开了 true），调用方才判得出失败",
    /function openLegacyWeb\(\)[\s\S]*?return false;[\s\S]*?return true;/.test(mainSrc)
  );
  // 只数**主进程里真正的直接调用**（`actions.openLegacyWeb()` 是委派给下面这个入口的，
  // 不重复计；注释行 / 函数定义行也不算）。
  const callLines = mainSrc
    .split("\n")
    .filter((L) => !/^\s*(\/\/|\*|\/\*)/.test(L)) // 注释
    .filter((L) => !/function openLegacyWeb/.test(L)) // 定义
    .filter((L) => !/actions\.openLegacyWeb/.test(L)) // 委派
    .filter((L) => !/openLegacyWeb:/.test(L)) // 对象字面量里的键
    .filter((L) => /openLegacyWeb\(\)/.test(L));
  const guarded = callLines.filter((L) => /!openLegacyWeb\(\)/.test(L));
  check(
    "openLegacyWeb 的所有直接调用点都判返回值（不静默）",
    callLines.length > 0 && callLines.length === guarded.length,
    `调用 ${callLines.length} 处 / 判返回值 ${guarded.length} 处`
  );
}

// 4g) 渲染层那一半：__orbOpenLegacyWeb 钩子必须存在（主进程靠它拿到抽屉兜底）
check("shell.js 暴露 __orbOpenLegacyWeb 给主进程", /window\.__orbOpenLegacyWeb\s*=/.test(
  readFileSync(join(PROJECT_ROOT, "helper", "assets", "shell.js"), "utf8")
));

// 4h) ★★ 环菜单「隐藏悬浮球」（用户 2026-10-08：「右键球体我没找到隐藏悬浮球」）
//
//     实测诊断：原生右键菜单里**本来就有**（contextMenuTemplate 第 8 项），
//     但**环菜单完全没有** —— 用户截图里展开的正是环菜单，所以他「找不到」。
//     这是「同一个功能有两套菜单，只补了一套」的典型漏。
{
  const shellSrc = readFileSync(join(PROJECT_ROOT, "helper", "assets", "shell.js"), "utf8");
  const ringSrc = readFileSync(join(PROJECT_ROOT, "helper", "assets", "ring-menu.js"), "utf8");

  // 环菜单项里有它
  const ringItemsBlock = shellSrc.slice(shellSrc.indexOf("function ringItems()"), shellSrc.indexOf("function ringItems()") + 700);
  check("环菜单加入了 ball-hide 项", ringItemsBlock.includes("'ball-hide'"));
  check("环菜单的隐藏项文案走 messages.menuHideBall", ringItemsBlock.includes("messages.menuHideBall"));
  check("中英文都有 menuHideBall 文案", shellSrc.includes("menuHideBall: '隐藏悬浮球'") && shellSrc.includes("menuHideBall: 'Hide floating ball'"));
  check("环菜单有 ball-hide 的图标（否则显示兜底的圆圈）", ringSrc.includes("'ball-hide':"));
  check("环菜单兜底项也含 ball-hide", /FALLBACK_ITEMS\s*=\s*\[[^\]]*'ball-hide'/.test(ringSrc));

  // ★ 关键：ball-hide 不能走 runRingAction 的 setExpanded(true) 老路
  check(
    "runRingAction 对 ball-hide 提前返回（不展开面板）",
    /async function runRingAction\(id\)\s*\{\s*if \(id === 'ball-hide'\) return/.test(shellSrc)
  );
  check(
    "handleMenuAction 有 ball-hide 分支（走 api.hideBall）",
    /id === 'ball-hide'[\s\S]{0,160}api\.hideBall/.test(shellSrc)
  );
  // 主进程截流：环菜单的 ball-hide 直接 hideBall，不回传球窗口
  check(
    "主进程在 orb:ring-action 里截流 ball-hide（直接 hideBall，不回传）",
    /orb:ring-action[\s\S]{0,400}ball-hide[\s\S]{0,200}hideBall\(\)/.test(mainSrc)
  );
  // 专用信道
  check("preload 暴露 api.hideBall", /hideBall\(\)\s*\{\s*ipcRenderer\.send\('orb:ball-hide'\)/.test(
    readFileSync(join(PROJECT_ROOT, "helper", "preload.cjs"), "utf8")
  ));
  check("主进程注册 orb:ball-hide 并校验 fromBall", /ipcMain\.on\("orb:ball-hide"[\s\S]{0,120}fromBall\(event\)[\s\S]{0,80}hideBall\(\)/.test(mainSrc));
}

// 4i) ★★★ 环菜单跟随球移动：**必须问 placement，不许自己从 bounds 反推**
//
//     用户报过**两次**「拖动球体，菜单就会飞出去」。两次的修法记录如下（防再犯）：
//
//       第一版：存 `ringAnchor = 球心相对球窗口视口的坐标`。
//               窗口一收缩（面板→球尺寸）相对偏移就过期 ⇒ 飞。
//       第二版：以为「球永远贴窗口左上角」，改成 `bounds + CHROME_INSET + 半径`。
//               **仍然飞** —— 展开态球贴的是窗口的**右/下**边（看 direction），
//               停靠态球也不在左上角。实测展开态偏差 **427px**。
//       第三版（现在）：`ballCenterScreen()` 直接问 `placement.currentBallOrigin()`。
//               它是唯一真正知道「球在窗口哪一角」的地方 —— 不要再有第二个真相源。
//
//     ★ 为什么两版都错、探针还全绿：旧探针在改 bounds 前先手动缩成 96×96，
//       等于把「展开态」这条真实路径跳过了。探针测的是「我以为的场景」，
//       不是「用户实际踩到的场景」—— 「探针测接口通不通 ≠ 用户点得到」的第九例。
{
  check("有 ballCenterScreen", mainSrc.includes("function ballCenterScreen("));
  check(
    "★★ ballCenterScreen 走 placement.currentBallOrigin（权威来源，不自己反推）",
    /function ballCenterScreen[\s\S]{0,900}placement\?\.currentBallOrigin\?\.\(\)/.test(mainSrc)
  );
  check(
    "★ ballCenterScreen 不再无脑用「左上角 + CHROME_INSET」当主路径",
    // 兜底分支允许有（placement 未就绪时），但它必须在 origin 判空**之后**
    (() => {
      const body = mainSrc.slice(mainSrc.indexOf("function ballCenterScreen("), mainSrc.indexOf("function ballCenterScreen(") + 1200);
      const iOrigin = body.indexOf("currentBallOrigin");
      const iFallback = body.indexOf("CHROME_INSET + BALL_SIZE / 2");
      return iOrigin !== -1 && iFallback !== -1 && iOrigin < iFallback;
    })()
  );
  check("★ ringAnchor 已彻底删除", !/let ringAnchor/.test(mainSrc) && !/ringAnchor\s*=/.test(mainSrc.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")));
  check(
    "repositionRingMenuWindow 用 ballCenterScreen（并判空）",
    /function repositionRingMenuWindow[\s\S]{0,500}ballCenterScreen\(\)[\s\S]{0,200}if \(!center\) return/.test(mainSrc)
  );
  check(
    "orb:ring-open 里的摆放也用 ballCenterScreen（不叠渲染层传来的视口偏移）",
    /orb:ring-open[\s\S]{0,1600}ballCenterScreen\(\)[\s\S]{0,200}if \(!center\) return/.test(mainSrc)
  );
  // ★ 光挂 move 不够：拖动第一帧是**改尺寸**，球的「角」会跳，resize 也要跟
  check(
    "★ 跟随同时挂了 move 与 resize（改尺寸那一刻球的角会跳）",
    /win\.on\("move", follow\)[\s\S]{0,200}win\.on\("resize", follow\)/.test(mainSrc)
  );
}

// 4j) ★ 隐藏球必须**自己刷托盘**（用户第三轮反馈：「环菜单里隐藏后，托盘文字没翻转」）
//
//     根因：刷托盘原来写在**托盘那一项的 click 回调里**，于是只有「从托盘点」
//     文案才对；「从环菜单点」不经过那段代码 ⇒ 球已藏、托盘却还写「隐藏悬浮球」，
//     用户再点一下反而把球叫回来。
//     这是「状态变更和它的副作用分家」——调用方有四条路，漏一条就一个 bug
//     （与「穿透必须单一所有者」同源）。
{
  const hideFn = mainSrc.slice(mainSrc.indexOf("function hideBall()"), mainSrc.indexOf("function hideBall()") + 900);
  const showFn = mainSrc.slice(mainSrc.indexOf("function showBall()"), mainSrc.indexOf("function showBall()") + 1100);
  check("★ hideBall 自己调 refreshTrayMenu（不依赖调用方）", /function hideBall\(\)[\s\S]{0,700}refreshTrayMenu\(\)/.test(mainSrc));
  check("★ showBall 自己调 refreshTrayMenu", /function showBall\(\)[\s\S]{0,800}refreshTrayMenu\(\)/.test(mainSrc));
  check("hideBall 里 refreshTrayMenu 在 closeRingMenuWindow 之后（顺序对上）", hideFn.indexOf("closeRingMenuWindow") < hideFn.indexOf("refreshTrayMenu") && hideFn.indexOf("closeRingMenuWindow") !== -1);
  // 托盘那一项**不该**再自己刷（那正是「管不全」的成因）。
  // ★ 先剥掉注释再判 —— 代码里刻意留了一句「不用在这里 refreshTrayMenu()」的说明，
  //   不剥注释会把这句话当成违规（第一版就踩了）。
  const trayItemRaw = mainSrc.slice(mainSrc.indexOf("function trayMenuTemplate()"), mainSrc.indexOf("function trayImageFromDataUrl"));
  const trayItem = trayItemRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("★ 托盘 click 里不再自己 refreshTrayMenu（副作用已收进 hide/show）", !/click:\s*\(\)\s*=>\s*\{[\s\S]{0,220}refreshTrayMenu/.test(trayItem));
}

// 4k) ★★ 抽屉互斥必须**对称**（用户第三轮反馈：「从 API 配置页点历史会话，两页叠着」）
//
//     根因：三个抽屉各有 `setExclusiveOpen('xxx')` 在打开时关掉**历史**，
//     但 `setHistoryOpen(true)` **不关它们** —— 方向是单向的。
//     `handleMenuAction('history')` 里有一句手写补丁替它兜了，
//     而左下角的历史按钮直接调 `setHistoryOpen`，没有那句 ⇒ 就叠了。
//     修法：把互斥收进 `setHistoryOpen` 自己，所有调用点自动都对。
{
  const shellSrc = readFileSync(join(PROJECT_ROOT, "helper", "assets", "shell.js"), "utf8");
  const fn = shellSrc.slice(shellSrc.indexOf("function setHistoryOpen(next)"), shellSrc.indexOf("function setHistoryOpen(next)") + 2600);
  check(
    "★★ setHistoryOpen(true) 会关掉 apiConfigPanel（修「从 API 页点历史」叠加）",
    /if \(next\) \{[\s\S]{0,200}apiConfigPanel\?\.setOpen\(false\)/.test(fn)
  );
  check(
    "★★ setHistoryOpen(true) 会关掉 impressionPanel / themePanel（三个都要）",
    /if \(next\) \{[\s\S]{0,300}impressionPanel\?\.setOpen\(false\)[\s\S]{0,200}themePanel\?\.setOpen\(false\)/.test(fn)
  );
  check("★ 先互斥后记账（if (next) 在 historyOpen = next 之前）", fn.indexOf("if (next) {") < fn.indexOf("historyOpen = next"));
  // handleMenuAction 里那句手写补丁必须删掉 —— 补丁写在调用点就是本 bug 的成因
  check(
    "★ handleMenuAction('history') 不再手写关抽屉（已收进 setHistoryOpen）",
    !/id === 'history'\) \{[\s\S]{0,300}apiConfigPanel\?\.setOpen\(false\)/.test(shellSrc)
  );
}

// 4c) ★★ 兜底图标必须是**真图**：上一版是坏 base64，实测 isEmpty=true
//     ⇒ createTray() bail ⇒ 托盘整个不出现（而且只有一行 error）。
{
  const m = mainSrc.match(/const TRAY_FALLBACK_PNG =\s*([\s\S]*?);\n/);
  const b64 = m
    ? m[1]
        .split("\n")
        .map((line) => {
          const hit = line.match(/"([A-Za-z0-9+/=]+)"/);
          return hit ? hit[1] : "";
        })
        .join("")
    : "";
  // ★ base64 对齐：9 个 base64 字符 = 6.75 字节，不足以覆盖 8 字节 PNG 魔数。
  //   12 个字符 = 9 字节，解出来是 `89504e470d0a1a0a00` —— 前 8 字节正是
  //   PNG 签名 89 50 4E 47 0D 0A 1A 0A。用 12 字符比对才稳。
  const head = b64.slice(0, 12);
  const magic = Buffer.from(head, "base64").toString("hex").slice(0, 16);
  check("兜底图标是 data:image/png;base64", /TRAY_FALLBACK_PNG =\s*"data:image\/png;base64,"/.test(mainSrc));
  check("兜底图标是合法 PNG（魔数 89504e470d0a1a0a）", magic === "89504e470d0a1a0a", `实际 ${magic}`);
  check("兜底图标 base64 长度合理（>120 字符）", b64.length > 120, `实际 ${b64.length}`);
}

// 5) 每一个预设头像文件都真实存在（托盘取不到图 = 静默空白）
for (const src of AVATAR_PRESETS) {
  const file = join(PROJECT_ROOT, "helper", "assets", src);
  check(`素材存在 ${src}`, existsSync(file), existsSync(file) ? "" : file);
}

// 6) 安全正则：合法路径通过、越界拒绝
check("正则接受 预设", PRESET_SRC.test("avatars/smile.gif"));
check("正则接受 默认", PRESET_SRC.test(DEFAULT_AVATAR_SRC));
check("正则拒绝 目录穿越", !PRESET_SRC.test("../secret.gif"));
check("正则拒绝 绝对路径", !PRESET_SRC.test("C:/x.gif"));
check("正则拒绝 大写/特殊字符", !PRESET_SRC.test("avatars/happy@0.85x.gif"));

// 7) 三种头像形态的判定（渲染层 __orbTrayIconPng 的分支语义）
function classify(src) {
  if (!src) return "default";
  if (src.startsWith("data:")) return "dataurl";
  if (!PRESET_SRC.test(src)) return "reject";
  return "preset";
}
check("空串 → 默认图", classify("") === "default");
check("预设 → preset", classify("avatars/heart.gif") === "preset");
check("data URL → dataurl", classify("data:image/gif;base64,R0lGOD") === "dataurl");
check("非法 → reject", classify("../x.gif") === "reject");

// 8) ★ 反向验证：三处 send("orb:avatar") 必须已收敛进 setBallAvatar
// 先剥掉注释行 —— 反例说明里也写着这段代码，不剥会误报。
const codeOnly = mainSrc
  .split("\n")
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join("\n");
const rawSends = codeOnly.match(/\.webContents\.send\("orb:avatar"/g) || [];
check(
  "orb:avatar 直推点已收敛（只应剩 did-finish-load + setBallAvatar 共 2 处）",
  rawSends.length === 2,
  `实际 ${rawSends.length} 处`
);
check("setBallAvatar 会刷新托盘", /function setBallAvatar[\s\S]{0,400}refreshTrayIcon\(src\)/.test(mainSrc));
check("loadAvatar 三条分支都走 setBallAvatar", (mainSrc.slice(mainSrc.indexOf("async function loadAvatar"), mainSrc.indexOf("function fetchAvatar")).match(/setBallAvatar\(/g) || []).length === 3);
check("before-quit 销毁托盘", /before-quit[\s\S]{0,400}tray\.destroy\(\)/.test(mainSrc));

console.log(failed === 0 ? "\n=== 全部通过 ===" : `\n=== ${failed} 项失败 ===`);
process.exit(failed === 0 ? 0 : 1);
