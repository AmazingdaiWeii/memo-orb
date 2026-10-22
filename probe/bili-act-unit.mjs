/**
 * probe/bili-act-unit.mjs · 「替他去点赞/投币/收藏」接线自检（无头、不联网、不花钱）
 *
 * 验的是四件事：
 *   1. `bili_act` 工具**只在宿主给了执行器时**才出现（没有就不能出现，否则她会去调一个不存在的工具）。
 *   2. 工具指南同一口径：`biliAct` 为 false 时，指南里**一个字都不能提**「替他去投币」。
 *   3. 枚举与上限：action 只有 like/coin/fav（**没有 comment** —— 公开发言必须用户点头）。
 *   4. 错误码口径：`-401` 必须翻成「B 站不让给这条稿件操作」，**不许**再吐「非法访问」
 *      （2026-10-22 实测：-401 是逐条稿件的拒绝，不是登录/风控；照原文吐会让人以为是我们的 bug）。
 *
 * 跑法：`node probe\bili-act-unit.mjs`
 * 不写任何 data/，不读 config，纯函数级。
 */
import { buildTools } from '../src/brain.mjs'
import { buildToolGuide, GUIDE_VERSION } from '../src/snapshot.mjs'
import { explainCode } from '../src/bili-actions.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const names = (list) => list.map((t) => t?.function?.name)

// ── 1. 工具列表由布尔量驱动 ────────────────────────────────────────────────
const withAct = buildTools({ biliAct: true })
const withoutAct = buildTools({ biliAct: false })
check('B1 给了 biliAct ⇒ 工具列表里有 bili_act', names(withAct).includes('bili_act'), JSON.stringify(names(withAct)))
check('B2 没给 biliAct ⇒ 工具列表里没有 bili_act', !names(withoutAct).includes('bili_act'), JSON.stringify(names(withoutAct)))

// ── 2. 枚举与字段 ─────────────────────────────────────────────────────────
const schema = withAct.find((t) => t.function.name === 'bili_act')?.function?.parameters
const actionEnum = schema?.properties?.action?.enum || []
check(
  'B3 action 枚举只有 like / coin / fav（**没有 comment**：公开发言必须用户点头）',
  actionEnum.length === 3 && actionEnum.join(',') === 'like,coin,fav',
  actionEnum.join(','),
)
check(
  'B4 bvid 与 action 都是必填（少一个就该被 schema 挡住）',
  Array.isArray(schema?.required) && schema.required.includes('bvid') && schema.required.includes('action'),
  JSON.stringify(schema?.required),
)
check(
  'B5 count 只在投币时有意义（描述里点名 coin）',
  /coin/.test(String(schema?.properties?.count?.description || '')),
  String(schema?.properties?.count?.description || ''),
)

// ── 3. 指南同口径 ─────────────────────────────────────────────────────────
const guideOn = buildToolGuide({ bili: true, biliAct: true })
const guideOff = buildToolGuide({ bili: true, biliAct: false })
check('B6 有 biliAct ⇒ 指南里有「赞 / 币 / 藏」那一节', /替他去点|替他点/.test(guideOn) && /bili_act/.test(guideOn))
check('B7 没 biliAct ⇒ 指南里**一个字都不提** bili_act（否则她会照着一个不存在的工具说话）', !/bili_act/.test(guideOff))
check('B8 指南写清「投币花他的硬币」，别让她默默扣钱', /硬币/.test(guideOn))

// ── 4. 错误码口径 ─────────────────────────────────────────────────────────
const e401 = explainCode(-401, '非法访问')
const e34003 = explainCode(34003, '非法的投币数量')
const e111 = explainCode(-111, 'CSRF 校验失败')
check('B9 -401 翻成「B 站不让给这条稿件操作」', /不让给这条稿件/.test(e401), e401)
check('B10 -401 不许再吐「非法访问」四个字（会让人以为是我们的 bug）', !/非法访问/.test(e401), e401)
check('B11 34003 是「数量不对」，别写成「被限流」', /数量/.test(e34003), e34003)
check('B12 反向对照：-111 仍然指 csrf（B9 不是把所有码都改成同一句话）', /csrf/i.test(e111), e111)

// ── 5. 指南版本必须跟着变（不然老会话继续用旧快照） ─────────────────────────
check('B13 GUIDE_VERSION 已经抬到 11 以后（这一轮加了 bili_act + 「轻松看」）', GUIDE_VERSION >= 11, String(GUIDE_VERSION))
check(
  'B14 指南里写了「轻松看」这一档（否则她会一直只想到取帧，字幕能力形同不存在）',
  /mode:"subtitle"/.test(buildToolGuide({ bili: true })),
  '指南 B 站段必须点名 mode:"subtitle"',
)
check(
  'B15 指南点明了「字幕 ≠ 画面」（读字不等于看见，别让她把字幕说成画面）',
  /字幕是文字稿/.test(buildToolGuide({ bili: true })),
)

console.log('')
console.log(`汇总：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
