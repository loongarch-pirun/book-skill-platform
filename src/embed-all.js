// 批量向量化：对书库目录下所有 .db 逐个跑 embed-book.js
// 为什么有这文件：embed-book.js 是单本 IIFE（无导出、无 --all），旧 package.json 的
// "ingest": "node src/embed-book.js --all" 会把 --all 当 dbPath 报错——审计 H2-① 实锤的失效脚本。
// 尊重 BSP_LIB_DIR（迁库后的桌面用户与 CLI 共享同一目录解析，M2）。
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const lib = process.env.BSP_LIB_DIR || path.join(__dirname, "..", "library");
if (!fs.existsSync(lib)) {
  console.log(`书库目录不存在（${lib}），无可灌库。迁过书库就设 BSP_LIB_DIR 指过去。`);
  process.exit(0);
}
const dbs = fs.readdirSync(lib).filter((f) => f.endsWith(".db")).sort();
if (!dbs.length) {
  console.log(`书库目录为空（${lib}）。`);
  process.exit(0);
}
for (const f of dbs) {
  console.log(`\n=== ${f} ===`);
  cp.execFileSync(process.execPath, [path.join(__dirname, "embed-book.js"), path.join(lib, f)], { stdio: "inherit" });
}
console.log(`\n完成：${dbs.length} 个库全部灌完`);
