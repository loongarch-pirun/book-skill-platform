// 编目导出：聚堆 → 生成"编目任务书"（给云端智能体读）
// 用法:
//   node src/catalog-export.mjs <book.db> [--th 0.38] [--min 5] [--max-clusters 0]
//   node src/catalog-export.mjs --all          # library/ 下全部库
// 输出: catalog-tasks/<书名>.json
// 闭环: 本脚本 → 智能体读任务书产 catalog-results/<书名>.json → catalog-import.mjs 入库
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { clusterChunks, buildTask } = await import("./lib/catalog.mjs");

const args = process.argv.slice(2);
const all = args.includes("--all");
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? +args[i + 1] : dflt; };
const TH = opt("--th", 0.38), MIN = opt("--min", 5), MAXC = opt("--max-clusters", 0);
const targets = all
  ? fs.readdirSync(path.join(process.cwd(), "library")).filter(f => f.endsWith(".db")).map(f => path.join(process.cwd(), "library", f))
  : args.filter(a => !a.startsWith("--"));
if (!targets.length) { console.error("用法: node src/catalog-export.mjs <book.db> [--th 0.38] [--min 5] [--max-clusters N] | --all"); process.exit(1); }

const outDir = path.join(process.cwd(), "catalog-tasks");
fs.mkdirSync(outDir, { recursive: true });

for (const dbPath of targets) {
  if (!fs.existsSync(dbPath)) { console.error(`找不到 ${dbPath}`); process.exit(1); }
  const db = new Database(dbPath, { readonly: true });
  const nEmb = db.prepare("SELECT COUNT(*) c FROM chunks WHERE emb IS NOT NULL").get().c;
  if (!nEmb) { console.error(`✗ ${path.basename(dbPath)} 还没有向量，先跑: node src/embed-book.js <书库>`); db.close(); continue; }

  const t0 = Date.now();
  const clusterRes = clusterChunks(db, { th: TH, minSize: MIN, maxClusters: MAXC });
  const task = buildTask(db, clusterRes);
  db.close();

  const outName = path.basename(dbPath).replace(/\.db$/, "") + ".json";
  const outPath = path.join(outDir, outName);
  fs.writeFileSync(outPath, JSON.stringify(task, null, 1), "utf8");

  const pct = clusterRes.total ? Math.round(clusterRes.covered / clusterRes.total * 100) : 0;
  console.log(`✓ ${outName}`);
  console.log(`  聚类: ${clusterRes.method} | ${clusterRes.clusters.length} 堆 | 覆盖 ${clusterRes.covered}/${clusterRes.total} 块 (${pct}%) | ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  任务书: ${outPath}`);
}
console.log(`
下一步（编目闭环）:
  1. 读 catalog-tasks/ 里的任务书（含 instructions 字段的严格要求）
  2. 按要求产出单个 JSON（themes/persons/relations/assignments），存到 catalog-results/<同名>.json
  3. 校验+入库: node src/catalog-import.mjs catalog-results/<同名>.json --dry-run 先看校验，去掉 --dry-run 正式入库`);
