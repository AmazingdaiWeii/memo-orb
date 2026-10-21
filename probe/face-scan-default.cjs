/**
 * 默认头像（512²）专属扫描：它的脸在中下部，超出第一轮候选范围。
 * 这里扫 cy ∈ {0.45..0.72}。
 */
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const fs = require("node:fs");

const ROOT = join(__dirname, "..");
const OUTDIR = join(ROOT, "probe", "_face_scan2");
const OUT = join(ROOT, "probe", "_face_scan2.txt");
const lines = [];
const log = (s) => lines.push(s);
const flush = () => {
  try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch {}
};

app.whenReady().then(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 200, height: 200 });
  await win.loadFile(join(ROOT, "helper", "assets", "floating.html"));

  const CANDIDATES = [
    [0.50, 0.60], [0.55, 0.60], [0.60, 0.60],
    [0.50, 0.70], [0.55, 0.70], [0.60, 0.70], [0.65, 0.70],
    [0.55, 0.80], [0.60, 0.80], [0.65, 0.80], [0.70, 0.80],
    [0.60, 0.90], [0.65, 0.90], [0.70, 0.90]
  ];
  log(`候选 ${CANDIDATES.length} 组 (cy 0.50..0.70, s 0.60..0.90)`);

  const abs = join(ROOT, "helper", "assets", "orb-idle.gif");
  const url = "file:///" + abs.replace(/\\/g, "/");
  const out = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image()
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = ${JSON.stringify(url)} })
    const W = img.naturalWidth, H = img.naturalHeight
    const res = { natural: [W, H], tiles: [] }
    const S = 64
    for (const [cy, s] of ${JSON.stringify(CANDIDATES)}) {
      const side = Math.min(W, H) * s
      const cx = W / 2
      const y = Math.max(0, Math.min(H - side, H * cy - side / 2))
      const c = document.createElement('canvas'); c.width = S; c.height = S
      const g = c.getContext('2d')
      g.imageSmoothingQuality = 'high'
      g.drawImage(img, cx - side / 2, y, side, side, 0, 0, S, S)
      res.tiles.push({ cy, s, png: c.toDataURL('image/png') })
    }
    return res
  })()`);

  log(`原图 ${out.natural[0]}x${out.natural[1]}`);
  out.tiles.forEach((t, i) => {
    const name = `default__${String(i).padStart(2, "0")}_cy${t.cy}_s${t.s}.png`;
    try { fs.writeFileSync(join(OUTDIR, name), Buffer.from(t.png.split(",")[1], "base64")); } catch {}
  });
  log(`导出 ${out.tiles.length} 张`);
  flush();
  try { win.destroy(); } catch {}
  app.exit(0);
});

setTimeout(() => { log("(超时)"); flush(); app.exit(9); }, 30000);
