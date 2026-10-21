/**
 * 逐图人脸框勘测：把 7 张头像各自用「不同垂直/水平偏移 + 缩放」的候选裁切
 * 批量导出成 64px，供人工挑出每张最合适的一组参数。
 *
 * 为什么要逐图定参：素材是完整立绘，脸的位置每张都不一样
 * （smile 的脸在上部、默认 512² 的脸在中下部），固定比例必然裁不准。
 */
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const fs = require("node:fs");

const ROOT = join(__dirname, "..");
const OUTDIR = join(ROOT, "probe", "_face_scan");
const OUT = join(ROOT, "probe", "_face_scan.txt");
const lines = [];
const log = (s) => lines.push(s);
const flush = () => {
  try {
    fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  } catch {}
};

const ASSETS = [
  "deepseek-avatar-square.gif",
  "avatars/smile.gif",
  "avatars/cheer.gif",
  "avatars/cheeks.gif",
  "avatars/heart.gif",
  "avatars/point.gif",
  "avatars/rice.gif"
];

app.whenReady().then(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  log("=== 逐图裁切参数勘测 ===");
  const win = new BrowserWindow({ show: false, width: 200, height: 200 });
  await win.loadFile(join(ROOT, "helper", "assets", "floating.html"));

  // 候选：(垂直中心位置比例 cy, 裁切边长比例 s) —— 都相对「短边」
  const CANDIDATES = [
    [0.30, 0.50], [0.35, 0.50], [0.40, 0.50], [0.45, 0.50],
    [0.30, 0.62], [0.35, 0.62], [0.40, 0.62], [0.45, 0.62],
    [0.30, 0.75], [0.35, 0.75], [0.40, 0.75], [0.45, 0.75],
    [0.25, 0.62], [0.50, 0.62], [0.35, 0.85], [0.42, 0.85]
  ];
  log(`候选 ${CANDIDATES.length} 组：cy∈{0.25..0.50}, s∈{0.50..0.85}`);

  for (const rel of ASSETS) {
    const abs = join(ROOT, "helper", "assets", rel);
    if (!fs.existsSync(abs)) {
      log(`SKIP ${rel}`);
      continue;
    }
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
      const name = `${rel.replace(/[\\/.]/g, "_")}__${String(i).padStart(2, "0")}_cy${t.cy}_s${t.s}.png`;
      try {
        fs.writeFileSync(join(OUTDIR, name), Buffer.from(t.png.split(",")[1], "base64"));
      } catch {}
    });
    log(`  导出 ${out.tiles.length} 张候选（编号 00..${out.tiles.length - 1}）`);
  }

  log("\n看图：probe/_face_scan/<素材>__<编号>_cy<cy>_s<s>.png");
  flush();
  try { win.destroy(); } catch {}
  app.exit(0);
});

setTimeout(() => { log("(超时)"); flush(); app.exit(9); }, 40000);
