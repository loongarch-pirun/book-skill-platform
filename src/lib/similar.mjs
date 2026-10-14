// 相似块查询（技能×编目融合 P-E）：给一块原文或一句话，用向量找全书最相似的几块
// 与 hybridSearch 平行的一条独立路：不碰混合检索/复试官/编目信号（检索层零改动），
// 纯 emb 余弦排序——零新模型，两个入口共用同一套打法。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

import { getEmbedder, assertEngine, cosine } from "./models.mjs";

// topN 上限与 MCP 侧一致（模型一次索要 999 条会拖垮上下文）
export const MAX_TOPN = 20;
// V2-D17（暴力测试 P3 修）：默认值与 register-tools 的 clampTopN 对齐为 4——老逻辑
// 这里是 5，MCP 路径被外层先夹成 4 还看不太出来，直接调 lib 的调用方（测试/脚本）
// 会拿到与 TOPN_SCHEMA 描述（"默认 4"）不一致的行为。两份同语义夹取器不许漂移。
export const clampTopN = (n) => Math.min(Math.max(1, Math.floor(Number(n) || 4)), MAX_TOPN);

// chunk_id 入口：块→块同库比较，两侧向量都出自灌库时那台引擎，无需引擎校验、无需加载模型
// text 入口：查询向量要现算，必须 assertEngine——引擎不同空间时余弦分是垃圾，宁可不答，不答错
export async function similarChunks(dbPath, { chunkId = null, text = null, topN = 4 } = {}) {
  const n = clampTopN(topN);
  // V2-D29（暴力测试 P3 修，D06/D-11 家族复发）：坏库的失败形态是「new Database 打开
  // 不抛、首次 prepare 才抛 SQLITE_NOTADB」——打开放 try 外层会裸崩英文堆栈。
  // 与 catalog-skill.mjs 的 generateSkillScaffold 同款双重兜底。
  let db;
  try { db = new Database(dbPath, { readonly: true }); }
  catch { return { error: "db-broken", hint: "书库文件损坏或无法打开——重新导入这本书" }; }
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
      // V2-D05（暴力测试 P3 修）：assertEngine 是 throw，而本函数其余失败路径全 return
      // {error}——MCP handler 无 catch，引擎不一致时裸抛穿层，智能体拿到的是 SDK 包的
      // "Error: Error: 引擎不一致…" 而不是结构化 error（错误契约分裂）。转结构化。
      try { assertEngine(db, embed.key); }
      catch (e) { return { error: "engine-mismatch", hint: e.message }; }
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
  } catch (e) {
    // V2-D29：PRAGMA/SELECT 阶段的 SqliteError（坏库/缺 chunks 表）转人话结构化 error；
    // 非 SQL 错误是真 bug（模型加载失败等），原样抛出不留案底
    if (e?.name === "SqliteError" || String(e?.code || "").startsWith("SQLITE_"))
      return { error: "db-broken", hint: "书库结构不完整或无法读取——重新导入这本书" };
    throw e;
  } finally {
    db.close();
  }
}
