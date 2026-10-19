// 全书地图（V3R7 第1批）：get_outline 的数据源——翻书动线的第一跳。
// 回答「这本书有几章、每章多大、从哪章读起」；与 browse 的分工：outline=看地图，browse=走路。
// 只读 chunks 表按 chapter 聚合，不碰检索/编目信号；坏库防御照 browse.mjs 同款。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import { detectLang, coeffFor, qualityFromStats } from "./token-estimate.mjs";

// 章清单返回上限：默认 100（孟子 261 章、凤凰 416 章都超）——超出给续读提示而不是闷头截断
export const OUTLINE_CAP = 100;
export const OUTLINE_MAX = 500;
export const clampOutlineChapters = (n) => Math.min(Math.max(1, Math.floor(Number(n) || OUTLINE_CAP)), OUTLINE_MAX);

const openDb = (dbPath) => { try { return new Database(dbPath, { readonly: true }); } catch { return null; } };

// 全书 token 系数：抽样 50 块判语言（与 build-book 记账同一把尺子）
function bookCoeff(db) {
  try {
    const sample = db.prepare("SELECT text FROM chunks LIMIT 50").all().map(r => r.text);
    return coeffFor(detectLang(sample));
  } catch { return 0.25; }
}

export function getOutline(dbPath, { maxChapters } = {}) {
  const cap = clampOutlineChapters(maxChapters);
  const db = openDb(dbPath);
  if (!db) return { error: "db-broken", hint: "书库文件损坏或无法打开——重新导入这本书" };
  try {
    const total = db.prepare("SELECT COUNT(*) n, SUM(length(text)) chars FROM chunks").get();
    const named = db.prepare("SELECT COUNT(*) n FROM chunks WHERE chapter IS NOT NULL AND chapter != ''").get().n;
    const avgLen = db.prepare("SELECT AVG(length(chapter)) a FROM chunks WHERE chapter IS NOT NULL AND chapter != ''").get().a;
    const quality = qualityFromStats({ total: total.n || 0, withChapter: named || 0, avgNameLen: avgLen || 0 });
    const coeff = bookCoeff(db);
    const base = {
      total_blocks: total.n || 0,
      total_tokens: Math.round((total.chars || 0) * coeff),
      chapter_quality: quality,
    };
    // 章节列不可用（PDF 无章节）：不给假地图，指路 read_range / query_book
    if (quality.verdict === "none")
      return { ...base, error: "no-chapters", hint: "该文档没有可用章节标题（PDF 定位靠页码）——用 read_range 按块号区间读，或 query_book 检索" };

    const rows = db.prepare("SELECT chapter, chapter_path, COUNT(*) blocks, SUM(length(text)) chars, MIN(id) first_id FROM chunks WHERE chapter IS NOT NULL AND chapter != '' GROUP BY chapter ORDER BY MIN(id) LIMIT ?")
      .all(cap + 1);
    const truncated = rows.length > cap;
    const chaptersTotal = db.prepare("SELECT COUNT(DISTINCT chapter) n FROM chunks WHERE chapter IS NOT NULL AND chapter != ''").get().n;
    const chapters = (truncated ? rows.slice(0, cap) : rows).map(r => ({
      name: r.chapter,
      path: r.chapter_path || r.chapter,
      blocks: r.blocks,
      tokens: Math.round((r.chars || 0) * coeff),
      first_id: r.first_id,
    }));
    const out = { ...base, chapters, shown: chapters.length, chapters_total: chaptersTotal };
    const notes = [];
    if (quality.coverage < 0.9)
      notes.push(`仅 ${Math.round(quality.coverage * 100)}% 的块带章节标记——未覆盖的块用 read_range/query_book 读`);
    if (truncated)
      notes.push(`本书共 ${chaptersTotal} 章，已列出前 ${cap} 章——其余用 read_range 按块号区间继续读`);
    if (quality.verdict === "messy")
      notes.push("章节名可能是正文片段（EPUB 通病）——按名翻章可能落空，优先用 read_range 按块号读");
    if (notes.length) out.note = notes.join("；");
    return out;
  } catch {
    return { error: "db-broken", hint: "书库文件损坏或不是有效数据库——重新导入这本书" };
  } finally { db.close(); }
}
