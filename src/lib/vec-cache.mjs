// 向量矩阵缓存：把每个库的向量 BLOB 一次性读成 Float32 矩阵，查询时逐行点积
// 适用规模：**大书库**。每次查询都要把库里全部向量 BLOB 读一遍（旧路径 new Float32Array
// 是零拷贝视图，BLOB 本身的读取/分配才是成本）——6 本书 ≈ 8MB 无感；书多了（几十本、
// 几十 MB 向量）每查询重复读库成为大头，缓存把"每次读库"变成"启动后只读一次"。
// 实测（test/perf-test.mjs）：6 本书规模开/关耗时持平（24 vs 28ms，噪声级）；
// 合成 2 万块库（~30MB 向量）关闭 ~70ms/查询，开启 ~12ms/查询。
//
// 因此默认**关闭**（BSP_VEC_CACHE_MB=0）。书库变大、查询变慢时再开：BSP_VEC_CACHE_MB=200。
//
// 失效三闸：文件 mtime/size 变化（重灌）、引擎 key 变化（BSP_EMBED_MODEL）、LRU 容量逐出。
//
// M2 记录（不改规则）：e5 分数分布挤在高段（0.7~0.9），曾考虑压缩映射拉开梯度——
// 实测归一化后各腿分数混合良好，无梯度问题，仅在此存档，不做任何分数变换。

import fs from "node:fs";

const cache = new Map();   // dbPath -> { ids, matrix, dim, n, engine, mtimeMs, size, bytes, atime, centroid }
let totalBytes = 0;

const maxBytes = () => (+(process.env.BSP_VEC_CACHE_MB ?? 0)) * 1048576;

// 取矩阵（自动失效/建缓存）；返回 null = 缓存关闭或库无向量，调用方走旧逐行路径
export function getMatrix(db, dbPath, embedKey) {
  const cap = maxBytes();
  if (cap <= 0) { cache.clear(); totalBytes = 0; return null; }
  let st;
  try { st = fs.statSync(dbPath); } catch { return null; }
  const ent = cache.get(dbPath);
  if (ent && ent.engine === embedKey && ent.mtimeMs === st.mtimeMs && ent.size === st.size) {
    ent.atime = Date.now();
    return ent;
  }
  if (ent) { totalBytes -= ent.bytes; cache.delete(dbPath); }

  const rows = db.prepare("SELECT id, emb FROM chunks WHERE emb IS NOT NULL").all();
  if (!rows.length) return null;
  const dim = rows[0].emb.byteLength / 4;
  const n = rows.length;
  const ids = new Float64Array(n);
  const matrix = new Float32Array(n * dim);
  const centroid = new Float32Array(dim);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    ids[i] = r.id;
    const v = new Float32Array(r.emb.buffer, r.emb.byteOffset, r.emb.byteLength / 4);
    matrix.set(v, i * dim);
    for (let j = 0; j < dim; j++) centroid[j] += v[j] / n;
  }
  const bytes = matrix.byteLength + ids.byteLength;
  while (totalBytes + bytes > cap && cache.size) {
    let oldest = null;
    for (const [k, v] of cache) if (!oldest || v.atime < oldest[1].atime) oldest = [k, v];
    totalBytes -= oldest[1].bytes;
    cache.delete(oldest[0]);
  }
  const entry = { ids, matrix, dim, n, engine: embedKey, mtimeMs: st.mtimeMs, size: st.size, bytes, atime: Date.now(), centroid };
  cache.set(dbPath, entry);
  totalBytes += bytes;
  return entry;
}

// 矩阵逐行点积（向量已归一化 → 点积即余弦，与旧路径逐位一致）
export function matrixScores(mat, qv, scores) {
  for (let i = 0; i < mat.n; i++) {
    let d = 0;
    const off = i * mat.dim;
    for (let j = 0; j < mat.dim; j++) d += qv[j] * mat.matrix[off + j];
    scores.set(mat.ids[i], d);
  }
}

export function clearVecCache() { cache.clear(); totalBytes = 0; }
export function vecCacheStats() { return { entries: cache.size, mb: +(totalBytes / 1048576).toFixed(1) }; }
