#!/usr/bin/env node
/**
 * config-agent-guard.mjs —— 「你的 orb 是不是被探针换了 agent」的一次性体检（纯 Node、只读）。
 *
 * ## 真实事故（2026-10-21 用户报「历史对话和记忆一起消失了」）
 *
 * 几个 GUI 探针（`impression-local-gui` / `switch-mode-local-gui` 等）会：
 *   1. 把**真实** `config.json` 备份到 `bak/config.*-<stamp>.json`；
 *   2. 往里写一个**一次性 agentId**（`orb-imp-test-…` / `orb-mode-test-…`）；
 *   3. 启动一个真 orb，让 P5 的归一逻辑把这个 id 固化下来；
 *   4. 跑完靠 `process.on('exit')` 把备份拷回去。
 *
 * 第 4 步只在**进程正常退出**时有效。探针超时被杀 / 被 360 拦 / 任务被杀，
 * exit 不触发 ⇒ **config.json 永远留在测试 agent 上**。
 *
 * 于是 orb 下次启动加载的是那个空 agent：
 *   - 记忆：读 `data/memfs/<agentId>/memory/` ⇒ 空（真记忆在 `orb-20261019` 里躺着）
 *   - 历史：会话目录按 `local-<agentId>` 命名 ⇒ 只剩测试那几条
 * 数据**一条没丢**，只是换了个抽屉 —— 但用户看到的现象就是「全没了」。
 *
 * ## 本探针做什么
 *
 * 只读地回答三个问题：
 *   ① 现在 config.agentId 是不是测试 agent（`-test-` / `-probe-` / `-e2e-` 形状）；
 *   ② `bak/` 里有没有**比 config.json 更新**的探针备份（有 ⇒ 上次恢复失败过）；
 *   ③ 候选里哪个 agent 才是"装满记忆的那个"（按 MEMORY.md 体量 + 会话数排个序）。
 *
 * 用法：`node probe/config-agent-guard.mjs`
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CFG = join(ROOT, 'config.json')
const BAK = join(ROOT, 'bak')
const DATA = join(ROOT, 'data')

let pass = 0
let fail = 0
const warnings = []
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`PASS ${name}${extra ? '  ' + extra : ''}`) } else { fail += 1; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`) }
}
function warn(msg) { warnings.push(msg); console.log(`WARN ${msg}`) }

const cfg = JSON.parse(readFileSync(CFG, 'utf8'))
const agentId = String(cfg.agentId || '')

console.log(`config.agentId = ${agentId || '(空)'}`)
console.log('')

/* ── ① 当前 agent 是不是测试 agent ───────────────────────────────────── */
const TESTY = /-(test|probe|e2e|smoke)-?\d{0,}/i
ok('① config.agentId 不是测试/探针 agent', !TESTY.test(agentId),
  agentId ? `（形如 orb-*-test-<时间戳> 就是测试 agent）` : '')

/* ── ② 有没有"恢复失败"的孤儿备份 ────────────────────────────────────── */
{
  const cfgMtime = statSync(CFG).mtimeMs
  const orphans = existsSync(BAK)
    ? readdirSync(BAK)
        .filter((f) => /^config[.\-].*\d{8,}\.json$/i.test(f))
        .map((f) => ({ f, mtime: statSync(join(BAK, f)).mtimeMs }))
        .filter((x) => x.mtime > cfgMtime)
        .map((x) => x.f)
    : []
  ok('② 没有比 config.json 更新的探针备份（上次的恢复都成功了）', orphans.length === 0,
    orphans.join(' '))
  if (orphans.length) {
    warn(`这 ${orphans.length} 个备份比 config.json 还新 ⇒ 上一次探针的 restoreConfig() 没跑成。`
      + `最可能的一次是 ${orphans.sort().pop()}；它的内容就是当时本该恢复回去的那份配置。`)
  }
}

/* ── ③ 谁才是"装满记忆的那个" ─────────────────────────────────────────── */
{
  const memfs = join(DATA, 'memfs')
  const rows = []
  if (existsSync(memfs)) {
    for (const name of readdirSync(memfs)) {
      const mem = join(memfs, name, 'memory', 'MEMORY.md')
      const bytes = existsSync(mem) ? statSync(mem).size : 0
      const convs = existsSync(join(DATA, 'conversations'))
        ? readdirSync(join(DATA, 'conversations'))
            .filter((d) => { try { return atob(d).includes(`local-${name}`) } catch { return false } }).length
        : 0
      rows.push({ name, bytes, convs })
    }
  }
  rows.sort((a, b) => b.bytes - a.bytes || b.convs - a.convs)
  console.log('')
  console.log('  各 agent 的记忆体量：')
  for (const r of rows) {
    const mark = r.name === agentId ? ' ← 当前' : ''
    console.log(`    ${r.name.padEnd(34)} MEMORY.md ${String(r.bytes).padStart(6)}B · 会话 ${r.convs}${mark}`)
  }
  const best = rows[0]
  ok('③ 当前 agent 就是记忆最多的那个（否则界面上会是空的）',
    best === undefined || best.name === agentId,
    best && best.name !== agentId ? `记忆最多的是 ${best.name}（${best.bytes}B），当前是 ${agentId}` : '')

  if (best && best.name !== agentId) {
    console.log('')
    console.log(`  ↳ 改回来只要一行（先完全退出 orb，它退出时会把内存里的配置写回去）：`)
    console.log(`     把 config.json 里的 "agentId" 改成 "${best.name}"`)
    console.log(`     ⚠️ 改完再启动 orb；启动后 ${best.name} 的记忆与历史就回来了（数据一直在）。`)
  }
}

console.log('')
console.log(`config-agent-guard: ${pass} PASS / ${fail} FAIL${warnings.length ? ` / ${warnings.length} WARN` : ''}`)
if (fail) process.exitCode = 1