// skill-health 单元测试：红黄绿七场景 + 汇总计数 + 僵尸目录识别
// 惯例：tmpdir 双注入——skillsDir 显式传、libDir 走 configureSearch（引文回源走 search 层
// currentLibDir()，与桌面/MCP 同一通道）；假书库用 better-sqlite3 现场造（meta + chunks 两表）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { checkSkills } from "../src/lib/skill-health.mjs";
import { saveSkill } from "../src/lib/skill-store.mjs";
import { configureSearch } from "../src/lib/search.mjs";
import { setSkillEnabled } from "../src/lib/skill-state.mjs";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log(`PASS - ${name}`); }
  else { fail++; console.log(`FAIL - ${name} ${extra}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-health-"));
const SKILLS = path.join(tmp, "skills");
const LIB = path.join(tmp, "library");
fs.mkdirSync(SKILLS, { recursive: true });
fs.mkdirSync(LIB, { recursive: true });
configureSearch({ libDir: LIB });

// 假书库：meta（title/format/chunk_count/total_tokens）+ chunks（chapter/text）
// verifyCitations 只查 chapter/page/text；page 可空
function makeBook(id, title, chapters) {
  const db = new Database(path.join(LIB, id + ".db"));
  db.exec("CREATE TABLE meta (key TEXT, value TEXT)");
  db.exec("CREATE TABLE chunks (id INTEGER PRIMARY KEY, chunk_id INTEGER, chapter TEXT, page INTEGER, text TEXT, emb BLOB)");
  db.prepare("INSERT INTO meta (key,value) VALUES (?,?)").run("title", title);
  db.prepare("INSERT INTO meta (key,value) VALUES (?,?)").run("format", "docx");
  db.prepare("INSERT INTO meta (key,value) VALUES (?,?)").run("chunk_count", String(Object.keys(chapters).length));
  db.prepare("INSERT INTO meta (key,value) VALUES (?,?)").run("total_tokens", "999");
  let cid = 1;
  for (const [ch, text] of Object.entries(chapters)) {
    db.prepare("INSERT INTO chunks (chunk_id, chapter, text) VALUES (?,?,?)").run(cid, ch, text);
    cid++;
  }
  db.close();
}
// 两本假书：fakebook（健康场景用，2 章）；gonebook（将被删掉验证源书丢失）
makeBook("fakebook-zh", "假书", {
  第一章: "上善若水，水善利萬物而不爭。",
  第二章: "知人者智，自知者明。",
});
makeBook("gonebook-zh", "将删之书", { 第一章: "旧书引文，用来验证删书后变红。" });

const fm = (name, extra = "") => `---
name: ${name}
title: ${name} 标题
description: 体检测试用技能包
${extra}---
# ${name}
`;

// 场景包直写磁盘（模拟"落盘时合法、之后书库变了/包被手改"——saveSkill 会拒收这些，体检必须能逮）
const rawWrite = (slug, files) => {
  const dir = path.join(SKILLS, slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const p = path.join(dir, ...f.path.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content, "utf8");
  }
};
const find = (r, slug) => r.packages.find(p => p.slug === slug);
const reasons = (p) => p.findings.map(f => f.reason);

// ========== 1) 健康绿：真书 + 真引文 + 有章节 ==========
{
  const r0 = saveSkill("pkg-green", [
    { path: "SKILL.md", content: fm("pkg-green", "sources:\n  假书: fakebook-zh\n") },
    { path: "references/ch01-real.md", content: "# 真引文章\n\n> 上善若水，水善利萬物而不爭。〔假书·第一章〕\n" },
  ], { skillsDir: SKILLS });
  ok(r0.ok === true, "S1 前置: saveSkill 接受健康包");
  const r = checkSkills({ skillsDir: SKILLS });
  const p = find(r, "pkg-green");
  ok(p && p.status === "green", "S1 健康包体检为绿", JSON.stringify(p && p.findings));
  ok(p && p.citations.checked === 1 && p.citations.failed === 0, "S1 引文 1/1 通过");
  ok(p && p.coverage && p.coverage.covered === 1 && p.coverage.total === 2, "S1 覆盖账 1/2 章", JSON.stringify(p && p.coverage));
}

// ========== 2) 源书被删 → 红 ==========
{
  const r0 = saveSkill("pkg-gone", [
    { path: "SKILL.md", content: fm("pkg-gone", "sources:\n  旧书: gonebook-zh\n") },
    { path: "references/ch01-old.md", content: "# 旧书章\n\n> 旧书引文，用来验证删书后变红。〔旧书·第一章〕\n" },
  ], { skillsDir: SKILLS });
  ok(r0.ok === true, "S2 前置: saveSkill 接受源书包（书还在）");
  fs.rmSync(path.join(LIB, "gonebook-zh.db"));  // 之后书被删了
  const r = checkSkills({ skillsDir: SKILLS });
  const p = find(r, "pkg-gone");
  ok(p && p.status === "red" && reasons(p).includes("source-missing"), "S2 源书被删 → 红 source-missing", JSON.stringify(p && p.findings));
  ok(p && p.sources[0].state === "missing", "S2 sources 行标记 missing", JSON.stringify(p && p.sources));
}

// ========== 3) 引文手改造假 → 红 ==========
{
  rawWrite("pkg-fake", [
    { path: "SKILL.md", content: fm("pkg-fake", "sources:\n  假书: fakebook-zh\n") },
    { path: "references/ch01-fake.md", content: "# 假引文章\n\n> 这是完全编造的引文句子。〔假书·第一章〕\n" },
  ]);
  const r = checkSkills({ skillsDir: SKILLS });
  const p = find(r, "pkg-fake");
  ok(p && p.status === "red" && reasons(p).includes("quote-not-found"), "S3 引文造假 → 红 quote-not-found", JSON.stringify(p && p.findings));
}

// ========== 4) 索引断链 → 红 ==========
{
  rawWrite("pkg-brokenref", [
    { path: "SKILL.md", content: fm("pkg-brokenref", "sources:\n  假书: fakebook-zh\n") + "\n## 参考文件索引\n\n| references/ch99-nope.md | 断链测试 |\n" },
  ]);
  const r = checkSkills({ skillsDir: SKILLS });
  const p = find(r, "pkg-brokenref");
  ok(p && p.status === "red" && reasons(p).includes("broken-reference"), "S4 索引断链 → 红 broken-reference", JSON.stringify(p && p.findings));
}

// ========== 5) 覆盖声称对不上 → 红 ==========
{
  rawWrite("pkg-lie", [
    { path: "SKILL.md", content: fm("pkg-lie", "sources:\n  假书: fakebook-zh\n") + "\n本技能是全书3章速查。\n" },
    { path: "references/ch01-real.md", content: "# 真引文章\n\n> 知人者智，自知者明。〔假书·第二章〕\n" },
  ]);
  const r = checkSkills({ skillsDir: SKILLS });
  const p = find(r, "pkg-lie");
  ok(p && p.status === "red" && reasons(p).includes("book-total-lie"), "S5 声称全书3章（实2章）→ 红 book-total-lie", JSON.stringify(p && p.findings));
}

// ========== 6) 源书被关 → 黄（书还在，引文仍可回源） ==========
{
  const r0 = saveSkill("pkg-off", [
    { path: "SKILL.md", content: fm("pkg-off", "sources:\n  假书: fakebook-zh\n") },
    { path: "references/ch01-real.md", content: "# 真引文章\n\n> 上善若水，水善利萬物而不爭。〔假书·第一章〕\n" },
  ], { skillsDir: SKILLS });
  ok(r0.ok === true, "S6 前置: saveSkill 接受源书包");
  setSkillEnabled(LIB, "fakebook-zh", false);  // 主人在桌面端关掉这本书
  const r = checkSkills({ skillsDir: SKILLS });
  const p = find(r, "pkg-off");
  ok(p && p.status === "yellow" && reasons(p).includes("source-disabled"), "S6 源书被关 → 黄 source-disabled", JSON.stringify(p && p.findings));
  ok(p && p.citations.failed === 0, "S6 书关了但引文照样回源（0 失败）", JSON.stringify(p && p.citations));
  const g = find(r, "pkg-green");
  ok(g && g.status === "yellow" && reasons(g).includes("source-disabled"), "S6 同一本书的健康包同步变黄（关书≠坏书）");
  // 不还原：tmp 库本就为这场景而生，保持关闭锁定第 9 节汇总期望（红4/黄3/绿0）
}

// ========== 7) 无章节文件 → 黄 ==========
{
  const r0 = saveSkill("pkg-bare", [{ path: "SKILL.md", content: fm("pkg-bare", "sources: {}\n") }], { skillsDir: SKILLS });
  ok(r0.ok === true, "S7 前置: saveSkill 接受纯 SKILL.md 包");
  const r = checkSkills({ skillsDir: SKILLS });
  const p = find(r, "pkg-bare");
  ok(p && p.status === "yellow" && reasons(p).includes("no-chapters"), "S7 无章节文件 → 黄 no-chapters", JSON.stringify(p && p.findings));
}

// ========== 8) 僵尸临时目录：不进报告计数，但要在 warnings 点名 ==========
{
  const zdir = path.join(SKILLS, "pkg-green.tmp-1699999999");
  fs.mkdirSync(zdir, { recursive: true });
  fs.writeFileSync(path.join(zdir, "SKILL.md"), fm("zombie"), "utf8");
  const r = checkSkills({ skillsDir: SKILLS });
  ok(!find(r, "pkg-green.tmp-1699999999"), "S8 僵尸目录不进体检计数（SLUG_RE 挡掉）");
  ok(r.warnings.some(w => w.includes("pkg-green.tmp-1699999999")), "S8 僵尸目录在 warnings 点名", JSON.stringify(r.warnings));
  fs.rmSync(zdir, { recursive: true, force: true });
}

// ========== 9) 汇总计数对账 ==========
{
  const r = checkSkills({ skillsDir: SKILLS });
  ok(r.total === 7, "汇总: 共 7 个包", String(r.total));
  ok(r.red === 4 && r.yellow === 3 && r.green === 0, `汇总: 红4/黄3/绿0（实 红${r.red}/黄${r.yellow}/绿${r.green}）`);
  ok(r.warnings.length === 0, "汇总: 僵尸清掉后无 warnings", JSON.stringify(r.warnings));
}

// ========== 10) skillsDir 不存在 → 空报告不炸 ==========
{
  const r = checkSkills({ skillsDir: path.join(tmp, "no-such-skills") });
  ok(r.total === 0 && Array.isArray(r.packages) && r.warnings.length === 1, "skills/ 不存在 → 空报告 + 提示", JSON.stringify(r));
}

console.log(`\n===== skill-health: ${pass} PASS / ${fail} FAIL =====`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmp 清不掉不挡结论 */ }
process.exit(fail > 0 ? 1 : 0);
