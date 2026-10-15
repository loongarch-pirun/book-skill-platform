// 原文浏览工具（V3-R5）：get_chapter 整章通读 / read_range 任意区间——补「外部智能体看不到原文」缺口。
// 与 lookup 的分工：lookup=按章节名三级匹配「寻址」（cap 40）；本模块=「通读」（上限更高 + 区间游标续读）。
// 只读 chunks 表，不碰检索打分/复试官/编目信号；坏库防御与 D01 空参短路照 lookup.mjs 同款。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

// 上限：整章 60 块（≈5 万字，超出走 read_range 续读）；区间 80 块
export const CHAPTER_CAP = 60;
export const RANGE_CAP = 80;

export const clampChapterBlocks = (n) => Math.min(Math.max(1, Math.floor(Number(n) || CHAPTER_CAP)), CHAPTER_CAP);
export const clampRangeBlocks = (n) => Math.min(Math.max(1, Math.floor(Number(n) || RANGE_CAP)), RANGE_CAP);

const openDb = (dbPath) => { try { return new Database(dbPath, { readonly: true }); } catch { return null; } };

// 整章通读：章节名三级匹配（精确→前缀→包含，小写比较），同级多命中取文档序第一个并告知
export function readChapter(dbPath, chapter, { maxBlocks } = {}) {
  const cap = clampChapterBlocks(maxBlocks);
  const raw = String(chapter ?? "").trim();
  const db = openDb(dbPath);
  if (!db) return { error: "db-broken", hint: "书库文件损坏或无法打开——重新导入这本书" };
  try {
    const chapters = db.prepare("SELECT chapter, MIN(id) mn FROM chunks WHERE chapter IS NOT NULL AND chapter != '' GROUP BY chapter ORDER BY mn")
      .all().map(r => r.chapter);
    if (!chapters.length)
      return { error: "no-chapters", hint: "该文档没有章节标题（PDF 定位靠页码），请用 query_book 检索或 read_range 按块号读" };
    const notFound = { error: "not-found", chapter: raw, available: chapters.slice(0, 30), available_total: chapters.length };
    if (!raw) return notFound;  // D01 家族：空串 includes("") 恒真，必须短路
    const lc = (s) => String(s).toLowerCase();
    const q = lc(raw);
    let hits = chapters.filter(c => lc(c) === q), level = "exact";
    if (!hits.length) { level = "prefix"; hits = chapters.filter(c => lc(c).startsWith(q)); }
    if (!hits.length) { level = "includes"; hits = chapters.filter(c => lc(c).includes(q)); }
    if (!hits.length) return notFound;
    const matched = hits[0];
    const total = db.prepare("SELECT COUNT(*) n FROM chunks WHERE chapter = ?").get(matched).n;
    const blocks = db.prepare("SELECT id, page, text FROM chunks WHERE chapter = ? ORDER BY id LIMIT ?").all(matched, cap)
      .map(r => ({ id: r.id, page: r.page ?? null, text: r.text ?? "" }));
    const out = { chapter: raw, matched_chapter: matched, match_level: level, total, blocks };
    const notes = [];
    if (hits.length > 1)
      notes.push(`命中 ${hits.length} 个章节，已选「${matched}」（其余：${hits.slice(1, 5).join("、")}${hits.length > 5 ? "……" : ""}）`);
    if (total > blocks.length)
      notes.push(`本章共 ${total} 块，已返回前 ${blocks.length} 块——用 read_range(book, ${blocks.length ? blocks[blocks.length - 1].id + 1 : 1}, …) 续读`);
    if (notes.length) out.note = notes.join("；");
    return out;
  } catch {
    return { error: "db-broken", hint: "书库文件损坏或不是有效数据库——重新导入这本书" };
  } finally { db.close(); }
}

// 区间读：按块号连续读（from/to 都来自其他工具结果里的 id），过宽截断并给续读游标
export function readRange(dbPath, from, to, { maxBlocks } = {}) {
  const cap = clampRangeBlocks(maxBlocks);
  const f = Math.floor(Number(from)), t = Math.floor(Number(to));
  if (!Number.isFinite(f) || !Number.isFinite(t) || f < 1 || t < 1)
    return { error: "bad-range", hint: "from/to 必须是 ≥1 的块号（query_book/lookup/get_chapter 结果里的 id）" };
  const lo = Math.min(f, t), hi = Math.max(f, t);
  const db = openDb(dbPath);
  if (!db) return { error: "db-broken", hint: "书库文件损坏或无法打开——重新导入这本书" };
  try {
    const span = hi - lo + 1;
    const blocks = db.prepare("SELECT id, page, chapter, text FROM chunks WHERE id BETWEEN ? AND ? ORDER BY id LIMIT ?")
      .all(lo, hi, cap)
      .map(r => ({ id: r.id, page: r.page ?? null, chapter: r.chapter || null, text: r.text ?? "" }));
    if (!blocks.length) {
      const mm = db.prepare("SELECT MIN(id) mn, MAX(id) mx FROM chunks").get();
      return { error: "empty-range", from: lo, to: hi,
        hint: `该区间没有块；本书块号范围 ${mm.mn}~${mm.mx}——先用 query_book/lookup 拿真实块号` };
    }
    const out = { from: lo, to: hi, blocks };
    if (span > cap)
      out.note = `区间跨 ${span} 块，已返回前 ${blocks.length} 块（至 id=${blocks[blocks.length - 1].id}）——用 read_range(book, ${blocks[blocks.length - 1].id + 1}, ${hi}) 续读`;
    else out.total = blocks.length;
    return out;
  } catch {
    return { error: "db-broken", hint: "书库文件损坏或不是有效数据库——重新导入这本书" };
  } finally { db.close(); }
}
