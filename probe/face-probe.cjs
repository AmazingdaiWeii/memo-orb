/**
 * 自动探脸：对每张头像，逐像素统计「非背景像素」的分布，
 * 估出人脸/主体所在的位置与尺度，输出建议裁切参数。
 *
 * 做法（在 Chromium 里跑，能解 GIF）：
 *   1. 把 GIF 画到 canvas，getImageData 拿像素；
 *   2. 背景判定：与四角颜色接近 + 低饱和/高亮的像素视为背景；
 *   3. 对"前景"像素求质心 (mx,my) 与二阶矩（估算主体半径）；
 *   4. 脸在上半部：把质心的 y 往"上偏"一点（人体立绘主体重心在胸腹，
 *      而我们要的是头）——用前景像素里"最靠上的 35% 行"再求一次质心，得到头部中心。
 *
 * 输出：每张图的 [头部中心 x, 头部中心 y, 主体尺度 s] 建议值。
 */
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const fs = require("node:fs");

const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "probe", "_face_probe.txt");
const lines = [];

const items = [
  "orb-idle.gif",
  "avatars/smile.gif",
  "avatars/cheer.gif",
  "avatars/cheeks.gif",
  "avatars/heart.gif",
  "avatars/point.gif",
  "avatars/rice.gif"
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 600,
    height: 400,
    show: false,
    webPreferences: {
      preload: join(ROOT, "helper", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  await win.loadFile(join(ROOT, "helper", "assets", "floating.html"));
  await new Promise((r) => setTimeout(r, 1200));

  const out = await win.webContents.executeJavaScript(`(async () => {
    const items = ${JSON.stringify(items)};
    const res = [];
    for (const src of items) {
      const img = new Image();
      await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = src; });
      const W = img.naturalWidth, H = img.naturalHeight;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, W, H).data;

      // 四角平均色 = 背景参考
      const corners = [[0,0],[W-1,0],[0,H-1],[W-1,H-1]];
      let br=0,bg=0,bb=0,ba=0;
      for (const [x,y] of corners) {
        const i=(y*W+x)*4; br+=d[i]; bg+=d[i+1]; bb+=d[i+2]; ba+=d[i+3];
      }
      br/=4; bg/=4; bb/=4; ba/=4;

      // 前景掩码：与背景色差足够大且不透明
      const isFg = (i) => {
        const a = d[i+3];
        if (a < 40) return false;
        const dr=d[i]-br, dg=d[i+1]-bg, db=d[i+2]-bb;
        return Math.sqrt(dr*dr+dg*dg+db*db) > 42;
      };

      // 全前景质心 + 行分布
      let sxx=0, syy=0, n=0;
      const rowCount = new Float64Array(H);
      for (let y=0;y<H;y++){
        for (let x=0;x<W;x++){
          const i=(y*W+x)*4;
          if (!isFg(i)) continue;
          sxx+=x; syy+=y; n++; rowCount[y]++;
        }
      }
      // 头部区：取"从顶部算起、累计前景达到总量 42%"的那一段
      const target = n*0.42;
      let acc=0, headBottom=H;
      for (let y=0;y<H;y++){ acc+=rowCount[y]; if (acc>=target){ headBottom=y; break; } }
      // 头部区域质心
      let hx=0, hy=0, hn=0, hMinY=H, hMaxY=0, hMinX=W, hMaxX=0;
      for (let y=0;y<=headBottom;y++){
        for (let x=0;x<W;x++){
          const i=(y*W+x)*4;
          if (!isFg(i)) continue;
          hx+=x; hy+=y; hn++;
          if (y<hMinY) hMinY=y; if (y>hMaxY) hMaxY=y;
          if (x<hMinX) hMinX=x; if (x>hMaxX) hMaxX=x;
        }
      }
      const hcx = hn? hx/hn/W : 0.5;
      const hcy = hn? hy/hn/H : 0.5;
      // 头部包围盒（用于估尺度）
      const hbw = (hMaxX-hMinX)/W, hbh=(hMaxY-hMinY)/H;
      res.push({
        src, dim: W+'x'+H, fgRatio: +(n/(W*H)).toFixed(3),
        headCx: +hcx.toFixed(3), headCy: +hcy.toFixed(3),
        headBoxW: +hbw.toFixed(3), headBoxH: +hbh.toFixed(3),
        headTop: +(hMinY/H).toFixed(3), headBottom: +(hMaxY/H).toFixed(3),
        fullCx: +(sxx/n/W).toFixed(3), fullCy: +(syy/n/H).toFixed(3)
      });
    }
    return JSON.stringify(res);
  })()`);

  const data = JSON.parse(out);
  lines.push("src\tdim\tfg\t头心x\t头心y\t头宽\t头高\t头顶\t头底\t全体x\t全体y");
  for (const d of data) {
    lines.push([d.src,d.dim,d.fgRatio,d.headCx,d.headCy,d.headBoxW,d.headBoxH,d.headTop,d.headBottom,d.fullCx,d.fullCy].join("\t"));
  }
  fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  win.destroy();
  app.exit(0);
});

setTimeout(() => { fs.writeFileSync(OUT, lines.join("\n") + "\n(超时)\n", "utf8"); app.exit(9); }, 60000);
