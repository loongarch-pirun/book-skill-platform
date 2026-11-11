// 块模型三视图（方案 A）：chunks 原文不动，旁挂 blocks/block_orig/block_key/block_key_fts/block_pos。
// DDL 定稿依据：前置过滤-第1轮/01-耦合与改造设计.md:179-228（草案，五表逐列对齐，列与类型未改）。
// 方案 A 定案：虾虾 2026-11-12；5 本真库迁移实测见 前置过滤-施工/exp-cite-migrate/exp-cite-migrate-round2-output.txt。
// 铁律：本模块只读 chunks，绝不 UPDATE/DELETE chunks 任何一行；回滚 = DROP 五张旁挂表（设计稿 :327）。
import crypto from "node:crypto";
import path from "node:path";
import { detectLang } from "./token-estimate.mjs";

export const BLOCK_SCHEMA_VERSION = 1;
export const BLOCK_VIEW_TABLES = ["blocks", "block_orig", "block_key", "block_key_fts", "block_pos"];

// 五表 DDL 定稿。与设计稿 :187-227 一致：一个 ID 串三个视图，不是三份拷贝。
export const BLOCK_DDL = `
CREATE TABLE blocks(
  id INTEGER PRIMARY KEY,
  book_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  lang TEXT,
  dedup_of INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE block_orig(
  block_id INTEGER PRIMARY KEY REFERENCES blocks(id),
  orig_text TEXT,
  table_json TEXT,
  image_ref TEXT,
  sha16 TEXT NOT NULL
);
CREATE TABLE block_key(
  block_id INTEGER PRIMARY KEY REFERENCES blocks(id),
  key_text TEXT NOT NULL,
  emb BLOB
);
CREATE VIRTUAL TABLE block_key_fts USING fts5(
  key_text, content='block_key', content_rowid='block_id', tokenize='trigram'
);
CREATE TABLE block_pos(
  block_id INTEGER PRIMARY KEY REFERENCES blocks(id),
  chapter TEXT,
  chapter_path TEXT,
  page INTEGER,
  bbox TEXT,
  orig_block TEXT,
  sentence_no INTEGER,
  cell TEXT
);
`;

// 与 src/lib/clean.mjs:341-342 的 textHash16 同款（TAMPER 闸）：sha256 截 16 hex。
export function textHash16(text) {
  return crypto.createHash("sha256").update(String(text ?? ""), "utf8").digest("hex").slice(0, 16);
}

// book_id 与书架层一致：library 文件名去掉 .db（src/lib/search.mjs:91）。
// 调用方显式给的 fallback 优先于 db.name——迁移常作用于备份/临时副本，文件名带标签，
// 若从 db.name 推会把 ".bak"/".copy" 混进 book_id。
export function bookIdFromDb(db, fallback) {
  const nm = (typeof fallback === "string" && fallback)
    || (db && typeof db.name === "string" && db.name) || "";
  return path.basename(nm).replace(/\.db$/i, "");
}

// 已存在几张三视图表：0=未迁移，5=齐，1~4=半残（拒绝静默覆盖）。
export function hasBlockViews(db) {
  return db.prepare(
    "SELECT COUNT(*) n FROM sqlite_master WHERE type IN ('table','view') AND name IN ('blocks','block_orig','block_key','block_key_fts','block_pos')"
  ).get().n;
}

function metaValue(db, key) {
  try {
    const r = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return r ? r.value : null;
  } catch { return null; }
}

// 从本书正文挑一个出现 >=3 次的高频词做 FTS 等价性验证。
// trigram 只索引 >=3 字符窗口，2 字词（如「子曰」）MATCH 恒 0，故中文取 3 字、英文取 >=4 字母整词。
// 与 exp-cite-migrate-round2.mjs:57-73 同款——拿别的书的词会命中恒 0，等价性假通过。
export function pickVerifyTerm(db) {
  const rows = db.prepare("SELECT text FROM chunks WHERE length(text) BETWEEN 50 AND 600 ORDER BY id LIMIT 500").all();
  const cnt = new Map();
  for (const r of rows) {
    const t = String(r.text ?? "");
    for (let i = 0; i + 3 <= t.length; i++) {
      const g = t.slice(i, i + 3);
      if (/^[\u4e00-\u9fa5]{3}$/.test(g)) cnt.set(g, (cnt.get(g) || 0) + 1);
    }
    for (const w of t.toLowerCase().match(/[a-z]{4,}/g) || []) cnt.set(w, (cnt.get(w) || 0) + 1);
  }
  const cand = [...cnt.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]);
  return cand.length ? { term: cand[0][0], freq: cand[0][1] } : null;
}

// 方案 A 迁移：建五表 + 逐块填充 + rebuild FTS，全在一个事务里（任一步失败自动回到建表前）。
// 字段映射（旧库只有 text 单视图，缺失字段一律 NULL，不编造）：
//   blocks.id/seq = chunks.id；book_id = 库文件名；kind='text'（表格/图片块待新管线）；
//   lang = meta.lang ?? detectLang(抽样)，与 search.mjs:83-89 同款；created_at = meta.built_at ?? now。
//   block_orig.orig_text = chunks.text 一字不改；sha16 = textHash16；table_json/image_ref = NULL。
//   block_key.key_text = chunks.text（过渡期钥匙=原文，去噪/表格拍平行待新管线）；emb 逐字节复制，不重灌。
//   block_pos.chapter/chapter_path/page 沿用 chunks；bbox/orig_block/sentence_no/cell = NULL
//     （bbox/orig_block 待 MinerU basic 新管线；sentence_no/cell 是引文回验命中后动态算的锚，非块属性，见 3.5）。
export function migrateBlockViews(db, { bookId, lang, createdAt } = {}) {
  const existing = hasBlockViews(db);
  if (existing) throw new Error(`已存在 ${existing}/5 张三视图表，拒绝静默覆盖；如需重建先 dropBlockViews()`);
  const cols = db.prepare("PRAGMA table_info(chunks)").all().map(c => c.name);
  for (const c of ["id", "chapter", "chapter_path", "page", "text", "emb"]) {
    if (!cols.includes(c)) throw new Error(`chunks 缺列 ${c}，方案 A 前提不成立；实际列：${cols.join(",")}`);
  }
  const bid = bookId || bookIdFromDb(db);
  const lg = lang || metaValue(db, "lang") || detectLang(db.prepare("SELECT text FROM chunks LIMIT 50").all().map(r => r.text));
  const ts = createdAt || metaValue(db, "built_at") || new Date().toISOString();
  const rows = db.prepare("SELECT id, chapter, chapter_path, page, text, emb FROM chunks ORDER BY id").all();

  db.transaction(() => {
    db.exec(BLOCK_DDL);
    const insB = db.prepare("INSERT INTO blocks(id,book_id,seq,kind,lang,dedup_of,created_at) VALUES (?,?,?,?,?,?,?)");
    const insO = db.prepare("INSERT INTO block_orig(block_id,orig_text,table_json,image_ref,sha16) VALUES (?,?,?,?,?)");
    const insK = db.prepare("INSERT INTO block_key(block_id,key_text,emb) VALUES (?,?,?)");
    const insP = db.prepare("INSERT INTO block_pos(block_id,chapter,chapter_path,page,bbox,orig_block,sentence_no,cell) VALUES (?,?,?,?,?,?,?,?)");
    for (const r of rows) {
      insB.run(r.id, bid, r.id, "text", lg, null, ts);
      insO.run(r.id, r.text, null, null, textHash16(r.text));
      insK.run(r.id, r.text, r.emb ? Buffer.from(r.emb) : null);
      insP.run(r.id, r.chapter, r.chapter_path, r.page, null, null, null, null);
    }
    db.exec("INSERT INTO block_key_fts(block_key_fts) VALUES('rebuild')");
  })();
  return { bookId: bid, lang: lg, createdAt: ts, blocks: rows.length };
}

// 只读校验。判据必须能翻转：sha16 那条故意改一行原文即变 FAIL（见 selftest 负向测试）。
// ok=null = 跳过（库里挑不到验证词，标「没跑过」），不算 PASS 也不算 FAIL。
export function verifyBlockViews(db) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const n = db.prepare("SELECT COUNT(*) n FROM chunks").get().n;
  const nonEmpty = db.prepare("SELECT COUNT(*) n FROM chunks WHERE length(text) > 0").get().n;
  add("chunks 原文未动（非空 text 行数 == 总行数）", n === nonEmpty, `chunks=${n} 非空text=${nonEmpty}`);
  const present = hasBlockViews(db);
  add("五张三视图表齐全", present === 5, `找到 ${present}/5`);
  if (present !== 5) return { ok: false, checks, blocks: n, term: null };

  const cnt = t => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  for (const t of ["blocks", "block_orig", "block_key", "block_pos"]) {
    add(`${t} 行数 == chunks`, cnt(t) === n, `${cnt(t)} vs ${n}`);
  }
  const origBad = db.prepare("SELECT COUNT(*) n FROM chunks c JOIN block_orig o ON o.block_id = c.id WHERE o.orig_text IS NOT c.text").get().n;
  add("block_orig.orig_text 与 chunks.text 逐字一致", origBad === 0, `不一致 ${origBad} 行`);

  const shaRows = db.prepare("SELECT c.id, c.text, o.sha16 FROM chunks c JOIN block_orig o ON o.block_id = c.id").all();
  let shaBad = 0;
  for (const r of shaRows) if (textHash16(r.text) !== r.sha16) shaBad++;
  add("block_orig.sha16 TAMPER 闸（可翻转：改一行原文即红）", shaBad === 0, `不匹配 ${shaBad}/${shaRows.length}`);

  const keyBad = db.prepare("SELECT COUNT(*) n FROM chunks c JOIN block_key k ON k.block_id = c.id WHERE k.key_text IS NOT c.text").get().n;
  add("block_key.key_text 与 chunks.text 一致（过渡期钥匙=原文）", keyBad === 0, `不一致 ${keyBad} 行`);

  const embTotal = db.prepare("SELECT COUNT(*) n FROM chunks WHERE emb IS NOT NULL").get().n;
  const embSame = db.prepare("SELECT COUNT(*) n FROM chunks c JOIN block_key k ON k.block_id = c.id WHERE c.emb IS NOT NULL AND c.emb = k.emb").get().n;
  add("block_key.emb 与 chunks.emb 逐字节相等（不重灌不换模型）", embSame === embTotal, `${embSame}/${embTotal}`);

  const posBad = db.prepare(`SELECT COUNT(*) n FROM chunks c JOIN block_pos p ON p.block_id = c.id
    WHERE p.chapter IS NOT c.chapter OR p.chapter_path IS NOT c.chapter_path OR p.page IS NOT c.page`).get().n;
  add("block_pos 位置字段与 chunks 一致", posBad === 0, `不一致 ${posBad} 行`);

  const picked = pickVerifyTerm(db);
  if (!picked) {
    add("block_key_fts 与 chunks_fts 命中集等价", null, "没跑过：库内挑不到 >=3 次的高频词");
  } else {
    const q = `"${picked.term.replace(/"/g, '""')}"`;
    const oldSet = db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?").all(q).map(r => r.rowid).sort((a, b) => a - b);
    const newSet = db.prepare("SELECT rowid FROM block_key_fts WHERE block_key_fts MATCH ?").all(q).map(r => r.rowid).sort((a, b) => a - b);
    add(`block_key_fts 与 chunks_fts 命中集等价（词 "${picked.term}"）`,
      JSON.stringify(oldSet) === JSON.stringify(newSet), `旧 ${oldSet.length} / 新 ${newSet.length}`);
  }
  return { ok: checks.every(c => c.ok !== false), checks, blocks: n, term: picked ? picked.term : null };
}

// 回滚：只 DROP 五张旁挂表；chunks / chunks_fts / meta 一字不动（设计稿 :327）。
export function dropBlockViews(db) {
  const order = ["block_key_fts", "block_pos", "block_key", "block_orig", "blocks"];
  db.transaction(() => { for (const t of order) db.exec(`DROP TABLE IF EXISTS ${t}`); })();
  return { dropped: order, remaining: hasBlockViews(db) };
}
