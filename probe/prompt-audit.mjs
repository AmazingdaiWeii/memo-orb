#!/usr/bin/env node
/**
 * system prompt 体检 · probe/prompt-audit.mjs
 *
 * ── 为什么要有这支 ───────────────────────────────────────────────────
 * 用户 2026-10-22 的原话：
 *   「该项目的版本和最初版本已经差别很大了，但 prompt 注入始终使用初版，
 *     导致现在注入的很多东西可能已经和现有的内容产生了冲突。」
 *
 * 查下来第一条实证：`MEMORY.md` 里留着**初版手写**的「记忆仓库里的其他文件」索引，
 * 而 `renderSystemText()` 又会自动生成一份同标题索引 —— 两份都进了 prompt，
 * 既重复占预算，又让她看到一份更旧的清单（少两个文件）。
 * 根因不是"谁忘了改"，而是**初版没有自动索引，只能手写**；机制变了，文本没变。
 *
 * 所以这支探针守两类东西：
 *   A. **不重复**：同一份 system 文本里，同一个二级标题只能出现一次。
 *   B. **不自相矛盾**：人格稿里关于「我能做什么」的说法，必须和 brain.mjs 里
 *      真正注册的工具对得上。写死的旧能力会让她拒绝干活、或者假装干过。
 *
 * 跑法：node probe/prompt-audit.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderSystemText } from '../src/snapshot.mjs'
import { extractPersona } from '../src/persona.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PERSONA = join(ROOT, '鲸鱼娘_persona.md')
const BRAIN = join(ROOT, 'src', 'brain.mjs')

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

/* ── A. 重复索引：手写的那份必须被剥掉 ────────────────────────────── */

const MANUAL_INDEX = [
  '## 关于他',
  '- 喝冰美式，不加糖。',
  '',
  '## 记忆仓库里的其他文件（需要时用 read_memory 打开）',
  '- `about/B站看视频.md`',
  '- `about/印象.md`',
  '- `journal/2026-10.md`',
].join('\n')

const INDEX_LINES = ['- `about/B站看视频.md` (2.9KB)', '- `about/印象.md` (2.8KB)']

const out = renderSystemText({
  persona: '# 测试人格\n我被注入进来了。',
  memoryText: MANUAL_INDEX,
  indexLines: INDEX_LINES,
})

const titleCount = (text, t) => text.split(t).length - 1

check(
  'A1 ★ 正文里手写的「记忆仓库里的其他文件」被剥掉了 —— 同名标题只出现一次',
  titleCount(out, '记忆仓库里的其他文件') === 1,
  `出现 ${titleCount(out, '记忆仓库里的其他文件')} 次`
)
check(
  'A2 剥的时候没误伤别的段落（「关于他」和它的内容还在）',
  out.includes('## 关于他') && out.includes('喝冰美式，不加糖。')
)
check(
  'A3 自动生成的那份索引还在（带 KB 大小）',
  out.includes('`about/B站看视频.md` (2.9KB)')
)
check(
  'A4 被剥掉的是**旧清单**（`about/B站看视频.md` 不带大小那一行不该留着）',
  !/^- `about\/B站看视频\.md`\s*$/m.test(out)
)

// 反向对照：不剥的话一定是两份 —— 证明 A1 不是恒真
const rawCompose = ['## 关于他', '- x', '', MANUAL_INDEX, '', '## 记忆仓库里的其他文件（需要时用 read_memory 打开）', ...INDEX_LINES].join('\n')
check(
  'A5 （对照）不剥的拼接方式会出现两份 —— 说明 A1 真的在测剥除逻辑',
  titleCount(rawCompose, '记忆仓库里的其他文件') === 2,
  `对照出现 ${titleCount(rawCompose, '记忆仓库里的其他文件')} 次`
)

/* ── B. 能力陈述 vs 真实工具 ──────────────────────────────────────── */

const brain = readFileSync(BRAIN, 'utf8')
const TOOLS = [...brain.matchAll(/name: '([a-z_0-9]+)'/g)].map((m) => m[1])
const has = (t) => TOOLS.includes(t)

check(
  'B1 brain.mjs 里能解析出工具清单（体检的前提）',
  TOOLS.length >= 15,
  `解析到 ${TOOLS.length} 个：${TOOLS.join(',')}`
)

const persona = existsSync(PERSONA) ? readFileSync(PERSONA, 'utf8') : ''

/**
 * 真正注入 prompt 的那一段 —— **直接用产品那份 `extractPersona()`**，别复刻。
 *
 * ⚠️ 2026-10-22 之前这里自己写了一版「取全文第一个 ``` 块」，那是错的：
 *    文档 line 64 的说明里有一处行内代码 `IndexOf('```')`，那三个反引号把正则带偏，
 *    于是体检一直在扫**另一个段落**（v2.0/v2.1 的说明区），而不是 §二 A 正文。
 *    后果不是报错，是**假健康**：B3 那几条禁句在错误段落里当然永远找不到，
 *    于是 PASS 得干干净净。新增的 B6 一眼看穿了这件事（它在真段落里找得到、
 *    在假段落里找不到），所以本质上是用一条新断言揪出了工具本身的 bug。
 *
 *    产品版是「先定位 `## 二、A.` 标记、再取它后面第一个围栏」，不会被行内代码干扰。
 *    审计工具一旦和产品不同源，它给的就是虚假的安全感 —— 这条今天已经应验第三次了。
 */
let injected = ''
try {
  injected = extractPersona(persona, 'chat')
} catch (e) {
  injected = ''
  check('B2 能切出围栏内的注入部分', false, `产品解析器报错：${e.message}`)
}

check('B2 人格稿读到了，且能切出围栏内的注入部分', persona.length > 1000 && injected.length > 500,
  `全文 ${persona.length} 字 / 围栏内 ${injected.length} 字`)

// B6（2026-10-22）：她必须知道自己有嗓子。
// 背景：语音播报上线后她答不了相关提问，被问「是不是依赖宿主 dsh」时干脆**现编**了个「是」
// —— 因为人格稿里一个字都没提这件事。加了 `## 我的声音` 之后她才有得可依据。
// 这条守的是「章节别掉出围栏」：一旦章节被挪到围栏外，注入部分就不含它，
// 她会退回「什么都不知道只能编」的状态，而人格稿文件本身看不出任何异常。
check('B6 注入部分里有「我的声音」章节（她得知道自己真的能开口）',
  injected.includes('## 我的声音'),
  '围栏内找不到 ## 我的声音 —— 她会重新变成不知道自己有嗓子，问什么现编什么')

/** 一条「能力陈述」+ 它的判据。命中即说明文本与代码打架。 */
const CLAIMS = [
  {
    bad: /跑过命令/,
    why: '没有任何 shell / 命令执行工具 ⇒ 她会以为自己跑过命令（或反过来拒绝干活）',
  },
  {
    bad: /不会自动联网/,
    why: '有 search_web / fetch_url，且工具指南写着「这两个不用问他，直接用」',
  },
  {
    bad: /不读大文件/,
    why: '工具指南教「大文件用 offset/limit 按行分段」，read_file 本来就能读大文件',
  },
  {
    bad: /不起长任务/,
    why: 'bili_watch 取帧 / 下载字幕就是长任务',
  },
]

for (const c of CLAIMS) {
  const hit = c.bad.exec(injected)
  check(
    `B3 注入部分里不该再出现「${c.bad.source}」`,
    hit === null,
    hit ? `${c.why}（命中：${injected.slice(Math.max(0, hit.index - 20), hit.index + 30).replace(/\n/g, ' ')}）` : ''
  )
}

// 反向对照：确实是"没有命令工具"，不是 B3 在瞎报
check(
  'B4 （对照）工具清单里确实没有 shell / run_command 类工具',
  !TOOLS.some((t) => /shell|bash|exec|command|run/.test(t)),
  TOOLS.join(',')
)
check(
  'B5 （对照）联网工具确实存在（否则「能自己查」那句反而是错的）',
  has('search_web') && has('fetch_url')
)

/* ── C. 通用不变量：整份 system 文本里二级标题不许重名 ────────────── */

const full = renderSystemText({
  persona: injected,
  memoryText: '## 关于他\n- x',
  indexLines: INDEX_LINES,
  web: true,
  bili: true,
  biliAct: true,
  balance: true,
})
const h2 = [...full.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim())
const dup = h2.filter((t, i) => h2.indexOf(t) !== i)
check(
  'C1 ★ 整份 system 文本里没有重名的二级标题（这次栽的就是这个）',
  dup.length === 0,
  dup.length ? `重复：${JSON.stringify([...new Set(dup)])}` : ''
)

console.log('='.repeat(64))
console.log(`通过 ${passed} / 失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
