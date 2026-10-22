/**
 * 直连 DeepSeek API 的视觉能力测试（绕过 letta）：
 * 把程序生成、内容已知的 PNG 用 OpenAI 多模态形状直接 POST 给
 * https://api.deepseek.com/v1/chat/completions（model=deepseek-flash）。
 *
 * 目的：区分「问题在 letta 模型元数据（input 缺 image）」还是
 *       「DeepSeek API 本身不收图」。
 *   - API 收图且答出颜色/形状 → letta 侧元数据是瓶颈（改 letta 侧）。
 *   - API 报错（如 "image" not supported）→ 此端点根本无视觉，需换模型/换法。
 *
 * 跑法：`node probe/api-vision-direct.mjs`
 */
/**
 * ⚠️ 2026-10-22 开源前审计：这里原本**硬编码了一个真实 DeepSeek API key**
 *    （`sk-ea94…`），而且已经随提交 `b48b638`（baseline 备份点）进入 git 历史。
 *    ⇒ 已改为从环境变量读。**历史清理必须单独做**（删文件里的值不够，
 *      旧提交里还留着，push 上去等于公开）。处置记录见
 *      内部问题清单 §16（该文档不进公开仓库）。
 *    永远不要把真 key 写进被 git 跟踪的文件 —— 探针也不例外。
 *
 * 跑法：`DEEPSEEK_API_KEY=sk-xxx node probe/api-vision-direct.mjs`
 */
import { deflateSync } from 'node:zlib'

const KEY = process.env.DEEPSEEK_API_KEY || ''
if (KEY === '') {
  console.error('缺 DEEPSEEK_API_KEY。跑法：DEEPSEEK_API_KEY=sk-xxx node probe/api-vision-direct.mjs')
  process.exit(2)
}
const URL = 'https://api.deepseek.com/v1/chat/completions'

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function makeTestPng(w = 96, h = 96) {
  const raw = Buffer.alloc(h * (1 + w * 3))
  let p = 0
  for (let y = 0; y < h; y++) {
    raw[p++] = 0
    for (let x = 0; x < w; x++) {
      const red = Math.hypot(x - 28, y - 48) <= 22
      const blue = x >= 58 && x <= 82 && y >= 34 && y <= 62
      if (red) { raw[p++] = 230; raw[p++] = 30; raw[p++] = 30 }
      else if (blue) { raw[p++] = 30; raw[p++] = 80; raw[p++] = 230 }
      else { raw[p++] = 250; raw[p++] = 250; raw[p++] = 250 }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const png = makeTestPng()
const b64 = png.toString('base64')
console.log(`PNG bytes=${png.length}, b64=${b64.length}`)

const payload = {
  model: 'deepseek-flash',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张图里画了什么？只回答颜色和形状，一句话。' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      ],
    },
  ],
}

const res = await fetch(URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify(payload),
})
const text = await res.text()
console.log(`HTTP ${res.status}`)
if (!res.ok) {
  console.log('ERROR BODY:')
  console.log(text.slice(0, 2000))
  process.exit(1)
}
const json = JSON.parse(text)
const reply = json?.choices?.[0]?.message?.content ?? '(no content)'
console.log('REPLY:', reply)
const hit = /(红|圆|蓝|方块|颜色|形状|white|red|blue|circle|square)/i.test(reply)
console.log(hit ? '✅ API 收图且模型看得见（问题在 letta 元数据侧）' : '⚠️ API 未收图或回复不含图内容')
