// 性能验收：向量矩阵缓存（正确性等价 + 真实规模持平 + 大库规模提速）+ 路由质心预筛
// 跑法: node test/perf-test.mjs
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const Database = require("better-sqlite3");

import { hybridSearch, routeAndSearch, cosine } from "../src/lib/search.mjs";
import { getMatrix, matrixScores, clearVecCache, vecCacheStats } from "../src/lib/vec-cache.mjs";

const LIB = path.join(__dirname, "..", "library");
const PP = path.join(LIB, "pride-and-prejudice-en.epub.db");
let failed = 0;
const assert = (cond, msg, extra = "") => {
  console.log((cond ? "PASS" : "FAIL") + " - " + msg + (cond ? "" : ` ${extra}`));
  if (!cond) failed++;
};
const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

// ---- 缓存关 vs 开：检索结果必须逐位一致（子进程对照，互不污染缓存）----
const runOne = (cacheMb) => {
  const script = `
    const { hybridSearch } = await import(${JSON.stringify("file:///" + path.join(__dirname, "..", "src", "lib", "search.mjs").replace(/\\\\/g, "/"))});
    const rs = await hybridSearch(${JSON.stringify(PP)}, "who tries to separate jane and bingley", 4, { rerank: false });
    console.log("FP " + JSON.stringify(rs.map(r => [r.id, r.text.length, +r.score.toFixed(9)])));
  `;
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", script],
    { encoding: "utf8", env: { ...process.env, BSP_VEC_CACHE_MB: String(cacheMb) }, timeout: 180000 });
  const line = (p.stdout || "").split(/\r?\n/).find(l => l.startsWith("FP "));
  return line ? JSON.parse(line.slice(3)) : null;
};
{
  const off = runOne(0);
  const on = runOne(200);
  assert(off && on && JSON.stringify(off) === JSON.stringify(on),
    "等价性: 缓存开/关的 top-4 结果逐位一致", JSON.stringify({ off, on }));
}

// ---- 缓存激活与命中（本进程显式打开）----
{
  process.env.BSP_VEC_CACHE_MB = "200";
  clearVecCache();
  await hybridSearch(PP, "governor", 3, { rerank: false });   // 冷：建缓存
  const s1 = vecCacheStats();
  await hybridSearch(PP, "governor", 3, { rerank: false });   // 暖：命中
  const s2 = vecCacheStats();
  assert(s1.entries === 1 && s1.mb > 1 && s2.entries === 1 && s2.mb === s1.mb,
    `缓存: 建立 1 条目 ${s1.mb}MB 且暖查询命中不扩容`);
}

// ---- 真实 6 书规模：只报告，不断言（实测持平，缓存的主场不在这）----
{
  const q = "who tries to separate jane and bingley";
  const bench = async () => {
    clearVecCache();
    const times = [];
    for (let i = 0; i < 4; i++) {
      const t0 = Date.now();
      await hybridSearch(PP, q, 4, { rerank: false });
      times.push(Date.now() - t0);
    }
    return median(times.slice(1));
  };
  const offMs = await bench();
  const onMs = await bench();
  console.log(`  (真实规模 P&P 2210 块: 缓存关 ${offMs}ms vs 开 ${onMs}ms —— 持平，符合预期)`);
  process.env.BSP_VEC_CACHE_MB = "0";
  clearVecCache();
}

// ---- 大库规模：合成 2 万块库实测缓存收益（本节显式开缓存）----
{
  process.env.BSP_VEC_CACHE_MB = "200";
  clearVecCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-scale-"));
  const dbPath = path.join(tmp, "big.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT NOT NULL, emb BLOB);");
  db.prepare("INSERT INTO meta VALUES('model','e5')").run();
  const DIM = 384, N = 20000;
  const base = new Float32Array(DIM);
  for (let j = 0; j < DIM; j++) base[j] = Math.random() - 0.5;
  const ins = db.prepare("INSERT INTO chunks(id, text, emb) VALUES (?, ?, ?)");
  db.transaction(() => {
    for (let i = 1; i <= N; i++) {
      const v = new Float32Array(base);
      v[i % DIM] += 0.01 * (i % 7);
      ins.run(i, `chunk ${i}`, Buffer.from(v.buffer));
    }
  })();
  const qv = new Float32Array(DIM);
  for (let j = 0; j < DIM; j++) qv[j] = Math.random() - 0.5;

  const oldPath = () => {  // 旧路径：每查询全表读 BLOB + 建视图 + 点积
    const rows = db.prepare("SELECT id, emb FROM chunks WHERE emb IS NOT NULL").all();
    const s = new Map();
    for (const r of rows) {
      const v = new Float32Array(r.emb.buffer, r.emb.byteOffset, r.emb.byteLength / 4);
      s.set(r.id, cosine(qv, v));
    }
    return s.size;
  };
  const timesOld = [];
  for (let i = 0; i < 3; i++) { const t0 = Date.now(); oldPath(); timesOld.push(Date.now() - t0); }
  const mat = getMatrix(db, dbPath, "e5");   // 建缓存（一次性成本，不计入暖比较）
  const timesNew = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const s = new Map();
    matrixScores(mat, qv, s);
    timesNew.push(Date.now() - t0);
  }
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env.BSP_VEC_CACHE_MB = "0";
  clearVecCache();
  const oldMs = median(timesOld), newMs = median(timesNew);
  assert(newMs < oldMs, `大库提速: 2 万块库 语义打分 缓存开 ${newMs}ms < 关 ${oldMs}ms（每次查询免重读 ${Math.round(mat.bytes / 1048576)}MB BLOB）`);
}

// ---- 路由质心预筛路径（伪造 >8 本书触发第二遍粗筛）----
{
  const libDir = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-perf-"));
  for (let i = 0; i < 10; i++) fs.copyFileSync(path.join(LIB, "lunyu-xueer-zh.docx.db"), path.join(libDir, `copy${i}.db`));
  const out = await routeAndSearch("学习之后经常温习会怎么样", { libDir, topN: 3 });
  assert(out.routed_books.length >= 1 && out.results.length > 0,
    `预筛: 10 本书触发粗筛路径且正常出结果（routed=${out.routed_books.length}）`);
  fs.rmSync(libDir, { recursive: true, force: true });
}

console.log("\n===== 性能验收结果 =====");
if (failed) { console.log(`有 ${failed} 项 FAIL`); process.exit(1); }
console.log("全部 PASS");
