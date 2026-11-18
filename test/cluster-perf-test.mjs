// 问题6（建库 O(n²)）：greedyCluster 邻接表原为全量两两比。改 IVF 近邻桶（同桶+最近两邻桶）
// 后必须满足：① 近邻召回足够（边数/暴力 >= 0.8，近似近邻允许漏远桶边）；② 真省算力——
// dim 维点积次数 < 全量一半；③ 聚类质量门（effective/coverage）不退化。
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { greedyCluster, clusterChunks } = await import("../src/lib/catalog.mjs");

const DIM = 64, N = 900;
// 8 个话题中心 + 噪声 → 有结构但分散，滑窗应明显小于全量
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const unit = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map(x => x / n); };
const centers = Array.from({ length: 8 }, () => unit(Array.from({ length: DIM }, () => rnd() - 0.5)));
const vecs = Array.from({ length: N }, (_, i) => {
  const c = centers[i % 8];
  return unit(c.map(x => x + (rnd() - 0.5) * 0.6));
});
const cos = (a, b) => { let s = 0; for (let d = 0; d < DIM; d++) s += a[d] * b[d]; return s; };
// greedyCluster 内部先「去均值再归一」再算 cos——暴力对照必须用同一套 centered 向量，
// 否则参考系不同、边数天然不等（不是剪枝漏边）。
const mean = Array.from({ length: DIM }, (_, d) => vecs.reduce((a, v) => a + v[d], 0) / N);
const centered = vecs.map(v => unit(v.map((x, d) => x - mean[d])));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "clust-"));
const dbPath = path.join(TMP, "c.db");
const db = new Database(dbPath);
db.exec("CREATE TABLE chunks (id INTEGER PRIMARY KEY, chapter TEXT, emb BLOB)");
const ins = db.prepare("INSERT INTO chunks (id, chapter, emb) VALUES (?,?,?)");
vecs.forEach((v, i) => ins.run(i + 1, "ch" + (i % 8), Buffer.from(new Float32Array(v).buffer)));
const rows = db.prepare("SELECT id, chapter, emb FROM chunks WHERE emb IS NOT NULL ORDER BY id").all();

// 暴力参考边数（独立 O(n²)，只作对照）
let brute = 0;
for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) if (cos(centered[i], centered[j]) >= 0.30) brute++;

const t0 = Date.now();
const res = greedyCluster(rows, 0.38, 5);
const ms = Date.now() - t0;

assert.ok(res.edges / brute >= 0.8, `近邻召回：剪枝边数 ${res.edges} / 暴力 ${brute} >= 0.8（近似近邻允许漏远桶边）`);
assert.ok(res.comparisons < (N * (N - 1)) / 2 * 0.5, `真省算力：点积 ${res.comparisons} < 全量一半 ${(N * (N - 1)) / 4}`);
assert.ok(res.effective >= 3 && res.coverage >= 0.5, `质量门不退化：effective=${res.effective} coverage=${res.coverage}`);
assert.ok(ms < 3000, `性能：${ms}ms < 3000ms`);
db.close();

// 真书（孟子 274 块 / 1024 维）：clusterChunks 覆盖率门仍过
const real = "C:/Users/JIANG XIAO HUA/Desktop/book-skill-platform-r4/library/mengzi-zh.docx.db";
if (fs.existsSync(real)) {
  const rdb = new Database(real, { readonly: true });
  const out = clusterChunks(rdb);
  rdb.close();
  assert.ok(out.covered / out.total >= 0.5, `真书覆盖率门：${out.covered}/${out.total} method=${out.method}`);
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`cluster-perf-test: PASS (edges=${res.edges} comparisons=${res.comparisons} ms=${ms})`);