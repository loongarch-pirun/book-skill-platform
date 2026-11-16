// test/holdout-run.mjs —— 留出集（独立卷子）跑分器
//
// 为什么单独一支：quality-gate.mjs 的 80 题是**同源**卷子（题、答案、金词都取自同一批库的
// 已知答案），拿它证明「改造有效」等于自己批自己的卷子。留出集是独立出的 30 题，
// 只用来回答一个问题：**改完之后到底有没有变好**。
//
// 与本文件的硬规矩：
//   1. 只读 test/holdout/sets/*.json，**一个字节都不写回卷子**；
//   2. 跑前校验 sha256 与 frozen.json 一致，卷子被人动过就当场退出；
//   3. 不 import 任何 test/golden 相关的东西（两套基线严格隔离，guard-test 有静态断言）。
//
// 跑法：
//   node test/holdout-run.mjs                 # 跑一遍，打印汇总
//   node test/holdout-run.mjs --limit=5       # 先跑 5 题看通路
//   node test/holdout-run.mjs --only=refusal  # 只跑某一类
//   node test/holdout-run.mjs --out=run.json  # 落逐题明细
//   node test/holdout-run.mjs --update-baseline   # 写 test/holdout/baseline.json
//   node test/holdout-run.mjs --gate          # 有基线时比对，退步则 exit 1
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { routeAndSearch } from "../src/lib/search.mjs";
import { judge } from "./lib/judge.mjs";

const HERE = import.meta.dirname;
const HOLD = path.join(HERE, "holdout");

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const hit = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return d;
  return hit === `--${n}` ? true : hit.slice(n.length + 3);
};
const flag = (n) => argv.includes(`--${n}`);

// 卷子选择：默认 v1（冻结执行卷）；--set=holdout-v2 跑第二轮独立卷。
// 两卷各有自己的 frozen 凭证与基线，互不覆盖（基线文件按 setId 后缀区分）。
const SET_ID = String(arg("set", "holdout-v1"));
const SUFFIX = SET_ID.replace(/^holdout-/, "");
const FROZEN_PATH = SUFFIX === "v1" ? path.join(HOLD, "frozen.json") : path.join(HOLD, `frozen-${SUFFIX}.json`);
const BASELINE_PATH = SUFFIX === "v1" ? path.join(HOLD, "baseline.json") : path.join(HOLD, `baseline-${SUFFIX}.json`);

const LIMIT = Number(arg("limit", 0)) || 0;
const ONLY = arg("only", null);
const OUT = arg("out", null);

// ---------- 0) 卷子完整性 ----------
if (!fs.existsSync(FROZEN_PATH)) {
  console.error(`缺少 ${FROZEN_PATH}：卷子还没冻结，不许跑。`);
  process.exit(2);
}
const frozen = JSON.parse(fs.readFileSync(FROZEN_PATH, "utf8"));
const SET_PATH = path.join(HERE, "..", frozen.file);
if (!fs.existsSync(SET_PATH)) {
  console.error(`卷子文件不存在：${SET_PATH}`);
  process.exit(2);
}
const raw = fs.readFileSync(SET_PATH);
const sha = crypto.createHash("sha256").update(raw).digest("hex");
if (sha !== frozen.sha256) {
  console.error("卷子被改过，拒绝跑分。");
  console.error("  frozen.sha256 =", frozen.sha256);
  console.error("  实际 sha256   =", sha);
  console.error("  规矩：改题必须新开 setId，不许偷偷改这 30 题。");
  process.exit(2);
}
const set = JSON.parse(raw.toString("utf8"));

let items = set.items ?? [];
if (ONLY) items = items.filter((x) => x.kind === ONLY);
if (LIMIT > 0) items = items.slice(0, LIMIT);
if (!items.length) {
  console.error("没有可跑的题（--only / --limit 过滤后为空）");
  process.exit(2);
}

// ---------- 1) 逐题跑 ----------
console.log("===== 留出集跑分 =====");
console.log("卷子   :", frozen.file, `(${SET_ID})`);
console.log("sha256 :", frozen.sha256.slice(0, 16) + "…", `(${frozen.total} 题 / 冻结于 ${frozen.frozenAt})`);
console.log("本次跑 :", items.length, "题", ONLY ? `（只跑 ${ONLY}）` : "");
console.log("");

const rows = [];
for (const it of items) {
  const t0 = Date.now();
  let out = null, err = null;
  try {
    out = await routeAndSearch(it.q, { topN: 5, maxBooks: 4 });
  } catch (e) {
    err = String(e?.message || e);
  }
  const ms = Date.now() - t0;
  const results = out?.results ?? [];
  const routed = out?.routed_books ?? [];
  const texts = results.map((r) => String(r.text ?? ""));

  let pass = false, detail, bookOk = null;

  if (err) {
    detail = "检索抛错：" + err;
  } else if (it.kind === "answerable" || it.kind === "newbook") {
    const v = judge(results, { a: it.a, g: it.g });
    pass = v.level !== "miss";
    detail = `判分 ${v.level}${v.rank ? ` @${v.rank}` : ""}${v.why ? "（" + v.why + "）" : ""}`;
    if (it.book) {
      bookOk = routed.some((b) => b.title === it.book || b.id === it.bookId);
      detail += bookOk ? "｜挑书命中本尊" : "｜挑书未命中本尊";
    }
  } else if (it.kind === "refusal") {
    const absent = it.absent ?? [];
    const bad = [];
    for (const t of absent) {
      const idx = texts.findIndex((x) => x.includes(t));
      if (idx >= 0) bad.push(`${t}@第${idx + 1}条(${results[idx].book})`);
    }
    pass = bad.length === 0 && !err;
    detail = bad.length ? "串词作答：" + bad.join(" , ") : `未出现 ${absent.join("/")}，正确拒答`;
  } else if (it.kind === "ambiguous") {
    pass = out?.ambiguous === true || routed.length >= 2;
    detail = `ambiguous=${out?.ambiguous === true}｜routed=${routed.length} 本`;
  } else {
    detail = `未知题型 ${it.kind}`;
  }

  const row = {
    id: it.id, kind: it.kind, lang: it.lang, q: it.q,
    book: it.book ?? null,
    pass, detail, ms,
    routed: routed.map((b) => `${b.title}(${b.best_sim})`),
    resultIds: results.map((r) => r.id),
    resultBooks: [...new Set(results.map((r) => r.book))],
    bookOk,
    err,
  };
  rows.push(row);
  console.log(
    `${pass ? "PASS" : "FAIL"} - ${row.id} [${row.kind}/${row.lang}] ${ms}ms  ${row.q.slice(0, 42)}`
  );
  console.log(`         ${detail}`);
}

// ---------- 2) 汇总 ----------
const byKind = {};
for (const r of rows) {
  byKind[r.kind] ??= { total: 0, pass: 0 };
  byKind[r.kind].total++;
  if (r.pass) byKind[r.kind].pass++;
}
for (const k of Object.keys(byKind)) {
  byKind[k].rate = +(byKind[k].pass / byKind[k].total).toFixed(4);
}

const answerableRows = rows.filter((r) => r.kind === "answerable" || r.kind === "newbook");
const bookHit = answerableRows.filter((r) => r.bookOk === true).length;
const summary = {
  setId: set.setId,
  ranAt: new Date().toISOString(),
  sha256: frozen.sha256,
  total: rows.length,
  pass: rows.filter((r) => r.pass).length,
  passRate: +(rows.filter((r) => r.pass).length / rows.length).toFixed(4),
  byKind,
  bookPickHit: bookHit,
  bookPickTotal: answerableRows.length,
  bookPickRate: answerableRows.length ? +(bookHit / answerableRows.length).toFixed(4) : 0,
  avgMs: +(rows.reduce((s, r) => s + r.ms, 0) / rows.length).toFixed(0),
  missList: rows.filter((r) => !r.pass).map((r) => `${r.id}[${r.kind}] ${r.q.slice(0, 50)} → ${r.detail}`),
};

console.log("\n===== 汇总 =====");
console.log(`总通过 : ${summary.pass}/${summary.total} = ${(summary.passRate * 100).toFixed(1)}%`);
for (const [k, v] of Object.entries(byKind)) {
  console.log(`  ${k.padEnd(11)} ${v.pass}/${v.total} = ${(v.rate * 100).toFixed(1)}%`);
}
console.log(`挑书命中 : ${summary.bookPickHit}/${summary.bookPickTotal} = ${(summary.bookPickRate * 100).toFixed(1)}%（可答题型，路由是否挑对本尊）`);
console.log(`平均耗时 : ${summary.avgMs}ms/题`);
if (summary.missList.length) {
  console.log("\n未通过清单：");
  for (const m of summary.missList) console.log("  - " + m);
}

if (OUT) {
  fs.writeFileSync(path.resolve(String(OUT)), JSON.stringify({ summary, rows }, null, 1));
  console.log("\n逐题明细已写：" + path.resolve(String(OUT)));
}

if (flag("update-baseline")) {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify({
    note: "留出集独立基线。与 test/quality-baseline.json 严格分离，两者不得互相引用。",
    setId: summary.setId,
    sha256: summary.sha256,
    updatedAt: summary.ranAt,
    passRate: summary.passRate,
    byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v.rate])),
    bookPickRate: summary.bookPickRate,
    avgMs: summary.avgMs,
  }, null, 1) + "\n");
  console.log("基线已更新：" + BASELINE_PATH);
}

// ---------- 3) 门禁比对 ----------
if (flag("gate")) {
  if (LIMIT > 0 || ONLY) {
    console.log("\n本次是抽样跑（--limit / --only），--gate 跳过：门禁只对整卷有意义");
  } else if (!fs.existsSync(BASELINE_PATH)) {
    console.log("\n没有基线，--gate 跳过（先跑一次 --update-baseline）");
  } else {
    const base = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    const bad = [];
    if (base.sha256 && base.sha256 !== summary.sha256) bad.push("卷子指纹与基线不一致（换卷了，要新开基线）");
    if (summary.passRate < base.passRate) bad.push(`总通过率 ${summary.passRate} < 基线 ${base.passRate}`);
    for (const [k, v] of Object.entries(base.byKind ?? {})) {
      const now = byKind[k]?.rate ?? 0;
      if (now < v) bad.push(`${k} ${now} < 基线 ${v}`);
    }
    if (bad.length) {
      console.error("\n===== 门禁未通过 =====");
      for (const b of bad) console.error("  - " + b);
      process.exit(1);
    }
    console.log("\n===== 门禁通过（不低于基线）=====");
  }
}
