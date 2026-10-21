/**
 * probe/qr-verify.mjs —— 把 src/qr.mjs 编出来的矩阵导出成 JSON，供 Python 侧验收：
 *   · probe/qr-decode.py —— 主闸：用 OpenCV 解码，检查读回的文本与原文一致；
 *   · probe/qr-verify.py —— 诊断：跟 segno 做字节级对拍（两侧填充策略不同，会有差异）。
 *
 * 跑法：
 *   node probe/qr-verify.mjs
 *   python probe/qr-decode.py logs/qr-mine.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { qrMatrix } from '../src/qr.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// 覆盖：短内容 / 典型 URL / B 站那条 130 字节登录 URL / 多字节中文 / 接近容量上限
const payloads = [
  'A',
  'https://example.com',
  'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=0123456789abcdef0123456789abcdef&from=main-fe-header',
  '你好，世界',
  'x'.repeat(120),
  'y'.repeat(150),
]

const cases = []
const record = (text, ecc, mask) => {
  try {
    const q = qrMatrix(text, { ecc, mask })
    cases.push({
      text,
      ecc,
      mask: q.mask,
      autoMask: mask === -1,
      version: q.version,
      size: q.size,
      rows: q.modules.map((row) => Array.from(row, (v) => (v ? '1' : '0')).join('')),
    })
  } catch (err) {
    cases.push({ text, ecc, mask, error: String(err.message || err) })
  }
}

for (const text of payloads) {
  for (const ecc of ['L', 'M', 'Q', 'H']) {
    for (let mask = 0; mask < 8; mask += 1) record(text, ecc, mask)
    record(text, ecc, -1) // 自动挑掩码
  }
}

mkdirSync(join(ROOT, 'logs'), { recursive: true })
const out = join(ROOT, 'logs', 'qr-mine.json')
writeFileSync(out, JSON.stringify(cases))
const auto = cases.filter((c) => c.autoMask && !c.error)
console.log(`已导出 ${cases.length} 个用例（其中自动掩码 ${auto.length}）→ ${out}`)
console.log('自动掩码选择:', auto.map((c) => `v${c.version}/${c.ecc}/m${c.mask}`).join(' '))
