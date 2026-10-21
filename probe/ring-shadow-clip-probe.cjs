/**
 * ★★ 环菜单「隐约的方块」是否真的修好了 —— 端到端验证探针（2026-10-08 第四轮）。
 *
 * 背景：用户截图里环菜单上有一层淡方块。像素分析结论是
 *   `#plane` 的 `box-shadow: 0 22px 54px` 外扩 22+54/2 = 49px，
 *   而旧窗口只留了 RING_PAD(16px) 的余量 ⇒ 阴影被窗口边界**垂直切平**，
 *   梯度在窗口边上戛然而止，肉眼看就是「一个隐约的方块」。
 * 修法：加 `RING_SHADOW_ROOM`，把窗口撑大到装得下阴影（环的视觉尺寸不变）。
 *
 * 这个探针**不看角落 alpha**（那是「窗口透不透明」的问题，另一支探针验过了），
 * 而是直接量「阴影梯度有没有在边界上被切断」：
 *
 *   取窗口**中心竖直一条线**（穿过环的下方那段阴影），从窗口上边缘往下扫，
 *   看 alpha/亮度是不是**连续**下降。被切平的旧版会在窗口边界处出现一个
 *   **突变台阶**（正是用户截图里 255 → 224 那一跳）。
 *
 * 判据：窗口边缘处的一阶差分 |Δ| 必须很小（梯度平滑），
 *       且边缘处的值几乎为 0（阴影耗尽），而不是被硬切在一个大值上。
 *
 * 反向对照：把 shadowRoom 设成 0（＝旧版），同一条线必须出现大台阶。
 *
 * 用法：python probe/run_ring_shadow_clip.py
 */
const { app, BrowserWindow, screen } = require("electron");
const { writeFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const OUT = join(__dirname, "_ring_shadow_clip.txt");
const HTML = join(ROOT, "helper", "assets", "ring-menu.html");
const CSS = join(ROOT, "helper", "assets", "ring-menu.css");

const lines = [];
function say(s) {
  lines.push(s);
  console.log(s);
}

/** 从产品 CSS 里抽真实几何，避免探针抄一份数字。 */
function productGeometry() {
  const css = readFileSync(CSS, "utf8");
  const num = (name, fallback) => {
    const m = css.match(new RegExp(`--${name}:\\s*(\\d+(?:\\.\\d+)?)px`));
    return m ? Number(m[1]) : fallback;
  };
  return {
    outer: num("ring-outer", 248),
    pad: num("ring-pad", 16),
    shadowRoom: num("ring-shadow-room", 0),
  };
}

function makeWin(size) {
  return new BrowserWindow({
    width: size,
    height: size,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true, // ★ 探针要在同一个窗口上切尺寸跑两个用例（产品里是 false，无所谓）
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    show: false,
    backgroundColor: "#00000000",
    roundedCorners: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
}

/** 反复重试 capturePage —— 透明窗口上首次截图会偶发 UnknownVizError（合成器没就绪）。 */
async function captureWithRetry(win, tries = 6) {
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await win.capturePage();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  throw lastErr;
}

/**
 * 沿着窗口中心的竖直扫描线，从**上边缘**往下取 alpha。
 * 返回 `{ alphas, stepTop, stepBottom, edgeTop, edgeBottom }`：
 *   - edgeTop/edgeBottom：紧贴窗口上/下边缘内侧的 alpha（阴影没被切的话应接近 0）
 *   - stepTop/stepBottom：边缘处相邻两行的一阶差分绝对值（梯度平滑则很小）
 */
async function scan(win, size) {
  const img = await captureWithRetry(win);
  const s = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const w = s.width;
  const h = s.height;
  const x = Math.floor(w / 2);
  const alphas = [];
  for (let y = 0; y < h; y += 1) {
    alphas.push(bmp[(y * w + x) * 4 + 3]);
  }
  // 上边缘：第 0..3 行；下边缘：末 4 行
  const tap = (arr) => {
    let max = 0;
    for (let i = 1; i < arr.length; i += 1) max = Math.max(max, Math.abs(arr[i] - arr[i - 1]));
    return max;
  };
  const stepTop = tap(alphas.slice(0, 6));
  const stepBottom = tap(alphas.slice(-6));
  return {
    w,
    h,
    size,
    edgeTop: alphas[0],
    edgeBottom: alphas[h - 1],
    stepTop,
    stepBottom,
    scan: alphas,
  };
}

app.whenReady().then(async () => {
  const g = productGeometry();
  // ring-geometry.js 是 ESM，.cjs 里 require 不进来 —— 窗口边长直接照公式算。
  // 公式本体由 probe/ring-geometry-test.mjs 的 §5.5 断言与 main.js 对账，这里只做探针用途。
  const fixedWindow = g.outer + (g.pad + g.shadowRoom) * 2;
  const legacyWindow = g.outer + g.pad * 2;

  say("工作区: " + JSON.stringify(screen.getPrimaryDisplay().workArea));
  say(`CSS 几何: outer=${g.outer} pad=${g.pad} shadowRoom=${g.shadowRoom}`);
  say(`新窗口边长=${fixedWindow}  旧窗口边长=${legacyWindow}  （差 ${fixedWindow - legacyWindow}）`);
  say("");

  const cases = [
    { label: "新（含 shadowRoom）", size: fixedWindow, shadowRoom: g.shadowRoom, expect: "clean" },
    { label: "旧（shadowRoom=0，反向对照）", size: legacyWindow, shadowRoom: 0, expect: "clipped" },
  ];

  const results = [];
  // ★ 用**同一个窗口**跑两个用例（reload 换 query），而不是每个用例新建窗口 ——
  //   连续 new BrowserWindow 立刻 loadFile 会偶发 ERR_FAILED(-2)（合成器没准备好），
  //   本项目的探针历史上反复踩到这个（见 ring-transparency-probe 的 B/C 用例）。
  const maxSize = Math.max(...cases.map((c) => c.size));
  const win = makeWin(maxSize);
  win.setAlwaysOnTop(true, "screen-saver");
  for (const c of cases) {
    win.setSize(c.size, c.size);
    let loaded = false;
    for (let attempt = 0; attempt < 4 && !loaded; attempt += 1) {
      try {
        await win.loadFile(HTML, {
          query: { outer: String(g.outer), band: "40", pad: String(g.pad), shadowRoom: String(c.shadowRoom) },
        });
        loaded = true;
      } catch (err) {
        say(`  （第 ${attempt + 1} 次加载失败：${err.message}，重试）`);
        await new Promise((r) => setTimeout(r, 600));
      }
    }
    if (!loaded) {
      say(`  ✗ ${c.label} 加载不上，跳过`);
      results.push({ ...c, skipped: true });
      continue;
    }
    if (!win.isVisible()) win.showInactive();
    await new Promise((r) => setTimeout(r, 900));

    say(`  → 截图中（${c.size}×${c.size} CSS px）…`);
    let r;
    try {
      r = await scan(win, c.size);
    } catch (err) {
      say(`  ✗ ${c.label} capturePage 失败：${err.message}`);
      results.push({ ...c, skipped: true });
      continue;
    }
    results.push({ ...c, r });
    say(`[${c.label}] ${r.w}×${r.h}`);
    say(`  上边缘 alpha=${r.edgeTop}  边缘内最大台阶=${r.stepTop}`);
    say(`  下边缘 alpha=${r.edgeBottom}  边缘内最大台阶=${r.stepBottom}`);
    say(`  扫描线（每 8 行取一个）: ${r.scan.filter((_, i) => i % 8 === 0).join(",")}`);
    say("");
  }
  win.destroy();

  say("=== 判定 ===");
  let failed = 0;
  for (const item of results) {
    const { label, expect, r } = item;
    if (item.skipped) {
      say(`SKIP  ${label}：加载失败未能测量`);
      continue;
    }
    // 被切平 ⇒ 边缘处出现大台阶（阴影正浓时被窗口边界截断）
    const stepped = r.stepTop > 6 || r.stepBottom > 6;
    if (expect === "clean") {
      const ok = !stepped && r.edgeTop <= 4 && r.edgeBottom <= 4;
      say(`${ok ? "PASS" : "FAIL"}  ${label}：阴影梯度在窗口边界处平滑收敛（无台阶）`);
      if (!ok) failed += 1;
    } else {
      const ok = stepped || r.edgeTop > 4 || r.edgeBottom > 4;
      say(`${ok ? "PASS" : "FAIL"}  ${label}：旧版必须出现台阶/边缘不收敛（证明探针验得出东西）`);
      if (!ok) failed += 1;
    }
  }
  say("");
  say(failed === 0 ? "全部通过" : `${failed} 条失败`);

  writeFileSync(OUT, lines.join("\n"), "utf8");
  app.exit(failed === 0 ? 0 : 1);
});

setTimeout(() => {
  writeFileSync(OUT, lines.join("\n") + "\n(超时兜底)", "utf8");
  console.log("TIMEOUT");
  app.exit(2);
}, 60000);
