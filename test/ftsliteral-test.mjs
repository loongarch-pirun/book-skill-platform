// 字面腿关键词化验收：关键词腿真的干活了 + 不打扰会做的题 + 开关退回旧行为
// 跑法: node test/ftsliteral-test.mjs
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const Database = require("better-sqlite3");

import { hybridSearch } from "../src/lib/search.mjs";
import { questionKeywords, buildFtsQuery, cjkLikeScores, capFtsHits, convS2T, ftsWeightFor, FTS_TOPK } from "../src/lib/keywords.mjs";

const LIB = path.join(__dirname, "..", "library");
const ATT = path.join(LIB, "attention-is-all-you-need-en.pdf.db");
const DD = path.join(LIB, "daodejing-zh.docx.db");
let failed = 0;
const assert = (cond, msg, extra = "") => {
  console.log((cond ? "PASS" : "FAIL") + " - " + msg + (cond ? "" : ` ${extra}`));
  if (!cond) failed++;
};

// ===== 1) 关键词抽取：问题词全停、属格剥离、弯引号归一 =====
{
  const k = questionKeywords("what is mr darcy's estate called");
  assert(k.en.includes("darcy") && k.en.includes("estate") && k.en.includes("called"),
    `关键词抽取: 属格剥离+实词保留（${k.en.join(",")}）`);
  assert(!k.en.includes("what") && !k.en.includes("darcy's"),
    "关键词抽取: who/what 类问题词全停、's 属格不单独出现");
  const k2 = questionKeywords("what is Mr Darcy\u2019s estate");  // 弯引号（epub 真实形态）
  assert(k2.en.includes("darcy"), "关键词抽取: 弯引号 \u2019s 归一后剥离（df=0 陷阱）");
  const k3 = questionKeywords("治理一个大国要怎么做");
  assert(k3.cjk.includes("大國") && k3.cjk.includes("治理"), `中文: 简转繁后切 2-gram（${k3.cjk.slice(0, 5).join(" ")}...）`);
  assert(convS2T("国恒") === "國恆", "简转繁: 国→國 恒→恆");
}

// ===== 2) 中文 gram 按 df 过滤：无区分度白话词不许提名 =====
{
  const db = new Database(DD, { readonly: true });
  const grams = questionKeywords("可以说出来的道就不是永恒的道吗").cjk;
  // 实测「可以」df=7/81 > max(5%,4) → 扔；其余 gram df=0 → 腿整体哑火（纯语义，与基线一致）
  const scores = cjkLikeScores(db, grams);
  assert(scores.size === 0, `df过滤: 「可以说…」题的字面腿哑火不提名（实际 ${scores.size}）`);
  const grams2 = questionKeywords("治理一个大国要怎么做").cjk;
  const scores2 = cjkLikeScores(db, grams2);
  // 「大國」df=1 → 唯一命中块应得满分且是烹小鮮那块
  const top1 = [...scores2.entries()].sort((a, b) => b[1] - a[1])[0];
  const text = top1 ? db.prepare("SELECT text FROM chunks WHERE id=?").get(top1[0]).text : "";
  assert(top1 && /烹小鮮/.test(text), `df过滤: 「大國」低频保留且正中烹小鮮块（id=${top1?.[0]} score=${top1?.[1]}）`);
  db.close();
}

// ===== 3) top-K 封顶：几百命中只留最尖 12 个 =====
{
  const big = new Map([...Array(50).keys()].map(i => [i, Math.sin(i)]));
  assert(capFtsHits(big).size === FTS_TOPK, `封顶: 50 候选取 top-${FTS_TOPK}`);
  assert([...capFtsHits(big).values()].every((v, i, a) => i === 0 || a[i - 1] >= v), "封顶: 保留的是分数最高的一批");
  const q = "which convolutional sequence models are cited as prior work";
  const db = new Database(ATT, { readonly: true });
  const hits = new Map();
  for (const r of db.prepare(`SELECT c.id id, bm25(chunks_fts) rank FROM chunks_fts f JOIN chunks c ON c.id=f.rowid WHERE chunks_fts MATCH ?`).all(buildFtsQuery(questionKeywords(q))))
    hits.set(r.id, -r.rank);
  db.close();
  assert(hits.size > FTS_TOPK, `关键词腿激活: convs2s 题 MATCH 命中 ${hits.size} 块（旧短语腿是 0）`);
}

// ===== 4) 端到端：convs2s/bytenet 进 top-20；治理大国命中带字面分 =====
{
  const rs = await hybridSearch(ATT, "which convolutional sequence models are cited as prior work", 20, { rerank: false });
  const inTop = rs.findIndex(r => /convs2s|bytenet/i.test(r.text));
  assert(inTop >= 0 && inTop < 20, `端到端: convs2s/bytenet 答案块进 top-20（第 ${inTop + 1} 名；旧字面腿时代根本不在池里）`,
    inTop < 0 ? JSON.stringify(rs.map(r => r.fts)) : "");
  assert(rs.some(r => r.fts > 0), "端到端: 英文关键词腿贡献字面分（fts>0）");
  assert(inTop === -1 || rs[inTop].fts > 0, "端到端: 答案块有字面分加持");

  const rs2 = await hybridSearch(DD, "治理一个大国要怎么做", 20, { rerank: false });
  const hit = rs2.find(r => /烹小鮮/.test(r.text));
  assert(hit && hit.fts > 0, `端到端: 烹小鮮块带字面分命中（fts=${hit?.fts.toFixed(2)}）`);
}

// ===== 5) BSP_FTS_KW=0 完整退回旧整句行为（子进程验证开关）=====
{
  const script = `
    const { hybridSearch } = await import(${JSON.stringify("file:///" + path.join(__dirname, "..", "src", "lib", "search.mjs").replace(/\\\\/g, "/"))});
    const rs = await hybridSearch(${JSON.stringify(ATT)}, "which convolutional sequence models are cited as prior work", 20, { rerank: false });
    console.log("PROBE " + JSON.stringify(rs.map(r => +(r.fts > 0))));
  `;
  const run = (env) => {
    const p = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 120000 });
    const line = (p.stdout || "").split(/\r?\n/).find(l => l.startsWith("PROBE"));
    return line ? JSON.parse(line.slice(6)) : null;
  };
  const oldMode = run({ BSP_FTS_KW: "0" });
  const kwMode = run({});
  assert(Array.isArray(oldMode) && oldMode.every(x => x === 0),
    `开关: BSP_FTS_KW=0 整句短语模式字面腿全哑（${oldMode ? "命中数 " + oldMode.filter(Boolean).length : "子进程失败"}）`);
  assert(Array.isArray(kwMode) && kwMode.some(x => x === 1),
    `开关: 默认关键词模式字面腿激活（${kwMode ? "命中数 " + kwMode.filter(Boolean).length : "子进程失败"}）`);
}

// ===== 6) 短查询/纯符号不崩 + 阶梯函数（保留调参用）=====
{
  const a = await hybridSearch(ATT, "ab", 3, { rerank: false });       // <3 字符：无字面腿
  const b = await hybridSearch(ATT, "%%%", 3, { rerank: false });      // 纯符号：MATCH/LIKE 都打不中
  assert(Array.isArray(a) && Array.isArray(b), "短查询/纯符号返回数组不崩溃");
  assert(ftsWeightFor(0.01) === 0.5 && ftsWeightFor(0.05) === 0.4 && ftsWeightFor(0.08) === 0.35 && ftsWeightFor(0.5) === 0.3,
    "质量阶梯函数边界正确（保留给实验用，当前主路径用提名封顶）");
}

console.log("\n===== 字面腿关键词化验收结果 =====");
if (failed) { console.log(`有 ${failed} 项 FAIL`); process.exit(1); }
console.log("全部 PASS");
