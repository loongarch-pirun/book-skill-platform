// P3-③ 邻块扩展验收：BSP_NEIGHBOR 默认关 + 开关后同章 ±1 附加 + 衰减计分 +
// 跨章不扩 + 去重 + 上限 4 + 变体快路径不扩 + chapter_path 透传
// 跑法: node test/neighbor-test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const buildBook = await import("../src/build-book.js");
import { hybridSearch, multiVariantSearch } from "../src/lib/search.mjs";

let failed = 0;
const assert = (cond, msg, extra = "") => {
  console.log((cond ? "PASS" : "FAIL") + " - " + msg + (cond ? "" : ` ${extra}`));
  if (!cond) failed++;
};

// ---------- 夹具：两章 md，第一章 5 段相邻段落（P1..P5 各带唯一词）----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nbr-"));
const md = `# 数组

数组第一章第一段落独特词苹果在这里。

数组第一章第二段落独特词香蕉在这里。

数组第一章第三段落独特词樱桃在这里。

数组第一章第四段落独特词蜜桃在这里。

数组第一章第五段落独特词柠檬在这里。

# 链表

链表章第一段独特词西瓜在这里。

链表章第二段独特词芒果在这里。
`;
const mdPath = path.join(TMP, "nbr.md");
fs.writeFileSync(mdPath, md, "utf8");
const dbPath = path.join(TMP, "nbr.md.db");
{
  const keep = process.exitCode;
  const oe = console.error, ol = console.log;
  console.error = () => {}; console.log = () => {};
  try { await buildBook.main([mdPath, "-o", dbPath, "--force", "--title", "nbr"]); } finally {
    console.error = oe; console.log = ol; process.exitCode = keep;
  }
}
const db = new Database(dbPath, { readonly: true });
const chunks = db.prepare("SELECT id, chapter, text FROM chunks ORDER BY id").all();
const idOf = (kw) => chunks.find(c => c.text.includes(kw))?.id;
const textOf = (id) => chunks.find(c => c.id === id)?.text;

// ===== 1) 默认关：无 nbr 字段、条数不超 topN =====
{
  const rs = await hybridSearch(dbPath, "樱桃独特词", 3);
  assert(rs.length <= 3 && rs.every(r => r.nbr === undefined), `默认关: 无邻块扩展（${rs.length} 行全无 nbr 字段）`);
  assert(rs.some(r => r.text.includes("樱桃")), "默认关: 检索本身正常（樱桃命中）");
}

// ===== 2) 开：同章 ±1 附加、衰减 ×0.5、种子在位、跨章不扩 =====
{
  process.env.BSP_NEIGHBOR = "1";
  try {
    const rs = await hybridSearch(dbPath, "樱桃独特词", 3);
    const nbrs = rs.filter(r => r.nbr !== undefined);
    const seeds = rs.filter(r => r.nbr === undefined);
    assert(seeds.some(r => r.text.includes("樱桃")), "开: 种子（樱桃块）在终排里");
    assert(nbrs.length > 0, `开: 邻块被附加（${nbrs.length} 席）`);
    // 不变式：每个 nbr 行的 id = nbrOf ± 1、同章、文本与库一致、分数 = 种子分 ×0.5
    let invOk = true;
    for (const n of nbrs) {
      const s = seeds.find(x => x.id === n.nbrOf);
      if (!s || Math.abs(n.id - n.nbrOf) !== 1) { invOk = false; break; }
      if (textOf(n.id) !== n.text) { invOk = false; break; }
      if (s.chapter && n.chapter !== s.chapter) { invOk = false; break; }
      const expect = +((((s.rerank ?? s.score) || 0)) * 0.5).toFixed(4);
      if (Math.abs(n.score - expect) > 1e-6) { invOk = false; break; }
    }
    assert(invOk, "开: nbr 不变式全对（id±nbrOf/同章/文本一致/衰减 ×0.5）");
    // 去重：nbr 行 id 互不相同且不与种子重叠
    assert(new Set(nbrs.map(n => n.id)).size === nbrs.length && nbrs.every(n => !seeds.some(s => s.id === n.id)),
      "开: 邻块去重（无重复、不与种子重叠）");
    // 跨章不扩：柠檬是第一章最后一段，其后是链表章——柠檬块的 +1 邻居不得出现在 nbr
    const lemon = idOf("柠檬");
    const lemonNbrs = nbrs.filter(n => n.nbrOf === lemon);
    const lemonNext = nbrs.some(n => n.id === lemon + 1 && chunks.find(c => c.id === lemon + 1)?.chapter !== chunks.find(c => c.id === lemon)?.chapter);
    assert(!lemonNext, `开: 跨章邻居不扩（柠檬+1 属链表章，${lemonNbrs.length} 个 nbr 中无跨章）`);
    // 上限：邻块总数 ≤4
    assert(nbrs.length <= 4, `开: 邻块总数 ≤4（实际 ${nbrs.length}）`);
    // chapter_path 透传：nbr 行继承种子的 chapterPath
    assert(nbrs.every(n => typeof n.chapterPath === "string" && n.chapterPath.includes("数组")),
      `开: chapter_path 透传（${JSON.stringify(nbrs[0]?.chapterPath)}）`);
  } finally { delete process.env.BSP_NEIGHBOR; }
}

// ===== 3) 变体路径：原句终排扩、变体快路不扩（不炸 + 不变式保持） =====
{
  process.env.BSP_NEIGHBOR = "1";
  try {
    const rs = await multiVariantSearch(dbPath, ["樱桃独特词", "请讲讲樱桃独特词"], 3);
    const nbrs = rs.filter(r => r.nbr !== undefined);
    let invOk = true;
    for (const n of nbrs) {
      if (Math.abs(n.id - n.nbrOf) !== 1) { invOk = false; break; }
      if (textOf(n.id) !== n.text) { invOk = false; break; }
    }
    assert(invOk, `多变体: nbr 不变式保持（${nbrs.length} 席 nbr / ${rs.length} 行）`);
  } finally { delete process.env.BSP_NEIGHBOR; }
}

// ===== 4) 老库（无 chapter_path 列）兼容：探测回退不炸 =====
{
  // 复制一份库并删列（SQLite 不支持 DROP COLUMN 的老版行为——直接造一个无列库更稳）
  const legacyPath = path.join(TMP, "legacy.db");
  const ldb = new Database(legacyPath);
  ldb.exec(`CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT NOT NULL);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='trigram');`);
  const ins = ldb.prepare("INSERT INTO chunks(chapter, page, text) VALUES (?,?,?)");
  for (const t of ["苹果树上的第一章文字独特词柚子。", "第二段落独特词橙子在这里。", "第三段落独特词橘子在这里。"])
    ins.run("果园", null, t);
  ldb.prepare("INSERT INTO chunks_fts(rowid, text) SELECT id, text FROM chunks").run();
  ldb.close();
  process.env.BSP_NEIGHBOR = "1";
  try {
    const rs = await hybridSearch(legacyPath, "橙子独特词", 2);
    assert(rs.every(r => r.chapterPath === null), `老库: chapterPath 全 null（无列回退）`);
    const nbrs = rs.filter(r => r.nbr !== undefined);
    assert(nbrs.every(n => textOfLegacy(legacyPath, n.id) === n.text), `老库: 邻块照常附加且文本一致（${nbrs.length} 席）`);
  } finally { delete process.env.BSP_NEIGHBOR; }
}
function textOfLegacy(p, id) {
  const d = new Database(p, { readonly: true });
  try { return d.prepare("SELECT text FROM chunks WHERE id=?").get(id)?.text; } finally { d.close(); }
}

db.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `\n===== 邻块扩展验收：${failed} 项 FAIL =====` : "\n===== 邻块扩展验收：全部 PASS =====");
process.exit(failed ? 1 : 0);
