// 自答复核 · 只读原文扫描（严禁调用检索链路）
// 三件事：① 导出有答案题的完整块上下文 ② 拒答题在指定书内查「确实没有」
//        ③ 歧义题扫全库查「确实多书可答」
const fs = require("node:fs");
const path = require("node:path");
const ROOT = process.argv[2];
if (!ROOT) { console.error("用法: node 自答复核.cjs <r4 根绝对路径>"); process.exit(1); }
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const set = JSON.parse(fs.readFileSync(path.join(__dirname, "holdout-DRAFT.json"), "utf8"));

// ---- 只读装载 13 本全部块 ----
const all = [];
for (const f of fs.readdirSync(path.join(ROOT, "library")).filter((x) => x.endsWith(".db")).sort()) {
  const book = f.replace(/\.db$/, "");
  const db = new Database(path.join(ROOT, "library", f), { readonly: true });
  const rows = db.prepare("SELECT id, text FROM chunks WHERE text IS NOT NULL").all();
  for (const r of rows) all.push({ book, id: r.id, text: String(r.text).replace(/\r/g, "") });
  db.close();
}
console.log(`只读装载: ${new Set(all.map((x) => x.book)).size} 本 / ${all.length} 块\n`);

// ---- ① 有答案题：导出完整上下文供逐题自答 ----
const ctx = [];
for (const it of set.items) {
  if (!it.a) continue;
  const row = all.find((x) => x.book === it.bookId && x.id === it.chunk_id);
  ctx.push([
    `===== ${it.id} [${it.kind}/${it.lang}] ${it.bookId} #${it.chunk_id} =====`,
    `Q: ${it.q}`,
    `G: ${it.g.join(" | ")}`,
    `A(草稿, ${it.a.length}字): ${it.a.replace(/\s+/g, " ")}`,
    `原文块全文(${row ? row.text.length : 0}字): ${row ? row.text.replace(/\s+/g, " ").slice(0, 700) : "【未找到】"}`,
    "",
  ].join("\n"));
}
fs.writeFileSync(path.join(__dirname, "自答复核-原文上下文.txt"), ctx.join("\n"), "utf8");
console.log(`① 已导出 ${ctx.length} 道有答案题的完整原文上下文 → 自答复核-原文上下文.txt\n`);

// ---- ② 拒答题：在指定书内查特色词 ----
const REFUSAL = {
  H17: ["量子", "quantum", "量子計算", "qubit"],
  H18: ["Kubernetes", "k8s", "yaml", "deployment", "容器编排"],
  H19: ["比特币", "bitcoin", "區塊鏈", "区块链", "加密貨幣"],
  H20: ["5G", "基站", "base station", "5g"],
  H21: ["智能手机", "智能手機", "smartphone", "mobile phone", "iPhone", "cell phone"],
  H22: ["年终奖", "年終獎", "bonus", "薪酬", "salary"],
  H23: ["Python", "python", "代码行", "行代码"],
  H24: ["食堂", "canteen", "cafeteria", "menu", "菜单", "菜單"],
};
const rLines = [];
for (const it of set.items.filter((x) => x.kind === "refusal")) {
  const words = REFUSAL[it.id] || [];
  const inBook = all.filter((x) => x.book === it.bookId);
  const hits = [];
  for (const w of words) {
    const n = inBook.filter((x) => x.text.toLowerCase().includes(w.toLowerCase()));
    if (n.length) hits.push(`${w}→${n.length}块(#${n[0].id}: ${n[0].text.replace(/\s+/g, " ").slice(0, 70)})`);
  }
  const other = words.filter((w) => all.some((x) => x.book !== it.bookId && x.text.toLowerCase().includes(w.toLowerCase())));
  rLines.push(`${it.id} ${it.bookId} | 特色词 ${words.length} 个 | 本书命中 ${hits.length ? hits.join(" ; ") : "0 ✓"} | 其他书出现过的词: ${other.length ? other.join(",") : "无"}`);
}
console.log("② 拒答题查原文:"); rLines.forEach((l) => console.log("  " + l));

// ---- ③ 歧义题：扫全库看多少本能答 ----
const AMB = {
  H25: ["作者", "author", "Author"],
  H26: ["一致性", "consistency", "consistent", "Consistency"],
  H27: ["學而時習之", "学而时习之"],
  H28: ["第一章", "第1章", "Chapter 1", "Chapter I", "CHAPTER I"],
};
const aLines = [];
for (const it of set.items.filter((x) => x.kind === "ambiguous")) {
  const words = AMB[it.id] || [];
  const booksHit = new Set();
  let blocks = 0;
  for (const w of words) for (const x of all) if (x.text.toLowerCase().includes(w.toLowerCase())) { booksHit.add(x.book); blocks++; }
  aLines.push(`${it.id} | 词 ${words.join("/")} | 命中 ${booksHit.size} 本 / ${blocks} 块 | ${[...booksHit].slice(0, 6).join(", ")}${booksHit.size > 6 ? " …" : ""}`);
}
console.log("\n③ 歧义题查原文:"); aLines.forEach((l) => console.log("  " + l));

const report = [
  "自答复核 · 只读原文扫描结果",  `时间: ${new Date().toISOString()}`, "口径: 只读 SELECT chunks.text；零检索调用", "",
  `装载: ${new Set(all.map((x) => x.book)).size} 本 / ${all.length} 块`, "",
  "② 拒答题（在指定书内查特色词，0 命中才算「确实没有」）", ...rLines, "",
  "③ 歧义题（扫全库，命中 ≥2 本才算歧义成立）", ...aLines, "",
].join("\n");
fs.writeFileSync(path.join(__dirname, "自答复核-扫描结果.txt"), report, "utf8");
