// 检索核心库：书库清单 / 混合检索（含复试官重排序）/ 动态挑书路由
// 被 query-book.js（CLI）、mcp-server.mjs（MCP skill）共用
// 模型统一从 models.mjs 拿（换引擎只改那一个文件）
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

import { getEmbedder, getReranker, cosine, assertEngine } from "./models.mjs";
import { questionKeywords, buildFtsQuery, cjkLikeScores, capFtsHits } from "./keywords.mjs";
import { getMatrix, matrixScores } from "./vec-cache.mjs";
import { loadCatalogSignal, entityAliasTerms } from "./catalog.mjs";
import { loadSkillState } from "./skill-state.mjs";
export { getEmbedder, cosine };

const DEFAULT_LIB_DIR = path.join(import.meta.dirname, "..", "..", "library");
// M2：环境变量层——桌面把 paths.mjs 解析结果写进 process.env，spawn 的 CLI 子进程继承，
// CLI 与桌面共享同一份解析（迁库后 CLI 不瞎）
const ENV_LIB_DIR = process.env.BSP_LIB_DIR || null;
let _libDir = null;
// configure：桌面端数据目录注入；未调用时默认值逐字节维持旧行为（npm test 不受伤）
export function configureSearch({ libDir } = {}) {
  if (libDir) _libDir = libDir;
}
export function currentLibDir() {
  return _libDir || ENV_LIB_DIR || DEFAULT_LIB_DIR;
}

// ---------- 书库清单 ----------
// opts.includeDisabled: 默认 false——按 <libDir>/skill-state.json 过滤掉关掉 skill 的书（H3：
// 关一本书，桌面与 MCP 都查不到它；但引用回源验证等内部用途显式传 true 豁免，否则已落盘的
// 技能包会全部验证失败）。无状态文件时全返回不过滤（stage3 六本断言不受伤）。
//
// P5 进程内缓存：缓存**未过滤的全量清单**（按 libDir 分桶）——includeDisabled 过滤在缓存
// 之上现读 skill-state（轻 json），skill-state 变化天然不触发清单失效。失效信号两个：
// .db 文件名集合变化 + 任一 .db 的 mtime/size 变化（readdir+stat 是轻操作；重的是逐库
// open 查 meta——指纹变化才重扫）。**不落盘**（desktop/MCP 双进程写盘缓存会打架）；
// BSP_LIST_CACHE=0 一键回退旧路径。默认开（清单条目几十字节无内存压力、失效信号明确）。
// 返回结构与语义与旧版一致（12 处调用方零感知）。
const listCache = new Map();  // libDir -> { fp, list }
let listHits = 0, listMisses = 0;
const listCacheEnabled = () => process.env.BSP_LIST_CACHE !== "0";

// 指纹：文件名集合 + 每个 .db 的 mtime/size（每次 listBooks 都算——readdir + N 次 stat，微秒级）
function libFingerprint(libDir) {
  return fs.readdirSync(libDir).filter(f => f.endsWith(".db")).sort().map(f => {
    try { const st = fs.statSync(path.join(libDir, f)); return `${f}:${st.mtimeMs}:${st.size}`; }
    catch { return `${f}:gone`; }  // stat 失败按"变化"处理：下一轮重扫兜底
  }).join("|");
}

// 逐库 open 查 meta（重操作，仅指纹变化时执行）
function scanBooks(libDir) {
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

export function listBooks(libDir = currentLibDir(), { includeDisabled = false } = {}) {
  if (!fs.existsSync(libDir)) return [];
  let all;
  if (listCacheEnabled()) {
    const fp = libFingerprint(libDir);
    const ent = listCache.get(libDir);
    if (ent && ent.fp === fp) { listHits++; all = ent.list; }
    else { listMisses++; all = scanBooks(libDir); listCache.set(libDir, { fp, list: all }); }
  } else {
    all = scanBooks(libDir);  // BSP_LIST_CACHE=0：旧路径，不读不写缓存
  }
  // 数组+元素浅拷贝：调用方改返回值不污染缓存（每条 10 字段，微秒级；旧版每次调用本就返回新对象）
  const books = all.map(b => ({ ...b }));
  if (includeDisabled) return books;
  const state = loadSkillState(libDir);
  return Object.keys(state).length ? books.filter(b => state[b.id] !== false) : books;
}

// 观测钩子（测试断言命中/失效）+ 一键清空（与 vec-cache 的 clearVecCache/vecCacheStats 对称）
export function clearListCache() { listCache.clear(); listHits = 0; listMisses = 0; }
export function listCacheStats() { return { enabled: listCacheEnabled(), hits: listHits, misses: listMisses, dirs: listCache.size }; }

export function findBook(query, libDir = currentLibDir()) {
  const q = String(query).toLowerCase();
  const books = listBooks(libDir);
  return books.find(b => b.id.toLowerCase().includes(q) || b.title.toLowerCase().includes(q)) || null;
}

// ---------- 单书混合检索：字面 0.5 + 语义 0.5 → 复试官终审 ----------
// opts.qv: 预算好的问题向量（路由场景下避免重复编码）
// opts.rerank: 默认开，传 false 只走混合
export async function hybridSearch(dbPath, question, topN = 5, { qv = null, rerank = true } = {}) {
  topN = Math.min(Math.max(Number(topN) || 5, 1), 50);  // 防呆：NaN/负数/超大值都夹回正常区间
  const db = new Database(dbPath, { readonly: true });
  try {
    // 引擎一致性卫兵（有向量才需要）：库和查询不在同一向量空间就拒绝跑（宁可不答，不答错）。
    // 无 emb 列（build-book 直出 / embed 中断途中）没有向量可错配 → 豁免，字面腿照常可用
    // （与 similar.mjs 的 no-vectors 优雅路径同哲学；写路径 importCatalog 仍由 assertEngine
    // 严格拦"先灌向量再编目"）
    const embed = await getEmbedder();
    const cols = db.prepare("PRAGMA table_info(chunks)").all().map(c => c.name);
    const hasEmb = cols.includes("emb");
    if (hasEmb) assertEngine(db, embed.key);

    // ---------- 字面腿 ----------
    // 关键词模式（默认）：整句 MATCH 是死路——书里不会出现整句问题（43 题实测字面腿命中 0）。
    // 英文拆 ≥3 字实义词 OR 联合 MATCH（bm25 天然按 IDF 排序）；中文简繁双形切 2-gram LIKE
    // 计分（转繁形服务繁体书、原形服务简体工作资料；df 过滤掉无区分度的白话词）。两条路都
    // 只留 top-12 最尖的候选——实测不封顶会把预筛窗口挤爆产生回归（86→81），封顶 12 = 最小
    // 扰动提名制。
    // 权重固定 0.5（与语义腿对等）；BSP_FTS_W 可手动压低。旧模式：BSP_FTS_KW=0。
    const ftsScores = new Map();
    const q = String(question).replace(/"/g, "").trim();
    const FTS_KW = process.env.BSP_FTS_KW !== "0";
    let ftsW = Math.min(+(process.env.BSP_FTS_W || 0.5), 0.5);
    if (q.length >= 3 && FTS_KW) {
      const kws = questionKeywords(q);
      // P1 词法实体链接别名注入（BSP_ENTITY_LINK=0 关 = 旧行为）：命中人物的书内真实写法
      // 补进字面腿词盘——问一种写法搜全写法（Lizzy↔Elizabeth）、中文提问链到书内写法。
      // 别名排问题词前（24 词封顶盘上别名永不落榜）；只加词不改分——打分/权重/复试官零改动
      const alias = process.env.BSP_ENTITY_LINK !== "0" ? entityAliasTerms(db, q) : { en: [], cjk: [] };
      const ftsQ = buildFtsQuery({ en: [...alias.en, ...kws.en] });
      if (ftsQ) {
        try {
          const hits = new Map();
          for (const r of db.prepare(`SELECT c.id id, bm25(chunks_fts) rank FROM chunks_fts f JOIN chunks c ON c.id=f.rowid WHERE chunks_fts MATCH ?`).all(ftsQ))
            hits.set(r.id, -r.rank);
          for (const [id, s] of capFtsHits(hits)) ftsScores.set(id, s);
        } catch { /* 词面意外 → 落中文 LIKE */ }
      }
      const cjkAll = [...kws.cjk, ...alias.cjk];
      if (!ftsScores.size && cjkAll.length)
        for (const [id, n] of capFtsHits(cjkLikeScores(db, cjkAll))) ftsScores.set(id, n);
    } else if (q.length >= 3) {
      try {
        for (const r of db.prepare(`SELECT c.id id, bm25(chunks_fts) rank FROM chunks_fts f JOIN chunks c ON c.id=f.rowid WHERE chunks_fts MATCH ?`).all(`"${q}"`))
          ftsScores.set(r.id, -r.rank);
      } catch { /* 特殊字符降级 LIKE */ }
      if (!ftsScores.size)
        // LIKE 通配符转义：问题里的 % _ \ 当字面量处理，否则 "100%" 能匹配半本书
        for (const r of db.prepare(`SELECT id FROM chunks WHERE text LIKE ? ESCAPE '\\' LIMIT 200`).all(`%${q.replace(/[\\%_]/g, "\\$&")}%`))
          ftsScores.set(r.id, 10);
    }

    let semScores = new Map();
    const embedKey = embed.key;
    if (hasEmb) {
      if (!qv) [qv] = await embed.embedQueries([q]);
      // 向量矩阵缓存（BSP_VEC_CACHE_MB=0 关闭）：命中则纯点积，未命中回退逐行 BLOB
      const mat = getMatrix(db, dbPath, embedKey);
      if (mat) matrixScores(mat, qv, semScores);
      else
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

  // 候选池：字面/语义全集（字面腿权重 ftsW：关键词模式按质量阶梯，旧模式恒 0.5）
  const pool = new Map();
  for (const id of new Set([...nf.keys(), ...ns.keys()]))
    pool.set(id, { id, score: ftsW * (nf.get(id) || 0) + (1 - ftsW) * (ns.get(id) || 0), fts: nf.get(id) || 0, sem: ns.get(id) || 0 });

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
      const p = { id: x.id, score: ftsW * (nf.get(x.id) || 0) + (1 - ftsW) * (ns.get(x.id) || 0) + CATALOG_W * x.w, fts: nf.get(x.id) || 0, sem: ns.get(x.id) || 0, cat: x.tag, catW: x.w, nom: true };
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
    return final.slice(0, topN);
  } finally {
    db.close();  // 错误路径也必须关库（引擎不一致抛错/模型加载失败时不能泄漏句柄）
  }
}

// ---------- 动态挑书路由（总入口：临时技能包） ----------
export async function routeAndSearch(question, { topN = 4, maxBooks = 2, libDir = currentLibDir() } = {}) {
  const books = listBooks(libDir);
  if (!books.length) return { routed_books: [], results: [], note: "书库为空" };
  const embed = await getEmbedder();
  const [qv] = await embed.embedQueries([question]);
  const skipped = [];  // 引擎不匹配的书：路由阶段跳过（混着旧引擎的书库不该整体罢工，但要说一声）
  // 质心预筛门槛：书少（≤ BSP_ROUTE_PRESCREEN，默认 6）直接全部精扫——行为与旧版逐位一致；
  // 书多时先按质心分粗排，只对 top-K（K = maxBooks×3，至少 8）做全库精扫，长尾保留质心分。
  // （质心分 ≤ 精扫最优分的数学下界：归一化向量的均值点积 = 行点积均值 ≤ 最大行点积）
  const PRESCREEN = Math.max(1, +(process.env.BSP_ROUTE_PRESCREEN ?? 6));
  const fullScan = (db, b) => {
    let best = 0;
    // 未灌向量的库没有可算的分（0 分自然被 routeFloor 挡在门外）；也避开 getMatrix 的 emb 查询
    const cols = db.prepare("PRAGMA table_info(chunks)").all().map(c => c.name);
    if (!cols.includes("emb")) return 0;
    const mat = getMatrix(db, b.db, embed.key);
    if (mat) {
      const s = new Map();
      matrixScores(mat, qv, s);
      for (const v of s.values()) if (v > best) best = v;
    } else {
      for (const r of db.prepare("SELECT emb FROM chunks WHERE emb IS NOT NULL").all()) {
        const v = new Float32Array(r.emb.buffer, r.emb.byteOffset, r.emb.byteLength / 4);
        const sc = cosine(qv, v);
        if (sc > best) best = sc;
      }
    }
    return best;
  };
  const scored = books.map(b => {
    const db = new Database(b.db, { readonly: true });
    try {
      try {
        const cols = db.prepare("PRAGMA table_info(chunks)").all().map(c => c.name);
        if (cols.includes("emb")) assertEngine(db, embed.key);  // 无向量列的库跳过引擎卫兵（无错配可言）
      }
      catch (e) { skipped.push({ title: b.title, reason: e.message }); return { ...b, best: -Infinity }; }
      return { ...b, best: fullScan(db, b) };
    } finally {
      db.close();
    }
  });
  if (books.length > PRESCREEN) {
    // 第二遍粗筛：质心分 top-K 才配全扫（大书库的省时闸门，当前 6 本书不触发）
    const K = Math.max(maxBooks * 3, 8);
    const cand = scored.filter(b => b.best > -Infinity).sort((a, b) => b.best - a.best).slice(0, K);
    for (const b of cand) {
      const db = new Database(b.db, { readonly: true });
      try { b.best = fullScan(db, b); } finally { db.close(); }
    }
  }
  scored.sort((a, b) => b.best - a.best);

  // 规则：语义分 ≥ 首名×0.85 的书入选（最多 maxBooks 本，至少 1 本）
  // routeFloor 接线：EMBED_MODELS 里注册的绝对下限（e5 尺度 0.7）兜底，防止弱书蹭进来
  const top = scored[0];
  const picked = top.best === -Infinity ? [] : scored.filter(b => b.best >= Math.max(embed.routeFloor, top.best * 0.85)).slice(0, maxBooks);
  const results = [];
  for (const b of picked)
    for (const r of await hybridSearch(b.db, question, topN, { qv }))
      // bookId/id 是桌面端引用跳转要的直通字段（纯加法，不碰排序与打分）
      results.push({ book: b.title, bookId: b.id, id: r.id, loc: r.loc, score: r.rerank ?? r.score, fts: r.fts, sem: r.sem, rerank: r.rerank, text: r.text });
  results.sort((a, b) => b.score - a.score);
  const out = {
    routed_books: picked.map(b => ({ title: b.title, best_sim: +b.best.toFixed(3) })),
    considered: scored.filter(b => b.best > -Infinity).map(b => ({ title: b.title, best_sim: +b.best.toFixed(3) })),
    results: results.slice(0, topN),
  };
  if (skipped.length) out.skipped_books = skipped;
  return out;
}
