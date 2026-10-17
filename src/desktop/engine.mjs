// 桌面端引擎桥接层：主进程（CJS）→ 引擎库（ESM）的唯一通道
// 所有 IPC 处理器只跟本模块说话；检索算法一行不碰——全部转调 lib。
// 职责（按对账审计）：configure 注入（paths.mjs 三层解析）+ getBookChunks（M1）+
// 错误人话化（M3）+ 模型进度钩子转事件（M4）。
import fs from "node:fs";
import { createRequire } from "node:module";
import { resolveDirs, writeConfig, hasConfig } from "./paths.mjs";
import { listBooks, findBook, hybridSearch, routeAndSearch, configureSearch, currentLibDir } from "../lib/search.mjs";
import { listShelf, resolveAsset, safeBookId } from "../lib/assets.mjs";
import { describeAsset } from "./book-view.mjs";
import { getCatalogSummary } from "../lib/catalog.mjs";
import { questionKeywords } from "../lib/keywords.mjs";
import { listSkills, readSkill, configureSkillStore } from "../lib/skill-store.mjs";
import { loadSkillState, setSkillEnabled } from "../lib/skill-state.mjs";
import { configureModels, setModelProgress, getEmbedder } from "../lib/models.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

let _dirs = null, _userData = null, _packaged = false;

// ---------- 初始化：三层解析 → 注入三个 lib + 回写环境变量（M2：spawn 的 CLI 子进程继承） ----------
export function init({ packaged = false, userData = null } = {}) {
  _packaged = packaged;
  _userData = userData;
  _dirs = resolveDirs({ packaged, userData });
  configureSearch({ libDir: _dirs.libDir });
  configureSkillStore({ skillsDir: _dirs.skillsDir });
  configureModels({ modelsDir: _dirs.modelsDir });
  process.env.BSP_LIB_DIR = _dirs.libDir;
  process.env.BSP_SKILLS_DIR = _dirs.skillsDir;
  process.env.BSP_MODELS_DIR = _dirs.modelsDir;
  return _dirs;
}

export function dirs() { return _dirs; }
export function isFirstRun() { return _packaged && !hasConfig(_userData); }

// 改目录（首启向导/设置）：写 config.json 后按新解析重新注入
export function applyConfig(patch) {
  if (!_userData) throw new Error("未打包态没有配置层，用环境变量 BSP_LIB_DIR 改目录");
  writeConfig(_userData, patch);
  return init({ packaged: _packaged, userData: _userData });
}

// ---------- 书架：全量书（含关掉的）+ 编目摘要 + 开关态 ----------
// 洗数据摘要（#140 书架徽标）：轻量只读——ctx 列在不在、覆盖率、标签数、三级摘要数。
// 与 enrich-job 的 auditEnrich 的区别：**不做全库指纹**（书架每次刷新都跑，指纹太贵），
// 只取徽标要显示的数字；回源率等重活走 enrich:audit 通道按需查。
function enrichSummary(dbPath) {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const cols = db.prepare("PRAGMA table_info(chunks)").all().map((c) => c.name);
      if (!cols.includes("ctx")) return { ready: false }; // 没洗过（ensureEnrichSchema 未跑）
      const covered = db.prepare("SELECT COUNT(*) c FROM chunks WHERE ctx IS NOT NULL AND ctx != ''").get().c;
      const eligible = db.prepare("SELECT COUNT(*) c FROM chunks WHERE length(text) >= 40").get().c;
      const has = (t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      const tags = has("chunk_tags") ? db.prepare("SELECT COUNT(*) c FROM chunk_tags").get().c : 0;
      const byScope = has("summaries")
        ? Object.fromEntries(db.prepare("SELECT scope, COUNT(*) c FROM summaries GROUP BY scope").all().map((r) => [r.scope, r.c]))
        : {};
      return {
        ready: true, covered, eligible,
        pct: eligible ? Math.round((covered / eligible) * 100) : 0,
        tags,
        summaries: { chunk: byScope.chunk || 0, chapter: byScope.chapter || 0, book: byScope.book || 0 },
      };
    } finally { db.close(); }
  } catch { return { ready: false }; } // 单本读失败不拖垮整个书架
}

export function booksList() {
  const libDir = currentLibDir();
  const state = loadSkillState(libDir);
  // V3 第四波 #165：listShelf 合并 books/ 原件与 library/*.db（raw=仅入库未加工）。
  // raw 书没有库：跳过编目/洗数据摘要（无表可查），skill 恒开（无技能开关可言）。
  return listShelf(libDir).map(b => {
    if (b.status === "raw") {
      return { ...b, skillEnabled: true, catalog: { cataloged: false, themes: [], persons: 0 }, enrich: { ready: false } };
    }
    let catalog = { cataloged: false, themes: [], persons: 0 };
    try {
      const s = getCatalogSummary(b.db);
      if (s.cataloged) catalog = { cataloged: true, themes: s.themes.map(t => t.name), persons: s.persons.length };
    } catch { /* 单本编目读失败不拖垮整个书架 */ }
    return { ...b, skillEnabled: state[b.id] !== false, catalog, enrich: enrichSummary(b.db) };
  });
}

export function bookCatalog(bookId) {
  const b = exactBook(bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」`);
  const out = getCatalogSummary(b.db);
  return { book: b.title, bookId: b.id, ...out };
}

// 删书第一档「移出书架」（M6 + V3 第四波 #168 两档删除）：只删库文件（含 wal/shm），
// books/ 原件保留——书架回到 raw 态，点「开始加工」即可重建，不用重新拖文件。
export function deleteBook(bookId) {
  const libDir = currentLibDir();
  const b = listBooks(libDir, { includeDisabled: true }).find(x => x.id === bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」——移出书架只删书库；只有原件的书请用「彻底删除」`);
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = b.db + suffix;
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
  setSkillEnabled(libDir, bookId, true); // 删记录，不留垃圾状态
  const hasAsset = resolveAsset(libDir, bookId).exists;
  return { deleted: bookId, removedAsset: false, note: hasAsset
    ? "已移出书架——书库文件已删，books/ 原件还在；点「开始加工」可重建"
    : "已移出书架——书库文件已删（这本没有 books/ 原件，重建要重新导入文件）" };
}

// 删书第二档「彻底删除」（V3 第四波 #168）：书库文件 + books/ 原件 + 开关记录一体删，不可恢复。
// 顺序：先删原件再删库——原件删除失败（占用/权限）时书库还完好，用户可重试；
// 存档/反馈样本联动在 ipc 层（purgeArchives 双清，与第一档同一条链路）。
export function purgeBook(bookId) {
  const libDir = currentLibDir();
  const b = listBooks(libDir, { includeDisabled: true }).find(x => x.id === bookId);
  const asset = resolveAsset(libDir, bookId);
  if (!b && !asset.exists) throw new UserError(`书库里找不到「${bookId}」`);
  const title = b?.title || String(bookId).replace(/\.[^.]+$/, "");
  if (asset.exists && asset.path) {
    try { fs.rmSync(asset.path, { force: true }); }
    catch (e) { throw new UserError(`books/ 原件删除失败（${e.message}）——书库未动，请关掉占用该文件的程序后重试`); }
  }
  if (b) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = b.db + suffix;
      if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
  }
  setSkillEnabled(libDir, bookId, true); // 删记录，不留垃圾状态
  const parts = [];
  if (b) parts.push("书库文件");
  if (asset.exists) parts.push("books/ 原件");
  return { purged: bookId, title, removedAsset: asset.exists, note: `《${title}》已彻底删除（${parts.join(" + ")}）` };
}

// ---------- 问一问：单书 / 全库（跨书检索入口） ----------
export async function ask({ bookId, question, topN = 4, skillSlug = null }) {
  const q = String(question || "");
  const n = Math.min(Math.max(1, Math.floor(Number(topN) || 4)), 20);
  let base;
  if (!bookId) {
    base = { mode: "library", ...(await routeAndSearch(q, { topN: n })) };
  } else {
    const b = findBook(bookId) || exactBook(bookId);
    if (!b) throw new UserError(`书库里找不到「${bookId}」`);
    // H3 桌面路径：关掉 skill 的书，桌面也问不到（翻书仍可看——读书是本地的，问 AI 是开关管的事）
    const st = loadSkillState(currentLibDir());
    if (st[b.id] === false) throw new UserError(`《${b.title}》的 skill 已关——去「技能开关」面板打开才能问`);
    base = { mode: "book", book: b.title, bookId: b.id, results: await hybridSearch(b.db, q, n) };
  }
  // 「用技能包回答」：技能章节作为附加参考随结果返回（见 attachSkill）
  return skillSlug ? attachSkill(base, String(skillSlug), q) : base;
}

// 技能包参考：读技能索引 → 用问题词给章节打分（与字面腿同一套抽词，不另起炉灶）→ 取 top2。
// 注意边界：这是"附加参考区"，不是新的检索腿——检索算法一行不碰，skill 匹配不上时
// 普通检索结果原样返回（matched 为空数组），UI 明示"技能包无匹配章节"。
// V3 导出：chat.mjs 的改写多路路径绕过 ask()，技能参考由编排层显式补挂。
export async function attachSkill(base, slug, question) {
  const skill = readSkill(slug);
  if (skill.error) throw new UserError(`技能包「${slug}」不存在（可去技能开关面板看有哪些）`);
  const { en, cjk } = questionKeywords(question);
  const hay = (s) => String(s || "").toLowerCase();
  const scored = [];
  for (const ch of skill.index || []) {
    const full = readSkill(slug, ch.file.split("/").pop()); // "chapters/ch01-x.md" → "ch01-x.md"
    if (full.error) continue;
    const text = hay(full.content);
    const title = hay(ch.title);
    let score = 0;
    for (const w of en) if (text.includes(w)) score += 2;   // 英文整词命中权重高
    for (const g of cjk) score += (title.includes(g) ? 2 : 0) + (text.includes(g) ? 1 : 0);
    scored.push({ file: ch.file, title: ch.title, score, tokens_est: ch.tokens_est, content: full.content });
  }
  scored.sort((a, b) => b.score - a.score);
  const matched = scored.filter(s => s.score > 0).slice(0, 2);
  return { ...base, skill: { slug, chapters_total: (skill.index || []).length, matched } };
}

// ---------- 翻书：目录 + 原文块（M1：lib 无此 API，这里自建，不污染 lib） ----------
// ---------- 原书视图（V3 #166）：book:// 协议 + 系统打开 ----------
// bookOriginal：原件元信息（存在性/格式/大小/展示方式）——渲染层按 render 分流
// bookAssetPath：原件绝对路径——只给 book:openExternal 用（shell.openPath 要真路径），
//   不走 IPC 回渲染层（路径不外泄）；不存在/不合法抛 UserError 走统一错误包装
export function bookOriginal(bookId) {
  const d = describeAsset(currentLibDir(), bookId);
  if (!d.ok) throw new UserError(d.error);
  return d.data;
}

export function bookAssetPath(bookId) {
  const id = safeBookId(bookId);
  if (!id) throw new UserError("书名不合法");
  const asset = resolveAsset(currentLibDir(), id);
  if (!asset.exists) throw new UserError(`《${id}》没有原件文件（books/ 里找不到）`);
  return asset.path;
}

export function readerChapters(bookId) {
  const b = exactBook(bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」`);
  const db = new Database(b.db, { readonly: true });
  try {
    const rows = db.prepare("SELECT id, chapter FROM chunks ORDER BY id").all();
    const chapters = [], idx = new Map();
    for (const r of rows) {
      const name = r.chapter || "未分章";
      if (!idx.has(name)) { idx.set(name, chapters.length); chapters.push({ name, blocks: 0, firstId: r.id }); }
      chapters[idx.get(name)].blocks++;
    }
    return { book: b.title, bookId: b.id, chapters };
  } finally { db.close(); }
}

export function readerBlock(bookId, chapter) {
  const b = exactBook(bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」`);
  const db = new Database(b.db, { readonly: true });
  try {
    const sql = chapter === "未分章"
      ? "SELECT id, page, text FROM chunks WHERE chapter IS NULL OR chapter='' ORDER BY id"
      : "SELECT id, page, text FROM chunks WHERE chapter = ? ORDER BY id";
    const rows = chapter === "未分章" ? db.prepare(sql).all() : db.prepare(sql).all(chapter);
    return { book: b.title, bookId: b.id, chapter, blocks: rows.map((r, i) => ({ n: i + 1, id: r.id, page: r.page, text: r.text })) };
  } finally { db.close(); }
}

// 按 chunk id 反查所在章节（问一问的引用徽标点击 → 跳翻书对应块用）
export function locateChunk(bookId, chunkId) {
  const b = exactBook(bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」`);
  const db = new Database(b.db, { readonly: true });
  try {
    const r = db.prepare("SELECT chapter FROM chunks WHERE id = ?").get(Number(chunkId));
    return { chapter: r ? (r.chapter || "未分章") : null };
  } finally { db.close(); }
}

// ---------- 翻书·编目资产（M1 同款：lib 没有"按主题/人物取块"的浏览 API，这里自建） ----------
// 主题分区：llm 编目层 themes + 每个主题的代表块预览（点主题 → readerThemeBlocks 看全文）
export function readerThemes(bookId) {
  const b = exactBook(bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」`);
  const db = new Database(b.db, { readonly: true });
  try {
    const themes = db.prepare("SELECT name, ref FROM nodes WHERE type='theme' AND source='llm' ORDER BY rowid").all();
    if (!themes.length) return { book: b.title, bookId: b.id, themes: [] };
    const belongs = db.prepare("SELECT src FROM edges WHERE kind='belongs' AND dst=? ORDER BY rowid LIMIT 5");
    const get = db.prepare("SELECT id, chapter, text FROM chunks WHERE id = ?");
    return {
      book: b.title, bookId: b.id,
      themes: themes.map(t => {
        let note = "";
        try { note = JSON.parse(t.ref || "{}").note || ""; } catch { /* ref 损坏不当成主题坏 */ }
        const representatives = belongs.all(t.name).map(r => {
          const c = get.get(+r.src);
          return c ? { chunk: c.id, chapter: c.chapter || "", preview: (c.text || "").slice(0, 60) } : null;
        }).filter(Boolean);
        return { name: t.name, note, representatives };
      }),
    };
  } finally { db.close(); }
}

// 主题代表块全文（翻书区"按主题逛"的落点）
export function readerThemeBlocks(bookId, theme) {
  const b = exactBook(bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」`);
  const db = new Database(b.db, { readonly: true });
  try {
    const ids = db.prepare("SELECT src FROM edges WHERE kind='belongs' AND dst=? ORDER BY rowid LIMIT 5").all(String(theme)).map(r => +r.src);
    if (!ids.length) return { book: b.title, bookId: b.id, theme, blocks: [] };
    const get = db.prepare("SELECT id, page, chapter, text FROM chunks WHERE id = ?");
    const blocks = ids.map(id => get.get(id)).filter(Boolean)
      .map((r, i) => ({ n: i + 1, id: r.id, page: r.page, chapter: r.chapter || "", text: r.text }));
    return { book: b.title, bookId: b.id, theme, blocks };
  } finally { db.close(); }
}

// 人物表：身份注记 / 书中写法 / 出场块数（吃 importCatalog 写进 nodes.ref 的编目数据）
export function readerPersons(bookId) {
  const b = exactBook(bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」`);
  const db = new Database(b.db, { readonly: true });
  try {
    const rows = db.prepare("SELECT name, ref FROM nodes WHERE type='person' AND source='llm' ORDER BY rowid").all();
    return {
      book: b.title, bookId: b.id,
      persons: rows.map(p => {
        let info = {};
        try { info = JSON.parse(p.ref || "{}"); } catch { /* 同上 */ }
        return { name: p.name, note: info.note || "", match_names: info.match_names || [], mention_count: info.mention_count || 0 };
      }),
    };
  } finally { db.close(); }
}

// 人物出场块：name + match_names 全文 instr 扫描（与 validateResult 防幻觉校验同一招式），封顶 50 块
export function readerPersonBlocks(bookId, person) {
  const b = exactBook(bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」`);
  const db = new Database(b.db, { readonly: true });
  try {
    const row = db.prepare("SELECT ref FROM nodes WHERE type='person' AND source='llm' AND name=?").get(String(person));
    if (!row) throw new UserError(`编目里没有人物「${person}」`);
    let info = {};
    try { info = JSON.parse(row.ref || "{}"); } catch { /* ref 坏 → 只按名字查 */ }
    const names = [String(person), ...(info.match_names || [])].filter(Boolean);
    const hit = new Map();
    for (const n of names) {
      for (const r of db.prepare("SELECT id, page, chapter, text FROM chunks WHERE instr(lower(text), lower(?)) > 0 ORDER BY id LIMIT 50").all(n)) {
        if (!hit.has(r.id)) hit.set(r.id, r);
      }
    }
    const blocks = [...hit.values()].sort((a, b2) => a.id - b2.id).slice(0, 50)
      .map((r, i) => ({ n: i + 1, id: r.id, page: r.page, chapter: r.chapter || "", text: r.text }));
    return { book: b.title, bookId: b.id, person, blocks };
  } finally { db.close(); }
}

// ---------- 技能：list/read/toggle ----------
export function skillsList() { return listSkills(); }
export function skillRead(slug, chapter) { return readSkill(slug, chapter); }
export function skillToggle(bookId, enabled) {
  return setSkillEnabled(currentLibDir(), bookId, !!enabled);
}

// ---------- 引擎状态 + 模型进度（M4） ----------
export function engineStatus() {
  return {
    dirs: _dirs,
    rerank: process.env.BSP_RERANK !== "0",
    catalog: process.env.BSP_CATALOG !== "0",
    ftsKw: process.env.BSP_FTS_KW !== "0",
  };
}

// 订阅模型下载进度（首启向导用）；返回退订函数
export function onModelProgress(fn) {
  setModelProgress(fn);
  return () => setModelProgress(null);
}

// 预热：触发嵌入模型下载/加载（reranker 首次提问时才下，574MB——向导要提示）
export async function warmup() {
  const embed = await getEmbedder();
  return { model: embed.id, dim: embed.dim };
}

// ---------- 内部工具 ----------
function exactBook(bookId) {
  const q = String(bookId || "").toLowerCase();
  return listBooks(undefined, { includeDisabled: true })
    .find(b => b.id === bookId || b.id.toLowerCase() === q || b.title === bookId) || null;
}

// M3：错误人话化——UI 不崩，且告诉用户怎么修
export class UserError extends Error {
  constructor(msg, code = "user") { super(msg); this.code = code; }
}

export function humanizeError(e) {
  const m = String((e && e.message) || e);
  if (/引擎不一致|维度不一致/.test(m)) return { code: "engine-mismatch", message: m }; // 原文已带修复指引
  if (/ENOENT|no such file/i.test(m)) return { code: "db-missing", message: "书库文件不见了（可能被移走或删除）" };
  if (e instanceof UserError) return { code: e.code, message: m };
  return { code: "unknown", message: m };
}
