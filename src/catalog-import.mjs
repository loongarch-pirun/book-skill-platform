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
  let result;
  try { result = parseResultText(fs.readFileSync(resultPath, "utf8")); }
  catch (e) { console.error(`✗ ${name} 不是合法 JSON: ${e.message}`); failed++; continue; }

  // 任务书配对：先按同名约定（catalog-tasks/<同名>.json），失败则按结果里的 task_ref
  // （= 书库文件名）反查——结果文件被改过名也不至于断链。再找不到才报错并给改名指引。
  const tasksDir = path.join(process.cwd(), "catalog-tasks");
  const taskPath = path.join(tasksDir, name);
  let task = null;
  if (fs.existsSync(taskPath)) {
    task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
  } else if (result.task_ref) {
    const found = fs.readdirSync(tasksDir).filter(f => f.endsWith(".json")).map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(tasksDir, f), "utf8")); } catch { return null; }
    }).filter(Boolean).find(t => t.book?.db === result.task_ref);
    if (found) {
      const foundName = fs.readdirSync(tasksDir).filter(f => f.endsWith(".json"))
        .find(f => { try { return JSON.parse(fs.readFileSync(path.join(tasksDir, f), "utf8")).book?.db === result.task_ref; } catch { return false; } });
      console.log(`ℹ ${name} 没有同名任务书，按 task_ref=${result.task_ref} 配到 catalog-tasks/${foundName}`);
      task = found;
    }
  }
  if (!task) {
    console.error(`✗ 找不到配套任务书：结果文件与任务书按同名配对（catalog-tasks/${name}）。`);
    console.error(`  如果改过结果文件名，请改回与 catalog-tasks/ 里的任务书同名；没有任务书就先跑 catalog-export。`);
    failed++; continue;
  }
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
