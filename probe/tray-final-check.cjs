/**
 * 托盘**收尾**验证：把生产代码里那条真实路径完整走一遍。
 *
 * 验三件事（全部是实测出来的坑，不是推测）：
 *   ① 新兜底图 TRAY_FALLBACK_PNG 必须解出**非空**位图。
 *      上一版是坏 base64，`createFromDataURL` 出来 isEmpty=true
 *      ⇒ `createTray()` bail ⇒ 托盘整个不出现，日志只有一行 error。
 *   ② 渲染层 `__orbTrayIconPng` 回传的 PNG 能过 `createFromDataURL` + `resize(16)`
 *      —— 走的就是 refreshTrayIcon 里那条路。
 *   ③ `setImage` / `new Tray` 只吃单张 NativeImage；数组必抛。
 *      （万一以后有人"优化"回数组，这条会在真机层再拦一次。）
 *
 * 结果写 probe/_tray_final.txt（Electron 无窗口时 stdout 不可靠）。
 */
const { app, BrowserWindow, Tray, nativeImage } = require("electron");
const { join } = require("node:path");
const fs = require("node:fs");

const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "probe", "_tray_final.txt");
const lines = [];
let failed = 0;
const log = (s) => lines.push(s);
const check = (name, ok, extra = "") => {
  log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (!ok) failed += 1;
};
const flush = () => {
  try {
    fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  } catch {}
};

// ---- 从 main.js 里抠出真实的 TRAY_FALLBACK_PNG 字面量（不复制一份，避免两份漂移）----
const mainSrc = fs.readFileSync(join(ROOT, "helper", "lib", "main.js"), "utf8");
function extractFallback() {
  const m = mainSrc.match(/const TRAY_FALLBACK_PNG =\s*([\s\S]*?);\n/);
  if (!m) return null;
  const b64 = m[1]
    .split("\n")
    .map((l) => {
      const h = l.match(/"([A-Za-z0-9+/=]+)"/);
      return h ? h[1] : "";
    })
    .join("");
  return "data:image/png;base64," + b64;
}

const AVATARS = [
  "",
  "avatars/smile.gif",
  "avatars/cheer.gif",
  "avatars/cheeks.gif",
  "avatars/heart.gif",
  "avatars/point.gif",
  "avatars/rice.gif"
];

app.whenReady().then(async () => {
  try {
    // ① 兜底图
    const fallbackUrl = extractFallback();
    check("从 main.js 抠到兜底图字面量", !!fallbackUrl);
    const fb = nativeImage.createFromDataURL(fallbackUrl);
    const fbSize = fb.getSize();
    check("兜底图非空", !fb.isEmpty(), `size=${fbSize.width}x${fbSize.height}`);
    const fb16 = fb.resize({ width: 16, height: 16, quality: "best" });
    check("兜底图可 resize 到 16×16", !fb16.isEmpty());

    // ② 真实渲染层回传 → 托盘路径
    const win = new BrowserWindow({
      width: 480,
      height: 360,
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

    const registered = await win.webContents.executeJavaScript(
      "typeof window.__orbTrayIconPng === 'function'"
    );
    check("渲染层 __orbTrayIconPng 已注册", registered === true, `typeof = ${registered}`);

    // 真建一个托盘，走 applyTrayImage 的同一条路径
    let tray = null;
    try {
      tray = new Tray(fb16);
      check("new Tray(单张 NativeImage) 成功", true);
    } catch (e) {
      check("new Tray(单张 NativeImage) 成功", false, e.message);
    }

    for (const src of AVATARS) {
      const label = src || "(默认图)";
      const payload = src || "deepseek-avatar-square.gif";
      let dataUrl;
      try {
        dataUrl = await win.webContents.executeJavaScript(
          `window.__orbTrayIconPng(${JSON.stringify(payload)})`
        );
      } catch (e) {
        check(`渲染层解码 ${label}`, false, e.message);
        continue;
      }
      if (!dataUrl || typeof dataUrl !== "string") {
        check(`渲染层解码 ${label}`, false, `回传 ${typeof dataUrl}`);
        continue;
      }
      const img = nativeImage.createFromDataURL(dataUrl);
      if (img.isEmpty()) {
        check(`托盘图标 ${label} 非空`, false, "isEmpty=true");
        continue;
      }
      const sized = img.resize({ width: 16, height: 16, quality: "best" });
      const ok = !sized.isEmpty();
      let applied = false;
      if (ok && tray && !tray.isDestroyed()) {
        try {
          tray.setImage(sized);
          applied = true;
        } catch (e) {
          log(`  setImage 抛错: ${e.message}`);
        }
      }
      const size = img.getSize();
      check(
        `托盘图标 ${label} 全链路可贴`,
        ok && applied,
        `源 ${size.width}x${size.height} → 16×16, PNG ${dataUrl.length} 字符, setImage=${applied}`
      );
    }

    // ③ 反向：数组必须抛错（守住这个已知边界）
    try {
      tray.setImage([fb16, fb16]);
      check("setImage(NativeImage[]) 应当抛错", false, "竟然没抛 —— 前提变了，回来重新评估");
    } catch (e) {
      check("setImage(NativeImage[]) 抛错（符合实测）", /must be a file path or a NativeImage/.test(e.message), e.message);
    }

    if (tray && !tray.isDestroyed()) {
      try {
        tray.destroy();
        check("tray.destroy() 成功", true);
      } catch (e) {
        check("tray.destroy() 成功", false, e.message);
      }
    }
    win.destroy();
  } catch (err) {
    log(`未捕获异常: ${err && err.stack ? err.stack : err}`);
    failed += 1;
  } finally {
    log(failed === 0 ? "\n=== 全部通过 ===" : `\n=== ${failed} 项失败 ===`);
    flush();
    app.exit(failed === 0 ? 0 : 1);
  }
});

setTimeout(() => {
  log("(整体超时)");
  flush();
  app.exit(9);
}, 60000);
