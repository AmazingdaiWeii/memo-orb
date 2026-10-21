/**
 * ctxmenu-glass-probe.cjs —— 实测「右键菜单的毛玻璃到底有没有糊到背景图」。
 *
 * ## 为什么要测
 *
 * 用户 2026-10-08：「接了窗口背景之后，之前的毛玻璃有点多此一举，根本看不出来」，
 * 并且具体指出 **记忆中心 / 历史页那个「选择总结记忆频率」的下拉**
 * （其实复用 `context-menu.js`，class 就是 `.ctxmenu`）看起来是一块实心深色板。
 *
 * 我原本的假设是「`.ctxmenu` 与 `#panel` 平级 ⇒ 采样不到背景」。
 * **这个假设被本探针推翻了**（见输出）：玻璃其实是生效的，只是被
 * 高不透明度的底色压住了。先把这件事钉死，再谈怎么改。
 *
 * ## 方法：同窗口换色，看菜单平均色跟不跟
 *
 * 绝不看「代码里有没有写 backdrop-filter」（写了也可能无效，假阳性）。
 * 做法是**一次窗口、同一位置、只换底下那张图的颜色**，然后比菜单区的平均色：
 *   - 平均色**跟着变** → 玻璃真生效（背景被采样进来了）
 *   - 平均色**一动不动** → 实心板（底下什么都糊不到）
 *
 * 输出 probe/_ctxmenu_glass.txt + 两张对照 PNG。
 */
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = resolve(__dirname, "..");
const A = "/helper/assets";
const OUT = join(__dirname, "_ctxmenu_glass.txt");
const lines = [];
const log = (...a) => lines.push(a.join(" "));

const RED = "rgba(220,40,40,1)";
const BLUE = "rgba(40,60,220,1)";
const AMBER = "rgba(230,180,40,1)";

function pageHtml() {
  const base = pathToFileURL(join(ROOT, "helper", "assets")).href;
  return `<!doctype html><html><head><meta charset="utf-8">
  <link rel="stylesheet" href="${base}/theme.css">
  <link rel="stylesheet" href="${base}/floating.css">
  <link rel="stylesheet" href="${base}/context-menu.css">
  <style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}</style>
  </head>
  <body class="expanded">
    <section id="panel">
      <div id="bg-stack" aria-hidden="true">
        <div class="bg-layer" data-slot="chat" id="probe-bg" style="opacity:1;background:${RED}"></div>
      </div>
      <div id="transcript">x</div>
    </section>
    <div class="ctxmenu" id="probe-menu" style="left:40px;top:80px;min-width:172px">
      <button class="ctxmenu-item"><span class="ctxmenu-label">每天一次</span></button>
      <button class="ctxmenu-item"><span class="ctxmenu-label">每周一次</span></button>
      <button class="ctxmenu-item"><span class="ctxmenu-label">已关闭</span></button>
    </div>
  </body></html>`;
}

/** 取一块区域的平均色（BGRA 位图）。 */
function avgOf(img, x0, y0, x1, y1) {
  const size = img.getSize();
  const raw = img.toBitmap();
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * size.width + x) * 4;
      b += raw[i]; g += raw[i + 1]; r += raw[i + 2]; n += 1;
    }
  }
  return { r: r / n, g: g / n, b: b / n };
}

const fmt = (c) => `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;

app.whenReady().then(async () => {
  let win = null;
  try {
    win = new BrowserWindow({
      width: 480, height: 360, frame: false, transparent: true,
      backgroundColor: "#00000000", show: false,
      webPreferences: { offscreen: false },
    });
    const htmlPath = join(__dirname, "_ctxmenu_page.html");
    writeFileSync(htmlPath, pageHtml(), "utf8");
    await win.loadURL(pathToFileURL(htmlPath).href);
    await new Promise((r) => setTimeout(r, 400));

    /** 换底色 → 等一帧 → 截菜单区中心平均色。 */
    async function sample(color, label, file) {
      await win.webContents.executeJavaScript(
        `document.getElementById('probe-bg').style.background = ${JSON.stringify(color)}; 'ok'`
      );
      await new Promise((r) => setTimeout(r, 320));
      const img = await win.capturePage();
      if (file) writeFileSync(join(__dirname, file), img.toPNG());
      // 菜单 at (40,80)，min-width 172，三行按钮 ≈ 104 高 → 取正中一小块
      const c = avgOf(img, 40 + 66, 80 + 44, 40 + 106, 80 + 64);
      log(`${label.padEnd(12)} 底=${color.padEnd(20)} → 菜单区平均色 ${fmt(c)}`);
      return c;
    }

    /** 切亮/暗主题（真实页面靠 body[data-ds-dark-theme] 切换，这里照搬）。 */
    async function setDark(dark) {
      await win.webContents.executeJavaScript(`
        document.body.toggleAttribute('data-ds-dark-theme', ${dark ? "true" : "false"});
        document.documentElement.style.colorScheme = ${dark ? "'dark'" : "'light'"};
        'ok'
      `);
      await new Promise((r) => setTimeout(r, 200));
    }

    const onRed = await sample(RED, "红底", "_ctxmenu_on_red.png");
    const onBlue = await sample(BLUE, "蓝底", "_ctxmenu_on_blue.png");
    const onAmber = await sample(AMBER, "琥珀底", "_ctxmenu_on_amber.png");

    const dRB = Math.abs(onRed.r - onBlue.r) + Math.abs(onRed.b - onBlue.b);
    const dRA = Math.abs(onRed.r - onAmber.r) + Math.abs(onRed.g - onAmber.g);
    log("");
    log(`【改后】色偏：红↔蓝 = ${Math.round(dRB)}    红↔琥珀 = ${Math.round(dRA)}`);
    // 与旧实现（写死 0.72 alpha / blur 30）的对照读数 —— 用同窗口加覆盖样式复现。
    await win.webContents.executeJavaScript(`
      (() => {
        const s = document.createElement('style')
        s.id = 'probe-old'
        s.textContent = '#probe-menu{background:rgba(21,21,23,0.72)!important;backdrop-filter:blur(30px) saturate(1.5)!important}'
        document.head.append(s)
        return 'ok'
      })()
    `);
    const oldRed = await sample(RED, "[旧]红底", "_ctxmenu_old_red.png");
    const oldBlue = await sample(BLUE, "[旧]蓝底", null);
    const oldRB = Math.abs(oldRed.r - oldBlue.r) + Math.abs(oldRed.b - oldBlue.b);
    log(`【旧版】色偏：红↔蓝 = ${Math.round(oldRB)}`);
    log("");
    log(`结论：新版色偏 ${Math.round(dRB)} vs 旧版 ${Math.round(oldRB)} —— 数值越大 = 背景透出来越多 = 玻璃越明显。`);
    if (dRB > oldRB * 1.4) {
      log("✅ 强化生效：同样的背景色变化，新版菜单的响应幅度明显大于旧版。");
    } else {
      log("⚠️ 强化幅度不明显，需要再调 --menu-opacity / --menu-blur。");
    }
    if (Math.max(dRB, dRA) >= 60) {
      log("判定：**玻璃显著可见** —— 菜单平均色随底色大幅改变，背景被充分采样。");
    } else {
      log("判定：**玻璃偏弱** —— 建议继续下调 --menu-opacity。");
    }

    // ── 真实背景图复测（最重要的一条）───────────────────────────────
    // 上面那些纯色是**对抗性测试**（全饱和亮琥珀，真实图片里基本不存在）。
    // 真正说了算的是用户手上那张 `bg-impression.png` —— 它就在
    // 「我们的回忆」页、也就是频率菜单弹出来的那一页。
    await win.webContents.executeJavaScript(`document.getElementById('probe-old')?.remove(); 'ok'`);
    const bgReal = pathToFileURL(join(ROOT, "helper", "assets", "backgrounds", "bg-impression.png")).href;
    await win.webContents.executeJavaScript(`
      (() => {
        const el = document.getElementById('probe-bg')
        el.style.background = 'url("${bgReal}") center/cover no-repeat'
        return 'ok'
      })()
    `);
    await new Promise((r) => setTimeout(r, 500));
    log("");
    log("── 真实背景图复测（bg-impression.png，即「我们的回忆」页那张）──");
    for (const dark of [false, true]) {
      await setDark(dark);
      const img = await win.capturePage();
      writeFileSync(join(__dirname, dark ? "_ctxmenu_real_dark.png" : "_ctxmenu_real_light.png"), img.toPNG());
      const c = avgOf(img, 40 + 66, 80 + 44, 40 + 106, 80 + 64);
      const lum = (x) => (0.2126 * x.r + 0.7152 * x.g + 0.0722 * x.b) / 255;
      const menuLum = lum(c);
      const textLum = dark ? lum({ r: 249, g: 250, b: 251 }) : lum({ r: 17, g: 17, b: 17 });
      const hi = Math.max(menuLum, textLum), lo = Math.min(menuLum, textLum);
      const ratio = (hi + 0.05) / (lo + 0.05);
      log(`${dark ? "暗" : "亮"}主题：菜单区平均色 ${fmt(c)} → 对比 ${ratio.toFixed(2)}:1  ${ratio >= 4.5 ? "✅" : ratio >= 3 ? "○" : "⚠️"}`);
    }
  } catch (e) {
    log("探针异常：" + (e && e.message ? e.message : String(e)));
  } finally {
    try { win?.destroy(); } catch {}
  }
  writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  app.exit(0);
});
setTimeout(() => {
  try { writeFileSync(OUT, lines.join("\n") + "\n(超时兜底)\n", "utf8"); } catch {}
  app.exit(1);
}, 30000);
