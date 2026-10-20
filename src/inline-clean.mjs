// 行级清洗 CLI（inline-clean）：clean-book「整块删」之后的块内净化关。纯规则零云端调用。
//   L1 删行级噪音（页码/楼层号/跟帖署名/结构分隔线）；L2 按跟帖边界切分（主帖留原块、跟帖切新块）。
// 用法:
//   node src/inline-clean.mjs <book.db> [--dry-run] [--no-import] [--force-gate] [--force] [--sample N] [--restore --all|--ids 1,2]
// 位次：build → clean → inline-clean → embed → enrich。改 text/切块都会作废向量与编目（落库时自动作废并提示重跑）。
// 退出码：0 成功/无改动；1 配置或库错误；2 GATE 闸门拒收（净化率异常）。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { buildInlinePlan, estimateInline, INLINE_VERSION } from "./lib/inline-clean.mjs";
import { importInline, restoreInline, auditInline } from "./lib/inline-import.mjs";

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const eq = args.find(a => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : null;
};
const VALUE_FLAGS = new Set(["--sample", "--ids"]);
const positional = (() => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (VALUE_FLAGS.has(a) && i + 1 < args.length && !args[i + 1].startsWith("--")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
})();

const dryRun = args.includes("--dry-run");
const noImport = args.includes("--no-import");
const forceGate = args.includes("--force-gate");
const forceRun = args.includes("--force");   // D2 修复：绕过幂等跳过强制重跑（恢复原文后用）
const restoreMode = args.includes("--restore");

const target = positional[0];
if (!target) {
  console.error("用法: node src/inline-clean.mjs <book.db> [--dry-run] [--no-import] [--force-gate] [--sample N]");
  console.error("      node src/inline-clean.mjs <book.db> --restore [--all | --ids 1,2] [--dry-run]");
  process.exit(1);
}
if (!fs.existsSync(target)) { console.error(`找不到 ${target}`); process.exit(1); }

const Database = require("better-sqlite3");

// ---------- 恢复模式 ----------
if (restoreMode) {
  const idsRaw = flag("--ids");
  const opts = { all: args.includes("--all") || !idsRaw, ids: idsRaw ? idsRaw.split(",").map(s => +s.trim()).filter(Number.isInteger) : null, dryRun };
  const rr = restoreInline(target, opts);
  if (!rr.ok) { console.error(`✗ 恢复失败: ${rr.message}`); process.exit(1); }
  if (rr.dryRun) {
    console.log(`可恢复 ${rr.candidates.length} 块：`);
    for (const c of rr.candidates.slice(0, 20)) console.log(`  块 ${c.chunk_id}: ${c.reason.slice(0, 60)}（${c.chars} 字${c.split ? `，切出 ${c.split} 跟帖块` : ""}）`);
    process.exit(0);
  }
  console.log(`✓ 恢复: ${rr.message}`);
  const au = auditInline(target);
  if (au.ready) console.log(`  现状: ${au.chunks} 块 | 隔离账剩 ${au.inlineQuarantined} 条 | 账实${au.metaAligned ? "相符" : "不符!"}`);
  process.exit(0);
}

// ---------- 清洗模式 ----------
let db;
try { db = new Database(target, { readonly: true }); }
catch (e) { console.error(`✗ 书库打不开: ${e.message}`); process.exit(1); }
// 幂等跳过：已按当前版本净化过且书未变（inline_content_hash 对上）→ 跳过（管线重跑/补向量不重复净化）。
// --force 绕过（D2 修复配套：恢复原文后强制重跑；恢复本身已清 meta 标记，此口子是双保险）
if (!forceRun) {
  const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
  if (meta.inline_version && String(meta.inline_version) === String(INLINE_VERSION) && meta.inline_content_hash) {
    const { buildCleanTasks } = await import("./lib/clean.mjs");
    let curHash = null;
    try { curHash = buildCleanTasks(db).book.content_hash; } catch { /* 坏库交给后续报人话 */ }
    if (curHash && curHash === meta.inline_content_hash) {
      db.close();
      console.log(`ⓘ ${path.basename(target)}: 已行级净化过（v${meta.inline_version}，${meta.inline_at || ""}），书未变——跳过（--force 强制重跑）`);
      process.exit(0);
    }
  }
}
const plan = buildInlinePlan(db);
db.close();
if (!plan.ok) { console.error(`✗ ${plan.message}`); process.exit(1); }

const est = estimateInline(plan);
console.log(`${path.basename(target)}：${est.chunks} 块 | strip ${est.strip} / split ${est.split} / keep ${est.keep} | 护栏拦回 I1:${est.guarded}`);
console.log(`  删行 ${plan.stats.removedLines} 行 ${plan.stats.removedChars} 字（净化率 ${(plan.stats.cleanRatio * 100).toFixed(1)}%）| 切出新块 ${est.newChunks} | 云端调用 ${est.cloudCalls}`);

// 样例打印（前后对比）
const sampleN = Math.max(1, Math.min(+(flag("--sample") || 3), 10));
const samples = plan.blocks.filter(b => b.action !== "keep").slice(0, sampleN);
for (const b of samples) {
  console.log(`\n===== 块 ${b.id}（${b.action}，删 ${b.removedLines} 行）=====`);
  console.log("--- 净化后（主帖段）---");
  console.log(b.after.slice(0, 300));
  if (b.replies.length) {
    console.log(`--- 切出 ${b.replies.length} 个跟帖段 ---`);
    b.replies.forEach((r, i) => console.log(`[跟帖${i + 1}] ${r.slice(0, 120)}`));
  }
}

if (dryRun || noImport) {
  console.log(dryRun ? "\n（--dry-run 不落库）" : "\n（--no-import 跳过落库）");
  console.log("落库: node src/inline-clean.mjs <db>");
  process.exit(0);
}

const ir = importInline(target, plan, { forceGate });
if (!ir.ok) {
  console.error(`✗ 落库被拒: ${ir.message}`);
  process.exit(ir.code === "GATE" ? 2 : 1);
}
console.log(`\n✓ 落库: ${ir.message}`);
if (ir.gate?.verdict === "warn") console.log(`⚠ 净化率 ${((ir.gate.ratio || 0) * 100).toFixed(1)}% 超黄线，已入库并标记`);
console.log(`恢复: node src/inline-clean.mjs <db> --restore --all`);
process.exit(0);
