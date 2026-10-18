// 终期暴力测试 P3：similar.mjs 相似块查询爆破（V2 融合轮）。
// 攻击面：src/lib/similar.mjs 的 similarChunks（P-E 以块找块）+ MCP similar_chunks 工具契约。
// 铁律：真库只读拷贝到 tmp；topN 矩阵用 tmp 合成库（随机 384 维向量，零模型）；
//   text 入口才加载真模型（e5，BSP_RERANK=0 不碰复试官）；不碰真 library 原件。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const Database = require("better-sqlite3");

const { similarChunks, clampTopN, MAX_TOPN } = await import("../src/lib/similar.mjs");
const { configureSearch } = await import("../src/lib/search.mjs");
const { registerServerTools } = await import("../src/lib/register-tools.mjs");

let pass = 0, fail = 0, observe = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log(`PASS - ${name}`); }
  else { fail++; console.log(`FAIL - ${name} ${extra}`); }
};
const obs = (cond, name, note = "") => {
  if (cond) { observe++; console.log(`OBSERVE - ${name}${note ? " | " + note : ""}`); }
  else { fail++; console.log(`FAIL - ${name}（OBSERVE 条件不成立）${note}`); }
};
const safeRm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { } };

// tmp 内自建合成库：n 个块 + 随机 384 维向量（e5 同维度）+ meta 表（listBooks 放行）
function makeVecDb(libDir, name, n = 30) {
  const p = path.join(libDir, name);
  const db = new Database(p);
  db.exec(`CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT, emb BLOB);
    CREATE TABLE meta(key TEXT, value TEXT);`);
  db.prepare("INSERT INTO meta VALUES('model','e5')").run();
  const ins = db.prepare("INSERT INTO chunks(id,chapter,page,text,emb) VALUES(?,?,?,?,?)");
  for (let i = 1; i <= n; i++) {
    const v = new Float32Array(384);
    for (let d = 0; d < 384; d++) v[d] = Math.random() * 2 - 1;
    ins.run(i, `第${i}章`, i, `合成块${i}的原文内容，用于向量余弦排序测试。`, Buffer.from(v.buffer));
  }
  db.close();
  return p;
}
// 无 emb 列的老库（跑 embed-book 之前的形态）
function makeNoVecDb(libDir, name) {
  const p = path.join(libDir, name);
  const db = new Database(p);
  db.exec("CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT); CREATE TABLE meta(key TEXT, value TEXT);");
  db.prepare("INSERT INTO chunks VALUES(1,'第一章',1,'甲')").run();
  db.close();
  return p;
}
// 有 emb 列但首块 emb 为 NULL（灌库时被跳过的块）
function makeNullVecDb(libDir, name) {
  const p = path.join(libDir, name);
  const db = new Database(p);
  db.exec("CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT, emb BLOB); CREATE TABLE meta(key TEXT, value TEXT);");
  db.prepare("INSERT INTO chunks VALUES(1,'第一章',1,'没有向量的块',NULL)").run();
  const v = new Float32Array(384).fill(0.5);
  db.prepare("INSERT INTO chunks VALUES(2,'第二章',2,'有向量的块',?)").run(Buffer.from(v.buffer));
  db.close();
  return p;
}
// 真库只读拷贝（16 块真 e5 向量，text 入口用）
const LUNYU = path.join(ROOT, "library", "lunyu-xueer-zh.docx.db");
function copyLunyu(tag) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `bsp-p3-${tag}-`));
  const libDir = path.join(tmp, "library");
  fs.mkdirSync(libDir, { recursive: true });
  const dst = path.join(libDir, "lunyu-xueer-zh.docx.db");
  fs.copyFileSync(LUNYU, dst);
  return { tmp, libDir, db: dst };
}

// ========== P3-A chunk_id 入口（零模型，合成库 30 块） ==========
console.log("\n--- P3-A similarChunks chunk_id 入口 ---");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-p3a-"));
  const libDir = path.join(tmp, "library");
  fs.mkdirSync(libDir, { recursive: true });
  const vec = makeVecDb(libDir, "vec.db", 30);

  // A1：正常 chunk_id → 字段齐全 + 降序 + 自相似排除
  const r1 = await similarChunks(vec, { chunkId: 1, topN: 5 });
  ok(!r1.error && Array.isArray(r1.results) && r1.results.length === 5,
    `P3-A1: chunk_id 正常返回 5 条（实际 ${r1.results?.length}）`);
  ok(r1.query?.chunk === 1 && r1.embed_model === null,
    "P3-A1b: query 回显参照块 + embed_model 为 null（chunk 入口零模型，设计如注释所说）");
  ok(r1.results.every((x) => x.id !== 1),
    "P3-A1c: 自相似排除（参照块不出现在结果里）");
  const scores = r1.results.map((x) => x.score);
  ok(scores.every((s, i) => i === 0 || scores[i - 1] >= s),
    `P3-A1d: 结果按分数降序（${scores.join(" ≥ ")}）`);
  ok(r1.results.every((x) => x.id && x.chapter !== undefined && x.page !== undefined && x.loc && typeof x.score === "number" && x.text),
    "P3-A1e: 每条带 id/chapter/page/loc/score/text（智能体可直接引用）");

  // A2（V2-D17）：topN 矩阵——默认值两份漂移修复后统一为 4；边界全夹回正常区间
  const nDef = (await similarChunks(vec, { chunkId: 1 })).results.length;
  ok(nDef === 4,
    `P3-A2 D17: 不传 topN → 4 条（实际 ${nDef}；修复前 similar 签名默认 5、与 MCP 侧 clampTopN 的 4 漂移）`);
  ok(clampTopN(undefined) === 4 && clampTopN(null) === 4 && clampTopN("abc") === 4 && clampTopN(NaN) === 4,
    "P3-A2b: clampTopN undefined/null/'abc'/NaN 全回退默认 4（两份夹取器同值）");
  ok(clampTopN(0) === 4 && clampTopN(-5) === 1,
    "P3-A2c: topN=0 → 4（0 是 falsy 落默认值，不是下限 1）；-5 → 1（真负数才被夹下限）");
  obs(true, "P3-A2d V2-D24 预判修正登记",
    "规划预判 clampTopN(0)→1 不成立：Number(0)||4 里 0 是 falsy → 落默认 4（register-tools 同款同值，两份一致）。两条路都安全——MCP 侧 zod min(1) 已拒 0，库内 0→4 也无害，预判机制修正登记");
  ok(clampTopN(2.7) === 2,
    "P3-A2d: topN=2.7 → 2（floor 取整）");
  ok(clampTopN(999) === MAX_TOPN && MAX_TOPN === 20,
    `P3-A2e: topN=999 → 封顶 ${MAX_TOPN}（模型一次索要 999 条会拖垮上下文）`);
  const r999 = await similarChunks(vec, { chunkId: 1, topN: 999 });
  ok(r999.results.length === 20,
    `P3-A2f: 端到端 topN=999 实测 20 条（30 块库排除自身剩 29，封顶生效）`);

  // A3/A4：块号不存在 / 0 都是假 id → chunk-not-found 人话
  const r3 = await similarChunks(vec, { chunkId: 999999 });
  ok(r3.error === "chunk-not-found" && /块号来自 query_book/.test(r3.hint || ""),
    `P3-A3: 越界块号 → chunk-not-found + hint（实际 ${r3.error}）`);
  const r4 = await similarChunks(vec, { chunkId: 0 });
  ok(r4.error === "chunk-not-found",
    "P3-A4: chunkId=0 → chunk-not-found（0 不是合法块号，预判闸门守住）");

  // A5：块存在但没有向量
  const nullVec = makeNullVecDb(libDir, "nullvec.db");
  const r5 = await similarChunks(nullVec, { chunkId: 1 });
  ok(r5.error === "chunk-no-vector" && /灌库时该块被跳过/.test(r5.hint || ""),
    `P3-A5: 块无向量 → chunk-no-vector + hint（实际 ${r5.error}）`);

  // A6：库级无 emb 列
  const noVec = makeNoVecDb(libDir, "novec.db");
  const r6 = await similarChunks(noVec, { chunkId: 1 });
  ok(r6.error === "no-vectors" && /跑 embed-book/.test(r6.hint || ""),
    `P3-A6: 无 emb 列 → no-vectors + hint（实际 ${r6.error}）`);

  // A7：两个入口都空 → missing-query
  const r7 = await similarChunks(vec, {});
  ok(r7.error === "missing-query" && /chunk_id 或 text/.test(r7.hint || ""),
    `P3-A7: 两入口全空 → missing-query + hint（实际 ${r7.error}）`);
  const r7b = await similarChunks(vec, { chunkId: null, text: "   " });
  ok(r7b.error === "missing-query",
    "P3-A7b: null/纯空白 text → missing-query（不进任何分支）");

  // A8（V2-D25）：chunkId 与 text 同给时 chunkId 优先——行为确定但工具描述没写，登记
  const r8 = await similarChunks(vec, { chunkId: 1, text: "合成块2的原文内容" });
  ok(r8.query?.chunk === 1 && r8.query?.text === undefined && r8.embed_model === null,
    "P3-A8: chunkId 与 text 同给 → chunkId 优先（text 被忽略，embed_model 仍 null）");
  obs(true, "P3-A8b V2-D25 chunkId 优先未写描述登记",
    "register-tools 的 similar_chunks 描述只写「与 chunk_id 二选一」，没写同给时谁优先——实测 chunkId 优先（代码 if 分支序），补一行描述的事，轻微，登记不修");
  safeRm(tmp);
}

// ========== P3-B text 入口（真模型 e5；BSP_RERANK=0 不碰复试官） ==========
console.log("\n--- P3-B similarChunks text 入口（真库拷贝） ---");
process.env.BSP_RERANK = "0"; // 复试官与本入口无关（只混检用），省一次 568M 模型加载
{
  // B1：正常 text → 现算查询向量，embed_model 透出
  const { tmp, db: lunyu } = copyLunyu("b1");
  const r1 = await similarChunks(lunyu, { text: "学而时习之，不亦说乎" });
  ok(!r1.error && r1.results.length > 0 && r1.embed_model === "e5" && r1.query?.text === "学而时习之，不亦说乎",
    `P3-B1: text 入口正常（${r1.results?.length} 条 / embed_model=${r1.embed_model} / query 回显）`);
  ok(r1.results.every((x) => x.text && typeof x.score === "number"),
    "P3-B1b: text 入口结果同样带 text/score（引用规格一致）");

  // B2（V2-D05）：混引擎库 text 入口——老逻辑 assertEngine throw 裸抛穿层，
  // MCP handler 无 catch，智能体拿到 SDK 包的 "Error: Error: 引擎不一致…" 而非结构化 error
  const mixed = path.join(path.dirname(lunyu), "mixed.db");
  fs.copyFileSync(lunyu, mixed);
  const md = new Database(mixed);
  md.prepare("UPDATE meta SET value='other-engine' WHERE key='model'").run();
  md.close();
  const r2 = await similarChunks(mixed, { text: "学而时习之" });
  ok(r2.error === "engine-mismatch" && /引擎不一致/.test(r2.hint || ""),
    `P3-B2 D05: 混引擎 text → {error:'engine-mismatch', hint} 结构化（修复前 throw 裸抛，实际 ${r2.error}）`);
  obs(true, "P3-B2b V2-D26 混引擎报错前先加载模型登记",
    "text 入口先 getEmbedder() 再 assertEngine——混引擎时模型已加载完才报错（浪费一次加载）。提前 assertEngine(db,DEFAULT_EMBED) 的修法有反效果：用户切 BSP_EMBED_MODEL 时库与 DEFAULT 不同会误伤，现顺序对切换场景才是对的，登记不修");

  // B3（V2-D29，规划外新发现，D06/D-11 家族复发）：垃圾文件——new Database 打开不抛、
  // 首次 prepare 才抛 SQLITE_NOTADB，老逻辑打开在 try 外 + 主体无 catch → 裸崩英文堆栈
  const garbage = path.join(path.dirname(lunyu), "garbage.db");
  fs.writeFileSync(garbage, "我不是数据库".repeat(20));
  const r3a = await similarChunks(garbage, { chunkId: 1 });
  ok(r3a.error === "db-broken" && !!r3a.hint,
    `P3-B3 D29: 垃圾库 chunk_id 入口 → {error:'db-broken'}（修复前 SqliteError 裸崩，实际 ${r3a.error}）`);
  const r3b = await similarChunks(garbage, { text: "x" });
  ok(r3b.error === "db-broken",
    "P3-B3b: 垃圾库 text 入口 → db-broken（PRAGMA 在两个分支之前，同一条防御全覆盖）");

  // B4：缺 chunks 表的老库——PRAGMA table_info 对不存在的表宽容返回空（不抛），
  // 走 no-vectors 分支：对「老库没跑过 embed」这是合理人话，不是缺陷
  // （实证修正预判：这条路径到不了 db-broken，也不抛）
  const old = path.join(path.dirname(lunyu), "old.db");
  const od = new Database(old);
  od.exec("CREATE TABLE meta(key TEXT, value TEXT)");
  od.close();
  const r4 = await similarChunks(old, { chunkId: 1 });
  ok(r4.error === "no-vectors" && /跑 embed-book/.test(r4.hint || ""),
    `P3-B4: 缺 chunks 表老库 → no-vectors（PRAGMA 宽容返回空走无向量分支，人话合理；实测 ${r4.error}）`);
  safeRm(tmp);
}

// ========== P3-C MCP 端到端（InMemoryTransport，mock 智能体） ==========
console.log("\n--- P3-C MCP similar_chunks 工具契约 ---");
{
  const { tmp, libDir } = copyLunyu("c1");
  configureSearch({ libDir });
  // 同 libDir 放两种坏书：页损坏的有效库（meta 可读→listBooks 放行，chunks 数据页崩）
  // 与混引擎库。注意垃圾文件不放——listBooks 的 meta 探测会把它静默过滤（P2-B3b 同款），
  // 根本到不了工具层，测了白测。
  const corrupt = path.join(libDir, "corrupt.db");
  fs.copyFileSync(path.join(libDir, "lunyu-xueer-zh.docx.db"), corrupt);
  // 先改标题再损坏页（写事务要在完好库上做）——拷贝库继承同一 meta.title，
  // "lunyu" 会三本全命中、matches[0] 看 readdir 顺序（P2-B7c 同款歧义）
  const cd2 = new Database(corrupt);
  cd2.prepare("UPDATE meta SET value='页损坏的书' WHERE key='title'").run();
  cd2.close();
  const cbuf = fs.readFileSync(corrupt);
  // 从第 11 页灌到文件尾（P3-⑤ 换库后 enrich 表加入，chunks 数据页不再固定在 11~12 页——
  // 固定范围灌不中查询路径，损坏夹具失效；meta 在第 1 页仍可读，listBooks 照样放行）
  cbuf.fill(0x58, 40960);
  fs.writeFileSync(corrupt, cbuf);
  const mixed = path.join(libDir, "mixed.db");
  fs.copyFileSync(path.join(libDir, "lunyu-xueer-zh.docx.db"), mixed);
  const md = new Database(mixed);
  md.prepare("UPDATE meta SET value='other-engine' WHERE key='model'").run();
  md.prepare("UPDATE meta SET value='混引擎的书' WHERE key='title'").run();
  md.close();

  const server = new McpServer({ name: "book-skill", version: "0.4.0" });
  registerServerTools(server);
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const [cT, sT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sT), client.connect(cT)]);

  // C1：正常链路——chunk_id 入口，工具层注入 book 标题
  const c1 = await client.callTool({ name: "similar_chunks", arguments: { book: "lunyu", chunk_id: 1, topN: 3 } });
  const j1 = JSON.parse(c1.content[0].text);
  ok(!j1.error && j1.results?.length === 3 && j1.book,
    `P3-C1: MCP 正常链路（${j1.results?.length} 条 / book=${j1.book}，工具层注入书名）`);

  // C2（V2-D05 族）：页损坏的书 → 工具返回结构化 error JSON，不裸抛穿层
  // （修复前 SqliteError 穿到 MCP SDK，智能体拿到的是 "Error: Error: file is not a database"）
  const c2 = await client.callTool({ name: "similar_chunks", arguments: { book: "corrupt", chunk_id: 1 } });
  const j2 = JSON.parse(c2.content[0].text);
  ok(j2.error === "db-broken" && !!j2.hint,
    `P3-C2 D05族: MCP 页损坏库 → 结构化 {error:'db-broken', hint} JSON（不裸抛穿层，实际 ${j2.error}）`);

  // C3：混引擎 text → engine-mismatch JSON（D05 的 MCP 侧实证）
  const c3 = await client.callTool({ name: "similar_chunks", arguments: { book: "mixed", text: "学而时习之" } });
  const j3 = JSON.parse(c3.content[0].text);
  ok(j3.error === "engine-mismatch",
    `P3-C3 D05: MCP 混引擎 → {error:'engine-mismatch'} JSON（契约与其余失败路径一致）`);

  // C4：chunk_id 入口同库比较不校验引擎=设计安全（预判闸门：混引擎书走 chunk_id 照样出结果）
  const c4 = await client.callTool({ name: "similar_chunks", arguments: { book: "mixed", chunk_id: 1, topN: 2 } });
  const j4 = JSON.parse(c4.content[0].text);
  ok(!j4.error && j4.results?.length === 2,
    "P3-C4: chunk_id 入口对混引擎库照样工作（两侧向量同出自灌库引擎，无需校验——设计安全，预判闸门守住）");
  safeRm(tmp);
}

console.log();
console.log(`=== similar-fuzz(P3): ${pass} pass / ${fail} fail / ${observe} observe ===`);
process.exit(fail > 0 ? 1 : 0);
