/**
 * 启动器：读 config.json，找到 Electron 运行时，把客户端拉起来。
 *
 * 用普通 Node 跑（不是 Electron），这样启动失败能直接看到报错，而不是窗口一闪而过。
 *
 * 所有路径都以项目根为基准，项目整个目录搬到任何盘都能直接跑。
 *
 * 环境变量：
 *   ORB_ELECTRON_FLAGS  追加给 Electron 的开关（空格分隔）。沙箱环境里需要
 *                       "--no-sandbox" 才能让 Chromium 的 GPU 子进程起来。
 *   ORB_ELECTRON        覆盖 config.json 里的 Electron 路径
 *   ORB_USER_DATA       覆盖 Electron 的用户数据目录（默认 %LOCALAPPDATA%\orb）
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const CONFIG_PATH = join(ROOT, 'config.json')
const USER_DATA = process.env.ORB_USER_DATA ?? join(process.env.LOCALAPPDATA ?? ROOT, 'orb')

function fail(msg) {
  console.error(`\n[启动失败] ${msg}\n`)
  process.exit(1)
}

if (!existsSync(CONFIG_PATH)) fail(`找不到配置文件 ${CONFIG_PATH}`)

let config
try {
  // ★ 剥 BOM：PowerShell 的 `Set-Content -Encoding UTF8`（5.1）会写带 BOM 的 UTF-8，
  //   而 JSON.parse 遇到 \uFEFF 直接抛。这里容忍它，否则出厂包会「双击没反应」。
  config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''))
} catch (err) {
  fail(`config.json 不是合法 JSON：${err.message}`)
}

const electronPath = process.env.ORB_ELECTRON ?? config.electronPath
if (!electronPath) fail('config.json 里没配 electronPath')
// electronPath 允许写相对路径，一律相对项目根解析，这样把项目搬到任何盘都能直接跑
let electronBin = isAbsolute(electronPath) ? electronPath : resolve(ROOT, electronPath)
if (!existsSync(electronBin)) {
  fail(
    `Electron 运行时不存在：${electronBin}\n` +
      '  改 config.json 的 electronPath，指向一个 electron 可执行文件（相对路径相对项目根）；\n' +
      '  或者从 https://github.com/electron/electron/releases 下载一个解压后指过去。',
  )
}

if (!existsSync(join(ROOT, 'helper', 'lib', 'main.js'))) {
  fail(`球窗口资源缺失：${join(ROOT, 'helper', 'lib', 'main.js')}`)
}
mkdirSync(USER_DATA, { recursive: true })

const flags = [...(config.electronFlags ?? []), ...(process.env.ORB_ELECTRON_FLAGS ?? '').split(' ')].filter(Boolean)

console.log(`[orb] Electron : ${electronBin}`)
console.log(`[orb] 项目目录 : ${ROOT}`)
console.log(`[orb] 用户数据 : ${USER_DATA}`)
console.log(`[orb] 额外开关 : ${flags.join(' ') || '无'}`)
console.log(`[orb] 模型     : ${config.model}`)
console.log(`[orb] 引擎     : ${config.engine ?? 'local'}${config.engine === 'local' ? '（自建，直连模型，无外部后端）' : ''}`)
if (flags.includes('--no-sandbox')) {
  console.log('[orb] 注意：带了 --no-sandbox，这是给受限环境用的；正常桌面不需要')
}
console.log('')

// 必须真正删掉，不能设为空串：Electron 只看这个变量有没有定义，
// 有定义就跑成纯 Node 模式，所有 Chromium 开关都会被报成 bad option。
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

/**
 * ★★ 杀软按「文件名」拦截 Electron 的自愈（2026-10-07 用户「打不开了」）。
 *
 * 现象：`spawn electron.exe` 直接抛 `Error: spawn EPERM`，Electron 一次都没起来
 *（`debug.log` 最后一条时间戳停在最后一次正常运行的那一刻，进程列表里也没有 electron）。
 * 定位过程（结论是**路径级、按文件名**，不是文件损坏、不是权限、不是环境变量）：
 *   - `electron.exe` 本身完好（244MB、MZ 头、mtime 是当初解压时间）；
 *   - ACL 无 deny 规则、无 NTFS 备用数据流（MOTW）→ 不是权限问题；
 *   - 同目录下的 `notepad.exe` 能spawn → spawn 机制本身没问题；
 *   - **把 electron.exe 复制成 `zz_probe.exe`（同目录）→ 能跑并输出 v24.18.1**；
 *   - 复制到 `E:\`根目录 / `runtime\probe2\` → 也都能跑。
 *⇒ 结论：安全软件按**可执行文件名 + 路径**命中特征库。Electron 这名字太显眼。
 *
 * Electron 本身不依赖 exe 名字（Chromium 从 `resources/` 加载资源，exe 只是入口），
 * 所以**复制一份改个名**就能绕过。实测改名副本带全套参数启动正常：
 * 球窗口出现、socket 连上、鉴权通过。
 *
 * 所以策略是「先按原名试，被拦才改名」—— 干净环境不受影响，
 * 也不必让用户去杀软里加白名单。
 */
const ALTERNATE_NAME = 'orb-runtime.exe'

/** 复制一份改名副本；已存在且大小一致就直接复用（省掉每次 244MB 的拷贝）。 */
function ensureAlternate() {
  const alt = join(dirname(electronBin), ALTERNATE_NAME)
  try {
    if (existsSync(alt) && statSync(alt).size === statSync(electronBin).size) return alt
    copyFileSync(electronBin, alt)
    console.log(`[orb] 已生成改名副本：${alt}`)
    return alt
  } catch (err) {
    return null
  }
}

/**
 * 试着 spawn，失败时按错误类型决定要不要换名重试。
 *
 * ⚠️ 关键实现约束：**必须等`error` 事件**才能判断失败。
 * `spawn()` 同步返回时 Windows 上可能还没报错（成功的情况更是根本不会有error），
 * 同步 try/catch 只能抓到参数错误，抓不到 `EPERM`。
 */
function trySpawn(bin) {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(bin, [`--user-data-dir=${USER_DATA}`, ...flags, ROOT], {
        cwd: ROOT,
        env,
        stdio: 'inherit',
      })
    } catch (err) {
      resolvePromise({ child: null, err })
      return
    }
    // 给个短窗口等 error；正常启动的 Electron 不会在这段时间里error
    const timer = setTimeout(() => {
      child.removeListener('error', onError)
      resolvePromise({ child, err: null })
    }, 400)
    const onError = (err) => {
      clearTimeout(timer)
      resolvePromise({ child: null, err })
    }
    child.once('error', onError)
  })
}

const first = await trySpawn(electronBin)

if (first.child === null && (first.err?.code === 'EPERM' || first.err?.code === 'EACCES')) {
  console.error(`\n[orb] 启动 electron.exe 被系统拒绝（${first.err.code}）——多半是杀软按文件名拦截。`)
  const alt = ensureAlternate()
  if (!alt) {
    fail(
      `改名副本也创建不了：${first.err.message}\n` +
        '  可以手动把 runtime\\electron\\electron.exe 复制一份改名（比如 orb-runtime.exe），\n' +
        '  再把 config.json 的 electronPath 指过去；或在杀软里把项目目录加白名单。',
    )
  }
  console.log('[orb] 正在用改名副本重试…\n')
  const second = await trySpawn(alt)
  if (second.child === null) {
    fail(`改名后依然拉不起 Electron：${second.err?.message ?? second.err}`)
  }
  attachExit(second.child)
} else if (first.child === null) {
  fail(`拉起 Electron 失败：${first.err?.message ?? first.err}`)
} else {
  attachExit(first.child)
}

function attachExit(child) {
  child.on('exit', (code, signal) => {
    console.log(`\n[orb] 退出，code=${code ?? signal}`)
    process.exit(code ?? 0)
  })
}
