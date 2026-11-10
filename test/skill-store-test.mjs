// skill-store 单元测试：结构校验 + 引用回源验证（防幻觉红线）
// 惯例：tmpdir 实验（skillsDir 注入），引用验证用真库 library/daodejing-zh.docx.db（只读）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveSkill, readSkill, listSkills, extractCitations, parseFrontmatter, deleteSkill, currentSkillsDir, DEFAULT_SKILLS_DIR, configureSkillStore } from "../src/lib/skill-store.mjs";

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

> 為學日益，為道日損。〔道德经·第四十八章〕
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

> 為學日益，為道日損。〔道德经·第四十八章〕
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
  // B5/CP3：scripts/ 移出白名单——技能包不收可执行脚本，hint 说人话
  r = saveSkill(base.slug, [{ path: "scripts/check.mjs", content: "console.log('x')" }], base);
  ok(r.errors.some(e => e.reason === "bad-path" && /可执行脚本/.test(e.hint || "")),
    "B5: scripts/check.mjs 拒收且 hint 说明「不收可执行脚本」", JSON.stringify(r.errors));
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
  ok(r.ok === true && r.citations_checked === 3, `正常落盘: ok:true（校验 ${r.citations_checked} 条引用——B5 后 SKILL.md 引文行也计入）`, JSON.stringify(r));
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

// ========== 14b) V09/A-08：空子句引文 fail-closed + 引文空壳拒收；B5/CP3：零引文包拒收 ==========
{
  const base = { slug: "test-skill", skillsDir: tmp };

  // a) 引文空壳：> 行带〔别名·章节〕但 quote 短到切不出 ≥4 字子句 → 拒（no-citation-clause）
  const shellFm = `---
name: test-skill
title: 测试技能
description: 引文空壳测试
sources:
  道德经: daodejing-zh
---
# 测试技能
> 啊。〔道德经·第八章〕
`;
  let r = saveSkill("test-skill", [{ path: "SKILL.md", content: shellFm }], base);
  ok(r.ok === false && r.stage === "citation-check" && r.errors?.[0]?.reason === "quote-too-short",
    "V09: 引文空壳（条条切不出有效子句）→ 拒收 quote-too-short（不再 ok:true 放行）", JSON.stringify(r.errors));

  // b) 单条短引文（同章还有真实内容）→ verifyCitations 直接拒 quote-too-short（不再放行）
  const shortOne = `---
name: test-skill
title: 测试技能
description: 短引文测试
sources:
  道德经: daodejing-zh
---
# 测试技能
> 啊。〔道德经·第八章〕
> 上善若水，水善利萬物而不爭。〔道德经·第八章〕
`;
  r = saveSkill("test-skill", [{ path: "SKILL.md", content: shortOne }], base);
  ok(r.ok === false && r.stage === "citation-check" && r.errors?.[0]?.reason === "quote-too-short",
    "V09: 短引文条目 → quote-too-short 拒收（空子句不再 ok:true）", JSON.stringify(r.errors));

  // c) 零引文包（SKILL.md 无任何 > 行）→ B5/CP3 拒收 no-quote（04 V09 验收口径：
  // 引文是回源验证的素材，零引文包无法回源——复核单裁定按 04 口径补齐）
  const noQuoteFm = goodFm.replace(/\n> 為學日益，為道日損。〔道德经·第四十八章〕\n/, "\n");
  r = saveSkill("test-skill", [{ path: "SKILL.md", content: noQuoteFm }], base);
  ok(r.ok === false && r.stage === "structure" && r.errors?.[0]?.reason === "no-quote",
    "B5: 零引文包（SKILL.md 无 > 行）→ no-quote 拒收", JSON.stringify(r.errors));
}

// ========== 14c) V09/A-08 防回归：脚本只落盘不执行（skills/*/scripts 不入执行链） ==========
{
  const fsMod = await import("node:fs");
  let execHit = null;
  const walk = (dir) => {
    for (const e of fsMod.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!["node_modules", "release", "books", "library", "skills", ".git", "build", "catalog-results", "catalog-tasks"].includes(e.name)) walk(path.join(dir, e.name)); }
      else if (/\.(mjs|js)$/.test(e.name)) {
        const src = fsMod.readFileSync(path.join(dir, e.name), "utf8");
        if (/\b(execFile|execFileSync|spawnSync)\b/.test(src) && /scripts/.test(src)) execHit = path.join(dir, e.name);
      }
    }
  };
  walk(path.join(import.meta.dirname, "..", "src"));
  ok(execHit === null, "V09: src/ 无任何执行 skills/*/scripts 的代码路径（只落盘不执行）", execHit || "");
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

// ========== 19) 删除（桌面「技能开关」页删除按钮：确认框直接删、不做回收站） ==========
{
  const delFm = `---
name: del-me
title: 待删除技能
description: 删除链路单测
sources:
  道德经: daodejing-zh
---
# 待删除技能

> 為學日益，為道日損。〔道德经·第四十八章〕
`;
  const base = { slug: "del-me", skillsDir: tmp };
  // a) 落一个带章节的包 → 删 → 整目录没了、列表不再有、回执带 skills/ 路径
  saveSkill("del-me", [{ path: "SKILL.md", content: delFm }, { path: "chapters/ch01-a.md", content: ch08 }], base);
  ok(fs.existsSync(path.join(tmp, "del-me", "SKILL.md")), "删除前：包在磁盘上（前置）");
  let r = deleteSkill("del-me", { skillsDir: tmp });
  ok(r.ok === true && r.deleted === "skills/del-me", "删除成功：回执 ok + deleted 路径", JSON.stringify(r));
  ok(!fs.existsSync(path.join(tmp, "del-me")), "删除后：整目录（含章节）没了");
  ok(!listSkills({ skillsDir: tmp }).some(s => s.slug === "del-me"), "删除后：列表不再有它");

  // b) 不存在 → skill-not-found（不炸、带可用清单）；坏 slug → bad-slug（SLUG_RE 闸门）
  r = deleteSkill("del-me", { skillsDir: tmp });
  ok(r.ok === false && r.error === "skill-not-found" && r.available.length > 0,
    "删除不存在的包 → skill-not-found + available 清单", JSON.stringify(r));
  r = deleteSkill("../evil", { skillsDir: tmp });
  ok(r.ok === false && r.error === "bad-slug", "删除穿越 slug → bad-slug 拒收");

  // c) 原子写僵尸连锅端：saveSkill 进程被砍会留 slug.tmp-*，listSkills 不筛 SLUG_RE
  // 会以僵尸卡片形式出现在 UI——删包时一并清掉
  saveSkill("del-me", [{ path: "SKILL.md", content: delFm }], base);
  fs.mkdirSync(path.join(tmp, "del-me.tmp-1699999999", "chapters"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "del-me.tmp-1699999999", "SKILL.md"), delFm, "utf8");
  r = deleteSkill("del-me", { skillsDir: tmp });
  ok(r.ok === true && !fs.existsSync(path.join(tmp, "del-me.tmp-1699999999")),
    "删除连锅端：同 slug 的原子写僵尸 tmp 目录一并清掉");

  // d) 删后可整包重建（幂等，不留痕迹）
  r = saveSkill("del-me", [{ path: "SKILL.md", content: delFm }, { path: "chapters/ch01-a.md", content: ch08 }], base);
  ok(r.ok === true && readSkill("del-me", undefined, { skillsDir: tmp }).index.length === 1,
    "删除后可整包重建（readSkill 正常）");
  deleteSkill("del-me", { skillsDir: tmp }); // 收尾还原
}

// ---------- 19) currentSkillsDir 三层解析（MCP 形态 B 生命线，2026-10-21） ----------
// 安装态 MCP 从 app.asar 里跑，相对默认路径（app.asar/skills）不存在——
// 不认 BSP_SKILLS_DIR 的话 list_skills/read_skill/check_skills 全空（win-unpacked 实测抓到的洞）
ok(currentSkillsDir() === DEFAULT_SKILLS_DIR, "无注入无 env → 默认目录（仓库 skills/）");
process.env.BSP_SKILLS_DIR = tmp;
ok(currentSkillsDir() === tmp, "env 层：BSP_SKILLS_DIR 生效（调用时读）");
configureSkillStore({ skillsDir: path.join(tmp, "nested") });
ok(currentSkillsDir() === path.join(tmp, "nested"), "注入优先于 env（桌面 engine 注入路径）");
delete process.env.BSP_SKILLS_DIR;
ok(currentSkillsDir() === path.join(tmp, "nested"), "env 删除后仍走注入（调用时读的另一面）");

// ========== V01/V02 断言（镜像自 usage-gate-test.mjs，入 test:ci 破假绿）==========
// usage-gate-test.mjs 只在 test:fast —— 生产闸机（gate=true）的拒绝路径此前不在 test:ci，
// register-tools.mjs:63 漏传 estChars 之类回归在 CI 全绿中溜走（04 完工标准 3 点名的坑）。
// 本节把两条关键断言镜像进 test:ci 串内；零落盘零真库（假 handler + 临时 libDir）。
{
  const { registerServerTools, TOOL_TIERS, estimateDeepReadChars, assertTierCoverage } = await import("../src/lib/register-tools.mjs");
  const up = await import("../src/lib/usage-policy.mjs");
  const searchMod = await import("../src/lib/search.mjs");
  const archTmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-skill-gate-"));
  searchMod.configureSearch({ libDir: archTmp }); // 审计/策略指向临时目录，零碰真库

  // ---- 断言 1（V01）：gate=true 下 read_range 超量请求被拒，探针 handler 不执行 ----
  {
    // 1a 漏传探测器：不传 estChars 时单次 8 万闸恒不触发（这正是修复前的病灶）
    const dflt = up.loadUsagePolicy(archTmp);
    ok(up.checkBudget(dflt, "deepRead", 90000).ok === false
      && up.checkBudget(dflt, "deepRead", 90000).reason === "single-call-too-big",
      "V01: checkBudget 传 estChars=90000 → single-call-too-big 拒");
    ok(up.checkBudget(dflt, "deepRead").ok === true,
      "V01: 漏传 estChars（默认 0）→ 恒放行（探测器：证明第三参非装饰）");
    // 1b 估算函数：99999 块区间 → 80 块钳顶 × 2000 = 16 万 > 8 万上限
    ok(estimateDeepReadChars("read_range", { from: 1, to: 99999 }) > 80000,
      "V01: estimateDeepReadChars(read_range 1..99999) > 80000（闸机前移的弹药）");
    // 1c 生产闸机集成（gate 默认 true，不传 gate:false）：探针 handler 换进 read_range
    let ran = 0;
    const handlers = new Map();
    const mockServer = {
      registerTool(name, _def, wrapped) { handlers.set(name, wrapped); },
    };
    registerServerTools(mockServer, {
      deps: { handlerOverrides: { read_range: async () => { ran++; return { content: [] }; } } },
    });
    const res = await handlers.get("read_range")({ book: "x", from: 1, to: 99999 });
    ok(ran === 0, "V01: gate=true 超量请求探针 handler 未执行（事前拦截）");
    const body = JSON.parse(res.content[0].text);
    ok(!!body.error && body.reason === "single-call-too-big",
      "V01: 拒绝返回 {error, reason:single-call-too-big}", JSON.stringify(body));
  }

  // ---- 断言 2（V02）：save_skill 定档 search + 未登记名 fail-closed + 闸机审计 ----
  {
    // 2a 定档表覆盖全部注册名（差集为空 = fail-closed 前提），save_skill 明确定 search 档
    const names = ["list_books","list_catalog","get_person","get_theme","expand","get_outline",
      "list_skills","read_skill","cite_check","check_skills","query_book","query_library",
      "similar_chunks","lookup","save_skill","read_full_book","get_chapter","read_range"];
    let coverageThrew = null;
    try { assertTierCoverage(names); } catch (e) { coverageThrew = e; }
    ok(coverageThrew === null, "V02: 18 个注册名全部有定档（差集为空）", coverageThrew?.message);
    ok(TOOL_TIERS.get ? TOOL_TIERS.get("save_skill") === "search" : TOOL_TIERS["save_skill"] === "search",
      "V02: save_skill 定档 search（不再走 metadata 直通绕闸机）");
    // 2b 未登记名拒绝注册（fail-closed，取代旧 || "metadata" 静默降级）
    const mock2 = { registerTool() {} };
    let regThrew = null;
    try { registerServerTools(mock2, { extraTools: { ghost_tool: { def: {}, handler: async () => ({ content: [] }) } } }); } catch (e) { regThrew = e; }
    // extraTools 不在生产签名里——直接验证 assertRegistered 语义：塞一个假名进 assertTierCoverage
    let ghostThrew = null;
    try { assertTierCoverage([...names, "ghost_tool"]); } catch (e) { ghostThrew = e; }
    ok(ghostThrew !== null && /未登记工具/.test(ghostThrew.message),
      "V02: 未登记工具名 → assertTierCoverage 抛「未登记工具」（fail-closed）", ghostThrew?.message);
    ok(regThrew === null || ghostThrew !== null, "V02: 未登记名无法静默降级为 metadata");
    // 2c 服务关闭态：save_skill 不走 metadata 直通，闸机拒绝且不真落盘
    up.saveUsagePolicy(archTmp, { enabled: false });
    const handlers2 = new Map();
    let saved = 0;
    registerServerTools({ registerTool(n, _d, w) { handlers2.set(n, w); } }, {
      deps: { handlerOverrides: { save_skill: async (args) => { saved++; return { content: [{ type: "text", text: JSON.stringify({ slug: args.slug }) }] }; } } },
    });
    const offRes = await handlers2.get("save_skill")({ slug: "x", files: [] });
    ok(saved === 0, "V02: 服务关闭态 save_skill 探针未落盘（闸机先拦）");
    const offBody = JSON.parse(offRes.content[0].text);
    ok(offBody.error === "知识库对外服务未开放" && offBody.reason === "manual-off",
      "V02: 关闭态返回 manual-off 人话拒绝", JSON.stringify(offBody));
    // 2d 开启态 + 假 saveSkill：过闸机 → session.calls 记账 + 审计行 tool:"save_skill"
    up.resetSessionUsage();
    up.saveUsagePolicy(archTmp, { enabled: true });
    const logPath = path.join(archTmp, "usage-log.jsonl");
    fs.rmSync(logPath, { force: true });
    const onRes = await handlers2.get("save_skill")({ slug: "audit-probe", files: [] });
    ok(saved === 1, "V02: 开启态探针执行了一次");
    ok(up.sessionUsage().calls === 1, "V02: save_skill 过闸机后 session.calls===1（记账，不再直通漏账）");
    const logRaw = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    const logLine = logRaw.split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .find((e2) => e2.tool === "save_skill");
    ok(!!logLine && logLine.ok === true,
      "V02: 审计 usage-log.jsonl 追加 tool=save_skill ok=true", logRaw.slice(0, 120));
    ok(JSON.parse(onRes.content[0].text).slug === "audit-probe", "V02: 开启态返回注入 handler 的结果");
  }

  fs.rmSync(archTmp, { recursive: true, force: true });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n===== skill-store-test: ${pass} PASS / ${fail} FAIL =====`);
if (fail) { console.error(`测试失败 ${fail} 项`); process.exit(1); }
