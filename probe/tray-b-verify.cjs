/**
 * B 方案（逐图人脸裁切）效果验证。
 *
 * 走**真实调用路径**：加载 floating.html → 调 window.__orbTrayIconPng(src)
 * → 拿到 64px PNG → 同时缩到 16px，两者并排画进一张对照板。
 *
 * 这样验证的是「用户切到这张头像时，托盘里究竟长什么样」，
 * 而不是我手搓的裁切参数长什么样 —— 两者的差别正是探针的价值。
 */
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const fs = require("node:fs");

const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "probe", "_tray_b_board.png");
const OUT_LOG = join(ROOT, "probe", "_tray_b.txt");
const lines = [];
const log = (s) => lines.push(s);
const flush = () => {
  try { fs.writeFileSync(OUT_LOG, lines.join("\n") + "\n", "utf8"); } catch {}
};

const ASSETS = [
  ["默认", "deepseek-avatar-square.gif"],
  ["smile", "avatars/smile.gif"],
  ["cheer", "avatars/cheer.gif"],
  ["cheeks", "avatars/cheeks.gif"],
  ["heart", "avatars/heart.gif"],
  ["point", "avatars/point.gif"],
  ["rice", "avatars/rice.gif"]
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 500,
    webPreferences: {
      // 与 tray-e2e.cjs 保持一致：必须给真 preload，否则 shell.js 里
      // `const api = window.dshOrb` 是 undefined，main() 当场抛错、
      // __orbTrayIconPng 根本不会被注册（表现为「注册: false」）。
      preload: join(ROOT, "helper", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  await win.loadFile(join(ROOT, "helper", "assets", "floating.html"));

  // 等 shell.js 注册
  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const has = await win.webContents.executeJavaScript("typeof window.__orbTrayIconPng === 'function'");
    if (has) { ready = true; break; }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }
  log(`__orbTrayIconPng 注册: ${ready}`);
  if (!ready) { flush(); app.exit(2); return; }

  const results = [];
  for (const [label, src] of ASSETS) {
    // eslint-disable-next-line no-await-in-loop
    const png64 = await win.webContents.executeJavaScript(`window.__orbTrayIconPng(${JSON.stringify(src)})`);
    if (!png64 || typeof png64 !== "string") {
      log(`FAIL ${label}: 回传 null`);
      continue;
    }
    results.push({ label, png64 });
    log(`OK   ${label.padEnd(8)} dataUrl ${png64.length} 字符`);
  }

  // 拼对照板：每列 = [64px 大图][16px 托盘实缩 ×1 / ×2 / ×3]
  const board = await win.webContents.executeJavaScript(`(async () => {
    const items = ${JSON.stringify(results)}
    const COLS = items.length
    const CW = 100, CH = 150
    const c = document.createElement('canvas')
    c.width = CW * COLS + 20; c.height = CH + 30
    const g = c.getContext('2d')
    g.fillStyle = '#22242b'; g.fillRect(0, 0, c.width, c.height)
    g.font = '13px sans-serif'
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const x0 = 10 + i * CW
      const img = new Image()
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = it.png64 })
      g.fillStyle = '#c8ccd4'
      g.fillText(it.label, x0, 16)
      // 64px 原样
      g.imageSmoothingQuality = 'high'
      g.drawImage(img, x0, 26, 64, 64)
      // 16px 托盘实缩，放大 1x/2x/3x 显示（便于肉眼判断辨识度）
      const tmp = document.createElement('canvas'); tmp.width = 16; tmp.height = 16
      const tg = tmp.getContext('2d'); tg.imageSmoothingQuality = 'high'
      tg.drawImage(img, 0, 0, 64, 64, 0, 0, 16, 16)
      g.imageSmoothingEnabled = false
      g.drawImage(tmp, x0, 98, 16, 16)
      g.drawImage(tmp, x0 + 20, 98, 32, 32)
      g.drawImage(tmp, x0 + 58, 98, 48, 48)
      g.imageSmoothingEnabled = true
    }
    return c.toDataURL('image/png')
  })()`);

  try {
    fs.writeFileSync(OUT, Buffer.from(board.split(",")[1], "base64"));
    log(`\n对照板已写: probe/_tray_b_board.png`);
  } catch (e) {
    log(`对照板写失败: ${e.message}`);
  }
  flush();
  try { win.destroy(); } catch {}
  app.exit(0);
});

setTimeout(() => { log("(超时)"); flush(); app.exit(9); }, 45000);
