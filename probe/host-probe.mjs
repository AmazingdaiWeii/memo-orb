/**
 * 阶段 0 探针：用自写的最小 Host 拉起 dsh-orb 的 helper，验证「球窗口可以脱离 DSH 启动」。
 * 不加载任何 @deepseek-ai/* 包，不读 DSH 的任何配置。
 *
 * 环境变量：
 *   ORB_HELPER_ROOT  helper 目录（默认 <项目根>/helper）
 *   ORB_FLAGS        额外传给 electron 的开关，空格分隔
 *   ORB_SECONDS      运行秒数（默认 18）
 */

import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ELECTRON = process.env.ORB_ELECTRON ?? join(ROOT, 'runtime', 'electron', 'electron.exe')
const HELPER_ROOT = process.env.ORB_HELPER_ROOT ?? join(ROOT, 'helper')
const HELPER_MAIN = `${HELPER_ROOT}/lib/main.js`
const USER_DATA = process.env.ORB_USER_DATA ?? join(ROOT, 'probe', 'userdata')
const EXTRA_FLAGS = (process.env.ORB_FLAGS ?? '').split(' ').filter(Boolean)
const SECONDS = Number(process.env.ORB_SECONDS ?? '18')

const token = randomBytes(32).toString('hex')
mkdirSync(USER_DATA, { recursive: true })

const t = () => new Date().toISOString().slice(11, 19)
const log = (m) => console.log(`[${t()}] ${m}`)

let child
let childOut = ''
let inbound = 0
let authed = false

function send(socket, obj) {
  socket.write(`${JSON.stringify(obj)}\n`)
}

const server = createServer((socket) => {
  log('helper 连上了 socket')
  socket.setEncoding('utf8')
  let buf = ''

  socket.on('data', (chunk) => {
    buf += chunk
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const part of parts) {
      if (!part.trim()) continue
      let msg
      try {
        msg = JSON.parse(part)
      } catch {
        log(`收到非法 JSON: ${part.slice(0, 120)}`)
        continue
      }

      if (!authed) {
        const ok =
          msg.type === 'hello' &&
          typeof msg.token === 'string' &&
          msg.token.length === token.length &&
          timingSafeEqual(Buffer.from(msg.token), Buffer.from(token))
        log(`收到 hello，token 校验 = ${ok}`)
        if (!ok) {
          socket.destroy()
          return
        }
        authed = true
        send(socket, { type: 'session', sessionId: 'probe-session' })
        send(socket, { type: 'turn', running: false })
        send(socket, { type: 'appearance', theme: 'dark', locale: 'zh' })
        setTimeout(() => {
          send(socket, { type: 'block', key: 'probe-user', kind: 'user', text: '独立 Host 探针：能收到我吗？' })
        }, 4000)
        setTimeout(() => {
          send(socket, {
            type: 'block',
            key: 'probe-reply',
            kind: 'assistant',
            text: '握手已通。这个球由独立 Host 拉起，没经过 DSH。',
            running: false,
          })
        }, 6000)
        continue
      }

      inbound += 1
      log(`helper -> ${JSON.stringify(msg).slice(0, 180)}`)
    }
  })

  socket.on('close', () => log('socket 关闭'))
  socket.on('error', (e) => log(`socket 错误 ${e.message}`))
})

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  log(`Host 监听 127.0.0.1:${port}`)
  log(`helper = ${HELPER_MAIN}`)
  log(`额外开关 = [${EXTRA_FLAGS.join(' ') || '无'}]`)

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.DSH_ORB_SOCKET = `127.0.0.1:${port}`
  env.DSH_ORB_TOKEN = token
  env.DSH_ORB_WEB_PORT = ''
  env.DSH_ORB_APPEARANCE = JSON.stringify({ theme: 'dark', locale: 'zh' })

  child = spawn(ELECTRON, [`--user-data-dir=${USER_DATA}`, ...EXTRA_FLAGS, HELPER_MAIN], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', (d) => {
    childOut += d
    const s = String(d).trim()
    if (s) log(`helper stdout: ${s.slice(0, 200)}`)
  })
  child.stderr.on('data', (d) => {
    childOut += d
    const s = String(d).trim()
    if (s) log(`helper stderr: ${s.slice(0, 200)}`)
  })
  child.on('error', (e) => log(`helper 启动失败: ${e.message}`))
  child.on('exit', (code) => log(`helper 退出，code=${code}`))
})

setTimeout(() => {
  log(`--- 探针结束，收到 helper 出站消息 ${inbound} 条 ---`)
  try {
    child?.kill()
  } catch {}
  server.close()
  setTimeout(() => {
    const gpuLines = childOut.split('\n').filter((l) => /gpu/i.test(l)).length
    console.log(`\n=== 汇总 ===\nGPU 相关报错行数: ${gpuLines}\n收到 helper 出站消息: ${inbound}`)
    process.exit(0)
  }, 1500)
}, SECONDS * 1000)
