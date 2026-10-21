// 冒烟探针：证实/证伪「floating.html 的 CSP（img-src 'self' data:，不含 blob:）
// 会不会拒绝 blob: 缩略图」。跑法：
//   & "E:\Memo orb\runtime\electron\electron.exe" "E:\Memo orb\probe\csp-blob-check.cjs"
// 判定：打印 [CSPCHK] blob-url BLOCKED + data-url-control LOADED ⇒ 根因坐实。
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// Windows 上 electron.exe 是 GUI 子系统程序，stdout 未必接得住 PowerShell 的管道；
// 所以同时落一份日志文件，以文件为准。
const LOG = path.join(__dirname, '_csp-blob-check.log')
fs.writeFileSync(LOG, '')
function say(line) {
  console.log(line)
  try {
    fs.appendFileSync(LOG, line + '\n')
  } catch { /* 落盘失败不影响 stdout */ }
}

app.disableHardwareAcceleration()

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, width: 320, height: 200 })
  win.webContents.on('console-message', (...args) => {
    // Electron 新旧签名不一：老版 (event, level, message, line, sourceId)，新版 (details)
    const first = args[0]
    const msg = first && typeof first === 'object' && typeof first.message === 'string'
      ? first.message
      : args[2]
    if (typeof msg === 'string') say(msg)
  })
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      say('[CSPCHK] quit')
      app.quit()
    }, 1200)
  })
  win.loadFile(path.join(__dirname, 'csp-blob-check.html'))
  setTimeout(() => {
    say('[CSPCHK] timeout-quit')
    app.quit()
  }, 15000)
})
