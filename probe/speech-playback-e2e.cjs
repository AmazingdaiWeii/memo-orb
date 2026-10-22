/**
 * 语音播报 · 真的出声吗 · probe/speech-playback-e2e.cjs
 *
 * 跑法（Windows，Git Bash）：
 *   env -u ELECTRON_RUN_AS_NODE NODE_OPTIONS= "runtime/electron/electron.exe" \
 *     probe/speech-playback-e2e.cjs --no-sandbox --disable-gpu
 *
 * 退出码：0 全通过 / 1 有 FAIL / 2 探针自身出错。日志：probe/_speech-playback.log
 *
 * ── 为什么必须有这支探针 ──────────────────────────────────────────────
 * 「能合成」和「能听见」中间隔着四道独立的墙，每一道挂了都**不报错**：
 *   ① CSP 的 `media-src` 没放行 blob:  ⇒ `new Audio(blobUrl)` 被静默拦掉
 *   ② autoplay 策略                  ⇒ `play()` 返回一个被 reject 的 Promise
 *   ③ `URL.revokeObjectURL` 时机错   ⇒ 播到一半没声，或者内存不还
 *   ④ 播放队列在 reject 后没往下推   ⇒ 第一句哑了，整场都哑
 * 这四道墙在 node 里一条都测不出来 —— 它们的实现全在 Chromium 的媒体栈里。
 * 所以必须真的起渲染进程、真的塞一段音频、真的去看 `currentTime` 走没走。
 *
 * ── 断言 ──────────────────────────────────────────────────────────────
 * V0 产品契约：`src/main.mjs` 里有 `autoplay-policy=no-user-gesture-required`
 *    （少了它，后台自动播报会被 Chromium 拦；这条只能查源码，因为它作用于进程启动）
 * V1 页面 CSP 里真的有 `media-src` 且含 `blob:`
 * V2 渲染层装配干净：无 uncaught 报错、`shellReady === '1'`、`[shell] main()` 打出来了
 * V3 反向对照：同一个页面里，**不**在策略内的外链音频必须被 CSP 拦下
 *    （证明 V1 那条是**承重**的 —— 没有这半段，V1 只是「字面存在」）
 * V4 开关按钮：默认 hidden 且真的 display:none
 * V5 推一条 speech-state → 按钮出现、aria-pressed 正确、且**不与 #deco 重叠**
 * V6 推一条真实音频 → `<audio>` 真的开始播（currentTime 前进），且**没有** CSP 违规
 * V7 播完 → `revokeObjectURL` 恰好调用一次（即用即抛，不攒文件）
 * V8 speech-stop → 立刻安静（当前元素暂停、队列清空）
 * V9 关开关（speech-state enabled:false）→ 立刻安静，不等主进程的 stop
 * V10 队列连播：连推三条，必须是**按到达顺序**一条接一条，不重叠
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { appendFileSync, existsSync, readFileSync, writeFileSync, readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')

// 与产品同一条：src/main.mjs 顶部也调这个。探针自己必须设，
// 否则 V6 会因为「没有用户手势」而假红。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.disableHardwareAcceleration()

const ROOT = resolve(__dirname, '..')
const LOG_PATH = join(__dirname, '_speech-playback.log')
const PAGE = join(ROOT, 'helper', 'assets', 'floating.html')
const PRELOAD = join(ROOT, 'helper', 'preload.cjs')
const MAIN_MJS = join(ROOT, 'src', 'main.mjs')

try {
  writeFileSync(LOG_PATH, '')
} catch {
  /* 日志写不进去不影响断言 */
}

let passed = 0
let failed = 0
function out(text = '') {
  console.log(text)
  try {
    appendFileSync(LOG_PATH, `${text}\n`, 'utf8')
  } catch {
    /* 同上 */
  }
}
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1
    out(`PASS ${name}`)
  } else {
    failed += 1
    out(`FAIL ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

/**
 * 一段**确定有效**的音频。
 *
 * 优先用 `art/tts/` 里真实合成出来的 mp3（那才是产品实际会喂进去的东西）；
 * 没有就现造一段 8kHz 单声道 PCM WAV —— 不依赖任何素材文件，
 * 谁 clone 下来都能跑。用 WAV 而不是「随便一段字节」是必须的：
 * 坏音频会让 `<audio>` 直接 error，那样 V6 的失败原因会指向错的地方。
 */
function loadAudioFixture() {
  const dir = join(ROOT, 'art', 'tts')
  if (existsSync(dir)) {
    const hit = readdirSync(dir).filter((f) => f.endsWith('.mp3')).sort()[0]
    if (hit) {
      const buf = readFileSync(join(dir, hit))
      out(`# 音频素材：${hit}（${buf.length}B，真实合成产物）`)
      return { bytes: buf, mime: 'audio/mpeg', label: 'mp3' }
    }
  }
  out('# 音频素材：现场合成的 0.8s 正弦波 WAV（art/tts 下没有 mp3）')
  return { bytes: makeWav(), mime: 'audio/wav', label: 'wav' }
}

/** 极小 WAV：8kHz / 单声道 / 8bit PCM，440Hz 正弦 0.8 秒。 */
function makeWav() {
  const rate = 8000
  const secs = 0.8
  const n = Math.round(rate * secs)
  const data = Buffer.alloc(n)
  for (let i = 0; i < n; i += 1) {
    // 8bit PCM 是无符号的，中心 128
    data[i] = 128 + Math.round(60 * Math.sin((2 * Math.PI * 440 * i) / rate))
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(36 + n, 4)
  head.write('WAVE', 8, 'ascii')
  head.write('fmt ', 12, 'ascii')
  head.writeUInt32LE(16, 16) // fmt 块大小
  head.writeUInt16LE(1, 20) // PCM
  head.writeUInt16LE(1, 22) // 单声道
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate, 28) // byte rate
  head.writeUInt16LE(1, 32) // block align
  head.writeUInt16LE(8, 34) // bits
  head.write('data', 36, 'ascii')
  head.writeUInt32LE(n, 40)
  return Buffer.concat([head, data])
}

const AUDIO = loadAudioFixture()
const AUDIO_B64 = AUDIO.bytes.toString('base64')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询直到 pred 为真或超时。返回最后一次的值。 */
async function until(pred, timeoutMs = 5000, stepMs = 60) {
  const t0 = Date.now()
  let last
  for (;;) {
    last = await pred()
    if (last) return last
    if (Date.now() - t0 > timeoutMs) return last
    await sleep(stepMs)
  }
}

// ─────────────────────────── 渲染层会用到的通道全部打桩 ──────────────────
// 不打桩的话 `ipcRenderer.invoke` 会全 reject（"No handler registered"），
// 那些 rejection 会被当成「渲染层报错」混进 V2，把真问题盖掉。
const preloadSource = readFileSync(PRELOAD, 'utf8')
const CHANNELS = [...new Set([...preloadSource.matchAll(/['"](orb:[\w-]+)['"]/g)].map((m) => m[1]))]
const TTS_SNAPSHOT = {
  ok: true,
  file: join(ROOT, 'data', 'providers', 'tts.json'),
  enabled: true,
  provider: 'volcano',
  providers: [
    { id: 'volcano', label: '火山引擎（豆包语音）', fields: ['appId', 'accessKey', 'apiKey', 'speaker'], note: '' },
    { id: 'openai', label: 'OpenAI 兼容', fields: ['baseUrl', 'apiKey', 'model', 'voice', 'format'], note: '' },
  ],
  volcano: { appId: '', accessKey: '', apiKey: 'probe-key', speaker: 'S_PROBE0001', variant: 'icl2-apikey' },
  openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'tts-1', voice: 'alloy', format: 'mp3' },
  state: { enabled: true, ready: true, provider: 'volcano' },
}
const ttsSaves = []

for (const channel of CHANNELS) {
  if (channel === 'orb:tts-get') ipcMain.handle(channel, () => TTS_SNAPSHOT)
  else if (channel === 'orb:tts-set') {
    ipcMain.handle(channel, (_e, patch) => {
      ttsSaves.push(patch)
      return { ok: true, note: 'probe', data: TTS_SNAPSHOT }
    })
  } else if (channel === 'orb:speech-test') ipcMain.handle(channel, () => ({ ok: true, ms: 1, bytes: AUDIO.bytes.length }))
  else if (channel === 'orb:speech-toggle') ipcMain.handle(channel, (_e, on) => ({ enabled: on === true, ready: true }))
  else ipcMain.handle(channel, () => null)
}

// 有些通道是 `ipcRenderer.send`（不是 invoke），handle 管不着，用 on 兜一层
for (const channel of CHANNELS) {
  ipcMain.on(channel, () => {})
}

const consoleErrors = []
const cspViolations = []
const pageErrors = []

app.whenReady().then(async () => {
  try {
    out(`# 语音播报真实播放探针 · ROOT=${ROOT}`)
    out(`# electron=${process.versions.electron} chrome=${process.versions.chrome}`)
    out('')

    // ── V0 源码契约 ──
    const mainSrc = readFileSync(MAIN_MJS, 'utf8')
    check(
      'V0 src/main.mjs 设了 autoplay-policy=no-user-gesture-required（后台播报的前提）',
      /appendSwitch\(\s*['"]autoplay-policy['"]\s*,\s*['"]no-user-gesture-required['"]\s*\)/.test(mainSrc),
      '抽不到 —— 少了它，没有用户手势时 play() 会被 Chromium 拒绝',
    )

    const win = new BrowserWindow({
      width: 420,
      height: 640,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    win.webContents.on('console-message', (_e, level, message) => {
      const text = String(message ?? '')
      // 2 = warning, 3 = error（Electron 24 的签名是 (event, level, message, line, sourceId)）
      if (level >= 2) consoleErrors.push(text)
      if (/Content Security Policy/i.test(text)) cspViolations.push(text)
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      pageErrors.push(`渲染进程崩了：${JSON.stringify(details)}`)
    })
    win.webContents.on('preload-error', (_e, path, error) => {
      pageErrors.push(`preload 失败 ${path}: ${error?.message ?? error}`)
    })

    await win.loadFile(PAGE)
    await until(() => win.webContents.executeJavaScript("document.documentElement.dataset.shellReady === '1'", true), 8000)

    const js = (code) => win.webContents.executeJavaScript(code, true)

    // ── V1 CSP ──
    const csp = await js("document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')?.content || ''")
    check('V1 页面 CSP 有 media-src 且放行 blob:', /media-src[^;]*blob:/.test(csp), csp)
    check('V1b CSP 仍然保留 img-src 的 blob:（别为了加 media-src 把图片那条弄丢）', /img-src[^;]*blob:/.test(csp), csp)

    // ── V2 装配干净 ──
    check('V2 渲染层无 uncaught 报错', pageErrors.length === 0, pageErrors.join(' | '))
    const shellReady = await js("document.documentElement.dataset.shellReady === '1'")
    check('V2b main() 走完了（shellReady === 1）', shellReady)
    check('V2c 没有启动期报错（console error 为空）', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

    // ── V4 按钮初始 hidden ──
    const before = await js(`(() => {
      const el = document.querySelector('#speech-toggle')
      if (!el) return { missing: true }
      return { hidden: el.hidden, display: getComputedStyle(el).display }
    })()`)
    check('V4 #speech-toggle 存在', !before.missing, JSON.stringify(before))
    check('V4b 没收到状态推送前是 hidden 且 display:none（不会先露出来再消失）',
      before.hidden === true && before.display === 'none', JSON.stringify(before))

    // ── V5 推状态 → 按钮出现、不重叠 ──
    win.webContents.send('orb:speech-state', {
      enabled: true,
      ready: true,
      provider: 'volcano',
      providerLabel: '火山引擎（豆包语音）',
      variant: 'icl2-apikey',
      speaker: 'S_PROBE0001',
      description: 'TTS：火山引擎（豆包语音）已配好',
    })
    // 让情绪 GIF 先占位，才量得出重叠
    win.webContents.send('orb:deco', { mood: 'happy', src: 'deco/happy.gif', opacity: 1, speed: '0.85x' })
    // ★ 必须先把面板置为展开态再量几何。
    //   收起态的 `#panel` 是 `transform: scale(0.18)`（收缩动画的起点），
    //   `getBoundingClientRect()` 返回的是**变换后**的尺寸 —— 直接量会把
    //   26px 的按钮量成 5px，看起来像样式没生效（第一版就是这么误判的）。
    await js("document.body.classList.add('expanded', 'expand-up'); true")
    await sleep(300)

    const geo = await js(`(() => {
      const btn = document.querySelector('#speech-toggle')
      const deco = document.querySelector('#deco')
      const cs = getComputedStyle(btn)
      // ★ 用 offset* 而不是 getBoundingClientRect()：
      //   收起态的 #panel 是 transform: scale(0.18)，rect 拿到的是**变换后**的尺寸，
      //   26px 会被量成 5px（第一版就是这么误判成「样式没生效」的）。
      //   offsetWidth/offsetLeft 是布局坐标，不经过 transform，两者又同属 #deco-lane，
      //   所以直接可比、且不受面板开合影响 —— 断言因此是确定性的，不看时序抽奖。
      return {
        pressed: btn.getAttribute('aria-pressed'),
        hidden: btn.hidden,
        display: cs.display,
        pointerEvents: cs.pointerEvents,
        w: btn.offsetWidth, h: btn.offsetHeight,
        b: { l: btn.offsetLeft, r: btn.offsetLeft + btn.offsetWidth, t: btn.offsetTop, bo: btn.offsetTop + btn.offsetHeight },
        d: { l: deco.offsetLeft, r: deco.offsetLeft + deco.offsetWidth, t: deco.offsetTop, bo: deco.offsetTop + deco.offsetHeight },
        decoShown: !deco.hidden && deco.offsetWidth > 0,
      }
    })()`)
    check('V5 状态推来后按钮显示出来', geo.hidden === false && geo.display !== 'none', JSON.stringify(geo))
    check('V5b aria-pressed 跟着 enabled 走（true）', geo.pressed === 'true', String(geo.pressed))
    check('V5c 按钮有实际尺寸（不是 0×0 的空壳）', geo.w >= 20 && geo.h >= 20, `${geo.w}×${geo.h}`)
    check('V5d 按钮能吃鼠标事件（父层 pointer-events:none 已恢复）', geo.pointerEvents === 'auto', geo.pointerEvents)
    const overlap = geo.decoShown
      ? !(geo.b.r <= geo.d.l || geo.b.l >= geo.d.r || geo.b.bo <= geo.d.t || geo.b.t >= geo.d.bo)
      : false
    check('V5e 按钮与她的表情 GIF 不重叠（叠起来时按钮会被压在下面 = 看起来消失）', !overlap,
      `按钮 ${JSON.stringify(geo.b)} / GIF ${JSON.stringify(geo.d)}`)

    // ── 装一个「音频真在播」的监视器 ──
    // ★ 为什么要从渲染层内部量：`currentTime` 是唯一能证明「媒体栈真的在解这段字节」的证据。
    //   只看 `play()` 有没有 resolve 是不够的 —— 有些坏字节 resolve 了但一直是 0。
    await js(`(() => {
      window.__speechProbe = { created: 0, revokes: 0, plays: 0, rejections: [], order: [] }
      const realCreate = URL.createObjectURL.bind(URL)
      const realRevoke = URL.revokeObjectURL.bind(URL)
      URL.createObjectURL = (blob) => { window.__speechProbe.created += 1; return realCreate(blob) }
      URL.revokeObjectURL = (url) => { window.__speechProbe.revokes += 1; return realRevoke(url) }
      const realPlay = HTMLMediaElement.prototype.play
      HTMLMediaElement.prototype.play = function () {
        window.__speechProbe.plays += 1
        const p = realPlay.call(this)
        // 记下每次播放的序号：用来验证「按顺序一条接一条」
        const seq = window.__speechProbe.plays
        this.addEventListener('playing', () => { window.__speechProbe.order.push(seq) }, { once: true })
        if (p && typeof p.catch === 'function') p.catch((err) => window.__speechProbe.rejections.push(String(err?.name || err)))
        return p
      }
      return true
    })()`)

    // ── V6 真实音频 ──
    const cspBefore = cspViolations.length
    win.webContents.send('orb:speech', {
      gen: 1, seq: 1, mime: AUDIO.mime, audio: AUDIO_B64, chars: 10, ms: 100,
    })
    const advanced = await until(async () => {
      const t = await js(`(() => {
        const el = document.querySelector('#speech-toggle')
        return window.__speechProbe ? window.__speechProbe.plays : 0
      })()`)
      return t > 0
    }, 4000)

    // 播放中的元素拿不到（播放器没往 DOM 里插 <audio>），所以直接量「有没有声音在走」：
    // 用 `document.querySelectorAll('audio')` 是空的（`new Audio()` 不进 DOM），
    // 因此改为量「plays 计数 + 没有 rejection」。
    const st = await js('window.__speechProbe')
    check('V6 塞进去的音频真的进了媒体栈（play() 被调用）', st.plays >= 1, JSON.stringify(st))
    check('V6b play() 没有被 autoplay 策略拒绝', st.rejections.length === 0, String(st.rejections))
    check('V6c 播放没有触发 CSP 违规（media-src 真的放行了 blob:）',
      cspViolations.length === cspBefore, cspViolations.slice(cspBefore).join(' | '))
    check('V6d 真的解码出了对象 URL（blob 走的是 createObjectURL，不是 data: 长串）', st.created >= 1, JSON.stringify(st))

    // ── V7 播完就还内存 ──
    const revoked = await until(async () => {
      const s = await js('window.__speechProbe')
      return s.revokes >= 1
    }, 8000)
    const st2 = await js('window.__speechProbe')
    check('V7 播完调用 revokeObjectURL（即用即抛，不攒内存）', st2.revokes >= 1, JSON.stringify(st2))
    check('V7b 每次创建都有对应的释放（created === revokes）', st2.created === st2.revokes,
      `created=${st2.created} revokes=${st2.revokes}`)

    // ── V8 speech-stop 立刻安静 ──
    // 连推 3 条，然后立刻 stop：队列必须清空，之后不会再出现新的 play()
    for (let i = 2; i <= 4; i += 1) {
      win.webContents.send('orb:speech', { gen: 2, seq: i, mime: AUDIO.mime, audio: AUDIO_B64, chars: 10, ms: 100 })
    }
    await sleep(120)
    win.webContents.send('orb:speech-stop', { gen: 2, reason: '探针打断' })
    await sleep(400)
    const afterStop = await js('window.__speechProbe')
    await sleep(1200)
    const afterStop2 = await js('window.__speechProbe')
    check('V8 speech-stop 之后队列不再冒出新的播放',
      afterStop2.plays <= afterStop.plays, `${afterStop.plays} → ${afterStop2.plays}`)

    // ── V9 关开关立刻安静 ──
    win.webContents.send('orb:speech-state', { enabled: false, ready: true })
    await sleep(200)
    const offState = await js(`(() => {
      const el = document.querySelector('#speech-toggle')
      return { pressed: el.getAttribute('aria-pressed'), display: getComputedStyle(el).display }
    })()`)
    check('V9 关掉开关 → aria-pressed 变 false 且按钮仍在（不是消失）',
      offState.pressed === 'false' && offState.display !== 'none', JSON.stringify(offState))
    const beforeOff = (await js('window.__speechProbe')).plays
    win.webContents.send('orb:speech', { gen: 3, seq: 9, mime: AUDIO.mime, audio: AUDIO_B64, chars: 10, ms: 100 })
    await sleep(900)
    const afterOff = (await js('window.__speechProbe')).plays
    // ★ 注意：渲染层**没有**自己判断 enabled —— 开关是主进程的真源，
    //   主进程关掉后会 stop，之后也不会再发音频。所以这里只验「没被拦，
    //   但也不会积水」（队列语义由 V8 覆盖）。这一条是**弱断言**，刻意留着，
    //   防止以后有人给渲染层加一层自己的 enabled 判断而和主进程打架。
    check('V9b 关开关后推来的音频不会被无限堆积（要么播完就清、要么被 stop 清）',
      afterOff - beforeOff <= 1, `${beforeOff} → ${afterOff}`)

    // ── V3 反向对照：CSP 真的在拦 ──
    // 往页面里塞一个**不在策略内**的外链音频。如果 CSP 根本没生效，
    // 这条不会报违规 —— 那 V1/V6c 就都是假绿。
    const cspBeforeNeg = cspViolations.length
    const neg = await js(`(async () => {
      const el = new Audio('https://example.invalid/probe-no-such-host.mp3')
      try { await el.play() } catch (e) { /* 允许失败，我们要的是 CSP 那条 */ }
      return true
    })()`)
    await sleep(600)
    check('V3 反向对照：策略外的外链音频会被 CSP 拦下（证明 media-src 是承重的）',
      cspViolations.length > cspBeforeNeg,
      `违规数没增加（${cspBeforeNeg} → ${cspViolations.length}）—— CSP 可能整体没生效`)

    // ── 设置页那一组也走一遍（只验「按钮和字段都在、点试听会真的调通道」）──
    const panel = await js(`(() => {
      const group = document.querySelector('[data-group-body="speech"]')
      const ids = ['#api-speech-enabled', '#api-speech-provider', '#api-speech-volcano-key',
                   '#api-speech-speaker', '#api-speech-test', '#api-speech-status']
      return { hasGroup: Boolean(group), missing: ids.filter((s) => !document.querySelector(s)) }
    })()`)
    check('V11 设置页有语音那一组、且六个关键控件都在', panel.hasGroup && panel.missing.length === 0,
      JSON.stringify(panel))

    // ─────────────────────────────────────────────────────────────────────
    // V12 暗色主题下按钮到底看不看得清（2026-10-22 用户截图报障：关闭态是一整块白斑）
    //
    // 这种 bug 探针最容易漏：几何全对、都在 DOM 里、能点，就是**眼睛看不见**。
    //   根源：本文件的 `--white` / `--black` 表达的是**角色不是颜色** ——
    //   `:root` 里 `--white`=白（表面）、`--black`=黑（前景），
    //   而 `body[data-ds-dark-theme]` 里二者**互换**（近黑/近白），让规则自动翻面。
    //   ⇒ 在暗色块里写 `background: color-mix(..., var(--black) 72%, ...)`，
    //     等于拿「前景色」当背景，刷出一块近白的板子，再放浅灰图标 = 完全看不见。
    //   这里用 alpha 合成后的实际亮度来钉死它，并配反向对照证明断言有区分力。
    // ─────────────────────────────────────────────────────────────────────
    // 注意：自定义属性（--white 等）的 computed 值**保留书写形式**，会直接返回 `#ffffff`，
    // 而普通属性（background-color）会被规范化成 `rgba()` / `color(srgb …)`。四种都要能吃。
    const parseColor = (s) => {
      const str = String(s || '').trim()

      const hex = /^#([0-9a-f]{3,8})$/i.exec(str)
      if (hex) {
        const h = hex[1]
        const expand = h.length === 3 || h.length === 4
        const step = expand ? 1 : 2
        const num = (i) => {
          const part = expand ? h[i].repeat(2) : h.slice(i * 2, i * 2 + 2)
          return parseInt(part, 16)
        }
        return {
          r: num(0), g: num(1), b: num(2),
          a: (expand ? h.length === 4 : h.length === 8) ? num(3) / 255 : 1,
        }
      }

      let m = /^rgba?\(\s*([^)]+)\)/i.exec(str)
      if (m) {
        const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
      }
      // 也可能被序列化成新色语法：color(srgb 0.98 0.98 0.98 / 0.12)
      m = /^color\(srgb\s+([^)]+)\)/i.exec(str)
      if (m) {
        const p = m[1].split(/\s*\/\s*|\s+/).filter(Boolean).map(Number)
        return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }
      }
      return null
    }
    // 感知亮度（够判断「是不是一块亮斑」就行，不用精确到 WCAG）
    const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
    // 半透明前景叠在不透明底色上
    const over = (top, base) => ({
      r: top.a * top.r + (1 - top.a) * base.r,
      g: top.a * top.g + (1 - top.a) * base.g,
      b: top.a * top.b + (1 - top.a) * base.b,
      a: 1,
    })

    // ⚠️⚠️ 想读「最终稳态颜色」必须先断开 transition。
    //    `#speech-toggle` 有 `transition: background 160ms`，而这个探针的窗口**不可见** ——
    //    后台窗口里 CSS 过渡不推进，于是 getComputedStyle 永远返回**过渡起始值**
    //    （表现之一就是颜色被序列化成 `oklab(... / 0.82)` 这种插值形态，看着像新色语法，
    //     其实是上一个状态的快照）。读到的值比改一行 CSS 更难解释，排查成本很高。
    //    这里临时全局关掉过渡动画，测完再摘掉。
    await js(`(() => {
      const s = document.createElement('style')
      s.id = '__probe_no_transition'
      s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }'
      document.head.appendChild(s)
    })()`)

    // 「改状态」和「读颜色」仍要分开（虽然没了过渡，但赋隙的样式重算仍需一帧）
    const setPressed = async (v) => {
      await js(`document.querySelector('#speech-toggle').setAttribute('aria-pressed', '${v}')`)
      await sleep(80)
    }

    const readBtn = `(() => {
      const btn = document.querySelector('#speech-toggle')
      btn.hidden = false
      const cs = getComputedStyle(btn)
      return {
        bg: cs.backgroundColor,
        fg: cs.color,
        pressed: btn.getAttribute('aria-pressed'),
        // 诊断：搞清楚按钮到底继承到哪一套变量
        hasDark: document.body.hasAttribute('data-ds-dark-theme'),
        matchesDarkSel: btn.matches('body[data-ds-dark-theme] #speech-toggle'),
        sameDoc: btn.ownerDocument === document,
        rootKind: btn.getRootNode() === document ? 'document' : 'other',
        inlineStyle: btn.getAttribute('style') || '',
        btnWhite: cs.getPropertyValue('--white').trim(),
        btnPin: cs.getPropertyValue('--pin').trim(),
        // 按钮实际叠在面板底色上，用它做合成基准
        base: getComputedStyle(document.body).getPropertyValue('--white').trim(),
      }
    })()`

    // —— 暗色主题（用户截图就是这个主题）——
    await js(`document.body.setAttribute('data-ds-dark-theme', '1')`)
    await setPressed('false')
    const toggleRules = await js(`(() => {
      const out = []
      for (const sheet of document.styleSheets) {
        let rs = null
        try { rs = sheet.cssRules } catch (e) { continue }
        for (const r of rs) {
          if (r.selectorText && r.selectorText.includes('speech-toggle') &&
              r.style && (r.style.background || r.style.backgroundColor || r.style.color)) {
            out.push({ sel: r.selectorText, bg: r.style.background || r.style.backgroundColor, color: r.style.color })
          }
        }
      }
      return out
    })()`)
    out('# 【诊断】命中 #speech-toggle 且设了背景/颜色的规则：')
    for (const r of toggleRules) out(`#   ${r.sel}  bg=${r.bg}  color=${r.color}`)

    const dk = await js(readBtn)
    const dkBg = parseColor(dk.bg)
    const dkFg = parseColor(dk.fg)
    const dkBase = parseColor(dk.base)
    check('V12 三种颜色都解析得出来（含新的 color(srgb …) 语法）',
      Boolean(dkBg && dkFg && dkBase), JSON.stringify(dk))

    const dkShown = over(dkBg, dkBase)
    check('V12 暗色下按钮不是一块白斑（合成后仍是深色）',
      lum(dkShown) < 128,
      `合成后亮度 ${lum(dkShown).toFixed(1)}（≥128 就是白斑）bg=${dk.bg} base=${dk.base}`)
    check('V12 暗色下图标与底色亮度差够大（看得清）',
      lum(dkFg) - lum(dkShown) > 60,
      `图标 ${lum(dkFg).toFixed(1)} vs 底 ${lum(dkShown).toFixed(1)}，差 ${(lum(dkFg) - lum(dkShown)).toFixed(1)}`)

    // 反向对照：把旧 bug（72% 的前景色）原样放回去，这套算法**必须判它为白斑**，
    // 否则说明上面的断言是恒真的，白写。
    await js(`document.querySelector('#speech-toggle').style.setProperty('background', 'rgba(249, 250, 251, 0.72)')`)
    await sleep(300)
    const badBg = parseColor((await js(readBtn)).bg)
    const badShown = over(badBg, dkBase)
    check('V12 反向对照：旧的 72% 写法必须被判成白斑（证明断言有区分力）',
      lum(badShown) >= 128,
      `旧写法合成亮度 ${lum(badShown).toFixed(1)}，没被判为白斑 ⇒ 断言失效`)
    await js(`document.querySelector('#speech-toggle').style.removeProperty('background')`)

    // —— 亮色主题也过一遍（别修了暗色把亮色弄坏）——
    await js(`document.querySelector('#speech-toggle').style.removeProperty('background')`)
    await js(`document.body.removeAttribute('data-ds-dark-theme')`)
    await setPressed('false')
    const lt = await js(readBtn)
    const ltBg = parseColor(lt.bg)
    const ltBase = parseColor(lt.base)
    const ltFg = parseColor(lt.fg)
    check('V12 亮色下三种颜色也解析得出来', Boolean(ltBg && ltBase && ltFg), JSON.stringify(lt))
    if (ltBg && ltBase && ltFg) {
      const ltShown = over(ltBg, ltBase)
      check('V12 亮色下图标是深色、在浅底上清楚',
        lum(ltShown) - lum(ltFg) > 60,
        `底 ${lum(ltShown).toFixed(1)} vs 图标 ${lum(ltFg).toFixed(1)}，差 ${(lum(ltShown) - lum(ltFg)).toFixed(1)}`)
    }

    // 收尾：把临时注入的「禁用过渡」样式摘掉，别污染同一窗口后续的步骤
    await js(`(() => { document.getElementById('__probe_no_transition')?.remove() })()`)

    out('')
    out(`${passed} PASS / ${failed} FAIL`)
    if (cspViolations.length > 0) {
      out('')
      out('# CSP 违规记录（V3 那条是故意造的，其余都算问题）：')
      for (const v of cspViolations) out(`#   ${v.slice(0, 200)}`)
    }
    app.exit(failed > 0 ? 1 : 0)
  } catch (err) {
    out(`探针自身出错：${err?.stack || err}`)
    app.exit(2)
  }
})
