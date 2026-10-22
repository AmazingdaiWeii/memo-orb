// 出厂包开源前审计：扫描一切可能暴露个人数据的痕迹（只读，不改任何文件）
// 用法: node tools/audit-export.mjs <出厂目录>
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const ROOT = process.argv[2];
if (!ROOT) { console.error('用法: node tools/audit-export.mjs <出厂目录>'); process.exit(2); }

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.mjs', '.cjs', '.js', '.css', '.html', '.cmd', '.ps1', '.yml', '.yaml', '.gitignore', '.lock', '.map', '.svg', '.xml', '.0', '']);
const PAT = [
  ['Windows 用户目录(反斜杠)', /[A-Za-z]:\\+Users\\+([A-Za-z0-9._\-]+)/g, 'path'],
  ['Windows 用户目录(正斜杠)', /[A-Za-z]:\/+Users\/+([A-Za-z0-9._\-]+)/g, 'path'],
  ['项目绝对路径', /[A-Za-z]:[\\/]+Memo orb/gi, 'plain'],
  ['母本绝对路径', /[A-Za-z]:[\\/]+[Ll]etta_?[Oo]rb/g, 'plain'],
  ['其他本机路径', /[A-Za-z]:\\+(?:dsh-home|dsh-workspace|deepseek-harness|ComfyUI|workbuddy|SteamLibrary)/gi, 'plain'],
  ['API key (sk-)', /sk-[A-Za-z0-9_\-]{16,}/g, 'secret'],
  ['GitHub token', /(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}/g, 'secret'],
  ['Google key', /AIza[0-9A-Za-z_\-]{35}/g, 'secret'],
  ['Slack token', /xox[baprs]-[A-Za-z0-9\-]{10,}/g, 'secret'],
  ['B站凭据', /(?:SESSDATA|bili_jct|DedeUserID|buvid3)=[^;"'\s]{6,}/g, 'secret'],
  ['微信凭据', /(?:wxid_[A-Za-z0-9_\-]{6,}|botToken)/g, 'secret'],
  ['凭据字段赋值', /["']?(?:api[_-]?key|apiKey|authorization|secret|password|passwd|appSecret)["']?\s*[:=]\s*["'][^"']{12,}["']/gi, 'secret'],
  ['邮箱', /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, 'email'],
  ['手机号', /(?<!\d)1[3-9]\d{9}(?!\d)/g, 'secret'],
  ['agentId', /agent-local-[0-9a-f][0-9a-f\-]{6,}/g, 'plain'],
  ['orb 日期 id', /\borb-2026\d{4}\b/g, 'plain'],
  ['B站会话 id', /conversation:[A-Za-z0-9\-]{6,}/g, 'plain'],
  ['本机端口', /127\.0\.0\.1:\d{4,5}/g, 'plain'],
  ['身份证/长数字串', /(?<!\d)\d{17}[\dXx](?!\d)/g, 'secret'],
  ['含凭据的 URL', /https?:\/\/[^\s"'<>]*(?:token|key|secret|password|sign)=[^\s"'<>]{6,}/gi, 'secret'],
];

// 二进制文件里值得找的字面量（latin1 扫描）
const NEEDLES = ['C:\\Users', 'C:/Users', 'sk-', 'agent-local-', 'orb-2026', 'SESSDATA', 'wxid_', 'dsh-home', 'Memo orb', 'Letta_orb', 'letta_orb', 'Administrator'];

const mask = (s, kind) => {
  if (kind === 'secret') return s.length <= 8 ? s.slice(0, 2) + '***' : s.slice(0, 6) + '…' + s.slice(-2) + `(len=${s.length})`;
  return s;
};

const files = [];
(function walk(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p);
    else files.push({ p, size: st.size, ext: extname(name).toLowerCase() });
  }
})(ROOT);

const report = new Map(); // pattern -> { count, files:Set, samples:[] }
const addHit = (pat, rel, where, match, kind) => {
  let r = report.get(pat);
  if (!r) { r = { count: 0, files: new Set(), samples: [] }; report.set(pat, r); }
  r.count++; r.files.add(rel);
  if (r.samples.length < 4) r.samples.push(`${rel}${where}  «${mask(match, kind)}»`);
};

const binHits = [];
const meta = [];   // 图片元数据（PNG/GIF/JPEG 里的文本块）
const parseErrors = [];

for (const f of files) {
  const rel = relative(ROOT, f.p);
  const isText = TEXT_EXT.has(f.ext) || f.size < 4096;
  let buf;
  try { buf = readFileSync(f.p); } catch (e) { parseErrors.push(`${rel}: ${e.message}`); continue; }

  if (isText) {
    const s = buf.toString('utf8');
    const lines = s.split(/\r?\n/);
    for (const [name, re, kind] of PAT) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) {
        const lineNo = s.slice(0, m.index).split('\n').length;
        addHit(name, rel, `:${lineNo}`, m[0], kind);
        if (m[0].length === 0) re.lastIndex++;
      }
    }
    if (f.ext === '.json' && (rel === 'config.json' || rel === 'package.json' || rel === 'package-lock.json' || rel.endsWith('helper/package.json'))) {
      meta.push({ rel, kind: 'json', text: s.slice(0, 1200) });
    }
  } else {
    const s = buf.toString('latin1');
    for (const n of NEEDLES) {
      let idx = -1, seen = 0;
      while ((idx = s.indexOf(n, idx + 1)) !== -1 && seen < 3) {
        seen++;
        const ctx = s.slice(Math.max(0, idx - 40), idx + 40).replace(/[^\x20-\x7e]/g, '.');
        binHits.push({ rel, needle: n, offset: idx, ctx });
      }
    }
  }

  // 图片元数据
  if (f.ext === '.png') meta.push({ rel, kind: 'png', chunks: pngChunks(buf) });
  else if (f.ext === '.gif') { const c = gifComments(buf); if (c.length) meta.push({ rel, kind: 'gif', text: c }); }
  else if (f.ext === '.jpg' || f.ext === '.jpeg') { const x = jpegStrings(buf); if (x.length) meta.push({ rel, kind: 'jpeg', text: x }); }
}

function pngChunks(buf) {
  const out = [];
  if (buf.length < 8) return out;
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME', 'pHYs'].includes(type)) {
      const data = buf.slice(off + 8, Math.min(buf.length, off + 8 + len));
      const printable = data.toString('latin1').replace(/[^\x20-\x7e\u4e00-\u9fff]/g, '.').slice(0, 200);
      out.push({ type, len, printable });
    }
    if (type === 'IEND') break;
    off += 12 + len;
    if (len > buf.length) break;
  }
  return out;
}
function gifComments(buf) {
  const out = [];
  let i = buf.indexOf(Buffer.from([0x21, 0xfe]));
  let guard = 0;
  while (i !== -1 && guard++ < 10) {
    const len = buf[i + 2] ?? 0;
    const txt = buf.slice(i + 3, i + 3 + len).toString('latin1').replace(/[^\x20-\x7e\u4e00-\u9fff]/g, '.');
    if (txt.trim()) out.push(txt.slice(0, 200));
    i = buf.indexOf(Buffer.from([0x21, 0xfe]), i + 3 + len);
  }
  return out;
}
function jpegStrings(buf) {
  const head = buf.slice(0, Math.min(buf.length, 256 * 1024)).toString('latin1');
  const out = [];
  if (!/Exif|Photoshop|XMP/.test(head)) return out;
  out.push('含 EXIF/XMP 段');
  const runs = head.match(/[\x20-\x7e]{6,}/g) ?? [];
  for (const r of runs) if (/Exif|Photoshop|XMP|http|Creator|Artist|Copyright|Software/.test(r)) out.push(r.slice(0, 160));
  return [...new Set(out)].slice(0, 12);
}

// ── 输出 ──
console.log(`扫描目录: ${ROOT}`);
console.log(`文件总数: ${files.length}  总体积: ${(files.reduce((a, b) => a + b.size, 0) / 1048576).toFixed(2)} MB`);
console.log('\n=== 文本命中（按类别聚合） ===');
if (!report.size) console.log('（无）');
for (const [name, r] of [...report.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`\n■ ${name}  命中 ${r.count} 次，涉及 ${r.files.size} 个文件`);
  for (const s of r.samples) console.log(`   ${s}`);
  if (r.files.size > 4) console.log(`   其余文件: ${[...r.files].slice(4, 14).join(', ')}${r.files.size > 14 ? ' …' : ''}`);
}

console.log('\n=== 二进制文件字面量命中 ===');
if (!binHits.length) console.log('（无）');
const byNeedle = new Map();
for (const h of binHits) {
  const k = `${h.needle} @ ${h.rel}`;
  if (!byNeedle.has(k)) byNeedle.set(k, []);
  byNeedle.get(k).push(h);
}
for (const [k, hs] of byNeedle) {
  console.log(`\n■ ${k}  共 ${hs.length} 处`);
  for (const h of hs.slice(0, 2)) console.log(`   offset ${h.offset}: …${h.ctx}…`);
}

console.log('\n=== 图片/文档元数据 ===');
let metaShown = 0;
for (const m of meta) {
  if (m.kind === 'json') {
    console.log(`\n■ ${m.rel}\n${m.text.split('\n').map((l) => '   ' + l).join('\n')}`);
    metaShown++;
    continue;
  }
  if (m.kind === 'png' && m.chunks.length) {
    const interesting = m.chunks.filter((c) => !['pHYs', 'tIME'].includes(c.type) || c.printable.replace(/\./g, '').length > 4);
    if (!interesting.length) continue;
    console.log(`\n■ ${m.rel}`);
    for (const c of interesting) console.log(`   ${c.type}(${c.len}B): ${c.printable}`);
    metaShown++;
    continue;
  }
  if ((m.kind === 'gif' || m.kind === 'jpeg') && m.text.length) {
    console.log(`\n■ ${m.rel}\n   ${m.text.join(' | ').slice(0, 400)}`);
    metaShown++;
  }
}
if (!metaShown) console.log('（图片无文本元数据，JSON 未取到）');
if (parseErrors.length) console.log('\n读失败: ' + parseErrors.join('; '));

const hardNames = ['Windows 用户目录(反斜杠)', 'Windows 用户目录(正斜杠)', 'API key (sk-)', 'GitHub token', 'Google key', 'Slack token', 'B站凭据', '微信凭据', '凭据字段赋值', '手机号', '身份证/长数字串', '含凭据的 URL'];
const hard = hardNames.filter((n) => report.has(n));
console.log('\n=== 结论 ===');
if (hard.length === 0) console.log('硬泄漏类别: 0 命中');
else console.log('硬泄漏类别命中: ' + hard.map((n) => `${n}(${report.get(n).count})`).join(' / '));
