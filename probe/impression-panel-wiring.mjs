/**
 * probe/impression-panel-wiring.mjs · 印象面板的接线一致性探针
 *
 * 为什么需要它：面板里有三类错**都不会在启动时报错**，只会表现为诡异现象：
 *   1. `querySelector('#xxx')` 拿不到元素 → 后面 `addEventListener` 直接抛，
 *      但那是在用户点开面板时才炸，日志在渲染进程，最难拿到；
 *   2. `t('impressionXxx')` 缺词条 → 界面上原样显示 `impressionXxx` 这串英文；
 *   3. 底部四个 chip 的标签字数不一致 → 等宽布局下整行抖动 / 文字被裁。
 *
 * 这三类都属于「看起来像功能没做，实际是线没接上」，所以用静态比对当场判红。
 *
 * 纯文本检查，不启动 Electron、不碰 data。
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJ = join(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(join(PROJ, 'helper/assets/floating.html'), 'utf8')
const panel = readFileSync(join(PROJ, 'helper/assets/impression-panel.js'), 'utf8')
const shell = readFileSync(join(PROJ, 'helper/assets/shell.js'), 'utf8')

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`) }
  else { fail += 1; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('\n=== 印象面板接线一致性 ===\n')

// ── 1. 所有 querySelector('#id') 都能在 HTML 里找到
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
const queried = [...new Set([...panel.matchAll(/querySelector\('#([^']+)'\)/g)].map((m) => m[1]))]
const missingIds = queried.filter((id) => !htmlIds.has(id))
ok(`querySelector 用到的 ${queried.length} 个 id 都在 HTML 里`, missingIds.length === 0, missingIds.join(', '))

// ── 2. 所有 t('key') 在 zh / en 两个词表里都有
const enStart = shell.indexOf('const en = {')
const zhPart = enStart > 0 ? shell.slice(0, enStart) : ''
const enPart = enStart > 0 ? shell.slice(enStart) : ''
const usedKeys = [...new Set([...panel.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]))]
const hasKey = (part, key) => new RegExp(`\\b${key}\\s*:`).test(part)
const missZh = usedKeys.filter((k) => !hasKey(zhPart, k))
const missEn = usedKeys.filter((k) => !hasKey(enPart, k))
ok(`面板用到的 ${usedKeys.length} 个词条都有中文`, missZh.length === 0, missZh.join(', '))
ok(`面板用到的 ${usedKeys.length} 个词条都有英文`, missEn.length === 0, missEn.join(', '))

// ── 3. 四个 chip 的节点与词条都到位
const chips = ['impression-refresh', 'impression-schedule', 'impression-freeze', 'impression-wake']
const missingChips = chips.filter((id) => !htmlIds.has(id))
ok('底部四个 chip 都在 HTML 里', missingChips.length === 0, missingChips.join(', '))
ok('冻结/唤醒两个 chip 在 footer 内',
  /id="impression-freeze"[\s\S]{0,200}id="impression-wake"/.test(html))

// ── 4. ★ 等宽契约：四个 chip 的**所有可能文案**都必须是四字
//     （等宽布局下字数变了，整行会跳或被裁。改文案的人未必想得到这一层。）
const labelRules = [
  ['impressionRefresh', '现在总结'],
  ['impressionRefreshing', '总结中…'],
  ['impressionFreeze', '冻结记忆'],
  ['impressionFreezing', '冻结中…'],
  ['impressionWake', '唤醒记忆'],
  ['impressionWaking', '唤醒中…'],
]
for (const [key] of labelRules) {
  const m = new RegExp(`${key}:\\s*'([^']*)'`).exec(zhPart)
  ok(`中文词条 ${key} 存在`, Boolean(m))
}
const badLen = labelRules
  .map(([key]) => {
    const m = new RegExp(`${key}:\\s*'([^']*)'`).exec(zhPart)
    return m ? [key, m[1]] : [key, '']
  })
  .filter(([, v]) => [...v].length !== 4)
ok('四个 chip 的中文文案全是四字（等宽契约）', badLen.length === 0, badLen.map(([k, v]) => `${k}="${v}"`).join(' '))

// 频率菜单三档也必须是四字（标签就在同一个 chip 里切换）
const schedBlock = /SCHEDULE_OPTIONS\s*=\s*\[([\s\S]*?)\]/.exec(panel)
const schedZh = schedBlock ? [...schedBlock[1].matchAll(/zh:\s*'([^']*)'/g)].map((m) => m[1]) : []
ok(`频率三档词条都取到（${schedZh.length} 档）`, schedZh.length === 3, schedZh.join(','))
ok('频率三档全四字（现在总结旁边那个 chip 会显示它们）',
  schedZh.length === 3 && schedZh.every((v) => [...v].length === 4), schedZh.join(','))

// ── 5. 确认条必须自己兜住 [hidden]（写过 display:flex 的元素都会踩这个）
const css = readFileSync(join(PROJ, 'helper/assets/floating.css'), 'utf8')
ok('CSS 给 .impression-confirm[hidden] 写了 display:none',
  /\.impression-confirm\[hidden\]\s*\{[^}]*display:\s*none/.test(css))
ok('确认条有三个必需节点（文本 / 确定 / 取消）',
  ['impression-confirm-text', 'impression-confirm-ok', 'impression-confirm-cancel'].every((id) => htmlIds.has(id)))

// ── 6. 上行三个动作在 helper 的白名单里都有映射，且回包类型在白名单里
const helperMain = readFileSync(join(PROJ, 'helper/lib/main.js'), 'utf8')
for (const action of ['snap-freeze', 'snap-list', 'snap-thaw']) {
  ok(`helper 映射了 action "${action}"`, helperMain.includes(`"${action}"`))
}
for (const type of ['snap-list', 'snap-result']) {
  ok(`helper 转发白名单含 "${type}"`, new RegExp(`"${type}"`).test(helperMain))
}
const hostMain = readFileSync(join(PROJ, 'src/main.mjs'), 'utf8')
for (const t2 of ['impression-snap-freeze', 'impression-snap-list', 'impression-snap-thaw']) {
  ok(`host 有分支 "${t2}"`, hostMain.includes(`case '${t2}'`))
}

// ── 7. 冻结/唤醒都必须先等回合收口（半截回合的存档最难查）
const freezecase = /case 'impression-snap-freeze'[\s\S]{0,600}/.exec(hostMain)
const thawcase = /case 'impression-snap-thaw'[\s\S]{0,700}/.exec(hostMain)
ok('freeze 分支调了 waitTurnIdle', Boolean(freezecase && freezecase[0].includes('waitTurnIdle')))
ok('thaw 分支调了 waitTurnIdle', Boolean(thawcase && thawcase[0].includes('waitTurnIdle')))

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
if (fail) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(fail ? 1 : 0)
