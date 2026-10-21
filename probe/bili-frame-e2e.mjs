#!/usr/bin/env node
/**
 * bili-frame-e2e.mjs —— 真机验证：Electron 主进程里 `bili_watch` 能不能取到真关键帧。
 *
 * 分工：
 *   `probe/_bili-frame-main.mjs`  在 Electron 里跑（`kfdecode.mjs` 只在那个上下文能载）；
 *   本文件在普通 Node 里跑，负责起进程、收结果、断言、留证（`logs/bili-frame-e2e/`）。
 *
 * 用匿名（不带 cookie）：`BV1GJ411x7h7` 实测最高 480P、852×480。
 * 期望值都是文档 `docs/B站认真看_取帧第三条路_原生分辨率_2026-10-21.md` 里记的实测数，
 * 对不上就说明链路退化，而不是「B 站偶尔抽风」。
 *
 * 跑法：`node probe/bili-frame-e2e.mjs`
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'logs', 'bili-frame-e2e')
const ELECTRON = join(ROOT, 'runtime', 'electron', 'electron.exe')
const MAIN = join(ROOT, 'probe', '_bili-frame-main.mjs')
const BV = process.env.BILI_BV || 'BV1GJ411x7h7'
const FRAMES = Number(process.env.BILI_FRAMES || 3)

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`PASS ${name}${extra ? '  ' + extra : ''}`)
  } else {
    fail++
    failures.push(name)
    console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`)
  }
}

if (!existsSync(ELECTRON)) {
  console.error(`找不到 Electron：${ELECTRON}`)
  process.exit(1)
}

// 每次都从干净目录起：上一轮的 frame-*.jpg 会让「这次出了几张」变得说不清。
rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

console.log(`[e2e] ${ELECTRON} 取 ${BV} 的 ${FRAMES} 帧 …`)
const t0 = Date.now()

// ★ 必须删掉 ELECTRON_RUN_AS_NODE：只要它存在（哪怕值是空串），Electron 就退化成纯 Node。
//   症状极具误导性 —— 表现为 `electron.exe: bad option: --disable-gpu`，再往后是
//   `SyntaxError: The requested module 'electron' does not provide an export named 'app'`
//  （因为纯 Node 下 'electron' 解析到 E:\node_modules\electron 那个「导出路径字符串」的 npm 壳）。
//   这条纪律在 src/launch.mjs 里也写着，探针必须自己再做一次：它不经过 launch.mjs。
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// 无显示/无 GPU 的环境（CI、沙箱、远程会话）里 Chromium 的 GPU 子进程会连崩，
// 最后 FATAL「GPU process isn't usable. Goodbye.」。这两个开关必须一起给，缺一个都不行。
// 默认不传，保持和真机一致；需要时用环境变量补：
//   BILI_E2E_ELECTRON_FLAGS="--no-sandbox --disable-gpu"
const extraArgs = (process.env.BILI_E2E_ELECTRON_FLAGS ?? '').split(' ').filter(Boolean)

const res = spawnSync(ELECTRON, [MAIN, ...extraArgs], {
  cwd: ROOT,
  env: {
    ...env,
    BILI_BV: BV,
    BILI_FRAMES: String(FRAMES),
    BILI_MAXW: '640',
    BILI_MAXH: '360',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
  encoding: 'utf8',
  timeout: 240000,
  windowsHide: true,
})
const wallMs = Date.now() - t0

const stdout = String(res.stdout || '')
const stderr = String(res.stderr || '')
const line = stdout.split(/\r?\n/).find((l) => l.startsWith('BILI_E2E_RESULT '))

if (!line) {
  console.error('没有拿到结果行。stdout 尾部：\n' + stdout.slice(-1500))
  console.error('stderr 尾部：\n' + stderr.slice(-1500))
  process.exit(1)
}

const r = JSON.parse(line.slice('BILI_E2E_RESULT '.length))
writeFileSync(join(OUT_DIR, 'result.json'), JSON.stringify({ ...r, wallMs }, null, 2))

console.log(`[e2e] 退出码 ${res.status}，外层耗时 ${wallMs}ms，内层 ${r.elapsedMs ?? '?'}ms`)
console.log('[e2e] 正文：\n' + String(r.text || '').split('\n').map((l) => '  ' + l).join('\n'))

ok('E1 取帧成功', r.ok === true, r.ok ? '' : String(r.text || r.threw || '').slice(0, 120))
ok('E2 拿到 3 张图', r.images === FRAMES, `images=${r.images}`)

const frames = Array.isArray(r.frames) ? r.frames : []
ok('E3 每张都落成文件', frames.length === FRAMES && frames.every((f) => existsSync(f.file)))

for (const [i, f] of frames.entries()) {
  ok(`E4.${i} 是 JPEG（SOI/EOI 都在）`, f.magic === 'ffd8' && f.tail === 'ffd9', `${f.magic}…${f.tail}`)
  ok(`E4.${i}b base64 不带 data: 前缀`, f.hasDataPrefix === false)
  // 只卡「不像被截断的空文件」：第 0 帧实测 2KB —— MV 开头就是黑场，
  // 黑帧本来就能压到这个量级，按 3KB 卡会把正常的首帧判成失败。
  ok(`E4.${i}c 不是被截断的空壳（>1KB）`, f.bytes > 1024, `${Math.round(f.bytes / 1024)}KB`)
}
ok('E4d 至少两张是真画面（>5KB）', frames.filter((f) => f.bytes > 5120).length >= Math.min(2, FRAMES), frames.map((f) => `${Math.round(f.bytes / 1024)}KB`).join(' '))

const st = r.meta?.stats ?? {}
ok('E5 下的是零头（≤15% 整片）', Number.isFinite(st.ratio) && st.ratio > 0 && st.ratio <= 0.15, `ratio=${st.ratio}`)
ok('E6 只碰了少数分片', Number.isFinite(st.segmentsUsed) && st.segmentsUsed > 0 && st.segmentsUsed < st.segmentsTotal, `${st.segmentsUsed}/${st.segmentsTotal} 段`)
// ★ 宽度容差：(st.width) 来自 `<video>.videoWidth`，实测比 playurl 报的 width 大 1（853 vs 852）。
//   这是 Chromium 的已知行为，文档《取帧第三条路》第 6 条坑写过，不是 bug，别按等号卡。
ok('E7 视频是 852×480 那条（宽度允许 +1）', Math.abs(st.width - 852) <= 1 && st.height === 480, `${st.width}×${st.height}`)
ok('E8 输出被缩到 ≤640×360', frames.length > 0 && r.meta?.frames?.every((f) => f.w <= 640 && f.h <= 360), JSON.stringify(r.meta?.frames?.map((f) => `${f.w}×${f.h}`)))
ok('E9 秒数落在片长内且递增', (r.meta?.frames ?? []).every((f, i, a) => f.t >= 0 && f.t < 213 && (i === 0 || f.t > a[i - 1].t)), JSON.stringify(r.meta?.frames?.map((f) => f.t)))
ok('E10 总耗时在 30s 内', Number(r.elapsedMs) < 30000, `${r.elapsedMs}ms`)
ok('E11 日志里没有 cookie', !/SESSDATA=|bili_jct=/.test(String(r.logs || [])))
ok('E12 取帧不落整片 mp4', readdirSync(OUT_DIR).filter((n) => /\.(mp4|m4s)$/i.test(n)).length === 0)

console.log('')
console.log(`bili-frame-e2e: ${pass} PASS / ${fail} FAIL（证据在 ${OUT_DIR}）`)
if (fail) {
  console.log('失败项：' + failures.join(' | '))
  process.exitCode = 1
}
