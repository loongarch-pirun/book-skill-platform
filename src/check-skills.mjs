// 技能体检 CLI（红黄绿报告）：
//   node src/check-skills.mjs          # 人话表格
//   node src/check-skills.mjs --json   # 机器可读（供脚本/门禁消费）
// 判定：红=不可信不可用（源书删了/引文回源失败/索引断链/覆盖声称对不上）；
//       黄=能用但提醒（源书被关/无章节文件/catalog.json 异常）；绿=全过。
// 退出码：0=无红；1=有红（可当门禁串在书库变动之后）；2=用法错误。
import { checkSkills } from "./lib/skill-health.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
if (args.filter(a => a !== "--json").length) {
  console.error("用法: node src/check-skills.mjs [--json]");
  process.exit(2);
}

const r = checkSkills();

if (asJson) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.red > 0 ? 1 : 0);
}

if (!r.total) {
  console.log("skills/ 下没有技能包——没什么可体检的。");
  process.exit(0);
}

const mark = { green: "✓", yellow: "!", red: "✗" };
console.log(`技能体检：${r.total} 个包 —— 绿 ${r.green} · 黄 ${r.yellow} · 红 ${r.red}\n`);
for (const p of r.packages) {
  const cov = p.coverage ? `覆盖 ${p.coverage.covered}/${p.coverage.total} 章${p.coverage.percent != null ? `（${p.coverage.percent}%）` : ""}` : "";
  const cit = p.citations.checked ? `引文 ${p.citations.checked - p.citations.failed}/${p.citations.checked} 通过` : "无引文";
  console.log(`${mark[p.status]} ${p.slug}（${p.title}）[${p.status === "green" ? "绿" : p.status === "yellow" ? "黄" : "红"}] ${cov} ${cit}`);
  if (p.coverage?.note) console.log(`    i ${p.coverage.note}`);
  for (const f of p.findings) {
    const loc = f.file ? ` ${f.file}${f.line ? ":" + f.line : ""}` : "";
    console.log(`    ${f.level === "red" ? "✗" : "!"} ${f.reason}${loc} ${f.hint}`);
  }
}
for (const w of r.warnings) console.log(`\n! ${w}`);
if (r.red > 0) {
  console.log(`\n有 ${r.red} 个包不可信不可用——修法是智能体的活：read_skill 取全文 → 改 → save_skill 整包重交（引文回源+声称核对两道质检）；确实没用了就删。`);
  process.exit(1);
}
console.log(r.yellow > 0 ? "\n无红包。黄点都是「能用但提醒」，按提示核对即可。" : "\n全部通过。");
