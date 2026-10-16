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
// V3R-D25：--min-chars 支持 "--min-chars N" 与 "--min-chars=N" 两形式；非数字/负数/小数 → 人话拒绝，
// 绝不把 NaN 传进 SQL（旧代码 +"abc"=NaN 直接绑进 length(text)>=?，输出里裸奔 NaN）
const parseMinChars = () => {
  const i = argv.indexOf("--min-chars");
  let raw = null;
  if (i > -1) {
    const next = argv[i + 1];
    if (next != null && !next.startsWith("--")) raw = next;
  } else {
    const eq = argv.find((a) => a.startsWith("--min-chars="));
    if (eq != null) raw = eq.slice("--min-chars=".length);
  }
  if (raw == null) {
    return argv.includes("--min-chars")
      ? { error: "「--min-chars」后面要跟一个不小于 0 的整数" }
      : { value: 40 };
  }
  if (raw.trim() === "") return { error: "「--min-chars」后面要跟一个不小于 0 的整数" };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return { error: `「--min-chars」要是不小于 0 的整数，收到「${raw}」` };
  return { value: n };
};
const mc = parseMinChars();
const positional = (() => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--min-chars" && argv[i + 1] != null && !argv[i + 1].startsWith("--")) { i++; continue; } // 连值一起吃
    if (a.startsWith("--")) continue;
    out.push(a);
  }
  return out;
})();
const dbPath = positional[0];
const artifactArg = positional[1] || null;
const auditOnly = argv.includes("--audit");

if (mc.error) {
  console.error(`✗ ${mc.error}`);
  console.error("用法: node src/enrich-import.mjs <book.db> [artifact.json] [--audit] [--min-chars N]");
  console.error("  artifact.json 缺省取 enrich-results/<库名>.json");
  process.exitCode = 1;
} else if (!dbPath || !fs.existsSync(dbPath)) {
  console.error("用法: node src/enrich-import.mjs <book.db> [artifact.json] [--audit] [--min-chars N]");
  console.error("  artifact.json 缺省取 enrich-results/<库名>.json");
  process.exitCode = 1;
} else if (auditOnly) {
  // V3R-D05：库侧查询边缘（坏文件/结构异常）→ 人话拒绝，不裸 SqliteError 堆栈
  let a;
  try { a = auditEnrich(dbPath, { minChars: mc.value }); }
  catch (e) { console.error(`复查失败：书库读不了（${e.message}）`); process.exitCode = 1; a = null; }
  if (a) {
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
  }
} else {
  const artifactPath = artifactArg || defaultArtifactPath(dbPath);
  // V3R-D05：importEnrich 契约上不抛（事务内抛错也回 {ok:false}），此处双保险
  let r;
  try { r = importEnrich(dbPath, artifactPath, { minChars: mc.value }); }
  catch (e) { console.error(`入库失败：${e.message}（已写内容会整单回滚，可修复后重跑）`); process.exitCode = 1; r = null; }
  if (r) {
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
}
