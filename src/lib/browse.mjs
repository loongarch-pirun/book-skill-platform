// 原文浏览工具（V3-R5）：get_chapter 整章通读 / read_range 任意区间——补「外部智能体看不到原文」缺口。
// 与 lookup 的分工：lookup=按章节名三级匹配「寻址」（cap 40）；本模块=「通读」（上限更高 + 区间游标续读）。
// V3R7-②：截断从「块数说了算」升级为「token 说了算」——章均块在不同书之间差 20 倍
// （孟子 3 块/章 vs P&P 78 块/章），块数 cap 对大块英文章形同虚设。块数 cap 保留作硬上限，
// token 闸是主闸：返回体带真实 token 账，续读游标按 token 给——模型能自己算账。
// 只读 chunks 表，不碰检索打分/复试官/编目信号；坏库防御与 D01 空参短路照 lookup.mjs 同款。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import { estimateTokens, bookTokenTotal, detectLang } from "./token-estimate.mjs";

// 上限：整章 60 块（块数硬上限）/ 区间 80 块；token 闸 8K（主闸，中英混排实测口径）
export const CHAPTER_CAP = 60;
export const RANGE_CAP = 80;
export const CHAPTER_TOKEN_CAP = 8000;
export const RANGE_TOKEN_CAP = 8000;
// 全文直读闸门：≤10K token 的书一口气端出全文（论语 0.5K/道德经 5.6K/attention 9.6K 四本受益）；
// 超限返回 too-big 并指路 get_outline + get_chapter/read_range——「权限全开」按书体量自动开关
export const FULL_READ_TOKEN_CAP = 10000;

export const clampChapterBlocks = (n) => Math.min(Math.max(1, Math.floor(Number(n) || CHAPTER_CAP)), CHAPTER_CAP);
export const clampRangeBlocks = (n) => Math.min(Math.max(1, Math.floor(Number(n) || RANGE_CAP)), RANGE_CAP);

const openDb = (dbPath) => { try { return new Database(dbPath, { readonly: true }); } catch { return null; } };

// token 闸取块：块数 cap 是硬上限，token 闸是主闸（至少保 1 块——单块超 8K 也整块给，
// 截断信息写进 note，模型用 read_range 续读）。返回 { blocks, tokens, tokenCut }
function takeWithTokenCap(rows, { blockCap, tokenCap }) {
  const blocks = [];
  let tokens = 0, tokenCut = false;
  for (const r of rows) {
    if (blocks.length >= blockCap) break;
    const t = estimateTokens(r.text);
    if (blocks.length && tokens + t > tokenCap) { tokenCut = true; break; }
    tokens += t;
    blocks.push(r);
  }
  return { blocks, tokens, tokenCut };
}

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
    const rows = db.prepare("SELECT id, page, text FROM chunks WHERE chapter = ? ORDER BY id LIMIT ?").all(matched, cap);
    const { blocks, tokens, tokenCut } = takeWithTokenCap(rows, { blockCap: cap, tokenCap: CHAPTER_TOKEN_CAP });
    const out = { chapter: raw, matched_chapter: matched, match_level: level, total, tokens, blocks };
    const notes = [];
    if (hits.length > 1)
      notes.push(`命中 ${hits.length} 个章节，已选「${matched}」（其余：${hits.slice(1, 5).join("、")}${hits.length > 5 ? "……" : ""}）`);
    if (total > blocks.length) {
      const why = tokenCut ? `本章约 ${Math.round(tokens / 100) / 10}K token 已触 ${CHAPTER_TOKEN_CAP} token 闸` : `块数上限 ${cap}`;
      notes.push(`本章共 ${total} 块，已返回前 ${blocks.length} 块（≈${tokens} token，${why}）——用 read_range(book, ${blocks.length ? blocks[blocks.length - 1].id + 1 : 1}, …) 续读`);
    }
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
    const rows = db.prepare("SELECT id, page, chapter, text FROM chunks WHERE id BETWEEN ? AND ? ORDER BY id LIMIT ?")
      .all(lo, hi, cap);
    if (!rows.length) {
      const mm = db.prepare("SELECT MIN(id) mn, MAX(id) mx FROM chunks").get();
      return { error: "empty-range", from: lo, to: hi,
        hint: `该区间没有块；本书块号范围 ${mm.mn}~${mm.mx}——先用 query_book/lookup 拿真实块号` };
    }
    const { blocks, tokens, tokenCut } = takeWithTokenCap(rows, { blockCap: cap, tokenCap: RANGE_TOKEN_CAP });
    const out = { from: lo, to: hi, tokens, blocks };
    // 截断判据：请求区间超过块数 cap（SQL 预取吃满）或 token 闸生效——挖洞区间
    // （rows 取尽但 id 不连续）不是截断，照样给 total
    if (span > cap || tokenCut) {
      const why = tokenCut ? `已触 ${RANGE_TOKEN_CAP} token 闸` : `块数上限 ${cap}`;
      out.note = `区间跨 ${span} 块，已返回前 ${blocks.length} 块（≈${tokens} token，${why}，至 id=${blocks[blocks.length - 1].id}）——用 read_range(book, ${blocks[blocks.length - 1].id + 1}, ${hi}) 续读`;
    }
    else out.total = blocks.length;
    return out;
  } catch {
    return { error: "db-broken", hint: "书库文件损坏或不是有效数据库——重新导入这本书" };
  } finally { db.close(); }
}

// 全文直读（V3R7-②）：≤10K token 的书全文端出——小书走检索是纯损耗（还可能漏），
// 全文进上下文零检索误差。超限不硬喂：返回 too-big + 体量 + 指路动线。
export function readFullBook(dbPath) {
  const db = openDb(dbPath);
  if (!db) return { error: "db-broken", hint: "书库文件损坏或无法打开——重新导入这本书" };
  try {
    const st = db.prepare("SELECT COUNT(*) n, SUM(length(text)) chars FROM chunks").get();
    if (!st.n)
      return { error: "empty-book", hint: "这本书没有内容块——重新导入或换一本书" };
    const sample = db.prepare("SELECT text FROM chunks LIMIT 50").all().map(r => r.text);
    const tokens = bookTokenTotal(st.chars || 0, detectLang(sample));
    if (tokens > FULL_READ_TOKEN_CAP)
      return { error: "too-big", tokens, cap: FULL_READ_TOKEN_CAP, total_blocks: st.n,
        hint: `本书约 ${tokens.toLocaleString()} token，超过全文直读上限 ${FULL_READ_TOKEN_CAP}——用 get_outline 看地图，再 get_chapter/read_range 翻目标章；查具体问题用 query_book` };
    const blocks = db.prepare("SELECT id, chapter, page, text FROM chunks ORDER BY id").all()
      .map(r => ({ id: r.id, chapter: r.chapter || null, page: r.page ?? null, text: r.text ?? "" }));
    return { total_blocks: st.n, tokens, blocks };
  } catch {
    return { error: "db-broken", hint: "书库文件损坏或不是有效数据库——重新导入这本书" };
  } finally { db.close(); }
}
