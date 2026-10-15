// 洗数据产物入库 CLI（V3 第二波 #137）
// 用法: node src/enrich-import.mjs <book.db> [artifact.json] [--audit] [--min-chars N]
//   artifact.json 缺省取 enrich-results/<库名>.json（与跑批写盘位置一致）
//   --audit  只复查不导入（回源率/覆盖率/三级摘要计数/原文指纹）
// 铁律：只写 ctx/tags/questions 三列与 summaries/chunk_tags 两表，原文一字不动；
//       content_hash 对不上（书重建过）整单拒收。库侧验真函数与跑批通道同一套。
import fs from "node:fs";
import path from "node:path";
import { importEnrich, auditEnrich, defaultArtifactPath } from "./lib/enrich-import.mjs";

const argv = process.argv.slice(2);
const minCharsIdx = argv.indexOf("--min-chars");
const hasMinChars = minCharsIdx > -1 && argv[minCharsIdx + 1] && !argv[minCharsIdx + 1].startsWith("--");
const minChars = hasMinChars ? +argv[minCharsIdx + 1] : 40;
const positional = argv.filter((a, i) => !a.startsWith("--") && !(hasMinChars && i === minCharsIdx + 1));
const dbPath = positional[0];
const artifactArg = positional[1] || null;
const auditOnly = argv.includes("--audit");

if (!dbPath || !fs.existsSync(dbPath)) {
  console.error("用法: node src/enrich-import.mjs <book.db> [artifact.json] [--audit] [--min-chars N]");
  console.error("  artifact.json 缺省取 enrich-results/<库名>.json");
  process.exitCode = 1;
} else if (auditOnly) {
  const a = auditEnrich(dbPath, { minChars });
  if (!a.ready) {
    console.error(`复查不了：${a.message}`);
    process.exitCode = 1;
  } else {
    console.log(`[复查] ${path.basename(dbPath)}`);
    console.log(`  标签倒排 ${a.tags.total} 条，回源失败 ${a.tags.bad} 条${a.tags.bad ? "（不该发生！）" : ""}`);
    console.log(`  覆盖率 ${a.coverage.covered}/${a.coverage.eligible} 合格块（${a.coverage.pct}%），全书 ${a.coverage.total} 块`);
    console.log(`  摘要：块 ${a.summaries.chunk} / 章 ${a.summaries.chapter} / 书 ${a.summaries.book}`);
    console.log(`  上次入库 ${a.enrichAt || "（无记录）"}，条目 ${a.enrichEntries ?? "-"}，原文指纹 ${a.textHash}`);
    if (a.tags.bad) process.exitCode = 1;
  }
} else {
  const artifactPath = artifactArg || defaultArtifactPath(dbPath);
  const r = importEnrich(dbPath, artifactPath, { minChars });
  if (!r.ok) {
    console.error(`入库被拒（${r.code}）：${r.message}`);
    if (r.warnings?.length) for (const w of r.warnings) console.error(`  - ${w}`);
    process.exitCode = 1;
  } else {
    const s = r.stats;
    console.log(`[入库] ${path.basename(dbPath)} ← ${path.basename(artifactPath)}`);
    console.log(`  ${r.message}`);
    console.log(`  块：合格 ${s.eligible}（跳过短块 ${s.skipped}），本次写入 ${s.imported}，未覆盖 ${s.uncovered}`);
    console.log(`  标签：写入倒排 ${s.tags} 条，回源丢弃 ${s.tagsDropped}，超限截断 ${s.tagsCapped}`);
    console.log(`  摘要：章 ${s.chapterSummaries} 篇${s.bookSummary ? " + 书摘要 1 篇" : ""}`);
    if (s.dup || s.orphan) console.log(`  产物瑕疵：重复 idx ${s.dup} 条（按首条）、越界 idx ${s.orphan} 条（已忽略）`);
    for (const w of r.warnings || []) console.log(`  提醒：${w}`);
    console.log(`  原文指纹 ${s.textHash}（导入前后一致，原文一字未动）`);
    if (s.uncovered) console.log(`  提示：${s.uncovered} 个合格块没有产物条目（跑批失败的批），重跑 enrich-book 补齐后再导入`);
  }
}
