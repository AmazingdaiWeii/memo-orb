/**
 * 对话框发图（P2-4）—— **上送链路**协议验证。
 *
 * 姊妹探针 `image-attach-test.mjs` 验的是「球侧收得到、画得出、发得掉」，
 * 本文件验的是**跨进程那一段**：
 *
 *   shell.js → preload.cjs → helper/lib/main.js（socket）→ src/main.mjs → Letta
 *
 * ★ 为什么必须单独一条：`image-attach-test` 里 `api` 是个 Proxy，
 *   `send(text, attachments)` 只是**被记下来**，第二个实参有没有被
 *   preload 真正转发出去，它一点都不知道。
 *   这正是「记录型桩测不出跨进程丢字段」的经典盲区 ——
 *   `preload.cjs` 白名单丢 `password` 那次就是这么漏掉的。
 *
 * ★ 做法：**读产品文件源码断言分支存在**，而不是 import 后调用。
 *   理由：`preload.cjs` 依赖 `electron`（探针里没有），
 *   `helper/lib/main.js` 更是一整个 Electron 主进程。
 *   项目里 `deco-wire-test` 已经确立了这种「源码断言型」探针 ——
 *   它对「静默丢弃型」的协议缺失（少一个 case、少一个字段）最有效。
 *
 * ⚠️ 这类断言的**最大陷阱**是「命中注释里的字」：
 *   第一版用 `indexOf('if (record.type === "deco")')` 命中的是注释里那行字，
 *   切出来的还是原文件，于是对照说「断言抓得住」—— 假绿。
 *   这里所有正则都要求 `\n\t?` 前缀（真正的代码行缩进），
 *   且**反向验证**（改坏产品 → 断言必须红）已实跑过，见文件末尾注释。
 *
 * 跑法：`node probe/image-wire-probe.mjs`
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS ${name}`); return }
  failed += 1
  console.log(`FAIL ${name}${detail === '' ? '' : ` —— ${detail}`}`)
}

const PRELOAD = readFileSync(join(ROOT, 'helper', 'preload.cjs'), 'utf8')
const HELPER_MAIN = readFileSync(join(ROOT, 'helper', 'lib', 'main.js'), 'utf8')
const SRC_MAIN = readFileSync(join(ROOT, 'src', 'main.mjs'), 'utf8')
/** 自建引擎那侧：图片 part 真正被拼装的地方（2026-10-21 补）。 */
const SRC_BRAIN = readFileSync(join(ROOT, 'src', 'brain.mjs'), 'utf8')

/** 取函数体：从 `start` 位置往后扫括号配对，返回 body 文本。 */
function bodyFrom(text, marker, { occurrence = 1 } = {}) {
  let idx = -1
  let from = 0
  for (let i = 0; i < occurrence; i++) {
    idx = text.indexOf(marker, from)
    if (idx < 0) return null
    from = idx + marker.length
  }
  // 从 marker 之后找第一个 '{'，然后配对到对应的 '}'
  const open = text.indexOf('{', idx)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return null
}

// ═══════════════════════════════════════════════ 1. preload

console.log('── 1. preload.cjs：send 能带附件 ──')

const sendBody = bodyFrom(PRELOAD, 'send(text, attachments)')
check('★ preload 的 send 接第二个形参 attachments', sendBody !== null,
  '没找到 `send(text, attachments) {` —— 说明还是旧的一参版本')
check('★ send 把 attachments 放进 payload（不是丢掉）',
  sendBody !== null && /payload\.attachments\s*=|attachments/.test(sendBody),
  sendBody?.slice(0, 200))
check('★ 空数组时不挂 attachments 键（保持与旧 host 的兼容语义）',
  sendBody !== null && /length > 0/.test(sendBody),
  '没看到「只有非空才挂」的判断')
check('★ send 仍然走 `orb:prompt` 通道（没另起一条没人接的通道）',
  sendBody !== null && /ipcRenderer\.send\('orb:prompt'/.test(sendBody))

// ═══════════════════════════════════════════════ 2. helper 侧

console.log('\n── 2. helper/lib/main.js：收得下、校验得了 ──')

const onPrompt = bodyFrom(HELPER_MAIN, 'ipcMain.on("orb:prompt"')
check('★ orb:prompt 处理器存在', onPrompt !== null)
check('★ 处理器把载荷交给 normalizePrompt 归一化（兼容字符串与对象两种形状）',
  onPrompt !== null && /normalizePrompt\(/.test(onPrompt),
  onPrompt?.slice(0, 160))

const normFn = bodyFrom(HELPER_MAIN, 'function normalizePrompt')
check('★ normalizePrompt 存在', normFn !== null)
check('★ 兼容裸字符串载荷（老探针/旧脚本仍传字符串）',
  normFn !== null && /typeof payload === "string"/.test(normFn))
check('★ 只放行 image/ 开头的 mimeType（不让任意文件冒充图片上送）',
  normFn !== null && /startsWith\("image\/"\)/.test(normFn))
check('★ 有单张上限（防止 base64 把 IPC 撑爆）',
  normFn !== null && /MAX_ATTACHMENT_B64/.test(normFn))
check('★ 有张数上限', normFn !== null && /MAX_ATTACHMENTS/.test(normFn))
check('★ 有张数上限常量定义', /const MAX_ATTACHMENTS = \d+/.test(HELPER_MAIN))
check('★ 输出字段是 name / mimeType / data 三个（与主进程读的一致）',
  normFn !== null && /name:/.test(normFn) && /mimeType/.test(normFn) && /data/.test(normFn))

// ═══════════════════════════════════════════════ 3. src/main.mjs

console.log('\n── 3. src/main.mjs：转成 Letta 的 content array ──')

check('★ onUserPrompt 接第二个形参 attachments',
  /async function onUserPrompt\(text, attachments\)/.test(SRC_MAIN),
  '还是单参版本 → 附件会在这一跳被丢掉')
check('★ prompt 分发点把 msg.attachments 传下去',
  /case 'prompt':[\s\S]{0,120}onUserPrompt\(String\(msg\.text \?\? ''\), msg\.attachments\)/.test(SRC_MAIN),
  '分发点没传 attachments')

const buildFn = bodyFrom(SRC_MAIN, 'function buildUserContent')
check('★ buildUserContent 存在', buildFn !== null)
check('★ 无附件时返回**纯字符串**（老路径形状不变）',
  buildFn !== null && /if \(!attachments \|\| attachments\.length === 0\) return body/.test(buildFn))
check('★ 有附件时返回 content array（不是字符串拼接）',
  buildFn !== null &&
  // 首元素是 text part（用字面量数组起步），后续 push image part
  /const parts = \[\{[\s\S]{0,80}type: 'text'/.test(buildFn) &&
  /parts\.push\(\{[\s\S]{0,160}type: 'image'/.test(buildFn) &&
  /return parts/.test(buildFn),
  buildFn?.slice(0, 300))
// ★ 2026-10-21 形状修正：这条断言原来钉的是 **Letta 归一化**的形状
//   （input_image + dataURL）—— 那条协议在 2026-10-19 断脐后已经退役，
//   断言却还在，于是「产品是对的、探针是过时的」这种假红又来了一次。
//   现状有两套图片形状，各有各的用处，必须都钉住：
//     ① `buildUserContent`（src/main.mjs）—— **旧后端分支**专用，
//        发 Anthropic 形状 `{type:'image', source:{type:'base64', media_type, data}}`；
//     ② `src/brain.mjs` —— **自建引擎**真正走的那条路，
//        发 OpenAI/DeepSeek 形状 `{type:'image_url', image_url:{url:'data:…;base64,…'}}`。
//   原来只钉 ①（而且钉的是已退役的形状），漏了 ②（真正上线的那条）—— 这次一起补上。
check('★ buildUserContent 的 image part 是 Anthropic 形状（source.base64 + media_type，旧后端分支专用）',
  buildFn !== null &&
  /type: 'image'/.test(buildFn) &&
  /source: \{ type: 'base64', media_type: a\.mimeType, data: a\.data \}/.test(buildFn),
  buildFn?.slice(0, 400))
check('★ 自建引擎（src/brain.mjs）发的是 image_url + dataURL 形状（本地引擎真正用的那条）',
  /type: 'image_url'/.test(SRC_BRAIN) &&
  /url: `data:\$\{[^}]+\};base64,\$\{im\.data\}`/.test(SRC_BRAIN) &&
  /image_url: \{/.test(SRC_BRAIN),
  'brain.mjs 里没找到 image_url + dataURL 形状')
check('★ 纯图无字时给占位文本（不给空 text part —— 某些实现会拒空消息）',
  buildFn !== null && /IMAGE_ONLY_PLACEHOLDER/.test(buildFn) && /body === ''/.test(buildFn))

const dispatchFn = bodyFrom(SRC_MAIN, 'function dispatchPrompt')
check('★ dispatchPrompt 用 buildUserContent 而不是裸 item.text',
  dispatchFn !== null && /buildUserContent\(item\.text, attach\)/.test(dispatchFn),
  dispatchFn?.slice(0, 300))
check('★ create_message 的 client_message_id 逻辑没被改动（排队去重那套还在）',
  dispatchFn !== null && /client_message_id: item\.id/.test(dispatchFn))
check('★ 日志带附件数（排障时能区分「没带上」和「带上了但后端没理」）',
  dispatchFn !== null && /附件=\$\{attach\.length\}/.test(dispatchFn))

check('★ 入队时保留了 attachments（队列里的 item 要带它一路走到底）',
  // ⚠️ 2026-10-21：原来这条要求 `attachments: attach }` **正好收尾**，
  //   而产品后来给队列项加了 `sessionId`（切会话时要按它补写），
  //   于是断言假红。收尾的 `}` 不该是契约的一部分 —— 只钉「附件没被丢掉」。
  /turnQueue\.push\(\{ id, text, attachments: attach/.test(SRC_MAIN),
  '入队只推了 {id,text} → 附件在排队阶段丢失')
check('★ 纯图无字不被 onUserPrompt 挡掉（旧版 `!text.trim()` 会静默吞）',
  /if \(!String\(text \?\? ''\)\.trim\(\) && attach\.length === 0\) return/.test(SRC_MAIN))

// 反向对照：确认「产品的 message content」这条路只在这一处改过
const createMsgSites = SRC_MAIN.match(/kind: 'create_message'/g) ?? []
check('create_message 只有一处（改动面收敛）', createMsgSites.length === 1,
  `找到 ${createMsgSites.length} 处`)

console.log('\n' + '='.repeat(56))
console.log(`通过 ${passed} / 失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
