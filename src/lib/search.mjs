// 检索核心库：书库清单 / 混合检索（含复试官重排序）/ 动态挑书路由
// 被 query-book.js（CLI）、mcp-server.mjs（MCP skill）共用
// 模型统一从 models.mjs 拿（换引擎只改那一个文件）
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

import { getEmbedder, getReranker, cosine } from "./models.mjs";
import { loadCatalogSignal } from "./catalog.mjs";
export { getEmbedder, cosine };

const LIB_DIR = path.join(import.meta.dirname, "..", "..", "library");

// ---------- 书库清单 ----------
export function listBooks(libDir = LIB_DIR) {
  if (!fs.existsSync(libDir)) return [];
  return fs.readdirSync(libDir).filter(f => f.endsWith(".db")).map(f => {
    const dbPath = path.join(libDir, f);
    try {
      const db = new Database(dbPath, { readonly: true });
      const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
      db.close();
      return { id: f.replace(/\.db$/, ""), db: dbPath, title: meta.title || f, format: meta.format, model: meta.model || null, chunks: +meta.chunk_count, chars: +meta.total_chars, pages: meta.num_pages || null, chapters: meta.num_chapters || null };
    } catch { return null; }
  }).filter(Boolean);
}

export function findBook(query, libDir = LIB_DIR) {
  const q = String(query).toLowerCase();
  const books = listBooks(libDir);
  return books.find(b => b.id.toLowerCase().includes(q) || b.title.toLowerCase().includes(q)) || null;
}

// ---------- 单书混合检索：字面 0.5 + 语义 0.5 → 复试官终审 ----------
// opts.qv: 预算好的问题向量（路由场景下避免重复编码）
// opts.rerank: 默认开，传 false 只走混合
export async function hybridSearch(dbPath, question, topN = 5, { qv = null, rerank = true } = {}) {
  const db = new Database(dbPath, { readonly: true });
  const cols = db.prepare("PRAGMA table_info(chunks)").all().map(c => c.name);
  const hasEmb = cols.includes("emb");

  const ftsScores = new Map();
  const q = String(question).replace(/"/g, "").trim();
  if (q.length >= 3) {
    try {
      for (const r of db.prepare(`SELECT c.id id, bm25(chunks_fts) rank FROM chunks_fts f JOIN chunks c ON c.id=f.rowid WHERE chunks_fts MATCH ?`).all(`"${q}"`))
        ftsScores.set(r.id, -r.rank);
    } catch { /* 特殊字符降级 LIKE */ }
  }
  if (!ftsScores.size)
    for (const r of db.prepare(`SELECT id FROM chunks WHERE text LIKE ? LIMIT 200`).all(`%${q}%`))
      ftsScores.set(r.id, 10);

  let semScores = new Map();
  let embedKey = null;
  if (hasEmb) {
    const embed = await getEmbedder();
    embedKey = embed.key;
    if (!qv) [qv] = await embed.embedQueries([q]);
    for (const r of db.prepare("SELECT id, emb FROM chunks WHERE emb IS NOT NULL").all()) {
      const v = new Float32Array(r.emb.buffer, r.emb.byteOffset, r.emb.byteLength / 4);
      semScores.set(r.id, cosine(qv, v));
    }
  }

  const norm = (m) => {
    if (m.size < 2) return new Map([...m.keys()].map(k => [k, 1]));
    const vals = [...m.values()], mx = Math.max(...vals), lo = Math.min(...vals);
    return new Map([...m.entries()].map(([k, v]) => [k, mx === lo ? 1 : (v - lo) / (mx - lo)]));
  };
  const nf = norm(ftsScores), ns = norm(semScores);

  // 第三路：编目信号（人物字面命中 + 主题语义命中，只对编过目的库生效）
  // 关掉：BSP_CATALOG=0（对照组/回滚）；加权强度可调：BSP_CATALOG_W
  const CATALOG_ON = process.env.BSP_CATALOG !== "0";
  const CATALOG_W = +(process.env.BSP_CATALOG_W || 0.3);
  const NOM_PERSON = 8, NOM_THEME = 4;  // 池外提名配额（绕过混合分进复试窗）
  const cat = (CATALOG_ON && q) ? loadCatalogSignal(db, q, qv, embedKey) : { hit: new Map() };
  // 信号地板：太弱的信号（高频人物单点名，如 352 块都提"达西" w≈0.085）帮不了检索
  // 却足以扰动预筛窗口重掷复试官的骰子（实测把 pemberley 英文题从过打到漏）——直接无效化
  for (const [k, v] of cat.hit) if (v.w < 0.15) cat.hit.delete(k);

  // 候选池：字面/语义全集
  const pool = new Map();
  for (const id of new Set([...nf.keys(), ...ns.keys()]))
    pool.set(id, { id, score: 0.5 * (nf.get(id) || 0) + 0.5 * (ns.get(id) || 0), fts: nf.get(id) || 0, sem: ns.get(id) || 0 });

  // 池内命中：加权（低频人物/强主题信号权重高，高频名字几乎不加权）
  for (const [cid, sig] of cat.hit) {
    const p = pool.get(+cid);
    if (p) { p.score += CATALOG_W * sig.w; p.cat = sig.tag; p.catW = sig.w; }
  }

  // 池外提名：人物 8 + 主题 4 个命中块保证进复试窗（人物关系题的救命机制——
  // 答案块的字面/语义分可能很低，但提名的目的是让它见到复试官，由复试官终审）
  // 提名门槛：信号太弱的块不配提名——高频人物（如 352 块都提"达西"）的命中是噪声，
  // 乱提名会挤掉真正凭实力进窗的答案块（实测把 pemberley 英文题从过打到漏）
  const nominations = [];
  if (cat.hit.size) {
    const W_FLOOR = { person: 0.2, theme: 0.3 };
    const out = [...cat.hit.entries()].map(([id, s]) => ({ id: +id, w: s.w, tag: s.tag }))
      .filter(x => !pool.has(x.id));
    const byW = (t, n) => out.filter(x => x.tag === t && x.w >= W_FLOOR[t]).sort((a, b) => b.w - a.w).slice(0, n);
    for (const x of [...byW("person", NOM_PERSON), ...byW("theme", NOM_THEME)]) {
      const p = { id: x.id, score: 0.5 * (nf.get(x.id) || 0) + 0.5 * (ns.get(x.id) || 0) + CATALOG_W * x.w, fts: nf.get(x.id) || 0, sem: ns.get(x.id) || 0, cat: x.tag, catW: x.w, nom: true };
      pool.set(x.id, p);
      nominations.push(p);
    }
  }

  // 初筛：混合分取宽（topN×4 封顶 20），交给复试官精选
  // 编目信号命中时窗口扩 8 席（封顶 28）：人物关系题的证据块常排在 20 名开外，
  // 它们的字面/语义分不高但编目证据硬——多给 8 张复试门票，由复试官终审裁决
  const RECALL = Math.min(Math.max(topN * 4, 12), 20) + (cat.hit.size ? 8 : 0);
  const regular = [...pool.values()].filter(p => !p.nom)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(RECALL - nominations.length, 4));
  const merged = [...regular, ...nominations].sort((a, b) => b.score - a.score);

  const get = db.prepare("SELECT id, chapter, page, text FROM chunks WHERE id = ?");
  let final = merged.map(m => {
    const c = get.get(m.id);
    return { ...m, loc: c.page ? `第${c.page}页` : (c.chapter || ""), text: c.text };
  });

  // 复试官：对（问题, 块原文）逐对精算相关度，重排
  // 终排 = 复试分 + 0.02×编目信号：复试官主导，编目证据只做近并列裁决
  // （独立证据源线性融合——修复"真答案块 0.6454 惜败无关块 0.6505"这类复试噪声）
  if (rerank && final.length > 1) {
    const rerankFn = await getReranker();
    if (rerankFn) {
      const scores = await rerankFn(q, final.map(r => r.text));
      const TIE = CATALOG_ON ? +(process.env.BSP_CATALOG_TIE || 0.02) : 0;
      final = final.map((r, i) => ({ ...r, rerank: +scores[i].toFixed(4) }))
        .sort((a, b) => (b.rerank + TIE * (b.catW || 0)) - (a.rerank + TIE * (a.catW || 0)));
    }
  }
  db.close();
  return final.slice(0, topN);
}

// ---------- 动态挑书路由（总入口：临时技能包） ----------
export async function routeAndSearch(question, { topN = 4, maxBooks = 2, libDir = LIB_DIR } = {}) {
  const books = listBooks(libDir);
  if (!books.length) return { routed_books: [], results: [], note: "书库为空" };
  const embed = await getEmbedder();
  const [qv] = await embed.embedQueries([question]);
  const scored = books.map(b => {
    const db = new Database(b.db, { readonly: true });
    const cols = db.prepare("PRAGMA table_info(chunks)").all().map(c => c.name);
    let best = 0;
    if (cols.includes("emb")) {
      for (const r of db.prepare("SELECT emb FROM chunks WHERE emb IS NOT NULL").all()) {
        const v = new Float32Array(r.emb.buffer, r.emb.byteOffset, r.emb.byteLength / 4);
        const s = cosine(qv, v);
        if (s > best) best = s;
      }
    }
    db.close();
    return { ...b, best };
  }).sort((a, b) => b.best - a.best);

  // 规则：语义分 ≥ 首名×0.85 的书入选（最多 maxBooks 本，至少 1 本）
  // routeFloor 接线：EMBED_MODELS 里注册的绝对下限（e5 尺度 0.7）兜底，防止弱书蹭进来
  const top = scored[0];
  const picked = scored.filter(b => b.best >= Math.max(embed.routeFloor, top.best * 0.85)).slice(0, maxBooks);
  const results = [];
  for (const b of picked)
    for (const r of await hybridSearch(b.db, question, topN, { qv }))
      results.push({ book: b.title, loc: r.loc, score: r.rerank ?? r.score, fts: r.fts, sem: r.sem, rerank: r.rerank, text: r.text });
  results.sort((a, b) => b.score - a.score);
  return {
    routed_books: picked.map(b => ({ title: b.title, best_sim: +b.best.toFixed(3) })),
    considered: scored.map(b => ({ title: b.title, best_sim: +b.best.toFixed(3) })),
    results: results.slice(0, topN),
  };
}
