/**
 * 参数扫描板：对指定的图，把一组候选 (cx,cy,s) 全部渲染出来并排看，
 * 一眼挑出最合适的那个。
 *
 * 用法：改下面 SWEEP 里要扫的项。
 * 输出：probe/_sweep.png
 */
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const fs = require("node:fs");

const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "probe", "_sweep.png");

  // 扫哪些图、扫哪些参数（每组 12 个候选，6 列 × 2 行）
  const SWEEP = [
    {
      src: "avatars/cheeks.gif",
      label: "脸红",
      cands: [
        { cx: 0.44, cy: 0.38, s: 0.68 }, { cx: 0.44, cy: 0.42, s: 0.72 }, { cx: 0.44, cy: 0.46, s: 0.76 },
        { cx: 0.48, cy: 0.38, s: 0.68 }, { cx: 0.48, cy: 0.42, s: 0.72 }, { cx: 0.48, cy: 0.46, s: 0.76 }
      ]
    },
    {
      src: "orb-idle.gif",
      label: "默认",
      cands: [
        { cx: 0.50, cy: 0.52, s: 0.66 }, { cx: 0.50, cy: 0.56, s: 0.70 }, { cx: 0.50, cy: 0.60, s: 0.74 },
        { cx: 0.54, cy: 0.52, s: 0.66 }, { cx: 0.54, cy: 0.56, s: 0.70 }, { cx: 0.54, cy: 0.60, s: 0.74 }
      ]
    },
    {
      src: "avatars/point.gif",
      label: "指路",
      cands: [
        { cx: 0.46, cy: 0.34, s: 0.68 }, { cx: 0.46, cy: 0.38, s: 0.72 }, { cx: 0.46, cy: 0.42, s: 0.76 },
        { cx: 0.52, cy: 0.34, s: 0.68 }, { cx: 0.52, cy: 0.38, s: 0.72 }, { cx: 0.52, cy: 0.42, s: 0.76 }
      ]
    },
    {
      src: "avatars/cheer.gif",
      label: "欢呼",
      cands: [
        { cx: 0.48, cy: 0.32, s: 0.66 }, { cx: 0.48, cy: 0.36, s: 0.70 }, { cx: 0.48, cy: 0.40, s: 0.74 },
        { cx: 0.52, cy: 0.32, s: 0.66 }, { cx: 0.52, cy: 0.36, s: 0.70 }, { cx: 0.52, cy: 0.40, s: 0.74 }
      ]
    },
    {
      src: "avatars/smile.gif",
      label: "微笑",
      cands: [
        { cx: 0.50, cy: 0.30, s: 0.64 }, { cx: 0.50, cy: 0.34, s: 0.68 }, { cx: 0.50, cy: 0.38, s: 0.72 },
        { cx: 0.54, cy: 0.30, s: 0.64 }, { cx: 0.54, cy: 0.34, s: 0.68 }, { cx: 0.54, cy: 0.38, s: 0.72 }
      ]
    },
    {
      src: "avatars/rice.gif",
      label: "干饭",
      cands: [
        { cx: 0.46, cy: 0.36, s: 0.68 }, { cx: 0.46, cy: 0.40, s: 0.72 }, { cx: 0.46, cy: 0.44, s: 0.76 },
        { cx: 0.52, cy: 0.36, s: 0.68 }, { cx: 0.52, cy: 0.40, s: 0.72 }, { cx: 0.52, cy: 0.44, s: 0.76 }
      ]
    },
    {
      src: "avatars/heart.gif",
      label: "比心（源图眼睛被手挡住，只能靠剪影）",
      cands: [
        { cx: 0.48, cy: 0.34, s: 0.68 }, { cx: 0.48, cy: 0.40, s: 0.74 }, { cx: 0.48, cy: 0.46, s: 0.80 },
        { cx: 0.52, cy: 0.34, s: 0.68 }, { cx: 0.52, cy: 0.40, s: 0.74 }, { cx: 0.52, cy: 0.46, s: 0.80 }
      ]
    }
  ];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 600, show: false,
    webPreferences: {
      preload: join(ROOT, "helper", "preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  await win.loadFile(join(ROOT, "helper", "assets", "floating.html"));
  await new Promise((r) => setTimeout(r, 1200));

  const html = await win.webContents.executeJavaScript(`(async () => {
    const SWEEP = ${JSON.stringify(SWEEP)};
    const sections = [];
    for (const item of SWEEP) {
      const img = new Image();
      await new Promise((ok,bad)=>{img.onload=ok;img.onerror=bad;img.src=item.src;});
      const W=img.naturalWidth,H=img.naturalHeight;
      const cells=[];
      for (const c of item.cands) {
        const box = Math.min(W,H)*c.s;
        const sx = Math.max(0, Math.min(W-box, W*c.cx - box/2));
        const sy = Math.max(0, Math.min(H-box, H*c.cy - box/2));
        // 大图 + 16px 实际效果
        const BIG=110, SM=16;
        const cv=document.createElement('canvas'); cv.width=BIG; cv.height=BIG;
        const g=cv.getContext('2d'); g.imageSmoothingQuality='high';
        g.drawImage(img,sx,sy,box,box,0,0,BIG,BIG);
        const cv2=document.createElement('canvas'); cv2.width=SM*3; cv2.height=SM*3;
        const g2=cv2.getContext('2d'); g2.imageSmoothingQuality='high';
        g2.drawImage(img,sx,sy,box,box,0,0,16,16);
        g2.drawImage(cv2,0,0); // noop
        const cv3=document.createElement('canvas'); cv3.width=SM; cv3.height=SM;
        const g3=cv3.getContext('2d'); g3.imageSmoothingQuality='high';
        g3.drawImage(img,sx,sy,box,box,0,0,SM,SM);
        cells.push({ c, big: cv.toDataURL('image/png'), sm: cv3.toDataURL('image/png') });
      }
      sections.push({ label: item.label, src: item.src, dim: W+'x'+H, cells });
    }
    return JSON.stringify(sections);
  })()`);

  const data = JSON.parse(html);
  // 分两页渲染（单次 capture 受屏幕高度限制，装不下 7 组）
  const HALF = Math.ceil(data.length / 2);
  const pages = [data.slice(0, HALF), data.slice(HALF)];

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    const board = `<html><head><meta charset="utf-8"><style>
      body{margin:0;background:#14161c;color:#e8ecf3;font-family:"Microsoft YaHei",sans-serif;padding:16px 20px}
      h2{font-size:15px;margin:0 0 9px;font-weight:600}
      h2 small{color:#8d97a8;font-weight:400;font-size:11px;font-family:Consolas,monospace;margin-left:8px}
      .grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:16px}
      .cell{background:#1d2029;border:1px solid #2b3040;border-radius:8px;padding:6px;text-align:center}
      .cell img.big{width:100%;height:auto;border-radius:5px;display:block}
      .cell .smrow{margin-top:6px;display:flex;justify-content:center;align-items:center;gap:8px}
      .cell img.sm{width:16px;height:16px;image-rendering:pixelated;border-radius:3px;border:1px solid #2b3040}
      .cell img.sm4{width:56px;height:56px;image-rendering:pixelated;border-radius:5px;border:1px solid #2b3040}
      .cell .p{font-size:9.5px;color:#8d97a8;font-family:Consolas,monospace;margin-top:5px;line-height:1.35}
    </style></head><body>
    ${page.map((s) => `<h2>${s.label}<small>${s.src} ${s.dim}</small></h2>
      <div class="grid">${s.cells.map((c) => `
        <div class="cell">
          <img class="big" src="${c.big}">
          <div class="smrow"><img class="sm" src="${c.sm}"><img class="sm4" src="${c.sm}"></div>
          <div class="p">cx ${c.c.cx}<br>cy ${c.c.cy}<br>s ${c.c.s}</div>
        </div>`).join("")}</div>`).join("")}
    </body></html>`;

    const htmlPath = join(ROOT, "probe", `_sweep_${pi + 1}.html`);
    fs.writeFileSync(htmlPath, board, "utf8");
    const win2 = new BrowserWindow({
      width: 1040, height: 1250, show: false,
      webPreferences: { contextIsolation: true, sandbox: false }
    });
    await win2.loadFile(htmlPath);
    await new Promise((r) => setTimeout(r, 800));
    const img = await win2.webContents.capturePage();
    fs.writeFileSync(join(ROOT, "probe", `_sweep_${pi + 1}.png`), img.toPNG());
    win2.destroy();
  }
  win.destroy();
  app.exit(0);
});

setTimeout(() => { app.exit(9); }, 60000);
