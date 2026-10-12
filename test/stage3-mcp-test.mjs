// 阶段3 验收：用官方 SDK 客户端（模拟任意智能体）接入 MCP server 实测三个工具
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerServerTools } from "../src/lib/register-tools.mjs";

let failed = 0;
const assert = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (!cond) failed++; };

// 起服务端（复用与 stdio server 完全相同的工具注册逻辑）
const server = new McpServer({ name: "book-skill", version: "0.3.0" });
registerServerTools(server);
const client = new Client({ name: "test-agent", version: "1.0.0" });
const [cT, sT] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(sT), client.connect(cT)]);

// 1. 工具清单
const tools = await client.listTools();
const names = tools.tools.map(t => t.name).sort();
assert(JSON.stringify(names) === JSON.stringify(["list_books", "list_catalog", "query_book", "query_library"]), `智能体能看到 4 个工具: ${names.join(", ")}`);

// 2. list_books
const lb = await client.callTool({ name: "list_books", arguments: {} });
const books = JSON.parse(lb.content[0].text);
assert(books.length === 6 && books.every(b => b.title && b.format), `list_books 返回 6 本书: ${books.map(b => b.title).join(" / ")}`);

// 3. query_book 单书（书名精确匹配到 PDF 版，带页码定位）
const qb = await client.callTool({ name: "query_book", arguments: { book: "lunyu-xueer-zh.pdf", question: "不患人之不己知", topN: 3 } });
const qbR = JSON.parse(qb.content[0].text);
assert(qbR.results?.length >= 1 && /lunyu/i.test(qbR.book) && qbR.results.some(r => r.loc === "第4页"),
  `query_book 精确书名命中且带页码定位（${qbR.results?.[0]?.loc}）`);

// 3b. query_book 模糊书名（"lunyu" 同时匹配 PDF+DOCX 两本 → 明确告知选了哪本）
const qb2 = await client.callTool({ name: "query_book", arguments: { book: "lunyu", question: "不患人之不己知", topN: 3 } });
const qb2R = JSON.parse(qb2.content[0].text);
assert(qb2R.results?.length >= 1 && qb2R.note && /匹配到 2 本/.test(qb2R.note),
  `query_book 模糊书名多本命中时明确提示（${qb2R.note || ""}）`);

// 3c. query_book 中文书名（匹配不到拼音名 → 自动路由到最相关的书）
const qb3 = await client.callTool({ name: "query_book", arguments: { book: "论语", question: "不患人之不己知", topN: 3 } });
const qb3R = JSON.parse(qb3.content[0].text);
assert(qb3R.results?.length >= 1 && /lunyu/i.test(qb3R.book) && qb3R.note,
  `query_book 书名未命中时自动路由: ${qb3R.book}`);

// 4. query_library 动态挑书（中文问题应路由到论语，不碰英文书）
const ql = await client.callTool({ name: "query_library", arguments: { question: "和朋友相处要讲信用", topN: 3 } });
const qlR = JSON.parse(ql.content[0].text);
assert(qlR.routed_books.length >= 1 && /lunyu/i.test(qlR.routed_books[0].title),
  `query_library 自动挑书: ${qlR.routed_books.map(b => b.title + "(" + b.best_sim + ")").join(", ")}`);
assert(qlR.results.length >= 1 && qlR.results.every(r => r.book && r.loc !== undefined), `总入口结果带书的归属 + 定位`);

// 4b. 英文问题路由到英文书
const ql2 = await client.callTool({ name: "query_library", arguments: { question: "attention mechanism in transformers", topN: 3 } });
const ql2R = JSON.parse(ql2.content[0].text);
assert(/attention/i.test(ql2R.routed_books[0].title), `英文问题自动路由到英文书: ${ql2R.routed_books[0].title}`);

// 5. 引用完整性：结果文本非空、含原文
assert(qlR.results.every(r => r.text && r.text.length > 10), `所有结果带原文（可回源核对）`);

// 6. list_catalog 编目浏览（P&P 已编目：12 主题 / 25 人物 / 26 关系）
const lc = await client.callTool({ name: "list_catalog", arguments: { book: "pride" } });
const lcR = JSON.parse(lc.content[0].text);
assert(lcR.cataloged === true && lcR.themes?.length === 12 && lcR.persons?.length === 25 && lcR.relations?.length === 26,
  `list_catalog 编目浏览: ${lcR.themes?.length} 主题 / ${lcR.persons?.length} 人物 / ${lcR.relations?.length} 关系`);

// 6b. list_catalog 人物关系断言（谁拆散了简和宾利 → 卡罗琳）
const carolineRel = lcR.relations.find(r => (r.a === "Caroline Bingley" && r.b === "Jane Bennet") || (r.b === "Caroline Bingley" && r.a === "Jane Bennet"));
assert(!!carolineRel && /拆散|拆开/.test(carolineRel.note), `list_catalog 关系网可查"谁拆散了简和宾利": ${carolineRel ? carolineRel.a + " ↔ " + carolineRel.b : "未找到"}`);

// 6c. list_catalog 主题过滤 + 代表块
const lc2 = await client.callTool({ name: "list_catalog", arguments: { book: "pride", theme: "pemberley" } });
const lc2R = JSON.parse(lc2.content[0].text);
assert(lc2R.filtered_themes?.length >= 1 && lc2R.theme_representatives && Object.values(lc2R.theme_representatives).flat().every(x => x.preview && x.chapter !== undefined),
  `list_catalog 主题过滤带代表块预览: ${lc2R.filtered_themes?.map(t => t.name).join(" / ")}`);

// 6d. list_catalog 1 堆小书（论语 pdf：全库 6 本现已全部编目）
const lc3 = await client.callTool({ name: "list_catalog", arguments: { book: "lunyu-xueer-zh.pdf" } });
const lc3R = JSON.parse(lc3.content[0].text);
assert(lc3R.cataloged === true && lc3R.themes?.length === 1 && lc3R.persons?.length === 5,
  `list_catalog 1 堆小书浏览: ${lc3R.themes?.map(t => t.name).join("/")} / 人物 ${lc3R.persons?.length}`);

// 6e. list_catalog 找不到的书
const lc4 = await client.callTool({ name: "list_catalog", arguments: { book: "不存在的书" } });
const lc4R = JSON.parse(lc4.content[0].text);
assert(!!lc4R.error && Array.isArray(lc4R.available), `list_catalog 书名未命中返回错误+书目清单`);

console.log("\n===== 阶段3 验收结果 =====");
if (failed > 0) { console.log(`${failed} 项 FAIL`); process.exit(1); }
console.log("全部 PASS：标准 MCP 协议接入成功，四工具可用（含编目浏览），自动挑书路由正确，引用可回源");
process.exit(0);
