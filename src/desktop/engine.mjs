// 桌面端引擎桥接层：主进程（CJS）→ 引擎库（ESM）的唯一通道
// 所有 IPC 处理器只跟本模块说话；检索算法一行不碰——全部转调 lib。
// 职责（按对账审计）：configure 注入（paths.mjs 三层解析）+ getBookChunks（M1）+
// 错误人话化（M3）+ 模型进度钩子转事件（M4）。
import fs from "node:fs";
import { createRequire } from "node:module";
import { resolveDirs, writeConfig, hasConfig } from "./paths.mjs";
import { listBooks, findBook, hybridSearch, routeAndSearch, configureSearch, currentLibDir } from "../lib/search.mjs";
import { getCatalogSummary } from "../lib/catalog.mjs";
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
export function booksList() {
  const libDir = currentLibDir();
  const state = loadSkillState(libDir);
  return listBooks(libDir, { includeDisabled: true }).map(b => {
    let catalog = { cataloged: false, themes: [], persons: 0 };
    try {
      const s = getCatalogSummary(b.db);
      if (s.cataloged) catalog = { cataloged: true, themes: s.themes.map(t => t.name), persons: s.persons.length };
    } catch { /* 单本编目读失败不拖垮整个书架 */ }
    return { ...b, skillEnabled: state[b.id] !== false, catalog };
  });
}

export function bookCatalog(bookId) {
  const b = exactBook(bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」`);
  const out = getCatalogSummary(b.db);
  return { book: b.title, bookId: b.id, ...out };
}

// 删书（M6）：只删库文件（含 wal/shm），books/ 原始书保留；开关记录一并清掉
export function deleteBook(bookId) {
  const libDir = currentLibDir();
  const b = listBooks(libDir, { includeDisabled: true }).find(x => x.id === bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」`);
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = b.db + suffix;
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
  setSkillEnabled(libDir, bookId, true); // 删记录，不留垃圾状态
  return { deleted: bookId, note: "只删了书库文件，books/ 里的原始书保留（可重新导入）" };
}

// ---------- 问一问：单书 / 全库（跨书检索入口） ----------
export async function ask({ bookId, question, topN = 4 }) {
  const n = Math.min(Math.max(1, Math.floor(Number(topN) || 4)), 20);
  if (!bookId) {
    const out = await routeAndSearch(String(question || ""), { topN: n });
    return { mode: "library", ...out };
  }
  const b = findBook(bookId) || exactBook(bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」`);
  const results = await hybridSearch(b.db, String(question || ""), n);
  return { mode: "book", book: b.title, bookId: b.id, results };
}

// ---------- 翻书：目录 + 原文块（M1：lib 无此 API，这里自建，不污染 lib） ----------
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
