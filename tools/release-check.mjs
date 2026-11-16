#!/usr/bin/env node
/**
 * release-check.mjs —— 打包前的「交付核对闸」。
 *
 * 为什么有它：上一个 0.1.0 安装包打完后，代码又走了 11 个提交，
 * 包和代码彻底脱节，只能作废。这道闸就守一件事——**包必须对得上代码**。
 *
 * 四项全过才允许 `npm run dist`：
 *   ① 提交号一致：HEAD 就是要发布的提交，且已是远端分支最新
 *   ② 工作区干净：git status --porcelain 为空
 *   ③ 文档数字对账：README/docs 的体积/维度/精度档与代码、实测一致，旧数字无残留
 *   ④ 冻结卷版本：sets 的 sha256/字节与 frozen*.json 一致，且写明两套卷分数不可相减
 *
 * 跑法：
 *   node tools/release-check.mjs                  # 闸门（默认）
 *   node tools/release-check.mjs --json           # 机读输出
 *   node tools/release-check.mjs --record         # 打包后登记（exe 字节/sha256/HEAD/测试）
 *   node tools/release-check.mjs --record --tests "lint=PASS; test:fast=43/43; guard=PASS"
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.join(import.meta.dirname, "..");
const WANT_JSON = process.argv.includes("--json");
const WANT_RECORD = process.argv.includes("--record");
// --tests=xxx 与 --tests xxx 两种写法都认（2026-11-16 第一次 --record 踩过：空格写法被吞成空串）
let TESTS = "";
{
  const eq = process.argv.find((a) => a.startsWith("--tests="));
  const at = process.argv.indexOf("--tests");
  if (eq) TESTS = eq.slice("--tests=".length);
  else if (at >= 0 && process.argv[at + 1]) TESTS = process.argv[at + 1];
}

const problems = [];
const warnings = [];
const facts = {};
const results = [];

const abs = (p) => path.join(ROOT, p);
const readText = (p) => fs.readFileSync(abs(p), "utf8");
const readJson = (p) => JSON.parse(readText(p));
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}
function isAncestor(sha, ref) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, ref], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function check(name, fn) {
  const before = problems.length;
  let ok;
  try {
    ok = fn() !== false;
  } catch (e) {
    problems.push(`${name} 执行异常：${e.message}`);
    ok = false;
  }
  results.push({ name, ok: ok && problems.length === before, problems: problems.slice(before) });
}

// ---------- 真值：代码 + 实测 ----------
const modelsMod = await import(pathToFileURL(abs("src/lib/models.mjs")).href);
const EMBED = modelsMod.EMBED_MODELS;
const DEFAULT_EMBED = modelsMod.DEFAULT_EMBED;
const budget = readJson("size-budget.json");
const pkg = readJson("package.json");
const libCount = fs.readdirSync(abs("library")).filter((f) => f.endsWith(".db")).length;
const dims = new Set(Object.values(EMBED).map((m) => m.dim));

facts.version = pkg.version;
facts.defaultEmbed = DEFAULT_EMBED;
facts.embedDims = Object.fromEntries(Object.entries(EMBED).map(([k, v]) => [k, v.dim]));
facts.embedDtypes = Object.fromEntries(Object.entries(EMBED).map(([k, v]) => [k, v.dtype]));
facts.libraryDbCount = libCount;
facts.installer = { bytes: budget.installer.bytes, gib: budget.installer.gib, gb: budget.installer.gb };
facts.modelsTotalGb = budget.modelsInPackage.totalGb;
facts.modelItemCount = budget.modelsInPackage.items.length;

// ---------- ① 提交号一致 ----------
check("① 提交号一致", () => {
  const head = git(["rev-parse", "HEAD"]);
  if (!head) {
    problems.push("取不到 HEAD——这不是 git 仓库，或 git 不可用");
    return false;
  }
  facts.gitHead = head.slice(0, 7);
  facts.gitHeadFull = head;
  const main = git(["rev-parse", "origin/main"]);
  const feat = git(["rev-parse", "origin/feat/quality-gate"]);
  facts.originMain = main.slice(0, 7) || "(缺失)";
  facts.originFeat = feat.slice(0, 7) || "(缺失)";

  if (head === main || head === feat) {
    facts.publishedOn = head === main ? "origin/main" : "origin/feat/quality-gate";
    return true;
  }
  if (main && isAncestor(head, "origin/main")) {
    problems.push(`HEAD ${facts.gitHead} 已推送但不是 origin/main 最新（远端 ${facts.originMain}）——发布必须打最新提交`);
  } else if (feat && isAncestor(head, "origin/feat/quality-gate")) {
    problems.push(`HEAD ${facts.gitHead} 已推送但不是 origin/feat/quality-gate 最新（远端 ${facts.originFeat}）`);
  } else {
    problems.push(`HEAD ${facts.gitHead} 未推送到远端（origin/main=${facts.originMain}）——先 push 再打包`);
  }
  return false;
});

// ---------- ② 工作区干净 ----------
check("② 工作区干净", () => {
  const status = git(["status", "--porcelain"]);
  const lines = status ? status.split("\n").filter((l) => l.trim()) : [];
  facts.dirtyCount = lines.length;
  if (!lines.length) return true;
  problems.push(`工作区有 ${lines.length} 项未提交/未跟踪：`);
  for (const l of lines.slice(0, 12)) problems.push(`  ${l}`);
  if (lines.length > 12) problems.push(`  …另有 ${lines.length - 12} 项`);
  return false;
});

// ---------- ③ 文档数字对账 ----------
// 当前口径文件：这里出现旧数字或与代码不符的数字，直接阻断。
const CURRENT_DOCS = [
  "README.md",
  "docs/模型清单与包体基线.md",
  "docs/真机验收勾选单.md",
  "docs/交接文档-2026-10-21.md",
];
// 历史归档：记录的是当时事实，只警告不阻断（顶部应有过期横幅）。
const ARCHIVE_DOCS = [
  "docs/收官打包与交接规划-2026-10-21.md",
  "docs/全量复盘-2026-11-02.md",
  "docs/导入管线改造计划.md",
  "docs/暴力测试计划-V2融合轮.md",
  "docs/代码审查标准与流程.md",
];
const BANNED = [
  { re: /700\s?MB/gi, label: "700MB" },
  { re: /701\s?MB/gi, label: "701MB" },
  { re: /2\.41\s?GB/gi, label: "2.41GB" },
  { re: /\bfp32\b/gi, label: "fp32" },
  { re: /主向量[^\n]{0,20}(multilingual-e5-small|\be5\b)/gi, label: "e5 作主向量" },
];
const EXEMPT_LINE = /废止|旧说法|旧数字|已改|更正|过期|历史|不再|曾(?:是|写)|示例|反例|检查项|目标 0/;

function nearestSection(lines, idx) {
  for (let i = idx; i >= 0; i--) if (/^##\s/.test(lines[i])) return lines[i];
  return "";
}

function scanDoc(rel, strict) {
  let text;
  try {
    text = readText(rel);
  } catch {
    if (strict) problems.push(`${rel}: 读不到（当前口径文件缺失）`);
    return;
  }
  const lines = text.split(/\r?\n/);
  const add = (msg) => (strict ? problems.push(msg) : warnings.push(msg));
  const fileTag = strict ? "" : "（历史归档，仅警告）";

  lines.forEach((line, i) => {
    const section = nearestSection(lines, i);
    if (/废止|旧数字/.test(section)) return; // 基线文档第 6 节合法记录旧数字
    for (const { re, label } of BANNED) {
      re.lastIndex = 0;
      if (!re.test(line)) continue;
      if (EXEMPT_LINE.test(line)) continue;
      add(`${rel}:${i + 1} 残留旧数字「${label}」${fileTag}：${line.trim().slice(0, 70)}`);
    }
    // 维度：出现的「N 维」必须是代码里真实存在的维度
    for (const m of line.matchAll(/(\d+)\s*维/g)) {
      const d = Number(m[1]);
      if (!dims.has(d)) add(`${rel}:${i + 1} 维度 ${d} 维与代码不符（可用：${[...dims].join("/")}）${fileTag}`);
    }
  });

  if (!strict) return;

  // 当前数字必须能在文档里找到，且等于真值
  const must = [
    [`${budget.installer.bytes.toLocaleString("en-US")}`, "安装包字节数"],
    [`${budget.installer.gib.toFixed(2)} GiB`, "安装包 GiB"],
    [`${budget.modelsInPackage.totalGb.toFixed(2)} GB`, "进包模型 GB"],
    [`${EMBED.m3.dim} 维`, "主向量维度"],
    ["int8", "精度档 int8"],
  ];
  if (rel === "README.md") {
    for (const [needle, label] of must) {
      if (!text.includes(needle)) problems.push(`${rel}: 找不到「${needle}」（${label}），文档与实测脱节`);
    }
  }

  // 书库条目数：文档写 N 个，必须等于实际 .db 数
  for (const m of text.matchAll(/(\d+)\s*个书库条目?/g)) {
    if (Number(m[1]) !== libCount) problems.push(`${rel}: 写「${m[1]} 个书库条目」，实际 ${libCount} 个 .db`);
  }
  // 模型个数：不许再写「三个本地模型」
  if (/三个本地模型/.test(text)) problems.push(`${rel}: 写「三个本地模型」，实际进包 ${budget.modelsInPackage.items.length} 个`);
}

check("③ 文档数字对账", () => {
  for (const d of CURRENT_DOCS) scanDoc(d, true);
  for (const d of ARCHIVE_DOCS) scanDoc(d, false);
  return true;
});

// ---------- ④ 冻结卷版本 ----------
check("④ 冻结卷版本", () => {
  const before = problems.length;
  for (const f of ["test/holdout/frozen.json", "test/holdout/frozen-v2.json"]) {
    const fr = readJson(f);
    const actual = fs.readFileSync(abs(fr.file));
    const actualSha = sha256(actual);
    facts[fr.setId] = { file: fr.file, sha256: actualSha, bytes: actual.length };
    if (actualSha !== fr.sha256) {
      problems.push(`${f}: ${fr.file} 实际 sha256 ${actualSha.slice(0, 16)}… ≠ 记录 ${fr.sha256.slice(0, 16)}…`);
    }
    if (actual.length !== fr.bytes) problems.push(`${f}: ${fr.file} 实际 ${actual.length} 字节 ≠ 记录 ${fr.bytes}`);
  }
  for (const f of ["test/holdout/baseline.json", "test/holdout/baseline-v2.json"]) {
    const b = readJson(f);
    if (!/不可相减|不可比|不得相减|口径不同/.test(b.note || "")) {
      problems.push(`${f}: note 未写明「两套卷分数不可相减」——报告混用会得出假结论`);
    }
  }
  return problems.length === before;
});

// ---------- 输出 ----------
const failed = results.filter((r) => !r.ok);
const payload = { ok: failed.length === 0, facts, results, problems, warnings };

if (WANT_JSON) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log("========== 交付核对闸（打包前） ==========");
  console.log(`仓库：${ROOT}`);
  console.log(`版本：${facts.version} HEAD：${facts.gitHead || "?"} 远端 main：${facts.originMain || "?"}`);
  console.log(`书库：${facts.libraryDbCount} 个 .db 默认引擎：${facts.defaultEmbed}（${facts.embedDims[facts.defaultEmbed]} 维）`);
  console.log("");
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} · ${r.name}`);
    for (const p of r.problems) console.log(`   - ${p}`);
  }
  if (warnings.length) {
    console.log("");
    console.log(`警告（不阻断）：${warnings.length} 条`);
    for (const w of warnings.slice(0, 10)) console.log(`   · ${w}`);
    if (warnings.length > 10) console.log(`   · …另有 ${warnings.length - 10} 条`);
  }
  console.log("");
  if (failed.length) {
    console.log(`结论：${results.length - failed.length} 项通过 / ${failed.length} 项失败 —— 禁止打包。`);
    console.log("修完再跑：node tools/release-check.mjs");
  } else {
    console.log(`结论：4 项全过 —— 可以打包（HEAD ${facts.gitHead}）。`);
  }
}

// ---------- --record：打包后登记 ----------
if (WANT_RECORD) {
  if (failed.length) {
    console.error("\n闸门未全过，拒绝登记。先修问题再打包。");
    process.exit(1);
  }
  const exeRel = `release/BookSkillPlatform Setup ${facts.version}.exe`;
  const exeAbs = abs(exeRel);
  if (!fs.existsSync(exeAbs)) {
    console.error(`\n找不到 ${exeRel}——先 npm run dist。`);
    process.exit(1);
  }
  const buf = fs.readFileSync(exeAbs);
  const digest = sha256(buf);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const record = {
    version: facts.version,
    gitHead: facts.gitHead,
    gitHeadFull: facts.gitHeadFull,
    builtAt: now.toISOString(),
    exe: exeRel,
    bytes: buf.length,
    sha256: digest,
    tests: TESTS || "未提供（用 --tests 显式登记）",
    gate: "release-check 四项全过",
  };
  fs.writeFileSync(abs("存档照/发布记录.json"), JSON.stringify(record, null, 1) + "\n");

  const ledger = abs("存档照/改动台账.md");
  let text = fs.readFileSync(ledger, "utf8");
  if (!text.includes("## 发布登记")) {
    text += "\n---\n\n## 发布登记\n\n| 时间 | 产物 | 代码与成品 | 为什么 | 依据 | 谁确认 | 验收 | 存档照 |\n|---|---|---|---|---|---|---|---|\n";
  }
  const row = `| ${stamp} | \`${exeRel}\` | HEAD \`${facts.gitHead}\`、${buf.length.toLocaleString("en-US")} 字节、sha256 \`${digest.slice(0, 16)}…\` | 交付核对闸四项全过后才打包；包与代码一一对应 | \`node tools/release-check.mjs --record\` | 富江 | ${record.tests} | 本次 |\n`;
  fs.writeFileSync(ledger, text + row);

  console.log("");
  console.log("========== 发布登记 ==========");
  console.log(`HEAD       ：${facts.gitHead}（${facts.publishedOn || "远端最新"}）`);
  console.log(`产物       ：${exeRel}`);
  console.log(`字节       ：${buf.length.toLocaleString("en-US")}`);
  console.log(`sha256     ：${digest}`);
  console.log(`测试       ：${record.tests}`);
  console.log("已写：存档照/发布记录.json、存档照/改动台账.md（记得提交这两处）");
}

process.exit(failed.length ? 1 : 0);
