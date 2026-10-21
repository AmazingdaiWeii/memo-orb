/**
 * 托盘图标的**真机验证**（在真 Electron 里跑）。
 * 结果直接写 probe/_bench.txt，不依赖 stdout 捕获（Electron 的 stdout 在无窗口时经常丢）。
 *
 * ★★ 2026-10-08 实测结论（保留此探针作为回归）：
 *   `nativeImage.createFromPath()` **对 GIF 返回空图**（isEmpty=true / 0x0）——
 *   Electron 的 nativeImage 只解 PNG / JPEG。而本项目的头像素材**全是 GIF**。
 *   所以托盘图标**不能**直接 createFromPath 头像文件，必须让渲染层（Chromium）
 *   解码首帧后回传 PNG。详见 main.js 的 `refreshTrayIcon` 注释。
 *
 *   这个坑的危险之处：`Tray` 接受空图**不抛错**，症状是托盘出现一个空位，
 *   而所有日志都正常 —— 属于「静默失败族」。
 */
const { app, Tray, nativeImage, Menu } = require("electron");
const { join } = require("node:path");
const fs = require("node:fs");

const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "probe", "_bench.txt");
const lines = [];
const log = (s) => lines.push(s);
const flush = () => {
  try {
    fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  } catch {}
};

const CASES = [
  ["GIF 默认 7.4MB", "helper/assets/deepseek-avatar-square.gif"],
  ["GIF 预设 2.3MB", "helper/assets/avatars/smile.gif"],
  ["PNG 对照", "helper/assets/backgrounds/bg-chat.png"]
];

app.whenReady().then(() => {
  log("=== 托盘图标基准（真 Electron）===");
  for (const [label, rel] of CASES) {
    const file = join(ROOT, rel);
    if (!fs.existsSync(file)) {
      log(`SKIP ${label}: 不存在`);
      continue;
    }
    const bytes = fs.statSync(file).size;
    let best = Infinity;
    let img;
    for (let i = 0; i < 3; i += 1) {
      const t0 = process.hrtime.bigint();
      img = nativeImage.createFromPath(file);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (ms < best) best = ms;
    }
    const size = img.getSize();
    const small = img.resize({ width: 16, height: 16, quality: "best" });
    log(
      `${label}\n` +
        `  文件      ${(bytes / 1048576).toFixed(2)} MB\n` +
        `  解码(最快) ${best.toFixed(1)} ms\n` +
        `  ★isEmpty  ${img.isEmpty()}   <-- GIF 应为 true（nativeImage 不解析 GIF）\n` +
        `  位图尺寸  ${size.width}x${size.height}\n` +
        `  16x16 PNG ${small.toPNG().length} B`
    );
  }
  flush();
  app.exit(0);
});

setTimeout(() => {
  log("(超时强退)");
  flush();
  app.exit(2);
}, 20000);
