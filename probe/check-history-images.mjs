/**
 * A 档断言（P2-4 补 / V6 修复）：历史回放的图片元数据 + 按需取原图。
 *
 * 为什么是 A 档：这两条链路（`readConversationBlocks` 里的 imageCount、
 * `readMessageImages` 取本体）全是**纯函数式磁盘读**，可以在 Node 里直接断言，
 * 不需要 GUI。球侧那一半（点占位 → 画真图）只能 B/C 档看。
 *
 * 判据（冻结）：
 *   A1 至少一条真实会话里，user 块带 `imageCount >= 1`（V6 故障的直接反面）；
 *   A2 由该块 key 推出的 messageId 能取回 1 张以上图，且 base64 非空、mime 像 image/*；
 *   A3 编造的 messageId 返回空/null（不误命中、不乱读）。
 *
 * 用法：node probe/check-history-images.mjs [convId]
 */
import { listConversations, readConversationBlocks, readMessageImages } from '../src/history.mjs'

const want = process.argv[2] ?? ''
const rows = listConversations() ?? []
if (rows.length === 0) {
  // ⚠️ 2026-10-21：这是**环境缺失**（本机 data/conversations 是空的），
  //   不是产品坏了。判成 FAIL 会让「探针矩阵全绿」这个信号失真 ——
  //   真回归和环境问题必须能一眼分开。
  //   跑法不变：先有会话再跑；或直接传一个 convId 进来。
  console.log('SKIP 没有会话可查（listConversations 为空）—— 先用orb 聊一轮再跑，或传入 convId')
  process.exit(0)
}
const ids = rows.map((r) => r.sessionId ?? r.id ?? '').filter(Boolean)
const order = want === '' ? ids : [want, ...ids.filter((i) => i !== want)]

let a1 = false
let a2 = false
let a3 = false
let hitConv = ''
let hitKey = ''
let hitMessageId = ''

for (const id of order) {
  const loaded = readConversationBlocks(id)
  if (!loaded) continue
  for (const b of loaded.blocks) {
    if (b.kind !== 'user') continue
    const n = Number(b.imageCount) || 0
    if (n <= 0) continue
    a1 = true
    hitConv = id
    hitKey = b.key
    hitMessageId = b.key.startsWith('u:') ? b.key.slice(2) : ''
    const images = readMessageImages(id, hitMessageId)
    if (Array.isArray(images) && images.length > 0) {
      const ok = images.every((im) => typeof im.data === 'string' && im.data.length > 100 && /^image\//.test(im.mimeType))
      a2 = ok
      console.log(`[A2] conv=${id} key=${b.key} imageCount=${n} 取回=${images.length} 张 mime=${images.map((i) => i.mimeType).join(',')} base64长度=${images.map((i) => i.data.length).join(',')} → ${ok ? 'PASS' : 'FAIL'}`)
    } else {
      console.log(`[A2] conv=${id} key=${b.key} imageCount=${n} → readMessageImages 返回 ${JSON.stringify(images)} FAIL`)
    }
    break
  }
  if (a1) break
}

const bogus = hitConv === '' ? null : readMessageImages(hitConv, 'ui-msg-999999')
a3 = bogus === null || (Array.isArray(bogus) && bogus.length === 0)
console.log(`[A3] 编造 messageId → ${JSON.stringify(bogus)} → ${a3 ? 'PASS' : 'FAIL'}`)

console.log(`[A1] ${a1 ? `PASS 命中 conv=${hitConv} key=${hitKey}` : 'FAIL 没有任何 user 块带 imageCount'}`)
console.log(`[A2] ${a2 ? 'PASS' : 'FAIL'}`)
console.log(`[A3] ${a3 ? 'PASS' : 'FAIL'}`)
console.log(a1 && a2 && a3 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(a1 && a2 && a3 ? 0 : 1)
