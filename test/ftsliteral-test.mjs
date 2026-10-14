// 字面腿关键词化验收：关键词腿真的干活了 + 不打扰会做的题 + 开关退回旧行为 + P1 实体链接别名注入
// 跑法: node test/ftsliteral-test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const Database = require("better-sqlite3");

import { hybridSearch } from "../src/lib/search.mjs";
import { questionKeywords, buildFtsQuery, cjkLikeScores, capFtsHits, convS2T, ftsWeightFor, FTS_TOPK } from "../src/lib/keywords.mjs";
import { linkEntities, entityAliasTerms } from "../src/lib/catalog.mjs";

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

// ===== 7) P1 词法实体链接：别名注入字面腿（BSP_ENTITY_LINK 默认开）=====
// 目标：命中人物的书内真实写法（match_names）补进字面腿词盘——问一种写法搜全写法 +
// 简体问句链到繁体原文。只加词不改分（打分/权重/复试官零改动），eval-gate 两道门守红线。
{
  const PP = path.join(LIB, "pride-and-prejudice-en.epub.db");
  const MZ = path.join(LIB, "mengzi-zh.docx.db");
  const Q7 = "what does lizzy think about marriage";

  // ① linkEntities：匹配逻辑从 loadCatalogSignal 抽出后，真库英文照常命中
  const pp = new Database(PP, { readonly: true });
  const hitPnp = linkEntities(pp, "what does darcy say about pride");
  assert(hitPnp.some(m => /Darcy/.test(m.name) && m.factor > 0),
    `实体链接: P&P 英文命中 Darcy（${hitPnp.map(m => m.name).join("/") || "无命中"}）`);

  // ② 简繁双形：简体问「齐宣王」命中繁体人物（S2T_MAP 补字 + convS2T 双形匹配——既有盲区修复）
  const mz = new Database(MZ, { readonly: true });
  const hitMz = linkEntities(mz, "齐宣王问政于孟子");
  assert(hitMz.some(m => m.name === "齊宣王"), `实体链接: 简体「齐宣王」命中繁体人物（${hitMz.map(m => m.name).join("/") || "无命中"}）`);
  assert(hitMz.some(m => m.name === "孟子"), "实体链接: 同一问句同时命中「孟子」（多人物并集）");

  // ③ entityAliasTerms：问一个写法注入全写法；中文转繁切 gram；cap/去重
  const aPnp = entityAliasTerms(pp, Q7);
  assert(aPnp.en.includes("elizabeth") && aPnp.en.includes("lizzy"),
    `别名: 问「lizzy」注入全写法（en=${aPnp.en.join(",")}）`);
  const aMz = entityAliasTerms(mz, "齐宣王问政于孟子");
  assert(aMz.cjk.includes("齊宣") && aMz.cjk.includes("孟軻"),
    `别名: 简体问句注入繁体 gram（cjk=${aMz.cjk.join(" ")}）`);
  assert(aPnp.en.length <= 8 && aMz.cjk.length <= 16 && new Set(aMz.cjk).size === aMz.cjk.length,
    "别名: cap 8/16 + 去重（无重复词）");
  // 防污染双剪枝（eval 87<88 回归的修复实证）：
  const aG = entityAliasTerms(pp, "who finds lydia and wickham in london");
  assert(!aG.en.includes("george"),
    `剪枝①: 多词写法只取末词（George Wickham 不带出 george——版权页 George Allen 短块污染实测；en=${aG.en.join(",")}）`);
  const aJ = entityAliasTerms(pp, "who tries to separate jane and bingley");
  assert(!aJ.en.includes("bennet") && aJ.en.includes("charles"),
    `剪枝②: 跨实体子串遮蔽（bennet⊂"Lydia Bennet" 被丢、书中单字写法 charles 保留；en=${aJ.en.join(",")}）`);

  // ④ 只用 match_names：aliases_zh 译名（P1.5）只参与匹配、不进注入词盘——合成库
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "entlink-"));
  const fdb = new Database(path.join(tmpDir, "fake.db"));
  fdb.exec("CREATE TABLE nodes(id TEXT, type TEXT, name TEXT, ref TEXT, source TEXT)");
  fdb.prepare("INSERT INTO nodes VALUES(?,?,?,?,?)").run("p1", "person", "Elizabeth Bennet",
    JSON.stringify({ match_names: ["Elizabeth", "Lizzy", "Eliza", "Beth", "Bess", "Ellie", "Liza", "Libby", "Lizbeth", "Bitsy"], aliases_zh: ["伊丽莎白"], mention_count: 623 }), "llm");
  const aZh = entityAliasTerms(fdb, "伊丽莎白是个怎样的人");  // 只经 aliases_zh 命中
  assert(aZh.en.includes("elizabeth") && aZh.en.length === 8 && !aZh.en.includes("bitsy"),
    `别名: 命中后注入 match_names 全写法且 cap=8（en=${aZh.en.length} 个）`);
  assert(aZh.cjk.length === 0, "别名: 译名只匹配不注入（cjk 为空，书里没有的词不进 FTS）");
  fdb.close();

  // ⑤ 安全：无 nodes 表库（空 sqlite）与有表无编目库都返回空词、不崩
  const bare = path.join(tmpDir, "bare.db");
  new Database(bare).close();  // 造一个连表都没有的空库
  const bdb = new Database(bare, { readonly: true });
  const aBare = entityAliasTerms(bdb, "任何问题");
  bdb.close();
  const dd = new Database(DD, { readonly: true });
  const aDd = entityAliasTerms(dd, "治理大国");
  dd.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert(aBare.en.length === 0 && aBare.cjk.length === 0, "安全: 无 nodes 表库返回空词（SqliteError 被吞、不崩）");
  assert(aDd.en.length === 0 && aDd.cjk.length === 0, "安全: 有表无编目（llm 层空）返回空词");
  pp.close(); mz.close();

  // ⑥ 合并词盘：别名排问题词前（24 词盘永不落榜）；封顶逻辑照旧
  const k7 = questionKeywords(Q7);
  const fq7 = buildFtsQuery({ en: [...aPnp.en, ...k7.en] });
  assert(fq7.startsWith('"elizabeth"') && fq7.indexOf('"marriage"') > fq7.indexOf('"elizabeth"'),
    `注入序: 别名排问题词前（${fq7}）`);
  assert((buildFtsQuery({ en: [...Array(30)].map((_, i) => "word" + i) }).match(/"/g) || []).length === 48,
    "注入盘: 总词封顶 24（30 词输入只留 24）");

  // ⑦ 开关对照（子进程，仿第 5 节）：默认开有实际作用、=0 退回旧行为（词串构造与旧版逐字节一致）
  const searchUrl = pathToFileURL(path.join(__dirname, "..", "src", "lib", "search.mjs")).href;
  const script7 = `
    const { hybridSearch } = await import(${JSON.stringify(searchUrl)});
    process.env.BSP_ENTITY_LINK = "0";
    const a = await hybridSearch(${JSON.stringify(PP)}, ${JSON.stringify(Q7)}, 20, { rerank: false });
    delete process.env.BSP_ENTITY_LINK;
    const b = await hybridSearch(${JSON.stringify(PP)}, ${JSON.stringify(Q7)}, 20, { rerank: false });
    console.log("PROBE " + JSON.stringify({ off: a.map(r => r.id), on: b.map(r => r.id) }));
  `;
  const p7 = spawnSync(process.execPath, ["--input-type=module", "-e", script7], { encoding: "utf8", env: { ...process.env }, timeout: 180000 });
  const line7 = (p7.stdout || "").split(/\r?\n/).find(l => l.startsWith("PROBE"));
  const probe7 = line7 ? JSON.parse(line7.slice(6)) : null;
  assert(probe7 && probe7.off.length > 0 && probe7.on.length > 0,
    `开关: BSP_ENTITY_LINK 关/开两模式都正常产出${probe7 ? "" : "（子进程失败: " + (p7.stderr || "").slice(0, 120) + "）"}`);
  assert(probe7 && JSON.stringify(probe7.off) !== JSON.stringify(probe7.on),
    "开关: 关/开结果序列不同（别名注入有实际作用，不是死代码）");

  // ⑧ 端到端：简体问孟子 → 繁体原文块带着字面分进池（S2T 桥兑现）
  const rsMz = await hybridSearch(MZ, "齐宣王问政于孟子", 20, { rerank: false });
  const hitMz2 = rsMz.find(r => /齊宣王/.test(r.text));
  assert(hitMz2 && hitMz2.fts > 0, `端到端: 简体问句命中繁体原文块（id=${hitMz2?.id} fts=${hitMz2?.fts ? hitMz2.fts.toFixed(2) : "无"}）`);
}

console.log("\n===== 字面腿关键词化验收结果 =====");
if (failed) { console.log(`有 ${failed} 项 FAIL`); process.exit(1); }
console.log("全部 PASS");
