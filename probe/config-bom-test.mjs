/**
 * config.json 的 BOM 容忍验证。
 *
 * 背景：`build.ps1` 过去用 PowerShell 的 `Set-Content -Encoding UTF8` 写 config.json，
 * 在 Windows PowerShell 5.1 下会带 BOM（实测首字节 EF BB BF）。
 * 而 `JSON.parse` 遇到 \uFEFF 直接抛 `Unexpected token` —— `loadConfig()` 的 catch
 * 会**静默回落到默认值**，用户手改的 model / lettaUrl / permission 全部失效。
 *
 * 这个探针把三种输入的解析结果摆在一起：
 *   1. 无 BOM（正常）
 *   2. 带 BOM（修复前会失败）
 *   3. 验证 main.mjs 里那行 `.replace(/^\uFEFF/, '')` 确实存在
 *
 * 注意：本探针只能验「字符串层面的解析」。
 * 真正的 loadConfig 要 Electron 才能跑，所以第 3 条用源码断言补上。
 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (!ok) failed += 1;
};

const sample = '{"model":"m","agentId":null,"permission":"read-only"}';

// 1) 无 BOM：正常解析
let plain = null;
try {
  plain = JSON.parse(sample);
} catch {}
check("无 BOM 可解析", plain !== null && plain.model === "m");

// 2) 带 BOM：裸 JSON.parse 必须失败（证明这个坑真实存在）
let bomFailed = false;
try {
  JSON.parse("\uFEFF" + sample);
} catch {
  bomFailed = true;
}
check("★ 裸 JSON.parse 遇到 BOM 会抛（坑是真的）", bomFailed);

// 3) 剥 BOM 后必须成功
let stripped = null;
try {
  stripped = JSON.parse(("\uFEFF" + sample).replace(/^\uFEFF/, ""));
} catch {}
check("剥 BOM 后可解析", stripped !== null && stripped.model === "m");

// 4) 源码里 loadConfig 确实带了剥 BOM
const mainSrc = readFileSync(join(PROJECT_ROOT, "src", "main.mjs"), "utf8");
const loadBlock = mainSrc.slice(
  mainSrc.indexOf("function loadConfig()"),
  mainSrc.indexOf("const { raw: rawConfig")
);
check(
  "main.mjs loadConfig 里剥了 BOM",
  /replace\(\/\^\\uFEFF\/,\s*""\)/.test(loadBlock) || loadBlock.includes("replace(/^\\uFEFF/, '')")
);

// 5) build.ps1 用 .NET 无 BOM 写入
const buildSrc = readFileSync(join(PROJECT_ROOT, "build.ps1"), "utf8");
check("build.ps1 用 UTF8Encoding($false)", buildSrc.includes("UTF8Encoding($false)"));
check("build.ps1 不再用 Set-Content 写 config", !/Set-Content\s+-Path\s+"\$dist\\config\.json"/.test(buildSrc));

// 6) 真写一个带 BOM 的文件，验证读回时剥得掉
const tmp = join(PROJECT_ROOT, "probe", "_bom_probe.json");
writeFileSync(tmp, "\uFEFF" + sample, "utf8");
const raw = readFileSync(tmp, "utf8");
check("写盘的 BOM 文件确实带 \\uFEFF", raw.charCodeAt(0) === 0xfeff);
let reread = null;
try {
  reread = JSON.parse(raw.replace(/^\uFEFF/, ""));
} catch {}
check("读回并剥 BOM 后可解析", reread !== null && reread.permission === "read-only");
try {
  unlinkSync(tmp);
} catch {}

console.log(failed === 0 ? "\n=== 全部通过 ===" : `\n=== ${failed} 项失败 ===`);
process.exit(failed === 0 ? 0 : 1);
