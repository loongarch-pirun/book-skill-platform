// P0 幻觉爆破（终期暴力测试核心）：拿对抗弹药攻四道幻觉闸门。
// 门1 编目五重校验（validateResult）：假人名/子串陷阱/安错人/坏引用 → 拒；合法 → 收
// 门2 技能三道质检（saveSkill）：中文数字声称/引文边缘造假/假索引/穿越/超限 → 拒；合法 → 收
// 门3 考卷金标准反验：GOLDEN 52 题每个关键词必须回该书库原文（常驻断言，防考卷自身带幻觉）
// 门4 检索探针：无答案问题/篡改主语（记录型——检索是相关性排序不是事实核查，不断言）
// 门2 的 sources 与门3/门4 用真 library（readonly）；门1/门2 落点全部临时目录。
// 挂载：test:slow（门4 要加载 e5 模型）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const LIB = path.join(ROOT, "library");
const Database = require("better-sqlite3");

const { validateResult } = await import("../src/lib/catalog.mjs");
const { saveSkill, claimNum } = await import("../src/lib/skill-store.mjs");
const { configureSearch } = await import("../src/lib/search.mjs");
const { configureModels } = await import("../src/lib/models.mjs");

let pass = 0, fail = 0, observe = 0;
const failures = [];
const ok = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (cond) pass++; else { fail++; failures.push(msg); } };
const obs = (msg) => { console.log("OBSERVE - " + msg); observe++; };

// ================= 门1 编目门：对抗编目结果 =================
console.log("===== 门1 编目五重校验（validateResult 对抗） =====");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-hf-cat-"));
  const dbPath = path.join(tmp, "fake.docx.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT NOT NULL)");
  const ins = db.prepare("INSERT INTO chunks(chapter, page, text) VALUES (?,?,?)");
  ins.run("ch1", null, "Mr. Darcy met Miss Bennet at the assembly in Meryton.");
  ins.run("ch1", null, "Elizabeth looked at Darcy with surprise and smiled.");
  ins.run("ch2", null, "His manners and fancies were strange that evening.");
  ins.run("ch2", null, "孟子對曰：王如好貨與民同之，公劉好貨.");
  ins.run("ch3", null, "The chance of Anne in the distance was small.");
  db.close();

  const task = { book: { db: "fake.docx.db" }, clusters: [{ id: "c001" }, { id: "c002" }, { id: "c003" }] };
  const dbRO = new Database(dbPath, { readonly: true });
  const run = (result) => validateResult(dbRO, task, result);
  const base = () => ({
    task_ref: "fake.docx.db",
    themes: [{ id: "t1", name: "相遇" }, { id: "t2", name: "性格" }, { id: "t3", name: "德性" }],
    assignments: [{ cluster: "c001", theme: "t1" }, { cluster: "c002", theme: "t2" }, { cluster: "c003", theme: "t3" }],
    persons: [], relations: [],
  });
  const withPersons = (persons, relations = []) => ({ ...base(), persons, relations });

  // 1) 防幻觉主防线：全编造人名 → 拒
  const r1 = run(withPersons([{ name: "张三丰", match_names: ["张三丰", "张君宝"] }]));
  ok(!r1.ok && /match_name.*不存在/.test(r1.errors.join(";")), `门1-1 全编造人名 → 拒（${r1.errors[0]?.slice(0, 50)}）`);
  // 2) 子串陷阱："Anne" 只作为 manners 子串存在 → 校验层放行（instr 纯子串，历史教训复刻）
  const r2 = run(withPersons([{ name: "Anne", match_names: ["Anne"] }]));
  ok(r2.ok, "门1-2 子串陷阱「Anne」过校验层（instr 子串语义，设计分层：校验管存在性）");
  // 3) 真人名安错人：Darcy 挂到 Elizabeth 身上 → 校验层放行（程序判不了人名归属）
  const r3 = run(withPersons([{ name: "Elizabeth Bennet", match_names: ["Darcy"] }]));
  ok(r3.ok, "门1-3 真人名安错人过校验层（固有边界：人名归属需 LLM 交叉验证，登记残余风险）");
  // 4) task_ref 不匹配 → 拒
  ok(!run({ ...base(), task_ref: "other.db" }).ok, "门1-4 task_ref 不匹配 → 拒");
  // 5) assignments 重复 cluster → 拒
  ok(!run({ ...base(), assignments: [{ cluster: "c001", theme: "t1" }, { cluster: "c001", theme: "t2" }, { cluster: "c003", theme: "t3" }] }).ok, "门1-5 assignments 重复 cluster → 拒");
  // 6) cluster 不存在 → 拒
  ok(!run({ ...base(), assignments: [{ cluster: "c001", theme: "t1" }, { cluster: "c002", theme: "t2" }, { cluster: "cXXX", theme: "t3" }] }).ok, "门1-6 assignments 引用不存在 cluster → 拒");
  // 7) theme 引用不存在 → 拒
  ok(!run({ ...base(), assignments: [{ cluster: "c001", theme: "tX" }, { cluster: "c002", theme: "t2" }, { cluster: "c003", theme: "t3" }] }).ok, "门1-7 assignment 引用不存在 theme → 拒");
  // 8) theme 0 使用 → 拒
  ok(!run({ ...base(), assignments: [{ cluster: "c001", theme: "t1" }, { cluster: "c002", theme: "t1" }, { cluster: "c003", theme: "t1" }] }).ok, "门1-8 theme 未被任何 cluster 使用 → 拒");
  // 9) relations 引用未声明人物 → 拒
  ok(!run(withPersons([], [{ a: "Ghost", b: "Darcy" }])).ok, "门1-9 relations 引用未声明人物 → 拒");
  // 10) schema 坏（match_names 空数组）→ 拒
  ok(!run(withPersons([{ name: "Darcy", match_names: [] }])).ok, "门1-10 schema：match_names 空数组 → 拒");
  // 11) 控制组：完全合法（中文真人名）→ 收
  const r11 = run(withPersons([{ name: "孟子", match_names: ["孟子"] }], [{ a: "孟子", b: "孟子", note: "自引" }]));
  ok(r11.ok, `门1-11 控制组：合法结果 → 收（warnings: ${r11.warnings.length}）`);
  // 12) 巨型 note（10 万字）→ 放行（DoS 面记录）
  const r12 = run(withPersons([{ name: "孟子", match_names: ["孟子"], note: "注".repeat(100000) }]));
  ok(r12.ok, "门1-12 10 万字 note → 放行（schema 无长度上限；DoS 面=轻微，登记不修）");
  dbRO.close();
  obs("门1-2/1-3 是设计分层与固有边界：校验层只验 match_name 在原文存在（instr 子串），"
    + "人名归属与短名精确性由 mention 扫描的词边界正则兜底（catalog.mjs 355-360 行），"
    + "修'安错人'需 LLM 交叉验证=新工程，登记残余风险");
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 沙箱 */ }
}

// ================= 门2 技能门：saveSkill 对抗 =================
console.log("===== 门2 技能三道质检（saveSkill 对抗） =====");
{
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-hf-skills-"));
  // 真引文：从道德经库取一章真原文（citation-check 要回源验证）
  const dd = new Database(path.join(LIB, "daodejing-zh.docx.db"), { readonly: true });
  const row = dd.prepare("SELECT chapter, text FROM chunks LIMIT 1").get();
  const quote = row.text.split(/[。；]/)[0] + "。";
  dd.close();
  const ddChapters = (() => {
    const d2 = new Database(path.join(LIB, "daodejing-zh.docx.db"), { readonly: true });
    const n = d2.prepare("SELECT COUNT(DISTINCT chapter) c FROM chunks").get().c;
    d2.close();
    return n;
  })();
  const skillMd = (extra = "", cov = "1/" + ddChapters) => `---
name: fuzz-pkg
title: 模糊测试包
description: P0 幻觉爆破对抗弹药${extra}
sources: { dd: daodejing-zh.docx }
coverage: ${cov}
---
> ${quote}〔dd·${row.chapter}〕

本包是 P0 对抗测试产物。
`;
  const mk = (files) => files.map(f => ({ path: f[0], content: f[1] }));
  const go = (slug, files) => saveSkill(slug, mk(files), { skillsDir });

  // 1) 中文数字能力声称：「八十一章速查」实际覆盖 1 章 → 修后应拒（L2 修复验证）
  const r1 = go("fuzz-pkg", [["SKILL.md", skillMd("本包是八十一章原典速查", `1/${ddChapters}`)]]);
  ok(!r1.ok && r1.stage === "coverage-check" && /claimed-coverage-lie/.test(JSON.stringify(r1.errors)),
    `门2-1 中文数字声称「八十一章速查」覆盖 1 章 → 拒（${r1.errors?.[0]?.reason}）——L2 修复生效`);
  // 2) 中文数字书属性声称：「全书八十二章」与实际 81 章不符 → 拒
  const r2 = go("fuzz-pkg", [["SKILL.md", skillMd("本书全书八十二章导读")]]);
  ok(!r2.ok && /book-total-lie/.test(JSON.stringify(r2.errors || [])), "门2-2 中文数字「全书八十一章」与实际章数不符 → 拒");
  // 3) 诚实中文数字声称：覆盖 1 章写「一章速查」→ 收
  const r3 = go("fuzz-pkg", [["SKILL.md", skillMd("本包是一章速查")]]);
  ok(r3.ok, `门2-3 控制组：诚实中文数字声称「一章速查」→ 收（coverage ${r3.coverage?.covered}/${r3.coverage?.total}）`);
  // 4) 引文边缘造假：真引文改一个字（子句命中率掉一档）→ 拒
  const forged = quote.slice(0, -2) + (quote.endsWith("。") ? "X。" : "X");
  const r4 = go("fuzz-pkg", [["SKILL.md", `---
name: fuzz-pkg
description: 引文造假测试
sources: { dd: daodejing-zh.docx }
---
> ${forged}〔dd·${row.chapter}〕

造假引文。
`]]);
  ok(!r4.ok && r4.stage === "citation-check", `门2-4 引文改字（命中率不足 60%）→ citation-check 拒（${r4.errors?.[0]?.reason}）`);
  // 4b) 照抄含校注原文的真实引文 → 收（修前误杀：源文剥校注引文不剥，D-06）
  const r4b = go("fuzz-pkg", [["SKILL.md", `---
name: fuzz-pkg
description: 校注引文测试
sources: { dd: daodejing-zh.docx }
---
> ${quote}〔dd·${row.chapter}〕

照抄含校注原文。
`]]);
  ok(r4b.ok, `门2-4b 照抄含校注原文的真实引文 → 收（对称剥离修复生效；失败详情 ${r4b.errors?.[0]?.reason || r4b.errors?.[0]?.hint || "无"}）`);
  // 5) broken-reference：SKILL.md 索引指向不存在文件 → 拒
  const r5 = go("fuzz-pkg", [["SKILL.md", skillMd("")], ["chapters/ch01-x.md", "# 空章节文件\n内容。"]]);
  ok(r5.ok, "门2-5a 控制组：索引指向真实存在文件 → 收");
  const r5b = go("fuzz-pkg", [["SKILL.md", skillMd("") + "\n详见 [进阶](chapters/ch99-none.md) 和 [术语](glossary.md)。\n"]]);
  ok(!r5b.ok && /broken-reference/.test(JSON.stringify(r5b.errors || [])), `门2-5 索引指向不存在 ch99-none.md → 拒（${r5b.errors?.[0]?.reason}）`);
  // 6) slug 穿越 → 拒
  const r6 = go("../evil", [["SKILL.md", skillMd("")]]);
  ok(!r6.ok && /bad-slug/.test(JSON.stringify(r6.errors)), "门2-6 slug 路径穿越（../evil）→ 拒");
  // 7) 单文件超限（600KB）→ 拒
  const r7 = go("fuzz-pkg", [["SKILL.md", skillMd("")], ["chapters/ch01-x.md", "字".repeat(600 * 1024)]]);
  ok(!r7.ok && /file-too-large/.test(JSON.stringify(r7.errors)), "门2-7 单文件 600KB 超 512KB 上限 → 拒");
  // 8) unknown-source：别名不在 sources → 拒
  const r8 = go("fuzz-pkg", [["SKILL.md", `---
name: fuzz-pkg
description: 未知来源测试
sources: { dd: daodejing-zh.docx }
---
> 测试引文〔ghost·第一章〕
`]]);
  ok(!r8.ok && /unknown-source|chapter-not-found/.test(JSON.stringify(r8.errors)), `门2-8 引用别名/章节不存在 → 拒（${r8.errors?.[0]?.reason}）`);
  // 9) chapter-not-found：章节名乱写 → 拒
  const r9 = go("fuzz-pkg", [["SKILL.md", `---
name: fuzz-pkg
description: 章节不存在测试
sources: { dd: daodejing-zh.docx }
---
> ${quote}〔dd·不存在的章节名〕
`]]);
  ok(!r9.ok && r9.stage === "citation-check" && /chapter-not-found/.test(JSON.stringify(r9.errors)), "门2-9 章节名乱写 → chapter-not-found 拒");
  // 10) claimNum 单测
  ok(claimNum("八十一") === 81 && claimNum("一千") === 1000 && claimNum("两百五十一") === 251
    && claimNum("十四") === 14 && claimNum("２５") === 25 && Number.isNaN(claimNum("若干")),
    "门2-10 claimNum：八十一=81 / 一千=1000 / 两百五十一=251 / 十四=14 / 全角25 / 「若干」=NaN");
  try { fs.rmSync(skillsDir, { recursive: true, force: true }); } catch { /* 沙箱 */ }
}

// ================= 门3 考卷门：金标准回原文反验 =================
console.log("===== 门3 考卷金标准反验（GOLDEN 52 题全查） =====");
{
  // v2-eval.mjs 无导出且 import 会真跑评测 → 正则提取 GOLDEN 字面量
  const src = fs.readFileSync(path.join(ROOT, "test/v2-eval.mjs"), "utf8")
    .split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
  const items = [];
  const re = /\{\s*book:\s*"([^"]+)"[\s\S]*?g:\s*\[([^\]]*)\]\s*\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const gs = [...m[2].matchAll(/"([^"]+)"/g)].map(x => x[1]);
    if (gs.length) items.push({ book: m[1], g: gs });
  }
  ok(items.length >= 50, `门3-0 GOLDEN 提取 ${items.length} 题（≥50 才算覆盖考卷）`);
  const cache = new Map();
  const textOf = (book) => {
    if (!cache.has(book)) {
      const d = new Database(path.join(LIB, book + ".db"), { readonly: true });
      cache.set(book, d.prepare("SELECT text FROM chunks").all().map(r => r.text).join("\n").toLowerCase());
      d.close();
    }
    return cache.get(book);
  };
  const bad = [];
  const redundant = [];
  for (const it of items) {
    const text = textOf(it.book);
    const hits = it.g.filter(kw => text.includes(kw.toLowerCase()));
    // 判分语义同 v2-eval.mjs 90 行：some（任一金标准词命中即有效题）——全不中才是考卷带幻觉
    if (!hits.length) bad.push(`「${it.g.join("/")}」全部不在 ${it.book}`);
    else if (hits.length < it.g.length) redundant.push(`${it.g.filter(k => !hits.includes(k)).join("/")}@${it.book}`);
  }
  ok(bad.length === 0, `门3-1 每题至少一个金标准词回原文验真（some 语义，同 v2-eval 90 行）${bad.length ? "，失败: " + bad.join("; ") : ""}`);
  obs(`门3-2 冗余金标准词（some 语义允许的提名冗余，非幻觉）：${redundant.join("; ") || "无"}`);
}

// ================= 门4 检索门：探针（记录型） =================
console.log("===== 门4 检索探针（记录型：检索是相关性排序不是事实核查） =====");
{
  configureSearch({ libDir: LIB });
  configureModels({ modelsDir: path.join(ROOT, ".models") });
  const { hybridSearch } = await import("../src/lib/search.mjs");
  const probes = [
    ["无答案", "孟子怎么看股市"],
    ["无答案", "孟子对人工智能的看法"],
    ["篡改主语", "孔子曰：民為貴，君為輕"],
    ["篡改主语", "孟子曰：言而有信，与朋友交"],
    ["正常对照", "什么是仁，孟子怎么解释"],
    ["书中没有", "孟子的母亲叫什么名字"],
  ];
  for (const [kind, q] of probes) {
    const rs = await hybridSearch(path.join(LIB, "mengzi-zh.docx.db"), q, 5, { rerank: true });
    const top = rs[0];
    obs(`门4 [${kind}]「${q}」top1=${top ? top.score.toFixed(3) : "无"} [${top?.chapter || "-"}] ${JSON.stringify((top?.text || "").slice(0, 40))}`);
  }
  obs("门4 定性：无答案探针 top1 分数显著低于正常题即合格；篡改主语探针记录答案块是否居首——"
    + "语义检索没有主语概念，此为本类系统的固有边界（对策在引用徽章可见原文，不假装清零）");
}

// ================= 汇总 =================
console.log(`\n===== P0 幻觉爆破汇总：${pass} PASS / ${fail} FAIL / ${observe} OBSERVE =====`);
if (failures.length) { console.log("失败项："); failures.forEach(f => console.log("  ✗ " + f)); }
process.exit(fail ? 1 : 0);
