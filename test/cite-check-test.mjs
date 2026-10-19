// V3R7-③ 引文回验 fuzz：cite_check（逐字命中 / 空白归一 / 未命中拒采用 / 坏库防御）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { checkCitation } = await import("../src/lib/cite-check.mjs");

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg + (cond || extra === undefined ? "" : ` | ${extra}`)); cond ? pass++ : fail++; };

// ---------- 夹具：tmp 迷你库 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-cite-"));
const dbPath = path.join(tmp, "mini-book.db");
{
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, chapter_path TEXT, page INTEGER, text TEXT NOT NULL);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='trigram');`);
  const ins = db.prepare("INSERT INTO chunks(id, chapter, chapter_path, page, text) VALUES (?,?,?,?,?)");
  ins.run(1, "学而篇", "学而篇", 1, "子曰：学而时习之，不亦说乎？有朋自远方来，不亦乐乎？");
  ins.run(2, "学而篇", "学而篇", 1, "人不知而不愠，不亦君子乎？");
  ins.run(3, "为政篇", "为政篇", 2, "吾十有五而志于学，三十而立。");
  db.close();
}
const badPath = path.join(tmp, "broken.db");
fs.writeFileSync(badPath, "这不是一个数据库文件，just garbage bytes for fuzz");

// ---------- 1) 逐字命中 ----------
{
  const r = checkCitation(dbPath, "学而时习之，不亦说乎");
  ok(r.hit && r.level === "exact" && r.chunk_id === 1 && r.chapter === "学而篇" && r.page === 1,
    `cite_check 逐字命中给块号/章节/页码（chunk#${r.chunk_id} ${r.chapter} 第${r.page}页）`);
}
// ---------- 2) 空白归一（引用带入换行/空格差异，照实标 normalized） ----------
{
  const r = checkCitation(dbPath, "学而时习之，\n 不亦  说乎");
  ok(r.hit && r.level === "normalized" && r.chunk_id === 1, "cite_check 空白归一命中且标 normalized（不冒充逐字）");
}
// ---------- 3) 未命中：明确拒采用 ----------
{
  const r = checkCitation(dbPath, "天行健，君子以自强不息。");
  ok(!r.hit && /不要采用/.test(r.hint || ""), "cite_check 未命中明确告知不要采用");
}
// ---------- 4) 边界：空引文 / 坏库 / 空书 ----------
{
  ok(checkCitation(dbPath, "").error === "empty-quote", "cite_check 空引文拒收");
  ok(checkCitation(dbPath, "   ").error === "empty-quote", "cite_check 纯空白引文拒收");
  ok(checkCitation(badPath, "学而时习之").error === "db-broken", "cite_check 坏库报 db-broken");
  const empty = path.join(tmp, "empty.db");
  const dbe = new Database(empty);
  dbe.exec("CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT NOT NULL);");
  dbe.close();
  const r = checkCitation(empty, "任何引文");
  ok(!r.hit && /不要采用/.test(r.hint || ""), "cite_check 空书未命中（不崩）");
}
// ---------- 5) 真库冒烟：论语真句子命中 / 捏造句子拒收 ----------
{
  const LUNYU = path.join(import.meta.dirname, "..", "library", "lunyu-xueer-zh.docx.db");
  if (fs.existsSync(LUNYU)) {
    const db = new Database(LUNYU, { readonly: true });
    const sample = db.prepare("SELECT text FROM chunks ORDER BY id LIMIT 1").get();
    db.close();
    const clause = String(sample.text).split(/[。；！？!?;]/).map(s => s.trim()).find(s => s.length >= 6) || String(sample.text).slice(0, 10);
    const good = checkCitation(LUNYU, clause);
    ok(good.hit && good.chunk_id === 1, `cite_check 真库原文照抄命中（chunk#${good.chunk_id}）`);
    const bad = checkCitation(LUNYU, "这本书里绝对没有的捏造句子 xyz");
    ok(!bad.hit, "cite_check 真库捏造句子拒收");
  } else {
    console.log("SKIP - 真库冒烟（lunyu 库不在）");
  }
}

// ---------- 清理 ----------
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmp 残留无害 */ }

console.log(`\n===== cite-check-test：${pass} PASS / ${fail} FAIL =====`);
if (fail) process.exitCode = 1;
