// 阶段1 验收：四库抽查定位 + 原文完整性 + FTS 全库可检索
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const path = require("node:path");
const LIB = path.join(process.env.USERPROFILE, "Desktop", "book-skill-platform", "library");

let failed = 0;
const assert = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (!cond) failed++; };
const fts = (db, q) => db.prepare(`SELECT c.id, c.chapter, c.page, c.text FROM chunks_fts f JOIN chunks c ON c.id=f.rowid WHERE chunks_fts MATCH ?`).all(q);

// ===== 1. 中文 PDF（论语）：页码定位 =====
{
  const db = new Database(path.join(LIB, "lunyu-xueer-zh.pdf.db"), { readonly: true });
  const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
  assert(meta.format === "pdf" && meta.num_pages === "4", `中文PDF meta: 4页/${meta.chunk_count}块`);
  const a = fts(db, '"不患人之不己知"');
  assert(a.length === 1 && a[0].page === 4, `抽查"不患人之不己知"→第${a[0]?.page}页（预期4）`);
  const b = fts(db, '"學而時習之"');
  assert(b.length >= 1 && b[0].page === 1, `抽查"學而時習之"→第${b[0]?.page}页（预期1）`);
  const all16 = db.prepare("SELECT COUNT(*) n FROM chunks WHERE text LIKE '%第%'").get().n;
  const chs = db.prepare("SELECT text FROM chunks").all().map(r => r.text).join("");
  const chCount = (chs.match(/第\d+章/g) || []).length;
  assert(chCount === 16, `16个章句全部在库中（找到${chCount}个章标）`);
  db.close();
}

// ===== 2. 中文 DOCX（论语）：章节定位 =====
{
  const db = new Database(path.join(LIB, "lunyu-xueer-zh.docx.db"), { readonly: true });
  const n = db.prepare("SELECT COUNT(*) n FROM chunks").get().n;
  assert(n === 16, `DOCX 16块/16章（实际${n}）`);
  const a = fts(db, '"吾日三省吾身"');
  assert(a.length === 1 && a[0].chapter === "第4章", `抽查"吾日三省吾身"→${a[0]?.chapter}（预期第4章）`);
  const b = fts(db, '"如切如磋"');
  assert(b.length === 1 && b[0].chapter === "第15章", `抽查"如切如磋"→${b[0]?.chapter}（预期第15章）`);
  // 原文完整性：DOCX 与 TXT 原文逐字符一致（去章标前缀后）
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(LIB, "..", "books", "lunyu-xueer-zh.txt"), "utf8");
  const srcLines = src.split("\n").map(s => s.trim()).filter(Boolean);
  const dbTexts = db.prepare("SELECT text FROM chunks ORDER BY id").all().map(r => r.text.replace(/^第\d+章\s*/, ""));
  let mismatch = 0;
  for (let i = 0; i < srcLines.length; i++)
    if (dbTexts[i] !== srcLines[i]) { mismatch++; console.log("   差异@", i + 1, JSON.stringify(dbTexts[i]), "!=", JSON.stringify(srcLines[i])); }
  assert(mismatch === 0, `DOCX 16章原文与源文件逐字比对：${srcLines.length}句全部一致`);
  db.close();
}

// ===== 3. 英文 PDF（arxiv）：页码定位 =====
{
  const db = new Database(path.join(LIB, "attention-is-all-you-need-en.pdf.db"), { readonly: true });
  const a = fts(db, '"multi-head attention"');
  assert(a.length >= 1, `英文抽查"multi-head attention"命中 ${a.length} 块`);
  const p1 = fts(db, '"Attention Is All You Need"');
  assert(p1.some(r => r.page === 1), `标题在第1页 ✓`);
  const n = db.prepare("SELECT COUNT(*) n FROM chunks").get().n;
  assert(n >= 40, `英文PDF切片量合理：${n} 块`);
  db.close();
}

// ===== 4. 英文 EPUB（傲慢与偏见）：章节定位 =====
{
  const db = new Database(path.join(LIB, "pride-and-prejudice-en.epub.db"), { readonly: true });
  const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
  assert(meta.num_chapters === "16" && meta.chunk_count === "2210", `epub meta: ${meta.num_chapters}章/${meta.chunk_count}块/${meta.total_chars}字符`);
  const a = fts(db, '"Mr. Bennet"');
  assert(a.length >= 1 && a[0].chapter, `英文epub抽查"Mr. Bennet"→章节「${a[0]?.chapter}」`);
  const b = fts(db, '"Pemberley"');
  assert(b.length >= 1, `英文epub抽查"Pemberley"命中 ${b.length} 块（可跨章检索）`);
  db.close();
}

console.log("\n===== 阶段1 验收结果 =====");
if (failed > 0) { console.log(`${failed} 项 FAIL`); process.exit(1); }
console.log("全部 PASS：四库抽查定位准、原文逐字一致、全库 FTS 可检索");
