// 三题复查：是「真没有」还是「排太后」。topN=20 看答案块能排到第几。
const R4 = "file:///C:/Users/JIANG%20XIAO%20HUA/Desktop/book-skill-platform-r4/";
const { routeAndSearch } = await import(R4 + "src/lib/search.mjs");
const fs = await import("node:fs");
const set = JSON.parse(fs.readFileSync("C:/Users/JIANG XIAO HUA/Desktop/book-skill-platform-r4/test/holdout/sets/holdout-v1.json", "utf8"));
const ids = ["H05", "H06", "H16"];
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
for (const it of set.items.filter((x) => ids.includes(x.id))) {
  const out = await routeAndSearch(it.q, { topN: 20, maxBooks: 4 });
  const a = norm(it.a);
  const idx = out.results.findIndex((r) => norm(r.text).includes(a));
  const half = a.slice(0, Math.floor(a.length / 2));
  const idxHalf = out.results.findIndex((r) => norm(r.text).includes(half));
  console.log(`\n${it.id} ${it.q}`);
  console.log(`  答案句长度 ${a.length}；完整命中位置=${idx < 0 ? "无" : idx + 1}；前半句命中位置=${idxHalf < 0 ? "无" : idxHalf + 1}`);
  console.log("  routed:", out.routed_books.map((b) => b.title + "(" + b.best_sim + ")").join(" , "));
  out.results.slice(0, 8).forEach((r, i) => {
    console.log(`   #${i + 1} ${r.book} id=${r.id} score=${r.score} | ${norm(r.text).slice(0, 60)}`);
  });
}
