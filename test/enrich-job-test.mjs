// 洗数据一键入口验收（V3 第二波 #140：src/desktop/enrich-job.mjs）
// 假 ipcMain 捕获通道 + 假 chatFn 注入（不连网络）+ 临时库目录（不碰 library/ 真库）。
// 覆盖：通道注册 / 无 key 人话拒启 / 全流程跑批→自动入库→done / 取消闸门 / STALE 拒收 /
//       BSP_SUMMARY=0 / 断点续跑零重复调用 / audit 坏书 / 状态出海可克隆 / 书架摘要挂载。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

import { registerIpc } from "../src/desktop/ipc.mjs";
import { startEnrich, cancelEnrich, enrichStatus, enrichAudit, onEnrichProgress } from "../src/desktop/enrich-job.mjs";
import { configureSearch } from "../src/lib/search.mjs";
import { configureLlmConfig } from "../src/desktop/llm-config.mjs";
import { booksList } from "../src/desktop/engine.mjs";
// 外部智能体路新入口用命名空间引：缺导出时只让本节断言失败，不拖垮整文件加载（干净 RED）
import * as enrichJobNS from "../src/desktop/enrich-job.mjs";

let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log(`PASS - ${name}`); }
  else { fail++; console.log(`FAIL - ${name} ${extra}`); }
};

// ---------- 夹具 ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-enrich-job-"));
const LIB = path.join(TMP, "library");           // 临时库目录（configureSearch 指过来，真库零打扰）
const RESULTS = path.join(TMP, "enrich-results"); // = LIB/../enrich-results，与生产同构
fs.mkdirSync(LIB, { recursive: true });
configureSearch({ libDir: LIB });

const CHUNKS = [
  { chapter: "第一章 低压电器", text: "低压断路器是配电系统的核心保护电器，当电流超过设定值时自动切断电路。熔断器利用金属熔断特性实现短路保护，两者常配合使用。" },
  { chapter: "第一章 低压电器", text: "接触器通过电磁线圈的通断来控制主触点的闭合，适用于频繁启动的电动机控制回路，选型时要看线圈电压与触点容量。" },
  { chapter: "第一章 低压电器", text: "热继电器依靠电流热效应推动动作机构，对电动机过载和缺相运行提供保护，其整定电流可按额定电流的百分数调节。" },
  { chapter: "第二章 电动机", text: "三相异步电动机的转速由同步转速与转差率决定，改变极对数或供电频率即可实现调速，变频调速是目前最常用的方案。" },
  { chapter: "第二章 电动机", text: "电动机启动电流可达额定值的数倍，直接启动会影响电网电压，因此较大容量的电动机需要星三角或软启动器降压启动。" },
  { chapter: "第二章 电动机", text: "伺服电动机以高精度定位著称，编码器把转角换成脉冲反馈给驱动器，构成半闭环控制系统，数控机床广泛采用。" },
];

function makeDb(name, chunks = CHUNKS, meta = {}) {
  const p = path.join(LIB, name);
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(p + suffix, { force: true });
  const db = new Database(p);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT NOT NULL);`);
  const ins = db.prepare("INSERT INTO chunks(chapter,page,text) VALUES (?,?,?)");
  for (const c of chunks) ins.run(c.chapter, null, c.text);
  const sm = db.prepare("INSERT INTO meta(key,value) VALUES (?,?)");
  for (const [k, v] of Object.entries({ title: name.replace(/\.db$/, ""), content_hash: "hash-aaa", format: "md", ...meta })) sm.run(k, String(v));
  db.close();
  return p;
}

// 假 chat：handler(req, callNo) 返回字符串/对象/{ok:false}；按请求类型分派块批/章批/书摘要
function fakeChat(handler) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    const out = handler(req, calls.length);
    if (out && typeof out === "object" && out.ok === false) return out;
    return { ok: true, text: typeof out === "string" ? out : JSON.stringify(out), usage: { prompt_tokens: 100, completion_tokens: 50 } };
  };
  fn.calls = calls;
  return fn;
}
const idxsOf = (req) => [...req.messages[1].content.matchAll(/\[idx (\d+)\]/g)].map((m) => +m[1]);
const chaptersOf = (req) => [...new Set([...req.messages[1].content.matchAll(/【(.+?)】/g)].map((m) => m[1]))];
// 从 user 消息里逐块取原文（标签必须回源命中——假 chat 也按真模型的规矩从块内取词）
const blocksOf = (req) => {
  const out = new Map();
  const re = /\[idx (\d+)\](?:《[^》]*》)?\n([\s\S]*?)(?=\n\n\[idx \d+\]|$)/g;
  let m;
  while ((m = re.exec(req.messages[1].content))) out.set(+m[1], m[2].trim());
  return out;
};
// 标准好响应：块批（tag 取块原文前 5 字，回源验真必过）/ 章批 / 书摘要
const goodChat = fakeChat((req) => {
  const sys = req.messages[0].content;
  if (sys.includes("章节摘要")) return chaptersOf(req).map((ch) => ({ chapter: ch, summary: "章摘要：" + ch }));
  if (sys.includes("全书摘要")) return "全书摘要：低压电器与电动机的基础知识。";
  const blocks = blocksOf(req);
  return idxsOf(req).map((i) => ({ idx: i, prefix: `第 ${i} 块的前置。`, tags: [(blocks.get(i) || "块").slice(0, 5)], questions: ["这块讲了什么"], summary: `第 ${i} 块摘要。` }));
});

// 事件捕获（取消态会从注册表删除，只能从事件流里验）
const events = [];
onEnrichProgress((e) => events.push(e));

// 等终态（done/failed/cancelled）——跑批是后台的，测试轮询注册表 + 事件流
async function waitTerminal(bookId, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const j = enrichStatus()[bookId];
    if (j && ["done", "failed", "cancelled"].includes(j.stage)) return j;
    const ev = events.find((e) => e.bookId === bookId && ["done", "failed", "cancelled"].includes(e.stage));
    if (ev) return ev;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`等待 ${bookId} 终态超时`);
}
const textHash = (dbPath) => {
  const db = new Database(dbPath, { readonly: true });
  try { return db.prepare("SELECT group_concat(text) t FROM chunks").get().t; } finally { db.close(); }
};
const cell = (dbPath, sql, ...args) => {
  const db = new Database(dbPath, { readonly: true });
  try { return db.prepare(sql).get(...args); } finally { db.close(); }
};

// ========== 1) 通道注册（假 ipcMain 捕获生产同一份注册代码） ==========
{
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  await registerIpc({ ipcMain, app: { isPackaged: false, getPath: () => null }, dialog: { showOpenDialog: async () => ({ canceled: true }) }, shell: { openPath: async () => "" }, getWin: () => null });
  const want = ["enrich:start", "enrich:cancel", "enrich:status", "enrich:audit"];
  ok(want.every((ch) => handlers.has(ch)), `enrich 四通道注册（${want.length}/4）`);
}

// ========== 2) 无 key → 人话拒启（不填 key 零变化：不炸、不静默、指路问一问页） ==========
// 注意：本节必须在 configureLlmConfig 之前跑（模块级状态，配了就全局有 key）
{
  makeDb("nokey.md.db");
  let err = null;
  try { await startEnrich("nokey.md"); } catch (e) { err = e; }
  ok(!!err && /问一问/.test(err.message) && /API key/.test(err.message), `无 key 抛人话错误并指路问一问（${err && err.message.slice(0, 30)}…）`);
  ok(!enrichStatus()["nokey.md"], "无 key 不落任务态（点了也只是提示）");
}

// ========== 10) 外部智能体路：导出任务书（全程无 key——本节在 configureLlmConfig 之前跑） ==========
// 用户不愿交明文 key：洗数据走「导出任务书 → 外部 AI 填 → 导入结果」，与编目同模式。
{
  ok(typeof enrichJobNS.exportEnrichTask === "function", "exportEnrichTask 已导出（外部智能体路入口）");
  if (typeof enrichJobNS.exportEnrichTask === "function") {
    const TASKS = path.join(TMP, "enrich-tasks"); // = LIB/../enrich-tasks，与生产同构
    makeDb("ext.md.db");
    const r = enrichJobNS.exportEnrichTask("ext.md");
    ok(r && r.path === path.join(TASKS, "ext.md.json") && fs.existsSync(r.path),
      "导出任务书落 <书库上级>/enrich-tasks/<id>.json", r && r.path);
    ok(r.chunks === 6 && r.batches >= 1, `导出回执带块数/批数（chunks=${r.chunks} batches=${r.batches}）`);
    const task = JSON.parse(fs.readFileSync(r.path, "utf8"));
    ok(task.book && task.book.content_hash === "hash-aaa" && Array.isArray(task.instructions) && Array.isArray(task.batches),
      "任务书含 book.content_hash / instructions / batches（外部 AI 的契约）");
    ok(typeof r.instructions === "string" && r.instructions.length > 0 && !r.instructions.includes(CHUNKS[0].text),
      "操作说明可复制且不含原文（只给步骤，原文在任务书里）");
    ok(!enrichStatus()["ext.md"], "导出不落任务态（同步操作，不是后台跑批）");
    let err = null;
    try { enrichJobNS.exportEnrichTask("不存在的书"); } catch (e) { err = e; }
    ok(!!err && /找不到/.test(err.message), "导出坏书抛人话错误");
  }
}

// ========== 11) 外部智能体路：导入结果（无 key；裸数组桥接 + 对象直通 + STALE + 人话） ==========
{
  ok(typeof enrichJobNS.importEnrichResult === "function", "importEnrichResult 已导出（外部结果入库入口）");
  if (typeof enrichJobNS.importEnrichResult === "function") {
    // 外部 AI 按任务书 instructions 产的就是裸数组（idx 与块一一对应，标签取自原文前 5 字必回源）
    const bare = CHUNKS.map((c, i) => ({
      idx: i + 1, prefix: `第 ${i + 1} 块前置。`, tags: [c.text.slice(0, 5)],
      questions: ["这块讲了什么"], summary: `第 ${i + 1} 块摘要。`,
    }));
    // 11-1 裸数组 + 选择文件路径 → 桥接成规范产物入库（复用 10 的 ext.md 任务书/库）
    const db = path.join(LIB, "ext.md.db");
    const before = textHash(db);
    const picked = path.join(TMP, "picked-ext.json");
    fs.writeFileSync(picked, JSON.stringify(bare), "utf8");
    const r = enrichJobNS.importEnrichResult("ext.md", picked);
    ok(r && r.ok === true && r.stats && r.stats.imported === 6, `裸数组结果入库 6 条（imported=${r && r.stats && r.stats.imported}）`, r && r.message);
    const row = cell(db, "SELECT ctx, tags, questions FROM chunks WHERE id=1");
    ok(!!row.ctx && JSON.parse(row.tags).length > 0 && JSON.parse(row.questions).length > 0, "裸数组入库后 ctx/tags/questions 三列落值");
    ok(cell(db, "SELECT COUNT(*) c FROM chunk_tags").c === 6, "裸数组入库后 chunk_tags 倒排 6 条");
    ok(textHash(db) === before, "外部结果入库原文一字不改");
    // 桥接产物落规范位（enrich-results/<id>.json），带任务书快照的 book.content_hash
    const art = JSON.parse(fs.readFileSync(path.join(RESULTS, "ext.md.json"), "utf8"));
    ok(Array.isArray(art.entries) && art.entries.length === 6 && art.book && art.book.content_hash === "hash-aaa",
      "裸数组桥接成 {entries,book} 规范产物落 enrich-results（book 取自任务书快照）");
    const audit = enrichAudit("ext.md");
    ok(audit.ready === true && audit.tags.bad === 0 && audit.coverage.pct === 100, `外部路入库后 audit 复查（bad=${audit.tags && audit.tags.bad} pct=${audit.coverage && audit.coverage.pct}）`);
    const b = booksList().find((x) => x.id === "ext.md");
    ok(b && b.enrich && b.enrich.ready === true && b.enrich.pct === 100, "外部路入库后书架摘要挂载（ready/pct）");

    // 11-2 对象直通：外部 AI 直接产 {book,entries} 规范产物 → 原样入库（不需要任务书）
    makeDb("ext2.md.db");
    const wrapped = { version: 1, book: { db: "ext2.md.db", content_hash: "hash-aaa", chunk_count: 6 }, entries: bare };
    const wp = path.join(TMP, "wrapped-ext2.json");
    fs.writeFileSync(wp, JSON.stringify(wrapped), "utf8");
    const r2 = enrichJobNS.importEnrichResult("ext2.md", wp);
    ok(r2 && r2.ok === true && r2.stats.imported === 6, "对象产物直通入库 6 条（无需任务书桥接）");

    // 11-3 STALE：任务书快照 hash-aaa，库重建为 hash-bbb → 桥接产物对不上 → 拒收人话
    makeDb("extstale.md.db");
    enrichJobNS.exportEnrichTask("extstale.md");
    const sp = path.join(TMP, "stale-ext.json");
    fs.writeFileSync(sp, JSON.stringify(bare), "utf8");
    makeDb("extstale.md.db", CHUNKS, { content_hash: "hash-bbb" }); // 同名重建换 hash
    let staleErr = null;
    try { enrichJobNS.importEnrichResult("extstale.md", sp); } catch (e) { staleErr = e; }
    ok(!!staleErr && /重建|作废/.test(staleErr.message), `STALE 拒收且人话带修复指引（${staleErr && staleErr.message.slice(0, 36)}…）`);
    ok(cell(path.join(LIB, "extstale.md.db"), "SELECT COUNT(*) c FROM pragma_table_info('chunks') WHERE name='ctx'").c === 0,
      "STALE 后连 ctx 列都没建（一个字符都不写）");

    // 11-4 人话边界：坏书 / 缺结果文件 / 裸数组但无任务书
    let badErr = null;
    try { enrichJobNS.importEnrichResult("不存在的书", picked); } catch (e) { badErr = e; }
    ok(!!badErr && /找不到/.test(badErr.message), "导入坏书抛人话错误");
    let noFileErr = null;
    try { enrichJobNS.importEnrichResult("ext.md", path.join(TMP, "no-such-result.json")); } catch (e) { noFileErr = e; }
    ok(!!noFileErr && /找不到/.test(noFileErr.message), "缺结果文件抛人话错误（指路选择文件）");
    makeDb("ext3.md.db"); // 没导出任务书
    const np = path.join(TMP, "bare-ext3.json");
    fs.writeFileSync(np, JSON.stringify(bare), "utf8");
    let noTaskErr = null;
    try { enrichJobNS.importEnrichResult("ext3.md", np); } catch (e) { noTaskErr = e; }
    ok(!!noTaskErr && /任务书/.test(noTaskErr.message), "裸数组但无任务书 → 人话指路先导出");
  }
}

// 配一把假 key（plain 模式；userData 指临时目录，不碰真 %APPDATA%）——后面各节都靠它过前置检查
configureLlmConfig({
  userData: path.join(TMP, "userData"),
  available: false,
  encrypt: (s) => Buffer.from(String(s), "utf8"),
  decrypt: (b) => Buffer.from(b).toString("utf8"),
});
fs.mkdirSync(path.join(TMP, "userData"), { recursive: true });
fs.writeFileSync(path.join(TMP, "userData", "llm.json"), JSON.stringify({
  // B2/CP3：地址环回化——非环回 http 会被 loadLlmConfig→normalizeLlmConfig→validateBaseUrl 拒收，
  // job 直接 failed，全流程断言全崩；chatFn 注入不真出网，环回地址仅过校验。
  baseUrl: "http://127.0.0.1:9/v1", model: "fake-model",
  apiKeyEnc: "plain:" + Buffer.from("sk-test", "utf8").toString("base64"),
}), "utf8");

// ========== 3) 全流程：跑批 → 自动入库 → done（假 chat 注入） ==========
{
  const db = makeDb("full.md.db");
  const before = textHash(db);
  const r = await startEnrich("full.md", { chatFn: goodChat });
  ok(r.started === true && r.estimate && r.estimate.calls >= 4, `启动即返回 + 成本预估（约 ${r.estimate && r.estimate.calls} 次云端调用）`);
  const j = await waitTerminal("full.md");
  ok(j.stage === "done", `跑批入库完成进 done 态（detail: ${j.detail}）`);
  ok(j.stats && j.stats.imported === 6 && j.stats.tags > 0, `入库统计（imported=${j.stats && j.stats.imported} tags=${j.stats && j.stats.tags}）`);
  // 库内：三列有值 + 倒排表 + 三级摘要
  const row = cell(db, "SELECT ctx, tags, questions FROM chunks WHERE id=1");
  ok(!!row.ctx && JSON.parse(row.tags).length > 0 && JSON.parse(row.questions).length > 0, "chunks ctx/tags/questions 三列落值");
  ok(cell(db, "SELECT COUNT(*) c FROM chunk_tags").c === 6, "chunk_tags 倒排表（6 块 × 1 标签）");
  const scopes = cell(db, "SELECT COUNT(*) c FROM summaries WHERE scope='chunk'").c;
  ok(scopes === 6, `块摘要 6 条（实际 ${scopes}）`);
  ok(cell(db, "SELECT COUNT(*) c FROM summaries WHERE scope='chapter'").c === 2, "章摘要 2 条（两章）");
  ok(cell(db, "SELECT COUNT(*) c FROM summaries WHERE scope='book'").c === 1, "书摘要 1 条");
  // 产物 + 缓存落盘（与 CLI 同址：LIB/../enrich-results）
  ok(fs.existsSync(path.join(RESULTS, "full.md.json")) && fs.existsSync(path.join(RESULTS, "full.md.jsonl")), "产物 JSON + JSONL 缓存在 <书库上级>/enrich-results");
  // 原文一字不改（跑批+入库全程）
  ok(textHash(db) === before, "原文一字不改（group_concat 前后一致）");
  // 库侧复查（audit 通道同款函数）：回源 0 坏、覆盖 100%
  const audit = enrichAudit("full.md");
  ok(audit.ready === true && audit.tags.bad === 0 && audit.coverage.pct === 100, `audit 复查（bad=${audit.tags && audit.tags.bad} pct=${audit.coverage && audit.coverage.pct}）`);
  // 书架摘要挂载（engine.booksList）
  const b = booksList().find((x) => x.id === "full.md");
  ok(b && b.enrich && b.enrich.ready === true && b.enrich.pct === 100 && b.enrich.tags === 6, `书架摘要（pct=${b && b.enrich && b.enrich.pct} tags=${b && b.enrich && b.enrich.tags}）`);
  // 状态出海可序列化（IPC 事件要过结构化克隆；带函数/循环会炸——JSON 往返是等效探针）
  let cloned = true;
  try { JSON.parse(JSON.stringify(enrichStatus())); } catch { cloned = false; }
  ok(cloned, "enrichStatus 出海可序列化（无函数/循环引用）");
}

// ========== 4) 取消闸门：第二批起不再发云端请求 → cancelled 态 ==========
{
  makeDb("cancel.md.db");
  const chat = fakeChat((req, n) => {
    if (n === 2) cancelEnrich("cancel.md"); // 第二批回来时取消 → 第三批（章摘要）被闸门拦
    return goodChatHandler(req);
  });
  function goodChatHandler(req) {
    const sys = req.messages[0].content;
    if (sys.includes("章节摘要")) return chaptersOf(req).map((ch) => ({ chapter: ch, summary: "章摘要" }));
    if (sys.includes("全书摘要")) return "全书摘要";
    return idxsOf(req).map((i) => ({ idx: i, prefix: "前置", tags: ["断路器"], questions: [], summary: "摘要" }));
  }
  await startEnrich("cancel.md", { chatFn: chat });
  const j = await waitTerminal("cancel.md");
  ok(j.stage === "cancelled", "取消后落 cancelled 态（不是 failed）");
  ok(chat.calls.length === 2, `闸门生效：只发了 ${chat.calls.length} 次云端请求（第二批后全拦）`);
  const jsonl = fs.readFileSync(path.join(RESULTS, "cancel.md.jsonl"), "utf8");
  ok(/"t":"ok"/.test(jsonl), "已洗好的批在 JSONL 缓存里（重跑接着来）");
  ok(!enrichStatus()["cancel.md"], "cancelled 从注册表撤掉（不留完成态残影）");
}

// ========== 5) STALE：书被重建过（content_hash 变）→ 拒洗并说人话 ==========
{
  makeDb("stale.md.db");           // 先建库（hash-aaa）
  await startEnrich("stale.md", { chatFn: goodChat });
  await waitTerminal("stale.md");  // 写完缓存（meta hash-aaa）
  makeDb("stale.md.db", CHUNKS, { content_hash: "hash-bbb" }); // 同名重建换 hash
  await startEnrich("stale.md", { chatFn: goodChat });
  const j = await waitTerminal("stale.md");
  ok(j.stage === "failed" && /移走/.test(j.error || ""), `STALE 拒洗且消息带修复指引（${(j.error || "").slice(0, 40)}…）`);
}

// ========== 6) BSP_SUMMARY=0：只洗块不产章/书摘要 ==========
{
  const prev = process.env.BSP_SUMMARY;
  process.env.BSP_SUMMARY = "0";
  try {
    makeDb("nosum.md.db");
    await startEnrich("nosum.md", { chatFn: goodChat });
    const j = await waitTerminal("nosum.md");
    ok(j.stage === "done", "BSP_SUMMARY=0 仍能洗完块");
    const art = JSON.parse(fs.readFileSync(path.join(RESULTS, "nosum.md.json"), "utf8"));
    ok(!art.chapter_summaries && !art.book_summary, "产物无章/书摘要（开关生效）");
    ok(cell(path.join(LIB, "nosum.md.db"), "SELECT COUNT(*) c FROM summaries").c === 6, "库内只有块摘要 6 条");
  } finally { if (prev === undefined) delete process.env.BSP_SUMMARY; else process.env.BSP_SUMMARY = prev; }
}

// ========== 7) 断点续跑：全覆盖后再洗 → 零云端调用（+ 入库幂等） ==========
{
  // 复用 6 的库（已全覆盖）；BSP_SUMMARY=0 隔离摘要调用，专测块批缓存
  const prev = process.env.BSP_SUMMARY;
  process.env.BSP_SUMMARY = "0";
  try {
    const counter = fakeChat(() => ({ ok: false, code: "SHOULD_NOT_HAPPEN", message: "不该调用" }));
    await startEnrich("nosum.md", { chatFn: counter });
    const j = await waitTerminal("nosum.md");
    ok(j.stage === "done" && counter.calls.length === 0, `全覆盖续跑零云端调用（实际 ${counter.calls.length} 次）`);
    ok(cell(path.join(LIB, "nosum.md.db"), "SELECT COUNT(*) c FROM chunk_tags").c === 6, "重复入库幂等（倒排不翻倍）");
  } finally { if (prev === undefined) delete process.env.BSP_SUMMARY; else process.env.BSP_SUMMARY = prev; }
}

// ========== 8) 边界：坏书 / 无任务取消 / IPC 错误包装 ==========
{
  let err = null;
  try { await startEnrich("不存在的书"); } catch (e) { err = e; }
  ok(!!err && /找不到/.test(err.message), "坏书名抛人话错误");
  const c = cancelEnrich("不存在的书");
  ok(c.cancelled === false && /没有进行中/.test(c.note), "无任务取消返回说明（不炸）");
  let auditErr = null;
  try { enrichAudit("不存在的书"); } catch (e) { auditErr = e; }
  ok(!!auditErr && /找不到/.test(auditErr.message), "audit 坏书抛人话错误（IPC 包装成 {ok:false}，UI toast）");
  // IPC 包装：坏书名走 {ok:false} 不崩（M3）
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  await registerIpc({ ipcMain, app: { isPackaged: false, getPath: () => null }, dialog: { showOpenDialog: async () => ({ canceled: true }) }, shell: { openPath: async () => "" }, getWin: () => null });
  const r = await handlers.get("enrich:start")({}, "不存在的书");
  ok(r.ok === false && r.error.code === "user", "IPC 层错误包装 {ok:false,error}（M3）");
}

// ========== 9) P4：闸门 warn 进 done detail / block 落 failed / DIRTY 标签 ==========
{
  // 9-1 warn：env 把黄线抬到 1.5（全量产物也被判 warn——生产里 warn 来自外部产物/部分覆盖，
  // 这里用 env 强制走 warn 分支锁接线）→ done 态 detail 带「闸门标记」，书架摘要带 enrichGate=warn
  const db = makeDb("warn.md.db");
  process.env.BSP_GATE_COVERAGE_WARN = "1.5";
  try {
    await startEnrich("warn.md", { chatFn: goodChat });
    const j = await waitTerminal("warn.md");
    ok(j.stage === "done", `warn 不拦入库——照样 done（detail: ${j.detail}）`);
    ok(j.gate && j.gate.verdict === "warn", "warn 的 gate 随终态出海", JSON.stringify(j.gate));
    ok(/闸门标记：覆盖 100%（部分覆盖）/.test(j.detail || ""), "warn 进 done detail（用户看得见）", j.detail);
    const g = JSON.parse(cell(db, "SELECT value FROM meta WHERE key='enrich_gate'").value);
    ok(g.verdict === "warn", "meta.enrich_gate 落 warn", JSON.stringify(g));
    const b = booksList().find((x) => x.id === "warn.md");
    ok(b && b.enrich && b.enrich.enrichGate === "warn", "书架摘要带 enrichGate=warn（徽标数据源）", JSON.stringify(b?.enrich));
  } finally { delete process.env.BSP_GATE_COVERAGE_WARN; }
}
{
  // 9-2 block：env 把硬线抬到 1.5（全量产物也被硬线拦）→ failed 态 + 人话 + DB 零印记
  const db = makeDb("gate.md.db");
  process.env.BSP_GATE_COVERAGE_HARD = "1.5";
  try {
    await startEnrich("gate.md", { chatFn: goodChat });
    const j = await waitTerminal("gate.md");
    ok(j.stage === "failed" && j.code === "GATE", `GATE block 落 failed 态（code=${j.code}）`);
    ok(j.label === "入库被拦（质量闸门）", "GATE 单给标签「入库被拦（质量闸门）」", j.label);
    ok(/闸门|重跑/.test(j.error || ""), "GATE 错误消息是人话且带补救", (j.error || "").slice(0, 60));
    ok(!cell(db, "SELECT value FROM meta WHERE key='enrich_gate'"), "block 后 meta 无 enrich_gate（没写成已完成）");
    ok(cell(db, "SELECT COUNT(*) c FROM pragma_table_info('chunks') WHERE name='ctx'").c === 0,
      "block 后 ctx 列都没建（事务前判定）");
    const b = booksList().find((x) => x.id === "gate.md");
    ok(b && b.enrich && b.enrich.ready === false, "block 后书架显示未洗（无半成品印记）");
  } finally { delete process.env.BSP_GATE_COVERAGE_HARD; }
}
{
  // 9-3 DIRTY：1/6 合格块带控制符 → 拒洗落 failed，标签说「书太脏」，零云端调用
  const dirty = CHUNKS.map((c, i) => (i === 1
    ? { chapter: c.chapter, text: "控制符块：" + "\u0001\u0002".repeat(10) + "正文内容继续写下去凑够四十个字符的长度要求。" }
    : c));
  const db = makeDb("dirty.md.db", dirty);
  const chat = fakeChat(goodChat);
  await startEnrich("dirty.md", { chatFn: chat });
  const j = await waitTerminal("dirty.md");
  ok(j.stage === "failed" && j.code === "DIRTY", `DIRTY 落 failed 态（code=${j.code}）`);
  ok(j.label === "洗数据被拒（书太脏）", "DIRTY 单给标签「洗数据被拒（书太脏）」", j.label);
  ok(/重新加工/.test(j.error || ""), "DIRTY 消息带补救（结构化改造）", (j.error || "").slice(0, 50));
  ok(chat.calls.length === 0, "DIRTY 零云端请求（体检在调用前）");
  ok(!fs.existsSync(path.join(RESULTS, "dirty.md.jsonl")), "DIRTY 连缓存都没建");
  ok(cell(db, "SELECT COUNT(*) c FROM pragma_table_info('chunks') WHERE name='ctx'").c === 0,
    "DIRTY 后库里连 ctx 列都没建（体检在写任何东西之前）");
}

// ---------- 收尾 ----------
console.log(`\n===== enrich-job-test: ${pass} PASS / ${fail} FAIL =====`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
