// 单书检索 CLI（薄壳：真正逻辑在 src/lib/search.mjs，与 MCP skill 同一条路）
// 用法: node query-book.js <book.db> "问题" [topN]
// 环境变量 BSP_RERANK=0 可关掉复试官
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

(async () => {
  const [dbPath, query, topArg] = process.argv.slice(2);
  if (!dbPath || !fs.existsSync(dbPath) || !query) {
    console.error('用法: node query-book.js <book.db> "问题" [topN]');
    process.exit(1);
  }
  const topN = parseInt(topArg || "5", 10);
  const db = require("better-sqlite3")(dbPath, { readonly: true });
  const title = db.prepare("SELECT value FROM meta WHERE key='title'").get()?.value;
  const model = db.prepare("SELECT value FROM meta WHERE key='model'").get()?.value;
  db.close();

  const { hybridSearch } = await import(pathToFileURL(path.join(__dirname, "lib", "search.mjs")).href);
  const results = await hybridSearch(dbPath, query, topN);
  console.log(JSON.stringify({ book: title, model, query, results }, null, 2));
})();
