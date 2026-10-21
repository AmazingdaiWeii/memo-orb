/**
 * bili-auth-unit.mjs —— B 站扫码登录的单元探针（真网络，不需要人扫码）。
 *
 * 覆盖：
 *   A1 createBiliAuth 缺 dataRoot 直接抛（装配期错误要早响）
 *   A2 空目录 status()：loggedIn=false、description 含「未登录」、file 指到 dataRoot
 *   A3 start() 真打 passport：拿到 qrcodeKey / url / svg
 *   A4 svg 是合法二维码结构：<svg + viewBox + 至少 40 个 <rect>（模块数下限）
 *   A5 url 编进二维码后能过 qrMatrix 的容量检查（不抛 = 版本 1~10 装得下）
 *   A6 立刻 poll 一次 ⇒ state=waiting（86101），ok=true
 *   A7 poll('') ⇒ ok=false（缺键要早失败，别打网络）
 *   A8 parseLoginCookie 从伪造的 data.url 抽全 5 个键
 *   A9 parseLoginCookie 能从 Set-Cookie 兜底（url 为空时）
 *   A10 同一 key poll 两次都 waiting（幂等，不会被扫前状态机咬住）
 *   A11 logout() 空仓也 ok，且不抛
 *   A12 cookieHeader() 未登录时是空串
 *   A13 status({verify:true}) 未登录时不发网络请求（fetch 计数不涨）
 *   A14 写入伪造凭据后 status() 认它（loggedIn=true、uname 对）
 *   A15 过期时间早于现在 ⇒ loggedIn=false 且 expired=true
 *   A16 cookieHeader() 有凭据时返回整串（含 SESSDATA）
 *   A17 坏 JSON 不会让人崩：改名留证 + 当未登录
 *
 * 用法：node probe/bili-auth-unit.mjs [--data E:\path\to\sandbox]
 * 全部在临时 dataRoot 里跑，绝不碰生产 data/。
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBiliAuth, parseLoginCookie } from '../src/bili-auth.mjs'

const argv = process.argv.slice(2)
const sandboxArg = argv[argv.indexOf('--data') + 1]
const SANDBOX = argv.includes('--data') ? sandboxArg : join(process.cwd(), '_sandbox-data', 'bili-auth-unit')

let pass = 0
const fails = []
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fails.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 数 svg 里的 <rect> 个数（每个 rect 是一段连续黑模块，能当结构下限）。 */
function countRects(svg) {
  return (String(svg).match(/<rect/g) ?? []).length
}

console.log(`[probe] 沙箱：${SANDBOX}`)
rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(SANDBOX, { recursive: true })

// A1 -----------------------------------------------------------------------
let threw = false
try {
  createBiliAuth({})
} catch {
  threw = true
}
check('A1 缺 dataRoot 直接抛', threw)

const logLines = []
const auth = createBiliAuth({ dataRoot: SANDBOX, log: (m) => logLines.push(m) })

// A2 -----------------------------------------------------------------------
const s0 = await auth.status()
check('A2 空目录 = 未登录', s0.loggedIn === false && s0.ok === true, s0.description)
check('A2b file 指到 dataRoot', s0.file === join(SANDBOX, 'bili-auth.json'), s0.file)

// A12 / A16（先测空态） ------------------------------------------------------
check('A12 未登录 cookieHeader 是空串', auth.cookieHeader() === '')

// A3 -----------------------------------------------------------------------
const started = await auth.start()
check('A3 start() 拿到二维码', started.ok === true && !!started.qrcodeKey && !!started.url,
  started.ok ? `key=${String(started.qrcodeKey).slice(0, 8)}… url=${String(started.url).slice(0, 48)}…` : String(started.error))

// A4 -----------------------------------------------------------------------
const svg = String(started.svg || '')
check('A4 svg 有骨架', svg.startsWith('<svg') && svg.includes('viewBox') && svg.includes('shape-rendering="crispEdges"'))
check('A4b svg 模块段数够', countRects(svg) >= 40, `${countRects(svg)} 个 <rect>`)

// A5 -----------------------------------------------------------------------
let qrThrew = null
try {
  const { qrMatrix } = await import('../src/qr.mjs')
  const q = qrMatrix(String(started.url), { ecc: 'M' })
  qrThrew = `v${q.version}/${q.ecc}/mask${q.mask} size=${q.size}`
} catch (err) {
  qrThrew = `抛了：${err.message}`
}
check('A5 登录 URL 装得进二维码', !String(qrThrew).startsWith('抛了'), String(qrThrew))

// A7（放在 A6 前，免得空 key 打网络） ---------------------------------------
const bad = await auth.poll('')
check('A7 空 key 立即失败', bad.ok === false && !!bad.error)

// A6 -----------------------------------------------------------------------
const polled = await auth.poll(started.qrcodeKey)
check('A6 未扫码 ⇒ waiting', polled.ok === true && polled.state === 'waiting', String(polled.state))

// A10 ----------------------------------------------------------------------
const polled2 = await auth.poll(started.qrcodeKey)
check('A10 再 poll 一次仍 waiting', polled2.ok === true && polled2.state === 'waiting')

// A8 -----------------------------------------------------------------------
const fakeUrl =
  'https://www.bilibili.com/?SESSDATA=abc%2C123%2Cdef%2A11&bili_jct=JCTJCT& DedeUserID=9988&DedeUserID__ckMd5=md5md5&sid=sidsid&gourl=x'
const c1 = parseLoginCookie(fakeUrl.replace('& DedeUserID', '&DedeUserID'))
check('A8 从 data.url 抽出 5 键', ['SESSDATA=', 'bili_jct=', 'DedeUserID=9988', 'DedeUserID__ckMd5=', 'sid='].every((k) => c1.includes(k)), c1.slice(0, 60))

// A9 -----------------------------------------------------------------------
const c2 = parseLoginCookie('', [
  'SESSDATA=sess%2C1; Path=/; Domain=.bilibili.com; HttpOnly',
  'bili_jct=jj; Path=/',
  'DedeUserID=1234; Path=/',
  'DedeUserID__ckMd5=kk; Path=/',
  'bili_ticket=ignored; Path=/',
])
check('A9 Set-Cookie 兜底', c2.includes('SESSDATA=sess') && c2.includes('DedeUserID=1234') && !c2.includes('bili_ticket'), c2)

// A13 ----------------------------------------------------------------------
let fetchCount = 0
const counting = createBiliAuth({
  dataRoot: SANDBOX,
  log: () => {},
  fetchImpl: (...args) => {
    fetchCount += 1
    return fetch(...args)
  },
})
const sVerify = await counting.status({ verify: true })
check('A13 未登录时 verify 不发请求', sVerify.loggedIn === false && fetchCount === 0, `fetch=${fetchCount}`)

// A14 / A16 ----------------------------------------------------------------
const credFile = join(SANDBOX, 'bili-auth.json')
writeFileSync(
  credFile,
  JSON.stringify(
    {
      savedAt: Date.now(),
      expiresAt: Date.now() + 86400_000,
      mid: '424242',
      uname: '探针用户',
      avatar: 'https://i0.hdslb.com/bfs/face/x.jpg',
      vip: false,
      cookie: 'SESSDATA=fake-sess; bili_jct=fake-jct; DedeUserID=424242',
    },
    null,
    2,
  ),
)
auth.reload()
const s1 = await auth.status()
check('A14 有凭据 ⇒ 已登录', s1.loggedIn === true && s1.uname === '探针用户' && s1.mid === '424242', s1.description)
check('A16 cookieHeader 含 SESSDATA', auth.cookieHeader().includes('SESSDATA=fake-sess'))

// A15 ----------------------------------------------------------------------
writeFileSync(
  credFile,
  JSON.stringify(
    { savedAt: 1, expiresAt: 2, mid: '1', uname: 'old', avatar: '', cookie: 'SESSDATA=gone' },
    null,
    2,
  ),
)
auth.reload()
const s2 = await auth.status()
check('A15 过期 ⇒ 未登录 + expired', s2.loggedIn === false && s2.expired === true, s2.description)
check('A15b 过期后 cookieHeader 空', auth.cookieHeader() === '')

// A17 ----------------------------------------------------------------------
writeFileSync(credFile, '{ this is not json', 'utf8')
auth.reload()
const s3 = await auth.status()
const broken = readdirSync(SANDBOX).filter((n) => n.startsWith('bili-auth.json.broken-'))
check('A17 坏 JSON 改名留证并当未登录', s3.loggedIn === false && broken.length === 1, broken.join(',') || '没找到 .broken 文件')

// A11 ----------------------------------------------------------------------
const out = await auth.logout()
check('A11 logout 空仓也 ok', out.ok === true)
check('A11b 文件已删', !existsSync(credFile))

// 日志纪律：全程不得出现 SESSDATA 的值 --------------------------------------
const joined = logLines.join('\n')
check('L1 日志不出现 cookie 值', !joined.includes('fake-sess') && !joined.includes('SESSDATA='), joined.split('\n').filter(Boolean).slice(0, 3).join(' | '))

console.log(`\n[probe] ${pass} 通过 / ${fails.length} 失败`)
if (fails.length > 0) {
  for (const f of fails) console.log(`  - ${f}`)
  process.exit(1)
}
