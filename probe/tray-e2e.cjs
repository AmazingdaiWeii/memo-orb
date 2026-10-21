/**
 * 托盘图标**端到端**验证（真 Electron + 真 floating.html + 真 shell.js）。
 *
 * 验的是这条链路真的通：
 *   主进程 executeJavaScript('__orbTrayIconPng(src)')
 *     → 渲染层 canvas 把 GIF 首帧画出来
 *     → toDataURL('image/png')
 *     → 主进程 nativeImage.createFromDataURL() → 非空位图
 *
 * ★ 为什么必须有这个探针：`nativeImage` 不解析 GIF（已实测 isEmpty=true），
 *   所以整条链路的成败就在「渲染层有没有真的解出 PNG」。
 *   而这条链路一旦断了，托盘是**空白格子 + 零日志**（静默失败族）。
 *
 * 结果写 probe/_tray_e2e.txt，并把 PNG 落盘供肉眼确认。
 * 跑法：electron.exe --no-sandbox probe/tray-e2e.cjs
 */
const { app, BrowserWindow, nativeImage } = require("electron");
const { join } = require("node:path");
const fs = require("node:fs");

const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "probe", "_tray_e2e.txt");
const lines = [];
const log = (s) => lines.push(s);
const flush = () => {
  try {
    fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  } catch {}
};

app.whenReady().then(async () => {
  log("=== 托盘图标 端到端 ===");
  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 500,
    webPreferences: {
      preload: join(ROOT, "helper", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // shell.js 会调一堆 ipcRenderer.invoke/send，没有 handler 会 reject 但不应致命。
  // 不注册任何 handler，让页面自己容错 —— 我们要的就是 window.__orbTrayIconPng 被注册。
  win.webContents.on("console-message", (_e, level, message) => {
    if (String(message).includes("tray icon")) log(`  [page] ${message}`);
  });

  try {
    await win.loadFile(join(ROOT, "helper", "assets", "floating.html"));
    log("floating.html 已加载");
  } catch (e) {
    log("加载失败: " + e.message);
    flush();
    app.exit(1);
    return;
  }

  // 等 shell.js（module）执行完并注册函数
  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const has = await win.webContents.executeJavaScript(
      "typeof window.__orbTrayIconPng === 'function'"
    );
    if (has) {
      ready = true;
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }
  log(`__orbTrayIconPng 已注册: ${ready}`);
  if (!ready) {
    log("★ shell.js 未能注册函数 —— 检查它是否在初始化时抛错");
    flush();
    app.exit(2);
    return;
  }

  const CASES = [
    ["默认（空串 → 当前球脸）", ""],
    ["预设 smile", "avatars/smile.gif"],
    ["预设 heart", "avatars/heart.gif"]
  ];

  for (const [label, src] of CASES) {
    const t0 = Date.now();
    // eslint-disable-next-line no-await-in-loop
    const dataUrl = await win.webContents.executeJavaScript(
      `window.__orbTrayIconPng(${JSON.stringify(src)})`
    );
    const ms = Date.now() - t0;
    if (!dataUrl || typeof dataUrl !== "string") {
      log(`${label}\n  回传: null  ★ 渲染层解码失败\n  耗时: ${ms} ms`);
      continue;
    }
    const image = nativeImage.createFromDataURL(dataUrl);
    const size = image.getSize();
    const small = image.resize({ width: 16, height: 16, quality: "best" });
    const png16 = small.toPNG();
    // 落一张 64px 的供肉眼确认
    const abs = join(ROOT, "probe", `_tray_${label.replace(/[^\w]/g, "_")}.png`);
    try {
      fs.writeFileSync(abs, image.toPNG());
    } catch {}
    log(
      `${label}\n` +
        `  dataUrl     ${dataUrl.slice(0, 30)}…  (${dataUrl.length} 字符)\n` +
        `  isEmpty     ${image.isEmpty()}   <-- 必须 false\n` +
        `  位图尺寸    ${size.width}x${size.height}\n` +
        `  16x16 PNG   ${png16.length} B  <-- 非 0 才算真图标\n` +
        `  回传耗时    ${ms} ms`
    );
  }

  flush();
  try {
    win.destroy();
  } catch {}
  app.exit(0);
});

setTimeout(() => {
  log("(超时强退)");
  flush();
  app.exit(9);
}, 30000);
