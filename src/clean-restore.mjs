// 隔离账恢复 CLI（clean-book G5 安全网的另一半）：清洗删错的块从 quarantine 原样插回主库。
// 用法:
//   node src/clean-restore.mjs <book.db> --list            # 只读列出隔离账
//   node src/clean-restore.mjs <book.db> --dry-run --all   # 预演（不改库）
//   node src/clean-restore.mjs <book.db> --ids 12,34       # 恢复指定块
//   node src/clean-restore.mjs <book.db> --all             # 全部恢复
// 恢复后这些块还没有向量（emb NULL）——重跑「开始加工」即可补齐（embed 幂等）。
import fs from "node:fs";
import path from "node:path";
import { restoreClean } from "./lib/clean-import.mjs";

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith("--"));
const dbPath = positional[0];
if (!dbPath || !fs.existsSync(dbPath)) {
  console.error("用法: node src/clean-restore.mjs <book.db> [--list] [--dry-run] [--ids 12,34] [--all]");
  process.exit(1);
}
if (!fs.existsSync(dbPath)) { console.error(`找不到 ${dbPath}`); process.exit(1); }

const list = args.includes("--list");
const dryRun = args.includes("--dry-run");
const all = args.includes("--all");
const idsFlag = args.find(a => a.startsWith("--ids"));
const ids = idsFlag
  ? (args[args.indexOf("--ids") + 1] || (idsFlag.includes("=") ? idsFlag.split("=")[1] : ""))
    .split(",").map(s => +s.trim()).filter(Number.isInteger)
  : null;

if (list) {
  // 只读列表：直接借用 restoreClean 的 dryRun 通道（同一查询路径，不重复实现）
  const r = restoreClean(dbPath, { all: true, dryRun: true });
  if (!r.ok) { console.error(`✗ ${r.message}`); process.exit(1); }
  if (!r.candidates.length) { console.log("隔离账为空——没有待恢复的块。"); process.exit(0); }
  console.log(`隔离账共 ${r.candidates.length} 块：`);
  for (const c of r.candidates) {
    console.log(`  #${c.chunk_id} [${c.cat}] ${c.chars}字 · ${c.chapter || "-"} · ${c.reason.slice(0, 50)}`);
  }
  console.log(`\n恢复: node src/clean-restore.mjs ${path.basename(dbPath)} --ids ${r.candidates.slice(0, 5).map(c => c.chunk_id).join(",")}（或 --all）`);
  process.exit(0);
}

if (!all && !ids?.length) {
  console.error("要 --list / --dry-run --all / --ids 12,34 / --all 之一（不指定范围不许恢复）");
  process.exit(1);
}
const r = restoreClean(dbPath, { ids, all, dryRun });
if (!r.ok) { console.error(`✗ ${r.message}`); process.exit(1); }
if (r.dryRun) {
  console.log(`预演：将恢复 ${r.candidates.length} 块（--dry-run 不改库）：`);
  for (const c of r.candidates.slice(0, 20)) console.log(`  #${c.chunk_id} [${c.cat}] ${c.reason.slice(0, 50)}`);
  if (r.candidates.length > 20) console.log(`  …等 ${r.candidates.length} 块`);
  process.exit(0);
}
console.log(`✓ ${r.message || `恢复 ${r.restored} 块`}`);
if (r.conflicts?.length) console.log(`  跳过（块号被占）: ${r.conflicts.join(", ")}`);
process.exit(0);
