// 阶段0 试金石 1：better-sqlite3 FTS5 trigram 中文检索实测
// 验收标准：中文 4 字词 trigram 命中 + 2 字词 LIKE 降级命中，且都能返回正确页码
const Database = require("better-sqlite3");
const assert = (cond, msg) => {
  console.log((cond ? "PASS" : "FAIL") + " - " + msg);
  if (!cond) process.exitCode = 1;
};

const db = new Database(":memory:");
const sqliteVer = db.prepare("select sqlite_version() v").get().v;
console.log("SQLite 版本: " + sqliteVer);

// 模拟一本书的切片表：原文一字不改 + 页码
db.exec(`
  CREATE TABLE chunks(
    id INTEGER PRIMARY KEY,
    book TEXT, page INTEGER, text TEXT
  );
  CREATE VIRTUAL TABLE chunks_fts USING fts5(
    text, content='chunks', content_rowid='id', tokenize='trigram'
  );
`);
const ins = db.prepare("INSERT INTO chunks(book,page,text) VALUES (?,?,?)");
const samples = [
  ["测试书", 12, "知识管理是每个人都需要的能力，尤其在大模型时代。"],
  ["测试书", 47, "检索增强生成让模型回答可以锚定原文，减少幻觉。"],
  ["测试书", 88, "图形思维导图帮助梳理章节结构与概念之间的关系。"],
];
for (const s of samples) {
  ins.run(...s);
  db.prepare("INSERT INTO chunks_fts(rowid, text) VALUES ((select id from chunks where text=?), ?)").run(s[2], s[2]);
}

// 试金石 1a：4 字词 trigram 命中
const hit4 = db.prepare(`
  SELECT c.page, c.text FROM chunks_fts f JOIN chunks c ON c.id=f.rowid
  WHERE chunks_fts MATCH ?`).all('"检索增强生成"');
assert(hit4.length === 1 && hit4[0].page === 47, "trigram 4字词命中且页码正确(47) -> " + JSON.stringify(hit4.map(h=>h.page)));

// 试金石 1b：2 字词（trigram 索引要求>=3字符，按方案降级 LIKE）
const hit2 = db.prepare(`
  SELECT page, text FROM chunks WHERE text LIKE ?`).all("%幻觉%");
assert(hit2.length === 1 && hit2[0].page === 47, "2字词 LIKE 降级命中且页码正确(47)");

// 试金石 1c：确认 FTS5 + trigram tokenizer 可用（能建表=可用）
assert(true, "FTS5 trigram 虚表在 Windows 上零编译建表成功");

// 试金石 1d：其余零件能否加载
const checks = [
  ["pdfjs-dist", () => require("pdfjs-dist")],
  ["mammoth", () => require("mammoth")],
  ["adm-zip", () => require("adm-zip")],
  ["@xmldom/xmldom", () => require("@xmldom/xmldom")],
  ["@huggingface/transformers", () => require("@huggingface/transformers")],
  ["@modelcontextprotocol/sdk", () => require("@modelcontextprotocol/sdk")],
  ["zod", () => require("zod")],
];
for (const [name, fn] of checks) {
  try { fn(); assert(true, name + " 加载成功"); }
  catch (e) { assert(false, name + " 加载失败: " + e.message); }
}
console.log("\n阶段0 试金石 1 执行完毕");
