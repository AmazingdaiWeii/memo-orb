#!/usr/bin/env node
/**
 * 六个情绪 GIF 在**真实 Chromium 渲染进程**里能不能解码（只读，不碰 config/data）。
 *
 * 起因（2026-10-22 用户报障）：
 *   「窗口侧的情绪 gif 表达不完整，只有思考和开心这两种，其它的都无法加载。」
 *
 * 「无法加载」有两种完全不同的含义，必须分开验：
 *   A. 图片本身解不出来（素材坏 / 路径错 / 格式不对）
 *   B. 图好得很，只是**没人推过这个情绪**
 * 本探针只回答 A。B 由 `probe/mood-alias-audit.mjs` 回答。
 *
 * ⚠️ 第一版踩的坑（记下来别再犯）：在 `about:blank` 页面里 `new Image()` 指向
 *    `file://` 会被同源策略拦成 onerror —— **六张全红**，看起来像"素材全坏"，
 *    其实是探针自己错了。必须让页面本身是一个 `file://` 文档（这里造个临时页），
 *    才能在同样的权限下测真实加载。
 *
 * 判据：`img.naturalWidth > 0` ⇒ 浏览器真的解出了像素。
 *
 * 跑法（无 GPU 环境必须带两个开关）：
 *   env -u ELECTRON_RUN_AS_NODE NODE_OPTIONS= \
 *     runtime/electron/electron.exe probe/deco-decode-e2e.cjs --no-sandbox --disable-gpu
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { existsSync, statSync, writeFileSync, unlinkSync } = require('node:fs')

const ROOT = join(__dirname, '..')
const MOODS = ['idle', 'thinking', 'happy', 'shy', 'sad', 'surprised']
const TMP = join(__dirname, '_deco-decode-tmp.html')

app.disableHardwareAcceleration()

const items = MOODS.map((m) => {
  const abs = join(ROOT, 'helper', 'assets', 'deco', `${m}.gif`)
  return {
    mood: m,
    url: pathToFileURL(abs).href,
    exists: existsSync(abs),
    bytes: existsSync(abs) ? statSync(abs).size : 0,
  }
})

const html = `<!doctype html><meta charset="utf-8"><body>
${items
  .map(
    (it) =>
      `<img id="img-${it.mood}" data-mood="${it.mood}" src="${it.url}" width="96" height="96" alt="">`
  )
  .join('\n')}
<script>
window.__r = {}
Promise.all(${JSON.stringify(items.map((i) => i.mood))}.map(function (m) {
  return new Promise(function (resolve) {
    var img = document.getElementById('img-' + m)
    var done = false
    function finish(v) { if (!done) { done = true; window.__r[m] = v; resolve() } }
    function snap(err) {
      finish({ ok: img.naturalWidth > 0, w: img.naturalWidth, h: img.naturalHeight, err: err })
    }
    if (img.complete) return snap(img.naturalWidth > 0 ? '' : 'onerror')
    img.addEventListener('load', function () { snap('') })
    img.addEventListener('error', function () { snap('onerror') })
    setTimeout(function () { snap('timeout') }, 15000)
  })
})).then(function () { window.__done = true })
</script></body>`

app.whenReady().then(async () => {
  writeFileSync(TMP, html, 'utf8')

  const win = new BrowserWindow({
    show: false,
    width: 480,
    height: 320,
    webPreferences: { offscreen: true, contextIsolation: false, nodeIntegration: false, webSecurity: true },
  })

  await win.loadFile(TMP)

  // 等全部 load/error 落定
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const done = await win.webContents.executeJavaScript('window.__done === true')
    if (done) break
    await new Promise((r) => setTimeout(r, 200))
  }

  const got = await win.webContents.executeJavaScript('JSON.stringify(window.__r || {})')
  const parsed = JSON.parse(got)

  let pass = 0
  let fail = 0
  console.log('='.repeat(64))
  console.log('六个情绪 GIF · 真实渲染进程解码验证')
  console.log('='.repeat(64))
  for (const it of items) {
    const r = parsed[it.mood] ?? { ok: false, w: 0, h: 0, err: 'no-result' }
    const head = `  ${it.mood.padEnd(10)}`
    if (r.ok) {
      pass += 1
      console.log(`${head} ✅ 解码成功  ${r.w}x${r.h}  ${(it.bytes / 1024).toFixed(0)}KB`)
    } else {
      fail += 1
      console.log(`${head} ❌ 解码失败  exists=${it.exists} bytes=${it.bytes} ${r.err}`)
    }
  }
  console.log('-'.repeat(64))
  console.log(`PASS ${pass} / FAIL ${fail}`)
  console.log(
    fail === 0
      ? '结论：素材层与解码层完全正常 —— 「无法加载」不成立，去查「没人推这个情绪」。'
      : '结论：有素材真的解不出来，这才是「无法加载」。'
  )

  try {
    unlinkSync(TMP)
  } catch {}

  win.destroy()
  app.exit(fail === 0 ? 0 : 1)
})
