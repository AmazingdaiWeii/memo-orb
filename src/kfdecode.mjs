/**
 * kfdecode.mjs · 按需取「真关键帧」——不下载整片
 *
 * 背景：B 站原生分辨率取帧的第三条路（2026-10-21 实测，原始报告是内部文档，不进公开仓库）
 *
 * B 站 dash 的 m4s 是 fragmented MP4：
 *
 *   ftyp | free | free | moov | sidx | (moof + mdat) × N
 *
 * `moov` 里没有样本表，关键帧信息只在两处：`sidx` 的 SAP 标记、每个 `moof/traf/trun` 的
 * first_sample_flags。本模块走 `sidx` 路线：
 *
 *   1. Range 取文件头 64KB → 解析 `sidx`，得到每段的 (offset, size, 起止时间, 是否 SAP)
 *   2. 只取「SAP=1」那几段的字节 + 开头的 `ftyp+moov`（1KB），拼成一个**稀疏 mp4**
 *   3. 交给 Electron 自己（隐藏窗口里的 `<video>` + `<canvas>`）解码并截帧
 *
 * 为什么 Chromium 能吃「丢了中间分片的 mp4」：每个 `moof` 的 `tfhd` 带
 * `default-base-is-moof`（实测 0x020000），`trun` 的数据偏移相对 `moof` 起点；`tfdt` 又给出
 * 绝对时间，所以 `duration` / `seekable` 仍然是完整时长。**这个标志必须断言**，没有它就会花屏。
 *
 * 六个坑（都是踩出来的，别改）：
 *   1. 媒体直链必须同时带 `Referer` 和浏览器 UA，缺一个 403（逐变量实测）
 *   2. `sidx` 的 SAP 在**第三个** uint32 的最高位，不是第一个（第一个是 reference_type）
 *   3. `first_offset` 相对 **sidx 盒尾**，不是文件头
 *   4. version 0 的 sidx 多一个 `earliest_presentation_time`（4 字节），漏读后面全错位
 *   5. Range 请求不要带 `gzip`（这里不发 Accept-Encoding，拿到就是裸字节）
 *   6. Chromium 报的 `videoWidth` 会比 playurl 的 width 大 1（853 vs 852），断言留容差
 *
 * 与 `helper/` 的关系：**零**。这个模块自己开一个隐藏窗口当解码器，用完可以留着复用，
 * 球的前端一行都不用改。
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 浏览器 UA。B 站 CDN 会按 UA 判断，非浏览器 UA 直接 403。 */
export const MEDIA_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 媒体请求的 Referer。缺了它 403，这是防盗链的核心。 */
export const MEDIA_REFERER = 'https://www.bilibili.com'

/** 首次探测的文件头大小。够装下 ftyp+moov+sidx（实测 1548 字节处就是第一个 moof）。 */
const HEAD_BYTES = 64 * 1024

/** 默认取几帧。6 帧 ≈ 2.8MB（480P），够回答「有没有真演示」。 */
export const DEFAULT_FRAME_COUNT = 6

/** 单帧 JPEG 质量。0.85 时 480P 一帧约 25KB，与存证缩略图预算同量级。 */
export const DEFAULT_JPEG_QUALITY = 0.85

const CH_JOB = 'kf:job'
const CH_DONE = 'kf:done'
const HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), 'kfdecode.html')

// ---------------------------------------------------------------------------
// MP4 盒解析
// ---------------------------------------------------------------------------

/**
 * 遍历一段缓冲区里的顶层盒。
 *
 * @param {Buffer} buf
 * @returns {{type: string, offset: number, size: number, header: number}[]}
 */
export function parseBoxes(buf) {
  const out = []
  let o = 0
  while (o + 8 <= buf.length) {
    let size = buf.readUInt32BE(o)
    const type = buf.toString('latin1', o + 4, o + 8)
    let header = 8
    if (size === 1) {
      // 64 位扩展长度
      if (o + 16 > buf.length) break
      size = Number(buf.readBigUInt64BE(o + 8))
      header = 16
    } else if (size === 0) {
      size = buf.length - o // 一直到文件尾
    }
    if (size < header) break
    out.push({ type, offset: o, size, header })
    o += size
  }
  return out
}

/**
 * 解析 `sidx`（Segment Index）。
 *
 * 布局（version 0）：
 *   header(8) | ver+flags(4) | ref_id(4) | timescale(4) | ept(4) | first_offset(4) |
 *   reserved(2) | count(2) | count × (reference(4) + duration(4) + sap(4))
 *
 * @param {Buffer} buf  必须覆盖 [off, off+size)
 * @param {number} off
 * @param {number} size
 */
export function parseSidx(buf, off, size) {
  const end = off + size
  if (end > buf.length) throw new Error(`sidx 数据不完整（需要 ${size}，实际 ${buf.length - off}）`)
  const version = buf.readUInt8(off + 8)
  let p = off + 12
  const timescale = buf.readUInt32BE(p + 4)
  p += 8
  let ept
  if (version === 0) {
    ept = buf.readUInt32BE(p)
    p += 4
  } else {
    ept = Number(buf.readBigUInt64BE(p))
    p += 8
  }
  let firstOffset
  if (version === 0) {
    firstOffset = buf.readUInt32BE(p)
    p += 4
  } else {
    firstOffset = Number(buf.readBigUInt64BE(p))
    p += 8
  }
  p += 2 // reserved
  const count = buf.readUInt16BE(p)
  p += 2

  const entries = []
  for (let i = 0; i < count; i++) {
    if (p + 12 > end) break
    const w1 = buf.readUInt32BE(p)
    const duration = buf.readUInt32BE(p + 4)
    const w3 = buf.readUInt32BE(p + 8) // ★ SAP 在第三个字的 bit31
    p += 12
    entries.push({
      size: w1 & 0x7fffffff,
      duration,
      sap: (w3 >>> 31) & 1,
      sapType: (w3 >>> 28) & 0x7,
    })
  }

  return { version, timescale, ept, firstOffset, count, entries, sidxEnd: end }
}

/**
 * 从 `moof → traf → tfhd` 里读 flags，判断能不能安全丢掉中间分片。
 *
 * @param {Buffer} buf
 * @param {{offset: number, size: number, header: number}} moof
 * @returns {number} flags（读不到返回 -1）
 */
export function readTfhdFlags(buf, moof) {
  const walk = (box) => {
    const kids = parseBoxes(buf.subarray(box.offset + box.header, box.offset + box.size))
    return kids.map((k) => ({ ...k, offset: k.offset + box.offset + box.header }))
  }
  for (const traf of walk(moof)) {
    if (traf.type !== 'traf') continue
    for (const kid of walk(traf)) {
      if (kid.type === 'tfhd') return buf.readUInt32BE(kid.offset + 8) & 0xffffff
    }
  }
  return -1
}

/**
 * 把头部字节解释成「分片表 + 关键帧时间轴」。
 *
 * @param {Buffer} head
 * @returns {{init: Buffer, segments: object[], keyframes: object[], timescale: number,
 *            relocatable: boolean, tfhdFlags: number, fullSize: number}}
 */
export function indexStream(head) {
  const boxes = parseBoxes(head)
  const moof = boxes.find((b) => b.type === 'moof')
  const sidx = boxes.find((b) => b.type === 'sidx')
  if (!moof) throw new Error(`不是 fMP4（顶层盒：${boxes.map((b) => b.type).join(',') || '空'}）`)
  if (!sidx) throw new Error('这条流没有 sidx，无法精确定位关键帧（请降级用 videoshot 雪碧图）')

  const init = head.subarray(0, moof.offset)
  const info = parseSidx(head, sidx.offset, sidx.size)
  const tfhdFlags = readTfhdFlags(head, moof)

  let cursor = info.sidxEnd + info.firstOffset // ★ 相对 sidx 盒尾
  let acc = info.ept
  const segments = info.entries.map((e) => {
    const seg = {
      offset: cursor,
      size: e.size,
      duration: e.duration,
      start: acc / info.timescale,
      sap: e.sap,
      sapType: e.sapType,
    }
    cursor += e.size
    acc += e.duration
    return seg
  })

  return {
    init,
    segments,
    keyframes: segments.filter((s) => s.sap),
    timescale: info.timescale,
    relocatable: tfhdFlags >= 0 && (tfhdFlags & 0x020000) !== 0,
    tfhdFlags,
    fullSize: segments.length ? segments[segments.length - 1].offset + segments[segments.length - 1].size : 0,
  }
}

// ---------------------------------------------------------------------------
// 网络
// ---------------------------------------------------------------------------

/**
 * 一次 Range 请求（闭区间）。自动跟随 3xx（B 站 CDN 会跳 mcdn/hdslb）。
 *
 * 注意：**不要**加 `Accept-Encoding`。B 站媒体能返回 gzip 头，压缩流会让盒解析直接空数组。
 *
 * @param {string} url
 * @param {number} start
 * @param {number} end
 * @param {{timeoutMs?: number, cookieHeader?: string, referer?: string, depth?: number}} [opts]
 * @returns {Promise<{status: number, buf: Buffer}>}
 */
async function readRange(url, start, end, opts = {}) {
  const { timeoutMs = 30_000, cookieHeader = '', referer = MEDIA_REFERER, depth = 0 } = opts
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const headers = {
      'user-agent': MEDIA_UA,
      referer,
      range: `bytes=${start}-${end}`,
    }
    if (cookieHeader) headers.cookie = cookieHeader
    const res = await fetch(url, { headers, redirect: 'follow', signal: ac.signal })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location') && depth < 4) {
      const next = new URL(res.headers.get('location'), url).toString()
      return readRange(next, start, end, { ...opts, depth: depth + 1 })
    }
    const buf = Buffer.from(await res.arrayBuffer())
    return { status: res.status, buf }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 探测一条媒体流：只取文件头，返回分片表与关键帧时间轴。
 *
 * 这一步**不下任何视频数据**（64KB 里绝大部分是 moov，实际只用到 sidx）。
 *
 * @param {string} mediaUrl  playurl 给的 baseUrl（或 backupUrl）
 * @param {{timeoutMs?: number, cookieHeader?: string, log?: Function}} [opts]
 */
export async function probeStream(mediaUrl, opts = {}) {
  const log = opts.log ?? (() => {})
  const { status, buf } = await readRange(mediaUrl, 0, HEAD_BYTES - 1, opts)
  if (status !== 200 && status !== 206) {
    throw new Error(`取文件头失败：HTTP ${status}（多半是 Referer/UA 被拒）`)
  }
  const index = indexStream(buf)
  log(
    `[kf] 探测：${index.segments.length} 段 / ${index.keyframes.length} 个关键帧 / ` +
      `timescale=${index.timescale} / relocatable=${index.relocatable} / 整片 ${(index.fullSize / 1048576).toFixed(2)}MB`
  )
  return index
}

/**
 * 从关键帧表里均匀挑 `n` 个（首尾必取）。
 *
 * @param {object[]} list
 * @param {number} n
 */
export function pickEven(list, n) {
  if (!list.length || n <= 0) return []
  if (list.length <= n) return list.slice()
  if (n === 1) return [list[0]]
  const idx = []
  for (let i = 0; i < n; i++) idx.push(Math.round((i * (list.length - 1)) / (n - 1)))
  return [...new Set(idx)].map((i) => list[i])
}

/**
 * 把任意时间点吸附到最近的关键帧上（只能跳关键帧，稀疏 mp4 里没有中间帧）。
 *
 * @param {object[]} keyframes
 * @param {number[]} times
 */
export function snapToKeyframes(keyframes, times) {
  const out = []
  for (const t of times) {
    let best = keyframes[0]
    for (const k of keyframes) {
      if (Math.abs(k.start - t) < Math.abs(best.start - t)) best = k
    }
    if (best && !out.some((s) => s.offset === best.offset)) out.push(best)
  }
  return out.sort((a, b) => a.start - b.start)
}

/**
 * 组稀疏 mp4：init(ftyp+moov) + 选中分片的 (moof+mdat)。
 *
 * @param {string} mediaUrl
 * @param {{offset: number, size: number}[]} segments
 * @param {{timeoutMs?: number, cookieHeader?: string, onProgress?: Function}} [opts]
 * @returns {Promise<{buf: Buffer, bytes: number}>}
 */
export async function buildSparse(mediaUrl, segments, opts = {}) {
  const { onProgress = () => {} } = opts
  const head = await readRange(mediaUrl, 0, HEAD_BYTES - 1, opts)
  const index = indexStream(head.buf)
  const parts = [index.init]
  let bytes = index.init.length
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    const { status, buf } = await readRange(mediaUrl, s.offset, s.offset + s.size - 1, opts)
    if (status !== 200 && status !== 206) throw new Error(`取分片失败：HTTP ${status}`)
    parts.push(buf)
    bytes += buf.length
    onProgress(i + 1, segments.length, s.start)
  }
  return { buf: Buffer.concat(parts), bytes }
}

// ---------------------------------------------------------------------------
// 解码器（隐藏窗口，单例复用）
// ---------------------------------------------------------------------------

let workerPromise = null
let queue = Promise.resolve()
let jobSeq = 0

/**
 * 拿到（或懒创建）那个隐藏的解码窗口。
 * @returns {Promise<BrowserWindow>}
 */
function getWorker() {
  if (workerPromise) return workerPromise
  workerPromise = (async () => {
    if (!app.isReady()) await app.whenReady()
    const win = new BrowserWindow({
      show: false,
      width: 2,
      height: 2,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        // ★ 隐藏窗口会被节流，seek/解码会卡成龟速
        backgroundThrottling: false,
      },
    })
    win.on('closed', () => {
      workerPromise = null
    })
    win.webContents.on('render-process-gone', () => {
      workerPromise = null
    })
    await win.loadFile(HTML_PATH)
    return win
  })().catch((err) => {
    workerPromise = null
    throw err
  })
  return workerPromise
}

/** 销毁解码窗口（退出前调用可省一次进程清理）。 */
export function disposeDecoder() {
  if (!workerPromise) return
  const p = workerPromise
  workerPromise = null
  p.then((win) => {
    if (!win.isDestroyed()) win.destroy()
  }).catch(() => {})
}

/**
 * 把一帧活儿丢给隐藏窗口，串行执行（同一个窗口不能并发 seek）。
 *
 * @param {object} job
 * @returns {Promise<object>}
 */
function runJob(job) {
  const task = async () => {
    const win = await getWorker()
    const id = ++jobSeq
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener(CH_DONE, onDone)
        reject(new Error(`解码超时（${job.timeoutMs}ms）`))
      }, job.timeoutMs)

      function onDone(event, payload) {
        if (!payload || payload.id !== id) return
        clearTimeout(timer)
        ipcMain.removeListener(CH_DONE, onDone)
        resolve(payload)
      }

      ipcMain.on(CH_DONE, onDone)
      try {
        win.webContents.send(CH_JOB, { ...job, id })
      } catch (err) {
        clearTimeout(timer)
        ipcMain.removeListener(CH_DONE, onDone)
        reject(err)
      }
    })
  }
  const p = queue.then(task, task)
  queue = p.then(
    () => {},
    () => {}
  )
  return p
}

// ---------------------------------------------------------------------------
// 对外主函数
// ---------------------------------------------------------------------------

/**
 * 取关键帧。**永不抛**，失败折成 `{ok:false, error}`（与 web.mjs 的约定一致）。
 *
 * @param {object} o
 * @param {string} o.mediaUrl      playurl 的 dash.video[].baseUrl
 * @param {number[]} [o.times]     想要的时间点（秒）。会吸附到最近的关键帧
 * @param {number} [o.count]       不给 times 时，均匀取几个关键帧（默认 6）
 * @param {{w: number, h: number}} [o.maxOut]  输出上限尺寸（等比缩放）；不传=原生
 * @param {number} [o.quality]     JPEG 质量，默认 0.85
 * @param {string} [o.cookieHeader] 一般不用给：媒体直链已签名，但给了更保险
 * @param {number} [o.timeoutMs]   整趟超时，默认 60s
 * @param {Function} [o.onProgress] (已取段数, 总段数, 时间秒)
 * @param {Function} [o.log]
 * @returns {Promise<{ok: boolean, frames?: object[], stats?: object, error?: string}>}
 */
export async function extractKeyframes(o = {}) {
  const log = o.log ?? (() => {})
  const t0 = Date.now()
  const mediaUrl = String(o.mediaUrl ?? '')
  if (!/^https?:/i.test(mediaUrl)) return { ok: false, error: 'extractKeyframes：mediaUrl 不是 http(s) 地址' }

  try {
    const index = await probeStream(mediaUrl, { ...o, log })
    if (!index.keyframes.length) return { ok: false, error: '这条流没有 SAP 标记的关键帧' }
    if (!index.relocatable) {
      return {
        ok: false,
        error: `tfhd 缺 default-base-is-moof（flags=0x${(index.tfhdFlags >>> 0).toString(16)}），` +
          '丢掉中间分片会花屏；请降级用 videoshot 雪碧图',
      }
    }

    const picked = Array.isArray(o.times) && o.times.length
      ? snapToKeyframes(index.keyframes, o.times.map(Number).filter(Number.isFinite))
      : pickEven(index.keyframes, o.count ?? DEFAULT_FRAME_COUNT)
    if (!picked.length) return { ok: false, error: '没有可用的关键帧时间点' }

    const tFetch = Date.now()
    const sparse = await buildSparse(mediaUrl, picked, { ...o, onProgress: o.onProgress })
    const fetchMs = Date.now() - tFetch
    log(
      `[kf] 取 ${picked.length}/${index.segments.length} 段：` +
        `${(sparse.bytes / 1048576).toFixed(2)}MB / 整片 ${(index.fullSize / 1048576).toFixed(2)}MB ` +
        `（${((sparse.bytes / index.fullSize) * 100).toFixed(1)}%）${fetchMs}ms`
    )

    const decoded = await runJob({
      b64: sparse.buf.toString('base64'),
      times: picked.map((s) => s.start),
      maxOut: o.maxOut ?? null,
      quality: o.quality ?? DEFAULT_JPEG_QUALITY,
      timeoutMs: o.timeoutMs ?? 60_000,
    })
    if (!decoded.ok) return { ok: false, error: decoded.error || '解码失败' }

    return {
      ok: true,
      frames: decoded.frames,
      stats: {
        segmentsTotal: index.segments.length,
        segmentsUsed: picked.length,
        keyframesTotal: index.keyframes.length,
        bytes: sparse.bytes,
        fullBytes: index.fullSize,
        ratio: +(sparse.bytes / index.fullSize).toFixed(4),
        fetchMs,
        decodeMs: decoded.meta?.decodedMs ?? null,
        totalMs: Date.now() - t0,
        width: decoded.meta?.videoWidth ?? null,
        height: decoded.meta?.videoHeight ?? null,
      },
    }
  } catch (err) {
    const msg = err?.name === 'AbortError' ? '请求超时' : String(err?.message || err)
    log(`[kf] 失败：${msg}`)
    return { ok: false, error: msg }
  }
}

/**
 * 一步到位：给一段 UGC 视频的 aid/cid，自己取流再抽帧。
 *
 * ⚠️ 需要 B 站 cookie（playurl 的 `fnval=4048` 匿名也能拿到 480P，登录才有 1080P+）。
 * 这里不带 cookie 逻辑——调 `getMediaUrl` 时把 `session.cookies` 拼好的头传进来。
 *
 * @param {object} o
 * @param {number} o.aid
 * @param {number} o.cid
 * @param {(params: {aid: number, cid: number}) => Promise<string>} o.getMediaUrl
 *        宿主提供：内部去调 playurl 并挑好码流，返回 baseUrl
 * @param {object} [o.rest]  其余透传给 extractKeyframes
 */
export async function extractForVideo(o) {
  try {
    const mediaUrl = await o.getMediaUrl({ aid: o.aid, cid: o.cid })
    if (!mediaUrl) return { ok: false, error: 'getMediaUrl 没给回媒体地址' }
    return await extractKeyframes({ ...o, mediaUrl })
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}
