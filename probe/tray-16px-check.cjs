/**
 * 16px 真实观感检查：把 7 张托盘图标按 1:1 像素输出，
 * 并排放大 8 倍显示（最近邻），这样能看清托盘里「实际有多少信息」。
 */
const { app, BrowserWindow, nativeImage } = require("electron");
const { join } = require("node:path");
const fs = require("node:fs");

const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "probe", "_tray_16px.png");
const OUT_LOG = join(ROOT, "probe", "_tray_16px.txt");
const lines = [];
const log = (s) => lines.push(s);
const flush = () => { try { fs.writeFileSync(OUT_LOG, lines.join("\n") + "\n", "utf8"); } catch {} };

const ASSETS = [
  ["default", "deepseek-avatar-square.gif"],
  ["smile", "avatars/smile.gif"],
  ["cheer", "avatars/cheer.gif"],
  ["cheeks", "avatars/cheeks.gif"],
  ["heart", "avatars/heart.gif"],
  ["point", "avatars/point.gif"],
  ["rice", "avatars/rice.gif"]
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 400, height: 500,
    webPreferences: {
      preload: join(ROOT, "helper", "preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  await win.loadFile(join(ROOT, "helper", "assets", "floating.html"));

  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await win.webContents.executeJavaScript("typeof window.__orbTrayIconPng === 'function'")) { ready = true; break; }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) { log("未注册"); flush(); app.exit(2); return; }

  const rows = [];
  for (const [label, src] of ASSETS) {
    // eslint-disable-next-line no-await-in-loop
    const png64 = await win.webContents.executeJavaScript(`window.__orbTrayIconPng(${JSON.stringify(src)})`);
    if (!png64) { log(`FAIL ${label}`); continue; }
    // 走与主进程完全相同的路径：createFromDataURL → resize(16)
    const img = nativeImage.createFromDataURL(png64);
    const small = img.resize({ width: 16, height: 16, quality: "best" });
    rows.push({ label, png: small.toPNG().toString("base64") });
    log(`${label.padEnd(8)} 64px=${img.getSize().width}  16px后=${small.isEmpty() ? "空!" : "OK"} ${small.toPNG().length}B`);
  }

  // 拼图：每行 = 标签 + 16px 原图(×1) + 放大 8 倍(最近邻，看像素)
  const board = await win.webContents.executeJavaScript(`(async () => {
    const rows = ${JSON.stringify(rows)}
    const ROWH = 40, Z = 8
    const c = document.createElement('canvas')
    c.width = 520; c.height = ROWH * rows.length + 20
    const g = c.getContext('2d')
    g.fillStyle = '#2a2c33'; g.fillRect(0, 0, c.width, c.height)
    g.font = '14px sans-serif'
    for (let i = 0; i < rows.length; i++) {
      const y = 10 + i * ROWH
      g.fillStyle = '#c8ccd4'
      g.fillText(rows[i].label, 6, y + 22)
      const img = new Image()
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + rows[i].png })
      g.imageSmoothingEnabled = false
      g.drawImage(img, 90, y + 4, 16, 16)      // 1:1 真实尺寸
      g.drawImage(img, 120, y + 4, 16*Z/2, 16*Z/2) // ×4
      g.drawImage(img, 220, y + 4, 16*Z, 16*Z)     // ×8 看像素
      g.imageSmoothingEnabled = true
    }
    return c.toDataURL('image/png')
  })()`);

  try {
    fs.writeFileSync(OUT, Buffer.from(board.split(",")[1], "base64"));
    log("\n对照图: probe/_tray_16px.png（每行：16px 原尺寸 / ×4 / ×8）");
  } catch (e) { log(`写失败 ${e.message}`); }
  flush();
  try { win.destroy(); } catch {}
  app.exit(0);
});

setTimeout(() => { log("(超时)"); flush(); app.exit(9); }, 45000);
