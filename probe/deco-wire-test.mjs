/**
 * 情绪装饰 GIF（P1-5）端到端接线探针。
 *
 * ★ 这个探针为什么必须存在 —— 它守的是一次**静默丢弃型**的协议缺失：
 *   host 侧 `sendMood()` 一直在发 `{type:'deco', ...}`，日志也写着「情绪 → happy」，
 *   但 `helper/lib/main.js` 的 `dispatchRecord` 里**根本没有 `deco` 分支**，
 *   记录走完匹配全落空 → 球侧永远收不到 → 用户看到的是「她永远只有一张脸」，
 *   而且**没有任何报错**。这类 bug 靠读代码肉眼很难发现，必须有探针钉住。
 *
 * 三层断言（对应链路的三段）：
 *   1. **素材**：6 个情绪的 GIF 都在 `helper/assets/deco/`，且文件名过球侧那条正则
 *   2. **主进程分发**：`dispatchRecord` 里存在 `deco` 分支，且过 `PRESET_SRC` 校验
 *   3. **preload → 渲染层**：`onDeco` 暴露了、HTML 里有 `#deco`、
 *      CSS 落点符合 CONFIG（图层 0 / 不吃事件）、shell.js 订阅了
 *
 * ⚠️ 与其它探针一样，**产物里没有的东西这里也测不到**：
 *   GIF 实际播不播、位置好不好看，必须真机看。
 *
 * 跑法：`node probe/deco-wire-test.mjs`
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MOODS, MOOD_NAMES, LAYER_OPACITY, DEFAULT_MOOD, assetFor, isSafeAssetSrc, sourceFileName } from '../src/mood.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = join(ROOT, 'helper', 'assets')
const DECO_DIR = join(ASSETS, 'deco')

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`PASS ${name}`)
    return
  }
  failed += 1
  console.log(`FAIL ${name}${detail === '' ? '' : ` —— ${detail}`}`)
}

// ═══════════════════════════════════════════════════════════ 1. 素材层

console.log('── 1. 素材：6 个情绪的 GIF 都在，且文件名合规 ──')

/**
 * 球侧那条正则（`helper/lib/main.js` 的 PRESET_SRC）。
 * 这里**从产品文件里抠出来**，不复刻 —— 复刻一份就多一处能漂移的地方。
 */
const MAIN_JS = readFileSync(join(ROOT, 'helper', 'lib', 'main.js'), 'utf8')
const PRESET_RE = (() => {
  // ⚠️ 变量名可能带打包后缀：`helper/lib/main.js` 是**构建产物**，tsdown 撞名时会
  //    把它重命名成 `PRESET_SRC$1`（2026-10-23 实测）。原来只认 `PRESET_SRC`，
  //    于是产品没坏、探针先红 —— 这是"断言过时"，不是回归。
  const m = MAIN_JS.match(/const PRESET_SRC(?:\$\d+)?\s*=\s*(\/\^\[a-z0-9\][^\n;]*\/[a-z]*)/)
  if (m === null) throw new Error('产品 main.js 里找不到 PRESET_SRC 定义（含 $N 后缀也认）')
  return new RegExp(m[1].slice(1, m[1].lastIndexOf('/')).replace(/\/$/, ''))
})()

check('能从产品 main.js 里解析出球侧那条 src 正则', PRESET_RE instanceof RegExp,
  `解析结果 ${String(PRESET_RE)}`)

for (const mood of MOOD_NAMES) {
  const asset = assetFor(mood)
  const file = join(ASSETS, ...asset.src.split('/'))
  check(`${mood}: src 过球侧正则（${asset.src}）`,
    isSafeAssetSrc(asset.src) && PRESET_RE.test(asset.src),
    `host 侧 isSafeAssetSrc=${isSafeAssetSrc(asset.src)} 球侧正则=${PRESET_RE.test(asset.src)}`)
  check(`${mood}: 素材文件真实存在`, existsSync(file) && statSync(file).size > 0,
    existsSync(file) ? `size=${statSync(file).size}` : '文件不存在')
  check(`${mood}: src 的目录段与 DECO_DIR 一致`, asset.src.startsWith('deco/'), asset.src)
}

check(`六个情绪全齐（${MOOD_NAMES.join('/')}）`, MOOD_NAMES.length === 6, `实际 ${MOOD_NAMES.length} 个`)
check('兜底情绪是 idle', DEFAULT_MOOD === 'idle', DEFAULT_MOOD)
check('认不出的情绪退化成 idle（不抛错、不返回 null）',
  assetFor('不存在的情绪').mood === 'idle' && assetFor(undefined).mood === 'idle')
check('每个情绪都有倍速记录（sourceFileName 能算出素材原名）',
  MOOD_NAMES.every((m) => sourceFileName(m) === `${m}@${MOODS[m].speed}.gif`),
  MOOD_NAMES.map((m) => sourceFileName(m)).join(' '))

// 素材原名必须**过不了**球侧正则 —— 这是「为什么必须有 copy-deco.mjs」的实证。
check('★ 素材原名（含 @ 和小数点）过不了球侧正则 —— 所以才需要统一改名',
  MOOD_NAMES.every((m) => !PRESET_RE.test(sourceFileName(m))),
  `${sourceFileName('happy')} 竟然过了？`)

// ═══════════════════════════════════════════════════════════ 2. 主进程分发

console.log('\n── 2. 主进程：dispatchRecord 里有 deco 分支（★ 这里以前是空的） ──')

check('★ main.js 的 dispatchRecord 里存在 record.type === "deco" 分支',
  /record\.type\s*===\s*"deco"/.test(MAIN_JS),
  '没找到 —— 记录会静默丢弃，症状是「她永远只有一张脸」且零报错')

// ⚠️ 下面几条断言用 `[\s\S]{0,N}` 在「deco 分支起点 → 分支体」之间找东西。
//   N 必须**大于分支里那段注释的长度** —— 一开始写 600，三条全红，
//   而代码是对的：分支上面有20 多行解释「为什么以前没有这个分支」的注释，
//   把 `webContents.send` 推出了窗口。教训同 MEMORY.md 那条
//   「期望值写反 → 实现对的探针错的」，只是这次是窗口开小了。
const DECO_BODY = '1200'

check('deco 分支把 src 过了一遍球侧那条 PRESET_SRC',
  new RegExp(`record\\.type\\s*===\\s*"deco"[\\s\\S]{0,${DECO_BODY}}?PRESET_SRC\\.test\\(record\\.src\\)`).test(MAIN_JS),
  'src 没校验 —— 非法路径会变成渲染层的加载失败破图')

check('deco 分支转发到 orb:deco 这个 IPC 事件',
  new RegExp(`record\\.type\\s*===\\s*"deco"[\\s\\S]{0,${DECO_BODY}}?webContents\\.send\\(\\s*"orb:deco"`).test(MAIN_JS))

check('★ 非法 src 时**直接 return**（不 send），不是把坏路径发出去',
  new RegExp(`record\\.type\\s*===\\s*"deco"[\\s\\S]{0,900}?!\\s*PRESET_SRC\\.test\\(record\\.src\\)\\)\\s*return`).test(MAIN_JS))

check('opacity 被夹到 [0,1]（宿主可能被改坏的值直接扔）',
  new RegExp(`record\\.type\\s*===\\s*"deco"[\\s\\S]{0,${DECO_BODY}}?Math\\.min\\(1,\\s*Math\\.max\\(0,`).test(MAIN_JS))

check('★ deco 用的是**专用类型**，没有复用 avatar（球脸兼拖窗把手，不能挂情绪）',
  new RegExp(`record\\.type\\s*===\\s*"deco"[\\s\\S]{0,${DECO_BODY}}?webContents\\.send\\(\\s*"orb:deco"`).test(MAIN_JS)
    && !new RegExp(`record\\.type\\s*===\\s*"deco"[\\s\\S]{0,400}?orb:avatar`).test(MAIN_JS))

// ═══════════════════════════════════════════════ 3. preload → 渲染层

console.log('\n── 3. preload / HTML / CSS / shell.js ──')

const PRELOAD = readFileSync(join(ROOT, 'helper', 'preload.cjs'), 'utf8')
const HTML = readFileSync(join(ASSETS, 'floating.html'), 'utf8')
const CSS = readFileSync(join(ASSETS, 'floating.css'), 'utf8')
const SHELL = readFileSync(join(ASSETS, 'shell.js'), 'utf8')

check('preload 暴露了 onDeco', /onDeco\s*\(callback\)/.test(PRELOAD))
check('onDeco 监听的是 orb:deco',
  /onDeco[\s\S]{0,200}?ipcRenderer\.on\('orb:deco'/.test(PRELOAD))
check('★ preload 没有把 deco 混进 onAvatar（球脸不能挂情绪）',
  !/onAvatar[\s\S]{0,300}?orb:deco/.test(PRELOAD))

check('HTML 里有独立的 #deco 图层', /<img[^>]*id="deco"/.test(HTML))
// ⚠️ 这两个断言用 `[\s\S]{0,N}` 窗口时，N 必须大于中间隔着的全部属性长度。
//    2026-10-07 美化后 <img id="deco"> 的属性变多了（多了 class 等），
//    窗口太小会让「属性确实在，但被推出窗口」→ 假红。
//    改成「先切出这个 img 标签、再在标签内找」，与属性顺序和数量都无关。
const decoTag = (() => {
  const m = HTML.match(/<img[^>]*id="deco"[^>]*>/)
  return m === null ? '' : m[0]
})()
check('HTML 里能切出 #deco 的 <img> 标签', decoTag !== '')
check('#deco 标了 draggable="false"（别让人把图拖走）', /draggable="false"/.test(decoTag), decoTag)
check('#deco 引用了空 alt（纯装饰，不给读屏念内容）', /alt=""/.test(decoTag), decoTag)
check('#deco 不是球的 #ball-gif（那是球脸）', !/ball-gif/.test(decoTag), decoTag)

// CSS 落点：按 deco-plan/CONFIG.md（用户已确认）
const decoRule = (() => {
  const m = CSS.match(/(?:^|\})\s*#deco\s*\{([^}]*)\}/m)
  return m === null ? null : m[1]
})()
/** 从一条 CSS 规则里抠出 z-index 数值；没写就返回 null（= 不参与层叠竞争）。 */
function deocZIndex(rule) {
  const m = rule.match(/z-index:\s*(-?\d+)\s*;/)
  return m === null ? null : Number(m[1])
}
check('CSS 里有 #deco 规则', decoRule !== null)
if (decoRule !== null) {
  // ★ z-index 从 0 改成 1（2026-10-07 美化：装饰层单独成条 #deco-lane，
  //   整条 lane 是 z-index 1；对话正文仍是 2，所以「文字在图之上」没变）。
  //   ⚠️ 现在 z-index 写在 **#deco-lane** 上，不在 #deco 上 ——
  //      #deco 是 lane 的子元素，层叠跟着父级走。断言要认这个结构，
  //      不然会像第一次那样报「#deco z-index = null」的假红。
  const laneRule = (() => {
    const m = CSS.match(/(?:^|\})\s*#deco-lane\s*\{([^}]*)\}/m)
    return m === null ? null : m[1]
  })()
  check('★ 装饰层整条 lane 的 z-index 低于正文（文字 z-index 2）',
    laneRule !== null && deocZIndex(laneRule) !== null && deocZIndex(laneRule) < 2,
    laneRule === null ? '#deco-lane 规则没找到' : `lane z-index = ${String(deocZIndex(laneRule))}`)
  check('★ pointer-events: none（硬要求 —— 落在面板底部，吃了事件就点不到那一片）',
    /pointer-events:\s*none\s*;/.test(decoRule))
  check('绝对定位（落点按 CONFIG 精确定位）', /position:\s*absolute/.test(decoRule))
  // ★ 落点从「左下角」改成「右下角」（2026-10-07 美化：放进 #deco-lane，右侧对齐）
  check('落在右下角（right + bottom）',
    /right:\s*[^;]+;/.test(decoRule) && /bottom:\s*[^;]+;/.test(decoRule),
    decoRule.replace(/\s+/g, ' ').slice(0, 120))
  check('★ #deco 在 #deco-lane 里（美化后的容器契约）',
    /<div[^>]*id="deco-lane"[\s\S]*?id="deco"/.test(HTML))
  // ⚠️ 不锁死具体透明度（用户会随美化调）。只要求 CSS 与 JS **同一个值**，
  //    因为 CSS 是初始渲染、JS 是运行时覆盖，两者不一致会闪一下。
  check('★ CSS 透明度与 mood.mjs 的 LAYER_OPACITY 一致（不锁死具体数值）',
    (() => {
      const m = decoRule.match(/opacity:\s*([\d.]+)\s*;/)
      return m !== null && Number(m[1]) === LAYER_OPACITY
    })(),
    `CSS ${(decoRule.match(/opacity:[^;]*/) || ['无'])[0]} / JS ${LAYER_OPACITY}`)
  check('尺寸走 --deco-size 变量（便于统一调）', /var\(--deco-size\)/.test(decoRule))
}

check('CSS 里定义了 --deco-size', /--deco-size:\s*\d+px/.test(CSS))
check('CSS 里定义了 --deco-lane-height（美化后新增的车道高度）',
  /--deco-lane-height:\s*\d+px/.test(CSS))
check('收起态把 #deco 藏了（body:not(.expanded)）',
  /body:not\(\.expanded\)\s*#deco/.test(CSS))

check('★ shell.js 订阅了 api.onDeco', /api\.onDeco\s*\(/.test(SHELL))
check('shell.js 里查了 #deco 节点', /querySelector\('#deco'\)/.test(SHELL))
check('applyDeco 挡了 `..` 路径（纵深防护）',
  /function applyDeco[\s\S]{0,900}?includes\('\.\.'\)/.test(SHELL))
check('applyDeco 写了 data-mood（CONFIG 待办的「状态联动」与探针都要靠它）',
  /dataset\.mood\s*=/.test(SHELL))
check('★ 同一个 src 重复推时不重新赋值（换 src 会让 GIF 从头播 = 卡帧）',
  /function applyDeco[\s\S]{0,900}?src === deco\.getAttribute\('src'\)/.test(SHELL))

// ═══════════════════════════════════════════════ 4. 反向对照

console.log('\n── 4. 反向对照：这些断言必须能抓到「链路没接」 ──')

{
  // 把 shell.js 的订阅行去掉，模拟「UI 助手还没接」的原始状态
  //
  // ⚠️ 2026-10-08：这条对照曾**静默失效**（探针报「对照失效」，但没人查）。
  //   旧正则 `\s*if \(typeof api\.onDeco === 'function'\) \{[\s\S]{0,200}?\}\n`
  //   要求闭括号后紧跟换行 —— 它假设订阅体是**多行**的。而 shell.js 现在写成
  //   单行 `api.onDeco((payload) => { applyDeco(payload) })`，箭头函数体里
  //   那个 `}` 后面是 `)` 不是 `\n` ⇒ 正则**匹配不到任何东西** ⇒ replace 是
  //   空操作 ⇒ broken === SHELL ⇒ 对照自动判红。
  //   （实测：`re.exec(SHELL)` 返回 NO MATCH。）
  //
  //   教训与本项目一贯的「探针自身也会踩坑」一致：**负向对照自己要有对照**。
  //   ★ 2026-10-08 二次修正：上一版我写 `[\s\S]*?\n\s*\}\n` 仍然 **NO MATCH**。
  //     原因是 shell.js **换行是 CRLF**，而且 `[\s\S]*?` 是惰性的 ——
  //     它停在第一个 `}`（即箭头函数体 `{ applyDeco(payload) }` 那个），
  //     其后跟的是 `)` 不是 `\n`，于是整条匹配失败。
  //     正确写法：锚定 `if (...)` 之后用惰性 `[\s\S]*?` 直到**行首缩进的 `}`**
  //     （`^[ \t]*\}` 多行模式），并容忍 `\r`。实测这条能匹配（长度 99）。
  const re = /\s*if \(typeof api\.onDeco === 'function'\) \{[\s\S]*?^[ \t]*\}[ \t]*\r?\n/m
  const broken = SHELL.replace(re, '\n')
  check('（对照）删掉 shell.js 的订阅后，订阅断言会红',
    broken !== SHELL && !/api\.onDeco\s*\(/.test(broken),
    broken === SHELL
      ? '对照失效 —— 正则没匹配到订阅块（shell.js 的写法可能又变了）'
      : '对照失效 —— 删掉后仍能匹配到 api.onDeco（断言抓不住“没接”）')
}
{
  // 把主进程的 deco 分支删掉，模拟「2026-10-07 之前的真实状态」。
  // ⚠️ 锚点不能用 `indexOf('if (record.type === "deco")')` 的朴素写法 ——
  //   分支上面那段注释里就写着 `record.type === "deco"`（解释「以前没有这个分支」），
  //   朴素indexOf 命中的是注释而不是代码，切出来的还是原文件 → 对照假绿。
  //   正确做法：从注释之后找分支，即匹配 `{\n\tif (record.type === "deco")`（带换行+Tab）。
  //
  // ⚠️ 还要注意 **deco 是 dispatchRecord 的最后一个分支**，后面没有同类的
  //   `if (record.type === "x") {` 可以当终点。所以不能「切[start, end)」
  //   —— 找���到 end 时容易写出 end < start 的假对照。
  //   正确做法：**从文件开头切到分支起点**，即把分支及其之后的内容全丢掉。
  const re = /\n\tif \(record\.type === "deco"\) \{/
  const m = re.exec(MAIN_JS)
  const start = m?.index ?? -1
  const noDeco = start > 0 ? MAIN_JS.slice(0, start) : MAIN_JS
  check('（对照）删掉主进程 deco 分支后，分发断言会红',
    start > 0 && noDeco.length < MAIN_JS.length && !/record\.type\s*===\s*"deco"\s*\)\s*\{/.test(noDeco),
    `start=${start} —— 对照失效，说明这条断言抓不住「静默丢弃」`)
}
{
  // 去掉 pointer-events: none，模拟「装饰层挡住输入框」
  const greedy = CSS.replace(/(#deco\s*\{[^}]*?)pointer-events:\s*none;/, '$1pointer-events: auto;')
  const rule = greedy.match(/(?:^|\})\s*#deco\s*\{([^}]*)\}/m)
  check('（对照）把 pointer-events 改成 auto 后，那条断言会红',
    rule !== null && !/pointer-events:\s*none/.test(rule[1]),
    '对照失效 —— 说明这条断言抓不住「装饰层吃事件」')
}

// ═══════════════════════════════════════════════════════════ 汇总

console.log('\n' + '='.repeat(56))
console.log(`通过 ${passed} / 失败 ${failed}`)
console.log('='.repeat(56))
console.log('')
console.log('⚠️ 探针验的是「链路通不通」。以下必须真机看：')
console.log('   · GIF 实际播不播（素材 960×960，缩到 --deco-size 后是否还流畅）')
console.log('   · 落点好不好看（#deco-lane 内右下角，是否与左侧 reasoning-lane 打架）')
console.log('   · 收起态会不会露出一角')
process.exit(failed === 0 ? 0 : 1)
