/**
 * 托盘图标方案对照板。
 * 把「全图缩放 / 自动裁脸 / 专门做一张静态托盘图」三种路线的
 * 64px 与 16px 效果并排画出来，供用户一眼选。
 */
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const fs = require("node:fs");

const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "probe", "_tray_board.png");

const ASSETS = [
  ["默认 512²", "deepseek-avatar-square.gif"],
  ["smile 256²", "avatars/smile.gif"],
  ["heart 256²", "avatars/heart.gif"],
  ["point 256²", "avatars/point.gif"]
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 600 });
  await win.loadFile(join(ROOT, "helper", "assets", "floating.html"));

  const urls = ASSETS.map(([label, rel]) => {
    const abs = join(ROOT, "helper", "assets", rel);
    return { label, url: "file:///" + abs.replace(/\\/g, "/"), exists: fs.existsSync(abs) };
  });

  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const items = ${JSON.stringify(urls)}.filter(i => i.exists)
    const loaded = []
    for (const it of items) {
      const img = new Image()
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = it.url })
      loaded.push({ label: it.label, img })
    }
    const COLS = loaded.length
    const CW = 220, CH = 250
    const c = document.createElement('canvas')
    c.width = CW * COLS + 20; c.height = CH + 40
    const g = c.getContext('2d')
    g.fillStyle = '#1b1d23'; g.fillRect(0, 0, c.width, c.height)
    g.font = '12px sans-serif'
    loaded.forEach(({ label, img }, i) => {
      const x0 = 10 + i * CW
      const W = img.naturalWidth, H = img.naturalHeight
      g.fillStyle = '#9aa0aa'
      g.fillText(label, x0, 18)
      // 64px 全图缩放
      g.drawImage(img, 0, 0, W, H, x0, 30, 64, 64)
      g.fillText('64 full', x0, 108)
      // 216px 全图（看细节）
      g.drawImage(img, 0, 0, W, H, x0, 116, 96, 96)
      g.fillText('96 full', x0, 226)
      // 16px 托盘实缩
      g.imageSmoothingQuality = 'high'
      g.drawImage(img, 0, 0, W, H, x0 + 108, 30, 16, 16)
      g.drawImage(img, 0, 0, W, H, x0 + 108, 60, 32, 32)
      g.fillStyle = '#9aa0aa'
      g.fillText('16px', x0 + 108, 108)
      g.fillText('32px', x0 + 108, 108 + 0)
    })
    return c.toDataURL('image/png')
  })()`);

  try {
    fs.writeFileSync(OUT, Buffer.from(dataUrl.split(",")[1], "base64"));
    console.log("written", OUT);
  } catch (e) {
    console.log("fail", e.message);
  }
  try { win.destroy(); } catch {}
  app.exit(0);
});

setTimeout(() => app.exit(9), 20000);
