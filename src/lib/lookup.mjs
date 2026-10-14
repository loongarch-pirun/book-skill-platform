// 章节直达（MCP lookup 工具）：按章节标题/编号三级匹配（精确→前缀→包含）直达该章全部原文块。
// 定位分工：「查错误码/条款号/流程步骤标题」→ lookup 精确直达；「查概念/情节/术语解释」→ query_book。
// 与 hybridSearch/similarChunks 平行的一条独立路：纯浏览查询，不碰混合检索/复试官/编目信号
// （检索层零改动）；只读 chunks 表，不依赖编目层（nodes/edges）——未编目的工作资料也能寻址。
// 块查询参照 src/desktop/engine.mjs readerBlock 的 `WHERE chapter = ? ORDER BY id` 同语义 SQL
// （补 LIMIT 与 COUNT：一章可能几百块，截断必须有说明）。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

// 与 MCP 侧 schema 1..40 对齐；候选章节清单封顶（智能体的"目录导航"，一屏能装下）
export const MAX_BLOCKS = 40;
const AVAILABLE_CAP = 30;

// maxBlocks 双层防呆：zod 1..40 + 此处兜底夹取（0/NaN 落默认 20，与 clampTopN 同款语义）
export const clampMaxBlocks = (n) => Math.min(Math.max(1, Math.floor(Number(n) || 20)), MAX_BLOCKS);

export function lookupEntry(dbPath, key, { maxBlocks = 20 } = {}) {
  const maxB = clampMaxBlocks(maxBlocks);
  const raw = String(key ?? "").trim();
  // 坏库双重兜底（与 similarChunks 同款）：new Database 打开不抛、首次 prepare 才抛 SQLITE_NOTADB
  let db;
  try { db = new Database(dbPath, { readonly: true }); }
  catch { return { error: "db-broken", hint: "书库文件损坏或无法打开——重新导入这本书" }; }
  try {
    // 章节清单：非空 chapter 去重，按首次出现块号排序（= 文档顺序，目录导航的顺序）
    const chapters = db.prepare("SELECT chapter, MIN(id) mn FROM chunks WHERE chapter IS NOT NULL AND chapter != '' GROUP BY chapter ORDER BY mn")
      .all().map(r => r.chapter);
    if (!chapters.length)
      return { error: "no-chapters", hint: "该文档没有章节标题（PDF 定位靠页码），请用 query_book 检索" };
    const notFound = { error: "not-found", key: raw, available: chapters.slice(0, AVAILABLE_CAP), available_total: chapters.length };
    // 空 key 必须短路（D01 家族：空串的 includes("") 恒真会命中第一章——"精确直达"幻觉入口）
    if (!raw) return notFound;
    // 三级匹配（学 matchNode 逐级降级：命中即返回，不再降级）；统一小写比较——
    // 错误码/英文标题大小写易变（"e1001" 该命中 "E1001 连接超时"），CJK 无感
    const lc = (s) => String(s).toLowerCase();
    const q = lc(raw);
    let level = "exact", hits = chapters.filter(c => lc(c) === q);
    if (!hits.length) { level = "prefix"; hits = chapters.filter(c => lc(c).startsWith(q)); }
    if (!hits.length) { level = "includes"; hits = chapters.filter(c => lc(c).includes(q)); }
    if (!hits.length) return notFound;
    const matched = hits[0];  // 同级多命中取文档序第一个，note 告知其余（不骗"精确命中"）
    const total = db.prepare("SELECT COUNT(*) n FROM chunks WHERE chapter = ?").get(matched).n;
    const blocks = db.prepare("SELECT id, page, text FROM chunks WHERE chapter = ? ORDER BY id LIMIT ?").all(matched, maxB)
      .map(r => ({ id: r.id, page: r.page ?? null, text: r.text ?? "" }));
    const out = { key: raw, matched_chapter: matched, match_level: level, total, blocks };
    const notes = [];
    if (hits.length > 1)
      notes.push(`${{ exact: "精确", prefix: "前缀", includes: "包含" }[level]}匹配命中 ${hits.length} 个章节，已选「${matched}」（其余：${hits.slice(1, 5).join("、")}${hits.length > 5 ? "……" : ""}）`);
    if (total > blocks.length)
      notes.push(`本章共 ${total} 块，已按上限显示前 ${blocks.length} 块`);
    if (notes.length) out.note = notes.join("；");
    return out;
  } catch {
    // 与 similarChunks 同款：坏库（打开层不抛、查询才抛）整包兜
    return { error: "db-broken", hint: "书库文件损坏或不是有效数据库——重新导入这本书" };
  } finally { db.close(); }
}
