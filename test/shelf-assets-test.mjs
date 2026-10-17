// 书架资产层单测（V3 第四波 #165 Step 1，资产/派生分层改造）：
//   safeBookId 防穿越 / resolveAsset（txt→docx 映射、同后缀优先、目录不算资产、不存在不抛错）
//   / listShelf（processed / raw / 无原件=CLI旧管线 / 坏db过滤 / 目录与杂项扩展过滤 / base 级合并不重 / 空库）
// 夹具：tmp 目录 library + books 两层，better-sqlite3 造假库（与 search.mjs 同模块，scanBooks 真扫）。
// 原则同 feedback-pool-test：纯 fs + tmp，不碰真书库；import assets.mjs 连带 search.mjs，模型懒加载不会真下。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { safeBookId, booksDirOf, resolveAsset, listShelf } = await import("../src/lib/assets.mjs");

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} - ${msg}${cond || extra === undefined ? "" : ` | ${extra}`}`);
  cond ? pass++ : fail++;
};

// ---------- 夹具 A：resolveAsset 专用（books/ 齐全，library 无库） ----------
const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-shelf-a-"));
const libA = path.join(tmpA, "library");
const booksA = path.join(tmpA, "books");
fs.mkdirSync(libA, { recursive: true });
fs.mkdirSync(booksA, { recursive: true });
fs.writeFileSync(path.join(booksA, "論語.docx"), "docx-bytes");             // 有库配对（同 base 双扩展之一）
fs.writeFileSync(path.join(booksA, "rawbook.txt"), "txt 原件，建库时转 docx、原件留 txt");
fs.writeFileSync(path.join(booksA, "both.pdf"), "pdf side");                // 同 base 双扩展
fs.writeFileSync(path.join(booksA, "both.docx"), "docx side");
fs.writeFileSync(path.join(booksA, "notes.tmp"), "杂项，不算资产");          // 非资产扩展
fs.mkdirSync(path.join(booksA, "dir.pdf"));                                  // 目录不算资产

// ---------- 夹具 B：listShelf 专用（library 有库，books/ 有原件） ----------
const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-shelf-b-"));
const libB = path.join(tmpB, "library");
const booksB = path.join(tmpB, "books");
fs.mkdirSync(libB, { recursive: true });
fs.mkdirSync(booksB, { recursive: true });
fs.writeFileSync(path.join(booksB, "論語.docx"), "docx-bytes");             // 与庫配對
fs.writeFileSync(path.join(booksB, "rawbook.txt"), "txt 原件仅入库未加工");
fs.writeFileSync(path.join(booksB, "rawpdf.pdf"), "%PDF-1.4 仅入库未加工");
fs.writeFileSync(path.join(booksB, "lunyu-xueer-zh-raw.txt"), "fetch-wikisource 上游下载产物，不是书");
{
  const db = new Database(path.join(libB, "論語.docx.db"));
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)");
  const ins = db.prepare("INSERT INTO meta(key,value) VALUES (?,?)");
  for (const [k, v] of [["title", "論語"], ["format", "docx"], ["model", "e5"], ["chunk_count", "625"], ["total_chars", "15900"], ["num_pages", "20"], ["num_chapters", "20"]]) ins.run(k, v);
  db.close();
}
{
  const db = new Database(path.join(libB, "orphan.db"));                    // 无原件=CLI/旧管线建库
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO meta(key,value) VALUES ('title','孤儿库')").run();
  db.prepare("INSERT INTO meta(key,value) VALUES ('chunk_count','12')").run();
  db.close();
}
fs.writeFileSync(path.join(libB, "broken.db"), "这不是一个数据库文件，just garbage bytes"); // 坏库

// ---------- 1) safeBookId：防穿越唯一闸门 ----------
ok(safeBookId("論語.docx") === "論語.docx" && safeBookId(" 論語.docx ") === "論語.docx", "合法 id 原样通过（去首尾空白）");
for (const bad of ["", null, undefined, "../x", "a/b", "a\\b", "..", "a..b"]) {
  ok(safeBookId(bad) === null, `拒绝非法 id：${JSON.stringify(bad)}`);
}

// ---------- 2) resolveAsset ----------
{
  const r = resolveAsset(libA, "論語.docx");
  ok(r.exists && r.ext === "docx" && r.path === path.join(booksA, "論語.docx"), "同后缀优先：論語.docx → books/論語.docx");
}
{
  // txt 书：bookId 是 <base>.docx（jobs.mjs EXT_FMT txt→docx），原件是 <base>.txt
  const r = resolveAsset(libA, "rawbook.docx");
  ok(r.exists && r.ext === "txt" && r.path === path.join(booksA, "rawbook.txt"), "txt→docx 映射：rawbook.docx 找到 books/rawbook.txt");
}
{
  ok(resolveAsset(libA, "both.pdf").path === path.join(booksA, "both.pdf")
    && resolveAsset(libA, "both.docx").path === path.join(booksA, "both.docx"), "同 base 双扩展：各归各的后缀");
}
ok(resolveAsset(libA, "../etc/passwd").path === null && !resolveAsset(libA, "a/b").exists, "防穿越：.. 与路径分隔符 → path null");
ok(!resolveAsset(libA, "dir.pdf").exists, "目录不算资产：books/dir.pdf 被 isFile 闸门拦下");
{
  const r = resolveAsset(libA, "不存在的书");
  ok(!r.exists && r.path === null && r.ext === null, "不存在 → exists false 不抛错");
}
ok(booksDirOf(libA) === booksA, "booksDirOf：libDir 上级的 books/");

// ---------- 3) listShelf：资产 ∪ 库合并 ----------
{
  const shelf = listShelf(libB);
  const byId = Object.fromEntries(shelf.map(b => [b.id, b]));

  ok(shelf.length === 4, `书架 4 条（論語/rawbook/rawpdf/orphan）：实际 ${shelf.length}`,
    shelf.map(b => b.id).join(","));

  const lun = byId["論語.docx"];
  ok(lun && lun.status === "processed" && lun.chunks === 625 && lun.title === "論語"
    && lun.asset.exists && lun.asset.ext === "docx", "processed：有库有原件，chunks/title 来自 meta");
  ok(lun.db === path.join(libB, "論語.docx.db"), "processed：db 路径指向 library/*.db");

  const raw = byId["rawbook.docx"];
  ok(raw && raw.status === "raw" && raw.db === null && raw.chunks === 0 && raw.title === "rawbook"
    && raw.format === "txt" && raw.asset.exists && raw.asset.ext === "txt", "raw：txt 原件仅入库未加工（等「开始加工」）");

  const rawp = byId["rawpdf.pdf"];
  ok(rawp && rawp.status === "raw" && rawp.format === "pdf" && rawp.chunks === 0, "raw：pdf 原件仅入库未加工");

  const orph = byId["orphan"];
  ok(orph && orph.status === "processed" && !orph.asset.exists, "无原件=CLI/旧管线建库：processed 但 asset.exists=false");

  ok(!shelf.some(b => b.id.startsWith("broken")), "坏 db 被 scanBooks 过滤，不进书架");
  ok(!shelf.some(b => b.id.startsWith("lunyu-xueer-zh-raw")), "上游中间产物 -raw.txt 不进书架（一本不变两行）");
  ok(shelf.every(b => b.asset && typeof b.asset.exists === "boolean"), "每条都挂 asset 定位结果（渲染层直接用）");
}

// ---------- 4) listShelf 过滤：目录（叫 x.pdf）与杂项扩展都不进书架；空库不炸 ----------
{
  const shelf = listShelf(libA);
  ok(shelf.every(b => b.id !== "dir.pdf" && b.title !== "dir" && b.title !== "notes"),
    "目录 dir.pdf 与杂项 notes.tmp 不进书架（isFile + 扩展双闸门）");
  ok(shelf.length === 4 && shelf.every(b => b.status === "raw"), "夹具 A 无库：4 个原件全 raw 态");
}
ok(listShelf(path.join(tmpB, "no-such-library")).length === 0, "libDir 不存在 → []");
ok(listShelf(null).length === 0, "libDir 传 null → []");

// ---------- 5) base 级合并不重：books/<base>.docx + library/<base>.db → 一条 ----------
{
  const t2 = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-shelf2-"));
  const lib2 = path.join(t2, "library");
  const books2 = path.join(t2, "books");
  fs.mkdirSync(lib2, { recursive: true });
  fs.mkdirSync(books2, { recursive: true });
  fs.writeFileSync(path.join(books2, "简爱.docx"), "docx-bytes");
  const db = new Database(path.join(lib2, "简爱.db")); // 无扩展 id（历史命名）
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO meta(key,value) VALUES ('title','简爱')").run();
  db.prepare("INSERT INTO meta(key,value) VALUES ('chunk_count','1863')").run();
  db.close();
  const shelf = listShelf(lib2);
  ok(shelf.length === 1 && shelf[0].id === "简爱" && shelf[0].status === "processed"
    && shelf[0].asset.exists && shelf[0].chunks === 1863, "base 级合并：原件与无扩展 id 库并成一条（不出现两行同一本书）");
  fs.rmSync(t2, { recursive: true, force: true });
}

// ---------- 6) 坏库句柄泄漏回归：scanBooks 过滤坏库后 tmp 目录可干净清理（EBUSY 修复锁） ----------
{
  const t3 = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-shelf3-"));
  const lib3 = path.join(t3, "library");
  fs.mkdirSync(lib3, { recursive: true });
  fs.writeFileSync(path.join(lib3, "junk.db"), "garbage");
  ok(listShelf(lib3).length === 0, "纯坏库书架为空");
  fs.rmSync(t3, { recursive: true, force: true }); // 句柄没关时这里会 EBUSY
  ok(true, "坏库过滤后 tmp 清理无 EBUSY（句柄已 close）");
}

fs.rmSync(tmpA, { recursive: true, force: true });
fs.rmSync(tmpB, { recursive: true, force: true });
console.log(`===== shelf-assets-test: ${pass} pass / ${fail} fail =====`);
process.exit(fail ? 1 : 0);
