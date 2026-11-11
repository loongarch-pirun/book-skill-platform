#!/usr/bin/env node
// 方案 A 块模型迁移 CLI（.db 迁移脚本另放，不塞进 skill-store.mjs）。
// 放 src/ 下：项目所有 CLI 工具都在 src/（clean-book.mjs / backup.mjs / embed-all.js…），
// 且 eslint.config.mjs:65 的 src/**/*.mjs 作用域才认 console/process 等 Node globals。
// 铁律：chunks 原文一字不动；回滚 = drop 五张旁挂表。
// 用法：
//   node src/migrate-blocks.mjs status  [--lib <dir>]               # 只读：列出各库三视图表状态
//   node src/migrate-blocks.mjs verify  --db <path> | --lib <dir>    # 只读：校验 migration 结果
//   node src/migrate-blocks.mjs migrate --db <path>                  # 单库迁移（幂等：已有表则跳过）
//   node src/migrate-blocks.mjs migrate --lib <dir> --confirm        # 批量迁移（必须带 --confirm）
//   node src/migrate-blocks.mjs drop    --db <path>                  # 单库回滚（DROP 五表）
//   node src/migrate-blocks.mjs drop    --lib <dir> --confirm        # 批量回滚（必须带 --confirm）
// 默认 --lib = <r3>/library。批量写操作强制 --confirm，防手滑把 18 库一次改掉。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import { migrateBlockViews, verifyBlockViews, dropBlockViews, hasBlockViews, BLOCK_VIEW_TABLES } from "./lib/block-schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LIB = path.resolve(HERE, "..", "library");

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--confirm") a.confirm = true;
    else if (t === "--db") a.db = argv[++i];
    else if (t === "--lib") a.lib = argv[++i];
    else a._.push(t);
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || "status";

function targets() {
  if (args.db) return [path.resolve(args.db)];
  const dir = path.resolve(args.lib || DEFAULT_LIB);
  if (!fs.existsSync(dir)) { console.error(`目录不存在：${dir}`); process.exit(2); }
  return fs.readdirSync(dir).filter(f => f.endsWith(".db")).sort().map(f => path.join(dir, f));
}
const files = targets();
if (!files.length) { console.log("没有找到任何 .db"); process.exit(0); }

const WRITE_BATCH = (cmd === "migrate" || cmd === "drop") && !args.db;
if (WRITE_BATCH && !args.confirm) {
  console.error("批量写操作必须带 --confirm（单库用 --db 显式指名）。已停手，未改动任何库。");
  process.exit(2);
}

let failed = 0;
for (const p of files) {
  const name = path.basename(p);
  if (!fs.existsSync(p)) { console.log(`${name}\t找不到文件`); failed++; continue; }
  const readonly = cmd === "status" || cmd === "verify";
  let db;
  try { db = new Database(p, { readonly }); }
  catch (e) { console.log(`${name}\t打开失败：${e.message}`); failed++; continue; }
  try {
    if (cmd === "status") {
      const n = hasBlockViews(db);
      const cnt = (() => { try { return db.prepare("SELECT COUNT(*) n FROM chunks").get().n; } catch { return "?"; } })();
      console.log(`${name}\tchunks=${cnt}\t三视图表=${n}/5\t${n === 0 ? "未迁移" : n === 5 ? "已迁移" : "半残(需人工处理)"}`);
    } else if (cmd === "verify") {
      const r = verifyBlockViews(db);
      console.log(`\n=== ${name} === verify ok=${r.ok} blocks=${r.blocks} term=${r.term ?? "(没跑过)"}`);
      for (const c of r.checks) console.log(`  [${c.ok === true ? "PASS" : c.ok === false ? "FAIL" : "SKIP"}] ${c.name} — ${c.detail}`);
      if (!r.ok) failed++;
    } else if (cmd === "migrate") {
      const before = hasBlockViews(db);
      if (before === 5) { console.log(`${name}\t已迁移(5/5)，跳过（幂等）`); }
      else if (before > 0) { console.log(`${name}\t半残 ${before}/5，拒绝静默覆盖，需先 drop 回滚`); failed++; }
      else {
        // book_id 从库文件名推（与 search.mjs:91 一致），不从 db.name 推——
        // 避免对备份/临时副本迁移时把 ".bak" 之类标签混进 book_id。
        const bookId = name.replace(/\.db$/i, "");
        const info = migrateBlockViews(db, { bookId });
        const v = verifyBlockViews(db);
        console.log(`${name}\t迁移完成 blocks=${info.blocks} book_id=${info.bookId} lang=${info.lang} verify=${v.ok}`);
        if (!v.ok) failed++;
      }
    } else if (cmd === "drop") {
      const before = hasBlockViews(db);
      if (before === 0) console.log(`${name}\t无三视图表，无需回滚`);
      else {
        const r = dropBlockViews(db);
        const cnt = db.prepare("SELECT COUNT(*) n FROM chunks").get().n;
        console.log(`${name}\t已 DROP ${r.dropped.length} 表，剩 ${r.remaining}/5，chunks 仍有 ${cnt} 行（原文未动）`);
      }
    } else {
      console.error(`未知命令：${cmd}`); db.close(); process.exit(2);
    }
  } catch (e) {
    console.log(`${name}\t出错：${e.message}`); failed++;
  } finally { db.close(); }
}
console.log(`\n--- ${cmd} 结束：${files.length} 个库，失败 ${failed} ---`);
console.log(`旁挂表清单：${BLOCK_VIEW_TABLES.join(", ")}`);
process.exit(failed ? 1 : 0);
