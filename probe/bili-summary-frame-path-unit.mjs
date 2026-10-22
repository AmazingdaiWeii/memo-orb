#!/usr/bin/env node
/**
 * 「画面摘要必须带落盘路径」· 单测（纯逻辑 + 临时账本，不碰 data/）。
 *
 * 背景（2026-10-22 用户定的预警）：
 *   她**没法把图推给人看**，只能报路径。所以一句「画面里有个穿蓝衣服的人」如果
 *   不带路径，以后既没人能复核，她自己也调不出来 —— 等于一句不可验证的断言。
 *   这件事不能靠 prompt（她整篇重写时会忘），所以钉在**落账这一层**：
 *   `setSummary()` 无条件经过 `ensureFramePathInSummary()`。
 *
 * 最容易错的是顺序：先截 240 字再加路径 ⇒ 长摘要恰好把路径切掉，
 * 于是「带路径」在最需要它的长摘要上失效。E6 就是钉这个。
 *
 * 跑法：node probe/bili-summary-frame-path-unit.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBiliHistory, ensureFramePathInSummary } from '../src/bili-history.mjs'

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

const TMP = mkdtempSync(join(tmpdir(), 'orb-bilihist-'))
const h = createBiliHistory({ dataRoot: TMP })
const DIR = 'bili/BV1ab411c7p1-p1'

// ── A 纯函数 ────────────────────────────────────────────────────
check('E1 没有 framesDir（没取过帧）→ 一个字都不加', ensureFramePathInSummary('讲了鲸搁浅', '') === '讲了鲸搁浅')
check(
  'E2 有 framesDir → 末尾补落盘目录',
  ensureFramePathInSummary('讲了鲸搁浅', DIR) === `讲了鲸搁浅（画面存 \`${DIR}/\`）`,
  ensureFramePathInSummary('讲了鲸搁浅', DIR),
)
check(
  'E3 摘要里已经提到这个目录 → 不重复加',
  ensureFramePathInSummary(`讲了鲸搁浅（画面存 \`${DIR}/\`）`, DIR) === `讲了鲸搁浅（画面存 \`${DIR}/\`）`,
)
check(
  'E4 空摘要 + 有路径 → 只有路径那一句，不留空括号',
  ensureFramePathInSummary('', DIR) === `（画面存 \`${DIR}/\`）`,
  ensureFramePathInSummary('', DIR),
)

// ── B 落账（写入端强制）─────────────────────────────────────────
h.record({ bvid: 'BV1ab411c7p1', cid: 111, title: '一条测试视频', frameTimes: [12, 40], framesDir: DIR })
const set1 = h.setSummary('BV1ab411c7p1', 111, '一条讲鲸鱼搁浅的纪录片，镜头很慢。', { framesDir: DIR })
check('E5 setSummary 落账成功', set1?.ok === true, JSON.stringify(set1))

const got1 = h.get('BV1ab411c7p1', 111)
check(
  'E6 ★ 落账后的概览带上了落盘目录',
  typeof got1?.summary === 'string' && got1.summary.includes(DIR),
  JSON.stringify(got1?.summary),
)
check(
  'E7 条目上单独存了 framesDir（不只靠正文里那一句）',
  got1?.framesDir === DIR,
  JSON.stringify(got1?.framesDir),
)

// ★ 顺序钉：先截正文再加路径
const longText = '很'.repeat(300)
h.record({ bvid: 'BV1long00001', cid: 222, title: '长摘要', framesDir: DIR })
h.setSummary('BV1long00001', 222, longText, { framesDir: DIR })
const got2 = h.get('BV1long00001', 222)
check(
  'E8 ★ 300 字长摘要被截断后，路径**仍然在**（先截再加的顺序）',
  typeof got2?.summary === 'string' && got2.summary.includes(DIR),
  `len=${got2?.summary?.length} tail=${JSON.stringify(got2?.summary?.slice(-40))}`,
)
check('E9 长摘要总长有上限（不会无限膨胀）', String(got2?.summary ?? '').length <= 400, `len=${got2?.summary?.length}`)

// 没取过帧的条目：不该凭空出现路径
h.record({ bvid: 'BV1noframes0', cid: 333, title: '只看了元信息' })
h.setSummary('BV1noframes0', 333, '只看了标题，不清楚具体讲了什么。')
const got3 = h.get('BV1noframes0', 333)
check(
  'E10 ★ 没取过帧的条目，概览里不出现任何路径',
  typeof got3?.summary === 'string' && !got3.summary.includes('画面存'),
  JSON.stringify(got3?.summary),
)

// 重复看同一条时 framesDir 会被最新一次覆盖（换了分P / 换了目录）
h.record({ bvid: 'BV1ab411c7p1', cid: 111, title: '一条测试视频', framesDir: 'bili/BV1ab411c7p1-p2' })
check(
  'E11 再看一次时 framesDir 跟到最新那一趟',
  h.get('BV1ab411c7p1', 111)?.framesDir === 'bili/BV1ab411c7p1-p2',
  JSON.stringify(h.get('BV1ab411c7p1', 111)?.framesDir),
)

rmSync(TMP, { recursive: true, force: true })
console.log(`\n${passed} PASS / ${failed} FAIL`)
if (failed > 0) process.exit(1)
