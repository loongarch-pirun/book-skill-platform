// V3-R1 查询改写测试：rewriteQuery/parseRewrite 单元（假 API 全场景）
// + multiVariantSearch（夹具库：合并去重/变体裁剪/空变体）
// + askWithRewrite 编排端到端（tmp libDir + configureSearch + H3 门 + BSP_REWRITE 开关）
// 铁律：不碰真 library、不碰真网络、不碰 safeStorage（config 参数注入）；
// BSP_RERANK=0 免加载复试官（本套件断言合并/去重/降级，rerank 终审由 ftsliteral/eval 覆盖）。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

process.env.BSP_RERANK = "0";

const { rewriteQuery, parseRewrite } = await import("../src/lib/query-rewrite.mjs");
const { multiVariantSearch, configureSearch } = await import("../src/lib/search.mjs");
const { askWithRewrite } = await import("../src/desktop/chat.mjs");
const { setSkillEnabled } = await import("../src/lib/skill-state.mjs");

let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log(`PASS - ${name}`); }
  else { fail++; console.log(`FAIL - ${name} ${extra}`); }
};

// ---------- 假 API：按请求内容分发（改写请求的 system 带「检索查询改写器」） ----------
let rewriteReply = null;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let payload;
    try {
      const b = JSON.parse(body);
      const isRewrite = (b.messages || []).some((m) => String(m.content || "").includes("检索查询改写器"));
      payload = isRewrite ? rewriteReply : "";
    } catch { payload = ""; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: payload } }], usage: { total_tokens: 10 } }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const CONFIG = { baseUrl: BASE, apiKey: "sk-v3-test", model: "test-chat" };

// ---------- A. rewriteQuery / parseRewrite ----------
console.log("\n--- A. rewriteQuery ---");
{
  rewriteReply = JSON.stringify({ variants: ["口语问法一下", "保民而王", "口语问法一下", "超长".repeat(60)], terms: ["王道", "王道", "仁政"] });
  const r = await rewriteQuery({ config: CONFIG, question: "口语问法一下" });
  ok(r.ok === true && r.variants[0] === "口语问法一下", "A1: 改写成功且原句保底在首位");
  ok(r.variants.length === 2, `A2: 去重 + 80 字超长过滤（实际 ${r.variants.length} 条）`);
  ok(r.terms.join(",") === "王道,仁政", "A3: terms 去重");
}
{
  rewriteReply = "好的，这是改写：\n```json\n{\"variants\":[\"保民而王\"],\"terms\":[\"民本\"]}\n```\n以上。";
  const r = await rewriteQuery({ config: CONFIG, question: "保民而王" });
  ok(r.ok && r.variants.length === 1 && r.variants[0] === "保民而王", "A4: 围栏 + 夹带文字宽容解析");
}
{
  rewriteReply = "我不会改写。";
  const r = await rewriteQuery({ config: CONFIG, question: "口语问法" });
  ok(r.ok === false && r.fallback === true && r.code === "BADRESP", "A5: 非 JSON → fallback（调用方退单路）");
}
{
  rewriteReply = JSON.stringify({ terms: ["只有词"] });
  const r = await rewriteQuery({ config: CONFIG, question: "口语问法" });
  ok(r.ok === false && r.fallback === true, "A6: variants 缺失 → fallback");
}
{
  rewriteReply = "慢";
  const r = await rewriteQuery({ config: CONFIG, question: "口语问法", timeoutMs: 300 });
  ok(r.ok === false && r.fallback === true, "A7: 超时 → fallback");
}
{
  ok((await rewriteQuery({ config: CONFIG, question: "  " })).ok === false, "A8: 空问题短路");
}
{
  const p = parseRewrite(JSON.stringify({ variants: ["甲", "乙"] }), "原句");
  ok(p.variants[0] === "原句" && p.variants.length === 3, "A9: parseRewrite 原句缺位自动补首");
  ok(parseRewrite("没有花括号的一段话") === null, "A10: parseRewrite 无花括号 → null");
}

// ---------- 夹具：tmp libDir + 迷你书（甲篇 3 块 / 乙篇 2 块，无 emb 列 → 字面腿快路径） ----------
console.log("\n--- B. multiVariantSearch ---");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-v3rw-"));
const libDir = path.join(TMP, "library");
fs.mkdirSync(libDir, { recursive: true });
const dbPath = path.join(libDir, "mini.docx.db");
{
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT NOT NULL);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='trigram');`);
  db.prepare("INSERT INTO meta(key,value) VALUES('title','迷你测试书')").run();
  const ins = db.prepare("INSERT INTO chunks(chapter, text) VALUES (?,?)");
  ins.run("甲篇", "保民而王，莫之能御也。");
  ins.run("甲篇", "王道之始也。");
  ins.run("甲篇", "齊宣王問曰。");
  ins.run("乙篇", "上善若水，水善利萬物而不爭。");
  ins.run("乙篇", "無為而無不為。");
  db.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')").run();
  db.close();
}
{
  const r = await multiVariantSearch(dbPath, ["保民而王", "上善若水"], 6);
  const ids = r.map((x) => x.id).sort((a, b) => a - b).join(",");
  ok(ids === "1,4" && r.length === 2, `B1: 两路变体命中合并（ids=${ids}）——甲篇一路、乙篇一路`);
  ok(r.every((x) => x.hitVariants === 1), "B2: 单路命中 hitVariants=1（共识计数不参与打分）");
}
{
  const r = await multiVariantSearch(dbPath, ["上善若水", "上善若水", "  "], 6);
  ok(r.length === 1 && r[0].id === 4 && r[0].hitVariants === 1, "B3: 变体去重（同问法不重复计路）");
}
{
  ok((await multiVariantSearch(dbPath, [], 6)).length === 0, "B4: 空变体 → 空结果");
  const one = await multiVariantSearch(dbPath, ["保民而王"], 6);
  ok(one.length === 1 && one[0].id === 1, "B5: 单变体等价 hybridSearch 快路径");
}

// ---------- C. askWithRewrite 编排端到端 ----------
console.log("\n--- C. askWithRewrite 编排 ---");
configureSearch({ libDir }); // findBook/currentLibDir 指 tmp——不碰真 library
setSkillEnabled(libDir, "mini.docx", true);
{
  rewriteReply = JSON.stringify({ variants: ["口语问法一下", "保民而王", "上善若水"], terms: [] });
  const r = await askWithRewrite({ bookId: "mini.docx", question: "口语问法一下", topN: 6, skillSlug: null, history: [], config: CONFIG });
  ok(r.rewrite.used === true && r.rewrite.variants.length === 3, "C1: 改写成功 → 多路检索启用");
  const ids = r.base.results.map((x) => x.id).sort((a, b) => a - b).join(",");
  ok(ids === "1,4", `C2: 多路合并命中两路（ids=${ids}）`);
  ok(r.base.book === "迷你测试书" && r.base.bookId === "mini.docx" && r.base.mode === "book",
    "C3: base 带 book/bookId/mode（cloudSummary 引用补齐依赖）");
}
{
  rewriteReply = "这不是 JSON";
  const r = await askWithRewrite({ bookId: "mini.docx", question: "保民而王", topN: 6, skillSlug: null, history: [], config: CONFIG });
  ok(r.rewrite.used === false && r.base.results.some((x) => x.id === 1), "C4: 改写坏 JSON → 单路兜底照常出结果");
}
{
  process.env.BSP_REWRITE = "0";
  rewriteReply = JSON.stringify({ variants: ["甲", "乙"], terms: [] });
  const r = await askWithRewrite({ bookId: "mini.docx", question: "保民而王", topN: 6, skillSlug: null, history: [], config: CONFIG });
  ok(r.rewrite.used === false && r.base.results.some((x) => x.id === 1), "C5: BSP_REWRITE=0 → 完全旁路");
  delete process.env.BSP_REWRITE;
}
{
  setSkillEnabled(libDir, "mini.docx", false);
  rewriteReply = JSON.stringify({ variants: ["口语问法一下", "保民而王"], terms: [] });
  let threw = null;
  try { await askWithRewrite({ bookId: "mini.docx", question: "口语问法一下", topN: 6, skillSlug: null, history: [], config: CONFIG }); }
  catch (e) { threw = e; }
  ok(threw && /skill 已关/.test(threw.message), `C6: H3 开关门在重切路径原样生效（${threw?.message?.slice(0, 20)}）`);
  setSkillEnabled(libDir, "mini.docx", true);
}
{
  rewriteReply = JSON.stringify({ variants: ["口语问法一下", "保民而王"], terms: [] });
  const r = await askWithRewrite({ bookId: null, question: "口语问法一下", topN: 6, skillSlug: null, history: [], config: CONFIG });
  ok(r.rewrite.used === false && Array.isArray(r.base.results), "C7: 全库模式 v1 走现状单路（跨书改写路由留两轮波次）");
}

// ---------- 清理 ----------
server.close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* tmp 残留无害 */ }

console.log(`\n===== query-rewrite-test：${pass} PASS / ${fail} FAIL =====`);
if (fail) process.exitCode = 1;
