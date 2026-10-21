// 环形菜单独立窗口的 preload（方案C）
// 暴露 window.ringMenu api 给渲染层 —— 只开四个口子：动作、关闭、命中开关、透明度。
// 全部单向 send，不需要 invoke：渲染层从不等待主进程结果，窗口尺寸/位置由主进程掌管。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ringMenu', {
  // 菜单项点击：通知主进程，主进程关掉环窗口再回传给球窗口执行
  action(id) {
    ipcRenderer.send('orb:ring-action', String(id ?? ''))
  },
  // 关闭菜单（光标离开环带 / ESC / 点环外）
  close() {
    ipcRenderer.send('orb:ring-close')
  },
  // 环带命中开关：true = 环带吃鼠标事件；false = 整个窗口穿透，点击落回桌面或球窗口。
  // 这是「中心孔里的球仍可点、环外不挡桌面」的关键——窗口默认全穿透，
  // 只有光标压在环带上时才临时把穿透关掉。
  hit(interactive) {
    ipcRenderer.send('orb:ring-hit', interactive === true)
  },
  // 拖动外侧透明度环：值由主进程夹取后写进 logs/window-state.json
  opacity(value) {
    const n = Number(value)
    if (Number.isFinite(n)) ipcRenderer.send('orb:ring-opacity', n)
  },
  // 主进程推来的 { items, opacity }：每次打开都会重放一份
  onData(callback) {
    ipcRenderer.on('ring-menu:data', (_event, payload) => callback(payload))
  },
})
