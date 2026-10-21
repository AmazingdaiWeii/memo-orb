/**
 * 冒烟：把目标目录的 orb.exe **当成双击**那样拉起来，等一会儿，看它有没有真的活。
 *
 * ★★ 唯一必须注意的事：**必须 `delete env.ELECTRON_RUN_AS_NODE`**（不能设空串 ——
 *    有定义就算开着）。本 agent 会话自带 `ELECTRON_RUN_AS_NODE=1`（WorkBuddy 本身是
 *    Electron 应用，子进程继承）。不删的话 orb.exe 会被跑成**纯 Node**：
 *      ① 无参数启动 ⇒ 什么都没发生（`logs/` 都不会建），看起来像「形态不对」；
 *      ② 带目录参数 ⇒ 报 `SyntaxError: ... does not provide an export named 'app'`，
 *         长得像代码坏了。**其实两次都是环境问题。**
 *    用户在资源管理器里双击时没有这个变量，所以这里要显式还原成「双击环境」。
 *
 * 判据：`src/main.mjs` 在模块顶层就 `mkdirSync(LOGS)`，所以 **`logs/orb.log` 长出来
 * 就证明 Electron 真的加载了 `resources/app/`** —— 比「进程还在」可靠得多。
 *
 * 用法：
 *   node tools/smoke-orb.mjs                       # 冒烟 D:\Orb，等 15 秒
 *   node tools/smoke-orb.mjs --dest D:\X --sec 25
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const di = argv.indexOf('--dest')
const DEST = di >= 0 && argv[di + 1] ? argv[di + 1] : 'D:\\Orb'
const si = argv.indexOf('--sec')
const SEC = Number(si >= 0 && argv[si + 1] ? argv[si + 1] : '15')

const APP = join(DEST, 'resources', 'app')
const LOG = join(APP, 'logs', 'orb.log')
const EXE = join(DEST, 'orb.exe')

if (!existsSync(EXE)) {
  console.error(`找不到 ${EXE}`)
  process.exit(1)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

console.log(`=== 冒烟：${EXE}（等 ${SEC} 秒）===`)
console.log(`  ELECTRON_RUN_AS_NODE 已删除 : ${env.ELECTRON_RUN_AS_NODE === undefined}`)

const child = spawn(EXE, [], { cwd: DEST, env, stdio: 'ignore' })
child.on('error', (e) => console.log(`  spawn error: ${e.code} ${e.message}`))

await new Promise((r) => setTimeout(r, SEC * 1000))

console.log('\n--- 结果 ---')
const logsOk = existsSync(join(APP, 'logs'))
const logOk = existsSync(LOG)
console.log(`  logs/ 目录 : ${logsOk ? '已建' : '没建 —— app 没被加载'}`)
console.log(`  orb.log    : ${logOk ? '已生成' : '没有'}`)
if (logOk) {
  const lines = readFileSync(LOG, 'utf8').trim().split('\n')
  console.log(`  共 ${lines.length} 行。全文：`)
  for (const l of lines) console.log(`    ${l}`)
}

console.log('\n--- 收尾 ---')
try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* noop */ }
await new Promise((r) => setTimeout(r, 1500))
console.log(`  已杀掉 pid ${child.pid}`)
process.exit(logOk ? 0 : 1)
