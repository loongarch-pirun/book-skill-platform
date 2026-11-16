#!/usr/bin/env node
/**
 * gate-diff.mjs —— 两份 quality-gate 逐题 dump 的对照器
 *
 * 用途：闸门只看聚合值（0.725 → 0.7125），红了也说不清是哪道题。这个脚本把两份
 * `--dump-rows` 的输出逐题比，直接指出「哪一题从 full 掉成 miss」「名次从 3 掉到 5」。
 *
 * 跑法：
 *   node test/gate-diff.mjs <A.rows.json> <B.rows.json>
 *
 * 退出码：0 = 无差异｜1 = 有差异｜2 = 键集不匹配（不是同一份卷子/同一批题）
 */
import fs from "node:fs";

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error("用法：node test/gate-diff.mjs <A.rows.json> <B.rows.json>");
  process.exit(2);
}

const A = JSON.parse(fs.readFileSync(aPath, "utf8"));
const B = JSON.parse(fs.readFileSync(bPath, "utf8"));

// 口径必须一致，否则比的是两份不同的尺子
const same = (k) => A[k] === B[k];
if (!same("topN") || !same("golden") && JSON.stringify(A.golden) !== JSON.stringify(B.golden)) {
  console.error("✗ 两份 dump 口径不一致，拒绝比数：");
  console.error(`  topN   A=${A.topN}  B=${B.topN}`);
  console.error(`  golden A=${JSON.stringify(A.golden)}  B=${JSON.stringify(B.golden)}`);
  process.exit(2);
}

// 白名单字段：只比「用户/判据能感知」的东西。lat 明确忽略（机器负载噪声，
// 把它算进差异会让每次对照都报一堆假阳性）。
const BOOK_FIELDS = ["level", "rank", "hit", "legacyHit", "legacyRank", "dirtyCount", "prodDirtyCount", "nRes"];
const ROUTE_FIELDS = ["level", "rank", "hit", "routeOk", "nRes"];

const keyOf = (r) => `${r.book}::${r.q}`;
const toMap = (rows) => new Map(rows.map((r) => [keyOf(r), r]));

function diffRows(name, aRows, bRows, fields) {
  const A2 = toMap(aRows || []);
  const B2 = toMap(bRows || []);
  const onlyA = [...A2.keys()].filter((k) => !B2.has(k));
  const onlyB = [...B2.keys()].filter((k) => !A2.has(k));
  if (onlyA.length || onlyB.length) {
    console.error(`✗ ${name} 键集不匹配：A 独有 ${onlyA.length} 条 / B 独有 ${onlyB.length} 条`);
    for (const k of onlyA.slice(0, 3)) console.error("   A 独有：" + k);
    for (const k of onlyB.slice(0, 3)) console.error("   B 独有：" + k);
    for (const k of onlyB.slice(0, 3)) console.error("   B 独有：" + k);
    process.exit(2);
  }
  const out = [];
  for (const [k, a] of A2) {
    const b = B2.get(k);
    const changed = fields.filter((f) => a[f] !== b[f]);
    if (changed.length) out.push({ k, a, b, changed });
  }
  return out;
}

const bookDiff = diffRows("按书口径", A.bookRows, B.bookRows, BOOK_FIELDS);
const routeDiff = diffRows("端到端口径", A.routeRows, B.routeRows, ROUTE_FIELDS);

const fmt = (r, f) => (f === "level" ? `${r[f]}` : r[f]);

function report(name, list) {
  console.log(`\n--- ${name}：变化 ${list.length} 题 ---`);
  for (const d of list) {
    const bits = d.changed.map((f) => `${f} ${fmt(d.a, f)} → ${fmt(d.b, f)}`).join(" / ");
    console.log(`  [${d.changed.includes("level") ? "翻转" : "微调"}] ${d.k}`);
    console.log(`      ${bits}`);
  }
}
report("按书口径", bookDiff);
report("端到端口径", routeDiff);

// 汇总：让「少了 1 题」这句话有出处
const cnt = (rows, f) => rows.filter((r) => r[f]).length;
console.log("\n===== 汇总 =====");
console.log(`按书命中  A ${cnt(A.bookRows, "hit")}/${A.bookRows.length}  →  B ${cnt(B.bookRows, "hit")}/${B.bookRows.length}`);
console.log(`路由正确  A ${cnt(A.routeRows, "routeOk")}/${A.routeRows.length}  →  B ${cnt(B.routeRows, "routeOk")}/${B.routeRows.length}`);
console.log(`指标      A ${JSON.stringify(A.metrics)}`);
console.log(`          B ${JSON.stringify(B.metrics)}`);
console.log(`\n（lat 已显式忽略：机器负载噪声，计入会制造假阳性）`);

const total = bookDiff.length + routeDiff.length;
process.exit(total ? 1 : 0);
