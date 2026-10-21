/**
 * P4 微信桥验收探针 —— 真起一个本地 mock iLink 服务，验 W1~W4 与审批第二通道。
 *
 * 为什么不打真微信：真接口要能收到消息才有回包，探针没法自己往手机上发话；
 * 而且真接口的失败路径（5xx / 超时）不能按需制造。这里只验**我方行为**：
 * 请求形状对不对、游标有没有落盘、去重有没有多回、审批从手机回能不能收口。
 *
 * 跑法：node probe/wechat-mock.mjs   （不出网，全在本机 127.0.0.1）
 */

import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SANDBOX = join(process.cwd(), '_sandbox-wechat')
process.env.ORB_DATA = SANDBOX
rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(SANDBOX, { recursive: true })

const { createWechatBridge, createWechatCreds, describeCreds, weixinHeaders, MAX_SEND_CHARS } =
  await import('../src/wechat.mjs')
const { createWechatFront } = await import('../src/wechat.mjs')
const { createApprovalBroker } = await import('../src/approval.mjs')

const BOT = 'bot-test@im.bot'
const ME = 'me@im.wechat'
const TOKEN = 'tok-test-123'

let pass = 0
const fails = []
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  PASS ${name}`) }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── mock iLink 服务 ───────────────────────────────────────────────────────
const polls = []        // 每次 getupdates 依次消费一份响应
const sent = []         // 每次 sendmessage 记下 body + headers
const hits = []         // 所有到达的请求（含 500 模式）
let failMode = null     // 设成数字则以该 HTTP 状态失败
let lastBuf = ''

function bodyOf(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
  })
}

const server = createServer(async (req, res) => {
  const url = req.url || ''
  hits.push(url)
  const body = await bodyOf(req)
  const out = (status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (failMode) return out(failMode, { error: 'mock failure' })

  if (url.endsWith('/ilink/bot/getupdates')) {
    const next = polls.length > 0 ? polls.shift() : { get_updates_buf: lastBuf, msgs: [] }
    if (typeof next.get_updates_buf === 'string' && next.get_updates_buf) lastBuf = next.get_updates_buf
    req.seenBuf = body.get_updates_buf
    return out(200, next)
  }
  if (url.endsWith('/ilink/bot/sendmessage')) {
    sent.push({ body, headers: req.headers })
    return out(200, { ret: 0, errmsg: '' })
  }
  return out(404, { ret: -1, errmsg: 'no such route' })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

function writeCreds(patch = {}) {
  const creds = {
    enabled: true,
    baseUrl: BASE,
    botToken: TOKEN,
    botId: BOT,
    userId: ME,
    ...patch,
  }
  writeFileSync(join(SANDBOX, 'wechat.json'), `${JSON.stringify(creds, null, 2)}\n`, 'utf8')
  return creds
}

// ── 1. describeCreds：四种状态各一句，别把「没配」说成「关闭」 ──────────────
console.log('\n[1] 凭据描述')
check('关闭', describeCreds({ enabled: false }) === '微信：关闭', describeCreds({ enabled: false }))
check('开了但没 token', describeCreds({ enabled: true, botToken: '' }) === '微信：已开启但没填 botToken')
check('没接收人', /没有接收人/.test(describeCreds({ enabled: true, botToken: 'x', userId: '' })))
check('正常', describeCreds({ enabled: true, botToken: 'x', botId: BOT, userId: ME }) === `微信：开启（${BOT} → ${ME}）`)

// ── 2. 凭据仓：文件第一次就落盘（用户看得见、改得动） ────────────────────────
console.log('\n[2] 凭据仓')
rmSync(join(SANDBOX, 'wechat.json'), { force: true })
const credsStore = createWechatCreds({ dataRoot: SANDBOX, log: () => {} })
const firstCreds = credsStore.load()
check('首次 load 就把 wechat.json 写出来', existsSync(join(SANDBOX, 'wechat.json')))
check('落盘内容是合法 json 且有五个字段', ['enabled', 'baseUrl', 'botToken', 'botId', 'userId'].every((k) => k in firstCreds))
check('baseUrl 缺省指向 iLink', firstCreds.baseUrl.startsWith('http'))
writeCreds()
check('手写的 wechat.json 立刻生效', credsStore.load().botToken === TOKEN)
check('weixinHeaders 带 Bearer 与 ilink 标记', (() => {
  const h = weixinHeaders(TOKEN)
  return h.Authorization === `Bearer ${TOKEN}` && h.AuthorizationType === 'ilink_bot_token' && typeof h['X-WECHAT-UIN'] === 'string'
})())
check('无 token 时不带 Authorization', !('Authorization' in weixinHeaders('')))

// ── 3. 发消息：形状、上下文令牌、截断、错误码 ──────────────────────────────
console.log('\n[3] 发消息')
{
  const bridge = createWechatBridge({ dataRoot: SANDBOX, onMessage: () => {}, log: () => {} })
  const r = await bridge.send({ text: '在的', contextToken: 'ctx-1' })
  check('发送成功', r.ok === true, JSON.stringify(r))
  const last = sent[sent.length - 1]
  check('收件人是 userId', last.body.msg.to_user_id === ME)
  check('是文本消息（type 1 / message_type 2）', last.body.msg.message_type === 2 && last.body.msg.item_list[0].type === 1)
  check('正文原样', last.body.msg.item_list[0].text_item.text === '在的')
  check('带回 context_token', last.body.msg.context_token === 'ctx-1')
  check('带 channel_version', last.body.base_info.channel_version === '1.0.2')
  check('带 Bearer 头', last.headers.authorization === `Bearer ${TOKEN}`)

  const noCtx = await bridge.send({ text: '主动一句' })
  check('没有 context_token 就不带这个字段', noCtx.ok === true && !sent[sent.length - 1].body.msg.context_token)

  const long = 'x'.repeat(MAX_SEND_CHARS + 500)
  await bridge.send({ text: long })
  const trunc = sent[sent.length - 1].body.msg.item_list[0].text_item.text
  check('超长截到上限并加省略号', trunc.length === MAX_SEND_CHARS && trunc.endsWith('…'), `len=${trunc.length}`)

  const empty = await bridge.send({ text: '   ' })
  check('空正文不发送', empty.ok === false && /空/.test(empty.error))

  writeCreds({ botToken: '' })
  const noTok = await bridge.send({ text: 'x' })
  check('没 token 发不出去且不抛', noTok.ok === false && /botToken/.test(noTok.error))
  writeCreds()
}

// ── 4. 入站过滤 / 去重（W2） ────────────────────────────────────────────────
console.log('\n[4] 入站过滤')
{
  const logs = []
  const bridge = createWechatBridge({ dataRoot: SANDBOX, onMessage: () => {}, log: (s) => logs.push(s) })
  const msgs = [
    { message_id: 'm1', message_type: 1, from_user_id: ME, context_token: 'c1', item_list: [{ type: 1, text_item: { text: '在吗' } }] },
    { message_id: 'm2', message_type: 1, from_user_id: 'stranger@im.wechat', item_list: [{ type: 1, text_item: { text: '你是谁' } }] },
    { message_id: 'm3', message_type: 2, from_user_id: ME, item_list: [{ type: 1, text_item: { text: '图片' } }] },
    { message_id: 'm4', message_type: 1, from_user_id: ME, item_list: [{ type: 1, text_item: { text: '' } }] },
    { message_id: 'm1', message_type: 1, from_user_id: ME, context_token: 'c1', item_list: [{ type: 1, text_item: { text: '在吗' } }] },
  ]
  const picked = bridge.pickInbound({ msgs }, ME)
  check('只留下主人发的一句文本', picked.length === 1 && picked[0].text === '在吗', JSON.stringify(picked))
  check('保留 contextToken 供回话用', picked[0].contextToken === 'c1')
  check('陌生人被记一行日志且不回', logs.some((s) => /非主人/.test(s)))
  check('同批重复 message_id 只算一次', picked.length === 1)
  const again = bridge.pickInbound({ msgs }, ME)
  check('跨批重复仍然挡掉', again.length === 0)
  const noSelf = bridge.pickInbound({ msgs: [{ message_id: 'm9', message_type: 1, from_user_id: 'x', item_list: [{ type: 1, text_item: { text: 'hi' } }] }] }, '')
  check('没配 userId 时不做主人过滤（只挡空文本）', noSelf.length === 1)
}

// ── 5. 长轮询 + 游标落盘（W1）+ 派发 ────────────────────────────────────────
console.log('\n[5] 轮询与游标')
{
  const seenByHost = []
  const bridge = createWechatBridge({
    dataRoot: SANDBOX,
    onMessage: async (item) => { seenByHost.push(item.text) },
    log: () => {},
  })
  polls.push({
    get_updates_buf: 'cur-1',
    msgs: [{ message_id: 'p1', message_type: 1, from_user_id: ME, context_token: 'cX', item_list: [{ type: 1, text_item: { text: '在吗' } }] }],
  })
  const n1 = await bridge.pollOnce()
  check('一轮派发一条', n1 === 1 && seenByHost[0] === '在吗', `n=${n1}`)
  const st1 = JSON.parse(readFileSync(join(SANDBOX, 'wechat-state.json'), 'utf8'))
  check('游标落盘', st1.cursor === 'cur-1', st1.cursor)
  check('记了 lastPollAt 与 userId', st1.lastPollAt > 0 && st1.userId === ME)

  // 服务端回空 buf：游标必须保持，不能被清成空串（清空 = 下次从头取一遍）
  polls.push({ get_updates_buf: '', msgs: [] })
  await bridge.pollOnce()
  const st2 = JSON.parse(readFileSync(join(SANDBOX, 'wechat-state.json'), 'utf8'))
  check('服务端回空 buf 时游标不动', st2.cursor === 'cur-1', st2.cursor)
  check('空批不派发', seenByHost.length === 1)

  // 同一 message_id 在新批次里再出现（服务端重发）：不能再回一遍
  polls.push({
    get_updates_buf: 'cur-2',
    msgs: [{ message_id: 'p1', message_type: 1, from_user_id: ME, item_list: [{ type: 1, text_item: { text: '在吗' } }] }],
  })
  const n2 = await bridge.pollOnce()
  check('重发批次不重复回（seen 第二道网）', n2 === 0 && seenByHost.length === 1)
  check('带上了上次的游标去要增量', hits.length > 3)

  // 新桥上第一次请求要带上落盘的游标
  const bridge2 = createWechatBridge({ dataRoot: SANDBOX, onMessage: () => {}, log: () => {} })
  check('新实例读回落盘的游标', bridge2.state().cursor === 'cur-2', bridge2.state().cursor)
}

// ── 6. 失败退避：不放弃、也不刷屏（W3） ──────────────────────────────────────
console.log('\n[6] 轮询失败退避')
{
  writeCreds()
  const logs = []
  const bridge = createWechatBridge({ dataRoot: SANDBOX, onMessage: () => {}, log: (s) => logs.push(s) })
  failMode = 500
  const st = bridge.start()
  check('start() 立刻返回', st.started === true)
  const again = bridge.start()
  check('已在跑时 start 不叠第二个循环', again.started === false && /已经/.test(again.reason), JSON.stringify(again))
  await sleep(300)
  await bridge.stop()
  failMode = null
  const s = bridge.stats()
  check('失败被记数而不是抛出', s.errors >= 1, `errors=${s.errors}`)
  check('日志说了几秒后重试', logs.some((l) => /轮询失败/.test(l) && /后重试/.test(l)), logs.filter((l) => /轮询失败/.test(l))[0])
  const hitsAfterStop = hits.length
  await sleep(250)
  check('stop 之后不再轮询', hits.length === hitsAfterStop, `before=${hitsAfterStop} after=${hits.length}`)
}

// ── 7. 会话侧：判读、审批第二通道、排队 ────────────────────────────────────
console.log('\n[7] 会话侧')
{
  const replies = []
  const bridge = createWechatBridge({ dataRoot: SANDBOX, onMessage: () => {}, log: () => {} })
  const sendOriginal = bridge.send
  // 包一层记下每条回话，同时照旧打到 mock 服务
  const wrapped = {
    send: (o) => { replies.push(o.text); return sendOriginal(o) },
    stats: () => bridge.stats(),
  }

  const ballEvents = []
  const front = createWechatFront({
    bridge: wrapped,
    runTurn: async ({ text }) => `你说的是「${text}」`,
    log: () => {},
  })

  check('「允许」判为放行', front.verdictOf('允许') === true)
  check('「同意。」去掉标点也认', front.verdictOf(' 同意。 ') === true)
  check('「2」判为拒绝', front.verdictOf('2') === false)
  check('「拒绝」判为拒绝', front.verdictOf('拒绝') === false)
  check('闲聊不被当成答案', front.verdictOf('今天好累') === null)

  // 没有待批时回「允许」= 普通对话，交给模型
  const r0 = await front.receive({ text: '允许', msgId: 'x0', contextToken: '', at: Date.now() })
  check('没有待批卡时「允许」当普通对话', r0 === 'ran')
  await sleep(60)
  check('普通回合回话带上了正文', replies.some((t) => /你说的是「允许」/.test(t)))

  // 真审批器 + 手机回话
  const broker = createApprovalBroker({
    send: (o) => ballEvents.push(o),
    isConnected: () => true,
    log: () => {},
    timeoutMs: 5000,
    onAsk: (evt) => front.notifyAsk(evt),
  })
  const front2 = createWechatFront({
    bridge: wrapped,
    runTurn: async () => '不该跑到这里',
    approval: broker,
    log: () => {},
  })
  const askPromise = broker.ask({ toolName: 'write_file', args: { path: 'D:/x.txt', content: 'hi' }, reason: '在白名单外，只放行这一次' })
  await sleep(80)
  check('卡片发到了球上', ballEvents.some((e) => e.type === 'question'))
  check('手机上收到了 ⚠️ 提示', replies.some((t) => /⚠️ 她要写文件/.test(t) && /回「允许」或「拒绝」/.test(t)), replies[replies.length - 1])
  check('提示里带了「为什么问」', replies.some((t) => /在白名单外/.test(t)))

  const r1 = await front2.receive({ text: '允许', msgId: 'x1', contextToken: 'c-a', at: Date.now() })
  const verdict = await askPromise
  check('手机回「允许」走审批通道', r1 === 'approval')
  check('审批器收口为放行', verdict.approved === true, JSON.stringify(verdict))
  check('理由记明是从手机答的', /手机/.test(verdict.reason), verdict.reason)
  check('手机收到「按你说的办」', replies.some((t) => /按你说的办/.test(t)))
  check('球上收了卡片', ballEvents.some((e) => e.type === 'question-clear'))

  // 已收口的卡再回一次 → 当普通对话（不能再改结果）
  const r2 = await front2.receive({ text: '允许', msgId: 'x2', contextToken: '', at: Date.now() })
  check('卡片已收口后再回「允许」不算审批', r2 !== 'approval', r2)

  // 多张待批时让他回电脑（模拟 pendingIds 返回两条）
  const front3 = createWechatFront({
    bridge: wrapped,
    runTurn: async () => '',
    approval: { pendingIds: () => ['a', 'b'], answerFromChannel: () => true },
    log: () => {},
  })
  const r3 = await front3.receive({ text: '允许', msgId: 'x3', contextToken: '', at: Date.now() })
  check('多条待批时回「请在电脑上点一下」', r3 === 'approval' && replies.some((t) => /请在电脑上点/.test(t)))

  // 排队：跑一轮期间来的消息入队，满了直接回「稍后」
  let release
  const gate = new Promise((r) => { release = r })
  const front4 = createWechatFront({
    bridge: wrapped,
    runTurn: async ({ text }) => { await gate; return `回了${text}` },
    log: () => {},
    queueMax: 2,
  })
  const rFirst = await front4.receive({ text: '一', msgId: 'q1', contextToken: 'ctx-q', at: Date.now() })
  check('空闲时直接跑', rFirst === 'ran')
  const rSecond = await front4.receive({ text: '二', msgId: 'q2', contextToken: '', at: Date.now() })
  check('忙时入队', rSecond === 'queued')
  await front4.receive({ text: '三', msgId: 'q3', contextToken: '', at: Date.now() })
  await front4.receive({ text: '四', msgId: 'q4', contextToken: '', at: Date.now() })
  await front4.receive({ text: '五', msgId: 'q5', contextToken: '', at: Date.now() })
  const st4 = front4.stats()
  check('队列满后丢弃并回「稍后」', st4.dropped >= 1 && replies.some((t) => /稍后回你/.test(t)), JSON.stringify(st4))
  check('队列没超过上限', st4.queued <= 2 && st4.queued >= 1, JSON.stringify(st4))
  release()
  await sleep(150)
  check('排队的消息最终跑完', replies.filter((t) => /^回了/.test(t)).length >= 2, String(replies.filter((t) => /^回了/.test(t)).length))
  check('回话带回话令牌', sent.some((s) => s.body.msg.context_token === 'ctx-q'))

  // 回合里抛异常：不能让手机那边永远等
  const front5 = createWechatFront({
    bridge: wrapped,
    runTurn: async () => { throw new Error('模型挂了') },
    log: () => {},
  })
  await front5.receive({ text: '六', msgId: 'q6', contextToken: '', at: Date.now() })
  await sleep(80)
  check('回合异常也回一句人话', replies.some((t) => /岔子/.test(t)))
}

server.close()
await new Promise((r) => setTimeout(r, 50))

console.log(`\n${pass} PASS / ${fails.length} FAIL`)
if (fails.length) {
  console.log('FAIL 列表：')
  for (const f of fails) console.log(`  - ${f}`)
  process.exit(1)
}
process.exit(0)
