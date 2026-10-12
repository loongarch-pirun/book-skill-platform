// 编目导入：校验智能体产出的编目结果 JSON → 入库（nodes/edges llm 层 + theme_vecs + meta）
// 用法:
//   node src/catalog-import.mjs catalog-results/<书名>.json --dry-run   # 只校验不入库
//   node src/catalog-import.mjs catalog-results/<书名>.json             # 校验+入库
//   node src/catalog-import.mjs --all [--dry-run]                       # catalog-results/ 全部
//   node src/catalog-import.mjs --rollback library/<书库.db>            # 整批撤销该书编目
// 校验五重：JSON 语法 / zod schema / 人物 match_names 原文验真 / cluster 全覆盖 / 引用完整性
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { importCatalog, rollbackCatalog, parseResultText } = await import("./lib/catalog.mjs");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

// 模式一：回滚
if (args.includes("--rollback")) {
  const dbPath = args[args.indexOf("--rollback") + 1];
  if (!dbPath || !fs.existsSync(dbPath)) { console.error("用法: --rollback <library/书.db>"); process.exit(1); }
  const db = require("better-sqlite3")(dbPath);
  const n = db.prepare("SELECT COUNT(*) n FROM nodes WHERE source='llm'").get().n;
  rollbackCatalog(db);
  console.log(`✓ 已回滚 ${path.basename(dbPath)}：删除 ${n} 条 llm 编目数据（rule 层与原文不动）`);
  db.close();
  process.exit(0);
}

// 模式二：导入
const resultPaths = args.includes("--all")
  ? fs.readdirSync(path.join(process.cwd(), "catalog-results")).filter(f => f.endsWith(".json")).map(f => path.join(process.cwd(), "catalog-results", f))
  : args.filter(a => !a.startsWith("--"));
if (!resultPaths.length) { console.error("用法: node src/catalog-import.mjs catalog-results/<书名>.json [--dry-run] | --all | --rollback <db>"); process.exit(1); }

let failed = 0;
for (const resultPath of resultPaths) {
  const name = path.basename(resultPath);
  const taskPath = path.join(process.cwd(), "catalog-tasks", name);
  if (!fs.existsSync(taskPath)) { console.error(`✗ 找不到配套任务书 catalog-tasks/${name}（先跑 catalog-export）`); failed++; continue; }
  const task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
  const result = parseResultText(fs.readFileSync(resultPath, "utf8"));
  const dbPath = path.join(process.cwd(), "library", task.book.db);
  if (!fs.existsSync(dbPath)) { console.error(`✗ 找不到书库 library/${task.book.db}`); failed++; continue; }

  const db = require("better-sqlite3")(dbPath);
  try {
    const stats = await importCatalog(db, task, result, { dryRun });
    if (dryRun) {
      console.log(`✓ [dry-run] ${name} 校验通过，预计入库: 主题 ${stats.themes} | 人物 ${stats.persons} | 关系 ${stats.relations} | 覆盖块 ${task.provenance.clusters} 堆`);
      for (const w of stats.warnings || []) console.log(`  ⚠ ${w}`);
    } else {
      console.log(`✓ ${name} 入库完成: 主题 ${stats.themes} | 人物 ${stats.persons} | 关系 ${stats.relations} | belongs 边 ${stats.covered_chunks} | mention 边 ${stats.mention_edges}`);
    }
  } catch (e) {
    failed++;
    console.error(`✗ ${name} 校验失败:\n${e.message || e}`);
  } finally { db.close(); }
}
process.exit(failed ? 1 : 0);
