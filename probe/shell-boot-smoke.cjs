/**
 * 渲染层装配冒烟 · probe/shell-boot-smoke.cjs
 *
 * 跑法（Windows；必须先清掉 ELECTRON_RUN_AS_NODE，否则 electron.exe 会退化成纯 Node）：
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE
 *   & "E:\Memo orb\runtime\electron\electron.exe" "E:\Memo orb\probe\shell-boot-smoke.cjs"
 *   （更稳的跑法：Start-Process … -PassThru + 轮询 HasExited；`-Wait` 在透明窗口上会卡死）
 * 退出码：0 全通过 / 1 有 FAIL / 2 探针自身出错 / 3 内部超时。日志：probe/_shell-boot-smoke.log
 *
 * ── 为什么要有这支探针（2026-10-08 实测事故）───────────────────────────
 * helper/assets/api-config.js 里 `applyClose()` **只有调用、没有定义** →
 * `createApiConfigPanel()` 初始化时抛
 *   Uncaught ReferenceError: applyClose is not defined   (api-config.js:198)
 * 而它在 shell.js:579 的 `main()` 里被调用，于是 `main()` 当场中断：
 * `applyStaticText()` 与其后**所有球窗口监听**（pointerdown / pointermove /
 * pointerup / contextmenu）全都没注册。
 *
 * 用户看到的现象：「球在屏幕上、程序不报错不闪退，但左键点不动、拖不动，
 * 右键弹出来的是最初始那版菜单」—— 右键失去渲染层 handler 后落到了窗口层
 * （helper/lib/main.js:1731 的 `webContents.on("context-menu", …)` → showMenu）。
 * 宿主 logs/orb.log 一行错都没有：错误只在渲染进程控制台里，要 `--enable-logging`
 * 才看得到；而当时三套源码扫描类探针（ring-geometry / ring-interaction /
 * ring-menu-layout）全绿 —— 因为它们只读源码，没人真的把渲染层跑起来点一下。
 *
 * 本探针补的就是这一层：**真的起渲染进程、真的点、真的看 IPC**。
 *
 * ── 断言 ──────────────────────────────────────────────────────────────
 * S0 产品契约：仍能从 helper/lib/main.js 抽到球窗口 webPreferences（preload.cjs + sandbox:true）
 * S1 floating.html 在真实渲染进程里加载成功，`#ball` 存在
 * S2 渲染层没有任何 uncaught 报错（ReferenceError / TypeError / SyntaxError / 加载失败）
 * S3 `document.documentElement.dataset.shellReady === '1'`（main() 走完了，标记见 shell.js 尾部）
 * S4 控制台出现 `[shell] main() 装配完成`
 * S5 反向对照：一份故意写坏的临时页面必须被同一套收集器抓到 ReferenceError，
 *    抓不到就说明 S2 是假绿
 * S6 真实右键球体（sendInputEvent）→ 主进程收到 `orb:ring-open`，且菜单项清单非空
 *    （证明 ball 的 contextmenu 监听真的注册上了）
 * S7 真实左键点球（sendInputEvent）→ `document.body.classList` 出现 `expanded`
 *    （证明 pointerdown/pointerup → togglePanel → setExpanded 这条左键链真的通了）
 * S8 同一次左键 → `body.pinned`（用户 m01764 ①：左键「点一下钉住」必须还在）
 * S9 展开态恰好两条自由边手柄可见、尺寸非零（与 `freeEdges()` 推出来的方向一致）
 * S9b 手柄必须贴着**面板可见边界**（不是窗口外缘）—— 用户「拖边缘没反应」的机制
 * S10 真拖手柄 60px → 主进程收到 `orb:resize`，宽度 +60、高度不变（用户 m01764 ②）
 * S11 钉住时指针离开窗口 500ms 面板仍在（未钉住 180ms 就被 scheduleCollapse 收掉）
 * S12 反向对照：再点一次球 → 取消钉住并收起、手柄全部 display:none（S11 不是恒真）
 * S13 反向对照：收起态拖同一条边不再产生 `orb:resize`（S10 的 IPC 确实来自手柄链）
 *
 * 说明：探针只起**渲染层**（floating.html + 真 helper/preload.cjs），不起窗口层与 Letta 后端。
 * 渲染层会发起的 `orb:*` 通道全部按 preload.cjs 里真实出现过的通道名挂哑处理器，
 * 免得 `ipcRenderer.invoke` 全部 reject（"No handler registered"）被误判成渲染层报错。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { appendFileSync, readFileSync, writeFileSync, unlinkSync } = require('node:fs')
const { join, resolve } = require('node:path')

const ROOT = resolve(__dirname, '..')
const LOG_PATH = join(__dirname, '_shell-boot-smoke.log')
const PAGE = join(ROOT, 'helper', 'assets', 'floating.html')
const PRELOAD = join(ROOT, 'helper', 'preload.cjs')
const MAIN_JS = join(ROOT, 'helper', 'lib', 'main.js')
const NEGATIVE_PAGE = join(__dirname, '_shell-boot-smoke-negative.html')

app.disableHardwareAcceleration()

try {
  writeFileSync(LOG_PATH, '')
} catch {
  /* 日志写不进去也不该影响断言 */
}

let passed = 0
let failed = 0
let skipped = 0
function out(text = '') {
  console.log(text)
  try {
    appendFileSync(LOG_PATH, `${text}\n`, 'utf8')
  } catch {
    /* 同上 */
  }
}
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    out(`PASS  ${name}`)
    return
  }
  failed += 1
  out(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}
function skip(name, why) {
  skipped += 1
  out(`SKIP  ${name} — ${why}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

out(`# 渲染层装配冒烟 · ROOT=${ROOT}`)
out(`# electron=${process.versions.electron} chrome=${process.versions.chrome} node=${process.versions.node}`)
out('')

/* ── S0 产品契约：球窗口的 webPreferences 仍照旧 ──────────────────────── */
const mainSource = readFileSync(MAIN_JS, 'utf8')
const preloadSource = readFileSync(PRELOAD, 'utf8')
const ballPrefs = mainSource.match(
  /preload:\s*fileURLToPath\(new URL\("\.\.\/preload\.cjs"[\s\S]{0,200}?sandbox:\s*true/,
)
check(
  'S0 球窗口契约：helper/lib/main.js 仍用 ../preload.cjs + contextIsolation + sandbox:true 建窗',
  Boolean(ballPrefs),
  '抽不到 —— 窗口层建窗方式变了，本探针的建窗参数需要同步复核',
)

/* ── 渲染层会用的 orb:* 通道：按 preload.cjs 里真实出现过的名字挂哑处理器 ── */
const CHANNELS = [...new Set([...preloadSource.matchAll(/['"](orb:[\w-]+)['"]/g)].map((m) => m[1]))]
const ringOpens = []
/** 缩放手柄回调（`preload.cjs` 的 `setPanelSize` → `ipcRenderer.invoke('orb:resize')`）。 */
const resizes = []
/** 用户 m02033（主题 + 三张页面背景）：这三条是「新链路真的走到主进程」的唯一证据。 */
const themeSets = []
const bgUpdates = []
const bgClears = []
/** 主进程会给渲染层的背景快照形状（照 `helper/lib/main.js` 的 backgroundsSnapshot 抄）。 */
/** 「看过的视频」账本快照（形状照 `src/bili-history.mjs` 的 `list()` 抄）。 */
const BILI_HISTORY_SNAPSHOT = {
  ok: true,
  total: 2,
  items: [
    {
      bvid: 'BV1GJ411x7h7',
      cid: 137649199,
      page: 1,
      title: '【官方 MV】Never Gonna Give You Up - Rick Astley',
      pageTitle: '',
      duration: 213,
      quality: 64,
      qualityLabel: '清晰 720P（64）',
      width: 1280,
      height: 720,
      account: '探针账号',
      frameTimes: [0.021, 105.021, 205.021],
      watches: 2,
      when: '今天 20:11',
      /* 概览：她看完之后自己写的那句（2026-10-21 深夜新增的字段）。 */
      summary: '一支 80 年代的复古 MV，副歌洗脑。',
    },
    {
      bvid: 'BV1xx411c7mD',
      cid: 28231,
      page: 1,
      title: '只用元信息的那一条',
      pageTitle: '',
      duration: 60,
      quality: 32,
      qualityLabel: '清晰 480P（32）',
      width: 640,
      height: 480,
      account: '',
      frameTimes: [],
      watches: 1,
      when: '昨天 18:02',
      /* 没取过画面 ⇒ 没有概览（界面退回「只看了元信息」占位） */
      summary: '',
    },
  ],
  /* 2026-10-21 夜重排：上半块「我喜欢的」读 `liked` 数组（liked 有值的那些）。
     形状照 `src/bili-history.mjs` 的 `listLiked()`。 */
  liked: [
    {
      bvid: 'BV1GJ411x7h7',
      cid: 137649199,
      page: 1,
      title: '【官方 MV】Never Gonna Give You Up - Rick Astley',
      pageTitle: '',
      duration: 213,
      quality: 64,
      qualityLabel: '清晰 720P（64）',
      frameTimes: [0.021, 105.021],
      watches: 2,
      when: '今天 20:11',
      summary: '探针拟的概览：八十年代的复古 MV。',
      liked: {
        at: '2026-10-21T20:12:00.000Z',
        reason: '她把整段副歌一帧一帧看过，说这段节奏"像有人在门口等你回来"。',
        comment: '这个转场我反复看了好几遍。',
        sentAt: '',
      },
      actions: { like: true, coin: 1, fav: false },
    },
  ],
}
/** 渲染层点一行时发出的外链（证明「点一行去 B 站」这条路是通的）。 */
const externals = []
/** 赞 / 币 / 藏 真的发出去才算数（2026-10-21 夜新增的四个通道）。 */
const biliActs = []
const biliComposes = []
const biliNoteSaves = []
const biliComments = []
/** 「让她写/重写概览」这条通道（2026-10-21 深夜新增）。 */
const biliSummaries = []
const BG_SNAPSHOT = {
  ok: true,
  dir: join(ROOT, 'helper', 'assets', 'backgrounds'),
  slots: {
    /* ★ 用**真实存在**的那两张（照 logs/window-state.json 里用户实际设的槽抄）。
     *   原来这里写的是 `bg-chat-20261019T225040.png` —— 那个文件**根本不存在**，
     *   于是探针截图里背景永远是空的 ⇒「正文压在高对比背景上读不了」这类问题
     *   在我眼前一直是隐形的。fixture 指向不存在的文件 = 假的安全感。 */
    chat: { file: 'bg-chat-20261019T225040.png', url: 'backgrounds/bg-chat-20261019T225040.png', fit: 'cover', scrim: 0.55 },
        // history 槽**故意留空**：S14/S15 要验「没设图的槽不会乱显示、不叠蒙层」
    history: { file: '', url: '', fit: 'cover', scrim: 0.55 },
    recall: { file: 'bg-recall-20261007T235002.png', url: 'backgrounds/bg-recall-20261007T235002.png', fit: 'contain', scrim: 0.8 },
  },
}
/** 主进程会给渲染层的 API 配置快照（照 `helper/lib/main.js` 的 apiConfigSnapshot + modelSettingsSnapshot 抄）。 */
const apiPatches = []
const API_SNAPSHOT = {
  ok: true,
  model: 'deepseek/deepseek-flash',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-probe-not-a-real-key',
  provider: 'deepseek',
  configPath: join(ROOT, 'config.json'),
  authPath: join(ROOT, 'probe', '_auth-probe.json'),
  canEditProvider: true,
  modelAgents: [{ agentId: 'agent-local-probe', file: join(ROOT, 'probe', '_agent-probe.json'), ok: true, thinking: 'off', contextWindowLimit: null }],
  thinking: 'off',
  contextWindowLimit: null,
  agentPath: join(ROOT, 'probe', '_agent-probe.json'),
  canEditModelSettings: true,
  modelSettingsError: '',
}
for (const channel of CHANNELS) {
  if (channel === 'orb:resize') {
    // ★ 必须单独接管：这条是「拖手柄有没有真的走到主进程」的唯一证据（用户 m01764）。
    ipcMain.handle(channel, (_event, width, height) => {
      resizes.push({ width: Number(width) || 0, height: Number(height) || 0 })
      return {}
    })
  } else if (channel === 'orb:theme-get') {
    ipcMain.handle(channel, () => ({ ok: true, mode: 'dark', dark: true }))
  } else if (channel === 'orb:theme-set') {
    ipcMain.handle(channel, (_event, mode) => {
      themeSets.push(String(mode ?? ''))
      return { ok: true, mode: String(mode ?? ''), dark: mode === 'dark' }
    })
  } else if (channel === 'orb:api-config-get') {
    ipcMain.handle(channel, () => Object.assign({}, API_SNAPSHOT))
  } else if (channel === 'orb:api-config-set') {
    // ★ 用户 m02698 第 4 条：API 页新增的「思考 / 上下文窗口上限」必须**真的走到主进程**，
    //   所以这里要把 patch 收下来（S27 断言它只带动过的那两项）。
    ipcMain.handle(channel, (_event, patch) => {
      apiPatches.push(patch ?? null)
      return { ok: true, backup: join(ROOT, 'logs', 'api-config-backup', 'probe.json.bak'), data: Object.assign({}, API_SNAPSHOT, patch ?? {}) }
    })
  } else if (channel === 'orb:bg-get') {
    ipcMain.handle(channel, () => BG_SNAPSHOT)
  } else if (channel === 'orb:bg-update') {
    ipcMain.handle(channel, (_event, patch) => {
      bgUpdates.push(patch ?? null)
      return Object.assign({ ok: true }, BG_SNAPSHOT)
    })
  } else if (channel === 'orb:bg-clear') {
    ipcMain.handle(channel, (_event, slot) => {
      bgClears.push(String(slot ?? ''))
      return Object.assign({ ok: true }, BG_SNAPSHOT)
    })
  } else if (channel === 'orb:bg-import') {
    // ★ 绝不能让真对话框弹出来（会挂住探针）：这里一律当「用户取消」。
    ipcMain.handle(channel, () => ({ ok: false, canceled: true }))
  } else if (channel === 'orb:bili-history') {
    ipcMain.handle(channel, () => Object.assign({}, BILI_HISTORY_SNAPSHOT))
  } else if (channel === 'orb:bili-history-clear') {
    ipcMain.handle(channel, () => ({ ok: true, removed: 2 }))
  } else if (channel === 'orb:bili-act') {
    // ★ 赞/币/藏是**真的动手**（会写进用户的 B 站账号），这一层必须证到「点了就有 IPC」。
    ipcMain.handle(channel, (_event, payload) => {
      biliActs.push(payload ?? null)
      return { ok: true, message: '已点赞' }
    })
  } else if (channel === 'orb:bili-compose') {
    // 让她现写「为什么喜欢」：探针给一段固定文案，省掉真模型调用。
    ipcMain.handle(channel, (_event, payload) => {
      biliComposes.push(payload ?? null)
      return { ok: true, reason: '探针拟的理由：这段副歌的节奏像有人在门口等你。', comment: '探针拟的评论。' }
    })
  } else if (channel === 'orb:bili-summary') {
    // 补写/重写「概览」：主进程那边是 LLM 写的，这里给一份固定文案。
    ipcMain.handle(channel, (_event, payload) => {
      biliSummaries.push(payload ?? null)
      return { ok: true, summary: '探针拟的概览（重写）。' }
    })
  } else if (channel === 'orb:bili-note-save') {
    ipcMain.handle(channel, (_event, payload) => {
      biliNoteSaves.push(payload ?? null)
      return { ok: true }
    })
  } else if (channel === 'orb:bili-comment-send') {
    ipcMain.handle(channel, (_event, payload) => {
      biliComments.push(payload ?? null)
      return { ok: true }
    })
  } else {
    ipcMain.handle(channel, () => ({}))
  }
  ipcMain.on(channel, () => {})
}
ipcMain.on('orb:ring-open', (_event, x, y, items) => {
  ringOpens.push({ x, y, items })
})
// 「看过的视频」点一行会走这条（渲染层 → preload.openExternal）。
ipcMain.on('orb:open-external', (_event, url) => {
  externals.push(String(url ?? ''))
})
out(`# 已给 ${CHANNELS.length} 条 orb:* 通道挂哑处理器：${CHANNELS.join(' ')}`)
out('')

/* ── 渲染层控制台 / 崩溃收集（同一套收集器喂正向页与反向页）───────────── */
const uncaught = []
const noise = []
const consoleLines = []
/** 只放「探针环境自身的噪声」：真起窗口层才会有的通道缺失告警（本探针已全挂哑处理器）。 */
const NOISE = [/No handler registered for/i]

function attach(win, label) {
  win.webContents.on('console-message', (...args) => {
    // Electron 44 传单个 details 对象；旧版是 (event, level, message, line, sourceId)。
    const first = args[0]
    const details = first && typeof first === 'object' && ('message' in first || 'level' in first) ? first : null
    const rawLevel = details ? details.level : args[1]
    const message = String((details ? details.message : args[2]) ?? '')
    const line = details ? details.lineNumber : args[3]
    const source = String((details ? details.sourceId : args[4]) ?? '')
    const level =
      typeof rawLevel === 'string'
        ? rawLevel
        : ({ 0: 'verbose', 1: 'info', 2: 'warning', 3: 'error' }[rawLevel] ?? String(rawLevel))
    const rec = `[${label}] ${level}: ${message}  (${source}:${line})`
    consoleLines.push(rec)
    const looksError =
      level === 'error' ||
      /Uncaught|ReferenceError|TypeError|SyntaxError|is not defined|Cannot access|Failed to fetch dynamically imported module|ERR_FILE_NOT_FOUND|ERR_FAILED/i.test(
        message,
      )
    if (!looksError) return
    if (NOISE.some((re) => re.test(message))) {
      noise.push(rec)
      return
    }
    uncaught.push(rec)
  })
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    uncaught.push(`[${label}] did-fail-load ${code} ${description} ${url}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    uncaught.push(`[${label}] render-process-gone ${details && details.reason}`)
  })
}

/** 建窗参数照抄产品（helper/lib/main.js:1717-1720 那一套）。 */
async function loadPage(file, label, { show = false, preload = PRELOAD } = {}) {
  const win = new BrowserWindow({
    width: 304,
    height: 344,
    x: 80,
    y: 80,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  attach(win, label)
  await win.loadFile(file)
  if (show) {
    // 真显示窗口（几乎透明）才收得到 sendInputEvent；showInactive 不抢用户焦点。
    win.setOpacity(0.05)
    win.showInactive()
  }
  return win
}

async function clickAt(win, point, button) {
  win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button, clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button, clickCount: 1 })
}

const watchdog = setTimeout(() => {
  out('')
  out('FATAL 内部超时（90s）被迫退出 —— 透明窗口上 Electron 卡住时就是这样')
  for (const line of consoleLines.slice(-20)) out(`#   ${line}`)
  app.exit(3)
}, 90_000)
if (typeof watchdog.unref === 'function') watchdog.unref()

app
  .whenReady()
  .then(async () => {
    /* ── 正向：真渲染层 ──────────────────────────────────────────────── */
    const win = await loadPage(PAGE, 'shell', { show: true })
    await sleep(1600)

    const boot = await win.webContents.executeJavaScript(
      `({
         ball: Boolean(document.querySelector('#ball')),
         ready: document.documentElement.dataset.shellReady || '',
         cls: document.body.className,
         lang: document.documentElement.lang || '',
       })`,
    )
    check('S1 floating.html 加载成功且 #ball 在', boot.ball === true, JSON.stringify(boot))
    check('S3 dataset.shellReady === "1"（main() 走完了）', boot.ready === '1', `shellReady=${JSON.stringify(boot.ready)}`)
    check(
      'S4 控制台出现 [shell] main() 装配完成',
      consoleLines.some((line) => line.includes('main() 装配完成')),
      consoleLines.length ? `控制台只有 ${consoleLines.length} 行：${consoleLines.slice(0, 6).join(' | ')}` : '控制台一行都没有',
    )

    /* ── S6 真实右键球体 → 必须走到 orb:ring-open ────────────────────── */
    let ballBox = null
    try {
      ballBox = await win.webContents.executeJavaScript(
        `(() => {
           const el = document.querySelector('#ball')
           if (!el) return null
           const r = el.getBoundingClientRect()
           return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
         })()`,
      )
    } catch (error) {
      ballBox = null
      out(`# 取球心坐标失败：${error && error.message}`)
    }
    if (!ballBox) {
      skip('S6 右键球体 → orb:ring-open', '拿不到 #ball 的坐标')
      skip('S7 左键点球 → body.expanded', '拿不到 #ball 的坐标')
    } else {
      ringOpens.length = 0
      await clickAt(win, ballBox, 'right')
      await sleep(700)
      const items = ringOpens.length > 0 ? ringOpens[0].items : null
      check(
        'S6 右键球体 → 主进程收到 orb:ring-open 且菜单项非空',
        ringOpens.length > 0 && Array.isArray(items) && items.length > 0,
        `收到 ${ringOpens.length} 次；items=${JSON.stringify(items)}`
          + (ringOpens.length === 0 && uncaught.length ? `；同时有 uncaught：${uncaught[0]}` : ''),
      )

      /* ── S7 真实左键点球 → 面板真的展开 ──────────────────────────────── */
      await clickAt(win, ballBox, 'left')
      await sleep(900)
      const after = await win.webContents.executeJavaScript(
        `({ cls: document.body.className, panelHidden: document.querySelector('#panel') ? document.querySelector('#panel').hidden : null })`,
      )
      check(
        'S7 左键点球 → body 出现 expanded（左键链真的通了）',
        /(^|\s)expanded(\s|$)/.test(String(after.cls)),
        `body.className=${JSON.stringify(after.cls)} panel.hidden=${after.panelHidden}`,
      )

      /* ══ 2026-10-08 用户 m01764：左键「钉住」+ 拖边缘缩放 两条回归 ══════
       * 症状：面板能开，但①不再是「点一下钉住」②拖边缘放大缩小的手感消失。
       * 根因是同一个：`togglePanel()` 里的 `pinned = true` 被上一轮删掉了，
       * 于是 `scheduleCollapse()`（闸门 `if (pinned || …) return`）不再被挡住，
       * 指针离开窗口 180ms 面板就自己收 —— 用户伸手去拖那圈手柄时面板先没了。 */

      /* ── S8 钉住回来了：左键点球 → body.pinned ─────────────────────────── */
      check(
        'S8 左键点球 → body 出现 pinned（「点一下钉住」回来了）',
        /(^|\s)pinned(\s|$)/.test(String(after.cls)),
        `body.className=${JSON.stringify(after.cls)} —— 缺 pinned 则面板 180ms 后被 scheduleCollapse 收掉`,
      )

      /* ── S9 展开态的两条自由边手柄必须可见且有真实尺寸 ─────────────────── */
      const handleState = await win.webContents.executeJavaScript(
        `(() => {
           const h = document.body.classList.contains('expand-right') ? 'e' : 'w'
           const v = document.body.classList.contains('expand-down') ? 's' : 'n'
           const shown = [...document.querySelectorAll('.resize-handle')]
             .filter((el) => el.style.display !== 'none')
             .map((el) => {
               const r = el.getBoundingClientRect()
               return {
                 dir: el.dataset.dir,
                 x: Math.round(r.left), y: Math.round(r.top),
                 w: Math.round(r.width), h: Math.round(r.height),
               }
             })
           const panel = document.getElementById('panel')
           const pr = panel ? panel.getBoundingClientRect() : null
           return {
             dir: [h, v].sort().join(','),
             shown,
             chrome: getComputedStyle(document.documentElement).getPropertyValue('--chrome').trim(),
             panel: pr ? { x: Math.round(pr.left), y: Math.round(pr.top), w: Math.round(pr.width), h: Math.round(pr.height) } : null,
           }
         })()`,
      )
      check(
        'S9 展开态：恰好两条自由边手柄可见，且尺寸非零',
        handleState.shown.length === 2
          && handleState.shown.map((h) => h.dir).sort().join(',') === handleState.dir
          && handleState.shown.every((h) => h.w > 0 && h.h > 0),
        `期望 ${handleState.dir}；实际 ${JSON.stringify(handleState.shown)}`,
      )

      /* ── S9b 手柄必须贴着**面板可见边界**（不是窗口外缘）─────────────────
       * 这正是用户「拖边缘没反应」的机制：旧版边条摆在窗口 0..6px，
       * 面板边界在 var(--chrome)=12px，整条命中区跟面板边界零重叠。 */
      const panelBox = handleState.panel
      const edgeAligned =
        panelBox !== null
        && handleState.shown.every((h) => {
          if (h.dir === 'n') return Math.abs(h.y + h.h - panelBox.y) <= 1
          if (h.dir === 's') return Math.abs(h.y - (panelBox.y + panelBox.h)) <= 1
          if (h.dir === 'w') return Math.abs(h.x + h.w - panelBox.x) <= 1
          if (h.dir === 'e') return Math.abs(h.x - (panelBox.x + panelBox.w)) <= 1
          return false
        })
      check(
        'S9b 手柄贴面板可见边界（--chrome 那圈不再把命中区推离面板）',
        edgeAligned,
        `chrome=${handleState.chrome} 面板=${JSON.stringify(panelBox)} 手柄=${JSON.stringify(handleState.shown)}`,
      )

      /* ── S10 真拖手柄 → 必须走到 orb:resize ─────────────────────────────── */
      const horizontalHandle = handleState.shown.find((h) => h.dir === 'w' || h.dir === 'e')
      if (!horizontalHandle || !panelBox) {
        skip('S10 真拖手柄 → orb:resize', '没有可见的水平边手柄 / 拿不到面板尺寸')
        skip('S13 反向对照：收起态拖手柄不产生 orb:resize', '同上')
      } else {
        const outward = horizontalHandle.dir === 'w' ? -1 : 1
        const dragPx = 60
        const startX = Math.round(horizontalHandle.x + horizontalHandle.w / 2)
        const startY = Math.round(horizontalHandle.y + horizontalHandle.h / 2)
        resizes.length = 0
        win.webContents.sendInputEvent({ type: 'mouseDown', x: startX, y: startY, button: 'left', clickCount: 1 })
        for (let step = 1; step <= 6; step += 1) {
          win.webContents.sendInputEvent({
            type: 'mouseMove',
            x: startX + Math.round((outward * dragPx * step) / 6),
            y: startY,
          })
        }
        win.webContents.sendInputEvent({
          type: 'mouseUp',
          x: startX + outward * dragPx,
          y: startY,
          button: 'left',
          clickCount: 1,
        })
        await sleep(600)
        const got = resizes[0]
        check(
          'S10 真拖手柄 → 主进程收到 orb:resize，宽度按拖拽方向变化、高度不变',
          Boolean(got)
            && Math.abs(got.width - (panelBox.w + dragPx)) <= 2
            && Math.abs(got.height - panelBox.h) <= 2,
          `收到 ${resizes.length} 次；${JSON.stringify(got)}；期望 ${panelBox.w + dragPx}×${panelBox.h}`,
        )
      }

      /* ── S11 钉住挡住自动收起（＝「能从容伸手去拖边缘」的前提）────────── */
      await win.webContents.executeJavaScript(
        `document.body.dispatchEvent(new PointerEvent('pointerleave'))`,
      )
      await sleep(500)
      const afterLeave = await win.webContents.executeJavaScript(
        `({ cls: document.body.className, panelHidden: document.getElementById('panel').hidden })`,
      )
      check(
        'S11 钉住时指针离开窗口 500ms 面板仍在（未钉住 180ms 就自己收了）',
        /(^|\s)expanded(\s|$)/.test(String(afterLeave.cls)) && afterLeave.panelHidden === false,
        `body.className=${JSON.stringify(afterLeave.cls)} panel.hidden=${afterLeave.panelHidden}`,
      )

      /* ── S12 反向对照：再点一次球 → 取消钉住并收起 ──────────────────────
       * 点之前必须**重新读球心**：面板展开后窗口变大，球在窗口内的坐标变了。 */
      const ballBoxAgain = await win.webContents.executeJavaScript(
        `(() => {
           const el = document.querySelector('#ball')
           if (!el) return null
           const r = el.getBoundingClientRect()
           return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
         })()`,
      )
      if (!ballBoxAgain) {
        skip('S12 再点一次球 → 取消钉住并收起', '拿不到 #ball 的坐标')
      } else {
        await clickAt(win, ballBoxAgain, 'left')
        await sleep(800)
        const afterClose = await win.webContents.executeJavaScript(
          `({
             cls: document.body.className,
             shown: [...document.querySelectorAll('.resize-handle')].filter((el) => el.style.display !== 'none').length,
           })`,
        )
        check(
          'S12 再点一次球 → 取消钉住并收起，手柄全部 display:none（反向对照：S11 不是恒真）',
          !/(^|\s)pinned(\s|$)/.test(String(afterClose.cls))
            && !/(^|\s)expanded(\s|$)/.test(String(afterClose.cls))
            && afterClose.shown === 0,
          `body.className=${JSON.stringify(afterClose.cls)} 可见手柄=${afterClose.shown}`,
        )
      }

      /* ── S13 反向对照：收起态拖同一条边不再产生 orb:resize ────────────── */
      if (horizontalHandle) {
        resizes.length = 0
        const x = Math.round(horizontalHandle.x + horizontalHandle.w / 2)
        const y = Math.round(horizontalHandle.y + horizontalHandle.h / 2)
        const outward = horizontalHandle.dir === 'w' ? -1 : 1
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        win.webContents.sendInputEvent({ type: 'mouseMove', x: x + outward * 60, y })
        win.webContents.sendInputEvent({ type: 'mouseUp', x: x + outward * 60, y, button: 'left', clickCount: 1 })
        await sleep(400)
        check(
          'S13 反向对照：收起态拖手柄不产生 orb:resize（S10 的 IPC 确实来自手柄链）',
          resizes.length === 0,
          `收到 ${resizes.length} 次：${JSON.stringify(resizes[0])}`,
        )
      }
    }

    /* ══ 2026-10-08 用户 m02033：主题页（黑白三态 + 三个页面各自一张背景）═══
     * 用户原话：「分为 3 个使用背景，1，对话页背景，2，历史对话背景
     * 3，我们的回忆背景。这三个背景随功能切换加载……环形菜单中需要额外加入
     * 一个主题菜单，其不仅提供了黑白两色的主题切换，还支持自定义分别导入
     * 前文三个页面的背景。」
     *
     * 所以要证的是三件事（缺一条都不算做对）：
     *   ① 背景层存在且**按当前视图**显隐（z-index:-1 画在面板玻璃之上、内容之下）；
     *   ② 三个视图切换时 data-view 真的变，且「没设图的那一槽不叠蒙层」
     *      （否则空面板会被蒙层染灰 —— 这是最容易做错的边界）；
     *   ③ 环菜单的「主题」项能打开主题抽屉，三态按钮与适配按钮真把意图
     *      发到主进程（`orb:theme-set` / `orb:bg-update` / `orb:bg-clear`）。
     */
    const bgState = await win.webContents.executeJavaScript(
      `(() => {
         const layer = (slot) => document.querySelector('.bg-layer[data-slot="' + slot + '"]')
         const cs = (el) => (el ? getComputedStyle(el) : null)
         const chat = layer('chat')
         const history = layer('history')
         const scrim = document.querySelector('#bg-scrim')
         const stack = document.getElementById('bg-stack')
         return {
           view: document.getElementById('panel').dataset.view || '',
           chatImage: cs(chat) ? cs(chat).backgroundImage : '',
           chatSize: cs(chat) ? cs(chat).backgroundSize : '',
           chatOpacity: cs(chat) ? cs(chat).opacity : '',
           historyImage: cs(history) ? cs(history).backgroundImage : '',
           scrim: scrim ? scrim.style.opacity : null,
           stackZ: cs(stack) ? cs(stack).zIndex : '',
         }
       })()`,
    )
    /* ★ 毛玻璃的口径 2026-10-22 换了（用户：「只对对话框/输入框/菜单框架生效，
     *   不对对话背景遮罩」）：
     *     · 必须是 `#panel { backdrop-filter: … }` —— 框架这层玻璃；
     *     · `.bg-layer` **不许**自己 `filter: blur()` —— 那是把背景糊成雾，正好搞反。
     *   前提是 `#bg-stack` 已搬到 `#panel` 外面（见 S14 的 z-index 断言）。
     *
     *   ★ 血泪史（别再改反）：母本原版有 ①，我曾误判它会把透明窗口合成成直角方块
     *     而把毛玻璃全删了 ⇒ 用户报「排版乱」；随后又按错处方给 `.bg-layer` 加了 blur
     *     ⇒ 背景糊、框架不糊。真正的问题一直是**层叠顺序**，不是 backdrop-filter。 */
    const floatCss = readFileSync(join(ROOT, 'helper', 'assets', 'floating.css'), 'utf8')
    const floatLive = floatCss.replace(/\/\*[\s\S]*?\*\//g, '')
    check('S14b 毛玻璃只糊框架：面板有 backdrop-filter，且 .bg-layer 自己不许 blur',
      /#panel\s*\{[^}]*?backdrop-filter:/.test(floatLive)
      && !/\.bg-layer\s*\{[^}]*?filter:\s*blur\(/.test(floatLive),
      '要么面板没玻璃，要么又把背景自己糊了（两者都不对）')
    check(
      'S14 背景层：默认视图 chat、chat 槽按 cover 铺满、未设图的槽为空、蒙层 0.55、整层 z-index:0（面板之上）',
      bgState.view === 'chat'
        && bgState.chatImage.includes('bg-chat-')
        && bgState.chatSize === 'cover'
        && bgState.chatOpacity === '1'
        && bgState.historyImage === 'none'
        && bgState.scrim === '0.55'
        && bgState.stackZ === '0',
      JSON.stringify(bgState),
    )

    /* ── S15 切到历史抽屉 → 视图变 history，且没设图 ⇒ 蒙层必须归零 ───────── */
    win.webContents.send('orb:ring-action', 'history')
    await sleep(700)
    const historyView = await win.webContents.executeJavaScript(
      `(() => {
         const layer = (slot) => document.querySelector('.bg-layer[data-slot="' + slot + '"]')
         const cs = (el) => (el ? getComputedStyle(el) : null)
         return {
           view: document.getElementById('panel').dataset.view || '',
           chatOpacity: cs(layer('chat')) ? cs(layer('chat')).opacity : '',
           historyOpacity: cs(layer('history')) ? cs(layer('history')).opacity : '',
           scrim: document.querySelector('#bg-scrim').style.opacity,
           listHidden: document.getElementById('history-list').hidden,
         }
       })()`,
    )
    check(
      'S15 切到历史对话 → data-view=history、chat 槽淡出、scrim 归零（未设图的槽不叠蒙层）',
      historyView.view === 'history'
        && historyView.listHidden === false
        && historyView.chatOpacity === '0'
        && historyView.historyOpacity === '1'
        && historyView.scrim === '0',
      JSON.stringify(historyView),
    )

    /* ── S16 切到「我们的回忆」→ 视图变 recall，recall 槽按它自己的 fit/scrim ── */
    win.webContents.send('orb:ring-action', 'impression')
    await sleep(700)
    const recallView = await win.webContents.executeJavaScript(
      `(() => {
         const layer = document.querySelector('.bg-layer[data-slot="recall"]')
         const cs = getComputedStyle(layer)
         return {
           view: document.getElementById('panel').dataset.view || '',
           image: cs.backgroundImage,
           size: cs.backgroundSize,
           opacity: cs.opacity,
           scrim: document.querySelector('#bg-scrim').style.opacity,
         }
       })()`,
    )
    check(
      'S16 切到「我们的回忆」→ data-view=recall、recall 槽按自己的 fit=contain / scrim=0.8 上屏',
      recallView.view === 'recall'
        && recallView.image.includes('bg-recall-')
        && recallView.size === 'contain'
        && recallView.opacity === '1'
        && recallView.scrim === '0.8',
      JSON.stringify(recallView),
    )

    /* ── S17 环菜单「主题」项 → 主题抽屉真的打开，并让出别的抽屉 ─────────── */
    win.webContents.send('orb:ring-action', 'theme')
    await sleep(800)
    const themeOpen = await win.webContents.executeJavaScript(
      `(() => {
         const root = document.getElementById('theme')
         const card = (slot) => document.querySelector('.theme-slot[data-slot="' + slot + '"]')
         const preview = card('chat') ? card('chat').querySelector('.theme-slot-preview') : null
         return {
           hidden: root ? root.hidden : null,
           cls: document.body.className,
           transcriptHidden: document.getElementById('transcript').hidden,
           modes: [...document.querySelectorAll('#theme-mode > button')].map((b) => b.dataset.mode),
           checked: [...document.querySelectorAll('#theme-mode > button')].filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.dataset.mode),
           slots: [...document.querySelectorAll('#theme-bg-list .theme-slot')].map((el) => ({
             slot: el.dataset.slot,
             file: (el.querySelector('.theme-slot-file') || {}).textContent || '',
             hasImage: el.querySelector('.theme-slot-preview').classList.contains('has-image'),
           })),
           previewImage: preview ? getComputedStyle(preview).backgroundImage : '',
           impressionHidden: document.getElementById('impression').hidden,
         }
       })()`,
    )
    check(
      'S17 环菜单「主题」项 → #theme 打开、body.theme-open、对话流让开、回忆页被关掉',
      themeOpen.hidden === false
        && /(^|\s)theme-open(\s|$)/.test(String(themeOpen.cls))
        && themeOpen.transcriptHidden === true
        && themeOpen.impressionHidden === true,
      JSON.stringify({ hidden: themeOpen.hidden, cls: themeOpen.cls, transcriptHidden: themeOpen.transcriptHidden, impressionHidden: themeOpen.impressionHidden }),
    )
    check(
      'S18 主题页三态按钮 = auto/light/dark（当前 dark 选中）＋ 三张槽卡带文件名/预览',
      themeOpen.modes.join(',') === 'auto,light,dark'
        && themeOpen.checked.join(',') === 'dark'
        && themeOpen.slots.length === 3
        && themeOpen.slots.map((s) => s.slot).join(',') === 'chat,history,recall'
        && themeOpen.slots[0].file.includes('bg-chat-')
        && themeOpen.slots[0].hasImage === true
        && themeOpen.slots[1].hasImage === false
        && themeOpen.previewImage.includes('bg-chat-'),
      JSON.stringify(themeOpen.slots),
    )

    /* ── S19 点「浅色」→ 必须真的发出 orb:theme-set('light') ─────────────── */
    themeSets.length = 0
    await win.webContents.executeJavaScript(
      `document.querySelector('#theme-mode > button[data-mode="light"]').click()`,
    )
    await sleep(400)
    check(
      'S19 点主题页「浅色」→ 主进程收到 orb:theme-set("light")（真 IPC，不是本地开关）',
      themeSets.includes('light'),
      `收到 ${JSON.stringify(themeSets)}`,
    )

    /* ── S20 改适配方式 → orb:bg-update；清除 → orb:bg-clear ─────────────── */
    bgUpdates.length = 0
    await win.webContents.executeJavaScript(
      `document.querySelector('.theme-slot[data-slot="chat"] .theme-slot-fit > button[data-fit="contain"]').click()`,
    )
    await sleep(400)
    const fitPatch = bgUpdates[0]
    check(
      'S20 点 chat 槽「完整」→ 主进程收到 orb:bg-update({slot:"chat",fit:"contain"})',
      Boolean(fitPatch) && fitPatch.slot === 'chat' && fitPatch.fit === 'contain',
      `收到 ${JSON.stringify(bgUpdates)}`,
    )

    bgClears.length = 0
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.theme-slot[data-slot="chat"] .theme-slot-actions > button')].pop().click()`,
    )
    await sleep(400)
    check(
      'S21 点 chat 槽「清除」→ 主进程收到 orb:bg-clear("chat")',
      bgClears.includes('chat'),
      `收到 ${JSON.stringify(bgClears)}`,
    )

    /* ── S22 反向对照：再开 API 配置 → 主题抽屉必须自己让开（互斥是双向的）── */
    win.webContents.send('orb:ring-action', 'api-config')
    await sleep(700)
    const exclusive = await win.webContents.executeJavaScript(
      `({
         themeHidden: document.getElementById('theme').hidden,
         apiHidden: document.getElementById('api-config').hidden,
         themeOpenCls: /(^|\\s)theme-open(\\s|$)/.test(document.body.className),
         apiOpenCls: /(^|\\s)api-config-open(\\s|$)/.test(document.body.className),
       })`,
    )
    check(
      'S22 反向对照：开 API 配置 → 主题抽屉关闭（theme-open 类撤掉，api-config-open 顶上）',
      exclusive.themeHidden === true
        && exclusive.apiHidden === false
        && exclusive.themeOpenCls === false
        && exclusive.apiOpenCls === true,
      JSON.stringify(exclusive),
    )

    /* ── S26 用户 m02698 第 4 条：API 页的「思考档位 / 上下文窗口上限」────────
     * 证的是这两项真的长在面板上、文案来自 shell.js 的双语表（html 里不许有中文字面量）、
     * 上限输入框的禁用/提示跟着主进程快照走。
     * ★ 2026-10-21 校准：10-19 改版后控件从 `#api-thinking`（off/on 两档）
     *   变成 `#api-effort`（off/minimal/…/max 八档），标签 id 也从
     *   `api-thinking-label` 变成 `api-effort-label`。断言跟着现在的契约走。
     */
    const apiFields = await win.webContents.executeJavaScript(
      `(() => {
         const sel = document.getElementById('api-effort')
         const limit = document.getElementById('api-context-limit')
         const label = (id) => { const el = document.getElementById(id); return el ? el.textContent.trim() : '' }
         return {
           hidden: document.getElementById('api-config').hidden,
           selectTag: sel ? sel.tagName : '',
           options: sel ? [...sel.options].map((o) => o.value + '=' + o.textContent.trim()) : [],
           value: sel ? sel.value : '',
           limitValue: limit ? limit.value : '',
           limitPlaceholder: limit ? limit.placeholder.trim() : '',
           limitDisabled: limit ? limit.disabled : null,
           labelThinking: label('api-effort-label'),
           labelLimit: label('api-context-limit-label'),
           status: label('api-config-status'),
         }
       })()`,
    )
    check(
      'S26 API 页两个字段：思考档位（8 档，off 与 max 都在，文案由双语表写）与压缩阈值（有标签与占位提示、可编辑）',
      apiFields.hidden === false
        && apiFields.selectTag === 'SELECT'
        && apiFields.options.length >= 2
        && apiFields.options.some((o) => /^off=.+/.test(o))
        && apiFields.options.some((o) => /^max=.+/.test(o))
        && apiFields.options.every((o) => !/^[a-z]+=$/.test(o))  // 每一档都得有译文，不能是空标签
        && apiFields.limitDisabled === false
        && apiFields.limitPlaceholder.length > 0
        && apiFields.labelThinking.length > 0
        && apiFields.labelLimit.length > 0,
      JSON.stringify(apiFields),
    )

    /* ── S27 改这两项 → 点保存 → 主进程收到 orb:api-config-set（真 IPC）────── */
    apiPatches.length = 0
    await win.webContents.executeJavaScript(
      `(() => {
         const sel = document.getElementById('api-effort')
         sel.value = 'high'
         sel.dispatchEvent(new Event('change', { bubbles: true }))
         const limit = document.getElementById('api-context-limit')
         limit.value = '200000'
         limit.dispatchEvent(new Event('input', { bubbles: true }))
         document.getElementById('api-config-save').click()
       })()`,
    )
    await sleep(700)
    const apiPatch = apiPatches[0] ?? null
    check(
      'S27 点保存 → 主进程收到 orb:api-config-set{reasoningEffort:"high", contextBudgetTokens:200000}，且**没动过**的 model/baseUrl/apiKey 一律不在 patch 里（反向对照）',
      Boolean(apiPatch)
        && apiPatch.reasoningEffort === 'high'
        && apiPatch.contextBudgetTokens === 200000
        && apiPatch.model === undefined
        && apiPatch.baseUrl === undefined
        && apiPatch.apiKey === undefined,
      JSON.stringify(apiPatches),
    )

    /* ══ 2026-10-21：环菜单「看过的视频」抽屉（当夜按用户意见重排成上下两块）══
     * 用户原话：「它太空了。上半部分实际上是一片完全的空白…… 分为两个部分，
     *   上半部分显示为"我喜欢的"，下半部分为"我看过的"，每个板块分别展示最近的两个
     *   视频，每个板块都支持下拉菜单…… 每个视频下方预留一个点赞、投币、收藏的菜单」
     * 要证六件事：
     *   ① 环菜单点它真的开抽屉，并把上一页（此时开着的设置）关掉；
     *   ② 两块都在，各自按快照画出来，且**每条只有最近 2 个**在外面（更早的收进下拉）；
     *   ③ 「我看过的」一行点下去真的去 B 站（preload.openExternal，不是本地假装）；
     *   ④ 「赞」不是本地假开关：点了真有 orb:bili-act 到主进程（会写进用户账号）；
     *   ⑤ 「我喜欢的」一行点下去开二级面板：理由 + 她拟的评论；
     *   ⑥ 评论**用户点头才发**：确认框按「取消」就一条都不发（反向对照）。
     */
    win.webContents.send('orb:ring-action', 'bili-history')
    await sleep(900)
    const biliPanel = await win.webContents.executeJavaScript(
      `(() => {
         const cell = (row, sel) => { const el = row ? row.querySelector(sel) : null; return el ? el.textContent.trim() : '' }
         const rowsOf = (id) => [...document.querySelectorAll('#' + id + ' .bili-row')].map((r) => ({
           title: cell(r, '.bili-row-title'),
           summary: cell(r, '.bili-row-summary'),
           summaryEmpty: !!r.querySelector('.bili-row-summary.is-empty'),
           when: cell(r, '.bili-row-when'),
           hint: cell(r, '.bili-row-hint'),
           /* ★ 用户 2026-10-21 深夜点名删掉的东西：这两行技术信息不许再出现 */
           oldMeta: cell(r, '.bili-row-meta'),
           oldTimes: cell(r, '.bili-row-times'),
           chips: [...r.querySelectorAll('.bili-chip')].map((c) => ({ t: c.textContent.trim(), done: c.classList.contains('is-done') })),
           bvid: r.dataset.bvid,
         }))
         const el = (id) => document.getElementById(id)
         const titleEl = el('bili-liked-title')
         return {
           hidden: el('bili-history').hidden,
           cls: document.body.className,
           transcriptHidden: el('transcript').hidden,
           apiConfigHidden: el('api-config').hidden,
           impressionHidden: el('impression').hidden,
           /* ★ 顶部大标题与「共 N 条…」那行已被用户判为多余、要求删除 */
           hasTopTitle: !!el('bili-history-title'),
           hasMetaLine: !!el('bili-history-meta'),
           close: el('bili-history-close').textContent.trim(),
           closeLabel: el('bili-history-close').getAttribute('aria-label') || '',
           likedTitle: el('bili-liked-title').textContent.trim(),
           watchedTitle: el('bili-watched-title').textContent.trim(),
           /* 两个板块标题要用原来那个大标题的格式（17px / 700） */
           titleFontSize: titleEl ? getComputedStyle(titleEl).fontSize : '',
           titleWeight: titleEl ? getComputedStyle(titleEl).fontWeight : '',
           likedEmptyHidden: el('bili-liked-empty').hidden,
           watchedEmptyHidden: el('bili-watched-empty').hidden,
           liked: rowsOf('bili-liked-list'),
           watched: rowsOf('bili-watched-list'),
           likedMoreHidden: el('bili-liked-more').hidden,
           watchedMoreHidden: el('bili-watched-more').hidden,
           noteHidden: el('bili-note').hidden,
           blocksHidden: [...document.querySelectorAll('#bili-history .bili-block')].map((b) => b.hidden),
         }
       })()`,
    )
    check(
      'S28 环菜单「看过的视频」→ 抽屉打开、对话流让开、设置抽屉被关；**顶部大标题与「共 N 条…」那行已删**（用户 2026-10-21 深夜判为多余）',
      biliPanel.hidden === false
        && /(^|\s)bili-history-open(\s|$)/.test(String(biliPanel.cls))
        && biliPanel.transcriptHidden === true
        && biliPanel.apiConfigHidden === true
        && biliPanel.impressionHidden === true
        && biliPanel.hasTopTitle === false
        && biliPanel.hasMetaLine === false
        && biliPanel.close === '×'
        && biliPanel.closeLabel.length > 0
        && biliPanel.noteHidden === true
        && biliPanel.blocksHidden.every((h) => h === false),
      JSON.stringify({ hidden: biliPanel.hidden, cls: biliPanel.cls, apiConfigHidden: biliPanel.apiConfigHidden, hasTopTitle: biliPanel.hasTopTitle, hasMetaLine: biliPanel.hasMetaLine, blocksHidden: biliPanel.blocksHidden }),
    )
    check(
      'S29 上下两块：两个板块标题都用**原来那个大标题的格式**（17px/700）；上「我喜欢的」按 liked 账本画（带点开提示、赞过的显已完成态）、下「我看过的」两条都在',
      biliPanel.likedTitle.length > 0
        && biliPanel.watchedTitle.length > 0
        && biliPanel.likedTitle !== biliPanel.watchedTitle
        && parseFloat(biliPanel.titleFontSize) >= 16
        && Number(biliPanel.titleWeight) >= 600
        && biliPanel.likedEmptyHidden === true
        && biliPanel.watchedEmptyHidden === true
        && biliPanel.liked.length === 1
        && biliPanel.liked[0].title.includes('Never Gonna')
        && biliPanel.liked[0].hint.length > 0
        && biliPanel.liked[0].chips.length === 3
        && biliPanel.liked[0].chips[0].done === true      // 赞过 → 已完成态
        && biliPanel.liked[0].chips[1].done === true      // 投过币
        && biliPanel.liked[0].chips[2].done === false
        && biliPanel.watched.length === 2
        && biliPanel.watched[0].bvid === 'BV1GJ411x7h7'
        && biliPanel.watched[1].bvid === 'BV1xx411c7mD'
        && biliPanel.watched[0].chips.length === 3
        && biliPanel.watched[0].chips[0].done === false,
      JSON.stringify({ likedTitle: biliPanel.likedTitle, watchedTitle: biliPanel.watchedTitle, font: biliPanel.titleFontSize + '/' + biliPanel.titleWeight, liked: biliPanel.liked, watched: biliPanel.watched }),
    )
    check(
      'S30 每条只有「标题 + 概览」；画质/次数/帧时间点那几行**不许再出现**；观看时间与时长在 .bili-row-when 里；没画面的那条退回「只看了元信息」占位',
      biliPanel.watched[0].title.includes('Never Gonna')
        && biliPanel.watched[0].summary.includes('复古 MV')
        && biliPanel.watched[0].summaryEmpty === false
        && biliPanel.watched[0].oldMeta === ''
        && biliPanel.watched[0].oldTimes === ''
        && biliPanel.watched[0].when.includes('今天 20:11')
        && biliPanel.watched[0].when.includes('3:33')
        && biliPanel.watched[1].summary.length > 0
        && biliPanel.watched[1].summaryEmpty === true
        && biliPanel.watched[1].summary.includes('元信息')
        && biliPanel.liked[0].summary.includes('复古 MV')
        && biliPanel.likedMoreHidden === true
        && biliPanel.watchedMoreHidden === true,
      JSON.stringify({ watched: biliPanel.watched, liked: biliPanel.liked }),
    )

    /* ── S31 点「我看过的」一行 → 真的发 orb:open-external 到 B 站 ──────── */
    externals.length = 0
    await win.webContents.executeJavaScript(
      `document.querySelector('#bili-watched-list .bili-row .bili-row-main').click()`,
    )
    await sleep(300)
    check(
      'S31 点「我看过的」一行 → 主进程收到 orb:open-external(https://www.bilibili.com/video/BV1GJ411x7h7)',
      externals.length === 1 && /^https:\/\/www\.bilibili\.com\/video\/BV1GJ411x7h7$/.test(externals[0]),
      JSON.stringify(externals),
    )

    /* ── S32 点「赞」→ 真的发 orb:bili-act（不是本地把按钮标灰了事）─────── */
    biliActs.length = 0
    await win.webContents.executeJavaScript(
      `document.querySelector('#bili-watched-list .bili-row .bili-chip[data-chip="like"]').click()`,
    )
    await sleep(700)
    const likeAct = biliActs[0] ?? null
    check(
      'S32 点「赞」→ 主进程收到 orb:bili-act{bvid,cid,action:"like"}（真发 B 站接口，不是本地假开关）',
      Boolean(likeAct) && likeAct.bvid === 'BV1GJ411x7h7' && Number(likeAct.cid) === 137649199 && likeAct.action === 'like',
      JSON.stringify(biliActs),
    )

    /* ── S33 点「我喜欢的」一行 → 二级面板：理由 + 她拟的评论 ─────────────── */
    const noteOpen = await win.webContents.executeJavaScript(
      `(() => {
         document.querySelector('#bili-liked-list .bili-row .bili-row-main').click()
         const el = (id) => document.getElementById(id)
         return {
           noteHidden: el('bili-note').hidden,
           blocksHidden: [...document.querySelectorAll('#bili-history .bili-block')].map((b) => b.hidden),
           /* ★ 光看 .hidden 不算数：.bili-block 的 display:flex 权重比 UA 的
              [hidden]{display:none} 高得多 —— 属性是 true、元素照样在画，
              二级面板因此被顶到列表下面（截图上就是那副样子）。
              所以这里连**算出来的 display** 一起要。 */
           blocksDisplay: [...document.querySelectorAll('#bili-history .bili-block')].map((b) => getComputedStyle(b).display),
           noteDisplay: getComputedStyle(el('bili-note')).display,
           title: el('bili-note-title').textContent.trim(),
           reason: el('bili-note-reason').textContent.trim(),
           comment: el('bili-note-comment').value,
           sendLabel: el('bili-note-send').textContent.trim(),
           sendDisabled: el('bili-note-send').disabled,
           summary: el('bili-note-summary').textContent.trim(),
           summaryEmpty: el('bili-note-summary').classList.contains('is-empty'),
           summaryWriteLabel: el('bili-note-summary-write').textContent.trim(),
           openBiliLabel: el('bili-note-open-bili').textContent.trim(),
         }
       })()`,
    )
    await sleep(300)
    check(
      'S33 点「我喜欢的」一行 → 二级面板真的顶掉两块列表（算出来 display:none，不只是 hidden 属性）、能看到「喜欢的理由」和她拟好的那段话（且不会顺手把 B 站打开）',
      noteOpen.noteHidden === false
        && noteOpen.noteDisplay !== 'none'
        && noteOpen.blocksHidden.every((h) => h === true)
        && noteOpen.blocksDisplay.every((d) => d === 'none')
        && noteOpen.title.includes('Never Gonna')
        && noteOpen.summary.includes('复古 MV')
        && noteOpen.summaryEmpty === false
        && noteOpen.summaryWriteLabel.length > 0
        && noteOpen.openBiliLabel.length > 0
        && noteOpen.reason.includes('门口等你')
        && noteOpen.comment.includes('转场')
        && noteOpen.sendLabel.length > 0
        && noteOpen.sendDisabled === false
        && externals.length === 1,
      JSON.stringify({ ...noteOpen, externals: externals.length }),
    )

    /* ── S36 「让她写概览」→ 真的发 orb:bili-summary（老条目补概览的入口）── */
    biliSummaries.length = 0
    await win.webContents.executeJavaScript(
      `document.getElementById('bili-note-summary-write').click()`,
    )
    await sleep(600)
    const sumPayload = biliSummaries[0] ?? null
    check(
      'S36 点「重写概览」→ 主进程收到 orb:bili-summary{bvid,cid}（概览可以随时重写）',
      Boolean(sumPayload) && sumPayload.bvid === 'BV1GJ411x7h7' && Number(sumPayload.cid) === 137649199,
      JSON.stringify(biliSummaries),
    )

    /* ── S37 「在 B 站看原片」→ 真的发 orb:open-external（行内没有 B 站按钮了，入口在这）── */
    externals.length = 0
    await win.webContents.executeJavaScript(
      `document.getElementById('bili-note-open-bili').click()`,
    )
    await sleep(300)
    check(
      'S37 二级面板「在 B 站看原片」→ 主进程收到 orb:open-external（行里的 B 站按钮删了，入口挪到这里，不能丢）',
      externals.length === 1 && /^https:\/\/www\.bilibili\.com\/video\/BV1GJ411x7h7$/.test(externals[0]),
      JSON.stringify(externals),
    )

    /* ── S34 评论只有用户点头才发：确认框按「取消」→ 一条都不发（反向对照）──
     * 这是本轮最要紧的一条：评论会署**用户自己的账号**发在公开评论区，
     * 删不掉。所以「点了发送」不等于「发出去了」，中间必须有用户的一次明确同意。
     */
    biliComments.length = 0
    biliNoteSaves.length = 0
    const confirmAsked = await win.webContents.executeJavaScript(
      `(() => {
         const asked = []
         window.__orbProbeConfirm = (reply) => (msg) => { asked.push(String(msg)); return reply }
         window.confirm = window.__orbProbeConfirm(false)
         document.getElementById('bili-note-comment').value = '探针改过的文案：这一段我看了三遍。'
         document.getElementById('bili-note-send').click()
         return { asked: asked.length, text: asked[0] || '' }
       })()`,
    )
    await sleep(500)
    check(
      'S34 点「发送」但确认框选取消 → 弹过确认、then 一条评论都不发（公开发言必须用户点头）',
      confirmAsked.asked === 1
        && confirmAsked.text.length > 0
        && biliComments.length === 0
        && biliNoteSaves.length === 0,
      JSON.stringify({ confirmAsked, comments: biliComments.length, saves: biliNoteSaves.length }),
    )

    /* ── S35 确认框选「确定」→ 才真的发出去，且发的是用户手上那个版本 ─────── */
    await win.webContents.executeJavaScript(
      `(() => { window.confirm = window.__orbProbeConfirm(true); document.getElementById('bili-note-send').click() })()`,
    )
    await sleep(700)
    const sentComment = biliComments[0] ?? null
    const savedNote = biliNoteSaves[0] ?? null
    check(
      'S35 确认框选确定 → orb:bili-note-save 先落盘改过的文案、再 orb:bili-comment-send 真发（发的是用户手上那一版）',
      Boolean(sentComment)
        && Boolean(savedNote)
        && sentComment.text === '探针改过的文案：这一段我看了三遍。'
        && savedNote.comment === '探针改过的文案：这一段我看了三遍。'
        && sentComment.bvid === 'BV1GJ411x7h7'
        && biliComments.length === 1,
      JSON.stringify({ comments: biliComments, saves: biliNoteSaves }),
    )

    /* ── 证据截图：这个抽屉是纯视觉的，光看断言不直观 ───────────────────
     * 探针窗口只有 304×344（贴最小尺寸），而球面板默认是 320×420 ——
     * 截图前临时放大到接近实际使用的尺寸，拍完立刻还原，免得影响后面的几何断言。
     * 拍两张：① 上下两块列表；② 二级面板（理由 + 待发评论）。
     */
    try {
      // ★ 探针窗口的 body 上一直没有 expand-up/down（那是主进程按球贴屏幕哪边算的），
      //   缺了它 `#composer` 没有 top/bottom 规则，会停在 static 位置把抽屉标题压住 ——
      //   截图为了还原真机观感，临时补上 expand-down 与真实面板尺寸，拍完还原。
      await win.webContents.executeJavaScript(
        `(() => {
           window.confirm = () => false
           document.body.classList.add('expand-down')
           document.getElementById('bili-note-cancel').click()   // 先拍列表页
         })()`,
      )
      win.setContentSize(420, 620)
      await sleep(700)
      const shot1State = await win.webContents.executeJavaScript(
        `(() => {
           const sec = document.getElementById('bili-history')
           const foot = sec.querySelector('.bili-history-foot')
           const cs = getComputedStyle(sec)
           const rs = sec.getBoundingClientRect()
           const rf = foot ? foot.getBoundingClientRect() : null
           return { pad: cs.paddingTop + ' / ' + cs.paddingBottom, sec: { top: Math.round(rs.top), bottom: Math.round(rs.bottom), h: Math.round(rs.height) }, foot: rf ? { top: Math.round(rf.top), bottom: Math.round(rf.bottom) } : null, scrollH: sec.scrollHeight, clientH: sec.clientHeight }
         })()`,
      )
      out('# 列表页留白：' + JSON.stringify(shot1State))
      const shotList = await win.webContents.capturePage()
      writeFileSync(join(ROOT, 'logs', 'shot-bili-history.png'), shotList.toPNG())
      // 再点开二级面板拍第二张
      await win.webContents.executeJavaScript(
        `document.querySelector('#bili-liked-list .bili-row .bili-row-main').click()`,
      )
      await sleep(500)
      // 诊断：这一张曾经拍出一片空白 —— 把「到底哪一层被藏了」打出来，省得靠猜
      const shot2State = await win.webContents.executeJavaScript(
        `(() => {
           const el = (id) => document.getElementById(id)
           const box = (id) => { const n = el(id); if (!n) return null; const r = n.getBoundingClientRect(); return { hidden: n.hidden, w: Math.round(r.width), h: Math.round(r.height) } }
           return { history: box('bili-history'), note: box('bili-note'), transcript: box('transcript'), panel: box('panel'), view: el('panel').dataset.view, cls: document.body.className }
         })()`,
      )
      out('# 二级面板状态：' + JSON.stringify(shot2State))
      const shotNote = await win.webContents.capturePage()
      writeFileSync(join(ROOT, 'logs', 'shot-bili-note.png'), shotNote.toPNG())

      // ── 再拍一张**暗色主题**的：用户那台机器是 Windows 暗色（config.theme=dark），
      //    而本探针环境跟随系统 = 亮色 ⇒ 之前给的证据图跟用户实况对不上，
      //    害我对着两张不同的界面判断「哪里不对」。以后每套界面截图都配一张暗色的。
      await win.webContents.executeJavaScript(
        `document.getElementById('bili-note-cancel').click(); document.body.setAttribute('data-ds-dark-theme', '')`,
      )
      await sleep(500)
      const shotDark = await win.webContents.capturePage()
      writeFileSync(join(ROOT, 'logs', 'shot-bili-history-dark.png'), shotDark.toPNG())
      await win.webContents.executeJavaScript(`document.body.removeAttribute('data-ds-dark-theme')`)

      out('# 截图：logs/shot-bili-history.png · shot-bili-note.png · shot-bili-history-dark.png（暗色）')
      win.setContentSize(304, 344)
      await win.webContents.executeJavaScript(
        `(() => {
           document.body.classList.remove('expand-down')
           document.getElementById('bili-note-cancel').click()
         })()`,
      )
      await sleep(300)
    } catch {
      /* 截不到不影响断言结论 */
    }

    /* ══ 2026-10-08 用户 m02698：「压缩显示也要的」═══════════════════════════
     * 真压缩要 ~98 万 tokens（阈值 ≈983.6k）本机造不出来 —— 所以在真渲染进程里
     * 直接灌一条**与 host 发出的完全同形**的 orb:block（type=block / kind=notice /
     * detail.summary / running）。要证的是球侧这条链的三件事：
     *   ① notice 直属 #transcript，不被「过程组」吸进可折叠的那一轮（吸进去就看不见了）；
     *   ② 没摘要时不可点、有摘要才可点（箭头与 aria-expanded 跟着走）；
     *   ③ 点一下真展开摘要，再点收起 —— 状态是翻转的，不是一次性（反向对照）。
     */
    const NOTICE_TEXT = '上下文已压缩 · 触发：上下文压力 · 隐藏 34 条早期消息 · 上下文 987.7k → 12.3k tokens'
    const NOTICE_SUMMARY = '（探针）被折叠的前文摘要：讨论了环形菜单与三个页面的背景。'
    win.webContents.send('orb:block', {
      type: 'block',
      key: 'notice:probe',
      kind: 'notice',
      text: NOTICE_TEXT,
      running: false,
      detail: { trigger: 'context_window_limit', summary: NOTICE_SUMMARY, stats: null },
    })
    await sleep(400)
    const noticeClosed = await win.webContents.executeJavaScript(
      `(() => {
         const nodes = [...document.querySelectorAll('.block[data-kind="notice"]')]
         const node = nodes[0]
         if (!node) return { count: nodes.length }
         const row = node.querySelector('.notice-row')
         const body = node.querySelector('.notice-body')
         return {
           count: nodes.length,
           parent: node.parentElement ? node.parentElement.id : '',
           text: node.querySelector('.notice-text').textContent,
           hasSummary: node.getAttribute('data-has-summary'),
           expanded: node.hasAttribute('data-expanded'),
           aria: row.getAttribute('aria-expanded'),
           role: row.getAttribute('role'),
           bodyHidden: body.hidden,
           leading: !!node.querySelector('.notice-leading svg'),
           chevron: !!node.querySelector('.notice-chevron svg'),
         }
       })()`,
    )
    check(
      'S23 压缩提示行：kind=notice 直属 #transcript（不被过程组吸走）、文案原样、默认收起但「可点」',
      noticeClosed.count === 1
        && noticeClosed.parent === 'transcript'
        && noticeClosed.text === NOTICE_TEXT
        // ⚠️ `toggleAttribute(name, true)` 挂出来的是**空值**属性：读回来是 ''，不是 'true'。
        && noticeClosed.hasSummary !== null
        && noticeClosed.expanded === false
        && noticeClosed.aria === 'false'
        && noticeClosed.role === 'button'
        && noticeClosed.bodyHidden === true
        && noticeClosed.leading === true
        && noticeClosed.chevron === true,
      JSON.stringify(noticeClosed),
    )

    /* ── S24 点开摘要 → 再点收起（同一颗按钮，状态必须真的翻转）─────────── */
    await win.webContents.executeJavaScript(
      `document.querySelector('.block[data-kind="notice"] .notice-row').click()`,
    )
    await sleep(250)
    const noticeOpen = await win.webContents.executeJavaScript(
      `(() => {
         const node = document.querySelector('.block[data-kind="notice"]')
         return {
           expanded: node.hasAttribute('data-expanded'),
           aria: node.querySelector('.notice-row').getAttribute('aria-expanded'),
           bodyHidden: node.querySelector('.notice-body').hidden,
           bodyText: node.querySelector('.notice-body').textContent,
         }
       })()`,
    )
    await win.webContents.executeJavaScript(
      `document.querySelector('.block[data-kind="notice"] .notice-row').click()`,
    )
    await sleep(250)
    const noticeReclosed = await win.webContents.executeJavaScript(
      `(() => {
         const node = document.querySelector('.block[data-kind="notice"]')
         return {
           expanded: node.hasAttribute('data-expanded'),
           bodyHidden: node.querySelector('.notice-body').hidden,
         }
       })()`,
    )
    check(
      'S24 点一下展开摘要正文（正文里看得到那句话），再点收起（反向对照：状态真的翻转回去）',
      noticeOpen.expanded === true
        && noticeOpen.aria === 'true'
        && noticeOpen.bodyHidden === false
        && noticeOpen.bodyText.includes('环形菜单与三个页面的背景')
        && noticeReclosed.expanded === false
        && noticeReclosed.bodyHidden === true,
      JSON.stringify({ noticeOpen, noticeReclosed }),
    )

    /* ── S25 摘要还没到的那条（running 态）不可点；顺带反向对照 placeBlock 的分支 ── */
    win.webContents.send('orb:block', {
      type: 'block',
      key: 'notice:probe-pending',
      kind: 'notice',
      text: '上下文已压缩 · 触发：手动触发 · 摘要生成中…',
      running: true,
      detail: { trigger: 'manual', summary: '', stats: null },
    })
    win.webContents.send('orb:block', { type: 'block', key: 'reason:probe', kind: 'reasoning', text: '探针思考正文', running: false })
    await sleep(400)
    const noticePending = await win.webContents.executeJavaScript(
      `(() => {
         const nodes = [...document.querySelectorAll('.block[data-kind="notice"]')]
         const node = nodes[nodes.length - 1]
         node.querySelector('.notice-row').click()
         return {
           count: nodes.length,
           parent: node.parentElement ? node.parentElement.id : '',
           hasSummary: node.getAttribute('data-has-summary'),
           expanded: node.hasAttribute('data-expanded'),
           text: node.querySelector('.notice-text').textContent,
           reasoningInTranscript: document.querySelectorAll('#transcript > .block[data-kind="reasoning"]').length,
           reasoningInLane: document.querySelectorAll('#reasoning-lane .block[data-kind="reasoning"]').length,
         }
       })()`,
    )
    check(
      'S25 摘要未到的提示行点了也不展开（data-has-summary 都没挂）＋反向对照：reasoning 块走 reasoning-lane',
      noticePending.count === 2
        && noticePending.parent === 'transcript'
        && noticePending.hasSummary === null
        && noticePending.expanded === false
        && noticePending.text.includes('摘要生成中')
        && noticePending.reasoningInTranscript === 0
        && noticePending.reasoningInLane === 1,
      JSON.stringify(noticePending),
    )

    /* ── S2 渲染层无 uncaught（放在交互之后，把交互期报错也算进来）────── */
    check('S2 渲染层无 uncaught 报错', uncaught.length === 0, uncaught.join(' | '))
    if (noise.length) {
      out(`# （按白名单排除的环境噪声 ${noise.length} 条：${noise.slice(0, 3).join(' | ')}）`)
    }

    /* ── S5 反向对照：故意写坏的页面必须被同一套收集器抓到 ─────────────── */
    try {
      writeFileSync(
        NEGATIVE_PAGE,
        '<!doctype html><meta charset="utf-8"><title>negative</title><body>'
          + '<script>notDefinedAnywhere_20261008()<\/script>',
        'utf8',
      )
      const before = uncaught.length
      const negative = await loadPage(NEGATIVE_PAGE, 'negative', { preload: undefined })
      await sleep(700)
      const caught = uncaught.slice(before)
      check(
        'S5 反向对照：故意抛 ReferenceError 的页面必须被收集器抓到',
        caught.some((line) => /ReferenceError|is not defined/.test(line)),
        caught.join(' | ') || '一条都没抓到 —— S2 就是假绿',
      )
      negative.destroy()
    } catch (error) {
      check('S5 反向对照：故意抛 ReferenceError 的页面必须被收集器抓到', false, `反向页没跑起来：${error && error.message}`)
    } finally {
      try {
        unlinkSync(NEGATIVE_PAGE)
      } catch {
        /* 临时产物，删不掉无所谓 */
      }
    }


  /* ── 对话页证据截图（**必须排在所有断言之后**）────────────────────
   * 之前它排在 S23–S25 前面，于是它注入的 user/reasoning 块被 S25 的
   * 「notice 恰好 1 个」数成了 2 —— 探针互相污染，红的还不是产品的问题。
   * 规矩：**凡是往页面里灌内容的动作，一律排在全部 check 之后。 */
  try {
      // ── 再拍一张**对话页**的：用户报「排版乱」时截的就是它，而探针此前
    //    只截过抽屉 —— 于是"正文压在背景图上读不了"这件事我一直是瞎的。
    //    这里灌一段真实形状的对话（user / 思考 / 工具 / 带 markdown 的回复）。
    const convo = [
      { key: 'shot:u:1', kind: 'user', text: '用普通用的bili_watch，深度求解中：工具调用 · bili_watch' },
      { key: 'shot:r:1', kind: 'reasoning', text: 'The bili account name. She needs to look up their Bilibili account name so she knows who is asking.' },
      { key: 'shot:t:1', kind: 'tool', text: 'bili_watch /bili-watch → 取 2 帧 480×270，只下了整片的 5.8%' },
      {
        key: 'shot:a:1',
        kind: 'assistant',
        text: [
          '**看视频要走 `bili_watch`，不是手打 URL。**',
          '',
          '要点：',
          '',
          '1. `mode:"quick"` 两帧 480×270，最省；',
          '2. `mode:"thorough"` 五帧 960×540，看细节；',
          '3. 实时取帧 > 0 才看是否记账，避免浪费 —— `frames:0` 只看元信息。',
          '',
          '```js',
          'await bili_watch({ url, mode: "quick" })',
          '```',
        ].join('\n'),
      },
    ]
    for (const rec of convo) {
      /* ★ assistant 必须带 `response:true`（照 shell.js:2562 的 `block.response`）——
         不带的话它会被 `.turn:not([data-open]) > .block[assistant]:not([data-response])`
         这条规则**整个隐藏**（那是"折叠某一轮时只留最终答复"的设计）。
           踩过一次：fixture 少这个字段 ⇒ 回复块在 DOM 里、屏幕上没有 ⇒ 我以为渲染坏了。 */
      win.webContents.send('orb:block', {
        type: 'block', key: rec.key, kind: rec.kind, text: rec.text, running: false,
        response: rec.kind === 'assistant',
      })
      await sleep(160)
    }
    await win.webContents.executeJavaScript(
      `document.body.setAttribute('data-ds-dark-theme',''); document.getElementById('bili-history').hidden = true; document.body.classList.remove('bili-history-open'); document.body.classList.add('expanded')`,
    )
    await sleep(700)
    // 顺手 dump 一下正文里到底有哪些块（注入的 assistant 为什么没显示，一并看清）
    // ⚠️ 这里**不能**在内层模板字符串里再用 ${}（那会在 Node 端求值、n 不存在）。
    //    一律用字符串拼接 —— 这是探针里最容易踩的一个坑。
    const convoDump = await win.webContents.executeJavaScript(
      `(() => {
         const t = document.getElementById('transcript')
         const r = t.getBoundingClientRect()
         return {
           kids: [].slice.call(t.children).map((n) => {
             const b = n.getBoundingClientRect()
             const cs = getComputedStyle(n)
             const par = n.parentElement
             return (n.dataset.kind || '?')
               + ' y=' + Math.round(b.y) + ' h=' + Math.round(b.height)
               + ' disp=' + cs.display
               + ' par=' + (par ? par.className : '-')
               + ' open=' + (par ? par.getAttribute('data-open') : '-')
           }),
           transcript: 'y=' + Math.round(r.y) + ' h=' + Math.round(r.height) + ' scroll=' + t.scrollTop + '/' + t.scrollHeight,
           lane: [].slice.call(document.querySelectorAll('#reasoning-lane .block')).map((n) => (n.dataset.kind || '') + '|' + (n.textContent || '').slice(0, 30)),
         }
       })()`,
    )
    out('# 正文 dump：' + JSON.stringify(convoDump))
    const shotConvo = await win.webContents.capturePage()
    writeFileSync(join(ROOT, 'logs', 'shot-transcript-dark.png'), shotConvo.toPNG())
    await win.webContents.executeJavaScript(`document.body.removeAttribute('data-ds-dark-theme')`)
    out('# 截图：… · shot-transcript-dark.png（对话页·暗色·真实背景）')
  } catch {
    /* 截不到不影响断言结论 */
  }

    win.destroy()
    out('')


    out(`# 汇总：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过`)
    if (consoleLines.length) {
      out('# 渲染层控制台全部输出：')
      for (const line of consoleLines) out(`#   ${line}`)
    }
    clearTimeout(watchdog)
    app.exit(failed === 0 ? 0 : 1)
  })
  .catch((error) => {
    out('')
    out(`FATAL 探针自身出错：${(error && error.stack) || error}`)
    clearTimeout(watchdog)
    app.exit(2)
  })
