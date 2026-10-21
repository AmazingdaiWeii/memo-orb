/**
 * ★★ 环菜单窗口「不透明方块」复现探针。
 *
 * 用户现象：环菜单周围有一个**隐约的方块**（跟他截图里的环形菜单同尺寸）。
 * 我用像素分析量过：方块 = x73..422 / y10..359，宽 349px。
 * 349 = RING_WINDOW_SIZE(280) × 1.246（该显示器的缩放）——
 * 所以那个方块**就是环窗口自身的足迹**：透明没生效，窗口画了一层淡色底。
 *
 * 这个探针比三种窗口配置，看谁能真正透明：
 *   A. 现状（transparent + backgroundColor:#00000000 + focusable:false + show:false→showInactive）
 *   B. 去掉 focusable:false（改成 true，和球窗口一致）
 *   C. A + 显式 setBackgroundColor('#00000000') + show 前等 ready-to-show
 *
 * 判据：截窗口区域，看「环外」的像素是否等于桌面背景（截不到桌面则比较
 * 窗口截图与「纯色填充窗口」的差异 —— 透明窗口的环外像素 alpha=0）。
 *
 * 用法：python probe/run_ring_transparency.py
 */
const { app, BrowserWindow, screen } = require("electron");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const OUT = join(__dirname, "_ring_transparency.txt");
const HTML = join(ROOT, "helper", "assets", "ring-menu.html");

const RING_OUTER_D = 248;
const RING_BAND = 40;
const RING_PAD = 16;
const RING_WINDOW_SIZE = RING_OUTER_D + RING_PAD * 2;

const lines = [];
function say(s) {
  lines.push(s);
  console.log(s);
}

function makeWin(extra) {
  return new BrowserWindow({
    width: RING_WINDOW_SIZE,
    height: RING_WINDOW_SIZE,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    roundedCorners: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    ...extra,
  });
}

/** 截窗口，返回「环外四角」的平均亮度与 alpha。 */
async function probeCorners(win, label) {
  // ★ 用 win.capturePage() 而不是 win.webContents.capturePage()：
  //   后者在透明窗口上抛 UnknownVizError（实测），前者是项目里
  //   ctxmenu-glass-probe 已在用的写法，能拿到带 alpha 的位图。
  const img = await win.capturePage();
  const size = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const w = size.width;
  const h = size.height;
  // 取四角各 12x12 区域（那里应完全在环外）
  const corners = [
    [2, 2],
    [w - 14, 2],
    [2, h - 14],
    [w - 14, h - 14],
  ];
  let aSum = 0;
  let aN = 0;
  let minA = 255;
  for (const [cx, cy] of corners) {
    for (let y = cy; y < cy + 12; y++) {
      for (let x = cx; x < cx + 12; x++) {
        const i = (y * w + x) * 4;
        const a = bmp[i + 3];
        aSum += a;
        aN += 1;
        if (a < minA) minA = a;
      }
    }
  }
  const avg = aSum / aN;
  say(`  ${label}: 尺寸 ${w}×${h}，环外四角平均 alpha = ${avg.toFixed(1)}，最小 alpha = ${minA}`);
  return { avg, minA, w, h };
}

app.whenReady().then(async () => {
  say("工作区: " + JSON.stringify(screen.getPrimaryDisplay().workArea));
  say("");

  const cases = [
    { label: "A 现状（focusable:false, backgroundColor 透明）", extra: { focusable: false } },
    { label: "B 去掉 focusable:false（与球窗口一致）", extra: { focusable: true } },
    { label: "C focusable:true + show 前等 ready-to-show", extra: { focusable: true }, waitReady: true },
  ];

  for (const c of cases) {
    const win = makeWin(c.extra);
    await win.loadFile(HTML, {
      query: { outer: String(RING_OUTER_D), band: String(RING_BAND), pad: String(RING_PAD) },
    });
    if (c.waitReady) await new Promise((r) => win.once("ready-to-show", r));
    win.setAlwaysOnTop(true, "screen-saver");
    win.showInactive();
    await new Promise((r) => setTimeout(r, 700)); // 给合成器时间
    c.result = await probeCorners(win, c.label);
    win.destroy();
    say("");
  }

  say("=== 判定 ===");
  const best = cases.reduce((a, b) => (a.result.avg <= b.result.avg ? a : b));
  for (const c of cases) {
    say(`${c.result.avg <= 1 ? "PASS" : "FAIL"}  ${c.label}（alpha ${c.result.avg.toFixed(1)}）`);
  }
  say("");
  say(`最佳配置：${best.label}（alpha ${best.result.avg.toFixed(1)}）`);
  say("alpha ≈ 0 ⇒ 透明生效；alpha ≈ 255 ⇒ 画了不透明底（＝用户看到的方块）");

  writeFileSync(OUT, lines.join("\n"), "utf8");
  app.exit(0);
});

setTimeout(() => {
  writeFileSync(OUT, lines.join("\n") + "\n(超时兜底)", "utf8");
  console.log("TIMEOUT");
  app.exit(2);
}, 40000);
