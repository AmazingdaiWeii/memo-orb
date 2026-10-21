/**
 * 逐图裁切**目视核对板**：对每张头像，把源图按网格画出 3×3 参考线
 * （0.1 间隔），并把 crop 框用红框标出来，再单独导出裁切结果。
 *
 * 用途：不靠猜——直接看见「框住了什么」。
 * 输出 probe/_tray_crop_audit.png
 */
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const fs = require("node:fs");

const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "probe", "_tray_crop_audit.png");

const items = [
  { src: "deepseek-avatar-square.gif", label: "默认" },
  { src: "avatars/smile.gif", label: "微笑" },
  { src: "avatars/cheer.gif", label: "欢呼" },
  { src: "avatars/cheeks.gif", label: "脸红" },
  { src: "avatars/heart.gif", label: "比心" },
  { src: "avatars/point.gif", label: "指路" },
  { src: "avatars/rice.gif", label: "干饭" }
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400,
    height: 1000,
    show: false,
    webPreferences: {
      preload: join(ROOT, "helper", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  await win.loadFile(join(ROOT, "helper", "assets", "floating.html"));
  await new Promise((r) => setTimeout(r, 1500));

  // 在页面里：对每张图，画出带参考线的源图 + 裁切框 + 裁切结果
  const html = await win.webContents.executeJavaScript(`(async () => {
    const items = ${JSON.stringify(items)};
    const CROPS = {
      'deepseek-avatar-square.gif': { cx: 0.5, cy: 0.65, s: 0.8 },
      'avatars/smile.gif':          { cx: 0.5, cy: 0.35, s: 0.75 },
      'avatars/cheer.gif':          { cx: 0.5, cy: 0.45, s: 0.8 },
      'avatars/cheeks.gif':         { cx: 0.5, cy: 0.55, s: 0.9 },
      'avatars/heart.gif':          { cx: 0.5, cy: 0.5,  s: 0.9 },
      'avatars/point.gif':          { cx: 0.5, cy: 0.45, s: 0.8 },
      'avatars/rice.gif':           { cx: 0.5, cy: 0.45, s: 0.8 }
    };
    const results = [];
    for (const it of items) {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = it.src; });
      const W = img.naturalWidth, H = img.naturalHeight;
      const c = CROPS[it.src];
      const box = Math.min(W, H) * c.s;
      const sx = Math.max(0, Math.min(W - box, W * c.cx - box / 2));
      const sy = Math.max(0, Math.min(H - box, H * c.cy - box / 2));

      // 源图 + 红框（缩到 200px）
      const PV = 200;
      const cv = document.createElement('canvas'); cv.width = PV; cv.height = PV;
      const cx = cv.getContext('2d');
      cx.drawImage(img, 0, 0, W, H, 0, 0, PV, PV);
      // 参考线
      cx.strokeStyle = 'rgba(255,255,255,0.28)'; cx.lineWidth = 1;
      for (let i = 1; i < 10; i++) {
        const p = PV * i / 10;
        cx.beginPath(); cx.moveTo(p, 0); cx.lineTo(p, PV); cx.stroke();
        cx.beginPath(); cx.moveTo(0, p); cx.lineTo(PV, p); cx.stroke();
      }
      cx.strokeStyle = '#ff3b3b'; cx.lineWidth = 2;
      cx.strokeRect(sx / W * PV, sy / H * PV, box / W * PV, box / H * PV);

      // 裁切结果 128px
      const CR = 128;
      const c2 = document.createElement('canvas'); c2.width = CR; c2.height = CR;
      const cx2 = c2.getContext('2d');
      cx2.imageSmoothingQuality = 'high';
      cx2.drawImage(img, sx, sy, box, box, 0, 0, CR, CR);

      results.push({
        label: it.label, src: it.src, crop: c,
        srcUrl: cv.toDataURL('image/png'),
        cropUrl: c2.toDataURL('image/png'),
        dim: W + 'x' + H
      });
    }
    return JSON.stringify(results);
  })()`);

  const data = JSON.parse(html);
  const board = `<html><head><meta charset="utf-8"><style>
    body{margin:0;background:#14161c;color:#e8ecf3;font-family:"Microsoft YaHei",sans-serif;padding:20px 24px}
    h1{font-size:18px;margin:0 0 16px;font-weight:600}
    .row{display:flex;gap:18px;flex-wrap:wrap}
    .c{background:#1d2029;border:1px solid #2b3040;border-radius:10px;padding:10px;width:330px}
    .t{font-size:13px;font-weight:600;margin-bottom:8px}
    .t small{color:#8d97a8;font-weight:400;font-family:Consolas,monospace;font-size:10px;margin-left:6px}
    .bar{display:flex;gap:12px;align-items:flex-start}
    figure{margin:0;text-align:center}
    figcaption{font-size:10px;color:#8d97a8;margin-top:4px}
    img{display:block;border-radius:6px;border:1px solid #2b3040}
    .cropimg{image-rendering:auto}
  </style></head><body>
  <h1>逐图裁切核对 · 白线=0.1 网格，红框=当前裁切框，右=裁切结果</h1>
  <div class="row">${data.map((d) => `
    <div class="c">
      <div class="t">${d.label}<small>${d.src} ${d.dim}</small></div>
      <div class="bar">
        <figure><img src="${d.srcUrl}" width="200" height="200"><figcaption>源图 + 裁切框</figcaption></figure>
        <figure><img class="cropimg" src="${d.cropUrl}" width="128" height="128"><figcaption>裁切结果</figcaption></figure>
      </div>
      <div style="font-size:10px;color:#6f7b91;margin-top:6px;font-family:Consolas,monospace">
        cx ${d.crop.cx} / cy ${d.crop.cy} / s ${d.crop.s}
      </div>
    </div>`).join("")}</div></body></html>`;

  fs.writeFileSync(join(ROOT, "probe", "_tray_crop_audit.html"), board, "utf8");

  const win2 = new BrowserWindow({
    width: 1400,
    height: 1000,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: false }
  });
  await win2.loadFile(join(ROOT, "probe", "_tray_crop_audit.html"));
  await new Promise((r) => setTimeout(r, 800));
  const img = await win2.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  fs.writeFileSync(join(ROOT, "probe", "_tray_crop_audit.txt"), JSON.stringify(data, null, 2), "utf8");
  win.destroy(); win2.destroy();
  app.exit(0);
});

setTimeout(() => { app.exit(9); }, 60000);
