// V3R7-① 全书地图 fuzz：get_outline（章清单/token 账/质量标记/cap/降级）
// 夹具：tmp 迷你库（2 章 + 无章节块 + chapter_path）；另造 messy 库（长章名）/无章库/坏库
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { getOutline, clampOutlineChapters, OUTLINE_CAP, OUTLINE_MAX } =
  await import("../src/lib/outline.mjs");
const { estimateTokens, detectLang, bookTokenTotal, chapterQuality, qualityFromStats } =
  await import("../src/lib/token-estimate.mjs");
const { configureSearch, listBooks } = await import("../src/lib/search.mjs");

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg + (cond || extra === undefined ? "" : ` | ${extra}`)); cond ? pass++ : fail++; };

// ---------- 夹具：tmp 迷你库（与 browse-test 同构：甲篇 4 块 / 乙篇 7 块 / 无章节 2 块） ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-outline-"));
const dbPath = path.join(tmp, "mini-book.db");
{
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, chapter_path TEXT, page INTEGER, text TEXT NOT NULL);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='trigram');`);
  db.prepare("INSERT INTO meta(key,value) VALUES('title','迷你测试书')").run();
  const ins = db.prepare("INSERT INTO chunks(id, chapter, chapter_path, page, text) VALUES (?,?,?,?,?)");
  const rows = [
    [1, "甲篇", "甲篇", 1, "甲篇第一块：齊宣王問曰，可得聞乎。"],
    [2, "甲篇", "甲篇", 1, "甲篇第二块：仲尼之徒無道桓文之事者。"],
    [3, "甲篇", "甲篇", 2, "甲篇第三块：王道與霸道之辨。"],
    [4, "甲篇", "甲篇", 2, "甲篇第四块：保民而王，莫之能御也。"],
    [6, "乙篇", "卷一 › 乙篇", 3, "乙篇第一块：無為而無不為。"],
    [7, "乙篇", "卷一 › 乙篇", 3, "乙篇第二块：上善若水，水善利萬物而不爭。"],
    [8, "乙篇", "卷一 › 乙篇", 4, "乙篇第三块：多言數窮，不如守中。"],
    [9, "乙篇", "卷一 › 乙篇", 4, "乙篇第四块：天地不仁，以萬物為芻狗。"],
    [10, "乙篇", "卷一 › 乙篇", 5, "乙篇第五块：功遂身退，天之道也。"],
    [11, "乙篇", "卷一 › 乙篇", 5, "乙篇第六块：企者不立，跨者不行。"],
    [12, "乙篇", "卷一 › 乙篇", 6, "乙篇第七块：自見者不明，自是者不彰。"],
    [13, null, null, 7, "无章节块一：检索增強生成讓回答錨定原文。"],
    [14, null, null, 7, "无章节块二：本地書庫智能體可通讀原文。"],
  ];
  for (const r of rows) ins.run(...r);
  db.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')").run();
  db.close();
}
// 坏库：垃圾文件
const badPath = path.join(tmp, "broken.db");
fs.writeFileSync(badPath, "这不是一个数据库文件，just garbage bytes for fuzz");

// ---------- 1) 正常库：章清单 / 顺序 / token 账 / 质量 ----------
{
  const r = getOutline(dbPath);
  ok(!r.error && r.chapters.length === 2 && r.total_blocks === 13, `getOutline 两章 + 总块数（实际 ${r.chapters?.length} 章 / ${r.total_blocks} 块）`);
  ok(r.chapters[0].name === "甲篇" && r.chapters[0].blocks === 4 && r.chapters[0].first_id === 1
    && r.chapters[1].name === "乙篇" && r.chapters[1].blocks === 7 && r.chapters[1].first_id === 6,
    "getOutline 章按文档序 + 块数 + 起始块号正确");
  ok(r.chapters[0].path === "甲篇" && r.chapters[1].path === "卷一 › 乙篇", "getOutline 带回 chapter_path 层级");
  ok(r.chapters.every(c => c.tokens > 0) && r.total_tokens >= r.chapters.reduce((a, c) => a + c.tokens, 0),
    `getOutline token 账自洽（总 ${r.total_tokens} ≥ 章和）`);
  ok(r.chapter_quality.verdict === "reliable" && r.chapter_quality.coverage > 0.8, `getOutline 质量标记 reliable（coverage ${r.chapter_quality.coverage}，名字干净不降级）`);
  ok(/85% 的块带章节标记/.test(r.note || ""), "getOutline 覆盖率不足给完整性提示（verdict 不因此降级）");
  ok(r.shown === 2 && r.chapters_total === 2, "getOutline shown/chapters_total 正确");
}

// ---------- 2) cap 夹取 + 截断提示 ----------
{
  const r = getOutline(dbPath, { maxChapters: 1 });
  ok(r.chapters.length === 1 && r.shown === 1 && r.chapters_total === 2
    && /共 2 章，已列出前 1 章/.test(r.note || ""), "getOutline maxChapters=1 截断并给总数提示");
  const r2 = getOutline(dbPath, { maxChapters: 999 });
  ok(r2.chapters.length === 2, "getOutline maxChapters 超上限被夹取（500）");
}
ok(clampOutlineChapters(999) === OUTLINE_MAX && clampOutlineChapters() === OUTLINE_CAP
  && clampOutlineChapters(-3) === 1 && clampOutlineChapters(50) === 50, "clampOutlineChapters 边界夹取");

// ---------- 3) 无章节库（PDF 形态）：优雅降级 ----------
{
  const noCh = path.join(tmp, "no-chapters.db");
  const db = new Database(noCh);
  db.exec(`CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, chapter_path TEXT, page INTEGER, text TEXT NOT NULL);`);
  db.prepare("INSERT INTO chunks(chapter, page, text) VALUES (NULL, 1, '只有页码没有章节。')").run();
  db.close();
  const r = getOutline(noCh, "随便");
  ok(r.error === "no-chapters" && r.chapter_quality.verdict === "none" && /read_range/.test(r.hint || ""),
    "getOutline 无章节库报 no-chapters 并指路 read_range");
}

// ---------- 4) messy 库：长章名（EPUB 正文片段通病）→ 警告 ----------
{
  const messy = path.join(tmp, "messy.db");
  const db = new Database(messy);
  db.exec(`CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, chapter_path TEXT, page INTEGER, text TEXT NOT NULL);`);
  const long = "I hope Mr. Bingley will like it. CHAPTER II.";
  db.prepare("INSERT INTO chunks(chapter, page, text) VALUES (?, ?, ?)").run(long, 1, "a".repeat(100));
  db.prepare("INSERT INTO chunks(chapter, page, text) VALUES (?, ?, ?)").run(long, 2, "b".repeat(100));
  db.close();
  const r = getOutline(messy);
  ok(r.chapter_quality.verdict === "messy" && /正文片段/.test(r.note || ""), "getOutline 长章名判 messy 并警告按名翻章可能落空");
}

// ---------- 5) 坏库 ----------
{
  const r = getOutline(badPath);
  ok(r.error === "db-broken", "getOutline 坏库报 db-broken");
}

// ---------- 6) token-estimate 单元 ----------
{
  ok(estimateTokens("你好世界") === Math.round(4 * 0.75), "estimateTokens 纯中文按 0.75 系数");
  ok(estimateTokens("hello world") === Math.round(11 * 0.25), "estimateTokens 纯英文按 0.25 系数");
  ok(detectLang(["这是一段中文文本", "再来一段"]) === "zh" && detectLang(["pure english text here"]) === "en",
    "detectLang 中英判别");
  ok(bookTokenTotal(710791, "en") === Math.round(710791 * 0.25), "bookTokenTotal 英文账与 P&P 实测校准值一致");
  ok(chapterQuality([{ chapter: "甲" }, { chapter: "乙" }, { chapter: null }]).verdict === "reliable"
    && chapterQuality([{ chapter: "甲" }, { chapter: null }, { chapter: null }]).verdict === "none",
    "chapterQuality 覆盖率只判 none/reliable 边界（2/3 不降级，1/3 建不了地图）");
  ok(qualityFromStats({ total: 0 }).verdict === "none" && qualityFromStats({ total: 10, withChapter: 10, avgNameLen: 5 }).verdict === "reliable",
    "qualityFromStats 空库 none / 正常 reliable");
}

// ---------- 7) listBooks 兜底：无 meta.total_tokens 的旧库现场估算 ----------
{
  const libDir = path.join(tmp, "lib");
  fs.mkdirSync(libDir);
  const oldDb = path.join(libDir, "old-book-zh.docx.db");
  const db = new Database(oldDb);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, chapter_path TEXT, page INTEGER, text TEXT NOT NULL);`);
  db.prepare("INSERT INTO meta(key,value) VALUES('title','旧书')").run();
  db.prepare("INSERT INTO meta(key,value) VALUES('format','docx')").run();
  db.prepare("INSERT INTO meta(key,value) VALUES('chunk_count','4')").run();
  db.prepare("INSERT INTO meta(key,value) VALUES('total_chars','400')").run();
  const ins = db.prepare("INSERT INTO chunks(chapter, chapter_path, page, text) VALUES (?,?,?,?)");
  for (let i = 1; i <= 4; i++) ins.run("第" + i + "章", "第" + i + "章", i, "中".repeat(100));
  db.close();
  configureSearch({ libDir });
  const books = listBooks(libDir);
  const b = books.find(x => x.id === "old-book-zh.docx");
  ok(!!b, "listBooks 扫到旧库");
  ok(b && b.total_tokens === Math.round(400 * 0.75), `listBooks 旧库现场估算 total_tokens=${b?.total_tokens}（400 字 × 0.75）`);
  ok(b && b.chapter_quality && b.chapter_quality.verdict === "reliable", `listBooks 旧库现场算 chapter_quality（${JSON.stringify(b?.chapter_quality)}）`);
}

// ---------- 清理（尽力而为） ----------
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmp 残留无害 */ }

console.log(`\n===== outline-test：${pass} PASS / ${fail} FAIL =====`);
if (fail) process.exitCode = 1;
