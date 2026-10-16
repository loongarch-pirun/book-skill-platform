// 洗数据信号（V3 第三波-①）：标签 / 假设问题 / 摘要 → 检索提名信号
// 定位：「镜像 loadCatalogSignal」的第四路信号——只读不写库，失败/无数据一律静默返回空。
// 数据面（enrich-import 灌入）：chunk_tags 倒排 / chunks.questions(JSON 数组) / summaries(scope='chunk')
// 匹配：复用 questionKeywords（与字面腿同一把词盘：en ≥3 字实义词 + cjk 简繁双形 2-gram）
// 权重（v1，实验可调）：tag 0.4 / question 0.25 / summary 0.12，同源每多中一词 +0.1（封顶 +0.3），
//   跨源求和封顶 1（镜像 catalog add()）；弱信号由 search.mjs 的 0.15 地板统一过滤
//   （单摘要命中 0.12 < 0.15 → 自动被地板丢弃——最弱源单独出现不配提名）
// 噪声对策：标签级 df 过滤（>30% 块出现的标签丢弃，计划风险表）+ 关键词 df 过滤
//   （问题/摘要里 df > max(5% 块数, 4) 的白话词丢弃——与字面腿 cjkLikeScores 同口径）
import { questionKeywords } from "./keywords.mjs";

const W_TAG = 0.4, W_Q = 0.25, W_SUM = 0.12;
const contrib = (base, n) => (n > 0 ? Math.min(base + 0.1 * (n - 1), base + 0.3) : 0);

export function loadEnrichSignal(db, q) {
  const hit = new Map(); // chunkId -> { w, tag }
  const add = (id, w, tag) => {
    if (!(w > 0)) return;
    const prev = hit.get(id);
    if (!prev) hit.set(id, { w: Math.min(1, w), tag });
    else hit.set(id, { w: Math.min(1, prev.w + w), tag: prev.tag.includes(tag) ? prev.tag : prev.tag + "+" + tag });
  };
  try {
    const s = String(q || "");
    if (!s) return { hit };
    // 数据面探测：没洗过数据的库直接退出（与未接线行为零变化）
    const cols = db.prepare("PRAGMA table_info(chunks)").all().map((c) => c.name);
    if (!cols.includes("tags") || !cols.includes("questions")) return { hit };
    const kws = questionKeywords(s);
    const uniq = [...new Set([...kws.en, ...kws.cjk])];
    if (!uniq.length) return { hit };
    const total = db.prepare("SELECT COUNT(*) n FROM chunks").get().n || 1;
    const kwCap = Math.max(0.05 * total, 4); // 关键词 df 上限（与字面腿同口径）
    const countHits = (text, words) => {
      const t = String(text || "").toLowerCase();
      if (!t) return 0;
      let n = 0;
      for (const w of words) if (t.includes(w)) n++;
      return n;
    };

    // ---------- ① 标签路：chunk_tags 倒排（标签=原文 2~6 字片段，命中最精准） ----------
    let tagRows = [];
    try { tagRows = db.prepare("SELECT tag, chunk_id FROM chunk_tags").all(); } catch { tagRows = []; }
    if (tagRows.length) {
      const tagDf = new Map();
      for (const r of tagRows) tagDf.set(r.tag, (tagDf.get(r.tag) || 0) + 1);
      const usable = tagRows.filter((r) => (tagDf.get(r.tag) || 0) <= total * 0.3);
      for (const r of usable) add(r.chunk_id, contrib(W_TAG, countHits(r.tag, uniq)), "tag");
    }

    // ---------- ② 问题路：chunks.questions（模型假设问题，逐块 JSON 数组） ----------
    let qRows = [];
    try { qRows = db.prepare("SELECT id, questions FROM chunks WHERE questions IS NOT NULL").all(); } catch { qRows = []; }
    if (qRows.length) {
      const texts = qRows.map((r) => {
        try { const arr = JSON.parse(r.questions); return Array.isArray(arr) ? arr.join(" \n ") : String(r.questions); }
        catch { return String(r.questions); }
      });
      // 关键词 df 过滤：问题里高频出现的白话词不配计分
      const qKeep = uniq.filter((w) => texts.reduce((n, t) => n + (t.toLowerCase().includes(w) ? 1 : 0), 0) <= kwCap);
      if (qKeep.length)
        qRows.forEach((r, i) => add(r.id, contrib(W_Q, countHits(texts[i], qKeep)), "question"));
    }

    // ---------- ③ 摘要路：summaries scope='chunk'（ref=String(chunkId)） ----------
    let sRows = [];
    try { sRows = db.prepare("SELECT ref, summary FROM summaries WHERE scope='chunk'").all(); } catch { sRows = []; }
    if (sRows.length) {
      const sKeep = uniq.filter((w) => sRows.reduce((n, r) => n + (String(r.summary).toLowerCase().includes(w) ? 1 : 0), 0) <= kwCap);
      if (sKeep.length)
        for (const r of sRows) add(+r.ref, contrib(W_SUM, countHits(r.summary, sKeep)), "summary");
    }
  } catch { /* 未洗数据/表缺/坏数据 → 静默跳过（与 loadCatalogSignal 同哲学） */ }
  return { hit };
}
