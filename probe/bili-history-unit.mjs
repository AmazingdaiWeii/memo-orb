#!/usr/bin/env node
/**
 * bili-history-unit.mjs —— 「看过的视频」账本的单元体检（纯 Node，不联网、不起 Electron）。
 *
 * 守的是四类容易出错的约定：
 *   ① **同一集只记一条**（bvid+cid 去重，分 P 是不同 cid 自然分开），重复看只累加次数；
 *   ② **时间点取并集**（「上次看 105s、这次看 10s」两个都得留着，不然「她看过哪几秒」会丢）；
 *   ③ **坏文件不能把启动拖死**（账本是附属数据，坏了当空的，但下一次写要能救回来）；
 *   ④ **原子写**（tmp + rename，写到一半崩掉旧账本仍完整）。
 *
 * 跑法：`node probe/bili-history-unit.mjs`
 * 全部在 `probe/_tmp-bili-history/` 里造数据，跑完自清（和项目里其它探针一致）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MAX_ITEMS, createBiliHistory, humanTime } from '../src/bili-history.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SANDBOX = join(ROOT, 'probe', '_tmp-bili-history')

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`PASS ${name}${extra ? '  ' + extra : ''}`)
  } else {
    fail += 1
    failures.push(name)
    console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`)
  }
}

function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)}`)
}

// 干净起步
try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 删不掉就沿用旧目录 */ }
mkdirSync(SANDBOX, { recursive: true })

const FILE = join(SANDBOX, 'bili-history.json')
const store = createBiliHistory({ dataRoot: SANDBOX })

// ───────────────────────── 1. 空账本 ─────────────────────────
eq('1.1 新账本 list 为空', store.list(), [])
eq('1.2 新账本 count = 0', store.count(), 0)
ok('1.3 描述里写 0 条', /0 条/.test(store.describe()), store.describe())

// ───────────────────────── 2. 记一条 ─────────────────────────
{
  const r = store.record({
    bvid: 'BV1GJ411x7h7',
    cid: 137649199,
    aid: 80433022,
    page: 1,
    title: 'Never Gonna Give You Up',
    duration: 213,
    quality: 64,
    qualityLabel: '清晰 720P（64）',
    width: 1280,
    height: 720,
    account: '测试账号',
    frameTimes: [0.021, 105.021, 205.021],
  })
  ok('2.1 record 成功', r.ok === true && r.watches === 1)
  eq('2.2 账本 1 条', store.count(), 1)
  const it = store.list()[0]
  eq('2.3 字段原样落盘（标题/画质/时长）', [it.title, it.qualityLabel, it.duration], ['Never Gonna Give You Up', '清晰 720P（64）', 213])
  eq('2.4 时间点保留', it.frameTimes, [0.021, 105.021, 205.021])
  ok('2.5 带一个给人看的 when', typeof it.when === 'string' && it.when.length > 0, it.when)
  ok('2.6 落盘文件真的存在', existsSync(FILE))
  ok('2.7 写完不留 .tmp 残留', readdirSync(SANDBOX).every((n) => !n.includes('.tmp-')))
}

// ───────────────────────── 3. 同一集再看一次 ─────────────────────────
{
  store.record({
    bvid: 'BV1GJ411x7h7',
    cid: 137649199,
    title: 'Never Gonna Give You Up（改名后）',
    qualityLabel: '清晰 1080P（80）',
    frameTimes: [10, 0.021],
  })
  eq('3.1 同一集不会变成两条', store.count(), 1)
  const it = store.list()[0]
  eq('3.2 watches 累加到 2', it.watches, 2)
  eq('3.3 时间点取并集并升序', it.frameTimes, [0.021, 10, 105.021, 205.021])
  eq('3.4 标题以最新一次为准', it.title, 'Never Gonna Give You Up（改名后）')
  eq('3.5 画质也以最新一次为准（升级大会员后要能反映出来）', it.qualityLabel, '清晰 1080P（80）')
  ok('3.6 lastAt 不小于 at', it.lastAt >= it.at)
}

// ───────────────────────── 4. 分 P 是不同条目 ─────────────────────────
{
  store.record({ bvid: 'BV1GJ411x7h7', cid: 999999, page: 2, title: 'Never Gonna Give You Up', duration: 213 })
  eq('4.1 换 cid（另一个分 P）算另一条', store.count(), 2)
  const list = store.list()
  eq('4.2 最新看的排最前', list[0].cid, 999999)
  eq('4.3 第二条还是老的那集', list[1].cid, 137649199)
  eq('4.4 没给 frameTimes 的条目记成空数组（不是 undefined）', list[0].frameTimes, [])
}

// ───────────────────────── 5. list 的 limit ─────────────────────────
{
  eq('5.1 limit=1 只回一条', store.list({ limit: 1 }).length, 1)
  ok('5.2 limit 非法值回落到默认而不是崩', store.list({ limit: 'x' }).length === 2)
}

// ───────────────────────── 6. 坏文件不许把启动拖死 ─────────────────────────
{
  const good = readFileSync(FILE, 'utf8')
  writeFileSync(FILE, '{ 这不是 json', 'utf8')
  const broken = createBiliHistory({ dataRoot: SANDBOX })
  eq('6.1 坏 JSON 读成空账本，不抛', broken.list(), [])
  const r = broken.record({ bvid: 'BV1xx411c7mD', cid: 1, title: '坏文件之后' })
  ok('6.2 坏文件之后还能正常记（自愈）', r.ok === true && broken.count() === 1)
  writeFileSync(FILE, good, 'utf8')
}

// ───────────────────────── 7. 上限 ─────────────────────────
{
  const big = createBiliHistory({ dataRoot: join(SANDBOX, 'big') })
  for (let i = 0; i < MAX_ITEMS + 5; i += 1) {
    big.record({ bvid: `BVfake${i}`, cid: i + 1, title: `第 ${i} 条` })
  }
  eq(`7.1 超过 ${MAX_ITEMS} 条时截断到上限`, big.count(), MAX_ITEMS)
}

// ───────────────────────── 8. clear ─────────────────────────
{
  const r = store.clear()
  ok('8.1 clear 报删了几条', r.ok === true && r.removed === 2, String(r.removed))
  eq('8.2 清空后 0 条', store.count(), 0)
  ok('8.3 清空也落了盘（不是只改内存）', JSON.parse(readFileSync(FILE, 'utf8')).items.length === 0)
}

// ───────────────────────── 9. humanTime ─────────────────────────
{
  const now = new Date('2026-10-21T21:30:00+08:00').getTime()
  ok('9.1 今天', /^今天 \d\d:\d\d$/.test(humanTime(new Date('2026-10-21T09:05:00+08:00').getTime(), now)), humanTime(new Date('2026-10-21T09:05:00+08:00').getTime(), now))
  ok('9.2 昨天', /^昨天 \d\d:\d\d$/.test(humanTime(new Date('2026-10-20T18:02:00+08:00').getTime(), now)), humanTime(new Date('2026-10-20T18:02:00+08:00').getTime(), now))
  ok('9.3 更早给月-日', /^\d\d-\d\d \d\d:\d\d$/.test(humanTime(new Date('2026-10-19T09:00:00+08:00').getTime(), now)), humanTime(new Date('2026-10-19T09:00:00+08:00').getTime(), now))
}

// ───────────────────── 10. 概览（2026-10-21 深夜新增的字段）─────────────────────
//
// 界面上每条只显示「标题 + 概览」—— 概览是**她看完之后自己写的一句**
// （主进程看完视频后用真实关键帧生成，见 src/main.mjs 的 summarizeVideo）。
// 这里守三件事：新条目默认空、写进去能读出来、读出来的一定是字符串（老条目没这字段）。
{
  const s10 = createBiliHistory({ dataRoot: SANDBOX })
  const rec = s10.record({ bvid: 'BVsum0000001', cid: 777, title: '带概览的那一条', frameTimes: [1, 2] })
  ok('10.1 新条目的 summary 默认为空串（不是 undefined）', rec.ok === true && rec.item.summary === '', JSON.stringify(rec.item.summary))

  const w = s10.setSummary('BVsum0000001', 777, '这是一支八十年代的复古 MV，副歌洗脑。')
  ok('10.2 setSummary 写进去了', w.ok === true && w.item.summary.includes('复古 MV'), w.item?.summary)

  const listed = s10.list({ limit: 10 }).find((x) => x.bvid === 'BVsum0000001')
  ok('10.3 list() 里能读到概览', Boolean(listed) && String(listed.summary || '').includes('复古 MV'), listed?.summary)

  // 老条目（这字段是后加的，磁盘上可能根本没有）→ 读出来必须是空串而不是 undefined
  const raw = JSON.parse(readFileSync(FILE, 'utf8'))
  const old = raw.items.find((x) => x.bvid === 'BVsum0000001')
  delete old.summary
  writeFileSync(FILE, JSON.stringify(raw, null, 2), 'utf8')
  const s10b = createBiliHistory({ dataRoot: SANDBOX })
  const oldListed = s10b.list({ limit: 10 }).find((x) => x.bvid === 'BVsum0000001')
  ok('10.4 老条目没有 summary 字段时读出来是空串（不是 undefined）', typeof oldListed.summary === 'string' && oldListed.summary === '', typeof oldListed.summary)

  ok('10.5 setSummary 对不存在的条目不偷偷新建', s10b.setSummary('BV不存在', 1, 'x').ok === false)
}

// 自清理（删不掉也无所谓：这个目录在 probe/ 下，不进发布包）
try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* noop */ }

console.log('')
console.log(`bili-history-unit: ${pass} PASS / ${fail} FAIL`)
if (fail) {
  console.log('失败项：' + failures.join(' | '))
  process.exitCode = 1
}
