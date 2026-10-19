// 新书 e2e 验收（V3R7-③ 第4批，泛化自 fenix-e2e）：任意书跑四层验证——
//   层1 检索 / 层2 翻章（get_outline 地图 → get_chapter → read_range 续读）/
//   层3 防幻觉（真引文 vs 编造引文，走 cite_check 工具）/ 层4 智能体端到端（真 LLM）
// 用法: node books/_work/kb-e2e.mjs <书名或db路径> [--layer search|browse|cite|e2e|all]
//   search 层题目可选：books/_work/e2e-questions/<bookId>.json（[{q, expect:[...]}]），
//   缺省跑冒烟（任意问句有结果即可）。层4 需要 %APPDATA%/book-skill-platform/llm.json。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerServerTools } from "../../src/lib/register-tools.mjs";
import { getOutline } from "../../src/lib/outline.mjs";
import { listBooks } from "../../src/lib/search.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.join(HERE, "..", "..", "library");

const args = process.argv.slice(2);
const layerFlag = args.indexOf("--layer");
const layerArg = layerFlag >= 0 ? args[layerFlag + 1] : "all";
const layers = new Set(layerArg.split(",").map(s => s.trim()));
const isLayer = (l) => layers.has("all") || layers.has(l);
const bookArg = args.find((a, i) => !a.startsWith("--") && a !== layerArg && i !== layerFlag + 1);
if (!bookArg) {
  console.error("用法: node books/_work/kb-e2e.mjs <书名或db路径> [--layer search|browse|cite|e2e|all]");
  console.error("  书名片段如: fenix / pride / mengzi（匹配 list_books 的 id 或 title）");
  process.exit(1);
}
const books = listBooks(LIB_DIR, { includeDisabled: true });
const q = String(bookArg).toLowerCase();
const book = books.find(b => b.id.toLowerCase().includes(q) || b.title.toLowerCase().includes(q))
  || (fs.existsSync(bookArg) ? { id: path.basename(bookArg).replace(/\.db$/, ""), db: bookArg, title: path.basename(bookArg).replace(/\.db$/, "") } : null);
if (!book) {
  console.error(`找不到书「${bookArg}」。库里有: ${books.map(b => b.id).join(", ")}`);
  process.exit(1);
}
console.log(`验收对象: ${book.title}（${book.id}）| ${book.chunks} 块 ≈${book.total_tokens} token | 章节 ${book.chapter_quality?.verdict}`);

const server = new McpServer({ name: "book-skill", version: "0.3.0" });
registerServerTools(server);
const client = new Client({ name: "e2e-agent", version: "1.0.0" });
const [cT, sT] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(sT), client.connect(cT)]);

const { loadSkillState, setSkillEnabled } = await import("../../src/lib/skill-state.mjs");
const beforeState = loadSkillState(LIB_DIR);
for (const id of Object.keys(beforeState).filter((id) => beforeState[id] === false)) setSkillEnabled(LIB_DIR, id, true);

const call = async (name, a) => {
  const r = await client.callTool({ name, arguments: a });
  return JSON.parse(r.content[0].text);
};
const log = (...a) => console.log(...a);

// ============ 层1：检索（题目文件可配，缺省冒烟） ============
if (isLayer("search")) {
  log("\n========== 层1 检索 ==========\n");
  const qFile = path.join(HERE, "e2e-questions", `${book.id}.json`);
  let items = [];
  try { items = JSON.parse(fs.readFileSync(qFile, "utf8")); log(`题目文件: ${path.relative(LIB_DIR, qFile)}（${items.length} 题）`); }
  catch { log(`无题目文件（${path.relative(LIB_DIR, qFile)}）→ 冒烟模式`); }
  if (!items.length) items = [{ q: `${book.title} 的核心内容是什么`, expect: [] }];
  for (const item of items) {
    const r = await call("query_book", { book: book.id, question: item.q, topN: 5 });
    const hits = r.results || [];
    const text = hits.map(h => h.text).join("\n");
    const miss = (item.expect || []).filter(k => !text.includes(k));
    log(`Q: ${item.q}`);
    log(`   路由: ${r.book} | 命中 ${hits.length} 块 | 缺关键词: ${miss.length ? miss.join(",") : "无"}`);
    log(`   首块定位: ${hits[0]?.loc} | 首块开头: ${JSON.stringify((hits[0]?.text || "").slice(0, 60))}`);
  }
}

// ============ 层2：翻章（get_outline 地图 → 最大章 get_chapter → read_range 续读） ============
if (isLayer("browse")) {
  log("\n========== 层2 翻章（动线: get_outline → get_chapter → read_range） ==========\n");
  const o = await call("get_outline", { book: book.id, maxChapters: 500 });
  if (o.error) {
    log(`get_outline → ${o.error}: ${o.hint}`);
    log("无章节书：直接验 read_range（按块号读是它的正路）");
    // 清洗过的书低号块可能已进隔离账（kk 实测：目录页删完后最小块号是 8）——
    // 用库里真实最小块号起读，不写死 1；error/hint 也照实显示（工具侧 empty-range 会指路）
    const dbm = new Database(book.db, { readonly: true });
    const mm = dbm.prepare("SELECT MIN(id) mn FROM chunks").get();
    dbm.close();
    const rFrom = mm?.mn || 1, rTo = rFrom + 4;
    const rr = await call("read_range", { book: book.id, from: rFrom, to: rTo });
    log(`read_range ${rFrom}-${rTo} → ${rr.blocks?.length ?? 0} 块${rr.error ? " | error: " + rr.error + " " + (rr.hint || "").slice(0, 50) : ""}${rr.note ? " | note: " + rr.note.slice(0, 60) : ""}`);
    if (rr.blocks?.length) log(`   首块: ${JSON.stringify(rr.blocks[0].text.slice(0, 60))}`);
  } else {
    const top = [...o.chapters].sort((a, b) => b.tokens - a.tokens)[0];
    log(`get_outline → ${o.chapters_total} 章 / 总 ≈${o.total_tokens} token / 质量 ${o.chapter_quality.verdict}`);
    log(`   最大章: 「${top.name}」${top.blocks} 块 ≈${top.tokens} token（起始块号 ${top.first_id}）`);
    const gc = await call("get_chapter", { book: book.id, chapter: top.name });
    if (gc.error) log(`get_chapter → ${gc.error}: ${gc.hint}`);
    else {
      log(`get_chapter「${top.name}」→ 命中「${gc.matched_chapter}」（${gc.match_level}）| 共 ${gc.total} 块返回 ${gc.blocks.length}（≈${gc.tokens} token）${gc.note ? " | note: " + gc.note.slice(0, 90) : ""}`);
      if (gc.blocks.length) log(`   首块: ${JSON.stringify(gc.blocks[0].text.slice(0, 60))}`);
    }
    const rr = await call("read_range", { book: book.id, from: top.first_id, to: top.first_id + 4 });
    log(`read_range ${top.first_id}-${top.first_id + 4} → ${rr.blocks?.length ?? 0} 块${rr.note ? " | note: " + rr.note.slice(0, 60) : ""}`);
  }
}

// ============ 层3：防幻觉（真引文 vs 编造引文，走 cite_check 工具） ============
if (isLayer("cite")) {
  log("\n========== 层3 防幻觉（cite_check 工具回验） ==========\n");
  const db = new Database(book.db, { readonly: true });
  const rows = db.prepare("SELECT chapter, page, text FROM chunks ORDER BY id LIMIT 3").all();
  db.close();
  const real = [];
  for (const r of rows) {
    const clause = String(r.text).split(/[。；！？!?;.\n]+/).map(s => s.trim()).find(s => s.replace(/\s/g, "").length >= 8);
    if (clause) real.push({ tag: "真引文", q: clause });
  }
  const fakes = [
    { tag: "编造引文", q: `${book.title}认为所有系统都必须在一开始就采用微服务否则必然失败` },
    { tag: "编造引文", q: "根据本书第一章，作者建议用区块链重构所有数据库" },
  ];
  for (const item of [...real, ...fakes]) {
    const r = await call("cite_check", { book: book.id, quote: item.q });
    const mark = item.tag === "真引文" ? (r.hit ? "✓" : "✗ 漏拦") : (r.hit ? "✗ 假阳性" : "✓");
    log(`${mark} ${item.tag}（${r.hit ? "命中" : "未命中"}${r.level ? " " + r.level : ""}）${JSON.stringify(item.q.slice(0, 42))}`);
  }
}

// ============ 层4：智能体端到端（真 LLM + MCP 工具 agent loop） ============
if (isLayer("e2e")) {
  log("\n========== 层4 端到端：智能体用 MCP 工具完成任务 ==========\n");
  const cfgPath = path.join(process.env.APPDATA || "", "book-skill-platform", "llm.json");
  if (!fs.existsSync(cfgPath)) {
    log(`SKIP 层4：没有 LLM 配置（${cfgPath}）——本层只在配了云端 AI 的机器上跑`);
  } else {
    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const cfg = { baseUrl: raw.baseUrl, model: raw.model, apiKey: Buffer.from(raw.apiKeyEnc.slice(6), "base64").toString("utf8") };
    const tools = await client.listTools();
    const toolDefs = tools.tools.map(t => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    const TASK = `我工作中需要引用《${book.title}》的内容做决策。请使用你的知识库工具（list_books/get_outline/get_chapter/read_range/query_book/cite_check 等）：①摸清这本书有哪些可用的板块 ②挑与工作最相关的 2-3 处读原文 ③引用书中原文作为依据，输出一份简短的工作备忘（中文）。书中没有的内容必须明说，不许编造。`;
    const messages = [
      { role: "system", content: "你是一个严谨的工程师，手边有一套知识库 MCP 工具。先用 list_books 看书架与体量，小书 read_full_book、大书 get_outline 看地图再翻章。引用必须逐字抄自工具返回的原文（含定位），写完用 cite_check 自检。没有依据就明说。" },
      { role: "user", content: TASK },
    ];
    let toolCalls = 0;
    const usage = { prompt: 0, completion: 0 };
    for (let round = 0; round < 12; round++) {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, messages, tools: toolDefs, temperature: 0, max_tokens: 2000 }),
      });
      const j = await res.json();
      if (!res.ok) { log("LLM 错误:", res.status, JSON.stringify(j).slice(0, 200)); break; }
      if (j.usage) { usage.prompt += j.usage.prompt_tokens; usage.completion += j.usage.completion_tokens; }
      const msg = j.choices[0].message;
      messages.push(msg);
      if (!msg.tool_calls || !msg.tool_calls.length) {
        log("\n===== 智能体最终输出 =====\n");
        log(msg.content || "(空)");
        log(`\n===== 统计：工具调用 ${toolCalls} 次 | tokens ${usage.prompt} in / ${usage.completion} out =====`);
        break;
      }
      for (const tc of msg.tool_calls) {
        toolCalls++;
        let a = {};
        try { a = JSON.parse(tc.function.arguments || "{}"); } catch {}
        log(`[第${round + 1}轮] 调工具 ${tc.function.name}(${JSON.stringify(a).slice(0, 90)})`);
        let result;
        try { result = await call(tc.function.name, a); } catch (e) { result = { error: String(e) }; }
        let text = JSON.stringify(result);
        if (text.length > 6000) text = text.slice(0, 6000) + "…(截断)";
        messages.push({ role: "tool", tool_call_id: tc.id, content: text });
      }
    }
  }
}

// 还原 skill 开关
for (const id of Object.keys(beforeState)) if (beforeState[id] === false) setSkillEnabled(LIB_DIR, id, false);
await client.close();
