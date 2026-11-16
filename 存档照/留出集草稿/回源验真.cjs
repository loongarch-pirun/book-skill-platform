// 回源验真（只读 SQL，不是检索探针）
// 用途：证明每题的 a 逐字存在于对应 .db 的 chunks.text 内，金词至少命中一个。
const fs = require("node:fs");
const path = require("node:path");
const ROOT = process.argv[2];
if (!ROOT) { console.error("用法: node 回源验真.cjs <r4 根绝对路径>"); process.exit(1); }
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const set = JSON.parse(fs.readFileSync(path.join(__dirname, "holdout-DRAFT.json"), "utf8"));

const cache = new Map();
const lines = [];
let ok = 0, skip = 0, bad = 0;

for (const it of set.items) {
  if (it.a === null) {
    skip++;
    lines.push(`${it.id} [${it.kind}] 无答案句（${it.expect}）→ 跳过回源，判分待 judgeRefusal 实现`);
    continue;
  }
  if (!cache.has(it.bookId)) {
    const p = path.join(ROOT, "library", it.bookId + ".db");
    cache.set(it.bookId, fs.existsSync(p) ? new Database(p, { readonly: true }) : null);
  }
  const db = cache.get(it.bookId);
  if (!db) { bad++; lines.push(`${it.id} ✗ 找不到库: ${it.bookId}`); continue; }
  const row = db.prepare("SELECT text FROM chunks WHERE id = ?").get(it.chunk_id);
  const text = row ? String(row.text).replace(/\r/g, "") : "";
  const hit = text.includes(it.a);
  const low = it.a.toLowerCase();
  const gold = it.g.length === 0 || it.g.some((k) => low.includes(k.toLowerCase()));
  if (hit && gold) { ok++; lines.push(`${it.id} ✓ ${it.bookId} #${it.chunk_id} a=${it.a.length}字 金词 ${it.g.length} 个`); }
  else { bad++; lines.push(`${it.id} ✗ 回源=${hit} 金词=${gold} ${it.bookId} #${it.chunk_id}`); }
}
for (const db of cache.values()) if (db) db.close();

const head = [
  "留出集草稿 · 回源验真结果",
  `时间: ${new Date().toISOString()}`,
  "口径: 只读 SELECT chunks.text；零检索调用",
  `题数 ${set.total} | 有答案句 ${ok + bad} | 验真通过 ${ok} | 失败 ${bad} | 无答案句跳过 ${skip}`,
  "",
].join("\n");
const out = head + lines.join("\n") + `\n\n结论: ${bad === 0 ? "✓ 全部有答案句的题逐字回源，金词命中" : "✗ 存在回源失败，需修正"}\n`;
fs.writeFileSync(path.join(__dirname, "回源验真结果.txt"), out, "utf8");
console.log(out.split("\n").slice(0, 5).join("\n"));
console.log(lines.filter((l) => l.includes("✗")).join("\n") || "无失败项");
process.exit(bad === 0 ? 0 : 2);
