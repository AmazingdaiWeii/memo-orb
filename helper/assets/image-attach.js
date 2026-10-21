/**
 * 图片附件：采集 → 压缩 → 缩略图 → base64。
 *
 * 实现参照 **WorkBuddy 对话框发图**的做法（逆向记录见 `参考-WorkBuddy图片实现.md`）。
 * 抄的是**分层**与**参数**，不是它的代码 —— 它那套还挂着云上传/netdrive，
 * orb 没有云，砍掉整条队列层只留四步。
 *
 * ★ 为什么压缩放在渲染层：`browser-image-compression` 靠 Web Worker + canvas，
 *   主进程没有 DOM。所以这个模块在 `helper/assets/`，不在 `src/`。
 *
 * ★ 为什么「发的时候才转 base64」：一张 4MB 的图转 base64 要 ≈5.3MB 常驻内存，
 *   挂在块上直到发送。WorkBuddy 也是这个顺序（`h$t` 在提交路径上才被调）。
 *   我们保留这个顺序，但**压缩在入框时就做**（那才是真正的省内存点）。
 */

/** 压缩目标：512 KB。数值直接照抄 WorkBuddy（`tS = 512e3`）。 */
const TARGET_BYTES = 512 * 1024
/** 超过这个大小放弃压缩 —— 解码本身就可能卡死页面。 */
const GIVE_UP_BYTES = 50 * 1024 * 1024
/** 已经不压缩也够小的，直接原样用（不做无谓重编码，保真 + 省 CPU）。 */
const SKIP_UNDER_BYTES = TARGET_BYTES
/** 这两类输出不再二次转码（WorkBuddy 的 `FWe`）。 */
const NO_RECODE_TYPES = new Set(['image/jpeg', 'image/webp'])
/** 三档逐级降级：依次试，哪档 ≤512KB 就停（WorkBuddy 的 `IWe`）。 */
const LADDER = [
  { maxWidthOrHeight: 1920, initialQuality: 0.85 },
  { maxWidthOrHeight: 1440, initialQuality: 0.7 },
  { maxWidthOrHeight: 1080, initialQuality: 0.55 },
]

/** 单条消息最多挂几张。防止手滑粘一整屏。 */
export const MAX_ATTACHMENTS = 6

let compressorPromise = null
/** 懒加载压缩库：没粘过图就不该为它付启动成本。 */
function loadCompressor() {
  if (!compressorPromise) {
    compressorPromise = import('./vendor/image-compression.js')
      .then((m) => m.default ?? m.compress)
      .catch((err) => {
        compressorPromise = null // 允许下次重试
        throw err
      })
  }
  return compressorPromise
}

export function isImageFile(file) {
  if (!file) return false
  const type = String(file.type ?? '')
  if (type.startsWith('image/') && type !== 'image/svg+xml') return true
  // 截图 / 部分剪贴板来源不带 type，只能看扩展名兜底
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(file.name ?? ''))
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1048576).toFixed(2)}MB`
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

/** 把 dataURL 转成 Blob，喂给压缩库（它要 File/Blob，不吃 dataURL）。 */
function dataURLToFile(dataURL, name, type) {
  const comma = dataURL.indexOf(',')
  if (comma < 0) return null
  const bin = atob(dataURL.slice(comma + 1))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type })
}

/**
 * 压缩一张图。**三档依次试，任一步 ≤512KB 立即返回**；都不行就返回「试过的最小那张」。
 *
 * @returns {Promise<{blob: Blob, mimeType: string, width?: number, height?: number,
 *                    originalBytes: number, finalBytes: number, compressed: boolean,
 *                    reachedTarget: boolean, attempts: number}>}
 */
export async function compressImage(file) {
  const originalBytes = file.size
  const base = {
    mimeType: file.type || 'image/png',
    originalBytes,
    finalBytes: originalBytes,
    compressed: false,
    reachedTarget: true,
    attempts: 0,
  }

  if (!isImageFile(file)) return { ...base, blob: file }
  if (originalBytes <= SKIP_UNDER_BYTES) return { ...base, blob: file }
  if (originalBytes > GIVE_UP_BYTES) {
    // 解不动就别硬解 —— 会卡住整个渲染进程
    return { ...base, blob: file, reachedTarget: false }
  }

  let compress
  try {
    compress = await loadCompressor()
  } catch {
    // 压缩库没加载上就退回原图：能发总比发不出去强
    return { ...base, blob: file, reachedTarget: false }
  }

  let best = file
  let bestSize = originalBytes
  let attempts = 0
  for (const step of LADDER) {
    attempts += 1
    try {
      const out = await compress(file, {
        maxSizeMB: TARGET_BYTES / 1048576,
        maxWidthOrHeight: step.maxWidthOrHeight,
        initialQuality: step.initialQuality,
        useWebWorker: true,
        fileType: NO_RECODE_TYPES.has(file.type) ? undefined : 'image/jpeg',
      })
      if (out.size < bestSize) {
        best = out
        bestSize = out.size
      }
      if (out.size <= TARGET_BYTES) {
        return {
          ...base,
          blob: best,
          mimeType: best.type || 'image/jpeg',
          finalBytes: bestSize,
          compressed: best !== file,
          reachedTarget: true,
          attempts,
        }
      }
    } catch {
      // 单档失败不致命，继续试更小的一档
    }
  }
  return {
    ...base,
    blob: best,
    mimeType: best.type || 'image/jpeg',
    finalBytes: bestSize,
    compressed: best !== file,
    reachedTarget: false,
    attempts,
  }
}

/**
 * 从剪贴板/拖拽事件里把图片文件掏出来。
 *
 * WorkBuddy 的做法（`zYt`）：遍历 `items`，`kind === 'file'` 才 `getAsFile()`。
 * 剪贴板里带文本+图片时两者并存，所以**不能只看 `files`**。
 */
export function pickImageFiles(dataTransferLike) {
  const out = []
  const items = dataTransferLike?.items
  if (items && typeof items.length === 'number') {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item?.kind !== 'file') continue
      const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null
      if (file && isImageFile(file)) out.push(file)
    }
  }
  // items 拿不到时退回 files（某些来源只有 files）
  if (out.length === 0) {
    const files = dataTransferLike?.files
    if (files && typeof files.length === 'number') {
      for (let i = 0; i < files.length; i++) {
        if (isImageFile(files[i])) out.push(files[i])
      }
    }
  }
  return out
}

/**
 * 一张图走完全流程，产出挂到输入框上的「块」。
 *
 * ★ 缩略图用 `objectURL` 而不是 dataURL：dataURL 会把整张压缩图常驻内存，
 *   而缩略图只需要能显示。`objectURL` 是浏览器侧的引用，用完必须 revoke。
 */
export async function prepareAttachment(file) {
  const result = await compressImage(file)
  const thumbURL = URL.createObjectURL(result.blob)
  let dataURL = ''
  return {
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || 'image.png',
    thumbURL,
    blob: result.blob,
    mimeType: result.mimeType,
    originalBytes: result.originalBytes,
    finalBytes: result.finalBytes,
    compressed: result.compressed,
    reachedTarget: result.reachedTarget,
    /** 发送时才真正读成 base64（延迟转码，与 WorkBuddy 同序）。 */
    async toBase64() {
      if (dataURL === '') dataURL = await readAsDataURL(result.blob)
      const comma = dataURL.indexOf(',')
      return comma < 0 ? '' : dataURL.slice(comma + 1)
    },
    /** 移除时释放 —— 不 revoke 会一直占着内存（本项目对资源泄漏很敏感）。 */
    dispose() {
      try {
        URL.revokeObjectURL(thumbURL)
      } catch {
        /* 已释放就忽略 */
      }
    },
  }
}

export { formatBytes }
