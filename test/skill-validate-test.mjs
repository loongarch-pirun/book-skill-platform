// W2a skill 结构校验测试：对标 Agent Skills 开放标准（tmp 夹具，不碰真 skills/）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg + (cond || extra === undefined ? "" : ` | ${extra}`)); cond ? pass++ : fail++; };

const { validateSkillDir, validateSkillsRoot } = await import("../src/lib/skill-validate.mjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-skillval-"));

// ---------- 夹具一：合规技能（应 0 error） ----------
const good = path.join(tmp, "good-skill");
fs.mkdirSync(path.join(good, "references"), { recursive: true });
fs.mkdirSync(path.join(good, "scripts"), { recursive: true });
fs.writeFileSync(path.join(good, "SKILL.md"), `---
name: good-skill
title: 合规技能
description: 测试用合规技能：校验结构与渐进披露。不用于生产检索——那用 query_book 工具。
metadata:
  version: 1.0.0
---

# 合规技能

## 指令
1. 先读 references/flow.md 再动手。

详见 [动线详解](references/flow.md)，脚本用 [校验](scripts/check.mjs)。
`);
fs.writeFileSync(path.join(good, "references", "flow.md"), "# 动线\n\n## 目录\n- [一](x)\n" + "内容行\n".repeat(120));
fs.writeFileSync(path.join(good, "scripts", "check.mjs"), "console.log('ok');\n");
{
  const r = validateSkillDir(good);
  ok(r.ok && r.errors.length === 0, "合规技能：0 error", JSON.stringify(r.errors));
  ok(r.warnings.length === 0, "合规技能：0 warning（负面触发/标题/目录都齐）", JSON.stringify(r.warnings));
}

// ---------- 夹具二：不合规技能（每个硬规则都该红） ----------
const bad = path.join(tmp, "Bad_Skill");
fs.mkdirSync(path.join(bad, "references", "deep"), { recursive: true });
fs.writeFileSync(path.join(bad, "SKILL.md"), `---
name: wrong-name
description: >
  一个用了 YAML 块标量的多行描述
  第二行同样多行
---

# 坏技能

链接断了：[不存在](references/nope.md)
`);
fs.writeFileSync(path.join(bad, "README.md"), "# 别放我\n");
fs.writeFileSync(path.join(bad, "references", "deep", "nested.md"), "# 太深\n");
{
  const r = validateSkillDir(bad);
  const rules = r.errors.map(e => e.rule);
  ok(r.ok === false, "不合规技能：ok=false");
  ok(rules.includes("slug"), "slug 规则：目录名非 kebab-case 红");
  ok(rules.includes("fm-name"), "fm-name 规则：name≠目录名 红");
  ok(rules.includes("fm-desc"), "fm-desc 规则：description 多行 红");
  ok(rules.includes("readme-inside"), "readme-inside 规则：目录内 README.md 红");
  ok(rules.includes("too-deep"), "too-deep 规则：references 两层深 红");
  ok(rules.includes("broken-link"), "broken-link 规则：指向不存在文件 红");
  ok(r.warnings.some(w => w.rule === "fm-desc-negative"), "fm-desc-negative warning：缺负面触发");
  ok(r.warnings.some(w => w.rule === "fm-title"), "fm-title warning：缺 title");
}

// ---------- 夹具三：缺 SKILL.md / frontmatter / 超长正文 ----------
{
  const noMd = path.join(tmp, "no-md-skill");
  fs.mkdirSync(noMd, { recursive: true });
  fs.writeFileSync(path.join(noMd, "glossary.md"), "# 只有术语表\n");
  const r1 = validateSkillDir(noMd);
  ok(r1.errors.some(e => e.rule === "no-skill-md"), "no-skill-md 规则：缺主文件红");

  const noFm = path.join(tmp, "no-fm-skill");
  fs.mkdirSync(noFm, { recursive: true });
  fs.writeFileSync(path.join(noFm, "SKILL.md"), "# 没有 frontmatter 的技能\n");
  const r2 = validateSkillDir(noFm);
  ok(r2.errors.some(e => e.rule === "no-frontmatter"), "no-frontmatter 规则：缺 YAML 头红");

  const longBody = path.join(tmp, "long-body-skill");
  fs.mkdirSync(longBody, { recursive: true });
  fs.writeFileSync(path.join(longBody, "SKILL.md"), `---\nname: long-body-skill\ndescription: 超长正文测试。不用于生产。\n---\n\n` + "行\n".repeat(600));
  const r3 = validateSkillDir(longBody);
  ok(r3.errors.some(e => e.rule === "body-too-long"), "body-too-long 规则：正文 >500 行红");
}

// ---------- 夹具四：根目录批量 + TOC warning ----------
{
  const root = path.join(tmp, "root");
  fs.mkdirSync(path.join(root, "alpha"), { recursive: true });
  fs.mkdirSync(path.join(root, "beta"), { recursive: true });
  fs.writeFileSync(path.join(root, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: 甲。不用于乙。\n---\n\n# 甲\n");
  fs.writeFileSync(path.join(root, "beta", "SKILL.md"), "---\nname: beta\ndescription: 乙。不用于甲。\n---\n\n# 乙\n\n[深](alpha/SKILL.md)\n");
  const r = validateSkillsRoot(root);
  ok(r.skills.length === 2 && r.skills.find(s => s.slug === "alpha").ok === true, "根目录批量：2 个技能都扫到，合规的 alpha 过");
  ok(r.skills.find(s => s.slug === "beta").errors.some(e => e.rule === "broken-link"), "批量也查链接（beta 断链红）");
}

// ---------- 夹具五：>100 行参考文件无目录 → warning ----------
{
  const noToc = path.join(tmp, "no-toc-skill");
  fs.mkdirSync(path.join(noToc, "references"), { recursive: true });
  fs.writeFileSync(path.join(noToc, "SKILL.md"), "---\nname: no-toc-skill\ndescription: 无目录参考文件测试。不用于生产。\n---\n\n# x\n");
  fs.writeFileSync(path.join(noToc, "references", "big.md"), "# 大文件\n" + "内容\n".repeat(150));
  const r = validateSkillDir(noToc);
  ok(r.warnings.some(w => w.rule === "no-toc" && w.file === "references/big.md"), "no-toc warning：>100 行无目录");
}

// ---------- 清理 ----------
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmp 残留无害 */ }

console.log(`\n===== skill-validate-test：${pass} PASS / ${fail} FAIL =====`);
if (fail) process.exitCode = 1;
