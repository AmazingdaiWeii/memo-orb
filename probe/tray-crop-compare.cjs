/**
 * 托盘图标「裁切策略」对比图生成器。
 *
 * 背景：头像素材是**完整角色立绘**（含头饰、双马尾、手部动作）。
 * 直接缩到 16×16 会糊成一团 —— 托盘里认不出是脸。
 *
 * 本脚本在真 Electron 里把每张头像按几种裁切策略导出成 PNG，
 * 排成对比图，供用户拍板选哪种（而不是我替他决定）。
 *
 * 策略：
 *   A. 全图缩放（当前实现）
 *   B. 顶部居中正方形裁切（把人脸框进来，通常是上半部）
 *   C. 上部 62% 居中裁切（更紧的脸部特写）
 *   D. 16×16 实缩预览（模拟托盘真实观感）
 */
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const fs = require("node:fs");

const ROOT = join(__dirname, "..");
const OUTDIR = join(ROOT, "probe", "_tray_crop");
const OUT = join(ROOT, "probe", "_tray_crop.txt");
const lines = [];
const log = (s) => lines.push(s);
const flush = () => {
  try {
    fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  } catch {}
};

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUTDIR, { recursive: true });
  } catch {}
  log("=== 托盘裁切策略对比 ===");
  const win = new BrowserWindow({ show: false, width: 200, height: 200 });
  // 必须加载 assets 下的页面：about:blank 里 new Image() 读 file:// 会被拦（超时）。
  await win.loadFile(join(ROOT, "helper", "assets", "floating.html"));

  const CASES = ["deepseek-avatar-square.gif", "avatars/smile.gif", "avatars/heart.gif"];

  for (const rel of CASES) {
    const abs = join(ROOT, "helper", "assets", rel);
    if (!fs.existsSync(abs)) {
      log(`SKIP ${rel}`);
      continue;
    }
    const url = "file:///" + abs.replace(/\\/g, "/");
    // eslint-disable-next-line no-await-in-loop
    const result = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image()
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = ${JSON.stringify(url)} })
      const W = img.naturalWidth, H = img.naturalHeight
      const out = { natural: [W, H], variants: {} }
      function draw(mode) {
        const S = 64
        const c = document.createElement('canvas'); c.width = S; c.height = S
        const g = c.getContext('2d')
        g.imageSmoothingQuality = 'high'
        if (mode === 'full') {
          g.drawImage(img, 0, 0, W, H, 0, 0, S, S)
        } else if (mode === 'top-square') {
          const side = Math.min(W, H)
          g.drawImage(img, (W - side) / 2, 0, side, side, 0, 0, S, S)
        } else if (mode === 'upper-62') {
          const side = Math.min(W, H) * 0.62
          g.drawImage(img, (W - side) / 2, H * 0.04, side, side, 0, 0, S, S)
        }
        return c.toDataURL('image/png')
      }
      for (const m of ['full', 'top-square', 'upper-62']) out.variants[m] = draw(m)
      // 16px 实缩预览（模拟托盘观感）
      const small = document.createElement('canvas'); small.width = 16; small.height = 16
      const sg = small.getContext('2d'); sg.imageSmoothingQuality = 'high'
      sg.drawImage(img, 0, 0, W, H, 0, 0, 16, 16)
      out.variants['preview-16'] = small.toDataURL('image/png')
      return out
    })()`);

    log(`\n${rel}  原始 ${result.natural[0]}x${result.natural[1]}`);
    for (const [mode, dataUrl] of Object.entries(result.variants)) {
      const b64 = dataUrl.split(",")[1];
      const name = `${rel.replace(/[\\/.]/g, "_")}__${mode}.png`;
      try {
        fs.writeFileSync(join(OUTDIR, name), Buffer.from(b64, "base64"));
        log(`  ${mode.padEnd(12)} → ${name}`);
      } catch {}
    }
  }

  log("\n（图在 probe/_tray_crop/ 下，可直接看 16px 效果）");
  flush();
  try {
    win.destroy();
  } catch {}
  app.exit(0);
});

setTimeout(() => {
  log("(超时)");
  flush();
  app.exit(9);
}, 25000);
