// src/backfill-summary.mjs —— 把 book-summaries.json 的简介写进各库 meta.book_summary
//
// 为什么单独一步：简介是「数据」不是「代码」（放 src/lib/book-summaries.json，
// 可审阅可 diff），但 list_books 要读的是库里的 meta。所以用回补脚本把数据搬进库。
//
// 只加 meta 键、不重切片——编目边不作废，不需要 --force，可反复跑（幂等：值相同不写）。
// 注意 build-book 整库重建会删库重写，重建后要重跑本脚本（新键不会从旧 meta 继承）。
//
// 用法:
//   node src/backfill-summary.mjs [库目录]          # 写入
//   node src/backfill-summary.mjs [库目录] --check  # 只盘点不写
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const ROOT = path.join(import.meta.dirname, "..");
const LIB = path.resolve(process.argv[2] && !process.argv[2].startsWith("--")
  ? process.argv[2]
  : path.join(ROOT, "library"));
const CHECK = process.argv.includes("--check");
const SRC = path.join(ROOT, "src", "lib", "book-summaries.json");

const all = JSON.parse(fs.readFileSync(SRC, "utf8"));
const map = Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith("_")));

let written = 0, unchanged = 0, failed = 0, missing = 0;
const ids = fs.readdirSync(LIB).filter((f) => f.endsWith(".db"));

for (const f of ids) {
  const id = f.replace(/\.db$/, "");
  let db;
  try {
    db = new Database(path.join(LIB, f), { readonly: CHECK });
    const cur = db.prepare("SELECT value FROM meta WHERE key='book_summary'").get()?.value ?? "";
    const want = (map[id] ?? "").trim();
    if (!want) {
      console.log(`  - ${id}: 没有简介条目（跳过）`);
      missing++;
      continue;
    }
    if (cur === want) { unchanged++; continue; }
    if (CHECK) { console.log(`  ~ ${id}: 待写入（当前 ${cur.length} 字 → ${want.length} 字）`); continue; }
    db.prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run("book_summary", want);
    console.log(`  ✓ ${id}: 写入 ${want.length} 字`);
    written++;
  } catch (e) {
    console.error(`  ✗ ${id}: ${e.message}`);
    failed++;
  } finally {
    try { db?.close(); } catch { /* 关失败无从补救 */ }
  }
}

console.log(`\n${CHECK ? "盘点" : "写入"}完成：写入 ${written} / 未变 ${unchanged} / 缺条目 ${missing} / 失败 ${failed}（共 ${ids.length} 本）`);
if (missing) console.log(`缺条目的书要补进 ${path.relative(ROOT, SRC)}：跑 node test/book-summary-test.mjs 看是哪几本`);
process.exit(failed || missing ? 1 : 0);
