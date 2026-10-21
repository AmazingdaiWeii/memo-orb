/**
 * 记忆中心 · 纯逻辑单测
 *
 * 验的是 `src/impression.mjs` 里的纯函数。**这些全绿不代表功能能用** ——
 * 它证明不了 host 的 `case 'impression-get'` 真的接上了球（那是 wire 探针的事）。
 * 但它能证明一件 wire 探针很难验的事：**我们复刻的 frontmatter 规则和真实钩子一致**。
 *
 * 跑法：node probe/impression-test.mjs
 */

import {
  ABOUT_INDEX_CONTENT,
  ABOUT_INDEX_PATH,
  DEFAULT_EVERY_HOURS,
  FM_DESC,
  FM_NAME,
  IMPRESSION_PATH,
  IMPRESSION_PLACEHOLDER,
  IMPRESSION_SEED,
  MAX_FILE_CHARS,
  SCHEDULE_CHOICES,
  TASK_NAME,
  buildImpressionPrompt,
  dueState,
  ensureFrontmatter,
  formatAgo,
  frontmatterProblem,
  isPlaceholder,
  latestCommitTime,
  normalizeEveryHours,
  overLimit,
  pickTask,
  stripFrontmatter,
  summarizeTask,
} from '../src/impression.mjs'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✅ ${name}${detail ? `  —— ${detail}` : ''}`) }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? `  —— ${detail}` : ''}`) }
}
const group = (t) => console.log(`\n=== ${t} ===`)

const H = 3600_000

// ================================================================ 1. 常量自洽
group('1. 常量自洽（路径 / 索引 / 种子）')
check('印象落在 about/ 子目录里（子目录不进每轮上下文，零 token）',
  IMPRESSION_PATH.startsWith('about/'), IMPRESSION_PATH)
check('★ 子目录索引与印象文件同目录', `${ABOUT_INDEX_PATH}`.replace('/MEMORY.md', '') === IMPRESSION_PATH.replace(/\/[^/]+$/, ''),
  `${ABOUT_INDEX_PATH} vs ${IMPRESSION_PATH}`)
check('索引文件 basename 必须是 MEMORY.md（MemFS v2 靠它认子目录）',
  ABOUT_INDEX_PATH.endsWith('/MEMORY.md'), ABOUT_INDEX_PATH)
check('★ 索引**不能**有 frontmatter（叫 MEMORY.md 的必须第一行不是 ---）',
  !ABOUT_INDEX_CONTENT.startsWith('---'), JSON.stringify(ABOUT_INDEX_CONTENT.slice(0, 12)))
check('索引里指向印象文件的链接存在', ABOUT_INDEX_CONTENT.includes('印象.md'))
check('深度 ≤ 2（钩子 maxDepth=2）',
  IMPRESSION_PATH.split('/').length - 1 <= 2, `depth=${IMPRESSION_PATH.split('/').length - 1}`)
check('频率三档 = 一天 / 一周 / 关', JSON.stringify(SCHEDULE_CHOICES) === '[24,168,0]', JSON.stringify(SCHEDULE_CHOICES))
check('默认一天一次', DEFAULT_EVERY_HOURS === 24, String(DEFAULT_EVERY_HOURS))
check('MAX_FILE_CHARS 与钩子对齐', MAX_FILE_CHARS === 20000, String(MAX_FILE_CHARS))

// ================================================================ 2. 种子合法
group('2. ★ 种子文件一出生就必须能被钩子放行')
check('IMPRESSION_SEED 过 frontmatter 校验', frontmatterProblem(IMPRESSION_SEED) === null,
  String(frontmatterProblem(IMPRESSION_SEED)))
check('种子里 name 是我们定的', IMPRESSION_SEED.includes(`name: ${FM_NAME}`))
check('种子里 description 是我们定的', IMPRESSION_SEED.includes(`description: ${FM_DESC}`))
check('种子不超长', !overLimit(IMPRESSION_SEED))

// ================================================================ 3. 频率归一
group('3. normalizeEveryHours —— 绝不把 NaN 放进调度逻辑')
for (const v of [24, 168, 0, '24', '168', '0']) {
  check(`合法值 ${JSON.stringify(v)} 原样保留`, normalizeEveryHours(v) === Number(v), String(normalizeEveryHours(v)))
}
for (const v of [undefined, null, NaN, '', '   ', false, true, 'abc', {}, [], [24], -1, 1, 12, 48, 1000, Infinity]) {
  check(`非法值 ${JSON.stringify(v) ?? String(v)} 回落默认 24`, normalizeEveryHours(v) === 24, String(normalizeEveryHours(v)))
}
/**
 * ★ 这一组单独拎出来：它们的 `Number()` 值**都是 0**，而 0 = 「关掉功能」。
 * 一不小心就会把「字段没传」静默理解成「用户主动关闭」—— 功能没了还查不出原因。
 */
group('3b. ★★ 这些值的 Number() 都是 0，绝不能被当成「关掉」')
for (const v of [null, '', '   ', [], false, undefined, NaN]) {
  check(`${JSON.stringify(v) ?? String(v)} → 不是「关」，而是回落 24`,
    normalizeEveryHours(v) === 24, String(normalizeEveryHours(v)))
}
check('真正的 0 仍然是「关」（别矫枉过正）', normalizeEveryHours(0) === 0, String(normalizeEveryHours(0)))
check('字符串 "0" 也是「关」', normalizeEveryHours('0') === 0, String(normalizeEveryHours('0')))
check('带空格的 " 24 " 认得出', normalizeEveryHours(' 24 ') === 24, String(normalizeEveryHours(' 24 ')))

// ================================================================ 4. 到期判定
group('4. dueState —— 到点了没')
const NOW = Date.parse('2026-10-07T12:00:00+08:00')
const ago = (h) => new Date(NOW - h * H).toISOString()

const off = dueState({ hasFile: true, lastCommitAt: ago(100), everyHours: 0, now: NOW })
check('关掉频率 → 永不触发', off.due === false && off.reason === 'off', off.reason)

const first = dueState({ hasFile: false, lastCommitAt: null, everyHours: 24, now: NOW })
check('★ 文件不存在 → 立刻跑第一次（不让用户等一天）', first.due === true && first.reason === 'first', first.reason)

const fresh = dueState({ hasFile: true, lastCommitAt: ago(3), everyHours: 24, now: NOW })
check('3 小时前刚跑过 → 不跑', fresh.due === false && fresh.reason === 'waiting', `${fresh.reason} / 下次 ${fresh.dueAt}`)

const almost = dueState({ hasFile: true, lastCommitAt: ago(21), everyHours: 24, now: NOW })
check('21 小时 → 还不到（余量是 22h，不是 24h）', almost.due === false, `dueAt=${almost.dueAt}`)

const atSlack = dueState({ hasFile: true, lastCommitAt: ago(22), everyHours: 24, now: NOW })
check('★ 满 22 小时 → 到点（方案 §0.4 的余量生效）', atSlack.due === true && atSlack.reason === 'due', `dueAt=${atSlack.dueAt}`)

const overdue = dueState({ hasFile: true, lastCommitAt: ago(30), everyHours: 24, now: NOW })
check('30 小时 → 到点', overdue.due === true, overdue.reason)
check('elapsedMs 如实反映间隔', Math.round(overdue.elapsedMs / H) === 30, String(Math.round(overdue.elapsedMs / H)))

const week = dueState({ hasFile: true, lastCommitAt: ago(165), everyHours: 168, now: NOW })
check('一周档：165 小时 → 还不到', week.due === false, `dueAt=${week.dueAt}`)
const weekDue = dueState({ hasFile: true, lastCommitAt: ago(167), everyHours: 168, now: NOW })
check('一周档：167 小时 → 到点', weekDue.due === true, weekDue.reason)

const broken = dueState({ hasFile: true, lastCommitAt: '不是时间', everyHours: 24, now: NOW })
check('时间戳烂了 → 按「不知道多久没跑」处理，到点（宁可多跑一次也别永远不跑）',
  broken.due === true && broken.reason === 'unknown-age', broken.reason)

const noCommit = dueState({ hasFile: true, lastCommitAt: null, everyHours: 24, now: NOW })
check('文件在但没 commit 记录 → 到点', noCommit.due === true, noCommit.reason)

check('返回的 dueAt / nominalAt 是 ISO 串', /^\d{4}-\d{2}-\d{2}T/.test(atSlack.dueAt ?? '')
  && /^\d{4}-\d{2}-\d{2}T/.test(atSlack.nominalAt ?? ''), `${atSlack.dueAt} / ${atSlack.nominalAt}`)
check('nominalAt 晚于 dueAt（余量方向没搞反）',
  Date.parse(atSlack.nominalAt) - Date.parse(atSlack.dueAt) === 2 * H,
  `${(Date.parse(atSlack.nominalAt) - Date.parse(atSlack.dueAt)) / H} 小时`)

// ================================================================ 5. commit 时间提取
group('5. latestCommitTime —— 不假设返回顺序')
check('空数组 → null', latestCommitTime([]) === null)
check('null → null', latestCommitTime(null) === null)
check('不是数组 → null', latestCommitTime({}) === null)
const ordered = [
  { timestamp: '2026-10-07T01:46:17+08:00' },
  { timestamp: '2026-10-06T18:00:00+08:00' },
]
check('取最新的那条（虽然协议是最新在前，但不依赖这个）',
  latestCommitTime(ordered) === new Date(Date.parse('2026-10-07T01:46:17+08:00')).toISOString(),
  String(latestCommitTime(ordered)))
const shuffled = [ordered[1], ordered[0]]
check('★ 顺序颠倒也取最新', latestCommitTime(shuffled) === latestCommitTime(ordered))
check('全是烂时间 → null', latestCommitTime([{ timestamp: 'x' }, { timestamp: null }]) === null)
check('混了烂时间也不崩', latestCommitTime([{ timestamp: 'x' }, ordered[0]]) === latestCommitTime(ordered))
check('兼容 date 字段（协议万一改名）',
  latestCommitTime([{ date: '2026-10-07T01:46:17+08:00' }]) === new Date(Date.parse('2026-10-07T01:46:17+08:00')).toISOString())

// ================================================================ 6. frontmatter（核心）
group('6. ★★ frontmatterProblem —— 复刻真实钩子的规则')
const GOOD = `---\nname: 印象\ndescription: 她眼中的你\n---\n\n正文。\n`
check('合法内容 → null', frontmatterProblem(GOOD) === null, String(frontmatterProblem(GOOD)))
check('空串 → empty', frontmatterProblem('') === 'empty')
check('null → empty', frontmatterProblem(null) === 'empty')
check('★ 纯散文（探针实际踩到的）→ missing-frontmatter',
  frontmatterProblem('这是她写的一段印象。\n没有 frontmatter。') === 'missing-frontmatter')
check('只有开头 --- 没闭合 → unclosed-frontmatter',
  frontmatterProblem('---\nname: x\ndescription: y\n正文') === 'unclosed-frontmatter')
check('多了一个键 → bad-key（v2 只允许 name / description）',
  frontmatterProblem('---\nname: x\ndescription: y\nread_only: true\n---\n') === 'bad-key:read_only',
  String(frontmatterProblem('---\nname: x\ndescription: y\nread_only: true\n---\n')))
check('name 为空 → empty-value',
  frontmatterProblem('---\nname:\ndescription: y\n---\n') === 'empty-value:name')
check('description 是引号空串 → empty-value',
  frontmatterProblem('---\nname: x\ndescription: ""\n---\n') === 'empty-value:description')
check('重复键 → dup-key',
  frontmatterProblem('---\nname: x\nname: y\ndescription: z\n---\n') === 'dup-key:name')
check('缺 name → missing-name',
  frontmatterProblem('---\ndescription: y\n---\n') === 'missing-name')
check('缺 description → missing-description',
  frontmatterProblem('---\nname: x\n---\n') === 'missing-description')
check('★ 第一行是 --- 但前面有空行 → 仍然不合格（git 钩子就是逐字节看第一行）',
  frontmatterProblem('\n---\nname: x\ndescription: y\n---\n') === 'missing-frontmatter')

// ================================================================ 7. ensureFrontmatter
group('7. ensureFrontmatter —— 写前保命 / 坏后修复')
check('已经合法 → 原样返回（幂等，不重复贴头）',
  ensureFrontmatter(GOOD) === GOOD, '逐字节相同')

const fixed = ensureFrontmatter('这是她写的一段印象。\n\n第二段。')
check('★ 纯散文 → 补上合法 frontmatter', frontmatterProblem(fixed) === null, String(frontmatterProblem(fixed)))
check('修补后正文一字不丢',
  fixed.includes('这是她写的一段印象。') && fixed.includes('第二段。'), JSON.stringify(fixed))
check('修补后第一行就是 ---', fixed.split('\n')[0] === '---')

const withBadFm = '---\nfoo: bar\n---\n\n正文保留。'
const fixedBad = ensureFrontmatter(withBadFm)
check('坏的 frontmatter → 剥掉重贴，不出现两层 ---',
  frontmatterProblem(fixedBad) === null && (fixedBad.match(/^---$/gm) ?? []).length === 2,
  `${(fixedBad.match(/^---$/gm) ?? []).length} 行 ---`)
check('原来的坏键没了', !fixedBad.includes('foo: bar'))
check('正文保留', fixedBad.includes('正文保留。'))

check('空内容 → 也能得到合法文件', frontmatterProblem(ensureFrontmatter('')) === null)
check('★ ensureFrontmatter 幂等（连跑两次结果相同）',
  ensureFrontmatter(ensureFrontmatter('散文')) === ensureFrontmatter('散文'))
check('★ 任意脏输入都不会产出非法文件', [
  '', '散文', '---', '---\n', '---\nfoo\n---', '---\nname: x\n---', '\n\n---\nname: x\ndescription: y\n---\n',
].every((s) => frontmatterProblem(ensureFrontmatter(s)) === null), '6 种脏输入')

// ================================================================ 8. 超长
group('8. overLimit')
check('短内容不超', overLimit('x'.repeat(100)) === false)
check('刚好 20000 不超（钩子是 > 才拒）', overLimit('x'.repeat(20000)) === false)
check('20001 超', overLimit('x'.repeat(20001)) === true)
check('非字符串不崩', overLimit(null) === false)

// ================================================================ 9. cron 任务
group('9. pickTask / summarizeTask')
const tasks = [
  { id: 'a', name: '别的任务' },
  { id: 'b', name: TASK_NAME, status: 'paused', cron: '0 4 * * *', fire_count: 3, last_run_error: null },
]
check('按 name 找回我们那条', pickTask(tasks)?.id === 'b')
check('找不到 → null', pickTask([{ id: 'a', name: '别的' }]) === null)
check('不是数组 → null', pickTask({}) === null)
check('空数组 → null', pickTask([]) === null)

const sum = summarizeTask(tasks[1])
check('收敛成面板要的形状', sum.id === 'b' && sum.status === 'paused' && sum.fireCount === 3, JSON.stringify(sum))
check('null → null', summarizeTask(null) === null)
check('★ 不透传后端的一堆内部字段（超大对象别丢给球）',
  Object.keys(summarizeTask({ id: 'x', whatever: 1, scheduled_for: 2 })).length <= 10,
  Object.keys(summarizeTask({ id: 'x', whatever: 1 })).join(','))

// ================================================================ 9b. 种子 vs 真总结
group('9b. ★★ 种子占位 ≠ 真的总结过（决定第一次要不要立刻跑）')
check('种子正文就是占位串', IMPRESSION_SEED.includes(IMPRESSION_PLACEHOLDER))
check('种子被判为「只有占位」', isPlaceholder(IMPRESSION_SEED) === true)
check('空串也算「只有占位」', isPlaceholder('') === true)
check('null 也算', isPlaceholder(null) === true)
check('★ 她自己写过的内容不算占位',
  isPlaceholder(`---\nname: 印象\ndescription: x\n---\n\n他不太爱解释，但会在细节上较真。`) === false)
check('只有 frontmatter 没正文 → 算占位（她写空了）',
  isPlaceholder(`---\nname: 印象\ndescription: x\n---\n`) === true)

check('stripFrontmatter 剥掉头只留正文',
  stripFrontmatter(`---\nname: x\ndescription: y\n---\n\n正文`).trim() === '正文',
  JSON.stringify(stripFrontmatter(`---\nname: x\ndescription: y\n---\n\n正文`)))
check('stripFrontmatter 对没有头的原样返回', stripFrontmatter('散文') === '散文')
check('stripFrontmatter 对没闭合的原样返回', stripFrontmatter('---\nname: x') === '---\nname: x')

/** ★ 核心：种子那次 commit 是 host 自己写的，绝不能当作「她跑过了」。 */
const seeded = dueState({ hasFile: true, lastCommitAt: ago(0.1), everyHours: 24, seededOnly: true, now: NOW })
check('★ 文件在、刚 commit 过、但只有占位 → 仍然立刻跑第一次',
  seeded.due === true && seeded.reason === 'first', `${seeded.reason}`)
const real = dueState({ hasFile: true, lastCommitAt: ago(0.1), everyHours: 24, seededOnly: false, now: NOW })
check('对照：真有内容且刚跑过 → 不跑', real.due === false, real.reason)
const seededOff = dueState({ hasFile: true, lastCommitAt: ago(0.1), everyHours: 0, seededOnly: true, now: NOW })
check('但「关掉」优先于「第一次」：关掉就不跑', seededOff.due === false && seededOff.reason === 'off', seededOff.reason)

// ================================================================ 10. formatAgo
group('10. formatAgo')
check('null → 未知', formatAgo(null) === '未知')
check('负数 → 未知', formatAgo(-1) === '未知')
check('30 秒 → 刚刚', formatAgo(30_000) === '刚刚')
check('5 分钟前', formatAgo(5 * 60_000) === '5 分钟前')
check('23 小时前', formatAgo(23 * H) === '23 小时前')
check('25 小时 → 1 天前', formatAgo(25 * H) === '1 天前')
check('非数字 → 未知', formatAgo('x') === '未知')

// ================================================================ 11. prompt
group('11. buildImpressionPrompt —— 硬要求必须写进去')
const prompt = buildImpressionPrompt()
check('写明了目标路径', prompt.includes(IMPRESSION_PATH))
check('★ 写明了 frontmatter 三段（她抄错了整篇白写）',
  prompt.includes('---') && prompt.includes(`name: ${FM_NAME}`) && prompt.includes(`description: ${FM_DESC}`))
check('写明了要覆盖不要追加', /覆盖/.test(prompt))
check('写明了字符上限', prompt.includes(String(MAX_FILE_CHARS)))
check('写明了用 write_memory_file', prompt.includes('write_memory_file'))
check('强调了第一行就是 ---', prompt.includes('第一行'))
check('★ prompt 里给出的 frontmatter 块不带缩进（缩进了她就抄错）',
  prompt.split('\n').some((l) => l === '---')
    && prompt.split('\n').every((l) => !/^\s+(name|description):/.test(l)),
  '无缩进')
check('语气没有 AI 味的自曝（不出现「大语言模型」之类）',
  !/大语言模型|真实身份|AI 模型/.test(prompt))
check('可以换路径生成（测试用）', buildImpressionPrompt({ path: 'x/y.md' }).includes('x/y.md'))

// ================================================================
console.log(`\n${'='.repeat(56)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
console.log('='.repeat(56))
process.exit(fail > 0 ? 1 : 0)
