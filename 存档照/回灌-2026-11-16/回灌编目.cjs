#!/usr/bin/env node
/**
 * 回灌编目：catalog-tasks/*.json + catalog-results/*.json → library/*.db
 *
 * 背景：13 本库在 2026-11-12/13 重灌 m3 向量时丢了 LLM 编目层（nodes 只剩 book/chapter/concept，
 * person 0 个、theme_vecs 0 行），ftsliteral-test 的实体链接/别名注入 9 条断言因此长期红灯。
 * 原始素材 catalog-results（18 份）与 catalog-tasks（18 份）一直在，只是没写回库。
 *
 * 做法：按 result.task_ref 与 task.book.db 对齐（两边都是 db 文件名，无需别名映射）；
 * 只处理 library 里**确实存在**的库，其余（测试书/已删书）跳过并列名。
 *
 * importCatalog 自带幂等（先 DELETE source='llm' 的节点/边再写），可重复跑。
 *
 * 跑法：
 *   node 存档照/回灌-2026-11-16/回灌编目.cjs --dry     # 只校验不写库
 *   node 存档照/回灌-2026-11-16/回灌编目.cjs           # 真写
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createRequire } = require("node:module");

const ROOT = path.resolve(__dirname, "..", "..");
const r4require = createRequire(path.join(ROOT, "package.json"));
const Database = r4require("better-sqlite3");

const DRY = process.argv.includes("--dry");
const LIB = path.join(ROOT, "library");
const TASK_DIR = path.join(ROOT, "catalog-tasks");
const RES_DIR = path.join(ROOT, "catalog-results");

(async () => {
  // Windows 上 import() 必须给 file:// URL，直接传 C://... 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME
  const { importCatalog } = await import(pathToFileURL(path.join(ROOT, "src/lib/catalog.mjs")).href);

  const dbs = new Set(fs.readdirSync(LIB).filter((f) => f.endsWith(".db")));
  // 编目素材里的书名是旧文件名（jane-eyre-en.epub），与现在的 .db 名对不上。
  // 映射与 test/lib/book-alias.mjs 同源——那 5 本是同一批书改过名，不是不同书。
  const RENAME = {
    "jane-eyre-en.epub.db": "pg1260-简爱.epub.db",
    "sherlock-holmes-adventures-en.epub.db": "pg1661-福尔摩斯冒险史.epub.db",
    "dynamo-2007-en.pdf.db": "Dynamo-亚马逊高可用键值存储-2007.pdf.db",
    "lamport-1978-en.pdf.db": "Lamport-时间时钟与分布式系统排序-1978.pdf.db",
    "mapreduce-2004-en.pdf.db": "MapReduce-谷歌大规模分布式处理-2004.pdf.db",
  };
  const results = fs.readdirSync(RES_DIR).filter((f) => f.endsWith(".json")).sort();

  const done = [], skipped = [], failed = [];
  for (const rf of results) {
    const res = JSON.parse(fs.readFileSync(path.join(RES_DIR, rf), "utf8"));
    const taskRef = res.task_ref;
    if (!taskRef) { skipped.push(`${rf}：缺 task_ref`); continue; }
    const dbName = RENAME[taskRef] || taskRef;
    if (!dbs.has(dbName)) { skipped.push(`${rf}：library 里没有 ${dbName}（测试书或已删书）`); continue; }

    const taskPath = path.join(TASK_DIR, rf);
    if (!fs.existsSync(taskPath)) { skipped.push(`${rf}：没有对应 catalog-task`); continue; }
    const task = JSON.parse(fs.readFileSync(taskPath, "utf8"));

    const dbPath = path.join(LIB, dbName);
    const db = new Database(dbPath, { readonly: !!DRY });
    try {
      const before = nodeStats(db);
      const stats = await importCatalog(db, task, res, { dryRun: DRY });
      const after = DRY ? before : nodeStats(db);
      done.push(`${dbName}: themes=${stats.themes} persons=${stats.persons} relations=${stats.relations} mention=${stats.mention_edges} 覆盖块=${stats.covered_chunks} | person 节点 ${before.person} → ${after.person}`);
    } catch (e) {
      failed.push(`${dbName}: ${e.message.split("\n")[0]}`);
    } finally {
      try { db.close(); } catch { /* 关失败无从补救 */ }
    }
  }

  console.log(`===== 回灌编目（${DRY ? "dry-run，未写库" : "已写库"}）=====`);
  console.log(`库内 .db：${dbs.size} 本　结果文件：${results.length} 份\n`);
  for (const l of done) console.log("  写 " + l);
  if (skipped.length) { console.log("\n--- 跳过 ---"); for (const s of skipped) console.log("  - " + s); }
  if (failed.length) { console.log("\n--- 失败 ---"); for (const f of failed) console.log("  ✗ " + f); }
  console.log(`\n合计：写入 ${done.length} / 跳过 ${skipped.length} / 失败 ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})();

function nodeStats(db) {
  const q = (sql) => { try { return db.prepare(sql).get()?.c ?? 0; } catch { return 0; } };
  return {
    person: q("SELECT COUNT(*) c FROM nodes WHERE type='person'"),
    theme: q("SELECT COUNT(*) c FROM nodes WHERE type='theme'"),
    vec: q("SELECT COUNT(*) c FROM theme_vecs"),
  };
}
