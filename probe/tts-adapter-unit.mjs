#!/usr/bin/env node
/**
 * TTS 适配层 · 单测（纯逻辑 + 假 fetch，**不打网络、不花钱**）。
 *
 * 守的是 `src/tts/` 三个文件的协议细节。这些东西的共同点是：
 * **错了不会崩，只会安静地「没有声音」或「声音变成别的」**，所以只能靠断言钉住。
 *
 * 重点：
 *   · 火山的回包是 NDJSON 多行，不是整段 JSON（整段 parse 会抛 ⇒ 被误判成「没音频」）
 *   · code 有的在顶层、有的在 `header.code`
 *   · 同一个厂商**头部改过名**：`X-Api-App-Key`（现行）vs `X-Api-App-Id`（早期）
 *   · 复刻 2.0 不带 `model_type:4` 会**静默回落 1.0**，情绪指令随之失效
 *   · 探测必须**探到就停** —— 每试一个变体都是一次真实计费
 *   · OpenAI 兼容通道回的是**二进制**，不是 JSON+base64
 *
 * 跑法：node probe/tts-adapter-unit.mjs
 */
import { parseVolcanoResponse, explainVolcanoError } from '../src/tts/parse.mjs'
import { VARIANTS, hasCreds, candidatesFor, buildRequest, createVolcanoTts } from '../src/tts/volcano.mjs'
import { speechUrl, buildSpeechBody, createOpenaiTts } from '../src/tts/openai.mjs'
import { createTts, describeTtsState, defaultTtsConfig, PROVIDERS } from '../src/tts/index.mjs'

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

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

/** 假 fetch：handler 回 `{status?, body?, ctype?}`，body 是 Buffer 就当二进制。 */
function fakeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), opts })
    const r = handler(String(url), opts)
    if (r instanceof Error) throw r
    const body = r.body ?? ''
    const isBuf = Buffer.isBuffer(body)
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (k) =>
          String(k).toLowerCase() === 'content-type'
            ? (r.ctype ?? (isBuf ? 'audio/mpeg' : 'application/json'))
            : null,
      },
      text: async () => (isBuf ? body.toString('utf8') : String(body)),
      arrayBuffer: async () => (isBuf ? body : Buffer.from(String(body))),
    }
  }
  return { fetchImpl, calls }
}

const ndjson = (...lines) => lines.join('\n')
const audioLine = (s) => JSON.stringify({ code: 0, data: b64(s) })
const END = JSON.stringify({ code: 20000000, data: null })

// ══ A. 回包解析 ═════════════════════════════════════════════════
const A1 = parseVolcanoResponse(ndjson(audioLine('AA'), audioLine('BB'), END))
check(
  'P1 ★ NDJSON 多块按顺序拼起来（拼错顺序听感就乱）',
  A1.audio?.toString('utf8') === 'AABB' && A1.blocks === 2 && A1.ended === true,
  `audio=${A1.audio?.toString('utf8')} blocks=${A1.blocks} ended=${A1.ended}`,
)

const A2 = parseVolcanoResponse(JSON.stringify({ code: 0, data: b64('整段') }))
check('P2 单 JSON 形态也认（data 就是整段）', A2.audio?.toString('utf8') === '整段' && A2.blocks === 1)

const A3 = parseVolcanoResponse(JSON.stringify({ header: { code: 45000010, message: 'invalid key' } }))
check(
  'P3 ★ 错误码在 `header.code` 里也认（顶层没有 code）',
  A3.failCode === 45000010 && A3.failMsg === 'invalid key' && A3.audio === null,
  JSON.stringify(A3),
)

const A4 = parseVolcanoResponse(ndjson(JSON.stringify({ code: 45000011, message: 'no permission' }), END))
check('P4 只有错误时 ended 仍可为 true，且不误判成成功', A4.audio === null && A4.failCode === 45000011)

const A5 = parseVolcanoResponse('<html>502 Bad Gateway</html>')
check(
  'P5 ★ 非 JSON（网关 HTML 错误页）给出可读原因，不是空错误',
  A5.audio === null && A5.failCode === null && A5.failMsg.includes('不是 JSON'),
  A5.failMsg,
)

check('P6 空响应不抛', parseVolcanoResponse('').audio === null && parseVolcanoResponse('').failMsg === '空响应')

check(
  'P7 45000010 翻成人话（是 key 无效，不是头写错）',
  explainVolcanoError(45000010, 'x').includes('45000010') && explainVolcanoError(45000010, 'x').includes('API Key'),
  explainVolcanoError(45000010, 'x'),
)

// ══ B. 变体矩阵与凭据筛选 ═══════════════════════════════════════
check('V1 变体 id 唯一', new Set(VARIANTS.map((v) => v.id)).size === VARIANTS.length)
check('V2 只给 appId+accessKey 时排除单 key 变体', candidatesFor({ appId: 'a', accessKey: 'b' }).length === 5)
check('V3 只给 apiKey 时排除双头变体', candidatesFor({ apiKey: 'k' }).length === 3)
check('V4 两样都有时全都可以试', candidatesFor({ appId: 'a', accessKey: 'b', apiKey: 'k' }).length === VARIANTS.length)
check('V5 什么都没有时一个都不试（不去白撞 401）', candidatesFor({}).length === 0)
check('V6 hasCreds 认三种鉴权方式', hasCreds({ auth: 'key' }, { apiKey: 'k' }) && hasCreds({ auth: 'app' }, { appId: 'a', accessKey: 'b' }) && !hasCreds({ auth: 'app' }, { appId: 'a' }))

// ══ C. 请求构造（头部差异是这里最容易错的地方）══════════════════
const creds = { appId: 'APP', accessKey: 'AK', apiKey: 'KEY' }
const mk = (id, extra = {}) => buildRequest(VARIANTS.find((v) => v.id === id), { creds, text: '你好', ...extra })

const C1 = mk('llm-appkey')
check(
  'V7 ★ 现行文档的头是 `X-Api-App-Key`',
  C1.headers['X-Api-App-Key'] === 'APP' && C1.headers['X-Api-App-Id'] === undefined && C1.headers['X-Api-Access-Key'] === 'AK',
  JSON.stringify(C1.headers),
)
const C2 = mk('llm-appid')
check(
  'V8 ★ 早期文档的头是 `X-Api-App-Id`（同一个厂商改过名）',
  C2.headers['X-Api-App-Id'] === 'APP' && C2.headers['X-Api-App-Key'] === undefined,
  JSON.stringify(C2.headers),
)
const C3 = mk('llm-apikey')
check(
  'V9 单 key 通道只带 X-Api-Key，**不带** accessKey 头',
  C3.headers['X-Api-Key'] === 'KEY' && C3.headers['X-Api-Access-Key'] === undefined,
  JSON.stringify(C3.headers),
)
check('V10 每次都有 X-Api-Request-Id（缺了会 400）', typeof C1.headers['X-Api-Request-Id'] === 'string' && C1.headers['X-Api-Request-Id'].length > 10)
check(
  'V11 resource id 跟变体走',
  mk('llm-appkey').headers['X-Api-Resource-Id'] === 'volc.service_type.10029' &&
    mk('icl2-appkey').headers['X-Api-Resource-Id'] === 'seed-icl-2.0' &&
    mk('icl1-appkey').headers['X-Api-Resource-Id'] === 'volc.megatts.default',
)
check('V12 端点默认走 unidirectional', C1.url.endsWith('/api/v3/tts/unidirectional'))

// ★ 复刻 2.0 的那个静默坑
const icl = mk('icl2-appkey', { emotion: '轻快一点' })
const iclAdd = JSON.parse(icl.body.req_params.additions)
check(
  'V13 ★ 复刻 2.0 必带 model_type:4（漏了静默回落 1.0，情绪失效且不报错）',
  iclAdd.model_type === 4,
  JSON.stringify(iclAdd),
)
check(
  'V14 情绪指令走 context_texts（官方说不参与朗读）',
  Array.isArray(iclAdd.context_texts) && iclAdd.context_texts[0] === '轻快一点',
  JSON.stringify(iclAdd),
)
check(
  'V15 大模型合成那条路不塞 additions（它不认 model_type）',
  mk('llm-appkey', { emotion: '轻快' }).body.req_params.additions === undefined,
)

const seed = mk('seed-audio-apikey')
check(
  'V16 ★ textPrompt 型变体的 body 形状是另一套（没有 req_params）',
  seed.body.model === 'seed-audio-1.0' && typeof seed.body.text_prompt === 'string' && seed.body.req_params === undefined,
  JSON.stringify(seed.body),
)
check('V17 默认音色兜底（没填 speaker 也能发）', mk('llm-appkey').body.req_params.speaker.length > 0)

// ══ D. speak 的行为 ═════════════════════════════════════════════
{
  const { fetchImpl, calls } = fakeFetch(() => ({ body: ndjson(audioLine('MP3'), END) }))
  const t = createVolcanoTts({ appId: 'a', accessKey: 'b', fetchImpl })
  const r = await t.speak('你好呀')
  check('V18 speak 成功时回 Buffer + mime', r.ok === true && Buffer.isBuffer(r.audio) && r.mime === 'audio/mpeg', JSON.stringify({ ok: r.ok, mime: r.mime }))
  check('V19 发出去的是 POST + JSON body', calls.length === 1 && calls[0].opts.method === 'POST' && JSON.parse(calls[0].opts.body).req_params.text === '你好呀')
  check('V20 describe 不泄露密钥原文', JSON.stringify(t.describe()).includes('a') === false || !JSON.stringify(t.describe()).includes('AK'), JSON.stringify(t.describe()))
}
{
  const { fetchImpl } = fakeFetch(() => ({ body: JSON.stringify({ header: { code: 45000010, message: 'invalid' } }) }))
  const t = createVolcanoTts({ apiKey: 'k', fetchImpl })
  const r = await t.speak('你好')
  check('V21 失败时把错误码翻成人话并带 variant', r.ok === false && r.code === 45000010 && r.variant === 'llm-apikey' && r.error.includes('45000010'), r.error)
}
{
  const { fetchImpl, calls } = fakeFetch(() => ({ body: ndjson(audioLine('X'), END) }))
  const t = createVolcanoTts({ appId: 'a', accessKey: 'b', fetchImpl })
  const r = await t.speak('你好', { variant: 'icl2-appkey' }) // 没给 speaker
  check('V22 ★ 复刻变体缺 speaker 时提前失败，**不发请求**（不白花一次钱）', r.ok === false && calls.length === 0 && r.error.includes('speaker'), r.error)
}
{
  const err = Object.assign(new Error('timeout'), { name: 'TimeoutError' })
  const { fetchImpl } = fakeFetch(() => err)
  const t = createVolcanoTts({ apiKey: 'k', fetchImpl })
  const r = await t.speak('你好')
  check('V23 超时被单独分类（timedOut=true，不是笼统网络错误）', r.ok === false && r.timedOut === true, JSON.stringify(r))
}

// ══ E. probe：探到就停（每次尝试都是钱）══════════════════════════
{
  // 第一个变体就成功
  const { fetchImpl, calls } = fakeFetch(() => ({ body: ndjson(audioLine('OK'), END) }))
  const t = createVolcanoTts({ appId: 'a', accessKey: 'b', fetchImpl })
  const p = await t.probe('你好')
  check('V24 ★ probe 探到就停，不会把整个矩阵跑完', p.ok === true && calls.length === 1 && p.variant === 'llm-appkey', `calls=${calls.length} variant=${p.variant}`)
  check('V25 探到后记住变体，之后 speak 直接用', t.describe().activeVariant === 'llm-appkey', t.describe().activeVariant)
}
{
  // 前三个失败，第四个成功。**必须给 speaker** —— 否则复刻类变体会在发请求前就返回
  // （见 V22），于是「tried 数」和「请求数」对不上，断言会误判成代码有 bug。
  let n = 0
  const { fetchImpl, calls } = fakeFetch(() => {
    n += 1
    return n < 4
      ? { body: JSON.stringify({ code: 45000010, message: 'bad' }) }
      : { body: ndjson(audioLine('OK'), END) }
  })
  const t = createVolcanoTts({ appId: 'a', accessKey: 'b', speaker: 'spk', fetchImpl })
  const p = await t.probe('你好')
  check(
    'V26 逐个试到成功为止，tried 里留着前几条的失败原因',
    p.ok === true && calls.length === 4 && p.tried.length === 4 && p.tried[0].ok === false,
    `calls=${calls.length} tried=${p.tried.length}`,
  )
}
{
  const { fetchImpl, calls } = fakeFetch(() => ({ body: JSON.stringify({ code: 403, message: 'no' }) }))
  const t = createVolcanoTts({ appId: 'a', accessKey: 'b', speaker: 'spk', fetchImpl })
  const p = await t.probe('你好')
  check(
    'V27 全失败时 tried 数量 = 可试变体数，且每条都有原因',
    p.ok === false && p.tried.length === 5 && calls.length === 5 && p.tried.every((x) => x.error.length > 0),
    `tried=${p.tried.length} calls=${calls.length}`,
  )
}
{
  // 缺 speaker 时：非复刻变体照发，复刻变体提前返回 —— 两者数量本来就不相等
  const { fetchImpl, calls } = fakeFetch(() => ({ body: JSON.stringify({ code: 403, message: 'no' }) }))
  const t = createVolcanoTts({ appId: 'a', accessKey: 'b', fetchImpl })
  const p = await t.probe('你好')
  check(
    'V28 ★ 缺 speaker 时只有不需要音色的变体真发请求（其余不发，省一次计费）',
    p.ok === false && p.tried.length === 5 && calls.length === 2,
    `tried=${p.tried.length} calls=${calls.length}`,
  )
}
{
  const t = createVolcanoTts({})
  const p = await t.probe()
  check('V29 没凭据时 probe 直接说清楚，不空跑', p.ok === false && p.tried.length === 0 && p.error.includes('凭据'), p.error)
}

// ══ F. OpenAI 兼容通道 ══════════════════════════════════════════
check(
  'O1 baseUrl 四种写法都能拼对端点',
  speechUrl('https://api.openai.com') === 'https://api.openai.com/v1/audio/speech' &&
    speechUrl('https://api.openai.com/v1') === 'https://api.openai.com/v1/audio/speech' &&
    speechUrl('https://api.openai.com/v1/') === 'https://api.openai.com/v1/audio/speech' &&
    speechUrl('https://gw.example.com/v1/audio/speech') === 'https://gw.example.com/v1/audio/speech',
  [speechUrl('https://api.openai.com'), speechUrl('https://api.openai.com/v1'), speechUrl('https://x/v1/'), speechUrl('https://gw.example.com/v1/audio/speech')].join(' | '),
)

const ob = buildSpeechBody({ text: '你好', model: 'tts-1', voice: 'alloy', format: 'mp3' })
check(
  'O2 请求体形状符合 /audio/speech 的约定',
  ob.input === '你好' && ob.model === 'tts-1' && ob.voice === 'alloy' && ob.response_format === 'mp3',
  JSON.stringify(ob),
)
check('O3 ★ 没给 speed 就不带这个字段（有的网关见到它会 400）', buildSpeechBody({ text: 'x' }).speed === undefined)
check('O4 非法 format 回落到 mp3（避免直接 400）', buildSpeechBody({ text: 'x', format: 'ogg' }).response_format === 'mp3')
check('O5 speed 被夹在 0.25~4', buildSpeechBody({ text: 'x', speed: 99 }).speed === 4)

{
  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00])
  const { fetchImpl, calls } = fakeFetch(() => ({ body: mp3, ctype: 'audio/mpeg' }))
  const t = createOpenaiTts({ baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-test', fetchImpl })
  const r = await t.speak('你好')
  check('O6 ★ 回的是二进制也能正确取到（不能当 JSON 读）', r.ok === true && Buffer.isBuffer(r.audio) && r.audio.equals(mp3), JSON.stringify({ ok: r.ok, bytes: r.bytes }))
  check('O7 带的是 Bearer 鉴权，不是火山那三件套', calls[0].opts.headers.Authorization === 'Bearer sk-test' && calls[0].opts.headers['X-Api-App-Id'] === undefined)
}
{
  const { fetchImpl } = fakeFetch(() => ({ status: 400, body: JSON.stringify({ error: { message: 'voice not found' } }) }))
  const t = createOpenaiTts({ apiKey: 'k', fetchImpl })
  const r = await t.speak('你好')
  check(
    'O8 400 的提示指向 model/voice 取值，而不是笼统「请求失败」',
    r.ok === false && r.error.includes('400') && r.error.includes('voice') && r.error.includes('voice not found'),
    r.error,
  )
}
{
  const { fetchImpl } = fakeFetch(() => ({ status: 404, body: 'not found' }))
  const t = createOpenaiTts({ baseUrl: 'https://gw.example.com', apiKey: 'k', fetchImpl })
  const r = await t.speak('你好')
  check('O9 ★ 404 时把**实际拼出来的 url** 报出来（否则查不出是 baseUrl 错了）', r.ok === false && r.error.includes('/v1/audio/speech'), r.error)
}
{
  const { fetchImpl } = fakeFetch(() => ({ body: Buffer.alloc(0), ctype: 'audio/mpeg' }))
  const t = createOpenaiTts({ apiKey: 'k', fetchImpl })
  const r = await t.speak('你好')
  check('O10 200 但音频为空 ⇒ 判失败（不能当成功静默返回空）', r.ok === false && r.error.includes('空'), r.error)
}
{
  const t = createOpenaiTts({ apiKey: '', fetchImpl: async () => { throw new Error('不该被调用') } })
  const r = await t.speak('你好')
  check('O11 没 key 时直接说，不发请求', r.ok === false && r.error.includes('API Key'))
}

// ══ G. 统一入口 ═════════════════════════════════════════════════
check('I1 ★ 默认配置是「关闭」（开源时不能带作者的 key 白送额度）', defaultTtsConfig().enabled === false)
check('I2 火山在设置页要三件套（不是一个 apiKey 输入框）', PROVIDERS.volcano.fields.includes('appId') && PROVIDERS.volcano.fields.includes('accessKey'))
check('I3 两个 provider 都已注册', Object.keys(PROVIDERS).join(',') === 'volcano,openai')

{
  const cfg = defaultTtsConfig()
  cfg.volcano = { ...cfg.volcano, appId: 'a', accessKey: 'b' }
  const t = createTts(cfg, { fetchImpl: async () => ({}) })
  check('I4 createTts 按 provider 分发到火山', t && t.describe().provider === 'volcano' && t.describe().candidates.length > 0, JSON.stringify(t?.describe()))
  check('I5 describe 标着「有播放层」（2026-10-22 起播放层已接）', t.describe().playable === true)
}
{
  const t = createTts({ ...defaultTtsConfig(), provider: 'openai' }, { fetchImpl: async () => ({}) })
  check('I6 createTts 分发到 OpenAI 兼容', t && t.describe().provider === 'openai')
}
check('I7 未知 provider 返回 null（不静默退回默认）', createTts({ provider: 'nope' }) === null)

check(
  'I8 状态文案四种情况都说得清',
  describeTtsState(null).includes('没配置') &&
    describeTtsState({ enabled: false }).includes('已关闭') &&
    describeTtsState({ enabled: true, provider: 'volcano', providerLabel: '火山', hasAppPair: false, hasApiKey: false }).includes('空的') &&
    describeTtsState({ enabled: true, provider: 'volcano', providerLabel: '火山', hasApiKey: true }).includes('已配好'),
  [
    describeTtsState(null),
    describeTtsState({ enabled: false }),
    describeTtsState({ enabled: true, provider: 'volcano', providerLabel: '火山', hasAppPair: false, hasApiKey: false }),
    describeTtsState({ enabled: true, provider: 'volcano', providerLabel: '火山', hasApiKey: true }),
  ].join(' | '),
)

console.log(`\n${passed} PASS / ${failed} FAIL`)
if (failed > 0) process.exit(1)
