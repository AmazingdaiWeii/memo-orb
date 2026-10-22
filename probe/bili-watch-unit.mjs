#!/usr/bin/env node
/**
 * bili-watch-unit.mjs —— `bili_watch` 接线体检（纯 Node，不需要 Electron）。
 *
 * 分三层断言：
 *   S 静态：地址解析 / 秒数解析 这些纯函数；
 *   T 真网：拿 BV1GJ411x7h7（213 秒、852×480、匿名最高 480P）走「只要元信息」这条路；
 *   B 接线：brain 的工具表 / system prompt 的 B 站段 / 取帧时「非 Electron 进程要优雅失败」。
 *
 * 为什么不在这里测真取帧：`kfdecode.mjs` 一进门就 `import electron`，
 * 只有 Electron 主进程能载。真取帧见 `probe/bili-watch-electron.mjs` 与 `probe/bili-frame-e2e.mjs`。
 *
 * 跑法：`node probe/bili-watch-unit.mjs`
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MAX_FRAMES,
  parseVideoRef,
  parsePage,
  parseTimes,
  createBiliWatch,
  WATCH_MODES,
  parseWatchMode,
} from '../src/bili-watch.mjs'
import { buildTools } from '../src/brain.mjs'
import { GUIDE_VERSION, buildToolGuide, renderSystemText } from '../src/snapshot.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`PASS ${name}${extra ? '  ' + extra : ''}`)
  } else {
    fail++
    failures.push(name)
    console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`)
  }
}

function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)}`)
}

// ───────────────────────── S：纯函数 ─────────────────────────
eq('S1 整条链接取 BV', parseVideoRef('https://www.bilibili.com/video/BV1GJ411x7h7?p=3&t=10'), {
  bvid: 'BV1GJ411x7h7',
  aid: null,
})
eq('S2 裸 BV 号', parseVideoRef('BV1GJ411x7h7'), { bvid: 'BV1GJ411x7h7', aid: null })
eq('S3 av 号', parseVideoRef('av170001'), { bvid: null, aid: 170001 })
eq('S4 链接里的 av', parseVideoRef('https://www.bilibili.com/video/av170001'), {
  bvid: null,
  aid: 170001,
})
eq('S5 看不懂的地址', parseVideoRef('随便一句话'), { bvid: null, aid: null })
eq('S6 空值不抛', parseVideoRef(undefined), { bvid: null, aid: null })
ok('S7 BV 号不会误吞 av 数字', parseVideoRef('BV1GJ411x7h7').aid === null)

eq('S8 URL 里的 ?p=', parsePage('https://www.bilibili.com/video/BV1GJ411x7h7?p=3'), 3)
eq('S9 没有 p 就用 fallback', parsePage('https://www.bilibili.com/video/BV1GJ411x7h7'), 1)
eq('S10 URL 里的 p 优先于 fallback', parsePage('https://x/video/BV1?p=9', 2), 9)
ok(
  'S10b watch 里模型显式给的 page 优先于 URL',
  /Number\(args\.page\)[\s\S]{0,160}parsePage\(args\.url/.test(
    readFileSync(join(ROOT, 'src', 'bili-watch.mjs'), 'utf8'),
  ),
)

eq('S11 数组秒数', parseTimes([1, 2.5, 30]), [1, 2.5, 30])
eq('S12 逗号字符串秒数', parseTimes('12, 30.5'), [12, 30.5])
eq('S13 负数/非数字被丢掉', parseTimes([-1, 'x', 5, null, NaN]), [5])
ok('S14 秒数上限 8 条', parseTimes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).length === MAX_FRAMES)
ok('S15 空值给空数组', Array.isArray(parseTimes(undefined)) && parseTimes(undefined).length === 0)

// ───────────────────────── T：真网（只要元信息） ─────────────────────────
const BV = 'BV1GJ411x7h7'
const watch = createBiliWatch({
  getCookie: () => '',
  log: (m) => console.log(`  · ${m}`),
})

{
  const r = await watch.watch({ url: '这不是视频' })
  ok('T1 坏地址直接说不懂', r.ok === false && /看不懂|给 BV/.test(r.text), r.text.slice(0, 40))
}

let meta1 = null
try {
  meta1 = await watch.watch({ url: BV, frames: 0 })
  ok('T2 只看元信息成功', meta1.ok === true, meta1.ok ? '' : meta1.text)
  if (meta1.ok) {
    ok('T3 拿到标题', typeof meta1.meta.title === 'string' && meta1.meta.title.length > 0, meta1.meta.title)
    eq('T4 时长 213s', meta1.meta.duration, 213)
    eq('T5 aid', meta1.meta.aid, 80433022)
    eq('T6 cid', meta1.meta.cid, 137649199)
    ok('T7 宽高是 852×480', meta1.meta.width === 852 && meta1.meta.height === 480, `${meta1.meta.width}×${meta1.meta.height}`)
    ok('T8 匿名画质写明 480P', /480P/.test(meta1.meta.qualityLabel), meta1.meta.qualityLabel)
    ok('T9 frames=0 时没有 images 字段', meta1.images === undefined)
    ok('T10 正文提示「没要帧」', /没要帧/.test(meta1.text), meta1.text.split('\n').pop())
    ok('T11 正文带 aid/cid', /aid 80433022/.test(meta1.text) && /cid 137649199/.test(meta1.text))
  }
} catch (err) {
  ok('T2 只看元信息成功', false, `抛了：${err.message}`)
}

// ───────────────────────── B：接线 ─────────────────────────
{
  const withBili = buildTools({ web: false, bili: true })
  const without = buildTools({ web: false, bili: false })
  const names = withBili.map((t) => t.function?.name)
  ok('B1 bili=true 时有 bili_watch', names.includes('bili_watch'), names.join(','))
  ok('B2 bili=false 时没有', !without.map((t) => t.function?.name).includes('bili_watch'))
  const spec = withBili.find((t) => t.function?.name === 'bili_watch').function
  eq('B3 必填参数是 url', spec.parameters.required, ['url'])
  ok('B4 参数里有 frames/times', 'frames' in spec.parameters.properties && 'times' in spec.parameters.properties)
  ok('B5 描述写清关键帧不是全片', /关键帧/.test(spec.description))
}

{
  eq('B6 GUIDE_VERSION 已升到 8（+余额/看法自选）', GUIDE_VERSION, 8)
  const g1 = buildToolGuide({ web: false, bili: true })
  const g0 = buildToolGuide({ web: false, bili: false })
  ok('B7 bili 段出现', /B 站/.test(g1), g1.match(/## B 站[^\n]*/)?.[0] ?? '(无标题)')
  ok('B8 不给 bili 就没有该段', !/B 站/.test(g0))
  ok('B9 该段说明「没登录最高 480P」', /480P/.test(g1))
}

{
  const src = readFileSync(join(ROOT, 'src', 'brain.mjs'), 'utf8')
  ok('B10 executeTool 有 bili_watch 分支', /case 'bili_watch'/.test(src))
  ok('B11 工具结果转图片走 user 消息', /type: 'image_url'/.test(src) && /imageSink/.test(src))
  ok('B12 每回合图片上限是 8', /MAX_TOOL_IMAGES\s*=\s*8/.test(src))
  const main = readFileSync(join(ROOT, 'src', 'main.mjs'), 'utf8')
  ok('B13 main 装配了 bili 并注入 brain', /createBiliWatch\(/.test(main) && /bili,\s*\r?\n/.test(main))
  ok('B14 cookie 来自扫码登录落盘那份', /ensureBiliAuth\(\)[\s\S]{0,80}cookieHeader\(\)/.test(main))
}

// ───────────────────────── L：账号身份（2026-10-21） ─────────────────────────
// 起因：她明明在用用户的账号看（480P→720P），却在对话里说「我这边没登录你的账号」——
// 因为工具结果里根本没有「我是谁」这一块，她只能凭画质猜。这几条守住那一行。
{
  const loggedIn = createBiliWatch({
    getCookie: () => '',
    getAccount: () => ({ loggedIn: true, uname: '测试账号', mid: 123456789, vip: false }),
  })
  const r = await loggedIn.watch({ url: BV, frames: 0 })
  ok('L1 登录态：结果里带 account.loggedIn', r.ok && r.meta?.account?.loggedIn === true)
  ok('L2 登录态：正文写清用户昵称', /测试账号/.test(r.text), r.text.split('\n')[2] ?? '')
  ok('L3 登录态：正文标明普通账号（不是大会员）', /普通账号/.test(r.text))
  ok('L4 登录态：正文带上这次实际给到的画质', /实际给到/.test(r.text))

  const anonymous = createBiliWatch({
    getCookie: () => '',
    getAccount: () => ({ loggedIn: false }),
  })
  const r2 = await anonymous.watch({ url: BV, frames: 0 })
  ok('L5 未登录：正文明确写「未登录」并说明 480P 上限', /未登录/.test(r2.text) && /480P/.test(r2.text))
  ok('L6 未登录：告诉她去设置里扫码，而不是让她自己猜', /设置/.test(r2.text) && /扫码/.test(r2.text))
  ok('L7 未登录：meta.account.loggedIn 是 false', r2.meta?.account?.loggedIn === false)

  // getAccount 抛错要降级成「未登录」，不能把整次观看拖崩（保守方向）。
  const broken = createBiliWatch({
    getCookie: () => '',
    getAccount: () => { throw new Error('boom') },
  })
  const r3 = await broken.watch({ url: BV, frames: 0 })
  ok('L8 getAccount 抛错时降级为未登录且观看照常成功', r3.ok === true && r3.meta?.account?.loggedIn === false)
}

// ───────────────────── H：bili_history 工具接线 ─────────────────────
{
  const withHistory = buildTools({ bili: true, biliHistory: true }).map((t) => t.function.name)
  const withoutHistory = buildTools({ bili: true, biliHistory: false }).map((t) => t.function.name)
  ok('H1 有账本时有 bili_history 工具', withHistory.includes('bili_history'))
  ok('H2 没账本时不暴露 bili_history（别给她一个会报错的工具）', !withoutHistory.includes('bili_history'))
  const guide = buildToolGuide({ web: true, bili: true })
  ok('H3 指南告诉她用 bili_history 查「上次那个视频」', /bili_history/.test(guide))
  ok('H4 指南写明「用的是他本人的账号」，别自己猜', /本人的 B 站账号|他本人登录的 B 站账号/.test(guide))
}

// ───────────────────── M：看法档位（quick / thorough）─────────────────────
// 2026-10-21 用户拍板：不再做菜单让用户选，交给她按余额自己定。
// 所以这几条守的是「档位真的能改变取帧参数」+「显式 frames 不许被档位覆盖」。
{
  eq('M1 quick = 2 帧 / 480×270', [WATCH_MODES.quick.frames, WATCH_MODES.quick.maxOut], [2, { w: 480, h: 270 }])
  eq('M2 thorough = 5 帧 / 960×540', [WATCH_MODES.thorough.frames, WATCH_MODES.thorough.maxOut], [5, { w: 960, h: 540 }])
  eq('M3 认不出档位名就给空串（走默认，而不是瞎猜）', parseWatchMode('fast'), '')
  eq('M4 大小写不敏感', parseWatchMode('QUICK'), 'quick')

  const seen = []
  const w = createBiliWatch({
    getCookie: () => '',
    getAccount: () => ({ loggedIn: false }),
    // 桩：把 extractKeyframes 之前的路径走完，然后把参数记下来。
    // 纯 Node 载不进 kfdecode，所以这里用 frames:0 那条早退分支验不到 maxOut；
    // 改为直接调 describe() 验档位表，再验一次「帧数优先级」用的纯函数路径。
  })
  const d = w.describe()
  eq('M5 describe() 把两档都报出来', Object.keys(d.modes).sort(), ['quick', 'thorough'])
  eq('M6 describe() 里 quick 的帧数对', d.modes.quick.frames, 2)

  // 帧数优先级：显式 frames 压过档位；frames:0 必须保持 0（不能被档位"升级"）
  const r1 = await w.watch({ url: BV, frames: 0, mode: 'thorough' })
  ok('M7 frames:0 + mode:thorough 仍然只取元信息（不许被档位偷偷升级）',
    r1.ok === true && (r1.meta?.frames ?? []).length === 0 && r1.meta?.mode === 'meta-only',
    JSON.stringify(r1.meta?.mode))
}

// ───────────────────── G：指南真的进了 system prompt ─────────────────────
// ★ 2026-10-21 查出来的真 bug：`capture()` 收了 bili/balance 却没往下传给
//   `renderSystemText()`，于是「B 站视频」整段从来没进过真实的 system prompt，
//   工具在手边而指南一个字没提。这条静态断言钉住那个传递。
{
  const snapSrc = readFileSync(join(ROOT, 'src', 'snapshot.mjs'), 'utf8')
  ok('G1 capture() 把 bili / balance 传进了 renderSystemText',
    /\bpersona,\s*\n\s*memoryText,[\s\S]{0,600}?\bbili,\s*\n\s*balance,/.test(snapSrc))
  const full = renderSystemText({ persona: 'P', memoryText: 'M', indexLines: [], web: true, bili: true, balance: true })
  ok('G2 真正的 system prompt 里能看到「B 站视频」段', /## B 站视频/.test(full))
  ok('G3 也能看到「钱」段', /## 钱/.test(full))
  ok('G4 指南里写了 quick / thorough 让她自己选', /mode:"quick"/.test(full) && /mode:"thorough"/.test(full))
}

// ───────────── H：看完之后自动写「概览」（2026-10-21 深夜新增）─────────────
//
// 界面上每条只显示「标题 + 概览」，概览必须由**她**来写：
//   看视频成功 → 主进程用真实取到的关键帧问一句 → 落进账本的 summary 字段。
// 这一段是纯静态断言（真跑要 LLM 与 Electron，不在单元探针的范围里），
// 但它钉住的是「写完了没落盘」这条最容易静默丢的链。
{
  const mainSrc = readFileSync(join(ROOT, 'src', 'main.mjs'), 'utf8')
  ok('I1 主进程有 summarizeVideo（用关键帧写概览）',
    /async function summarizeVideo\(/.test(mainSrc) && /image_url/.test(mainSrc))
  ok('I2 概览用的多模态形状是 image_url + dataURL（brain.mjs 那一套）',
    /url: `data:\$\{im\.mimeType[^}]*\};base64,\$\{im\.data\}`/.test(mainSrc))
  ok('I3 看成功之后会调 summarizeVideo 并把结果落进账本',
    /summarizeVideo\(r\)/.test(mainSrc) && /biliHistory\.setSummary\(/.test(mainSrc))
  ok('I4 概览不会挡住工具返回（异步 fire-and-forget）',
    /void summarizeVideo\(r\)/.test(mainSrc))
  const histSrc = readFileSync(join(ROOT, 'src', 'bili-history.mjs'), 'utf8')
  ok('I5 账本有 setSummary 与 summary 字段',
    /function setSummary\(/.test(histSrc) && /summary: ''/.test(histSrc))
  const preloadSrc = readFileSync(join(ROOT, 'helper', 'preload.cjs'), 'utf8')
  ok('I6 preload 暴露了 biliSummary（老条目能手动补写概览）',
    /biliSummary\(payload\)/.test(preloadSrc) && /orb:bili-summary/.test(preloadSrc))
  ok('I7 主进程处理了 orb:bili-summary',
    /ipcMain\.handle\('orb:bili-summary'/.test(mainSrc))
}

// 非 Electron 进程里要「优雅失败」而不是抛：这是 frames>0 在纯 Node 下的唯一合法结局。
if (meta1?.ok) {
  const r = await watch.watch({ url: BV, frames: 2 })
  ok('B15 纯 Node 取帧返回 ok:false 而不是抛', r.ok === false, r.text.slice(0, 60))
  ok('B16 失败原因指向「不是 Electron 主进程」', /不是 Electron 主进程|取帧模块没载进来/.test(r.text), r.text.slice(0, 60))
}

console.log('')
console.log(`bili-watch-unit: ${pass} PASS / ${fail} FAIL`)
if (fail) {
  console.log('失败项：' + failures.join(' | '))
  process.exitCode = 1
}
