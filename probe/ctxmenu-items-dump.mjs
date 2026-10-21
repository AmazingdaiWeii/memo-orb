/**
 * 直接构造原生右键菜单模板，把每一项 label 打出来。
 *
 * ★ 为什么需要这个探针：
 *   用户报「右键球体我没找到隐藏悬浮球」。源码里 `contextMenuTemplate` 确实有这一项，
 *   所以问题不在「有没有写」，而在「写的东西到没到用户眼前」——
 *   可能是分组顺序把新项推到了用户没细看的位置，也可能根本没走到这个模板。
 *   先把**实际产出的清单**打出来，再谈修。
 *
 * 用法：node probe/ctxmenu-items-dump.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mainSrc = readFileSync(join(ROOT, "helper", "lib", "main.js"), "utf8");

// 从源码里把 contextMenuTemplate 整段抠出来，抽出所有 label
const start = mainSrc.indexOf("function contextMenuTemplate(");
const end = mainSrc.indexOf("//#endregion", start);
const body = mainSrc.slice(start, end);

console.log("=== contextMenuTemplate 里出现的所有 label / 分隔符（按源码顺序）===\n");
const lines = body.split("\n");
let idx = 0;
for (const line of lines) {
  if (/type:\s*"separator"/.test(line)) {
    console.log(`  ${String(++idx).padStart(3)}  ────────── separator ──────────`);
    continue;
  }
  const zh = line.match(/label:\s*zh\s*\?\s*"([^"]+)"/);
  const en = line.match(/:\s*"([^"]+)"/);
  const plain = line.match(/^\s*label:\s*"([^"]+)"/);
  if (zh) console.log(`  ${String(++idx).padStart(3)}  ${zh[1]}`);
  else if (plain) console.log(`  ${String(++idx).padStart(3)}  ${plain[1]}`);
}

console.log("\n=== 检查项 ===");
console.log("含隐藏悬浮球（中文）：", body.includes('"隐藏悬浮球"'));
console.log("含 Hide floating ball（英文）：", body.includes('"Hide floating ball"'));
console.log("含 停用悬浮球：", body.includes('"停用悬浮球"'));
console.log("actions.hideBall 被调用：", body.includes("actions.hideBall()"));

// showMenu 是否真的把这个模板 popup 出来
const showStart = mainSrc.indexOf("async function showMenu(");
const showSeg = mainSrc.slice(showStart, showStart + 900);
console.log("\n=== showMenu 关键行 ===");
for (const l of showSeg.split("\n").slice(0, 26)) {
  if (/contextMenuTemplate|Menu\.buildFromTemplate|popup|actions\./.test(l)) console.log("  " + l.trim());
}
