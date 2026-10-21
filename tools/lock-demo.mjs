/**
 * 对话加密·软锁**一键演示**开关（排障/验收用，不是产品功能）。
 *
 * 为什么需要它：软锁的触发前提是「`softEnabled === true` **且** 已约定暗号」，
 * 而 `locks.json` 里默认 `softEnabled: false`，闲置时间又是 30 分钟 ——
 * 两条加起来，真人想「看一眼遮罩长什么样」得先等半小时。这个脚本把两个门槛都拆掉。
 *
 * 用法（**最省事：双击项目根目录的 `lock-demo.cmd`**）：
 *   node tools/lock-demo.mjs on      # 打开软锁 + 闲置 3 秒即遮罩
 *   node tools/lock-demo.mjs off     # 还原成「软锁未启用 / 30 分钟」
 *   node tools/lock-demo.mjs show    # 打印当前状态 + **把暗号原文读出来**（不改文件）
 *
 * ★ `show` 会从 `~/.legacy/.../conversations/` 里把暗号那条消息捞出来打印，
 *   省得「设完就忘」。捞不到只提示一句，不当错误。
 *
 * ⚠️ 只动 `settings` 两个字段与 `idleTimeoutMin`，**不碰** `softAgreement`（暗号指针）
 *    与 `strong`（强锁凭证）—— 演示开关不该有能力破坏你已有的锁。
 *
 * ⚠️ 改完必须**重启 orb** 才生效：`lock-flow.startIdleWatch()` 只在进程启动时读一次设置，
 *    运行中改文件不会让已经在跑的定时器醒过来。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOCK_PATH = join(ROOT, 'locks.json')

const cmd = (process.argv[2] || 'show').toLowerCase()

function load() {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
  } catch (err) {
    console.error(`读 ${LOCK_PATH} 失败：${err.message}`)
    process.exit(1)
  }
}

function save(state) {
  writeFileSync(LOCK_PATH, JSON.stringify(state, null, 2), 'utf8')
}

const st = load()
const settings = st.settings ?? {}
const agr = st.softAgreement

/**
 * 把暗号**原文**从对话记录里捞出来。
 *
 * ★ 为什么要做这件事：用户设完暗号就忘了（尤其测试用的），而解锁框
 *   只认「子串包含」，他不会知道该敲什么。以前只能靠我人肉去 `messages.jsonl`
 *   里翻 —— 这个工具既然叫「演示」，就该把答案一并印出来。
 *
 * ⚠️ 找不到不算错：目录名是 base64 无 padding 变体（不能从 id 反推路径），
 *    这里一律**扫描**匹配，扫不到就返回 null，让调用方显示「自己想想」。
 */
function findAgreementText(pointer) {
  if (!pointer?.convId || !pointer?.messageId) return null
  const CONV_ROOT = join(homedir(), '.legacy', 'lc-local-backend', 'conversations')
  let dirs = []
  try {
    dirs = readdirSync(CONV_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(CONV_ROOT, d.name))
  } catch {
    return null
  }
  for (const dir of dirs) {
    let raw
    try {
      raw = readFileSync(join(dir, 'messages.jsonl'), 'utf8')
    } catch {
      continue // 没有 messages.jsonl 的（default 占位会话）跳过
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      // 磁盘上的 `id` 是哈希，活的 id 嵌在 message.id 里
      const liveId = rec?.message?.id ?? rec?.id
      if (liveId !== pointer.messageId) continue
      const content = rec?.message?.content ?? rec?.content
      if (typeof content === 'string') return content
      // content 是 parts 数组时逐段拼（首条 user 消息会被剥成多个 part）
      if (Array.isArray(content)) {
        return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
      }
    }
  }
  return null
}

if (cmd === 'show') {
  console.log('── locks.json 现状 ──')
  console.log('  软锁已启用   :', settings.softEnabled === true ? '是' : '否 ← 没打开，永远不会自动遮罩')
  console.log('  闲置超时     :', settings.idleTimeoutMin, '分钟')
  console.log('  暗号指针     :', agr ? `${agr.convId} / ${agr.messageId}` : '（尚未约定 → 也不会布防）')
  console.log('  强锁对话     :', (st.lockedConvIds ?? []).length, '条')
  console.log('  已设强锁密码 :', st.strong?.passwordHash ? '是' : '否')
  if (agr) {
    const text = findAgreementText(agr)
    console.log('')
    console.log('  ── 暗号原文（从对话记录里读出来的）──')
    if (text === null) {
      console.log('  （没找到。指针指向的那条消息可能已被删；换一条暗号再试）')
    } else {
      for (const line of text.split('\n')) console.log('  | ' + line)
      console.log('')
      console.log('  ★ 解锁时敲上面**任意一段**即可（比对是子串包含，不需要一模一样）。')
      console.log('    全角/半角标点已经做过归一化，`？` 和 `?` 都认。')
    }
  }
  console.log('')
  console.log('小结：', settings.softEnabled === true && agr
    ? '两条门槛都过了 —— 闲置到点就会遮罩。'
    : '★ 门槛没过，所以你看不到遮罩（这是设计使然，不是 bug）。跑 `node tools/lock-demo.mjs on` 打开。')
  process.exit(0)
}

if (cmd === 'on') {
  st.settings = { ...settings, softEnabled: true, idleTimeoutMin: 0.05 }  // 3 秒
  save(st)
  console.log('✅ 软锁演示已打开：闲置 **3 秒** 即遮罩全部历史。')
  console.log('   ⚠️ 现在去重启 orb（关掉球重新双击 run.cmd），设置只在启动时读一次。')
  console.log('')
  console.log('   遮罩出现后，解锁框里敲暗号的**任意片段**即可：')
  console.log('     球上有几颗糖')
  console.log('   （比对是「子串包含」，「几颗糖」这种两三个字也算过）')
  process.exit(0)
}

if (cmd === 'off') {
  st.settings = { ...settings, softEnabled: false, idleTimeoutMin: 30 }
  save(st)
  console.log('✅ 已还原：软锁未启用 / 闲置 30 分钟。重启 orb 生效。')
  process.exit(0)
}

console.error(`未知命令：${cmd}（可用：on / off / show）`)
process.exit(1)
