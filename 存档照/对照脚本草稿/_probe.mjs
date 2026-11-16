// 临时探针：确认本地 .models 能加载、单题耗时（跑完即删）
const R4 = "file:///C:/Users/JIANG%20XIAO%20HUA/Desktop/book-skill-platform-r4/";
const { hybridSearch } = await import(R4 + "src/lib/search.mjs");
const DB = "C:/Users/JIANG XIAO HUA/Desktop/book-skill-platform-r4/library/pg1260-简爱.epub.db";
const t0 = Date.now();
const rs = await hybridSearch(DB, "What happened to John Reed at college?", 5);
console.log("首次(含模型加载) ms:", Date.now() - t0, "条数:", rs.length);
for (const r of rs) console.log(" #", r.id, "|", String(r.text || "").replace(/\s+/g, " ").slice(0, 70));
const t1 = Date.now();
await hybridSearch(DB, "governor", 3);
console.log("第二次(热) ms:", Date.now() - t1);
