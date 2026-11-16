#!/usr/bin/env node
/**
 * route-equiv-compare.cjs —— 路由层「开关翻转」等价对照脚本（M0 ③ 草稿）
 *
 * 地位：**草稿，住在工作区，不属 r4**。冻结后由 P1 搬进 r4 的 test/ 并加 package.json 入口。
 * 现在就能跑 `--dry-run` 验脚本本身；真跑需要真书库 + 本地向量/重排模型（本机，不在 CI）。
 *
 * 用途：把 routeAndSearch 在两组 env 下的全量输出拿来做对照。
 *   ① cache 对：BSP_VEC_CACHE_MB=0 vs 200     → 期望「逐位一致」（缓存不许改结果）
 *   ② route 对：无开关 vs BSP_ROUTE=0          → 期望「五元组 + 漏题清单一致」（回滚开关真的回到旧行为）
 *   ③ pool  对：BSP_ROUTE_POOL=48 vs auto      → 只报告差异，不预设一致（池子本来就会变）
 *
 * 范式来源（照抄，不另发明）：
 *   - test/perf-test.mjs:25-42   子进程 spawnSync + env 翻转 + 比 JSON 字符串（现只覆盖 hybridSearch）
 *   - test/ftsliteral-test.mjs:260-270  三段式：关 → 结果不变 + 计数冻结 → 删变量恢复命中
 *
 * 跑法：
 *   node route-equiv-compare.cjs --dry-run
 *   node route-equiv-compare.cjs --pair=cache
 *   node route-equiv-compare.cjs --pair=route --level=loose
 *   node route-equiv-compare.cjs --pair=pool --limit=5
 *   node route-equiv-compare.cjs --pair=cache --out=./raw-20261116
 *   node route-equiv-compare.cjs --qs=./my-questions.txt --env-a=BSP_ROUTE_BOOKS=8 --env-b=BSP_ROUTE_BOOKS=4
 *
 * 退出码：0 = 全部符合预期；1 = 有不符合项；2 = 用法/环境错误（不产生任何结论）
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

// ---------------- 参数解析 ----------------
const argv = process.argv.slice(2);
const arg = (name, fb = null) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fb;
  if (hit === `--${name}`) return true;
  return hit.slice(name.length + 3);
};
const flag = (name) => argv.includes(`--${name}`);

const DRY = flag("dry-run");
const PAIR = String(arg("pair", "cache"));
const LEVEL = String(arg("level", PAIR === "route" ? "loose" : "strict"));
const LIMIT = Number(arg("limit", 0)) || 0;
const OUT_DIR = arg("out", null);
const QS_FILE = arg("qs", null);

const DEFAULT_R4 = "C:/Users/JIANG XIAO HUA/Desktop/book-skill-platform-r4";
const R4 = path.resolve(String(arg("r4", DEFAULT_R4)));
const LIB = path.resolve(String(arg("lib", path.join(R4, "library"))));
const SEARCH_MJS = path.join(R4, "src", "lib", "search.mjs");
const GOLDEN_DIR = path.join(R4, "test", "golden");

const die = (msg) => {
  console.error("用法/环境错误：" + msg);
  process.exit(2);
};

if (!fs.existsSync(SEARCH_MJS)) die(`找不到 ${SEARCH_MJS}；用 --r4=<r4 根目录> 指定`);
if (!fs.existsSync(LIB)) die(`找不到书库 ${LIB}；用 --lib=<书库目录> 指定`);

// ---------------- 三组预置对照 ----------------
const PAIRS = {
  cache: {
    why: "缓存层不许改结果：开/关必须逐位一致",
    a: { BSP_VEC_CACHE_MB: "0" },
    b: { BSP_VEC_CACHE_MB: "200" },
    expect: "identical",
  },
  route: {
    why: "回滚总闸：BSP_ROUTE=0 必须逐字节回到旧三段式全库扫描",
    a: {},
    b: { BSP_ROUTE: "0" },
    expect: "same-five-tuple",
  },
  pool: {
    why: "池子上限：48（旧行为）vs auto（动态配额），只报告差异",
    a: { BSP_ROUTE_POOL: "48" },
    b: { BSP_ROUTE_POOL: "auto" },
    expect: "report",
  },
};

let pairCfg;
if (arg("env-a") || arg("env-b")) {
  const parseEnv = (s) => {
    const o = {};
    for (const kv of String(s).split(",")) {
      if (!kv.trim()) continue;
      const i = kv.indexOf("=");
      if (i < 0) die(`env 片段要 key=value 形式：${kv}`);
      o[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
    return o;
  };
  pairCfg = {
    why: "自定义对照",
    a: parseEnv(arg("env-a", "")),
    b: parseEnv(arg("env-b", "")),
    expect: LEVEL === "strict" ? "identical" : "same-five-tuple",
  };
} else {
  pairCfg = PAIRS[PAIR];
  if (!pairCfg) die(`未知 --pair=${PAIR}，可选：${Object.keys(PAIRS).join(" / ")}`);
}

// ---------------- 题目来源 ----------------
function loadQuestions() {
  if (QS_FILE) {
    const p = path.resolve(QS_FILE);
    if (!fs.existsSync(p)) die(`找不到题目文件 ${p}`);
    const raw = fs.readFileSync(p, "utf8");
    const qs = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    if (!qs.length) die(`${p} 里没有有效题目行`);
    return qs;
  }
  // 缺省：读 test/golden/*.json 的 q 字段（**只读**，不写一个字节）
  if (!fs.existsSync(GOLDEN_DIR)) die(`既没给 --qs，也找不到 ${GOLDEN_DIR}`);
  const files = fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json"));
  const qs = [];
  for (const f of files) {
    let arr;
    try {
      arr = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, f), "utf8"));
    } catch {
      continue;
    }
    const list = Array.isArray(arr) ? arr : Array.isArray(arr.items) ? arr.items : [];
    for (const it of list) {
      const q = typeof it === "string" ? it : it && it.q;
      if (q && !qs.includes(q)) qs.push(String(q));
    }
  }
  if (!qs.length) die(`${GOLDEN_DIR} 里没解析出题目（预期 {q,a,g} 结构）`);
  return qs;
}

let questions = loadQuestions();
if (LIMIT > 0) questions = questions.slice(0, LIMIT);

// ---------------- 子进程：跑一组 env ----------------
const CHILD = `
const mod = await import(${JSON.stringify(pathToFileURL(SEARCH_MJS).href)});
const qs = ${JSON.stringify(questions)};
const libDir = ${JSON.stringify(LIB)};
const out = [];
for (const q of qs) {
  const t0 = Date.now();
  let r = null, err = null;
  try { r = await mod.routeAndSearch(q, { topN: 4, maxBooks: 4, libDir }); }
  catch (e) { err = String((e && e.message) || e); }
  out.push({
    q, ms: Date.now() - t0, err,
    routed: r ? r.routed_books : null,
    considered: r ? r.considered : null,
    results: r ? (r.results || []).map(x => ({ id: x.id, book: x.book, score: x.score })) : null,
    skipped: r ? (r.skipped_books || null) : null,
    ambiguous: r ? !!r.ambiguous : null,
    note: r ? (r.note || null) : null,
  });
}
console.log("OUT " + JSON.stringify(out));
`;

function runWith(envDelta, label) {
  const env = { ...process.env, ...envDelta };
  const t0 = Date.now();
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD], {
    encoding: "utf8",
    env,
    timeout: 1800000,
    maxBuffer: 128 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  const stdout = p.stdout || "";
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("OUT "));
  if (!line) {
    return {
      label,
      ok: false,
      ms,
      err: `子进程没吐 OUT（exit=${p.status} signal=${p.signal}）\nSTDERR:\n${(p.stderr || "").slice(-4000)}`,
      data: null,
    };
  }
  let data;
  try {
    data = JSON.parse(line.slice(4));
  } catch (e) {
    return { label, ok: false, ms, err: "OUT 行不是合法 JSON：" + e.message, data: null };
  }
  return { label, ok: true, ms, err: null, data };
}

// ---------------- 比对 ----------------
const round3 = (x) => (typeof x === "number" ? +Number(x).toFixed(3) : x);

function strictKey(row) {
  // 逐位：id + 书名 + 分数（9 位小数）。不含耗时（ms 天然不同）
  if (!row || !row.results) return { err: row ? row.err : "no-row" };
  return {
    err: row.err,
    routed: (row.routed || []).map((b) => [b.title, b.best_sim]),
    considered: (row.considered || []).map((c) => [c.title, c.best_sim, c.n]),
    results: (row.results || []).map((r) => [r.id, r.book, +Number(r.score).toFixed(9)]),
    skipped: (row.skipped || []).map((s) => [s.title, s.reason]),
    ambiguous: row.ambiguous,
    note: row.note,
  };
}

function looseKey(row) {
  // 五元组 + 漏题清单：书单、答案 id 清单、considered 书名、skip、ambiguous
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
}

const keyFn = LEVEL === "strict" ? strictKey : looseKey;

function diffRows(a, b) {
  const diffs = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ka = JSON.stringify(keyFn(a[i]));
    const kb = JSON.stringify(keyFn(b[i]));
    if (ka !== kb) {
      diffs.push({ idx: i, q: (a[i] || b[i] || {}).q, a: keyFn(a[i]), b: keyFn(b[i]) });
    }
  }
  return diffs;
}

// ---------------- 主流程 ----------------
function describeEnv(o) {
  const ks = Object.keys(o);
  return ks.length ? ks.map((k) => `${k}=${o[k]}`).join(" ") : "(无覆盖，用默认)";
}

console.log("===== route-equiv-compare =====");
console.log("r4        :", R4);
console.log("书库      :", LIB);
console.log("对照      :", PAIR, "—", pairCfg.why);
console.log("A 侧 env  :", describeEnv(pairCfg.a));
console.log("B 侧 env  :", describeEnv(pairCfg.b));
console.log("比对口径  :", LEVEL, LEVEL === "strict" ? "（逐位，含分数 9 位小数）" : "（五元组 + 漏题清单）");
console.log("题量      :", questions.length);
console.log("预期      :", pairCfg.expect);
console.log("模式      :", flag("once") ? "只跑 A 侧（生成改造前 raw 基准，不做对照）" : "A/B 双跑对照");
if (OUT_DIR) console.log("raw 落盘  :", path.resolve(OUT_DIR));

if (DRY) {
  console.log("\n[DRY-RUN] 只检查了路径、题源与参数，没有启动子进程、没跑任何检索。");
  console.log("[DRY-RUN] 真跑需要本机真书库 + 向量/重排模型；CI 里不跑这个脚本。");
  console.log("\n===== 干跑结论：脚本可用 =====");
  process.exit(0);
}

const A = runWith(pairCfg.a, "A");
if (!A.ok) {
  console.error(`\nA 侧失败：${A.err}`);
  process.exit(2);
}
if (flag("once")) {
  console.log(`\n耗时：A ${A.ms}ms（整批）`);
  if (!OUT_DIR) {
    console.error("--once 必须配 --out=<目录>，否则 raw 会随进程消失");
    process.exit(2);
  }
  const dir0 = path.resolve(OUT_DIR);
  fs.mkdirSync(dir0, { recursive: true });
  const stamp0 = new Date().toISOString().replace(/[:.]/g, "-");
  const p0 = path.join(dir0, `raw-${PAIR}-${stamp0}.json`);
  fs.writeFileSync(p0, JSON.stringify(A.data, null, 1));
  console.log("raw 已落盘：" + p0);
  console.log(`\n===== 结论：改造前基准已生成（${A.data.length} 题）=====`);
  process.exit(0);
}

const B = runWith(pairCfg.b, "B");
for (const r of [B]) {
  if (!r.ok) {
    console.error(`\n${r.label} 侧失败：${r.err}`);
    process.exit(2);
  }
}
console.log(`\n耗时：A ${A.ms}ms / B ${B.ms}ms（整批，非单题）`);

if (OUT_DIR) {
  const dir = path.resolve(OUT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(dir, `raw-A-${PAIR}-${stamp}.json`), JSON.stringify(A.data, null, 1));
  fs.writeFileSync(path.join(dir, `raw-B-${PAIR}-${stamp}.json`), JSON.stringify(B.data, null, 1));
  console.log("raw 已落盘两份（P3 差分基准）");
}

const diffs = diffRows(A.data, B.data);

let pass;
if (pairCfg.expect === "identical") pass = diffs.length === 0;
else if (pairCfg.expect === "same-five-tuple") pass = diffs.length === 0;
else pass = true; // report 模式只报告

if (!diffs.length) {
  console.log(`\nPASS - 两侧 ${LEVEL} 口径完全一致（${questions.length} 题）`);
} else {
  console.log(`\n${pass ? "INFO" : "FAIL"} - ${diffs.length}/${questions.length} 题存在差异`);
  for (const d of diffs.slice(0, 5)) {
    console.log(`\n--- 第 ${d.idx + 1} 题：${d.q}`);
    console.log("  A:", JSON.stringify(d.a));
    console.log("  B:", JSON.stringify(d.b));
  }
  if (diffs.length > 5) console.log(`\n（其余 ${diffs.length - 5} 题略，用 --out 落盘后逐条看）`);
}

console.log(`\n===== 结论：${pass ? "符合预期" : "不符合预期"} =====`);
process.exit(pass ? 0 : 1);
