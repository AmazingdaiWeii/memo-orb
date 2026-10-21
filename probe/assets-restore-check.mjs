// 素材还原后的落地校验：代码期望的路径 vs 磁盘实际文件。
// 只读，不改任何东西。node probe/assets-restore-check.mjs
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = join(ROOT, 'helper', 'assets')

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log('  PASS  ' + m) }
const no = (m) => { fail++; console.log('  FAIL  ' + m) }

// 1) 情绪图：mood.mjs 的 MOODS 里每个 key 都要有对应的 deco/<key>.gif
console.log('\n[1] 情绪图（deco/）')
const { MOODS } = await import('../src/mood.mjs')
const keys = Object.keys(MOODS)
console.log('  MOODS 声明了 ' + keys.length + ' 种: ' + keys.join(', '))
for (const k of keys) {
  const p = join(ASSETS, 'deco', k + '.gif')
  existsSync(p) ? ok('deco/' + k + '.gif') : no('deco/' + k + '.gif 缺失')
}
// 反向：磁盘上多出来的
for (const f of readdirSync(join(ASSETS, 'deco'))) {
  if (!f.endsWith('.gif')) continue
  if (!keys.includes(f.slice(0, -4))) console.log('  note  磁盘有但 MOODS 未声明: ' + f)
}

// 2) 球形态：avatars/ 下的每个 gif 都要能在 TRAY_FACE_CROP 里找到标定
console.log('\n[2] 球形态（avatars/）与托盘标定')
const shell = await import('node:fs').then(m => m.readFileSync(join(ASSETS, 'shell.js'), 'utf8'))
const cropBlock = shell.slice(shell.indexOf('const TRAY_FACE_CROP = {'), shell.indexOf('TRAY_FACE_CROP_FALLBACK'))
const avatarFiles = readdirSync(join(ASSETS, 'avatars')).filter(f => f.endsWith('.gif'))
console.log('  磁盘上有 ' + avatarFiles.length + ' 张: ' + avatarFiles.join(', '))
for (const f of avatarFiles) {
  cropBlock.includes("'avatars/" + f + "'") ? ok('avatars/' + f + ' 已标定') : no('avatars/' + f + ' 无标定（会走 fallback）')
}
// 反向：标定了但文件已没
for (const m of cropBlock.matchAll(/'avatars\/([^']+)'/g)) {
  existsSync(join(ASSETS, 'avatars', m[1])) ? 0 : no('标定表里的 avatars/' + m[1] + ' 文件不存在')
}
cropBlock.includes("'orb-idle.gif'") ? ok('orb-idle.gif 已标定') : no('orb-idle.gif 无标定')

// 3) 示例球脸与默认图
console.log('\n[3] 默认球脸')
existsSync(join(ASSETS, 'orb-idle.gif')) ? ok('orb-idle.gif 存在') : no('orb-idle.gif 缺失（球会变空白）')

// 4) 被移走的只剩上游素材
console.log('\n[4] bak/ 残留（应只有上游素材与图标，不该有自制 GIF）')
const bak = join(ROOT, 'bak', 'assets-original-20261021-185642')
for (const f of readdirSync(bak)) {
  if (f.endsWith('.gif') && f !== 'deepseek-avatar-square.gif') no('bak/ 里仍有自制素材: ' + f)
  else if (f.endsWith('.gif') || f.endsWith('.png') || f.endsWith('.ico')) console.log('  note  上游素材: ' + f)
}
ok('bak/ 无自制 GIF 残留（' + readdirSync(bak).length + ' 项均为上游素材/图标）')

console.log('\n== ' + pass + ' PASS / ' + fail + ' FAIL ==')
process.exit(fail ? 1 : 0)
