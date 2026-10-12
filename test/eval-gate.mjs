// eval-gate：回归门禁
// 跑 v2-eval.mjs（复试官开），对基线断言两条硬规矩：
//   1. 总分不得低于基线分（eval-baseline.json 的 rate）
//   2. 本轮漏题必须是基线漏题的子集（不许把做对过的题做错）
// 用法: node test/eval-gate.mjs
// 基线更新规矩：只有净提升才允许改 eval-baseline.json，且漏题清单变化要写进 commit message
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const baselinePath = path.join(import.meta.dirname, "eval-baseline.json");
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

// 复试官开（默认配置）跑一轮；rerank off 的分数也顺手记录但不设门（关复试官是诊断模式）
const proc = spawnSync(process.execPath, ["test/v2-eval.mjs", "--rerank", "on"], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 10 * 60 * 1000,
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
