// 块模型三视图（方案 A）：chunks 原文不动，旁挂 blocks/block_orig/block_key/block_key_fts/block_pos。
// DDL 定稿依据：前置过滤-第1轮/01-耦合与改造设计.md:179-228（草案，五表逐列对齐，列与类型未改）。
// 方案 A 定案：虾虾 2026-11-12；5 本真库迁移实测见 前置过滤-施工/exp-cite-migrate/exp-cite-migrate-round2-output.txt。
// 铁律：本模块只读 chunks，绝不 UPDATE/DELETE chunks 任何一行；回滚 = DROP 五张旁挂表（设计稿 :327）。
// 契约 v3（解析官 3573edd）后：chunks 新增 7 个描述列，本模块按列存在性分支真读
//   （含列库搬真值、老库缺列 NULL 兜底）；五表 DDL 列未变，BLOCK_SCHEMA_VERSION 仍为 1。
//   orig_block = "<page>/<block_type>#<block_index>"（契约 §2.4，page 必须带）。
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

// 契约 v3 §2.3 的 7 个描述列。缺列不报错，读时以 NULL AS 兜底（enrich-import.mjs:25-27 同款）。
const NEW_COLS = ["kind", "bbox", "block_type", "image_path", "seq", "table_json", "block_index"];

// 方案 A 迁移：建五表 + 逐块填充 + rebuild FTS，全在一个事务里（任一步失败自动回到建表前）。
// 字段映射（契约 v3 §2.2/§2.3；一个 ID 串三视图，chunks 原文一字不动）：
//   必填 6 列：id/chapter/chapter_path/page/text/emb（emb 是契约 §4.1「建库→embed→migrate」的前提，不放宽）。
//   blocks.id = chunks.id；book_id = 库文件名；lang = meta.lang ?? detectLang；created_at = meta.built_at ?? now。
//   blocks.seq  ← chunks.seq，缺列/空值回退 chunks.id（旧库对齐期，契约 §5.2）。
//   blocks.kind ← chunks.kind，缺列/空值回退 'text'。
//   block_orig.orig_text = chunks.text 一字不改；sha16 = textHash16。
//   block_orig.table_json ← chunks.table_json（三合一 JSON，直传不再序列化）；缺列 NULL。
//   block_orig.image_ref  ← chunks.image_path（MinerU 相对路径，直传不编造）；缺列 NULL。
//     §5.3 的 assets/<book_id>/<block_id>.jpg 改写需等图片落盘小步，本轮图片不落盘故不编造目标路径。
//   block_key.key_text = chunks.text（过渡期钥匙=原文）；emb 逐字节复制，不重灌不换模型。
//   block_pos.chapter/chapter_path/page 沿用 chunks。
//   block_pos.bbox ← chunks.bbox（JSON 数组字符串）；缺列 NULL。
//   block_pos.orig_block ← "<page>/<block_type>#<block_index>"（契约 §2.4，page 必须带）；
//     page/block_type/block_index 任一缺列或为空 → NULL，不编造。
//   block_pos.sentence_no/cell = NULL（命中后动态算的锚，非块属性，设计稿 3.5 / :422）。
export function migrateBlockViews(db, { bookId, lang, createdAt } = {}) {
  const existing = hasBlockViews(db);
  if (existing) throw new Error(`已存在 ${existing}/5 张三视图表，拒绝静默覆盖；如需重建先 dropBlockViews()`);
  const cols = db.prepare("PRAGMA table_info(chunks)").all().map(c => c.name);
  for (const c of ["id", "chapter", "chapter_path", "page", "text", "emb"]) {
    if (!cols.includes(c)) throw new Error(`chunks 缺列 ${c}，方案 A 前提不成立；实际列：${cols.join(",")}`);
  }
  // 按列存在性分支：含列库读真值，老库缺列用 NULL AS 兜底。
  const opt = (c) => (cols.includes(c) ? c : `NULL AS ${c}`);
  const bid = bookId || bookIdFromDb(db);
  const lg = lang || metaValue(db, "lang") || detectLang(db.prepare("SELECT text FROM chunks LIMIT 50").all().map(r => r.text));
  const ts = createdAt || metaValue(db, "built_at") || new Date().toISOString();
  const rows = db.prepare(`SELECT id, chapter, chapter_path, page, text, emb, ${NEW_COLS.map(opt).join(", ")} FROM chunks ORDER BY id`).all();

  db.transaction(() => {
    db.exec(BLOCK_DDL);
    const insB = db.prepare("INSERT INTO blocks(id,book_id,seq,kind,lang,dedup_of,created_at) VALUES (?,?,?,?,?,?,?)");
    const insO = db.prepare("INSERT INTO block_orig(block_id,orig_text,table_json,image_ref,sha16) VALUES (?,?,?,?,?)");
    const insK = db.prepare("INSERT INTO block_key(block_id,key_text,emb) VALUES (?,?,?)");
    const insP = db.prepare("INSERT INTO block_pos(block_id,chapter,chapter_path,page,bbox,orig_block,sentence_no,cell) VALUES (?,?,?,?,?,?,?,?)");
    for (const r of rows) {
      const seq = r.seq != null ? r.seq : r.id;                 // 缺列/空值回退主键
      const kind = r.kind != null ? r.kind : "text";            // 缺列/空值回退 text
      const origBlock = (r.page != null && r.block_type != null && r.block_index != null)
        ? `${r.page}/${r.block_type}#${r.block_index}` : null; // 契约 §2.4，page 必须带
      insB.run(r.id, bid, seq, kind, lg, null, ts);
      insO.run(r.id, r.text, r.table_json ?? null, r.image_path ?? null, textHash16(r.text));
      insK.run(r.id, r.text, r.emb ? Buffer.from(r.emb) : null);
      insP.run(r.id, r.chapter, r.chapter_path, r.page, r.bbox ?? null, origBlock, null, null);
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

  // 契约 v3 §2.3 七列搬运校验（按列存在性分支）：含列库真值一致，老库缺列一律 NULL/回退（不编造）。
  // 判据可翻转：改一行 chunks 的任一新列，对应判据立刻变红。
  const ccols = db.prepare("PRAGMA table_info(chunks)").all().map(c => c.name);
  const has = (c) => ccols.includes(c);
  const seqExp = has("seq") ? "(CASE WHEN c.seq IS NOT NULL THEN c.seq ELSE c.id END)" : "c.id";
  const kindExp = has("kind") ? "(CASE WHEN c.kind IS NOT NULL THEN c.kind ELSE 'text' END)" : "'text'";
  const bboxExp = has("bbox") ? "c.bbox" : "NULL";
  const tableExp = has("table_json") ? "c.table_json" : "NULL";
  const imageExp = has("image_path") ? "c.image_path" : "NULL";
  const origExp = (has("block_type") && has("block_index"))
    ? "(CASE WHEN c.page IS NOT NULL AND c.block_type IS NOT NULL AND c.block_index IS NOT NULL THEN c.page || '/' || c.block_type || '#' || c.block_index ELSE NULL END)"
    : "NULL";
  const mapped = [
    ["blocks.seq", "SELECT COUNT(*) n FROM chunks c JOIN blocks b ON b.id = c.id WHERE b.seq IS NOT " + seqExp, has("seq") ? "含列库真值/空值回退 id" : "老库缺列回退 id"],
    ["blocks.kind", "SELECT COUNT(*) n FROM chunks c JOIN blocks b ON b.id = c.id WHERE b.kind IS NOT " + kindExp, has("kind") ? "含列库真值/空值回退 text" : "老库缺列回退 text"],
    ["block_pos.bbox", "SELECT COUNT(*) n FROM chunks c JOIN block_pos p ON p.block_id = c.id WHERE p.bbox IS NOT " + bboxExp, has("bbox") ? "含列库真值" : "老库缺列全 NULL"],
    ["block_orig.table_json", "SELECT COUNT(*) n FROM chunks c JOIN block_orig o ON o.block_id = c.id WHERE o.table_json IS NOT " + tableExp, has("table_json") ? "含列库真值" : "老库缺列全 NULL"],
    ["block_orig.image_ref", "SELECT COUNT(*) n FROM chunks c JOIN block_orig o ON o.block_id = c.id WHERE o.image_ref IS NOT " + imageExp, has("image_path") ? "含列库真值" : "老库缺列全 NULL"],
    ["block_pos.orig_block", "SELECT COUNT(*) n FROM chunks c JOIN block_pos p ON p.block_id = c.id WHERE p.orig_block IS NOT " + origExp, (has("block_type") && has("block_index")) ? "含列库 <page>/<type>#<idx>" : "老库缺列全 NULL"],
  ];
  for (const [name, sql, mode] of mapped) {
    const bad = db.prepare(sql).get().n;
    add(`v3 七列搬运 ${name}（${mode}）`, bad === 0, `不一致 ${bad} 行`);
  }

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
