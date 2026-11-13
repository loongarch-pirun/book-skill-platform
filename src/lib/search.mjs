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
import { loadEnrichSignal } from "./enrich-signal.mjs";
import { loadSkillState } from "./skill-state.mjs";
import { bookTokenTotal, detectLang, qualityFromStats } from "./token-estimate.mjs";
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
    let db;
    try {
      db = new Database(dbPath, { readonly: true });
      const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
      // V3R7-①：token 账 + 章节质量。新库 build-book 直接写 meta；回补前的旧库现场估算
      // （同一把尺子见 lib/token-estimate.mjs）——旧库不跑回补脚本也有正确展示。
      let totalTokens = +meta.total_tokens > 0 ? +meta.total_tokens : null;
      if (totalTokens === null && +meta.total_chars > 0) {
        try {
          const sample = db.prepare("SELECT text FROM chunks LIMIT 50").all().map(r => r.text);
          totalTokens = bookTokenTotal(+meta.total_chars, detectLang(sample));
        } catch { /* 坏库/空表：保持 null，调用方按未知处理 */ }
      }
      let chapterQuality = null;
      try { chapterQuality = meta.chapter_quality ? JSON.parse(meta.chapter_quality) : null; } catch { /* 坏 JSON 现场算 */ }
      if (!chapterQuality) {
        try {
          const st = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN chapter IS NOT NULL AND chapter != '' THEN 1 ELSE 0 END) named, AVG(CASE WHEN chapter IS NOT NULL AND chapter != '' THEN length(chapter) ELSE NULL END) avg_len FROM chunks").get();
          chapterQuality = qualityFromStats({ total: st.total || 0, withChapter: st.named || 0, avgNameLen: st.avg_len || 0 });
        } catch { chapterQuality = null; }
      }
      // B6/CP3：lang 语义打通——meta.lang 由编目（jobs.mjs B6 改动）落库；旧库没有该键时
      // 现场用 detectLang 抽样估（与上面 total_tokens 同款兜底模式，readonly 不写库）。
      // engine.mjs {...b} 自动带上，B 线英文书分支从此可达。
      let lang = meta.lang || null;
      if (!lang) {
        try {
          const sample = db.prepare("SELECT text FROM chunks LIMIT 50").all().map(r => r.text);
          lang = detectLang(sample);
        } catch { lang = null; } // 坏库/空表：保持 null，调用方按未知处理
      }
      db.close();
      return { id: f.replace(/\.db$/, ""), db: dbPath, title: meta.title || f, format: meta.format, model: meta.model || null, chunks: +meta.chunk_count, chars: +meta.total_chars, pages: meta.num_pages || null, chapters: meta.num_chapters || null, total_tokens: totalTokens, chapter_quality: chapterQuality, lang };
    } catch {
      // 坏库过滤：句柄必须先 close——Windows 上泄漏会让删库/清理临时目录报 EBUSY
      try { db?.close(); } catch { /* close 失败无从补救，继续过滤 */ }
      return null;
    }
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

// ---------- 指代回填：单书检索里把「这本书 / 这篇论文」换成《书名》 ----------
// 为什么需要（实测 2026-11-13，13-可用性/）：问「这篇论文的作者是谁」时问句里没有指代对象，
// 中文问句 × 英文正文的字面腿全 0，只剩语义腿；归一化后参考文献条（sem 0.86~0.99）系统性高于
// 首页署名区（sem 0.85），attention 121 块库里 6 块署名块在初筛池排 11~49 名（前 20 只进 1 块）。
// 结果：4 本 PDF × 2 问共 8 题，top1 落在首页只有 1/8，4/4 全答成参考文献段。
// 把指代换成「《书名》」后 8/8 落首页，分数从 0.02~0.08 抬到 0.33~0.97（vague-rewrite-abc.mjs）。
//
// 为什么必须过闸门：书名来源就是文件名（meta.title 是 slug），美化后是拼音或英文——
// pg1260-简爱→简爱、mengzi-zh→Mengzi、pride-and-prejudice-en→Pride And Prejudice。
// 无条件回填等于把中文书名塞进英文正文当纯噪声：实测简爱「这本书的作者是谁」原 0.253
//（本来就答对 JANE EYRE AN AUTOBIOGRAPHY）被砸到 0.004，孟子 0.044→0.002，
// 道德经 0.103→0.030（vague-rewrite-novel.mjs）。所以只有当书名的某个锚点真在本库
// chunks.text 里字面出现时才回填；闸门不开时原句一个字节都不动（可翻转判据，guard-test 钉着）。
export function prettyTitle(raw) {
  let s = String(raw || "").replace(/\.(pdf|epub|docx|md|txt)$/i, "");
  s = s.replace(/^pg\d+[-_]/i, "");                    // Gutenberg 编号：pg1260-简爱 → 简爱
  s = s.replace(/[-_](en|zh|cn|ja|de|fr)$/i, "");      // 语言后缀：pride-and-prejudice-en
  if (/^[\x00-\x7F]+$/.test(s)) {                      // 纯 ASCII 才还原连字符与首字母
    s = s.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    s = s.replace(/\b[a-z]/g, (m) => m.toUpperCase());
  }
  return s.trim() || String(raw || "");
}

// 候选锚点：整串、去尾部年份、第一个分隔符前的主名、最长 ASCII 主词。
// 为什么要这一串：「Dynamo-亚马逊高可用键值存储-2007」整串正文里没有，但「Dynamo」有 79 块；
// 「MapReduce-…-2004」同理。锚点只用于闸门判定，不参与检索打分。
export function anchorsOf(title) {
  const out = new Set();
  const t = String(title || "").trim();
  if (!t) return [];
  out.add(t);
  const noYear = t.replace(/[-_\s]*\d{4}$/, "").trim();
  if (noYear) out.add(noYear);
  const head = t.split(/[:：—–\-]/)[0].trim();
  if (head) out.add(head);
  const ascii = (t.match(/[A-Za-z][A-Za-z0-9]{2,}/g) || []).sort((a, b) => b.length - a.length)[0];
  if (ascii) out.add(ascii);
  return [...out].filter((x) => x.length >= 3);
}

// 闸门结果按 dbPath + mtime/size 缓存：LIKE 全表扫在 1861 块的库上是毫秒级，但每问都要跑一次，
// 缓存失效信号与 listBooks 同款（mtime+size）。BSP_LIST_CACHE=0 时一并回退不缓存。
const anchorGateCache = new Map();  // dbPath -> { key, hit }
function anchorGate(db, dbPath, title) {
  let key = "gone";
  try { const st = fs.statSync(dbPath); key = `${st.mtimeMs}:${st.size}`; } catch { /* 统计失败按每次重算 */ }
  if (listCacheEnabled() && key !== "gone") {
    const c = anchorGateCache.get(dbPath);
    if (c && c.key === key) return c.hit;
  }
  let hit = null;
  for (const a of anchorsOf(title)) {
    const esc = a.replace(/[\\%_]/g, "\\$&");  // % _ \ 当字面量：书名里出现它们不许当通配符
    let n = 0;
    try { n = db.prepare("SELECT count(*) c FROM chunks WHERE text LIKE ? ESCAPE '\\'").get(`%${esc}%`).c; }
    catch { n = 0; }
    if (n > 0) { hit = { anchor: a, hits: n }; break; }
  }
  if (listCacheEnabled() && key !== "gone") anchorGateCache.set(dbPath, { key, hit });
  return hit;
}

function bookTitleOf(db) {
  try { return db.prepare("SELECT value FROM meta WHERE key = 'title'").get()?.value || ""; }
  catch { return ""; }  // 老库/坏 meta：没有书名就不回填
}

// 返回改写后的问句；不该改（没有指代 / 没有书名 / 闸门不开）返回 null。
export function vagueRewrite(db, dbPath, question) {
  const q = String(question || "");
  if (!VAGUE_REF_RE.test(q)) return null;
  const raw = bookTitleOf(db);
  if (!raw) return null;
  const title = prettyTitle(raw);
  if (!title) return null;
  if (!anchorGate(db, dbPath, title)) return null;
  const rewritten = q.replace(VAGUE_REF_RE, `《${title}》`);
  return rewritten === q ? null : rewritten;
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
    const qRaw = String(question).replace(/"/g, "").trim();
    // 指代回填（见上方 vagueRewrite 注释）：闸门开了才改，改了就三条腿全都用新问句——
    // 传入的 qv 是按原句预编码的，回填后必须作废重编，否则语义腿与字面腿问的不是同一件事。
    // BSP_VAGUE=0 一键回退旧行为（对照组用）。
    const qW = process.env.BSP_VAGUE === "0" ? null : vagueRewrite(db, dbPath, qRaw);
    const q = qW || qRaw;
    if (qW) qv = null;
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

  // 第四路：洗数据信号（标签/假设问题/摘要命中，只对洗过数据的库生效；V3 第三波-①）
  // 模式：BSP_ENRICH_NOM=0 关（开发期默认；实验定后改）/ 1 提名制 / 2 加权腿；强度可调 BSP_ENRICH_W
  const ENRICH_MODE = +(process.env.BSP_ENRICH_NOM || 0);
  const ENRICH_W = +(process.env.BSP_ENRICH_W || 0.3);
  const NOM_ENRICH = 6; // 池外提名配额（镜像目录信号的最小扰动原则）
  const enr = ENRICH_MODE > 0 && q ? loadEnrichSignal(db, q) : { hit: new Map() };
  // 信号地板（铁律：弱信号不许扰动——单摘要命中 0.12 在这一步被无效化）
  for (const [k, v] of enr.hit) if (v.w < 0.15) enr.hit.delete(k);

  // 候选池：字面/语义全集（字面腿权重 ftsW：关键词模式按质量阶梯，旧模式恒 0.5）
  const pool = new Map();
  for (const id of new Set([...nf.keys(), ...ns.keys()]))
    pool.set(id, { id, score: ftsW * (nf.get(id) || 0) + (1 - ftsW) * (ns.get(id) || 0), fts: nf.get(id) || 0, sem: ns.get(id) || 0 });

  // 池内命中：加权（低频人物/强主题信号权重高，高频名字几乎不加权）
  for (const [cid, sig] of cat.hit) {
    const p = pool.get(+cid);
    if (p) { p.score += CATALOG_W * sig.w; p.cat = sig.tag; p.catW = sig.w; }
  }
  // 池内命中（模式 2 加权腿）：洗数据信号加权（镜像编目池内逻辑）
  if (ENRICH_MODE === 2) for (const [cid, sig] of enr.hit) {
    const p = pool.get(+cid);
    if (p) { p.score += ENRICH_W * sig.w; p.enr = sig.tag; p.enrW = sig.w; }
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

  // 池外提名（模式 1 提名制）：洗数据信号 top-6 保证进复试窗。
  // 提名门槛 0.2（tag 0.4/question 0.25 过线；弱组合不过）——乱提名会挤掉凭实力进窗的答案块
  if (ENRICH_MODE === 1 && enr.hit.size) {
    const out = [...enr.hit.entries()].map(([id, s]) => ({ id: +id, w: s.w, tag: s.tag }))
      .filter((x) => !pool.has(x.id) && x.w >= 0.2)
      .sort((a, b) => b.w - a.w).slice(0, NOM_ENRICH);
    for (const x of out) {
      const p = { id: x.id, score: ftsW * (nf.get(x.id) || 0) + (1 - ftsW) * (ns.get(x.id) || 0) + ENRICH_W * x.w, fts: nf.get(x.id) || 0, sem: ns.get(x.id) || 0, enr: x.tag, enrW: x.w, nom: true };
      pool.set(x.id, p);
      nominations.push(p);
    }
  }

  // 初筛：混合分取宽（topN×4 封顶 20），交给复试官精选
  // 编目/洗数据信号命中时窗口扩 8 席（封顶 28）：证据块常排在 20 名开外，
  // 它们的字面/语义分不高但独立证据硬——多给 8 张复试门票，由复试官终审裁决
  const RECALL = Math.min(Math.max(topN * 4, 12), 20) + ((cat.hit.size || enr.hit.size) ? 8 : 0);
  const regular = [...pool.values()].filter(p => !p.nom)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(RECALL - nominations.length, 4));
  const merged = [...regular, ...nominations].sort((a, b) => b.score - a.score);

  // P3-② chapter_path 渐进采用：列随重建出现（老库无列），探测后再取——
  // 只搭载不动 loc（loc 喂提示词，动它=动模型输入）；展示层自行选用
  const hasPath = db.prepare("SELECT COUNT(*) n FROM pragma_table_info('chunks') WHERE name='chapter_path'").get().n > 0;
  const get = db.prepare(`SELECT id, chapter, page, text${hasPath ? ", chapter_path" : ""} FROM chunks WHERE id = ?`);
  let final = merged.map(m => {
    const c = get.get(m.id);
    return { ...m, chapter: c.chapter || null, loc: c.page ? `第${c.page}页` : (c.chapter || ""), chapterPath: hasPath ? (c.chapter_path || null) : null, text: c.text };
  });

  // 复试官：对（问题, 块原文）逐对精算相关度，重排
  // 终排 = 复试分 + 0.02×独立证据权重（编目/洗数据信号）：复试官主导，证据只做近并列裁决
  // （独立证据源线性融合——修复"真答案块 0.6454 惜败无关块 0.6505"这类复试噪声）
  if (rerank && final.length > 1) {
    const rerankFn = await getReranker();
    if (rerankFn) {
      const scores = await rerankFn(q, final.map(r => r.text));
      const TIE = CATALOG_ON ? +(process.env.BSP_CATALOG_TIE || 0.02) : 0;
      let ranked = final.map((r, i) => ({ ...r, rerank: +scores[i].toFixed(4) }))
        .sort((a, b) => (b.rerank + TIE * ((b.catW || 0) + (b.enrW || 0))) - (a.rerank + TIE * ((a.catW || 0) + (a.enrW || 0))));

      // P0-4 终排保送向量召回第 1 名（BSP_SEM_GUARD=0 关 = 旧行为，对照组用）
      //
      // 为什么要有这道保险：复试官是字面匹配器，语义等价但措辞不同的题它一律看低。
      // 实测 pride 开篇题（「what is the famous opening sentence about」）唯一正确答案
      // 向量召回排第 1/1277，重排后掉到第 20/20 —— 纯重排把它整条踢出候选池，
      // 无论后面怎么答都答不对。这不是重排噪声，是重排的系统性盲区。
      // 但也不能废掉重排：重排整体 +11 分（83→93），独漏的只有这一类题。
      //
      // 所以只做最小干预：向量召回第 1 名若不在重排后的 topN 内，替换掉末位。
      // 不扩池（池子大小不变，被挤下的末位与它换位，进池不进 topN）——扩池会稀释
      // 提示词、并让下游（邻块扩展/展示层）看到预算外的块。
      // 翻转判据：BSP_SEM_GUARD=0 → v2-eval rerank on 掉回 74/80=93，且漏题清单
      // 重新出现 what is the famous opening sentence about；默认开 → 75/80=94。
      if (process.env.BSP_SEM_GUARD !== "0" && ranked.length > topN) {
        let best = ranked[0];
        for (const r of ranked) if ((r.sem ?? 0) > (best.sem ?? 0)) best = r;
        const bi = ranked.findIndex(r => r.id === best.id);
        if (bi >= topN) {
          const dropped = ranked[topN - 1];      // 重排后的末位
          const out = [...ranked.slice(0, topN - 1), best];
          for (let i = topN; i < ranked.length; i++) out.push(i === bi ? dropped : ranked[i]);
          ranked = out;                          // 长度不变：末位与保送块换位，不扩池
        }
      }
      final = ranked;
    }
  }
  // P3-③ 邻块扩展（BSP_NEIGHBOR=1 开，默认关）：复试官终排后，对终排结果按
  // 同章 id±1 各补一席紧邻上下文——衰减计分 ×0.5、只附加不挤位（原 topN 一个
  // 不动）、不重跑复试官（邻居不进复试，成本零）；总数 ≤4 控提示词增量。
  // 变体快路径（rerank:false）不扩展——邻块只跟终排走；同章判据用扁平 chapter
  // （null 章 / 跨章不扩）。双门（evals 漏题⊆基线）过了才考虑默认开。
  const topFinal = final.slice(0, topN);
  if (process.env.BSP_NEIGHBOR === "1" && rerank && topFinal.length) {
    const inSet = new Set(topFinal.map(r => r.id));
    const nbrGet = db.prepare("SELECT id, chapter, page, text FROM chunks WHERE id = ?");
    const added = [];
    outer:
    for (const s of topFinal) {
      for (const d of [-1, 1]) {
        if (added.length >= 4) break outer;
        const nid = s.id + d;
        if (inSet.has(nid)) continue;
        const c = nbrGet.get(nid);
        if (!c || !c.chapter || c.chapter !== s.chapter) continue;
        inSet.add(nid);
        added.push({
          ...s, id: nid, chapter: c.chapter, loc: c.page ? `第${c.page}页` : (c.chapter || ""),
          chapterPath: s.chapterPath ?? null, text: c.text,
          score: +(((s.rerank ?? s.score) || 0) * 0.5).toFixed(4), rerank: undefined,
          nbr: Math.abs(d), nbrOf: s.id,
        });
      }
    }
    if (added.length) return [...topFinal, ...added];
  }
  return topFinal;
  } finally {
    db.close();  // 错误路径也必须关库（引擎不一致抛错/模型加载失败时不能泄漏句柄）
  }
}

// ---------- 多问法检索（V3-R1）：改写变体各跑一路快检索 → 合并去重 → 原句一次 rerank 终审 ----------
// 设计：变体路径全部 rerank:false（快，FTS+向量），变体只负责「把候选捞进池子」；
// 排序权威仍然是用户原话（questions[0]）——原句一次 rerank 终审。
// 变体数封顶 4、单路收宽 min(topN×2,12)、合并池封顶 30（复试官 ~3.6s 预算）。
// 不碰 hybridSearch 内部：本函数是 hybridSearch 的编排层。
export async function multiVariantSearch(dbPath, questions, topN = 6) {
  const variants = [...new Set((Array.isArray(questions) ? questions : [questions])
    .map(q => String(q || "").trim()).filter(Boolean))].slice(0, 4);
  if (!variants.length) return [];
  const per = Math.min(Math.max(topN * 2, 8), 12);
  const merged = new Map();
  for (const v of variants) {
    for (const r of await hybridSearch(dbPath, v, per, { rerank: false })) {
      const prev = merged.get(r.id);
      if (!prev) merged.set(r.id, { ...r, hitVariants: 1 });
      else {
        prev.hitVariants++;  // 多路共识计数：仅展示/调试用，不参与打分
        if (r.score > prev.score) { prev.score = r.score; prev.fts = r.fts; prev.sem = r.sem; }
      }
    }
  }
  let final = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 30);
  if (final.length > 1) {
    const rerankFn = await getReranker();
    if (rerankFn) {
      const scores = await rerankFn(variants[0], final.map(r => r.text));
      final = final.map((r, i) => ({ ...r, rerank: +scores[i].toFixed(4) })).sort((a, b) => b.rerank - a.rerank);
    }
  }
  return final.slice(0, topN);
}

// ---------- 动态挑书路由（总入口：临时技能包） ----------
// 三段式：① 逐本全块语义扫描（**不做每书归一化** → 余弦跨书同尺）算书级信号
//        ② 只翻最像的几本，每本深召回 K 条纯语义候选，合成一个池子
//        ③ 池子**只跑一次** rerank（同一把尺子比所有书），按书取最高分挑书
//
// 为什么不再用「hybridSearch 每本粗召回 6 条 + 按廉价混合分截 48 条」（2026-11-13 实测推翻）：
//   ① hybridSearch 内部对每本书做 min-max 归一化（norm），归一化后的分跨书不可比——
//      每本书的第一名都是 1.0，池子按它排序等于按「谁更极端」排序，不是按相关度；
//   ② 字面腿跨书会串味：问 Lamport 事件序，Dynamo 参考文献里那行
//      "[12] Lamport, L. Time, clocks, and the ordering of events..." 靠词面命中挤到第 2（0.554）；
//   ③ 每本只取 6 条太浅：实测答案块在廉价混合分里排第 12（Lamport）、13（Dynamo）、
//      甚至 556（简爱，1861 块），全部被截在池外，重排器根本没见过它们；
//   ④ 决定性实验（rerank-decisive.mjs）：把答案块硬塞进池子，4 题里 3 题直接拿第 1
//      （Dynamo 0.994 / attention 0.669 / 简爱 0.117）——所以病根是「池子截断」，不是「重排器不行」。
//
// 为什么书级信号用「前 3 条合格块余弦的均值」而不是「全书最大余弦」：max 是极值统计量，
// 天然偏袒块多和块碎的书（实测问「注意力头」时，只有 3~5 块的小库靠 max 挤到榜首）。
//
// 为什么加碎片门槛 ROUTE_MIN_LEN：句向量对短文本系统性给高分（95000 条实测：平均余弦随块长
// 单调递减，去均值后 log(长度) 与余弦 Pearson r=-0.18），不设门槛时 top10 可能全被 13 字的
// 标题碎片占满。门槛只作用在「挑书信号」和「深召回头」上；合格块不足 K 条时按真实余弦补位
//（不硬塞 0 分——那样补位块在重排时反而会凭真分数挤掉答案，是统计口径作弊）。
const ROUTE_MIN_LEN = Math.max(0, +(process.env.BSP_ROUTE_MINLEN ?? 60)); // 碎片门槛（字数）
const ROUTE_SIG_TOPK = 3;      // 书级信号 = 该书合格块里前 3 条余弦的均值
const ROUTE_BOOKS = Math.max(1, +(process.env.BSP_ROUTE_BOOKS ?? 4));  // 深召回几本书
const ROUTE_KEEP = Math.max(2, +(process.env.BSP_ROUTE_K ?? 10));      // 每本深召回几条
// 参考文献条（kind=ref）在路由结果里只降权不剔除：它们几乎从不是用户要的答案，却因为
// 词面高度重合而抢位（实测问 Lamport 事件序，Dynamo 参考文献里那行
// "[12] Lamport, L. Time, clocks, and the ordering of events..." 拿 0.554 挤到第 2）。
// 降权而不是剔掉：真有用户问「这篇论文引了谁」时它们还得能出来。
const ROUTE_REF_W = Math.min(1, Math.max(0, +(process.env.BSP_ROUTE_REFW ?? 0.5)));
const ROUTE_POOL_CAP = 48;     // 池子上限（重排逐条 128ms，48 条≈6s 是预算上限）
const ROUTE_FLOOR_RATIO = 0.3; // 书分 < 首名×0.3 视为不相关，不入选（避免每问都硬凑满 maxBooks）
// 「这篇/这本书/this paper」这类没点名的问句：任何排序器都猜不到用户指哪本（实测 probe-route5/6/10）。
// 与其赌一本答错，不如把候选书交给用户选。只在多本入选时提示，单本命中照常回答。
const VAGUE_REF_RE = /(?:这|那|该|此|本)\s*(?:本|篇|个)?\s*(?:书|論文|论文|文章|文檔|文档|教材|報告|报告)|this\s+(?:paper|book|article|document|story|novel)|the\s+(?:paper|book|article)|these\s+notes/i;

// 全块语义扫描：**不做每书 min-max 归一化**，返回的 sem 是原始余弦，跨书同尺可比。
// 坏库/坏向量/引擎不一致一律往上抛，由 routeAndSearch 逐本记账（一本坏库不许挂掉全库问答）。
async function scanBookSem(dbPath, embedKey, getQv) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const cols = db.prepare("PRAGMA table_info(chunks)").all().map(c => c.name);
    if (!cols.includes("emb")) return { hasSem: false, rows: [] };  // build-only 库：没有向量可扫
    assertEngine(db, embedKey);  // 引擎/维度不一致 → 抛出，调用方记 skipped_books
    const qv = await getQv();
    const rows = [];
    for (const r of db.prepare("SELECT id, kind, length(text) len, emb FROM chunks WHERE emb IS NOT NULL").all()) {
      const v = new Float32Array(r.emb.buffer, r.emb.byteOffset, r.emb.byteLength / 4);
      // kind 只用来识别参考文献条（见 ROUTE_REF_W）：正文块与它同尺比较，ref 条在入池时降权
      rows.push({ id: r.id, kind: r.kind || "", len: r.len || 0, sem: cosine(qv, v) });
    }
    rows.sort((a, b) => b.sem - a.sem);
    return { hasSem: rows.length > 0, rows };
  } finally { try { db.close(); } catch { /* 关失败无从补救，继续 */ } }
}

// 在已按余弦降序的行里取前 n 条：合格块（≥ROUTE_MIN_LEN）优先，不足 n 条时用短块按**真实余弦**
// 补位（绝不塞 0 分——那样补位块在重排时会凭真分数挤掉答案，是统计口径作弊）。
function tightPick(rows, n) {
  const out = [];
  for (const r of rows) if (r.len >= ROUTE_MIN_LEN) { out.push(r); if (out.length >= n) return out; }
  for (const r of rows) if (r.len < ROUTE_MIN_LEN) { out.push(r); if (out.length >= n) break; }
  return out;
}

// 书级信号：合格块前 ROUTE_SIG_TOPK 条余弦的均值（不用 max——max 偏袒块多和块碎的书）
function bookSignal(rows) {
  const pick = tightPick(rows, ROUTE_SIG_TOPK);
  return pick.length ? pick.reduce((s, r) => s + r.sem, 0) / pick.length : 0;
}

// 截断之后才查正文与定位：只查进池的那几十条，不把整库正文读进来
function attachChunks(rows) {
  const byBook = new Map();
  for (const r of rows) {
    if (!byBook.has(r.bookId)) byBook.set(r.bookId, { dbPath: r.db, list: [] });
    byBook.get(r.bookId).list.push(r);
  }
  for (const { dbPath, list } of byBook.values()) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const cols = db.prepare("PRAGMA table_info(chunks)").all().map(c => c.name);
      const hasPath = cols.includes("chapter_path");
      const sql = `SELECT id, kind, chapter, page, text${hasPath ? ", chapter_path" : ""} FROM chunks WHERE id IN (${list.map(() => "?").join(",")})`;
      const got = new Map(db.prepare(sql).all(...list.map(r => r.id)).map(r => [r.id, r]));
      for (const r of list) {
        const row = got.get(r.id);
        if (!row) { r.text = ""; r.loc = ""; continue; }  // 扫描后被删/换过的竞态：留空，后面会被剔除
        r.text = row.text || "";
        r.kind = row.kind || "";
        r.chapterPath = hasPath ? (row.chapter_path ?? null) : null;
        r.loc = row.page ? `第${row.page}页` : (row.chapter || "");
      }
    } finally { try { db.close(); } catch { /* 关失败无从补救，继续 */ } }
  }
}

export async function routeAndSearch(question, { topN = 4, maxBooks = 4, libDir = currentLibDir() } = {}) {
  const books = listBooks(libDir);
  if (!books.length) return { routed_books: [], results: [], note: "书库为空" };
  const skipped = [];  // 引擎不匹配/坏库：逐本跳过并记账（混着旧引擎的书库不该整体罢工，但要说一声）

  const embed = await getEmbedder();
  const q = String(question).trim();
  let qv = null;  // 问题向量全书库只编码一次
  const getQv = async () => { if (!qv) { [qv] = await embed.embedQueries([q]); } return qv; };

  // ---------- 第一段：逐本全块语义扫描（原始余弦，跨书同尺） ----------
  const considered = [];
  const scanned = [];  // { b, rows, sig }；rows 已按原始余弦降序
  for (const b of books) {
    // D3 修复（标准轮段 2）：逐本隔离——better-sqlite3 的 open 是惰性的（只开句柄），
    // 坏文件头/坏页/坏向量都在首条查询才炸，所以整段拦。一本坏库跳过并记账，不挂掉全库问答
    //（对齐 listBooks 过滤语义）。scanBookSem 内部带 assertEngine 卫兵与 finally close。
    let res;
    try {
      res = await scanBookSem(b.db, embed.key, getQv);
    } catch (e) {
      skipped.push({ title: b.title, reason: `召回失败（${e.message}）` });
      continue;
    }
    // 未灌向量的库（build-only / embed 中断）记 0 分且不入池——graphrag-fuzz:112 钉着这条
    //（considered[0].best_sim===0 且 routed 为空）；负余弦按 0 报，界面不该看到负数相似度。
    if (!res.hasSem) { considered.push({ title: b.title, best_sim: 0, n: 0 }); continue; }
    const sig = bookSignal(res.rows);
    considered.push({ title: b.title, best_sim: +Math.max(0, sig).toFixed(3), n: res.rows.length });
    scanned.push({ b, rows: res.rows, sig });
  }

  // ---------- 第二段：只翻最像的 ROUTE_BOOKS 本，每本深召回 ROUTE_KEEP 条 ----------
  scanned.sort((a, b) => b.sig - a.sig);
  const pool = [];
  for (const { b, rows } of scanned.slice(0, ROUTE_BOOKS))
    for (const r of tightPick(rows, ROUTE_KEEP))
      pool.push({ id: r.id, sem: r.sem, db: b.db, book: b.title, bookId: b.id });

  // 去重后按原始余弦截到池子上限（重排逐条 ~128ms，ROUTE_POOL_CAP 就是耗时预算）
  const seen = new Set();
  const merged = [];
  for (const c of pool.sort((a, b) => b.sem - a.sem)) {
    const k = `${c.bookId}#${c.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(c);
    if (merged.length >= ROUTE_POOL_CAP) break;
  }
  attachChunks(merged);
  for (let i = merged.length - 1; i >= 0; i--) if (!merged[i].text) merged.splice(i, 1);  // 空正文进重排只会占预算
  for (const r of merged) { r.score = r.sem; r.fts = 0; }  // 下游统一读 score/rerank，这里把余弦接进去
  if (!merged.length) {
    const empty = { routed_books: [], considered: considered.sort((a, b) => b.best_sim - a.best_sim), results: [] };
    if (skipped.length) empty.skipped_books = skipped;
    return empty;
  }

  // ---------- 第三段：一次统一重排（跨书同尺，这是新口径的核心） ----------
  if (merged.length > 1) {
    const rerankFn = await getReranker();
    if (rerankFn) {
      const scores = await rerankFn(question, merged.map(r => r.text));
      for (let i = 0; i < merged.length; i++) merged[i].rerank = +Number(scores[i] ?? 0).toFixed(4);
    }
  }

  // ---------- 有效分：重排分 ×（参考文献条降权） ----------
  // ref 条只降权不剔除（见 ROUTE_REF_W 注释）：0.554 的参考文献行 ×0.5 后让位给 0.39 的正文答案，
  // 但用户真问「这篇引了谁」时它还在榜上。
  for (const r of merged) {
    const base = r.rerank ?? r.score ?? 0;
    r.rank = base * (r.kind === "ref" ? ROUTE_REF_W : 1);
  }

  // ---------- 按书聚分：0.5×该书最好那条的有效分 + 0.5×(书级信号/池内首名信号) ----------
  // 为什么不是「整本取重排最优」：实测 9 题里简爱会被 pride 抢走（跨语种书名与正文都弱），
  // 因为重排只看得到入池的那几十条；而书级信号（全块前3余弦均值）是整本尺度的证据，
  // 两者各占一半时 9/9 全对（book-pick.mjs：纯重排 8/9、纯信号 8/9、0.5/0.5 与 0.6/0.4 均 9/9）。
  const sigOf = new Map(scanned.map(s => [s.b.id, s.sig]));
  const sigMax = Math.max(scanned.length ? scanned[0].sig : 0, 1e-9);
  const byBook = new Map();
  for (const r of merged) {
    const s = r.rank;
    const cur = byBook.get(r.bookId);
    if (!cur) byBook.set(r.bookId, { book: r.book, bookId: r.bookId, best: s, hits: 1, items: [r] });
    else { cur.hits++; cur.items.push(r); if (s > cur.best) cur.best = s; }
  }
  for (const v of byBook.values()) {
    const sig = Math.max(0, sigOf.get(v.bookId) ?? 0) / sigMax;
    v.bookScore = 0.5 * v.best + 0.5 * Math.min(1, sig);  // 书分只用于「挑书排序」，不冒充结果相关度
  }
  const ranked = [...byBook.values()].sort((a, b) => b.bookScore - a.bookScore);

  // 入选规则：书分 ≥ 首名×ROUTE_FLOOR_RATIO（不硬凑满 maxBooks——问「孟子讲了什么」时
  // 简爱/福尔摩斯的 0.27 分只是重排器的噪声底，列进"翻了 4 本书"只会让用户困惑）。
  // 只用相对门槛，不叠加绝对下限：重排分是 sigmoid 输出，跨查询的绝对值不可比（有的问题
  // 全池最高才 0.005），加一个固定 0.01 会把「有结果但弱」的书整本判丢——guard-test 段 9
  // 就是这样把唯一的好书挡掉的。唯一的绝对条件是 best > 0：0 分代表这书根本没召回（未灌
  // 向量/空库），必须排除（graphrag-fuzz:112 钉着 considered[0].best_sim===0 且 routed 为空）。
  // maxBooks=0 直通空（graphrag-fuzz:551 钉着 lib 层这个语义，工具层用 clampMaxBooks 归一）
  const bestMax = Math.max(0, ...[...byBook.values()].map(v => v.best));
  const floor = bestMax > 0 ? bestMax * ROUTE_FLOOR_RATIO : Infinity;
  const picked = maxBooks > 0 ? ranked.filter(b => b.best > 0 && b.best >= floor).slice(0, maxBooks) : [];

  // ---------- 结果：先按入选书的书分次序，书内再按有效分排 ----------
  // 为什么不是「全池按重排分排」：书分已经把简爱排到第 1 时，若结果还让 pride 的 0.1506 占着
  // 第一屏，用户看到的就是「说翻了简爱，给的却是傲慢与偏见」。书序即答案序才对得上。
  const pickedIds = new Set(picked.map(p => p.bookId));
  const order = new Map(picked.map((p, i) => [p.bookId, i]));
  const results = merged
    .filter(r => pickedIds.has(r.bookId))
    .sort((a, b) => (order.get(a.bookId) - order.get(b.bookId)) || ((b.rank ?? 0) - (a.rank ?? 0)))
    // bookId/id 是桌面端引用跳转要的直通字段（纯加法，不碰排序与打分）
    .slice(0, topN)
    // score 仍报真实重排分（rank 只是内部排位用的降权分，不对外冒充相关度）
    .map(r => ({ book: r.book, bookId: r.bookId, id: r.id, loc: r.loc, chapterPath: r.chapterPath ?? null, score: r.rerank ?? r.score, fts: r.fts, sem: r.sem, rerank: r.rerank, text: r.text }));

  const out = {
    // best_sim 语义变了：从「余弦最大值」变成「该书书分」（0.5×最好那条有效分 + 0.5×归一化书级信号）。
    // 必须报书分而不是重排分：挑书排序用的是书分，报重排分会出现「排第一的书分数比第二低」
    // （实测问简爱时 routed_books 显示成 简爱 0.117 | pride 0.151，用户必然困惑）。
    // id 是纯加法直通字段：UI 要靠它把「你问的是哪本」的候选做成可点的按钮（点了走单书问答）
    routed_books: picked.map(b => ({ id: b.bookId, title: b.book, best_sim: +Number(Math.min(1, b.bookScore)).toFixed(3) })),
    considered: considered.sort((a, b) => b.best_sim - a.best_sim),
    results,
  };
  // 没点名的问句（「这篇论文/这本书/this paper」）在「问全库」里天然没有指代对象——
  // 用户没先选书，任何排序器都只能猜。实测（probe-route5/6/10、probe-ambiguous）：
  // 「这篇论文的作者是谁」在 13 本书上冠军永远是英文小说的 Author 页（简爱 BY THE AUTHOR /
  // 福尔摩斯 Author: Arthur Conan Doyle），真正要问的那本只能排到 4~9 名；
  // 更糟的是英文问法「what is the author of this paper」会以 0.956 的高分「确信地答错」简爱
  // （因为分数差得开，用分数差判歧义根本判不出来）。
  // 所以判据不看分数差，只看「问句有没有指代对象」——没有就老实把候选书摆给用户点。
  // 这不是兜底彩蛋而是产品必需：点一下走单书问答，答案立刻准。
  if (VAGUE_REF_RE.test(question) && picked.length >= 1) out.ambiguous = true;
  if (skipped.length) out.skipped_books = skipped;
  return out;
}
