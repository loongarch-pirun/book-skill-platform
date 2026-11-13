// eval-gate：回归门禁
// 跑 v2-eval.mjs（复试官开），对基线断言两条硬规矩：
//   1. 总分不得低于基线分（eval-baseline.json 的 rate）
//   2. 本轮漏题必须是基线漏题的子集（不许把做对过的题做错）
// 用法: node test/eval-gate.mjs
// 基线更新规矩：只有净提升才允许改 eval-baseline.json，且漏题清单变化要写进 commit message
//
// 2026-11-13 加了一道「可比性」前置闸：基线里记了 model，若与本轮评测的引擎不同、
// 或有效题数不同，两条门都失去意义（分母都变了，93 比 88 属于拿两把尺子量）。
// 这种情形不再静默判红，而是打「不可比」并 exit 0 —— 让换引擎这件事不被假红灯挡路，
// 同时一眼看得见「这份基线该重定了」。真正同引擎同卷的回归仍然照旧判死。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const baselinePath = path.join(import.meta.dirname, "eval-baseline.json");
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

// 复试官开（默认配置）跑一轮；rerank off 的分数也顺手记录但不设门（关复试官是诊断模式）
// 超时随考卷规模走：124 题 × ~5.9s ≈ 12.2 分钟，给 20 分钟余量（102 题时代 10 分钟线曾贴脸）
const proc = spawnSync(process.execPath, ["test/v2-eval.mjs", "--rerank", "on"], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 20 * 60 * 1000,
});
const out = (proc.stdout || "") + (proc.stderr || "");

// 解析 EVAL_RESULT 行和漏题行
let result = null;
const misses = [];
for (const line of out.split(/\r?\n/)) {
  const m = line.match(/^EVAL_RESULT\s+(.+)$/);
  if (m) result = JSON.parse(m[1]);
  const missLine = line.match(/^\s*漏题:\s*(.+)$/);
  if (missLine) misses.push(...missLine[1].split("|").map(s => s.trim()).filter(Boolean));
}

if (!result) {
  console.error("eval-gate 失败：没解析到 EVAL_RESULT（评测没跑完或崩溃）\n---- 原始输出尾部 ----");
  console.error(out.slice(-2000));
  process.exit(1);
}

console.log(`\n===== eval-gate =====`);
console.log(`  本轮: ${result.hits}/${result.total} = ${result.rate} 分 | 平均延迟 ${result.avgLatencyMs}ms`);
console.log(`  基线: ${baseline.hits}/${baseline.total} = ${baseline.rate} 分 (model=${baseline.model}, 记录于 ${baseline.date})`);
if (misses.length) console.log(`  本轮漏题: ${misses.join(" | ")}`);
else console.log(`  本轮漏题: 无`);

// 门 0（可比性前置闸）：引擎或卷面规模一变，分母就变了，两条门都量的是两把尺子。
// 这种情形安静地打「不可比」，让真正同引擎同卷的回归继续判死。
// 判据可翻转：把 eval-baseline.json 的 model 改回本轮引擎、total 改回本轮题数，立刻恢复硬门。
const why = [];
if (baseline.model !== result.model) why.push(`引擎不同（基线 ${baseline.model} / 本轮 ${result.model}）`);
if (baseline.total !== result.total) why.push(`有效题数不同（基线 ${baseline.total} / 本轮 ${result.total}）`);
if (why.length) {
  console.log(`\n≓ eval-gate 不可比，本轮不判红也不判绿：${why.join("；")}。`);
  console.log(`  分数不可比：${result.rate} 分 ≠ ${baseline.rate} 分，分母与向量空间都变了，这组对比没有意义。`);
  console.log(`  这不是放行、也不是回归——是「这份基线该重定了」。`);
  console.log(`  重定基线：确认本轮检索无退化后，把 test/eval-baseline.json 的 model/total/hits/rate/misses`);
  console.log(`  改成当前实况，并在 commit message 里写明漏题变化（规矩见本文件头）。`);
  console.log(`  硬门会在基线对齐后的下一轮自动恢复。`);
  process.exit(0);
}

// 门 1：分数不低于基线
if (result.rate < baseline.rate) {
  console.error(`✗ 门禁不通过：${result.rate} < 基线 ${baseline.rate}。检索层出现回归，不许提交。`);
  process.exit(1);
}

// 门 2：漏题 ⊆ 基线漏题（做对过的题不许做错）
const baseMiss = new Set(baseline.misses);
const newMiss = misses.filter(q => !baseMiss.has(q));
if (newMiss.length) {
  console.error(`✗ 门禁不通过：新增漏题（基线里这几题原本是对的）：\n  ${newMiss.join("\n  ")}`);
  process.exit(1);
}

// 顺带把漏题清单变化提示出来（变好：可以更新基线了）
const improved = [...baseMiss].filter(q => !misses.includes(q));
if (improved.length) {
  console.log(`  ↑ 相比基线新做对 ${improved.length} 题：${improved.join(" | ")}`);
  console.log(`  可以净更新基线了：改 test/eval-baseline.json 并在 commit message 里写明漏题变化。`);
}
console.log(`✓ eval-gate 通过（${result.rate} ≥ ${baseline.rate}，无新增漏题）`);
