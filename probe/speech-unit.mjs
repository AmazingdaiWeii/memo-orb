#!/usr/bin/env node
/**
 * 播报编排层单测 —— 切句 / 清洗 / 保序 / 打断。
 *
 * 这些断言守的都是「不看代码就永远发现不了」的坑：
 *   · 句末标点后面被漏掉的 `」` → 引号念丢
 *   · 流式增量把「因为」当一句念出去 → 听起来像卡带
 *   · 代码块被念出来 → 灾难
 *   · 并发合成时谁先回来谁先发 → 第二句话说在前头
 *   · 合成失败的那句把序号卡死 → 后面全堵着不说话
 *
 * 跑： node probe/speech-unit.mjs
 */
let pass = 0
let fail = 0
const fails = []

function ok(cond, name, detail = '') {
  if (cond) {
    pass += 1
    console.log(`PASS ${name}`)
  } else {
    fail += 1
    fails.push(name)
    console.log(`FAIL ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

function eq(actual, expected, name) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(a === e, name, `实际 ${a} / 期望 ${e}`)
}

const { cleanForSpeech, createSpeechSegmenter, createSpeechQueue } = await import('../src/tts/speech.mjs')

// ───────────────────────────── 清洗 ─────────────────────────────
console.log('\n── cleanForSpeech ──')

eq(cleanForSpeech('**重点**是这样'), '重点是这样', 'C1 Markdown 粗体剥掉')
eq(cleanForSpeech('看 `npm install` 这句'), '看 npm install 这句', 'C2 行内代码留内容去反引号')
eq(cleanForSpeech('点[这里](https://example.com/a)看'), '点这里看', 'C3 链接只留文字')
eq(cleanForSpeech('见 https://example.com/x?y=1 那段'), '见 那段', 'C4 裸 URL 整个删掉')
eq(cleanForSpeech('### 标题行'), '标题行', 'C5 标题标记')
eq(cleanForSpeech('- 第一项\n- 第二项'), '第一项 第二项', 'C6 列表标记')
eq(cleanForSpeech('a | b | c'), 'a ， b ， c', 'C7 表格竖线换成停顿')
eq(cleanForSpeech('好开心 😊🎉'), '好开心', 'C8 emoji 删掉')
ok(!cleanForSpeech('（mood:happy）').includes('mood'), 'C9 情绪标记不念')
// ★ 中文逗号版本 —— mood.mjs 的 MARKER 认不出它（已知 bug），播报这一侧必须自己兜住
ok(!cleanForSpeech('（mood:楞了下，认真起来）').includes('mood'), 'C10 中文逗号的情绪标记也不念')
eq(cleanForSpeech('（mood:楞了下，认真起来）说完了'), '说完了', 'C11 中文逗号标记剥干净')
eq(cleanForSpeech('---'), '', 'C12 水平线成了空 → 返回空串')
eq(cleanForSpeech('   \n\n  '), '', 'C13 纯空白 → 空串')
eq(cleanForSpeech('😊😊'), '', 'C14 只有 emoji → 空串')
ok(cleanForSpeech('C_C++ 也能说').includes('C_C++'), 'C15 词中间的连字符下划线不误伤')
eq(cleanForSpeech('<b>加粗</b>了'), '加粗了', 'C16 HTML 标签剥掉')

// ───────────────────────────── 切句 ─────────────────────────────
console.log('\n── createSpeechSegmenter ──')

{
  const s = createSpeechSegmenter()
  eq(s.feed('你好。今天'), ['你好。'], 'S1 成句就吐，尾部留在缓冲')
  eq(s.feed('想吃什么？'), ['今天想吃什么？'], 'S2 跨 delta 续上，标点到了才吐')
  eq(s.flush(), [], 'S3 缓冲已空，flush 没东西')
}

{
  const s = createSpeechSegmenter()
  // 没有句号也没有换行的残句，一直不该被吐出来
  const out = [...s.feed('我在想'), ...s.feed('一个'), ...s.feed('很难的问题')]
  eq(out, [], 'S4 没标点的残句不提前吐')
  eq(s.flush(), ['我在想一个很难的问题'], 'S5 flush 把残句兜出来')
}

{
  const s = createSpeechSegmenter()
  eq(s.feed('他说：「好。」然后'), ['他说：「好。」'], 'S6 句末的闭合引号一起带走')
}

{
  const s = createSpeechSegmenter()
  const out = [...s.feed('第一句。\n'), ...s.feed('第二句。\n')]
  eq(out, ['第一句。', '第二句。'], 'S7 换行也断句')
}

{
  const s = createSpeechSegmenter()
  // 行尾没标点：换行本身是停顿，应该吐出
  const out = s.feed('这一行没有句号\n')
  eq(out, ['这一行没有句号'], 'S8 行结束无标点也算一句')
}

{
  const s = createSpeechSegmenter()
  const out = [
    ...s.feed('看这段代码：\n'),
    ...s.feed('```js\n'),
    ...s.feed('const a = 1\n'),
    ...s.feed('console.log(a)\n'),
    ...s.feed('```\n'),
    ...s.feed('就这样。\n'),
  ]
  eq(out, ['看这段代码：', '就这样。'], 'S9 代码块整段不念')
}

{
  const s = createSpeechSegmenter()
  const out = [...s.feed('```js\nconst a = 1\n')]
  eq(out, [], 'S10 围栏没闭合前不吐内容')
}

{
  const s = createSpeechSegmenter({ maxChars: 10 })
  const out = s.feed('一二三四五六七八，九十十一十二。')
  ok(out.length >= 2, 'S11 超长句在逗号处软切', JSON.stringify(out))
  ok(out.every((x) => x.length <= 20), 'S12 软切后每段都不至于离谱地长', JSON.stringify(out))
}

{
  const s = createSpeechSegmenter({ minChars: 6 })
  const out = [...s.feed('开场白在这里。'), ...s.feed('嗯。'), ...s.feed('我明白你的意思了。')]
  eq(out, ['开场白在这里。', '嗯。我明白你的意思了。'], 'S13 过短碎片并进下一句')
}

{
  const s = createSpeechSegmenter({ minChars: 12 })
  // ★ 首句必须立刻走：为了凑长度把它扣住，等于把「早点出声」这个唯一目的丢了
  eq(s.feed('嗯。'), ['嗯。'], 'S15 首句再短也立刻吐（延迟优先）')
}

{
  const s = createSpeechSegmenter()
  s.feed('第一句。\n')
  s.reset()
  eq(s.feed('第二句。'), ['第二句。'], 'S14 reset 后不拼接上一轮残留')
}

// ───────────────────────────── 队列 ─────────────────────────────
console.log('\n── createSpeechQueue ──')

/** 可控的假合成器：手动决定每个请求什么时候、以什么顺序完成 */
function makeFakeSpeak() {
  const calls = []
  const speak = (text) =>
    new Promise((resolve) => {
      calls.push({ text, resolve })
    })
  return { speak, calls }
}

async function tick(n = 0) {
  for (let i = 0; i < n; i += 1) await Promise.resolve()
  await new Promise((r) => setImmediate(r))
}

{
  const emitted = []
  const { speak, calls } = makeFakeSpeak()
  const q = createSpeechQueue({ speak, emit: (p) => emitted.push(p), enabled: true, concurrency: 1 })
  q.feed('第一句。')
  await tick()
  ok(calls.length === 1, 'Q1 第一句立刻送去合成')
  calls[0].resolve({ ok: true, audio: Buffer.from('A'), mime: 'audio/mpeg', ms: 1 })
  await tick()
  eq(emitted.map((e) => e.audio), ['QQ=='], 'Q2 结果按 base64 发出（A → QQ==）')
  eq(emitted[0].seq, 1, 'Q3 序号从 1 开始')
}

{
  const emitted = []
  const { speak, calls } = makeFakeSpeak()
  // concurrency 2：两句同时在路上，故意让第 2 句先回来
  const q = createSpeechQueue({ speak, emit: (p) => emitted.push(p), enabled: true, concurrency: 2 })
  q.feed('第一句。第二句。')
  await tick()
  ok(calls.length === 2, 'Q4 并发 2 时两句同时在合成')
  calls[1].resolve({ ok: true, audio: Buffer.from('B'), mime: 'audio/mpeg' })
  await tick()
  eq(emitted.length, 0, 'Q5 第 2 句先回来也不先发（保序）')
  calls[0].resolve({ ok: true, audio: Buffer.from('A'), mime: 'audio/mpeg' })
  await tick()
  eq(emitted.map((e) => e.seq), [1, 2], 'Q6 补齐后按 1、2 顺序一起吐出')
}

{
  const emitted = []
  const { speak, calls } = makeFakeSpeak()
  const q = createSpeechQueue({ speak, emit: (p) => emitted.push(p), enabled: true, concurrency: 1 })
  q.feed('第一句。')
  await tick()
  q.stop('新回合')
  calls[0].resolve({ ok: true, audio: Buffer.from('A'), mime: 'audio/mpeg' })
  await tick()
  eq(emitted.filter((e) => e.type === 'speech').length, 0, 'Q7 打断后迟到的结果不播')
  ok(emitted.some((e) => e.type === 'speech-stop'), 'Q8 打断会发 speech-stop')
}

{
  const emitted = []
  const { speak, calls } = makeFakeSpeak()
  const q = createSpeechQueue({ speak, emit: (p) => emitted.push(p), enabled: true, concurrency: 1 })
  q.feed('第一句。第二句。')
  await tick()
  calls[0].resolve({ ok: false, error: '网络挂了' })
  await tick()
  calls[1].resolve({ ok: true, audio: Buffer.from('B'), mime: 'audio/mpeg' })
  await tick()
  eq(emitted.map((e) => e.seq), [2], 'Q9 中间一句失败，后面的照常播（不堵死）')
}

{
  const emitted = []
  const { speak } = makeFakeSpeak()
  const q = createSpeechQueue({ speak, emit: (p) => emitted.push(p), enabled: false })
  q.feed('关了就别播。')
  await tick()
  q.finish()
  await tick()
  eq(emitted.length, 0, 'Q10 enabled=false 时一个请求都不发')
}

{
  const emitted = []
  const { speak } = makeFakeSpeak()
  const q = createSpeechQueue({ speak, emit: (p) => emitted.push(p), enabled: true })
  q.say('闹钟：该喝水了。')
  await tick()
  ok(q.status().pending + q.status().inflight >= 1, 'Q11 say() 能一次把整段推进队列')
  eq(q.status().enabled, true, 'Q12 status 反映开关')
}

{
  const emitted = []
  const q = createSpeechQueue({ speak: undefined, emit: (p) => emitted.push(p), enabled: true })
  q.feed('没有合成器。')
  await tick()
  eq(emitted.length, 0, 'Q13 没有合成器时不炸、不播')
}

console.log('')
console.log(`${pass} PASS / ${fail} FAIL`)
if (fail > 0) {
  console.log('失败项：' + fails.join('、'))
  process.exit(1)
}
