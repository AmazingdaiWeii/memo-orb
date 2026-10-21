/**
 * 生成**验收板**：每个头像一张卡 —— 左边源图（球上看到的样子），
 * 右边托盘图标（1:1、×3、×6 三档放大），下面标文件名与裁切参数。
 *
 * 用途：让用户真看一眼选项 B（逐图裁脸）的实际效果，再决定收不收。
 * 输出 probe/_tray_acceptance.png
 */
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const fs = require("node:fs");

const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "probe", "_tray_acceptance.png");
const REPORT = join(ROOT, "probe", "_tray_acceptance.txt");

const items = [
  { src: "", label: "默认头像", note: "deepseek-avatar-square.gif" },
  { src: "avatars/smile.gif", label: "微笑", note: "" },
  { src: "avatars/cheer.gif", label: "欢呼", note: "" },
  { src: "avatars/cheeks.gif", label: "脸红", note: "" },
  { src: "avatars/heart.gif", label: "比心", note: "" },
  { src: "avatars/point.gif", label: "指路", note: "" },
  { src: "avatars/rice.gif", label: "干饭", note: "" }
];

/**
 * ★ 裁切参数不在这里写第二份 —— 直接去 shell.js 里抠，避免两份漂移。
 *   板子上显示的必须就是**跑起来时真正用的**那组数字。
 */
function readCropTable() {
  const src = fs.readFileSync(join(ROOT, "helper", "assets", "shell.js"), "utf8");
  const m = src.match(/const TRAY_FACE_CROP = \{([\s\S]*?)\n\s*\}/);
  const table = {};
  if (m) {
    for (const line of m[1].split("\n")) {
      const hit = line.match(/'([^']+)':\s*\{\s*cx:\s*([\d.]+),\s*cy:\s*([\d.]+),\s*s:\s*([\d.]+)/);
      if (hit) table[hit[1]] = { cx: hit[2], cy: hit[3], s: hit[4] };
    }
  }
  const fm = src.match(/const TRAY_FACE_CROP_FALLBACK = \{\s*cx:\s*([\d.]+),\s*cy:\s*([\d.]+),\s*s:\s*([\d.]+)/);
  const fallback = fm ? { cx: fm[1], cy: fm[2], s: fm[3] } : null;
  return { table, fallback };
}

const lines = [];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
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

  const results = [];
  const { table, fallback } = readCropTable();
  for (const it of items) {
    const payload = it.src || "deepseek-avatar-square.gif";
    const dataUrl = await win.webContents.executeJavaScript(
      `window.__orbTrayIconPng(${JSON.stringify(payload)})`
    );
    const c = table[payload] || fallback || { cx: "?", cy: "?", s: "?" };
    results.push({
      ...it,
      dataUrl,
      payload,
      note: `cx ${c.cx} / cy ${c.cy} / s ${c.s}`
    });
    lines.push(`${it.label}\t${payload}\t${results[results.length - 1].note}\t${dataUrl ? dataUrl.length : 0}`);
  }

  // 在页面里拼一块板子，直接截图
  const boardHtml = `
    <html><head><meta charset="utf-8"><style>
      body { margin:0; background:#14161c; color:#e8ecf3;
             font-family:"Microsoft YaHei",system-ui,sans-serif; padding:22px 26px; }
      h1 { font-size:19px; margin:0 0 4px; font-weight:600; letter-spacing:.5px; }
      .sub { font-size:12px; color:#8d97a8; margin-bottom:18px; }
      .grid { display:grid; grid-template-columns:repeat(2,1fr); gap:14px; }
      .card { background:#1d2029; border:1px solid #2b3040; border-radius:10px;
              padding:12px 14px; display:flex; gap:16px; align-items:center; }
      .srcwrap { width:96px; height:96px; flex:0 0 96px; background:#0e1015;
                 border-radius:8px; display:flex; align-items:center; justify-content:center;
                 overflow:hidden; border:1px solid #262b38; }
      .srcwrap img { width:88px; height:88px; object-fit:contain; image-rendering:auto; }
      .trays { display:flex; gap:14px; align-items:flex-end; }
      .trays .u { display:flex; flex-direction:column; align-items:center; gap:6px; }
      .trays .u span { font-size:10px; color:#7d879a; }
      .trays img { image-rendering:pixelated; background:#0e1015; border-radius:4px;
                   border:1px solid #2b3040; }
      .meta { flex:1; }
      .meta .n { font-size:14px; font-weight:600; margin-bottom:3px; }
      .meta .f { font-size:11px; color:#8d97a8; font-family:Consolas,monospace; }
      .meta .c { font-size:11px; color:#6f7b91; margin-top:5px; }
      .badge { display:inline-block; font-size:10px; padding:2px 7px; border-radius:99px;
               background:#233047; color:#7fb0ff; margin-left:6px; }
    </style></head><body>
      <h1>托盘图标验收板 · 选项 B（逐图裁脸）</h1>
      <div class="sub">左：球上的源图 ｜ 右：托盘实际图标（16px 原尺寸 / ×3 / ×6 放大）</div>
      <div class="grid" id="g"></div>
      <script>
        const D = ${JSON.stringify(results.map((r) => ({ l: r.label, n: r.src || "deepseek-avatar-square.gif", c: r.note, d: r.dataUrl })))};
        const g = document.getElementById('g');
        for (const it of D) {
          const el = document.createElement('div');
          el.className = 'card';
          el.innerHTML =
            '<div class="srcwrap"><img src="../helper/assets/' + it.n + '"></div>' +
            '<div class="trays">' +
              '<div class="u"><img src="' + it.d + '" width="16" height="16"><span>16px</span></div>' +
              '<div class="u"><img src="' + it.d + '" width="48" height="48"><span>×3</span></div>' +
              '<div class="u"><img src="' + it.d + '" width="96" height="96"><span>×6</span></div>' +
            '</div>' +
            '<div class="meta"><div class="n">' + it.l + '<span class="badge">' + it.n + '</span></div>' +
            '<div class="c">裁切 ' + it.c + '</div></div>';
          g.appendChild(el);
        }
        document.title = 'ready';
      </script>
    </body></html>`;

  try {
    fs.writeFileSync(join(ROOT, "probe", "_tray_acceptance.html"), boardHtml, "utf8");
  } catch (e) {
    lines.push("写 html 失败: " + e.message);
  }

  const win2 = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: false }
  });
  await win2.loadFile(join(ROOT, "probe", "_tray_acceptance.html"));
  await new Promise((r) => setTimeout(r, 900));
  const image = await win2.webContents.capturePage();
  fs.writeFileSync(OUT, image.toPNG());
  lines.push(`板子已写出: ${OUT}`);

  fs.writeFileSync(REPORT, lines.join("\n") + "\n", "utf8");
  win.destroy();
  win2.destroy();
  app.exit(0);
});

setTimeout(() => {
  fs.writeFileSync(REPORT, lines.join("\n") + "\n(超时)\n", "utf8");
  app.exit(9);
}, 60000);
