// 相似块查询（技能×编目融合 P-E）：给一块原文或一句话，用向量找全书最相似的几块
// 与 hybridSearch 平行的一条独立路：不碰混合检索/复试官/编目信号（检索层零改动），
// 纯 emb 余弦排序——零新模型，两个入口共用同一套打法。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

import { getEmbedder, assertEngine, cosine } from "./models.mjs";

// topN 上限与 MCP 侧一致（模型一次索要 999 条会拖垮上下文）
export const MAX_TOPN = 20;
export const clampTopN = (n) => Math.min(Math.max(1, Math.floor(Number(n) || 5)), MAX_TOPN);

// chunk_id 入口：块→块同库比较，两侧向量都出自灌库时那台引擎，无需引擎校验、无需加载模型
// text 入口：查询向量要现算，必须 assertEngine——引擎不同空间时余弦分是垃圾，宁可不答，不答错
export async function similarChunks(dbPath, { chunkId = null, text = null, topN = 5 } = {}) {
  const n = clampTopN(topN);
  const db = new Database(dbPath, { readonly: true });
  try {
    const cols = db.prepare("PRAGMA table_info(chunks)").all().map(c => c.name);
    if (!cols.includes("emb")) return { error: "no-vectors", hint: "这个书库没有向量列（跑 embed-book 重灌才有）" };

    let src = null;      // 查询侧描述（回给智能体，让它知道比的是谁）
    let srcVec = null;   // 查询向量
    let embedKey = null; // 只在 text 入口有（chunk 入口没有模型参与）

    if (chunkId !== null && chunkId !== undefined && chunkId !== "") {
      const row = db.prepare("SELECT id, chapter, page, text, emb FROM chunks WHERE id = ?").get(Number(chunkId));
      if (!row) return { error: "chunk-not-found", hint: `书里没有块 #${chunkId}（块号来自 query_book 结果的 id）` };
      if (!row.emb) return { error: "chunk-no-vector", hint: `块 #${chunkId} 没有向量——灌库时该块被跳过` };
      src = { chunk: row.id, loc: row.page ? `第${row.page}页` : (row.chapter || ""), chapter: row.chapter || "", page: row.page ?? null };
      srcVec = new Float32Array(row.emb.buffer, row.emb.byteOffset, row.emb.byteLength / 4);
    } else if (text && String(text).trim()) {
      const q = String(text).trim();
      const embed = await getEmbedder();
      assertEngine(db, embed.key);
      const [qv] = await embed.embedQueries([q]);
      src = { text: q };
      srcVec = qv;
      embedKey = embed.key;
    } else {
      return { error: "missing-query", hint: "必须给 chunk_id 或 text 之一——这是以块找块的入口" };
    }

    const rows = db.prepare("SELECT id, chapter, page, text, emb FROM chunks WHERE emb IS NOT NULL").all();
    const out = [];
    for (const r of rows) {
      if (src.chunk !== undefined && r.id === src.chunk) continue; // 自相似排除（最像自己没有意义）
      const v = new Float32Array(r.emb.buffer, r.emb.byteOffset, r.emb.byteLength / 4);
      out.push({
        id: r.id, chapter: r.chapter || "", page: r.page ?? null,
        loc: r.page ? `第${r.page}页` : (r.chapter || ""),
        score: +cosine(srcVec, v).toFixed(4), text: r.text,
      });
    }
    out.sort((a, b) => b.score - a.score);
    return { query: src, embed_model: embedKey, results: out.slice(0, n) };
  } finally {
    db.close();
  }
}
