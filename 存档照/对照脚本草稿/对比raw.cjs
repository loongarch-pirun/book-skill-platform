#!/usr/bin/env node
/**
 * 对比两份 raw（五元组 + 漏题清单口径）
 * 跑法：node 对比raw.cjs <旧raw.json> <新raw.json>
 *
 * 用来回答一个问题：`BSP_ROUTE=0` 到底有没有逐题回到改造前的行为。
 * 不比 rerank 浮点与耗时（服务端时间戳天然不同），只比用户能看到的东西：
 *   挑书清单 / considered 书名集合 / 答案 id 序列 / 答案来自哪几本 / 跳过清单 / ambiguous
 */
"use strict";
const fs = require("node:fs");

const [, , oldP, newP] = process.argv;
if (!oldP || !newP) {
  console.error("用法：node 对比raw.cjs <旧raw.json> <新raw.json>");
  process.exit(2);
}
const A = JSON.parse(fs.readFileSync(oldP, "utf8"));
const B = JSON.parse(fs.readFileSync(newP, "utf8"));
if (!Array.isArray(A) || !Array.isArray(B)) {
  console.error("两份 raw 都应是数组");
  process.exit(2);
}

const key = (row) => {
  if (!row || !row.results) return { err: row ? row.err : "no-row" };
  return {
    err: row.err,
    routedTitles: (row.routed || []).map((b) => b.title),
    consideredTitles: (row.considered || []).map((c) => c.title).sort(),
    resultIds: (row.results || []).map((r) => r.id),
    resultBooks: [...new Set((row.results || []).map((r) => r.book))].sort(),
    skippedTitles: (row.skipped || []).map((s) => s.title).sort(),
    ambiguous: !!row.ambiguous,
  };
};

const byQ = new Map(B.map((r) => [r.q, r]));
const diffs = [];
for (const a of A) {
  const b = byQ.get(a.q);
  if (!b) { diffs.push({ q: a.q, why: "新 raw 里没有这道题" }); continue; }
  const ka = JSON.stringify(key(a));
  const kb = JSON.stringify(key(b));
  if (ka !== kb) diffs.push({ q: a.q, old: key(a), new: key(b) });
}

console.log("旧 raw :", oldP, `(${A.length} 题)`);
console.log("新 raw :", newP, `(${B.length} 题)`);
console.log("");
if (!diffs.length) {
  console.log(`PASS - 两边的五元组 + 漏题清单逐题一致（${A.length} 题）`);
  process.exit(0);
}
console.log(`FAIL - ${diffs.length}/${A.length} 题存在差异`);
for (const d of diffs.slice(0, 8)) {
  console.log("\n--- " + d.q);
  console.log("  旧:", JSON.stringify(d.old ?? d.why));
  console.log("  新:", JSON.stringify(d.new ?? ""));
}
if (diffs.length > 8) console.log(`\n（其余 ${diffs.length - 8} 题略）`);
process.exit(1);
