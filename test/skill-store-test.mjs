// skill-store 单元测试：结构校验 + 引用回源验证（防幻觉红线）
// 惯例：tmpdir 实验（skillsDir 注入），引用验证用真库 library/daodejing-zh.docx.db（只读）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveSkill, readSkill, listSkills, extractCitations, parseFrontmatter } from "../src/lib/skill-store.mjs";

let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log(`PASS - ${name}`); }
  else { fail++; console.log(`FAIL - ${name} ${extra}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-skill-"));
const goodFm = `---
name: test-skill
title: 测试技能
description: 用于单元测试的技能包
sources:
  道德经: daodejing-zh
---
# 测试技能
核心心智模型占位。
`;

const goodChapter = (quote) => `# 第一章 · 测试
说明文字。

> ${quote}
`;

// frontmatter 构造器：可换 description、可带 coverage（出厂自检用）
const makeFm = ({ coverage, desc = "用于单元测试的技能包" } = {}) => `---
name: test-skill
title: 测试技能
description: ${desc}
sources:
  道德经: daodejing-zh
${coverage ? `coverage: ${coverage}\n` : ""}---
# 测试技能
核心心智模型占位。
`;

// 两章引用样例（第四十八章、第八章——真库验真后 covered=2，道德经全书 81 章）
const ch48 = goodChapter("為學日益，為道日損。〔道德经·第四十八章〕");
const ch08 = goodChapter("上善若水，水善利萬物而不爭。〔道德经·第八章〕");

// ========== 1) slug 白名单与路径穿越 ==========
{
  for (const bad of ["../evil", "..\\evil", "a/b", ".git", "", "大写的中文"]) {
    const r = saveSkill(bad, [{ path: "SKILL.md", content: goodFm }], { skillsDir: tmp });
    ok(r.ok === false && r.errors.some(e => e.reason === "bad-slug"), `slug 拒收: ${JSON.stringify(bad)}`);
  }
  ok(!fs.existsSync(path.join(tmp, "evil")), "穿越 slug 未在磁盘产生任何目录");
}

// ========== 2) 文件路径白名单 ==========
{
  const base = { slug: "test-skill", skillsDir: tmp };
  let r = saveSkill(base.slug, [{ path: "../../package.json", content: "x" }], base);
  ok(r.errors.some(e => e.reason === "bad-path"), "路径白名单: ../../package.json 拒收");
  r = saveSkill(base.slug, [{ path: "chapters/x.js", content: "x" }], base);
  ok(r.errors.some(e => e.reason === "bad-path"), "路径白名单: chapters/x.js 拒收");
  r = saveSkill(base.slug, [{ path: "SKILL.txt", content: "x" }], base);
  ok(r.errors.some(e => e.reason === "bad-path"), "路径白名单: SKILL.txt 拒收");
}

// ========== 3) 结构校验 ==========
{
  const base = { slug: "test-skill", skillsDir: tmp };
  let r = saveSkill(base.slug, [{ path: "chapters/ch01-a.md", content: "# x" }], base);
  ok(r.errors.some(e => e.reason === "missing-skill-md"), "结构: 缺 SKILL.md 拒收");
  const noDesc = goodFm.replace(/description:.*/g, "").replace(/\n\n/g, "\n");
  r = saveSkill(base.slug, [{ path: "SKILL.md", content: noDesc }], base);
  ok(r.errors.some(e => e.reason === "bad-frontmatter"), "结构: 缺 description 拒收");
  const wrongName = goodFm.replace("name: test-skill", "name: other-slug");
  r = saveSkill(base.slug, [{ path: "SKILL.md", content: wrongName }], base);
  ok(r.errors.some(e => e.reason === "bad-frontmatter"), "结构: name != slug 拒收");
  ok(parseFrontmatter(goodFm).data.sources["道德经"] === "daodejing-zh", "frontmatter: sources 别名映射解析正确");
}

// ========== 4) 引用别名未声明 ==========
{
  const r = saveSkill("test-skill",
    [{ path: "SKILL.md", content: goodFm }, { path: "chapters/ch01-a.md", content: goodChapter("道可道非常道。〔庄子·第一章〕") }],
    { skillsDir: tmp });
  ok(r.ok === false && r.stage === "citation-check" && r.errors.some(e => e.reason === "unknown-source"),
    "别名未声明: unknown-source", JSON.stringify(r.errors));
}

// ========== 5) 章节造假 ==========
{
  const r = saveSkill("test-skill",
    [{ path: "SKILL.md", content: goodFm }, { path: "chapters/ch01-a.md", content: goodChapter("天地不仁。〔道德经·第九十九章〕") }],
    { skillsDir: tmp });
  const e = r.errors?.find(e => e.reason === "chapter-not-found");
  ok(r.ok === false && !!e, "章节造假: chapter-not-found");
  ok(!e || /第[一-龥]+章/.test(e.hint), "章节造假: hint 给出实际章节示例", e && e.hint);
}

// ========== 6) 引文造假 ==========
{
  const r = saveSkill("test-skill",
    [{ path: "SKILL.md", content: goodFm }, { path: "chapters/ch01-a.md", content: goodChapter("天地不仁，以萬物為魚狗；聖人不仁，以百姓為魚狗。〔道德经·第五章〕") }],
    { skillsDir: tmp });
  const e = r.errors?.find(e => e.reason === "quote-not-found");
  ok(r.ok === false && !!e, "引文造假: quote-not-found");
  ok(!e || (e.file === "chapters/ch01-a.md" && e.line >= 1), "引文造假: 错误定位到文件与行号");
}

// ========== 7) 校注容忍：剥「一作」后真实引文必须通过 ==========
{
  const r = saveSkill("test-skill",
    [{ path: "SKILL.md", content: goodFm }, { path: "chapters/ch01-a.md", content: goodChapter("天地不仁，以萬物為芻狗；聖人不仁，以百姓為芻狗。〔道德经·第五章〕") }],
    { skillsDir: tmp });
  ok(r.ok === true, "校注容忍: 剥「一作」后真实引文通过", JSON.stringify(r.errors));
}

// ========== 8) 正常落盘 ==========
{
  const r = saveSkill("test-skill",
    [
      { path: "SKILL.md", content: goodFm },
      { path: "chapters/ch01-shui.md", content: goodChapter("上善若水，水善利萬物而不爭。〔道德经·第八章〕") },
      { path: "chapters/ch02-wu-wei.md", content: goodChapter("為學日益，為道日損。〔道德经·第四十八章〕") },
      { path: "cheatsheet.md", content: "# 速查\n- 用『无为』处理：不妄为场景\n" },
    ],
    { skillsDir: tmp });
  ok(r.ok === true && r.citations_checked === 2, `正常落盘: ok:true（校验 ${r.citations_checked} 条引用）`, JSON.stringify(r));
  ok(fs.existsSync(path.join(tmp, "test-skill", "SKILL.md")) &&
     fs.existsSync(path.join(tmp, "test-skill", "chapters", "ch01-shui.md")) &&
     fs.existsSync(path.join(tmp, "test-skill", "cheatsheet.md")), "正常落盘: 磁盘文件齐全");
}

// ========== 9) 读回 ==========
{
  const r = readSkill("test-skill", undefined, { skillsDir: tmp });
  ok(r.skill_md && r.index.length === 2 &&
     r.index[0].file === "chapters/ch01-shui.md" && r.index[0].tokens_est > 0, "读回: SKILL.md + 章节索引");
  const c = readSkill("test-skill", "ch01-shui.md", { skillsDir: tmp });
  ok(c.content && c.content.includes("上善若水"), "读回: 按需取单章");
  ok(readSkill("test-skill", "ch01-evil.js", { skillsDir: tmp }).error === "bad-chapter", "读回: 章节文件名白名单");
}

// ========== 10) 读不存在 ==========
{
  const miss = readSkill("nope", undefined, { skillsDir: tmp });
  ok(miss.error === "skill-not-found" && Array.isArray(miss.available), "读不存在: error + available");
  const missCh = readSkill("test-skill", "ch99-none.md", { skillsDir: tmp });
  ok(missCh.error === "chapter-not-found" && Array.isArray(missCh.available), "读不存在章节: error + available");
}

// ========== 11) list_skills ==========
{
  // 再落一个不同 slug 的技能（含合法引用）
  const fm2 = goodFm.replace("test-skill", "test-skill-2");
  saveSkill("test-skill-2",
    [{ path: "SKILL.md", content: fm2 }, { path: "chapters/ch01-a.md", content: goodChapter("為學日益，為道日損。〔道德经·第四十八章〕") }],
    { skillsDir: tmp });
  const list = listSkills({ skillsDir: tmp });
  ok(list.length === 2 && list[0].slug === "test-skill", `list_skills: 枚举 ${list.length} 个技能`);
  ok(list[0].title === "测试技能" && list[0].description.includes("单元测试") && list[0].chapters === 2 &&
     list[0].sources[0] === "daodejing-zh", "list_skills: 字段齐全（title/description/chapters/sources）");
}

// ========== 12) 幂等覆盖 ==========
{
  const r = saveSkill("test-skill",
    [
      { path: "SKILL.md", content: goodFm },
      { path: "chapters/ch01-only.md", content: goodChapter("為學日益，為道日損。〔道德经·第四十八章〕") },
    ],
    { skillsDir: tmp });
  ok(r.ok === true, "幂等覆盖: 二次 save 成功");
  const reread = readSkill("test-skill", undefined, { skillsDir: tmp });
  ok(reread.index.length === 1 && reread.index[0].file === "chapters/ch01-only.md", "幂等覆盖: 整包替换（旧章节消失）");
  ok(!fs.existsSync(path.join(tmp, "test-skill", "chapters", "ch01-shui.md")), "幂等覆盖: 旧文件不留残骸");
}

// ========== 13) 校验失败不落半包（原子性） ==========
{
  const r = saveSkill("atomic-test",
    [
      { path: "SKILL.md", content: goodFm.replace("test-skill", "atomic-test") },
      { path: "chapters/ch01-ok.md", content: goodChapter("為學日益。〔道德经·第四十八章〕") },
      { path: "chapters/ch02-fake.md", content: goodChapter("这一句是编造的假引文。〔道德经·第四十八章〕") },
    ],
    { skillsDir: tmp });
  ok(r.ok === false && r.errors.some(e => e.reason === "quote-not-found"), "原子性: 假引文整包拒收");
  ok(!fs.existsSync(path.join(tmp, "atomic-test")), "原子性: 拒收后目录不存在（一个字节都没写）");
  ok(!fs.readdirSync(tmp).some(d => d.includes(".tmp-")), "原子性: 无临时目录残留");
}

// ========== 14) 引文提取单元 ==========
{
  const cits = extractCitations([
    { path: "chapters/x.md", content: "> 上善若水。〔道德经·第八章〕\n普通行〔不提取〕\n> 第二条〔道德经·第二章〕" },
  ]);
  ok(cits.length === 2 && cits[0].chapter === "第八章" && cits[0].line === 1 &&
     cits[0].quote === "上善若水。" && cits[1].quote === "第二条", "引文提取: 只认 blockquote、行号与引文正确");
}

// ========== 15) 出厂自检：声称 vs 实际（coverage-check） ==========
{
  const base = { slug: "test-skill", skillsDir: tmp };

  // a) coverage 声明正确（2/81）→ 过，且返回清点单
  let r = saveSkill("test-skill",
    [{ path: "SKILL.md", content: makeFm({ coverage: "2/81" }) }, { path: "chapters/ch01-a.md", content: ch48 }, { path: "chapters/ch02-b.md", content: ch08 }],
    base);
  ok(r.ok === true, "出厂自检: coverage 2/81 声明正确通过", JSON.stringify(r.errors));
  ok(r.coverage && r.coverage.covered === 2 && r.coverage.total === 81 && r.coverage.percent === 2,
    "出厂自检: 清点单 covered/total/percent 正确", JSON.stringify(r.coverage));
  ok(Array.isArray(r.coverage.chapters) && r.coverage.chapters.length === 2, "出厂自检: 清点单带章节清单");

  // b) coverage N 写错
  r = saveSkill("test-skill",
    [{ path: "SKILL.md", content: makeFm({ coverage: "3/81" }) }, { path: "chapters/ch01-a.md", content: ch48 }, { path: "chapters/ch02-b.md", content: ch08 }],
    base);
  ok(r.ok === false && r.stage === "coverage-check" && r.errors.some(e => e.reason === "coverage-mismatch"),
    "出厂自检: coverage 覆盖数写错拒收");

  // c) coverage 分母写错
  r = saveSkill("test-skill",
    [{ path: "SKILL.md", content: makeFm({ coverage: "2/80" }) }, { path: "chapters/ch01-a.md", content: ch48 }, { path: "chapters/ch02-b.md", content: ch08 }],
    base);
  ok(r.errors.some(e => e.reason === "coverage-total-mismatch"), "出厂自检: coverage 分母写错拒收");

  // d) 能力声称对上（2章速查 + 2 章实覆盖）→ 过
  r = saveSkill("test-skill",
    [{ path: "SKILL.md", content: makeFm({ desc: "道德经2章速查" }) }, { path: "chapters/ch01-a.md", content: ch48 }, { path: "chapters/ch02-b.md", content: ch08 }],
    base);
  ok(r.ok === true, "出厂自检: 能力声称与实际一致放行", JSON.stringify(r.errors));

  // e) 能力声称吹牛（复现道德经案：81章速查，实覆盖 2）→ 拒
  r = saveSkill("test-skill",
    [{ path: "SKILL.md", content: makeFm({ desc: "老子81章原典速查" }) }, { path: "chapters/ch01-a.md", content: ch48 }],
    base);
  ok(r.ok === false && r.errors.some(e => e.reason === "claimed-coverage-lie" && e.claimed === 81 && e.actual === 1),
    "出厂自检: 「81章速查」吹牛拒收（复现本案）");

  // f) 书属性声称：全书 81 章正确 → 过 + warning 建议补 coverage；全书 80 章 → 拒
  r = saveSkill("test-skill",
    [{ path: "SKILL.md", content: makeFm({ desc: "全书81章的精选，用于单元测试" }) }, { path: "chapters/ch01-a.md", content: ch48 }, { path: "chapters/ch02-b.md", content: ch08 }],
    base);
  ok(r.ok === true && r.warnings.some(w => w.includes("coverage")), "出厂自检: 书属性正确放行并提示补 coverage", JSON.stringify(r.warnings));
  r = saveSkill("test-skill",
    [{ path: "SKILL.md", content: makeFm({ desc: "全书80章的精选，用于单元测试" }) }, { path: "chapters/ch01-a.md", content: ch48 }],
    base);
  ok(r.errors.some(e => e.reason === "book-total-lie"), "出厂自检: 书属性写错拒收");

  // g) 索引表指向不存在的文件 → 拒
  const brokenIdx = makeFm({ coverage: "2/81" }) + "\n## 章节索引\n| chapters/ch99-none.md | 幽灵章 | 99 |\n";
  r = saveSkill("test-skill",
    [{ path: "SKILL.md", content: brokenIdx }, { path: "chapters/ch01-a.md", content: ch48 }, { path: "chapters/ch02-b.md", content: ch08 }],
    base);
  ok(r.errors.some(e => e.reason === "broken-reference" && e.file === "chapters/ch99-none.md"),
    "出厂自检: 索引表指向不存在文件拒收");

  // h) coverage 坏格式
  r = saveSkill("test-skill",
    [{ path: "SKILL.md", content: makeFm({ coverage: "很多章" }) }, { path: "chapters/ch01-a.md", content: ch48 }],
    base);
  ok(r.errors.some(e => e.reason === "bad-coverage"), "出厂自检: coverage 坏格式拒收");

  // i) 多书技能：M 校验跳过只给 warning，不误杀
  const fm2src = makeFm({ coverage: "1" }).replace("  道德经: daodejing-zh", "  道德经: daodejing-zh\n  論語: lunyu-xueer-zh");
  r = saveSkill("test-skill",
    [{ path: "SKILL.md", content: fm2src }, { path: "chapters/ch01-a.md", content: ch48 }],
    base);
  ok(r.ok === true && r.coverage === null, "出厂自检: 多书技能跳过 coverage 校验不误杀", JSON.stringify(r.errors));
}

// ========== 16) 大小上限（防失控智能体写超大文件） ==========
{
  const big = "x".repeat(513 * 1024); // 513KB > 单文件上限 512KB
  let r = saveSkill("test-skill",
    [{ path: "SKILL.md", content: goodFm }, { path: "glossary.md", content: big }],
    { skillsDir: tmp });
  ok(r.ok === false && r.stage === "structure" && r.errors.some(e => e.reason === "file-too-large"),
    "大小上限: 单文件 513KB 拒收");
  const mid = "y".repeat(400 * 1024); // 三个 400KB = 1.2MB > 整包上限 1MB，单文件均未超
  r = saveSkill("test-skill",
    [
      { path: "SKILL.md", content: goodFm },
      { path: "glossary.md", content: mid },
      { path: "patterns.md", content: mid },
      { path: "cheatsheet.md", content: mid },
    ],
    { skillsDir: tmp });
  ok(r.ok === false && r.errors.some(e => e.reason === "total-too-large"),
    "大小上限: 整包 1.2MB 拒收（单文件均未超）");
  ok(!fs.existsSync(path.join(tmp, "test-skill", "glossary.md")) &&
     !fs.existsSync(path.join(tmp, "test-skill", "patterns.md")),
    "大小上限: 拒收后不落任何文件");
}

// ========== 17) catalog.json 进包（P-A：技能×编目融合，皮骨同包） ==========
{
  const base = { slug: "test-skill", skillsDir: tmp };
  // 真骨架长这样（skill-scaffold 生成）：book_id 与 SKILL.md sources 指向同一本书，章节表是查出来的真值
  const catalog = JSON.stringify({
    book: "道德经", book_id: "daodejing-zh", cataloged: true,
    chapters_total: 81, chunks_total: 120,
    chapters: [{ chapter: "第八章", chunks: 3, suggested_file: "ch01-di-ba-zhang.md" }],
    themes: [], persons: [], relations: [],
  }, null, 2);

  // a) 合法 catalog.json → 放行；read_skill 带 catalog；list_skills 标 has_catalog
  let r = saveSkill("test-skill", [{ path: "SKILL.md", content: goodFm }, { path: "catalog.json", content: catalog }], base);
  ok(r.ok === true, "P-A: 带 catalog.json 整包落盘通过", JSON.stringify(r.errors));
  let read = readSkill("test-skill", undefined, base);
  ok(read.catalog && read.catalog.book_id === "daodejing-zh" && read.catalog.chapters_total === 81,
    "P-A: read_skill 返回 catalog（机器可读索引随包走，离库分享也能用）");
  ok(listSkills(base).find(s => s.slug === "test-skill").has_catalog === true, "P-A: list_skills 带 has_catalog=true");

  // b) 坏 JSON → 首版只 warning 不拒收（融合规划风险表：先观察再升 error）
  r = saveSkill("test-skill", [{ path: "SKILL.md", content: goodFm }, { path: "catalog.json", content: "{ 这不是 json" }], base);
  ok(r.ok === true && r.warnings.some(w => w.includes("catalog.json")),
    "P-A: 坏 catalog.json 只 warning 不拒收（先观察后收紧）", JSON.stringify(r.errors));
  ok(readSkill("test-skill", undefined, base).catalog === null, "P-A: 坏 catalog.json 读回降级为 null（不炸读流程）");

  // c) book_id 与 SKILL.md sources 不对齐 → warning（包里的地图和封面必须指向同一本书）
  r = saveSkill("test-skill", [{ path: "SKILL.md", content: goodFm },
    { path: "catalog.json", content: catalog.replace("daodejing-zh", "zhuangzi-zh") }], base);
  ok(r.ok === true && r.warnings.some(w => w.includes("book_id")),
    "P-A: catalog book_id 与 sources 不对齐给 warning", JSON.stringify(r.warnings));

  // d) 旧包（无 catalog.json）零影响——新增不得破坏既有资产
  saveSkill("test-skill", [{ path: "SKILL.md", content: goodFm }], base);
  read = readSkill("test-skill", undefined, base);
  ok(read.catalog === null && listSkills(base).find(s => s.slug === "test-skill").has_catalog === false,
    "P-A: 旧包零影响——catalog=null / has_catalog=false");
}

// ========== 18) references/ 通道（W2b：开放标准目录，kb-research 迁此） ==========
{
  const base = { slug: "test-skill", skillsDir: tmp };
  // a) references/ 路径整包落盘 + 索引表指向 references/ 不触发 broken-reference
  const refFm = makeFm({ coverage: "1/81" }) + "\n## 参考文件索引\n| references/ch01-dongxian.md | 动线详解 | 9 |\n";
  let r = saveSkill("test-skill",
    [
      { path: "SKILL.md", content: refFm },
      { path: "references/ch01-dongxian.md", content: ch48 },
    ],
    base);
  ok(r.ok === true, "references: 整包落盘通过（索引指向 references/ 不报 broken-reference）", JSON.stringify(r.errors));

  // b) 读回：index 带真实前缀；裸文件名按需取章（engine 视图传法）
  const back = readSkill("test-skill", undefined, base);
  ok(back.index.length === 1 && back.index[0].file === "references/ch01-dongxian.md",
    "references: 章节索引带 references/ 前缀", JSON.stringify(back.index));
  const chap = readSkill("test-skill", "ch01-dongxian.md", base);
  ok(chap.content && chap.content.includes("為學日益") && chap.file === "references/ch01-dongxian.md",
    "references: 裸文件名读回（file 字段带实际前缀）");

  // c) 两代并存：同 slug 再补一个 chapters/ 文件，索引合并两目录
  r = saveSkill("test-skill",
    [
      { path: "SKILL.md", content: makeFm({ coverage: "2/81" }) },
      { path: "references/ch01-dongxian.md", content: ch48 },
      { path: "chapters/ch02-legacy.md", content: ch08 },
    ],
    base);
  ok(r.ok === true, "references: 两代目录并存落盘通过", JSON.stringify(r.errors));
  const mixed = readSkill("test-skill", undefined, base);
  ok(mixed.index.length === 2 &&
     mixed.index[0].file === "chapters/ch02-legacy.md" && // chapters 排序在前（子目录序：chapters < references）
     mixed.index[1].file === "references/ch01-dongxian.md",
    "references: 两代目录索引合并（chapters 与 references 同列）", JSON.stringify(mixed.index));

  // d) references 路径穿越拒收（白名单只放行 kebab 单层）
  r = saveSkill("test-skill",
    [{ path: "SKILL.md", content: goodFm }, { path: "references/../evil.md", content: "x" }],
    base);
  ok(r.errors.some(e => e.reason === "bad-path"), "references: 路径穿越拒收");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n===== skill-store-test: ${pass} PASS / ${fail} FAIL =====`);
if (fail) { console.error(`测试失败 ${fail} 项`); process.exit(1); }
