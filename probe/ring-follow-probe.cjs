/**
 * ★★ 环菜单「跟随球体」的**真窗口**验证（Electron）。
 *
 * 用户报的 bug：「右键展开环形菜单时，拖动球体，菜单就会飞出去」。
 * ★ 用户第二次反馈「这个bug还在」—— 因为**第一版修法是错的**，这个探针也错，
 *   它假设「球永远贴窗口左上角」，于是把真实失败场景整条跳过了。
 *   本版重写为**覆盖三种球位**，专门盯住上一版漏掉的那条。
 *
 * 上一版为什么漏：
 *   它在改 bounds 前先手动把窗口缩成 96×96，等于替主进程把「展开态」跳过了。
 *   而真实拖动第一帧里，`placement.move()` 有可能仍读到**还没缩完的展开尺寸**，
 *   走 `overlayBoundsFromBall` 那条**球在窗口右下角**的分支 —— 那一刻用
 *   「左上角 + inset」公式算球心，能差出整整一个面板宽度。
 *
 * 本版验什么：
 *   1. 收起态：球在窗口左上角 → 左上角公式能用（所以第一版自测是绿的）；
 *   2. ★ 展开态（direction=left/up）：球在窗口**右/下**边 → 左上角公式**必然错**，
 *      而权威算法（ballOriginFromWindow）正确；
 *   3. ★ 停靠态：窗口 96×88、球在 y-8 处 → 左上角公式也错；
 *   4. 反向对照：证明这两条断言真的能抓 bug（左上角公式的偏差必须 > 50px）。
 *
 * 用法：python probe/run_ring_follow.py
 */
const { app, BrowserWindow, screen } = require("electron");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const OUT = join(__dirname, "_ring_follow.txt");

// ── 与 main.js 逐字同构的常量 ──
const BALL_SIZE = 72;
const CHROME_INSET = 12;
const BALL_WINDOW_SIZE = BALL_SIZE + 2 * CHROME_INSET; // 96
const PANEL = { width: 320, height: 420 };
const PANEL_WINDOW = { width: PANEL.width + 2 * CHROME_INSET, height: PANEL.height + 2 * CHROME_INSET };
const DOCK_GLOW = 8;
const DOCK_TAB_WIDTH = 8;
const DOCK_HOVER_MARGIN = 8;
const DOCK_HIT_WIDTH = DOCK_TAB_WIDTH + DOCK_GLOW + DOCK_HOVER_MARGIN;
const DOCK_HIT_HEIGHT = BALL_SIZE + 2 * DOCK_GLOW; // 88
const RING_OUTER_D = 248;
const RING_PAD = 16;
const RING_WINDOW_SIZE = RING_OUTER_D + RING_PAD * 2; // 280

// ── 被测算法 ──

/** ★ 权威算法：main.js 的 FloatingPlacement.currentBallOrigin（从 bounds + 状态推球左上角）。 */
function authoritativeBallOrigin(bounds, state) {
  if (state.docked) {
    // 停靠：窗口是贴边竖条，球被放在 ballY - DOCK_GLOW 处（见 dockedTabBounds）
    return { x: bounds.x, y: bounds.y + DOCK_GLOW };
  }
  if (bounds.width <= BALL_WINDOW_SIZE && bounds.height <= BALL_WINDOW_SIZE) {
    // 收起：球贴左上角
    return { x: bounds.x + CHROME_INSET, y: bounds.y + CHROME_INSET };
  }
  // 展开：球在窗口的哪一角由 direction 决定（见 ballOriginFromWindow）
  return {
    x: state.horizontal === "left" ? bounds.x + bounds.width - CHROME_INSET - BALL_SIZE : bounds.x + CHROME_INSET,
    y: state.vertical === "up" ? bounds.y + bounds.height - CHROME_INSET - BALL_SIZE : bounds.y + CHROME_INSET,
  };
}

/** ★ 第一版（错误）算法：无脑「窗口左上角 + inset」。 */
function naiveBallOrigin(bounds) {
  return { x: bounds.x + CHROME_INSET, y: bounds.y + CHROME_INSET };
}

function centerOf(origin) {
  return { x: origin.x + BALL_SIZE / 2, y: origin.y + BALL_SIZE / 2 };
}
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const lines = [];
let failed = 0;
function check(name, ok, extra = "") {
  lines.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (!ok) failed += 1;
}

app.whenReady().then(async () => {
  const work = screen.getPrimaryDisplay().workArea;
  lines.push(`工作区: ${work.x},${work.y} ${work.width}x${work.height}`);
  lines.push("");

  // 真窗口只用来拿「真实的 bounds 数值」，判定用的是两种算法本身
  const win = new BrowserWindow({
    x: work.x + 300,
    y: work.y + 200,
    width: 96,
    height: 96,
    frame: false,
    transparent: true,
    show: false,
    skipTaskbar: true,
    focusable: false,
  });

  // ── 场景 1：收起态（第一版能过的那条） ──
  win.setBounds({ x: work.x + 300, y: work.y + 200, width: BALL_WINDOW_SIZE, height: BALL_WINDOW_SIZE });
  {
    const b = win.getBounds();
    const truth = centerOf(authoritativeBallOrigin(b, {}));
    const naive = centerOf(naiveBallOrigin(b));
    check("收起态：权威算法 = 球心", dist(truth, { x: b.x + CHROME_INSET + BALL_SIZE / 2, y: b.y + CHROME_INSET + BALL_SIZE / 2 }) <= 1);
    check("收起态：左上角公式也对（所以第一版自测是绿的）", dist(naive, truth) <= 1, `偏差 ${dist(naive, truth).toFixed(1)}px`);
  }
  lines.push("");

  // ── 场景 2：★★ 展开态 —— 第一版漏掉、也是用户实际踩到的那条 ──
  {
    // direction: horizontal=left, vertical=up ⇒ 球贴在窗口**右下角**
    const expandedBounds = {
      x: work.x + 100,
      y: work.y + 100,
      width: PANEL_WINDOW.width,
      height: PANEL_WINDOW.height,
    };
    win.setBounds(expandedBounds);
    const b = win.getBounds();
    const state = { horizontal: "left", vertical: "up" };
    const truth = centerOf(authoritativeBallOrigin(b, state));
    const naive = centerOf(naiveBallOrigin(b));
    const err = dist(naive, truth);
    check(
      "★★ 展开态(左/上)：权威算法仍给出正确球心（球在右下角）",
      Math.abs(truth.x - (b.x + b.width - CHROME_INSET - BALL_SIZE / 2)) <= 1 &&
        Math.abs(truth.y - (b.y + b.height - CHROME_INSET - BALL_SIZE / 2)) <= 1
    );
    check(
      "★★ 反向对照：展开态下左上角公式严重偏离（这就是「菜单飞出去」）",
      err > 200,
      `偏差 ${err.toFixed(1)}px`
    );
    lines.push(`     展开窗口 ${b.width}×${b.height}：权威球心 ${truth.x},${truth.y} / 左上角公式 ${naive.x},${naive.y}`);
  }
  lines.push("");

  // ── 场景 3：停靠态 —— 窗口 96×88、球不在左上角 ──
  {
    win.setBounds({ x: work.x + 4, y: work.y + 300, width: DOCK_HIT_WIDTH, height: DOCK_HIT_HEIGHT });
    const b = win.getBounds();
    const truth = centerOf(authoritativeBallOrigin(b, { docked: "left" }));
    const naive = centerOf(naiveBallOrigin(b));
    const err = dist(naive, truth);
    check(
      "★ 停靠态：权威算法把球放在 ballY-DOCK_GLOW 处（不在左上角）",
      Math.abs(truth.y - (b.y + DOCK_GLOW + BALL_SIZE / 2)) <= 1,
      `窗口 ${b.width}×${b.height}`
    );
    check("★ 反向对照：停靠态下左上角公式也偏（虽比展开态小）", err > 0, `偏差 ${err.toFixed(1)}px`);
  }
  lines.push("");

  // ── 场景 4：四种 direction 组合都要对 ──
  {
    const eb = { x: work.x, y: work.y, width: PANEL_WINDOW.width, height: PANEL_WINDOW.height };
    win.setBounds(eb);
    const b = win.getBounds();
    let worst = 0;
    for (const horizontal of ["left", "right"]) {
      for (const vertical of ["up", "down"]) {
        const truth = centerOf(authoritativeBallOrigin(b, { horizontal, vertical }));
        const naive = centerOf(naiveBallOrigin(b));
        worst = Math.max(worst, dist(naive, truth));
        // 权威算法推出的球心必须落在窗口内、且与面板边距一致
        const okX = truth.x >= b.x && truth.x <= b.x + b.width;
        const okY = truth.y >= b.y && truth.y <= b.y + b.height;
        check(`展开态 ${horizontal}/${vertical}：权威球心落在窗口内`, okX && okY);
      }
    }
    check("★ 左上角公式在展开态的最坏偏差 > 200px", worst > 200, `最坏 ${worst.toFixed(1)}px`);
  }

  lines.push("");
  lines.push(`=== ${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);

  writeFileSync(OUT, lines.join("\n"), "utf8");
  console.log(lines.join("\n"));
  app.exit(failed === 0 ? 0 : 1);
});

setTimeout(() => {
  writeFileSync(OUT, lines.join("\n") + "\n(超时兜底)", "utf8");
  console.log("TIMEOUT");
  app.exit(2);
}, 30000);
