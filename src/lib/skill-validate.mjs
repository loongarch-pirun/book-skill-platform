// Skill 结构校验（W2，2026-10-21）：对标 Agent Skills 开放标准（agentskills.io /
// Anthropic 三级渐进披露 + skills-guides 社区硬规则）的离线校验器。
// 与 skill-store.saveSkill 的分工：saveSkill 管「写入时」的 slug/路径/大小/引用回源；
// 本模块管「标准符合度」——description 负面触发、正文行数、references 一层深、
// 参考文件 TOC、链接完整性、README 混入等。两边互不重复，CI 与本地一键都用它。
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter, SLUG_RE } from "./skill-store.mjs";

const DESC_MAX = 1024;        // 开放标准：description 上限 1024 字符
const BODY_MAX_LINES = 500;   // 开放标准：SKILL.md 正文 <500 行
const TOC_MIN_LINES = 100;    // 社区惯例：>100 行的参考文件顶部加目录

// 负面触发线索：description 应写清「不用于什么」（防技能间抢触发）
const NEGATIVE_HINT_RE = /不用于|不要用|不适用|别用于|not for|do not use|don't use/i;

// 收集技能目录下的全部文件（相对路径，POSIX 分隔符）
function listFiles(dir) {
  const out = [];
  const walk = (rel) => {
    const abs = rel ? path.join(dir, rel) : dir;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk("");
  return out.sort();
}

// 校验单个技能目录：返回 { ok, errors: [...], warnings: [...] }
// errors = 违反硬规则（不可交付）；warnings = 建议项（不拦路）
export function validateSkillDir(dir) {
  const errors = [];
  const warnings = [];
  const slug = path.basename(path.resolve(dir));

  if (!SLUG_RE.test(slug))
    errors.push({ rule: "slug", hint: `目录名「${slug}」不是 kebab-case（小写字母/数字/连字符，≤64）` });

  let files;
  try { files = listFiles(dir); }
  catch (e) { return { ok: false, errors: [{ rule: "unreadable", hint: String(e.message || e) }], warnings }; }

  // ① SKILL.md 必须存在且大小写精确（开放标准：主文件必须叫 SKILL.md）
  if (!files.includes("SKILL.md"))
    errors.push({ rule: "no-skill-md", hint: "缺少 SKILL.md（必须精确这个大小写，不是 skill.md/SKILL.MD）" });

  // ② 技能目录内不放 README.md（开放标准反模式：文档归 SKILL.md 或 references/）
  if (files.includes("README.md"))
    errors.push({ rule: "readme-inside", hint: "技能目录内不放 README.md——说明写进 SKILL.md 或 references/" });

  // ③ 嵌套深度：root/*.md 与 root/<one-dir>/*.md，不允许多层
  for (const f of files) {
    const depth = f.split("/").length;
    if (depth > 2)
      errors.push({ rule: "too-deep", file: f, hint: "references 只深一层——更深的文件请拆分或合并" });
  }

  if (files.includes("SKILL.md")) {
    const md = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    const fm = parseFrontmatter(md);

    // ④ frontmatter 契约
    if (!fm) {
      errors.push({ rule: "no-frontmatter", file: "SKILL.md", hint: "需要 YAML frontmatter（--- 包裹的 name/description）" });
    } else {
      const { data } = fm;
      if (!data.name) errors.push({ rule: "fm-name", hint: "frontmatter 缺 name" });
      else if (!SLUG_RE.test(data.name)) errors.push({ rule: "fm-name", hint: `name「${data.name}」不是 kebab-case` });
      else if (data.name !== slug) errors.push({ rule: "fm-name", hint: `name（${data.name}）必须等于目录名（${slug}）` });

      if (!data.description) {
        errors.push({ rule: "fm-desc", hint: "frontmatter 缺 description——它是唯一的 L1 触发线索" });
      } else {
        const desc = String(data.description);
        if (desc.length > DESC_MAX)
          errors.push({ rule: "fm-desc", hint: `description ${desc.length} 字符超上限 ${DESC_MAX}` });
        // 单行判定：YAML 块标量（>/|）与裸换行都算多行——L1 线索必须是单行 inline
        if (/^[>|]/.test(desc) || /\r|\n/.test(desc))
          errors.push({ rule: "fm-desc", hint: "description 必须单行（禁用 YAML 多行操作符 >/|，会让 L1 触发线索变形）" });
        if (!NEGATIVE_HINT_RE.test(desc))
          warnings.push({ rule: "fm-desc-negative", hint: "description 建议加负面触发（「不用于 X——用 Y」），防技能间抢触发" });
      }
      if (!data.title) warnings.push({ rule: "fm-title", hint: "建议补 frontmatter title（中文名，给 UI 与 list_skills 显示）" });

      // ⑤ 正文行数：超 500 行说明该拆 references/
      const bodyLines = String(fm.body || "").split(/\r?\n/).length;
      if (bodyLines > BODY_MAX_LINES)
        errors.push({ rule: "body-too-long", file: "SKILL.md", hint: `正文 ${bodyLines} 行超上限 ${BODY_MAX_LINES}——细节拆进 references/（渐进披露 L3）` });

      // ⑦ 链接完整性：SKILL.md 里指向的文件必须存在（相对路径）
      const linkRe = /\]\(([^)#]+?)(?:#[^)]*)?\)/g;
      let m;
      while ((m = linkRe.exec(md)) !== null) {
        const target = m[1].trim();
        if (/^(https?:|mailto:)/i.test(target)) continue;
        if (!files.includes(target.replace(/^\.\//, "")))
          errors.push({ rule: "broken-link", file: "SKILL.md", hint: `链接指向不存在的文件：${target}` });
      }
    }
  }

  // ⑥ 参考文件 >100 行要有目录（否则智能体只能整读，渐进披露打折）
  for (const f of files) {
    if (!f.endsWith(".md") || f === "SKILL.md") continue;
    const lines = fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/).length;
    if (lines > TOC_MIN_LINES) {
      const head = fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/).slice(0, 30).join("\n");
      if (!/目录|目錄|\|\s*文件\s*\|/.test(head))
        warnings.push({ rule: "no-toc", file: f, hint: `${lines} 行的参考文件顶部建议加目录（>100 行的社区惯例）` });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// 校验 skills/ 根目录下的全部技能：返回 { ok, skills: [{slug, ...result}] }
export function validateSkillsRoot(skillsDir) {
  const skills = [];
  for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const r = validateSkillDir(path.join(skillsDir, e.name));
    skills.push({ slug: e.name, ...r });
  }
  return { ok: skills.every(s => s.ok), skills };
}
