/**
 * _bili-frame-main.mjs —— 在**真 Electron 主进程**里跑一次 `bili_watch` 取帧。
 *
 * 为什么必须是独立入口：`src/kfdecode.mjs` 一进门就 `import { app, BrowserWindow } from 'electron'`，
 * 纯 Node（探针进程）载不进来。所以由 `probe/bili-frame-e2e.mjs` 用 `runtime/electron/electron.exe`
 * 起这个脚本，它把结果写成一行 `BILI_E2E_RESULT {json}` 给父进程读。
 *
 * 直接跑：`runtime\electron\electron.exe --disable-gpu probe\_bili-frame-main.mjs`
 */

import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'logs', 'bili-frame-e2e')

const BV = process.env.BILI_BV || 'BV1GJ411x7h7'
const FRAMES = Number(process.env.BILI_FRAMES || 3)
const MAX_W = Number(process.env.BILI_MAXW || 640)
const MAX_H = Number(process.env.BILI_MAXH || 360)

function emit(obj) {
  process.stdout.write('BILI_E2E_RESULT ' + JSON.stringify(obj) + '\n')
}

async function main() {
  await app.whenReady()
  const { createBiliWatch } = await import('../src/bili-watch.mjs')
  const logs = []
  const watch = createBiliWatch({
    getCookie: () => process.env.BILI_COOKIE || '',
    log: (m) => {
      logs.push(String(m))
      console.log('[bili] ' + m)
    },
  })

  const t0 = Date.now()
  let r
  try {
    r = await watch.watch({ url: BV, frames: FRAMES, maxOut: { w: MAX_W, h: MAX_H } })
  } catch (err) {
    emit({ ok: false, threw: String(err?.stack || err), elapsedMs: Date.now() - t0, logs })
    return
  }

  const frames = []
  if (r.ok && Array.isArray(r.images)) {
    mkdirSync(OUT_DIR, { recursive: true })
    r.images.forEach((im, i) => {
      const buf = Buffer.from(im.data, 'base64')
      const file = join(OUT_DIR, `frame-${i}.jpg`)
      writeFileSync(file, buf)
      frames.push({
        file,
        mimeType: im.mimeType,
        bytes: buf.length,
        magic: buf.subarray(0, 2).toString('hex'),
        tail: buf.subarray(-2).toString('hex'),
        // 解出来的 base64 前缀要能被 data URL 直接拼：不允许带 `data:image/jpeg;base64,`
        hasDataPrefix: im.data.startsWith('data:'),
        base64Chars: im.data.length,
      })
    })
  }

  emit({
    ok: r.ok,
    text: r.text,
    elapsedMs: Date.now() - t0,
    meta: r.meta ?? null,
    images: r.images?.length ?? 0,
    frames,
    logs,
  })
}

main()
  .catch((err) => emit({ ok: false, threw: String(err?.stack || err) }))
  .finally(() => {
    // 给 stdout 一点时间冲出去，再退出（Electron 直接 exit 会吞掉最后一段输出）。
    setTimeout(() => app.exit(0), 200)
  })
