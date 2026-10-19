// V3-R5 浏览工具 fuzz：get_chapter（整章通读）/ read_range（区间读）
// 夹具：tmp 迷你库（2 章 + 无章节块 + 块号 5 处挖洞验证 empty-range）；坏库/空参/D01 短路全防
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { readChapter, readRange, readFullBook, clampChapterBlocks, clampRangeBlocks, CHAPTER_CAP, RANGE_CAP, CHAPTER_TOKEN_CAP, RANGE_TOKEN_CAP, FULL_READ_TOKEN_CAP } =
  await import("../src/lib/browse.mjs");

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg + (cond || extra === undefined ? "" : ` | ${extra}`)); cond ? pass++ : fail++; };

// ---------- 夹具：tmp 迷你库 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-browse-"));
const dbPath = path.join(tmp, "mini-book.db");
{
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT NOT NULL);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='trigram');`);
  db.prepare("INSERT INTO meta(key,value) VALUES('title','迷你测试书')").run();
  const ins = db.prepare("INSERT INTO chunks(id, chapter, page, text) VALUES (?,?,?,?)");
  // id 1~4 甲章 / 5 故意挖洞 / 6~12 乙章 / 13~14 无章节（PDF 形态）
  const rows = [
    [1, "甲篇", 1, "甲篇第一块：齊宣王問曰，可得聞乎。"],
    [2, "甲篇", 1, "甲篇第二块：仲尼之徒無道桓文之事者。"],
    [3, "甲篇", 2, "甲篇第三块：王道與霸道之辨。"],
    [4, "甲篇", 2, "甲篇第四块：保民而王，莫之能御也。"],
    [6, "乙篇", 3, "乙篇第一块：無為而無不為。"],
    [7, "乙篇", 3, "乙篇第二块：上善若水，水善利萬物而不爭。"],
    [8, "乙篇", 4, "乙篇第三块：多言數窮，不如守中。"],
    [9, "乙篇", 4, "乙篇第四块：天地不仁，以萬物為芻狗。"],
    [10, "乙篇", 5, "乙篇第五块：功遂身退，天之道也。"],
    [11, "乙篇", 5, "乙篇第六块：企者不立，跨者不行。"],
    [12, "乙篇", 6, "乙篇第七块：自見者不明，自是者不彰。"],
    [13, null, 7, "无章节块一：检索增強生成讓回答錨定原文。"],
    [14, null, 7, "无章节块二：本地書庫智能體可通讀原文。"],
  ];
  for (const r of rows) ins.run(...r);
  db.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')").run();
  db.close();
}
// 坏库：写个垃圾文件
const badPath = path.join(tmp, "broken.db");
fs.writeFileSync(badPath, "这不是一个数据库文件，just garbage bytes for fuzz");

// ---------- 1) readChapter：精确 / 前缀 / 截断续读游标 / 多命中 / not-found / 空参短路 ----------
{
  const r = readChapter(dbPath, "甲篇");
  ok(r.match_level === "exact" && r.total === 4 && r.blocks.length === 4
    && r.blocks[0].id === 1 && r.blocks[0].text.includes("齊宣王"), "readChapter 精确命中甲篇 4 块");
  ok(!r.note, "readChapter 未截断无 note");
}
{
  const r = readChapter(dbPath, "甲");
  ok(r.match_level === "prefix" && r.matched_chapter === "甲篇", "readChapter 前缀匹配降级");
  const r2 = readChapter(dbPath, "篇");
  ok(r2.match_level === "includes" && r2.matched_chapter === "甲篇"
    && /命中 2 个章节/.test(r2.note || ""), "readChapter 包含匹配多命中告知其余");
}
{
  const r = readChapter(dbPath, "乙篇", { maxBlocks: 5 });
  ok(r.total === 7 && r.blocks.length === 5 && r.blocks[4].id === 10
    && /read_range\(book, 11, …\)/.test(r.note || ""), "readChapter 截断给续读游标（id=11 起）");
}
{
  const r = readChapter(dbPath, "不存在的章");
  ok(r.error === "not-found" && Array.isArray(r.available) && r.available.includes("乙篇"), "readChapter 未命中给章节清单");
  const r2 = readChapter(dbPath, "");
  ok(r2.error === "not-found", "readChapter 空 key 短路（D01 家族）");
}
{
  const r = readChapter(dbPath, "甲篇", { maxBlocks: 999 });
  ok(r.blocks.length === 4, "readChapter maxBlocks 超上限被夹取");
}
ok(clampChapterBlocks(999) === CHAPTER_CAP && clampChapterBlocks() === CHAPTER_CAP
  && clampChapterBlocks(-3) === 1 && clampChapterBlocks(5) === 5, "clampChapterBlocks 边界夹取");
{
  const noCh = path.join(tmp, "no-chapters.db");
  const db = new Database(noCh);
  db.exec(`CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT NOT NULL);`);
  db.prepare("INSERT INTO chunks(chapter, page, text) VALUES (NULL, 1, '只有页码没有章节。')").run();
  db.close();
  const r = readChapter(noCh, "随便");
  ok(r.error === "no-chapters", "readChapter 无章节库报 no-chapters 并指路");
}

// ---------- 2) readRange：正常 / 跨洞 / 截断 / 空区间 / 坏参 / 坏库 ----------
{
  const r = readRange(dbPath, 2, 4);
  ok(r.total === 3 && r.blocks.map(b => b.id).join(",") === "2,3,4"
    && r.blocks[0].chapter === "甲篇", "readRange 连续区间 2..4 正常");
  const r2 = readRange(dbPath, 4, 2);
  ok(r2.blocks.map(b => b.id).join(",") === "2,3,4", "readRange from>to 自动交换");
}
{
  const r = readRange(dbPath, 1, 12);
  ok(r.total === 11 && !r.blocks.some(b => b.id === 5) && r.blocks[3].id === 4 && r.blocks[4].id === 6,
    "readRange 跨挖洞区间自动跳过缺失 id=5");
}
{
  const r = readRange(dbPath, 1, 12, { maxBlocks: 3 });
  ok(r.blocks.length === 3 && /已返回前 3 块/.test(r.note || "") && /read_range\(book, 4, 12\)/.test(r.note || ""),
    "readRange 过宽截断给续读游标");
  const r2 = readRange(dbPath, 100, 200);
  ok(r2.error === "empty-range" && /块号范围 1~14/.test(r2.hint || ""), "readRange 空区间给本书块号范围");
}
{
  ok(readRange(dbPath, 0, 5).error === "bad-range", "readRange from=0 拒收");
  ok(readRange(dbPath, "abc", 5).error === "bad-range", "readRange 非数字拒收");
}
ok(clampRangeBlocks(999) === RANGE_CAP && clampRangeBlocks() === RANGE_CAP
  && clampRangeBlocks(-3) === 1 && clampRangeBlocks(80) === RANGE_CAP, "clampRangeBlocks 边界夹取");
{
  const r = readRange(badPath, 1, 5);
  ok(r.error === "db-broken", "readRange 坏库报 db-broken");
  const r2 = readChapter(badPath, "甲篇");
  ok(r2.error === "db-broken", "readChapter 坏库报 db-broken");
}

// ---------- 3) V3R7-② token 闸：大章按 token 截断（块数 cap 保留作硬上限） ----------
const bigDb = path.join(tmp, "big-chapter.db");
{
  const db = new Database(bigDb);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT NOT NULL);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='trigram');`);
  db.prepare("INSERT INTO meta(key,value) VALUES('title','大章测试书')").run();
  const ins = db.prepare("INSERT INTO chunks(id, chapter, page, text) VALUES (?,?,?,?)");
  // 45 块 × 1000 英文字符 ≈ 11.25K token（>8K 闸且 >10K 全文闸）；块数 45 < cap 60——旧实现全给，新实现按 token 截
  for (let i = 1; i <= 45; i++) ins.run(i, "大章", i, ("token " + i + " ").padEnd(1000, "x"));
  db.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')").run();
  db.close();
}
{
  const r = readChapter(bigDb, "大章");
  ok(r.blocks.length < 45 && r.tokens <= CHAPTER_TOKEN_CAP && r.total === 45,
    `readChapter token 闸截断（${r.blocks.length}/45 块，${r.tokens} token ≤ ${CHAPTER_TOKEN_CAP}）`);
  ok(/token 闸/.test(r.note || "") && /read_range\(book, \d+, …\)/.test(r.note || ""),
    `readChapter 截断 note 带 token 闸事由与续读游标（${r.note?.slice(0, 60)}…）`);
  const r2 = readChapter(bigDb, "大章", { maxBlocks: 10 });
  ok(r2.blocks.length === 10 && r2.tokens <= CHAPTER_TOKEN_CAP, "readChapter maxBlocks 小于 token 闸时块数 cap 先生效");
  const r3 = readRange(bigDb, 1, 45);
  ok(r3.blocks.length < 45 && r3.tokens <= RANGE_TOKEN_CAP && /token 闸/.test(r3.note || ""),
    `readRange token 闸截断（${r3.blocks.length}/45 块，${r3.tokens} token）`);
}

// ---------- 4) V3R7-② read_full_book：小书全文 / too-big / 空书 / 坏库 ----------
{
  const r = readFullBook(dbPath);
  ok(!r.error && r.blocks.length === 13 && r.total_blocks === 13 && r.tokens > 0
    && r.blocks[0].id === 1 && r.blocks[12].id === 14, `readFullBook 小书全文端出（${r.blocks.length} 块 ≈${r.tokens} token）`);
  const big = readFullBook(bigDb);
  ok(big.error === "too-big" && big.tokens > FULL_READ_TOKEN_CAP && /get_outline/.test(big.hint || ""),
    `readFullBook 超 10K token 拒喂并指路（${big.tokens} token > ${FULL_READ_TOKEN_CAP}）`);
  const empty = path.join(tmp, "empty.db");
  const dbe = new Database(empty);
  dbe.exec("CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT NOT NULL);");
  dbe.close();
  ok(readFullBook(empty).error === "empty-book", "readFullBook 空书报 empty-book");
  ok(readFullBook(badPath).error === "db-broken", "readFullBook 坏库报 db-broken");
}

// ---------- 清理（尽力而为） ----------
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmp 残留无害 */ }

console.log(`\n===== browse-test：${pass} PASS / ${fail} FAIL =====`);
if (fail) process.exitCode = 1;
