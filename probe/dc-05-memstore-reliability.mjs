/**
 * dc-05 · memstore 可靠性探针（★ G2 闸门）
 *
 * 验证 V1 / V2 / V3 / V6 四条可靠性，直接对应主设计者最怕的三件事。
 *
 * | # | 验什么 | 怎么验 | 判据 |
 * |---|---|---|---|
 * | V1 | 写了立刻可见 | write() 后立刻 read() | 必须包含刚写的内容 |
 * | V2 | 崩溃不丢 | 子进程写入中 kill → 重启读 | 无半截文件；git 可回滚 |
 * | V3 | 并发不覆盖 | Promise.all 连发 10 次 write | 全部落盘（不同文件全部存在；同一文件最终完整） |
 * | V6 | 误删可恢复 | 删文件 → git 恢复 | 恢复后与删除前逐字节相同 |
 *
 * ★ G2 判据：V1 / V3 / V6 必须全绿，否则不许进 D3。
 *   V2 允许「已知限制 + 写进文档」，但要如实汇报。
 *
 * 只测 local 实现（letta 实现的可靠性由 Letta 后端保证）。
 * 用沙箱数据目录，不碰真实数据。
 */

import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createLocalMemoryStore } from '../src/memstore-local.mjs'

// ── 沙箱设置 ─────────────────────────────────────────────
// ★ 重要：ORB_LEGACY_DATA 是 memory.mjs 的模块级常量，必须在进程启动前设置。
// 运行方式：$env:ORB_LEGACY_DATA="E:\Memo orb\_sandbox-data"; node probe/dc-05-*.mjs
// 探针内部不再设置 process.env（设置了也不会生效，因为模块已加载）。

const SANDBOX_ROOT = join(process.cwd(), '_sandbox-data')
const TEST_AGENT = 'test-agent-reliability-001'
const REPO_DIR = join(SANDBOX_ROOT, 'memfs', TEST_AGENT, 'memory')

// 启动时验证环境变量
// ★ R5：用 path.resolve 比较，别比裸字符串 —— 正斜杠写法 `E:/Memo orb/_sandbox-data`
//   跟 `E:\Memo orb\_sandbox-data` 是同一个目录，但 `!==` 会误报「你没设」。
if (resolve(process.env.ORB_LEGACY_DATA || '') !== resolve(SANDBOX_ROOT)) {
  console.error('❌ 必须在运行前设置 ORB_LEGACY_DATA 环境变量！')
  console.error(`   期望：${SANDBOX_ROOT}`)
  console.error(`   实际：${process.env.ORB_LEGACY_DATA || '(未设置)'}`)
  console.error('   运行方式：$env:ORB_LEGACY_DATA="E:\\Memo orb\\_sandbox-data"; node probe/dc-05-memstore-reliability.mjs')
  process.exit(1)
}

function resetSandbox() {
  if (existsSync(REPO_DIR)) {
    rmSync(REPO_DIR, { recursive: true, force: true })
  }
  mkdirSync(REPO_DIR, { recursive: true })
}

function createStore() {
  return createLocalMemoryStore({ root: process.cwd(), agentId: TEST_AGENT })
}

// ── R8 证据层（主设计者要求：不依赖 git 子进程也能复核 V1/V2/V3/V6）──
// 每个关键时刻抓一份「仓库快照」：文件列表 + 每文件 sha256 + git log + git status。
// 跑完统一落盘到 probe/dc-05-output.txt，跟代码一起交。

const TRANSCRIPT = [] // console.log 的全量转录
const SNAPSHOTS = []  // 关键时刻的仓库快照

function sha256Of(abs) {
  try {
    return createHash('sha256').update(readFileSync(abs)).digest('hex')
  } catch (err) {
    return `(读不到：${err.code || err.message})`
  }
}

function walkRepo(dir = REPO_DIR, base = '') {
  const out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ent of entries) {
    if (ent.name === '.git') continue // 跳过版本库内部，只列「用户看得见的记忆文件」
    const rel = base ? `${base}/${ent.name}` : ent.name
    const abs = join(dir, ent.name)
    if (ent.isDirectory()) {
      out.push(...walkRepo(abs, rel))
    } else {
      let size = -1
      try { size = statSync(abs).size } catch { /* ignore */ }
      out.push({ rel, abs, size, sha: sha256Of(abs) })
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

function captureSnapshot(label, note = '') {
  const files = walkRepo()
  const leftovers = files.filter((f) => /\.tmp-|\.tmp$/.test(f.rel))
  const log = spawnSync('git', ['log', '--oneline'], { cwd: REPO_DIR, encoding: 'utf8' })
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_DIR, encoding: 'utf8' })
  const lines = []
  lines.push(`### ${label}`)
  lines.push(`时刻：${new Date().toISOString()}`)
  if (note) lines.push(`说明：${note}`)
  lines.push(`记忆文件数：${files.length}（其中 *.tmp-* 原子写中转残留：${leftovers.length}）`)
  for (const f of files) lines.push(`- \`${f.rel}\`  ${f.size}B  sha256=${f.sha}`)
  if (files.length === 0) lines.push('- （仓库里没有文件）')
  lines.push('')
  lines.push('git log --oneline：')
  lines.push('```')
  lines.push((log.stdout || '').trim() || '(空)')
  lines.push('```')
  lines.push(`git status --porcelain：${(status.stdout || '').trim() || 'clean（工作树干净）'}`)
  lines.push('')
  SNAPSHOTS.push(lines.join('\n'))
  // 同时回显到控制台，方便跑的人当场看
  console.log(`  📸 快照「${label}」：${files.length} 个文件，${leftovers.length} 个 tmp 残留`)
}

function installTranscript() {
  const orig = console.log
  console.log = (...args) => {
    TRANSCRIPT.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '))
    orig(...args)
  }
}

function writeArtifact() {
  const head = [
    '=== dc-05 · memstore 可靠性探针 · R8 可复核证据 ===',
    `生成时间：${new Date().toISOString()}`,
    `node：${process.version}`,
    `仓库：${REPO_DIR}`,
    `测试 agent：${TEST_AGENT}`,
    '',
    '★ 怎么读这份文件（不需要能起 git 子进程）：',
    '1) 每段「### …」是一个时刻的完整仓库快照：文件列表 + 每个文件的 sha256 + git log + git status。',
    '2) V1 → 看「V1 · 写入后」：v1/test.md 在、sha 稳定、git log 多一条 commit。',
    '3) V2 → 看「V2 · 子进程被 SIGKILL 后」：v2/data.md 仍是初始版本（sha 与「V2 · 初始写入后」一致）；',
    '   v2/big.md 要么不存在、要么完整（>1000B 且不以 .tmp 结尾）；残留的 *.tmp-* 是原子写的中转文件，不会被 read() 当成正式文件。',
    '4) V3 → 看「V3 · 10 个文件并发写入后」：v3/file-0..9.md 十个都在，v3/same-file.md 只有一份且是某一次完整写入的最终态。',
    '5) V6 → 看「V6 · 误删后」与「V6 · git 恢复后」两段：前者 v6/important.md 消失，后者 sha 与「V6 · 写入后」完全一致。',
    '6) sha256 可独立复核：`Get-FileHash -Algorithm SHA256 <文件>` 或 `certutil -hashfile <文件> SHA256`。',
    '',
  ].join('\n')

  const body = [
    head,
    '──────── 运行输出 ────────',
    TRANSCRIPT.join('\n'),
    '',
    '──────── 仓库快照（关键中间态）────────',
    SNAPSHOTS.join('\n'),
  ].join('\n')

  const outPath = join(process.cwd(), 'probe', 'dc-05-output.txt')
  try {
    writeFileSync(outPath, body, 'utf8')
    console.log(`\n📄 R8 证据已落盘：probe/dc-05-output.txt（${SNAPSHOTS.length} 个快照，${body.length} 字符）`)
    return outPath
  } catch (err) {
    console.error(`❌ 证据落盘失败：${err.message}`)
    return null
  }
}

// ── V1：写了立刻可见 ─────────────────────────────────────

async function testV1() {
  console.log('── V1：写了立刻可见 ──')
  resetSandbox()
  const store = createStore()

  const path = 'v1/test.md'
  const content = `# V1 测试\n\n写入时间：${new Date().toISOString()}\n这行必须立刻能读到。\n`

  // write 后立刻 read（不等待任何额外时间）
  await store.write(path, content)
  const readBack = await store.read(path)

  const pass = readBack === content
  console.log(`  写入 ${content.length} 字符`)
  console.log(`  立刻读回 ${readBack?.length ?? 0} 字符`)
  console.log(`  内容一致：${pass ? '✅' : '❌'}`)

  if (!pass) {
    console.log(`  期望：${JSON.stringify(content).slice(0, 100)}`)
    console.log(`  实际：${JSON.stringify(readBack).slice(0, 100)}`)
  }
  captureSnapshot('V1 · 写入后', '立刻 read() 与写入内容逐字节相同 ⇒ 写了立刻可见')
  return pass
}

// ── V2：崩溃不丢 ─────────────────────────────────────────

/**
 * 用子进程跑写入，在写入过程中杀掉它，验证文件完整性。
 *
 * 因为原子写（临时文件 + rename）的特性，预期结果是：
 *   - 文件要么是完整的旧版本，要么是完整的新版本
 *   - 不会有半截文件
 *   - git 可能有未完成的 commit，但工作树文件是完整的
 */
async function testV2() {
  console.log('\n── V2：崩溃不丢 ──')
  resetSandbox()

  // 先写一个初始文件并确保 commit
  const store = createStore()
  const initialContent = '# 初始版本\n\n这是崩溃前的内容。\n'
  await store.write('v2/data.md', initialContent)

  // 验证初始文件存在
  const initialRead = await store.read('v2/data.md')
  if (initialRead !== initialContent) {
    console.log('  ❌ 初始写入失败')
    return false
  }
  console.log('  初始文件已写入并提交')
  captureSnapshot('V2 · 初始写入后', '崩溃点之前的基线：v2/data.md 已 commit')

  // 写一个子进程脚本：写一个大文件（让写入有足够时间被打断）
  // 用相对 import：脚本在 _sandbox-data/ 下，../src/ 就是项目根的 src/
  const childScript = `
    import { createLocalMemoryStore } from '../src/memstore-local.mjs'
    const store = createLocalMemoryStore({ root: '${process.cwd().replace(/\\/g, '\\\\')}', agentId: '${TEST_AGENT}' })
    // 写一个足够大的内容，让 git commit 花点时间
    const bigContent = '# 大文件\\n\\n' + 'x'.repeat(50000) + '\\n'
    console.log('CHILD: starting write...')
    await store.write('v2/big.md', bigContent)
    console.log('CHILD: write completed')
  `

  const scriptPath = join(SANDBOX_ROOT, 'v2-child.mjs')
  writeFileSync(scriptPath, childScript, 'utf8')

  return new Promise((resolve) => {
    const child = spawn('node', [scriptPath], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ORB_LEGACY_DATA: SANDBOX_ROOT, // 子进程启动时就设置好环境变量
      },
    })

    let childOutput = ''

    // ★ 崩溃点要落在「写入真的开始了之后」才算证据。
    //   固定 100ms 往往在子进程还没启动完，big.md 根本没出现 —— 那样的「没有半截文件」
    //   是因为还没写，不是因为原子写救了它。改成：看到 CHILD: starting write 再补 15ms 杀。
    let killTimer = null
    let killed = false
    const killNow = (why) => {
      if (killed) return
      killed = true
      console.log(`  杀掉子进程...（${why}）`)
      child.kill('SIGKILL')
    }
    // 兜底：子进程若因故没打出那一行，3s 后照样杀，避免挂死
    const hardTimer = setTimeout(() => killNow('兜底 3s'), 3000)

    child.stdout.on('data', (d) => {
      childOutput += d.toString()
      if (!killed && childOutput.includes('CHILD: starting write')) {
        killTimer = setTimeout(() => killNow('写入已开始 15ms，正处于 commit 中途'), 15)
      }
    })
    child.stderr.on('data', (d) => { childOutput += d.toString() })

    child.on('exit', (code, signal) => {
      clearTimeout(hardTimer)
      if (killTimer) clearTimeout(killTimer)
      console.log(`  子进程退出：code=${code}, signal=${signal}`)
      console.log(`  子进程输出：${childOutput.trim()}`)

      // 验证文件状态
      const dataFile = join(REPO_DIR, 'v2', 'data.md')
      const bigFile = join(REPO_DIR, 'v2', 'big.md')

      let pass = true

      // 初始文件应该还在且完整
      if (existsSync(dataFile)) {
        const content = readFileSync(dataFile, 'utf8')
        if (content === initialContent) {
          console.log('  ✅ 初始文件完整保留')
        } else {
          console.log('  ❌ 初始文件被破坏')
          pass = false
        }
      } else {
        console.log('  ❌ 初始文件丢失')
        pass = false
      }

      // big.md 要么不存在（rename 前被杀），要么完整（rename 后被杀）
      if (existsSync(bigFile)) {
        const stat = statSync(bigFile)
        const content = readFileSync(bigFile, 'utf8')
        // 如果文件存在，必须是完整的（以换行结尾，长度合理）
        if (content.endsWith('\n') && content.length > 1000) {
          console.log(`  ✅ big.md 完整存在（${stat.size} 字节）`)
        } else {
          console.log(`  ❌ big.md 是半截文件（${stat.size} 字节，不以换行结尾）`)
          pass = false
        }
      } else {
        console.log('  ✅ big.md 不存在（rename 前被杀，无半截文件）')
      }

      // 验证 git 状态（可以回滚到上一个完整态）
      const gitStatus = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_DIR, encoding: 'utf8' })
      console.log(`  git status：${gitStatus.stdout.trim() || 'clean'}`)

      captureSnapshot(
        'V2 · 子进程被 SIGKILL 后',
        '对照「V2 · 初始写入后」：v2/data.md 的 sha 必须不变；v2/big.md 要么不存在，要么完整的一整块（非半截）',
      )

      // 清理子脚本
      try { unlinkSync(scriptPath) } catch { /* ignore */ }

      if (pass) {
        console.log('  ✅ V2 通过：无半截文件，初始数据完整')
      } else {
        console.log('  ❌ V2 失败')
      }
      resolve(pass)
    })
  })
}

// ── V3：并发不覆盖 ───────────────────────────────────────

async function testV3() {
  console.log('\n── V3：并发不覆盖 ──')
  resetSandbox()
  const store = createStore()

  // 测试 A：10 个不同文件并发写，验证全部存在
  console.log('  测试 A：10 个不同文件并发写')
  const paths = []
  const promises = []
  for (let i = 0; i < 10; i++) {
    const path = `v3/file-${i}.md`
    paths.push(path)
    const content = `# 文件 ${i}\n\n内容：${'A'.repeat(100 + i)}\n`
    promises.push(store.write(path, content))
  }
  await Promise.all(promises)

  let allExist = true
  for (let i = 0; i < 10; i++) {
    const content = await store.read(paths[i])
    if (!content || !content.includes(`文件 ${i}`)) {
      console.log(`  ❌ 文件 ${i} 缺失或内容错误`)
      allExist = false
    }
  }
  console.log(`  10 个文件全部存在且内容正确：${allExist ? '✅' : '❌'}`)

  // 测试 B：同一文件并发写 10 次，验证最终文件完整（不是半截）
  console.log('  测试 B：同一文件并发写 10 次')
  const samePath = 'v3/same-file.md'
  const samePromises = []
  for (let i = 0; i < 10; i++) {
    const content = `# 第 ${i} 次写入\n\n${'B'.repeat(200)}\n`
    samePromises.push(store.write(samePath, content))
  }
  await Promise.all(samePromises)

  const finalContent = await store.read(samePath)
  const isComplete = finalContent !== null
    && finalContent.endsWith('\n')
    && finalContent.length > 100
  console.log(`  最终文件完整（${finalContent?.length ?? 0} 字符，以换行结尾）：${isComplete ? '✅' : '❌'}`)

  // 验证串行队列生效：最终内容应该是某一次的完整内容（不是混合的）
  const hasValidHeader = /^# 第 \d+ 次写入/.test(finalContent || '')
  console.log(`  最终内容是完整的一次写入（非混合）：${hasValidHeader ? '✅' : '❌'}`)

  const pass = allExist && isComplete && hasValidHeader
  if (pass) {
    console.log('  ✅ V3 通过')
  } else {
    console.log('  ❌ V3 失败')
  }
  captureSnapshot(
    'V3 · 10 个文件并发写入后',
    'v3/file-0..9.md 十个都要在（无互相覆盖）；v3/same-file.md 只有一份，且是某一次完整写入的最终态',
  )
  return pass
}

// ── V6：误删可恢复 ───────────────────────────────────────

async function testV6() {
  console.log('\n── V6：误删可恢复 ──')
  resetSandbox()
  const store = createStore()

  const path = 'v6/important.md'
  const content = `# 重要文件\n\n这是不能丢的内容。\n创建时间：${new Date().toISOString()}\n`

  // 1. 写文件并 commit
  await store.write(path, content)
  console.log('  文件已写入并提交')
  captureSnapshot('V6 · 写入后', '删除前的基线：v6/important.md 的 sha 是恢复后必须对上的值')

  // 记录删除前的内容
  const beforeDelete = await store.read(path)
  if (beforeDelete !== content) {
    console.log('  ❌ 写入验证失败')
    return false
  }

  // 2. 误删文件（直接删，不走 memstore，模拟用户误删）
  const fullPath = resolve(REPO_DIR, path)
  unlinkSync(fullPath)
  console.log('  文件已删除')
  captureSnapshot('V6 · 误删后', 'v6/important.md 应该从文件列表里消失（工作树删除，未提交）')

  // 验证文件确实没了
  const afterDelete = await store.read(path)
  if (afterDelete !== null) {
    console.log('  ❌ 删除后文件仍存在（删除失败）')
    return false
  }
  console.log('  确认文件已不存在')

  // 3. 用 git 恢复
  const restoreResult = spawnSync('git', ['checkout', 'HEAD', '--', path.replace(/\\/g, '/')], {
    cwd: REPO_DIR,
    encoding: 'utf8',
  })

  if (restoreResult.status !== 0) {
    console.log(`  ❌ git checkout 失败：${restoreResult.stderr}`)
    return false
  }
  console.log('  git checkout 恢复成功')
  captureSnapshot('V6 · git 恢复后', '对照「V6 · 写入后」：v6/important.md 的 sha 必须完全一致（逐字节恢复）')

  // 4. 验证恢复后与删除前逐字节相同
  const afterRestore = await store.read(path)
  const pass = afterRestore === beforeDelete

  console.log(`  删除前：${beforeDelete.length} 字符`)
  console.log(`  恢复后：${afterRestore?.length ?? 0} 字符`)
  console.log(`  逐字节相同：${pass ? '✅' : '❌'}`)

  if (!pass) {
    console.log(`  期望：${JSON.stringify(beforeDelete).slice(0, 100)}`)
    console.log(`  实际：${JSON.stringify(afterRestore).slice(0, 100)}`)
  }

  if (pass) {
    console.log('  ✅ V6 通过')
  } else {
    console.log('  ❌ V6 失败')
  }
  return pass
}

// ── 主流程 ───────────────────────────────────────────────

async function main() {
  installTranscript()
  console.log('=== dc-05 · memstore 可靠性探针（G2 闸门）===\n')
  console.log(`沙箱目录：${SANDBOX_ROOT}`)
  console.log(`测试 agent：${TEST_AGENT}`)
  console.log()

  const v1 = await testV1()
  const v2 = await testV2()
  const v3 = await testV3()
  const v6 = await testV6()

  console.log('\n=== G2 闸门总结 ===')
  console.log(`V1 写了立刻可见：${v1 ? '✅ PASS' : '❌ FAIL'}`)
  console.log(`V2 崩溃不丢：    ${v2 ? '✅ PASS' : '⚠️  已知限制（见上）'}`)
  console.log(`V3 并发不覆盖：  ${v3 ? '✅ PASS' : '❌ FAIL'}`)
  console.log(`V6 误删可恢复：  ${v6 ? '✅ PASS' : '❌ FAIL'}`)
  console.log()

  // G2 判据：V1 / V3 / V6 必须全绿
  const g2pass = v1 && v3 && v6
  if (g2pass) {
    console.log('✅ G2 通过：V1 / V3 / V6 全绿')
    if (!v2) {
      console.log('   V2 为已知限制，已如实记录')
    }
    writeArtifact() // ★ R8：先把证据落盘，再退出
    process.exit(0)
  } else {
    console.log('❌ G2 未通过：V1 / V3 / V6 中存在失败')
    console.log('   按计划书要求：不许进 D3，停下汇报')
    writeArtifact() // 失败也落盘：证据同样要留
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('\n=== FAIL ===')
  console.error(err.message)
  if (err.stack) console.error(err.stack)
  TRANSCRIPT.push(`\n=== FAIL ===\n${err.message}\n${err.stack || ''}`)
  writeArtifact()
  process.exit(1)
})
