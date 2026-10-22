#!/usr/bin/env node
/**
 * 工具装配 · 静态体检（只读源码文本，不跑 Electron）。
 *
 * 起因（2026-10-22，本轮真踩到的 bug）：
 *   `search_memory` 接对话仓检索时写成了 `this.agentId`。但 `executeTool` 是**模块级
 *   函数**（`async function executeTool(...)`），根本没有 `this` —— 于是 `agentId`
 *   是 `undefined`，会话目录前缀变成 `conversation:local-undefined`，
 *   **一条都搜不到、也不报错**。她只会觉得「我真的不记得」，比崩了更难查。
 *
 * 这类错误的共同点：语法完全合法（`async function` 里的 `this` 在非严格模式下是
 * 全局对象，取属性得到 undefined），`node --check` 也全绿。所以只能靠结构性断言。
 *
 * 跑法：node probe/tool-deps-wiring-unit.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src', 'brain.mjs')
const text = readFileSync(SRC, 'utf8')

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

/** 去掉注释，避免「解释这条规则的注释」自己触发这条规则。 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 取出 `async function <name>(` 开始、到下一个顶层 `}\n` 为止的函数体（够用且不依赖解析器）。 */
function bodyOf(fnName) {
  const start = text.indexOf(`async function ${fnName}(`)
  if (start < 0) return ''
  // 顶层函数的结束标志：一行的 `}` 后面跟空行或注释
  const rest = text.slice(start)
  const end = rest.search(/\n}\n/)
  const body = end < 0 ? rest : rest.slice(0, end + 2)
  return stripComments(body)
}

const exec = bodyOf('executeTool')
check('W1 源码里能找到 executeTool', exec.length > 1000, `len=${exec.length}`)

// ★ 核心：模块级函数里不许有 this.
const thisHits = [...exec.matchAll(/\bthis\./g)]
check(
  'W2 ★ executeTool 体内没有任何 `this.`（它是模块级函数，没有 this）',
  thisHits.length === 0,
  `命中 ${thisHits.length} 处`,
)

// 参数表里必须有 agentId（否则只能靠 this，必错）
const sig = /async function executeTool\(\s*\{[^}]*\},\s*\{([\s\S]*?)\}\s*,?\s*\)/.exec(text)
check('W3 executeTool 能解析出参数表', Boolean(sig))
check(
  'W4 ★ executeTool 的参数表里有 agentId',
  Boolean(sig) && /\bagentId\b/.test(sig[1]),
  sig ? sig[1].replace(/\s+/g, ' ').trim().slice(0, 160) : '解析失败',
)

// 调用点必须把 agentId 真传进去
const callIdx = text.lastIndexOf('executeTool(call,')
check('W5 找到 executeTool 的调用点', callIdx > 0)
const callBlock = callIdx > 0 ? text.slice(callIdx, callIdx + 900) : ''
check(
  'W6 ★ 调用 executeTool 时传了 `agentId: this.agentId`',
  /agentId:\s*this\.agentId/.test(callBlock),
  callBlock.replace(/\s+/g, ' ').slice(0, 200),
)

// search_memory 分支必须用参数 agentId，且对空值有防御
const caseIdx = text.indexOf("case 'search_memory':")
const caseBlock = caseIdx > 0 ? stripComments(text.slice(caseIdx, caseIdx + 1400)) : ''
check('W7 找到 search_memory 分支', caseIdx > 0)
check(
  'W8 ★ search_memory 里用的是 `agentId`（参数），不是 `this.agentId`',
  /searchConversations\(\s*agentId\s*,/.test(caseBlock),
  caseBlock.replace(/\s+/g, ' ').slice(0, 220),
)
check(
  'W9 ★ 空 agentId 时不去搜对话仓（否则前缀变成 conversation:local-undefined）',
  /if\s*\(\s*agentId\s*\)\s*talkHits\s*=\s*searchConversations/.test(caseBlock),
)
check(
  'W10 对话仓检索失败不连累记忆仓结果（有 try/catch 兜底）',
  /try\s*\{[\s\S]{0,200}searchConversations[\s\S]{0,300}\}\s*catch/.test(caseBlock),
)

// 反向对照：确认这套检测真的能发现 `this.`
const fakeBody = 'async function foo() {\n  const x = this.bar\n}\n'
check(
  'W11 （对照）同样的正则能抓出伪造的 `this.` —— 说明 W2 不是永远为真',
  [...fakeBody.matchAll(/\bthis\./g)].length === 1,
)

console.log(`\n${passed} PASS / ${failed} FAIL`)
if (failed > 0) process.exit(1)
