/**
 * 验证 Electron `Tray.setImage()` / `new Tray()` 是否接受 NativeImage[]。
 *
 * 我不确定这一点，所以在把生产代码写成「传数组」之前先实测 ——
 * 猜错的后果是托盘图标**静默不变**（Tray 对无效输入不抛错）。
 */
const { app, Tray, nativeImage } = require("electron");
const { join } = require("node:path");
const fs = require("node:fs");

const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "probe", "_tray_api.txt");
const lines = [];
const log = (s) => lines.push(s);
const flush = () => { try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch {} };

app.whenReady().then(() => {
  const glyph = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAgUlEQVR42mNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMAgAqTQABb0m1iQAAAABJRU5ErkJggg==";
  const base = nativeImage.createFromDataURL(glyph);
  log(`基底图 isEmpty=${base.isEmpty()} size=${base.getSize().width}x${base.getSize().height}`);

  const set = [16, 20, 24, 32].map((s) =>
    base.resize({ width: s, height: s, quality: "best" })
  );
  log(`数组 = ${set.length} 张，尺寸 ${set.map((i) => i.getSize().width).join("/")}`);

  // ① new Tray(单张) → ② setImage(数组)
  try {
    const t = new Tray(set[0]);
    log("new Tray(single): OK");
    try {
      t.setImage(set);
      log("setImage(NativeImage[]): OK  ← 没抛错");
      // 读回看看系统记的是哪张
      const back = t.getBounds();
      log(`  tray.getBounds() = ${JSON.stringify(back)}`);
    } catch (e) {
      log("setImage(NativeImage[]): 抛错 " + e.message);
    }
    try {
      t.setImage(base);
      log("setImage(single): OK");
    } catch (e) {
      log("setImage(single): 抛错 " + e.message);
    }
    setTimeout(() => {
      try { t.destroy(); log("destroy OK"); } catch (e) { log("destroy 抛错 " + e.message); }
      // ③ 直接 new Tray(数组) 也试一下
      try {
        const t2 = new Tray(set);
        log("new Tray(NativeImage[]): OK");
        try { t2.destroy(); } catch {}
      } catch (e) {
        log("new Tray(NativeImage[]): 抛错 " + e.message);
      }
      flush();
      app.exit(0);
    }, 500);
  } catch (e) {
    log("new Tray(single): 抛错 " + e.message);
    flush();
    app.exit(1);
  }
});

setTimeout(() => { log("(超时)"); flush(); app.exit(9); }, 15000);
