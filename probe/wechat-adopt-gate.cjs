/**
 * 验收：`adoptHostWechatCreds` 开关（2026-10-22 事故的护栏）。
 *
 * 跑法：`node probe/wechat-adopt-gate.cjs`
 *
 * 两个方向都要测，缺一不可：
 *   ① 关（出厂默认）：绝对不能从 ~/.dsh 搬凭据 —— 这是事故本身；
 *   ② 开（开发机）：搬家路径仍然有效 —— 否则开发机上白丢一次便利。
 *
 * 判据只看盘上写出来的 data/wechat.json，不看内存返回值（写盘才是事故现场）。
 */
'use strict'

const { mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createWechatCreds, migrateCreds } = require('../src/wechat.mjs')

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS  ${name}`)
  } else {
    failures++
    console.log(`FAIL  ${name}${detail ? `  —  ${detail}` : ''}`)
  }
}

// 宿主那份（真实存在的话）——只用来判断「有没有被搬进来」，不打印 token
const host = migrateCreds()
const hostToken = String(host?.botToken || '')
console.log(`宿主 ~/.dsh 微信凭据：${hostToken ? `有（token ${hostToken.length} 字符）` : '没有'}`)

const roots = []
function freshRoot() {
  const d = mkdtempSync(join(tmpdir(), 'orb-wechat-gate-'))
  roots.push(d)
  return d
}

function readWritten(root) {
  return JSON.parse(readFileSync(join(root, 'wechat.json'), 'utf8'))
}

try {
  // ── ① 关：出厂默认 ────────────────────────────────────────
  const offRoot = freshRoot()
  const off = createWechatCreds({ dataRoot: offRoot, adoptHostCreds: false })
  const offCreds = off.load()
  const offOnDisk = readWritten(offRoot)
  check('关：返回的 token 为空', offCreds.botToken === '', `实际 ${offCreds.botToken.length} 字符`)
  check('关：盘上写的 token 为空', offOnDisk.botToken === '', `实际 ${offOnDisk.botToken.length} 字符`)
  check('关：enabled 为 false', offOnDisk.enabled === false)
  check('关：文件照样建出来了（用户看得见）', typeof offOnDisk.baseUrl === 'string' && offOnDisk.baseUrl !== '')
  if (hostToken) {
    check('关：没有搬宿主 botId', offOnDisk.botId !== String(host.botId || ''), offOnDisk.botId)
    check('关：没有搬宿主 userId', offOnDisk.userId !== String(host.userId || ''), offOnDisk.userId)
  }

  // ── ② 开：开发机 ─────────────────────────────────────────
  const onRoot = freshRoot()
  const on = createWechatCreds({ dataRoot: onRoot, adoptHostCreds: true })
  const onCreds = on.load()
  const onOnDisk = readWritten(onRoot)
  if (hostToken) {
    check('开：搬到了宿主 token', onOnDisk.botToken === hostToken && onCreds.botToken === hostToken)
    check('开：搬到了宿主 botId', onOnDisk.botId === String(host.botId || ''))
  } else {
    console.log('SKIP  开：本机没有宿主凭据可搬（这台机器上测不出正向分支）')
    check('开：没有宿主凭据时照样建文件且为空', onOnDisk.botToken === '')
  }

  // ── ③ 已有文件时开关不起作用（不能被反复覆盖）─────────────
  const off2 = createWechatCreds({ dataRoot: onRoot, adoptHostCreds: false })
  const keep = off2.load()
  check('已有 data/wechat.json 时不再搬家（读盘优先）', keep.botToken === onOnDisk.botToken)
} finally {
  for (const d of roots) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不算失败 */
    }
  }
}

console.log(failures === 0 ? '\n✓ 全部通过' : `\n✗ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
