// Skill 结构校验 CLI（W2）：node src/skill-validate.mjs [skillsDir]
// 默认校验项目 skills/ 目录；退出码 0=全过，1=有 error。warnings 只提示不拦路。
import fs from "node:fs";
import path from "node:path";
import { validateSkillsRoot, validateSkillDir } from "./lib/skill-validate.mjs";
import { DEFAULT_SKILLS_DIR } from "./lib/skill-store.mjs";

// 与 currentSkillsDir 同一解析序（env > 默认）——安装态从 app.asar 跑时相对默认路径不存在
const target = process.argv[2] ? path.resolve(process.argv[2]) : (process.env.BSP_SKILLS_DIR || DEFAULT_SKILLS_DIR);

let out;
try {
  // 传的是单个技能目录（有 SKILL.md）→ 只校验它；否则按根目录批量
  const isSingle = fs.existsSync(path.join(target, "SKILL.md"));
  out = isSingle
    ? { ok: validateSkillDir(target).ok, skills: [{ slug: path.basename(target), ...validateSkillDir(target) }] }
    : validateSkillsRoot(target);
} catch (e) {
  console.error(`校验失败：${e.message}`);
  process.exit(1);
}

let errCount = 0, warnCount = 0;
for (const s of out.skills) {
  const mark = s.ok ? "PASS" : "FAIL";
  console.log(`${mark} - ${s.slug}${s.ok ? "" : `（${s.errors.length} error）`}`);
  for (const e of s.errors) { errCount++; console.log(`  [error] ${e.rule}${e.file ? ` @${e.file}` : ""}: ${e.hint}`); }
  for (const w of s.warnings) { warnCount++; console.log(`  [warn] ${w.rule}${w.file ? ` @${w.file}` : ""}: ${w.hint}`); }
}
console.log(`\n===== skill-validate：${out.skills.length} 个技能 / ${errCount} error / ${warnCount} warning =====`);
process.exit(errCount > 0 ? 1 : 0);
