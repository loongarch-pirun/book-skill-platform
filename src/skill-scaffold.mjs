// 技能骨架生成 CLI（技能×编目融合 P-B）：从编目 JSON + 库实况生成 skill 包"半成品"
// 用法：
//   node src/skill-scaffold.mjs <书名片段>              → 打印 JSON（含 SKILL.md/catalog.json 全文，给对话智能体填空）
//   node src/skill-scaffold.mjs <书名片段> --write <目录> → 把骨架文件写到 <目录>/<slug>/（智能体在此基础上改）
// 骨架的一切结构声称都从库里查出（真值），智能体只填导读空位——目录不许手改。
import fs from "node:fs";
import path from "node:path";
import { generateSkillScaffold } from "./lib/catalog-skill.mjs";

const args = process.argv.slice(2);
const book = args.find((a) => !a.startsWith("--"));
const writeIdx = args.indexOf("--write");
const outDir = writeIdx > -1 ? args[writeIdx + 1] : null;

if (!book) {
  console.error("用法: node src/skill-scaffold.mjs <书名片段> [--write <输出目录>]");
  console.error("示例: node src/skill-scaffold.mjs pride");
  process.exit(1);
}

const r = generateSkillScaffold(book);
if (r.error) {
  console.error(`找不到书「${book}」。可用书目：${r.available.join("、")}`);
  process.exit(1);
}

if (outDir) {
  const dir = path.resolve(outDir, r.slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of r.files) {
    const p = path.join(dir, ...f.path.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content, "utf8");
  }
  console.error(`骨架已写入 ${dir}（${r.files.map((f) => f.path).join(" + ")}）`);
  console.error(`下一步：${r.next}`);
}

// stdout 只走 JSON（可管道给别的程序；stderr 走人类提示）——与 MCP 日志规矩同源
console.log(JSON.stringify(r, null, 2));
