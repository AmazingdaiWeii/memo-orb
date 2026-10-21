/**
 * 轻量图片压缩：canvas 重绘 + 逐档降质。**零依赖**。
 *
 * ★ 为什么不用 `browser-image-compression`：
 *   WorkBuddy 用它（`browser-image-compression-CLuLOoPU.js`，52 KB），
 *   但 orb 的铁律之一是**轻量化**，而这个库的能力里我们用不到的多
 *   （多线程池、EXIF 旋转矩阵、并发限流、webp 探测）。
 *   orb 只需要「缩到某尺寸 + 某个 jpeg 质量 + 输出 Blob」，`canvas.toBlob` 一行搞定。
 *   省掉一个运行时依赖，也省掉 `helper/assets/vendor/` 里 50 KB 的第三方代码。
 *
 * ⚠️ **必须跑在渲染进程**（要 DOM/canvas）。主进程没有 canvas。
 *
 * ⚠️ **EXIF 方向**：现代浏览器 `createImageBitmap(blob, {imageOrientation:'from-image'})`
 *    会自动应用方向，所以这里用它而不是 `new Image()` —— 否则手机竖拍的照片会躺倒。
 */

/**
 * @param {Blob|File} file
 * @param {{maxSizeMB?:number, maxWidthOrHeight?:number, initialQuality?:number, fileType?:string}} opts
 * @returns {Promise<Blob>}
 */
export default async function compress(file, opts = {}) {
  const {
    maxWidthOrHeight = 1920,
    initialQuality = 0.85,
    fileType = 'image/jpeg',
  } = opts

  const bitmap = await decode(file, maxWidthOrHeight)
  const { width, height } = bitmap
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('拿不到 canvas 2d 上下文')
  // 转 jpeg 会把透明区变黑，先铺白底（截图带 alpha 时很常见）
  if (fileType === 'image/jpeg') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
  }
  ctx.drawImage(bitmap, 0, 0, width, height)
  if (typeof bitmap.close === 'function') bitmap.close()

  let quality = initialQuality
  let blob = await toBlob(canvas, fileType, quality)
  // toBlob 的质量是「建议值」，小图上可能仍偏大 —— 再压两轮就够
  for (let i = 0; i < 2 && blob && blob.size > (opts.maxSizeMB ?? 0.5) * 1048576 && quality > 0.4; i++) {
    quality = Math.max(0.4, quality - 0.15)
    const next = await toBlob(canvas, fileType, quality)
    if (!next || next.size >= blob.size) break
    blob = next
  }
  if (!blob) throw new Error('canvas.toBlob 返回空')
  // 保持文件名可读性：压缩库返回的是不带 name 的 Blob，这里补一个 File
  const name = String(file.name ?? 'image').replace(/\.[^.]+$/, '') + extFor(fileType)
  return new File([blob], name, { type: fileType, lastModified: Date.now() })
}

async function decode(file, maxEdge) {
  if (typeof createImageBitmap === 'function') {
    try {
      // from-image：让浏览器替我们处理 EXIF 方向
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return await shrink(bmp, maxEdge)
    } catch {
      /* 落到下面的 Image 兜底 */
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('图片解码失败'))
      el.src = url
    })
    return await shrink(img, maxEdge)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** 超过最大边就先等比缩一次，避免把 8000px 的图原样塞进 canvas（会炸内存）。 */
async function shrink(src, maxEdge) {
  const sw = src.width || src.naturalWidth || 0
  const sh = src.height || src.naturalHeight || 0
  if (!sw || !sh) return src
  const longest = Math.max(sw, sh)
  if (longest <= maxEdge) return src
  const scale = maxEdge / longest
  const w = Math.max(1, Math.round(sw * scale))
  const h = Math.max(1, Math.round(sh * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('拿不到 canvas 2d 上下文')
  ctx.drawImage(src, 0, 0, w, h)
  if (typeof src.close === 'function') src.close()
  const blob = await toBlob(canvas, 'image/png', 1)
  if (!blob) throw new Error('缩放失败')
  return await createImageBitmap(blob)
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), type, quality)
  })
}

function extFor(type) {
  if (type === 'image/webp') return '.webp'
  if (type === 'image/png') return '.png'
  return '.jpg'
}
