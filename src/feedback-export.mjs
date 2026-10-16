// 反馈样本池导出（V3 第三波-③）：pool.jsonl → markdown 草稿（按失败类型分组）。
// 升格流程：人工从草稿里挑题 → 金词回原文验真 → 候选题探针实跑（v2-eval 同款 judge）
// → 入考卷 test/v2-eval.mjs。本工具只读池子，不改任何数据。
//
// 用法: node src/feedback-export.mjs [--lib DIR] [--out FILE] [--kind KIND] [--limit N]
//   --lib   书库目录（默认 resolveDirs：env BSP_LIB_DIR > 配置 > ./library）
//   --out   输出文件（默认打到 stdout）
//   --kind  只看某一类（no-results / degraded / citations-dropped）
import fs from "node:fs";
import path from "node:path";
import { resolveDirs } from "./desktop/paths.mjs";
import { listFeedback, countFeedback } from "./desktop/feedback-pool.mjs";

const args = process.argv.slice(2);
// flag() 支持 "--name value" 与 "--name=value" 两种形式（同 enrich-book.mjs）
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const eq = args.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : null;
};

const libDir = flag("--lib") || resolveDirs().libDir;
const outFile = flag("--out");
const kind = flag("--kind");
const limit = +flag("--limit") || 200;

const KINDS = ["no-results", "degraded", "citations-dropped"];
const LABELS = {
  "no-results": "检索空手（应查到而没查到）",
  "degraded": "降级（引用全不过 / 云端失败）",
  "citations-dropped": "引用被剔除（部分失败）",
};

function fmtLegs(legs) {
  if (!Array.isArray(legs) || !legs.length) return "";
  return legs.map((l) => {
    const tags = [];
    if (l.nom) tags.push("提名");
    if (l.cat) tags.push("编目:" + l.cat);
    if (l.enr) tags.push("洗数据:" + l.enr);
    if (l.fts != null) tags.push("fts=" + l.fts);
    if (l.sem != null) tags.push("sem=" + l.sem);
    return `#${l.id}(${tags.join(" ")})`;
  }).join(" ");
}

const items = listFeedback(libDir, { limit, kind });
const total = countFeedback(libDir);
const lines = [];
lines.push("# 反馈样本池导出");
lines.push("");
lines.push(`> 池文件：${path.join(libDir, "feedback", "pool.jsonl")}（共 ${total} 条，本次导出 ${items.length} 条）`);
lines.push("> 升格流程：人工挑题 → 金词回原文验真 → 候选题探针实跑 → 入考卷（test/v2-eval.mjs）");
lines.push("");
if (!items.length) lines.push("（池为空——还没有失败样本，或者都已处理）");
for (const k of kind ? [kind] : KINDS) {
  const g = items.filter((e) => e.kind === k);
  if (!g.length) continue;
  lines.push(`## ${LABELS[k] || k}（${g.length} 条）`);
  lines.push("");
  for (const e of g) {
    const when = String(e.ts || "").slice(0, 16).replace("T", " ");
    const book = e.book ? `《${e.book}》` : "全库";
    lines.push(`- [${when}] ${book}｜${e.question}`);
    if (Array.isArray(e.variants) && e.variants.length) lines.push(`  - 试过的改写：${e.variants.join(" ／ ")}`);
    if (e.detail && Object.keys(e.detail).length) lines.push(`  - 细节：${JSON.stringify(e.detail)}`);
    if (Array.isArray(e.legs) && e.legs.length) lines.push(`  - 检索腿归因：${fmtLegs(e.legs)}`);
  }
  lines.push("");
}
const md = lines.join("\n");
if (outFile) {
  fs.writeFileSync(outFile, md + "\n", "utf8");
  console.log(`已写出 ${outFile}（${items.length} 条）`);
} else {
  console.log(md);
}
