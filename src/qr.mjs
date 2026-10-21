/**
 * qr.mjs —— 纯 JS 二维码编码器（零依赖，只支持 byte 模式，版本 1~10）。
 *
 * 为什么自己写：设置抽屉里要画 B 站扫码登录的二维码，而 Orb 的硬约束是
 * **零依赖**（`package.json` 的 dependencies 是空的，2026-10-19 断脐时定的）。
 * B 站 `qrcode/generate` 只给一段待编码的 URL，不给图片；把这段 URL 发给
 * 第三方「在线生成二维码」服务等于把一次性登录凭据送给外人，不能这么做。
 *
 * 实现范围（够用就行，不追求全规格）：
 *   · 纠错等级 L / M / Q / H 全支持，版本按内容自动选最小可行（1~10）；
 *   · 只做 byte 模式（UTF-8 字节），B 站那段是纯 ASCII 的 URL；
 *   · 掩码按 ISO 18004 的四条罚分自动挑最优。
 *
 * 已用独立实现（Python `segno` 1.6.6）逐掩码比对过矩阵：版本 1~10 × 四个等级
 * × 8 个掩码，`probe/qr-verify.mjs` 产出、`probe/qr-verify.py` 比对，全等。
 *
 * 用法：
 *   import { qrMatrix, qrSvg } from './qr.mjs'
 *   const q = qrMatrix('https://...', { ecc: 'M' })   // { size, modules, version, mask, ecc }
 *   q.modules[y][x] === 1 表示黑点
 */

/** ISO 18004 表：每版本的总码字数（含纠错）。 */
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346]

/**
 * ISO 18004 表：每（版本, 等级）的 [每块纠错码字数, [[块数, 每块数据码字], ...]]。
 * 第二项是分组的「块数 × 每块数据码字」——组 2 的每块比组 1 多 1 个字，这是规格里
 * 唯一的不对称，写错就会在长内容上崩。
 */
const BLOCKS = {
  L: [
    [7, [[1, 19]]],
    [10, [[1, 34]]],
    [15, [[1, 55]]],
    [20, [[1, 80]]],
    [26, [[1, 108]]],
    [18, [[2, 68]]],
    [20, [[2, 78]]],
    [24, [[2, 97]]],
    [30, [[2, 116]]],
    [18, [[2, 68], [2, 69]]],
  ],
  M: [
    [10, [[1, 16]]],
    [16, [[1, 28]]],
    [26, [[1, 44]]],
    [18, [[2, 32]]],
    [24, [[2, 43]]],
    [16, [[4, 27]]],
    [18, [[4, 31]]],
    [22, [[2, 38], [2, 39]]],
    [22, [[3, 36], [2, 37]]],
    [26, [[4, 43], [1, 44]]],
  ],
  Q: [
    [13, [[1, 13]]],
    [22, [[1, 22]]],
    [18, [[2, 17]]],
    [26, [[2, 24]]],
    [18, [[2, 15], [2, 16]]],
    [24, [[4, 19]]],
    [18, [[2, 14], [4, 15]]],
    [22, [[4, 18], [2, 19]]],
    [20, [[4, 16], [4, 17]]],
    [24, [[6, 19], [2, 20]]],
  ],
  H: [
    [17, [[1, 9]]],
    [28, [[1, 16]]],
    [22, [[2, 13]]],
    [16, [[4, 9]]],
    [22, [[2, 11], [2, 12]]],
    [28, [[4, 15]]],
    [26, [[4, 13], [1, 14]]],
    [26, [[4, 14], [2, 15]]],
    [24, [[4, 12], [4, 13]]],
    [28, [[6, 15], [2, 16]]],
  ],
}

/** 对齐图形的圆心坐标（版本 1 没有对齐图形）。 */
const ALIGN = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
]

/** 纠错等级在格式信息里的两位编码。 */
const ECC_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 }

const MASK_FN = [
  (y, x) => (y + x) % 2 === 0,
  (y) => y % 2 === 0,
  (_, x) => x % 3 === 0,
  (y, x) => (y + x) % 3 === 0,
  (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
  (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
  (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
]

/** byte 模式的字符计数位数（版本 1~9 是 8 位，10 起 16 位）。 */
function countBits(version) {
  return version <= 9 ? 8 : 16
}

/** 内容能塞进版本 v、等级 ecc 吗（byte 模式，含 4 位模式指示与计数位）。 */
function fits(version, ecc, byteLength) {
  const [, groups] = BLOCKS[ecc][version - 1]
  let dataCodewords = 0
  for (const [n, per] of groups) dataCodewords += n * per
  const capacityBits = dataCodewords * 8
  const needBits = 4 + countBits(version) + byteLength * 8
  return needBits <= capacityBits
}

/** 挑最小的可行版本。 */
function pickVersion(byteLength, ecc, minVersion) {
  for (let v = Math.max(1, minVersion); v <= TOTAL_CODEWORDS.length; v += 1) {
    if (fits(v, ecc, byteLength)) return v
  }
  return 0
}

// ── GF(256) 与 RS 纠错 ────────────────────────────────────

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

/** 生成多项式 ∏(x - a^i)，i=0..degree-1，系数从高次到低次。 */
function generatorPoly(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly // 长度 degree+1，首项恒为 1
}

/** 对一段数据码字算 degree 个纠错码字。 */
function rsEncode(data, degree) {
  const gen = generatorPoly(degree)
  const rem = new Uint8Array(degree)
  for (const byte of data) {
    const factor = byte ^ rem[0]
    rem.copyWithin(0, 1)
    rem[degree - 1] = 0
    if (factor !== 0) {
      for (let i = 0; i < degree; i += 1) {
        rem[i] ^= gfMul(gen[i + 1], factor)
      }
    }
  }
  return rem
}

// ── 位流 ─────────────────────────────────────────────────

function buildBitStream(bytes, version, ecc) {
  const [, groups] = BLOCKS[ecc][version - 1]
  let dataCodewords = 0
  for (const [n, per] of groups) dataCodewords += n * per
  const capacityBits = dataCodewords * 8

  const bits = []
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4) // byte 模式
  push(bytes.length, countBits(version))
  for (const b of bytes) push(b, 8)

  // 终结符最多 4 位，然后补齐到字节边界。
  const terminator = Math.min(4, capacityBits - bits.length)
  push(0, terminator)
  while (bits.length % 8 !== 0) bits.push(0)

  const codewords = []
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0
    for (let j = 0; j < 8; j += 1) v = (v << 1) | bits[i + j]
    codewords.push(v)
  }
  // 填充码字 0xEC / 0x11 交替。
  const pad = [0xec, 0x11]
  let k = 0
  while (codewords.length < dataCodewords) {
    codewords.push(pad[k % 2])
    k += 1
  }
  return codewords
}

/** 分块算纠错，再按规格交织成最终码字序列。 */
function interleave(dataCodewords, version, ecc) {
  const [eccPerBlock, groups] = BLOCKS[ecc][version - 1]
  const dataBlocks = []
  const eccBlocks = []
  let offset = 0
  for (const [n, per] of groups) {
    for (let i = 0; i < n; i += 1) {
      const block = dataCodewords.slice(offset, offset + per)
      offset += per
      dataBlocks.push(block)
      eccBlocks.push(rsEncode(block, eccPerBlock))
    }
  }

  const out = []
  const maxData = Math.max(...dataBlocks.map((b) => b.length))
  for (let i = 0; i < maxData; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) out.push(block[i])
    }
  }
  for (let i = 0; i < eccPerBlock; i += 1) {
    for (const block of eccBlocks) out.push(block[i])
  }
  return out
}

// ── 矩阵 ─────────────────────────────────────────────────

function createMatrix(size) {
  const modules = []
  for (let y = 0; y < size; y += 1) modules.push(new Uint8Array(size).fill(0))
  const reserved = []
  for (let y = 0; y < size; y += 1) reserved.push(new Uint8Array(size).fill(0))
  return { size, modules, reserved }
}

function setModule(m, y, x, dark) {
  m.modules[y][x] = dark ? 1 : 0
  m.reserved[y][x] = 1
}

function placeFinder(m, cy, cx) {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const y = cy + dy
      const x = cx + dx
      if (y < 0 || y >= m.size || x < 0 || x >= m.size) continue
      const dist = Math.max(Math.abs(dy), Math.abs(dx))
      // 7×7 回字 + 一圈白分隔（dist 4）
      const dark = dist !== 2 && dist !== 4
      setModule(m, y, x, dark)
    }
  }
}

function placeAlignment(m, cy, cx) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const dist = Math.max(Math.abs(dy), Math.abs(dx))
      setModule(m, cy + dy, cx + dx, dist !== 1)
    }
  }
}

function placeTiming(m) {
  for (let i = 8; i < m.size - 8; i += 1) {
    if (m.reserved[6][i] === 0) setModule(m, 6, i, i % 2 === 0)
    if (m.reserved[i][6] === 0) setModule(m, i, 6, i % 2 === 0)
  }
}

/** 版本信息（版本 ≥7）：6 位 + BCH(18,6)，两处 3×6。 */
function placeVersionInfo(m, version) {
  if (version < 7) return
  // 6 位版本号 + BCH(18,6)，生成多项式 0x1F25。
  let rem = version << 12
  for (let i = 17; i >= 12; i -= 1) {
    if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12)
  }
  const word = (version << 12) | rem

  for (let i = 0; i < 18; i += 1) {
    const bit = (word >>> i) & 1
    const a = Math.floor(i / 3) // 0..5
    const b = i % 3 // 0..2
    // 左下是 6 行 × 3 列，右上是 3 行 × 6 列（互为转置）。
    setModule(m, m.size - 11 + b, a, bit)
    setModule(m, a, m.size - 11 + b, bit)
  }
}

/** 格式信息：2 位等级 + 3 位掩码 + BCH(15,5)，异或 0x5412。 */
function formatWord(ecc, mask) {
  const data = (ECC_BITS[ecc] << 3) | mask
  let rem = data << 10
  for (let i = 14; i >= 10; i -= 1) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10)
  }
  return ((data << 10) | rem) ^ 0x5412
}

function placeFormatInfo(m, ecc, mask, size) {
  const word = formatWord(ecc, mask)
  const bit = (i) => (word >>> i) & 1

  // 第一份：竖着贴左上角的第 8 列 + 横着贴第 8 行（ISO 里这两段是错位的，
  // 抄的时候最容易被「对称」骗过去——写成 x/y 互换，格式位就整块搬错了）。
  for (let i = 0; i <= 5; i += 1) setModule(m, i, 8, bit(i))
  setModule(m, 7, 8, bit(6))
  setModule(m, 8, 8, bit(7))
  setModule(m, 8, 7, bit(8))
  for (let i = 9; i <= 14; i += 1) setModule(m, 8, 14 - i, bit(i))

  // 第二份：右上沿第 8 行，左下沿第 8 列
  for (let i = 0; i <= 7; i += 1) setModule(m, 8, size - 1 - i, bit(i))
  for (let i = 8; i <= 14; i += 1) setModule(m, size - 15 + i, 8, bit(i))

  // 固定的黑点
  setModule(m, size - 8, 8, true)
}

/** 数据区按两列一组、蛇形从右下往上填。 */
function placeData(m, codewords) {
  let bitIndex = 0
  const totalBits = codewords.length * 8
  const readBit = () => {
    if (bitIndex >= totalBits) return 0
    const byte = codewords[bitIndex >> 3]
    const bit = (byte >>> (7 - (bitIndex & 7))) & 1
    bitIndex += 1
    return bit
  }

  let upward = true
  for (let right = m.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5 // 跳过竖向定时图形那一列
    for (let i = 0; i < m.size; i += 1) {
      const y = upward ? m.size - 1 - i : i
      for (let c = 0; c < 2; c += 1) {
        const x = right - c
        if (m.reserved[y][x] === 1) continue
        m.modules[y][x] = readBit()
      }
    }
    upward = !upward
  }
}

function applyMask(m, mask) {
  const fn = MASK_FN[mask]
  for (let y = 0; y < m.size; y += 1) {
    for (let x = 0; x < m.size; x += 1) {
      if (m.reserved[y][x] === 1) continue
      if (fn(y, x)) m.modules[y][x] ^= 1
    }
  }
}

// ── 罚分（ISO 18004 §8.8.2）───────────────────────────────

function penalty(modules, size) {
  let score = 0

  // N1：同一行/列里连续 5 个以上同色
  for (let i = 0; i < size; i += 1) {
    for (const axis of ['row', 'col']) {
      let run = 1
      let prev = axis === 'row' ? modules[i][0] : modules[0][i]
      for (let j = 1; j < size; j += 1) {
        const cur = axis === 'row' ? modules[i][j] : modules[j][i]
        if (cur === prev) {
          run += 1
        } else {
          if (run >= 5) score += 3 + (run - 5)
          run = 1
          prev = cur
        }
      }
      if (run >= 5) score += 3 + (run - 5)
    }
  }

  // N2：2×2 同色块
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const v = modules[y][x]
      if (v === modules[y][x + 1] && v === modules[y + 1][x] && v === modules[y + 1][x + 1]) {
        score += 3
      }
    }
  }

  // N3：1:1:3:1:1 的类定位图形，且一侧有 4 个浅色
  const pattern = [1, 0, 1, 1, 1, 0, 1]
  const check = (get, len) => {
    for (let i = 0; i + 11 <= len; i += 1) {
      let okA = true
      let okB = true
      for (let k = 0; k < 7; k += 1) {
        if (get(i + 4 + k) !== pattern[k]) okA = false
        if (get(i + k) !== pattern[k]) okB = false
      }
      if (okA) {
        let light = 0
        for (let k = 0; k < 4; k += 1) {
          if (i + 4 + 7 + k < len) light += get(i + 4 + 7 + k) === 0 ? 1 : 0
          else light += 1
        }
        if (light === 4) score += 40
      }
      if (okB) {
        let light = 0
        for (let k = 1; k <= 4; k += 1) {
          if (i - k >= 0) light += get(i - k) === 0 ? 1 : 0
          else light += 1
        }
        if (light === 4) score += 40
      }
    }
  }
  for (let i = 0; i < size; i += 1) {
    check((j) => modules[i][j], size)
    check((j) => modules[j][i], size)
  }

  // N4：黑点比例偏离 50%
  let dark = 0
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) dark += modules[y][x] === 1 ? 1 : 0
  }
  const ratio = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10

  return score
}

/**
 * 把文本编成二维码矩阵。
 *
 * @param {string} text UTF-8 文本
 * @param {{ecc?: 'L'|'M'|'Q'|'H', version?: number, mask?: number, minVersion?: number}} [opts]
 *        version=0 自动挑；mask=-1 按罚分自动挑
 * @returns {{size:number, modules:Uint8Array[], version:number, mask:number, ecc:string}}
 */
export function qrMatrix(text, opts = {}) {
  const ecc = String(opts.ecc ?? 'M').toUpperCase()
  if (!BLOCKS[ecc]) throw new Error(`不支持的纠错等级：${ecc}（可用 L/M/Q/H）`)
  const bytes = Array.from(Buffer.from(String(text), 'utf8'))

  let version = Number(opts.version) || 0
  if (version === 0) {
    version = pickVersion(bytes.length, ecc, Number(opts.minVersion) || 1)
    if (version === 0) throw new Error(`内容太长（${bytes.length} 字节），超出了版本 10 的容量`)
  } else if (!fits(version, ecc, bytes.length)) {
    throw new Error(`内容 ${bytes.length} 字节塞不进版本 ${version}（${ecc} 级）`)
  }

  const size = 17 + 4 * version
  const dataCodewords = buildBitStream(bytes, version, ecc)
  const codewords = interleave(dataCodewords, version, ecc)

  const build = (mask) => {
    const m = createMatrix(size)
    placeFinder(m, 3, 3)
    placeFinder(m, 3, size - 4)
    placeFinder(m, size - 4, 3)
    const centers = ALIGN[version - 1]
    for (const cy of centers) {
      for (const cx of centers) {
        // 与三个定位图形重叠的位置不放对齐图形
        const near = (a, b) => Math.abs(a - b) <= 2
        if ((near(cy, 6) && near(cx, 6)) || (near(cy, 6) && near(cx, size - 7)) || (near(cy, size - 7) && near(cx, 6))) {
          continue
        }
        placeAlignment(m, cy, cx)
      }
    }
    placeTiming(m)
    placeVersionInfo(m, version)
    placeFormatInfo(m, ecc, mask, size)
    placeData(m, codewords)
    applyMask(m, mask)
    // 格式信息在掩码之后补一遍：掩码会跳过 reserved 区，但格式位也属于 reserved，
    // 顺序在前的 placeFormatInfo 已经把 reserved 标好了，这里不需要重画。
    return m
  }

  let mask = Number.isInteger(opts.mask) ? opts.mask : -1
  if (mask < 0) {
    let best = 0
    let bestScore = Infinity
    for (let i = 0; i < 8; i += 1) {
      const m = build(i)
      const score = penalty(m.modules, size)
      if (score < bestScore) {
        bestScore = score
        best = i
      }
    }
    mask = best
  }

  const final = build(mask)
  return { size, modules: final.modules, version, mask, ecc }
}

/**
 * 出 SVG 字符串（设置面板里直接塞进 `<div>` 就行，比 canvas 省事、任意缩放都清楚）。
 * `scale` 是每个模块几像素；`margin` 是静区模块数（规格要求 ≥4）。
 */
export function qrSvg(text, opts = {}) {
  const q = qrMatrix(text, opts)
  const scale = Number(opts.scale) || 4
  const margin = Number.isInteger(opts.margin) ? opts.margin : 4
  const dim = (q.size + margin * 2) * scale
  const dark = typeof opts.dark === 'string' ? opts.dark : '#111'
  const light = typeof opts.light === 'string' ? opts.light : '#fff'

  const rects = []
  for (let y = 0; y < q.size; y += 1) {
    let x = 0
    while (x < q.size) {
      if (q.modules[y][x] !== 1) {
        x += 1
        continue
      }
      let run = 0
      while (x + run < q.size && q.modules[y][x + run] === 1) run += 1
      rects.push(
        `<rect x="${(x + margin) * scale}" y="${(y + margin) * scale}" width="${run * scale}" height="${scale}"/>`,
      )
      x += run
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<g fill="${dark}">${rects.join('')}</g></svg>`
  )
}
