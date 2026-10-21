/**
 * 剩下 4 张 256² 头像（cheer/cheeks/heart/point）的面部位置扫描。
 * 256² 的脸大概在中上部，扫 cy ∈ {0.30..0.60}。
 */
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const fs = require("node:fs");

const ROOT = join(__dirname, "..");
const OUTDIR = join(ROOT, "probe", "_face_scan3");
const OUT = join(ROOT, "probe", "_face_scan3.txt");
const lines = [];
const log = (s) => lines.push(s);
const flush = () => {
  try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch {}
};

const ASSETS = ["avatars/cheer.gif", "avatars/cheeks.gif", "avatars/heart.gif", "avatars/point.gif", "avatars/rice.gif"];

app.whenReady().then(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 200, height: 200 });
  await win.loadFile(join(ROOT, "helper", "assets", "floating.html"));

  const CANDIDATES = [
    [0.35, 0.70], [0.40, 0.70], [0.45, 0.70],
    [0.40, 0.80], [0.45, 0.80], [0.50, 0.80],
    [0.45, 0.90], [0.50, 0.90], [0.55, 0.90]
  ];
  log(`候选 ${CANDIDATES.length} 组 (cy 0.35..0.55, s 0.70..0.90)`);

  for (const rel of ASSETS) {
    const abs = join(ROOT, "helper", "assets", rel);
    if (!fs.existsSync(abs)) { log(`SKIP ${rel}`); continue; }
    const url = "file:///" + abs.replace(/\\/g, "/");
    // eslint-disable-next-line no-await-in-loop
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
    log(`\n${rel}  ${out.natural[0]}x${out.natural[1]}`);
    out.tiles.forEach((t, i) => {
      const base = rel.split("/").pop().replace(".gif", "");
      const name = `${base}__${String(i).padStart(2, "0")}_cy${t.cy}_s${t.s}.png`;
      try { fs.writeFileSync(join(OUTDIR, name), Buffer.from(t.png.split(",")[1], "base64")); } catch {}
    });
  }

  log("\n看图：probe/_face_scan3/");
  flush();
  try { win.destroy(); } catch {}
  app.exit(0);
});

setTimeout(() => { log("(超时)"); flush(); app.exit(9); }, 40000);
