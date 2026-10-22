#!/usr/bin/env node
/**
 * 记忆索引 · 单测（纯逻辑，不碰任何真实文件）。
 *
 * 守的是 `src/snapshot.mjs` 的 `pickTrigger` / `pickPreview` / `buildIndexLines`。
 *
 * 为什么这几行值得单独测：索引是「她扫一眼决定要不要打开某个文件」的唯一依据。
 * 原来的索引行只有一句首句摘要（`— 讲了鲸鱼搁浅`），回答的是「这文件写了什么」，
 * 而她真正要判断的是「**现在**该不该开它」。所以加了 `> 打开条件：…` 约定，
 * 并把 frontmatter / 引用行从摘要里剔掉（`about/印象.md` 原来在索引里显示成 `— ---`）。
 *
 * 跑法：node probe/memory-index-trigger-unit.mjs
 */
import { buildIndexLines, pickPreview, pickTrigger, renderSystemText } from '../src/snapshot.mjs'

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`PASS ${name}`)
    return
  }
  failed += 1
  console.log(`FAIL ${name}${detail ? `  —— ${detail}` : ''}`)
}

// ── pickTrigger ─────────────────────────────────────────────────
check(
  'I1 从引用行里取到打开条件',
  pickTrigger('# 标题\n\n> 打开条件：他提到春桃的时候。\n') === '他提到春桃的时候。',
)
check(
  'I2 全角/半角冒号都认',
  pickTrigger('> 打开条件:半角也行') === '半角也行',
)
check('I3 没写就返回空串（不编）', pickTrigger('# 标题\n\n一些正文\n') === '')
check('I4 空的/缺失的前言不炸', pickTrigger('') === '' && pickTrigger(undefined) === '')
check('I5 中间有空格也认（`>  打开条件 ：`）', pickTrigger('>  打开条件 ： 有空格 ') === '有空格')

// ── pickPreview ─────────────────────────────────────────────────
check('I6 有 H1 就用 H1', pickPreview('B 站看视频', '正文第一行') === 'B 站看视频')
check(
  'I7 ★ 跳过 YAML frontmatter 的 `---` 与键值行',
  pickPreview(null, '---\nname: 印象\ndescription: 她眼中的你\n---\n\n上一版我写，我手上…\n') === '上一版我写，我手上…',
  pickPreview(null, '---\nname: 印象\ndescription: 她眼中的你\n---\n\n上一版我写，我手上…\n'),
)
check(
  'I8 ★ 跳过 `> 打开条件：` 行（它已经是 trigger，别再当摘要）',
  pickPreview(null, '> 打开条件：他问 Chir 的时候。\n\n真正的正文在这里\n') === '真正的正文在这里',
)
check('I9 什么都没有就返回空串', pickPreview(null, '---\nname: x\n---\n') === '')

// ── buildIndexLines ─────────────────────────────────────────────
const lines = buildIndexLines([
  { path: 'about/我.md', size: 1300, preview: '我', trigger: '他问「你是谁」的时候。' },
  { path: 'about/无条件.md', size: 2000, preview: '讲了鲸鱼搁浅', trigger: '' },
  { path: 'journal/2026-10.md', size: 15600, preview: '', trigger: '' },
  { path: 'about/空的.md', size: 12, preview: '', trigger: '' },
])
console.log('\n渲染出来的索引：')
for (const l of lines) console.log(`  ${l}`)
console.log('')

check('I10 有 trigger 时优先展示「打开条件」', lines[0].includes('打开条件：他问「你是谁」的时候。'), lines[0])
check('I11 没有 trigger 时退回首句摘要', lines[1].includes('讲了鲸鱼搁浅'), lines[1])
check('I12 ★ journal 没有前言时补一句固定说法（不留下光秃秃的路径）', lines[2].includes('流水账'), lines[2])
check('I13 真什么都没有时只给路径和大小（不编内容）', lines[3].includes('`about/空的.md`') && !lines[3].includes('—'), lines[3])
check(
  'I14 每行都以 `- ` + 反引号路径开头，大小带单位',
  lines.every((l) => /^- `[^`]+` \(\d+(\.\d)?(B|KB)\)/.test(l)),
  lines.join(' | '),
)

// 条数上限：超了要有一行说明，而不是静默截断
const many = Array.from({ length: 90 }, (_, i) => ({ path: `about/f${i}.md`, size: 100, preview: '', trigger: '' }))
const capped = buildIndexLines(many)
check(
  'I15 ★ 超过上限时明写「还有几个文件」，不静默截断',
  capped.length === 81 && capped[80].includes('还有') && capped[80].includes('10'),
  `len=${capped.length} last=${capped[80]}`,
)

// ── renderSystemText 的整体形状 ─────────────────────────────────
const sys = renderSystemText({
  persona: '（人格）',
  memoryText: '# 记忆\n\n## 关于他\n- 喝冰美式\n\n## 记忆仓库里的其他文件（需要时用 read_memory 打开）\n- 手写清单，应该被剥掉\n',
  indexLines: lines,
  web: true,
  bili: false,
  biliAct: false,
  balance: false,
})
check('I16 ★ 正文里手写的文件清单被剥掉（索引只由宿主生成）', !sys.includes('手写清单，应该被剥掉'), sys.slice(0, 200))
check('I17 自动索引照样在', sys.includes('`about/我.md`'))
check(
  'I18 三段顺序不变：人格 → 长期记忆 → 工具指南',
  sys.indexOf('（人格）') < sys.indexOf('## 长期记忆') && sys.indexOf('## 长期记忆') < sys.indexOf('## 记忆怎么用'),
)
check('I19 指南里教了 `> 打开条件：` 这个约定', sys.includes('打开条件'))
check('I20 指南里说了「关于我自己」要写进 about/我.md，不塞常驻记忆', sys.includes('about/我.md'))

console.log(`\n${passed} PASS / ${failed} FAIL`)
if (failed > 0) process.exit(1)
