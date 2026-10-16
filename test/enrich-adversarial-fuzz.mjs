// enrich 链路对抗 fuzz（V3 两波全量检查·标准轮）：CLI 契约 / JSONL 中断矩阵 / 坏产物矩阵 /
// 指纹与 DBBROKEN / 桌面层守卫与取消 / chatFn 抛异常与库层容错。
// 自包含：tmp 目录 + 假 chat 注入 + 合成夹具，不碰 library/ 真库、不连网、不加载模型。
// 跑法: node test/enrich-adversarial-fuzz.mjs
// 性质：对抗套件——部分用例在当前代码上为红（坐实缺陷），修复后全绿；结论以发现清单为准。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

import { runEnrich, loadEnrichCache, buildEnrichTaskFile, enrichResultPath } from "../src/lib/enrich.mjs";
import { importEnrich } from "../src/lib/enrich-import.mjs";
import { startEnrich, cancelEnrich, enrichStatus, enrichAudit, onEnrichProgress } from "../src/desktop/enrich-job.mjs";
import { configureSearch } from "../src/lib/search.mjs";
import { configureLlmConfig } from "../src/desktop/llm-config.mjs";

let pass = 0, fail = 0, obs = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log(`PASS - ${name}`); }
  else { fail++; console.log(`FAIL - ${name} ${extra}`); }
};
const observe = (cond, name, note = "") => {
  if (cond) { pass++; console.log(`OBSERVE - ${name} | ${note}`); }
  else { fail++; console.log(`FAIL - ${name}（OBSERVE 条件不成立） ${note}`); }
};

// ---------- 夹具 ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-enrich-adv-"));
const LIB = path.join(TMP, "library");
const RESULTS = path.join(TMP, "enrich-results"); // 与 LIB 平级=书库上级，桌面/CLI 同构
fs.mkdirSync(LIB, { recursive: true });
configureSearch({ libDir: LIB });
// 配一把假 key（plain 模式，userData 指临时目录，不碰真 %APPDATA%）
configureLlmConfig({
  userData: path.join(TMP, "userData"),
  available: false,
  encrypt: (s) => Buffer.from(String(s), "utf8"),
  decrypt: (b) => Buffer.from(b).toString("utf8"),
});
fs.mkdirSync(path.join(TMP, "userData"), { recursive: true });
fs.writeFileSync(path.join(TMP, "userData", "llm.json"), JSON.stringify({
  baseUrl: "http://fake.local/v1", model: "fake-model",
  apiKeyEnc: "plain:" + Buffer.from("sk-test", "utf8").toString("base64"),
}), "utf8");

const CH = [
  { chapter: "第1章", text: "熔断器是一种保护电器，当电流超过额定值时自动切断电路，防止设备烧毁。断路器则兼有开关作用，两者常配合使用。" },
  { chapter: "第1章", text: "低压电器的符号在图纸上用特定图形表示，交流接触器的主触点绘制成常开触点形式，便于工程识图与施工。" },
  { chapter: "第1章", text: "热继电器利用电流的热效应动作，双金属片受热弯曲推动触点，用于电动机的过载保护场合，整定电流可调。" },
  { chapter: "第2章", text: "异步电动机的转子分为笼型与绕线型两类，笼型结构简单可靠，绕线型可在起动时串入电阻改善性能。" },
  { chapter: "第2章", text: "电动机的额定电压指线电压，接线时应核对铭牌标注，星形与三角形接法不可随意混用以免烧毁绕组。" },
  { chapter: "第2章", text: "变频器通过改变电源频率调节电动机转速，调速范围宽且节能，已在风机水泵类负载中广泛替代阀门节流。" },
];

function makeDb(name, chunks = CH, meta = {}) {
  const p = path.join(LIB, name);
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(p + suffix, { force: true });
  const db = new Database(p);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT NOT NULL);`);
  const ins = db.prepare("INSERT INTO chunks(chapter,page,text) VALUES (?,?,?)");
  for (const c of chunks) ins.run(c.chapter, null, c.text);
  const sm = db.prepare("INSERT INTO meta(key,value) VALUES (?,?)");
  for (const [k, v] of Object.entries({ title: name.replace(/\.db$/, ""), content_hash: "hash-" + name, format: "md", ...meta })) sm.run(k, String(v));
  db.close();
  return p;
}
function makeRawDb(name, sql) { // 任意 schema 的库（造缺表/不兼容表场景）
  const p = path.join(TMP, name);
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(p + suffix, { force: true });
  const db = new Database(p);
  if (sql) db.exec(sql);
  db.close();
  return p;
}
const cell = (dbPath, sql, ...args) => { const db = new Database(dbPath, { readonly: true }); try { return db.prepare(sql).get(...args); } finally { db.close(); } };

function fakeChat(handler) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    const out = await handler(req, calls.length); // 必须 await：延迟/挂起型 handler 才有语义（否则 Promise 被 stringify 成 "{}"）
    if (out && typeof out === "object" && out.ok === false) return out;
    return { ok: true, text: typeof out === "string" ? out : JSON.stringify(out), usage: { prompt_tokens: 100, completion_tokens: 50 } };
  };
  fn.calls = calls;
  return fn;
}
const idxsOf = (req) => [...req.messages[1].content.matchAll(/\[idx (\d+)\]/g)].map((m) => +m[1]);
const chaptersOf = (req) => [...new Set([...req.messages[1].content.matchAll(/【(.+?)】/g)].map((m) => m[1]))];
const blocksOf = (req) => {
  const out = new Map();
  const re = /\[idx (\d+)\](?:《[^》]*》)?\n([\s\S]*?)(?=\n\n\[idx \d+\]|$)/g;
  let m;
  while ((m = re.exec(req.messages[1].content))) out.set(+m[1], m[2].trim());
  return out;
};
// 标准好响应（handler 抽出——调用数敏感的用例必须各用独立 fakeChat 实例，共享实例 calls 会累积）
const goodHandler = (req) => {
  const sys = req.messages[0].content;
  if (sys.includes("章节摘要")) return chaptersOf(req).map((ch) => ({ chapter: ch, summary: "章摘要：" + ch }));
  if (sys.includes("全书摘要")) return "全书摘要：低压电器与电动机的基础知识。";
  const blocks = blocksOf(req);
  return idxsOf(req).map((i) => ({ idx: i, prefix: `第 ${i} 块的前置。`, tags: [(blocks.get(i) || "块").slice(0, 5)], questions: ["这块讲了什么"], summary: `第 ${i} 块摘要。` }));
};
const goodChat = fakeChat(goodHandler);

const CFG = { baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-test", model: "m" };
const cli = (args, opts = {}) => {
  try {
    const out = execFileSync(process.execPath, args, { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"], ...opts });
    return { code: 0, out, err: "" };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? ""), err: String(e.stderr ?? "") };
  }
};
const PROJ = path.resolve(import.meta.dirname, "..");

console.log("===== W0 CLI 契约（V3R-D01/D02/D03/D04/D05/D06/D07）=====");

// W0-1：带值 flag 不再被当书路径（致命 D01）——好库 + --batch 5 应正常导任务书
{
  const db = makeDb("cli1.db");
  const r = cli([path.join(PROJ, "src/enrich-book.mjs"), db, "--export", "--batch", "5"], { env: { ...process.env, BSP_USER_DATA: TMP } });
  ok(r.code === 0 && r.out.includes("批") && !r.err.includes("找不到"), "W0-1 带值 flag 解析（--batch 5 不当书路径）", `code=${r.code} err=${r.err.slice(0, 120)}`);
}

// W0-2：无 key 指引路里的 --base/--key/--model 组合必须能走到「没有 key」而不是「找不到 URL」
{
  const db = makeDb("cli2.db");
  const r = cli([path.join(PROJ, "src/enrich-book.mjs"), db, "--export", "--base", "https://api.deepseek.com/v1", "--key", "sk-x", "--model", "deepseek-chat"], { env: { ...process.env, BSP_USER_DATA: path.join(TMP, "empty-ud"), BSP_LLM_KEY: "" } });
  ok(!/找不到 (https?:|\S*sk-|deepseek)/.test(r.err), "W0-2 --base/--key/--model 值不被当书路径", `err=${r.err.slice(0, 160)}`);
}

// W0-3：无 chunks 表的库 → 人话拒绝，非英文堆栈（严重 D02/D03/D06）
{
  const raw = makeRawDb("nochunks.db", "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);");
  const r = cli([path.join(PROJ, "src/enrich-book.mjs"), raw, "--export"], { env: { ...process.env, BSP_USER_DATA: TMP } });
  ok(r.code === 1 && /书库|读不了|chunks/.test(r.err) && !/SqliteError|at \w+ \(/.test(r.err), "W0-3 缺 chunks 表库走人话拒绝", `code=${r.code} err=${r.err.slice(0, 160)}`);
}

// W0-4：垃圾文件库 → 人话拒绝（严重 D06/D07）
{
  const p = path.join(TMP, "garbage.db");
  fs.writeFileSync(p, "我不是数据库".repeat(50));
  const r = cli([path.join(PROJ, "src/enrich-book.mjs"), p, "--export"], { env: { ...process.env, BSP_USER_DATA: TMP } });
  ok(r.code === 1 && !/SqliteError|at \w+ \(/.test(r.err), "W0-4 垃圾文件库走人话拒绝", `code=${r.code} err=${r.err.slice(0, 160)}`);
}

// W0-5：importEnrich CLI 对坏产物/坏库不裸奔（严重 D05）
{
  const r = cli([path.join(PROJ, "src/enrich-import.mjs"), path.join(TMP, "none.json")], { env: { ...process.env } });
  ok(r.code === 1 && !/at \w+ \(/.test(r.err), "W0-5 入库 CLI 坏路径人话", `code=${r.code} err=${r.err.slice(0, 160)}`);
}

// W0-6：--min-chars 非数字 → 人话拒绝（轻微 D25）
{
  const db = makeDb("cli6.db");
  fs.writeFileSync(path.join(TMP, "art6.json"), JSON.stringify({ book: { content_hash: "hash-cli6.db" }, entries: [] }));
  const r = cli([path.join(PROJ, "src/enrich-import.mjs"), db, path.join(TMP, "art6.json"), "--min-chars", "abc"], { env: { ...process.env } });
  ok(r.code === 1 && !/NaN/.test(r.out + r.err), "W0-6 --min-chars=abc 人话拒绝", `code=${r.code} err=${r.err.slice(0, 120)}`);
}

console.log("\n===== W1 JSONL 中断矩阵（V3R-D09 + 断点续跑）=====");

const writeJsonl = (p, lines) => fs.writeFileSync(p, lines.join("\n") + "\n", "utf8");

// W1-1：半行损坏（崩溃写入中）→ 跳过且好行全收
{
  const jp = path.join(TMP, "w1-1.jsonl");
  writeJsonl(jp, [
    JSON.stringify({ t: "meta", db: "w1-1.db", content_hash: "h1", at: "t0" }),
    JSON.stringify({ t: "ok", idxs: [1, 2], entries: [{ idx: 1, prefix: "p1", tags: [], questions: [] }, { idx: 2, prefix: "p2", tags: [], questions: [] }], at: "t1" }),
    '{"t":"ok","ent', // 半行
    JSON.stringify({ t: "fail", idxs: [5, 6], code: "HTTP", at: "t3" }),
  ]);
  const c = loadEnrichCache(jp, "h1");
  ok(c.entries.size === 2 && c.failedBatches.length === 1 && !c.stale, "W1-1 半行损坏跳过+好行全收", JSON.stringify([...c.entries.keys()]));
}

// W1-2：形状异常行不穿层（一般 D09——当前代码为红）
{
  const jp = path.join(TMP, "w1-2.jsonl");
  writeJsonl(jp, [
    JSON.stringify({ t: "meta", db: "w1-2.db", content_hash: "h2", at: "t0" }),
    "null",
    JSON.stringify({ t: "ok", idxs: [1], entries: null, at: "t1" }),
    JSON.stringify({ t: "fail", at: "t2" }), // 缺 idxs
    JSON.stringify({ t: "ok", idxs: [3], entries: [{ idx: 3, prefix: "p3", tags: [], questions: [] }], at: "t3" }),
  ]);
  let threw = null, c = null;
  try { c = loadEnrichCache(jp, "h2"); } catch (e) { threw = e; }
  ok(!threw && c && c.entries.size === 1, "W1-2 形状异常行（null/entries:null/缺idxs）不抛", threw ? String(threw).slice(0, 100) : "");
}

// W1-3：meta 行损坏 → hash 丢失 → stale 不误判（无 hash 时不拒跑）
{
  const jp = path.join(TMP, "w1-3.jsonl");
  writeJsonl(jp, [JSON.stringify({ t: "ok", idxs: [1], entries: [{ idx: 1, prefix: "p", tags: [], questions: [] }], at: "t1" })]);
  const c = loadEnrichCache(jp, "whatever");
  ok(!c.stale && c.entries.size === 1, "W1-3 无 meta 行不误判 stale", "");
}

// W1-4：双 meta 行 → 末条覆盖（重跑批追加新 meta 的场景）
{
  const jp = path.join(TMP, "w1-4.jsonl");
  writeJsonl(jp, [
    JSON.stringify({ t: "meta", db: "w1-4.db", content_hash: "old", at: "t0" }),
    JSON.stringify({ t: "meta", db: "w1-4.db", content_hash: "new", at: "t1" }),
  ]);
  const c = loadEnrichCache(jp, "new");
  ok(!c.stale, "W1-4 双 meta 末条覆盖", "");
}

// W1-5：runEnrich 续跑只补缺批不双调（首批 ok 缓存后二次跑零调用）——独立 chat 实例数调用
{
  const db = makeDb("w1-5.db");
  const chat1 = fakeChat(goodHandler);
  const r1 = await runEnrich(db, { config: CFG, chatFn: chat1, resultsDir: RESULTS, summaries: false });
  const n1 = chat1.calls.length;
  const chat2 = fakeChat(goodHandler);
  const r2 = await runEnrich(db, { config: CFG, chatFn: chat2, resultsDir: RESULTS, summaries: false });
  ok(r1.ok && r2.ok && n1 === 2 && chat2.calls.length === 0, "W1-5 全覆盖后续跑零调用", `n1=${n1} n2=${chat2.calls.length}`);
}

// W1-6：kill -9 真中断后续跑——缓存可续、不双调（单发；Windows SIGKILL 不稳则登记）
{
  const db = makeDb("w1-6.db");
  const jp = enrichResultPath(RESULTS, "w1-6.db");
  const helper = `
    import { pathToFileURL } from "node:url";
    const { runEnrich } = await import(pathToFileURL(${JSON.stringify(path.join(PROJ, "src/lib/enrich.mjs"))}).href);
    let n = 0;
    const chat = async () => { n++; if (n >= 2) return new Promise(() => {}); return { ok: true, text: JSON.stringify([{ idx: 1, prefix: "第一批", tags: ["熔断器"], questions: ["q"], summary: "s" }]) }; };
    setInterval(() => {}, 1000); // 保活：挂起的 promise 不阻止 node 在空事件循环下自然退出（必须在 await 前启动）
    await runEnrich(${JSON.stringify(db)}, { config: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-test", model: "m" }, chatFn: chat, resultsDir: ${JSON.stringify(RESULTS)}, summaries: false, batchSize: 1 });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", helper], { stdio: "ignore" });
  // 等首批落盘 + 第二批在途（批 2 的 chat 永不 resolve，子进程会挂住）
  const t1 = Date.now();
  while (Date.now() - t1 < 8000 && child.exitCode === null && !(fs.existsSync(jp) && fs.readFileSync(jp, "utf8").includes('"t":"ok"'))) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 300));
  const aliveBefore = child.exitCode === null;
  child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  const hasCache = fs.existsSync(jp) && fs.readFileSync(jp, "utf8").includes('"t":"ok"');
  const chat3 = fakeChat((req) => idxsOf(req).map((i) => ({ idx: i, prefix: "p" + i, tags: [(blocksOf(req).get(i) || "块").slice(0, 5)], questions: ["q"], summary: "s" })));
  const r3 = await runEnrich(db, { config: CFG, chatFn: chat3, resultsDir: RESULTS, summaries: false, batchSize: 1 });
  // 续跑是批级：首批（idx1）的 ok 记录在缓存里 → 重跑从 idx2 起，6 块只需 5 批
  const firstBatch = chat3.calls.length > 0 ? idxsOf(chat3.calls[0]) : [];
  observe(aliveBefore && hasCache && r3.ok && chat3.calls.length === 5 && firstBatch[0] === 2,
    "W1-6 kill -9 真中断后续跑不双调（首批走缓存，从 idx2 续）",
    `alive=${aliveBefore} cache=${hasCache} ok=${r3.ok} calls=${chat3.calls.length} 首批=${firstBatch.join(",")}`);
}

console.log("\n===== W2 坏产物矩阵（G1 ③④⑤）=====");

const SYN_ENTRIES = CH.map((c, i) => ({ idx: i + 1, prefix: `第 ${i + 1} 块前置。`, tags: [c.text.slice(0, 5)], questions: ["这块讲了什么"], summary: `第 ${i + 1} 块摘要。` }));
const synArtifact = (over = {}) => ({
  version: 1,
  book: { db: "w2.db", title: "w2", content_hash: "hash-w2.db", chunk_count: 6 },
  stats: {}, entries: SYN_ENTRIES, failed_batches: [],
  updated_at: "2026-10-16T00:00:00.000Z",
  chapter_summaries: { "第1章": "低压电器三事。", "第2章": "电动机三事。" },
  book_summary: "全书：低压电器与电动机基础知识。",
  ...over,
});

// W2 系列统一 hash（makeDb 默认 hash 随库名变，artifact 固定 hash-w2.db，不统一会踩 STALE）
const w2db = (name) => makeDb(name, CH, { content_hash: "hash-w2.db" });

// W2-1：idx 非整数（"1"/1.5/null）→ 验真记错 + 不入库该条（G1④）
{
  const db = w2db("w2-1.db");
  const art = synArtifact({ entries: [...SYN_ENTRIES, { idx: "1", prefix: "x", tags: [], questions: [] }, { idx: 2.5, prefix: "y", tags: [], questions: [] }, { idx: null, prefix: "z", tags: [], questions: [] }] });
  const ap = path.join(TMP, "w2-1.json"); fs.writeFileSync(ap, JSON.stringify(art));
  const r = importEnrich(db, ap);
  ok(r.ok && r.warnings.length > 0 && r.stats.imported === 6, "W2-1 idx 非整数被验真丢弃并警告", JSON.stringify(r.warnings).slice(0, 120));
}

// W2-2：artifact 缺 content_hash → 三条件放行（设计行为，G1⑤）
{
  const db = w2db("w2-2.db");
  const art = synArtifact(); delete art.book.content_hash;
  const ap = path.join(TMP, "w2-2.json"); fs.writeFileSync(ap, JSON.stringify(art));
  const r = importEnrich(db, ap);
  ok(r.ok && r.code === "OK" && r.stats.imported === 6, "W2-2 缺 content_hash 放行入库（设计行为）", r.message);
}

// W2-3：章摘要 400 字→库内 300；书摘要 600 字→库内 500（G1③）
{
  const db = w2db("w2-3.db");
  const art = synArtifact({ chapter_summaries: { "第1章": "章".repeat(400), "第2章": "电动机。" }, book_summary: "书".repeat(600) });
  const ap = path.join(TMP, "w2-3.json"); fs.writeFileSync(ap, JSON.stringify(art));
  const r = importEnrich(db, ap);
  const ch1 = cell(db, "SELECT summary s FROM summaries WHERE scope='chapter' AND ref='第1章'").s;
  const bk = cell(db, "SELECT summary s FROM summaries WHERE scope='book'").s;
  ok(r.ok && ch1.length === 300 && bk.length === 500, "W2-3 摘要截断（章 300/书 500）", `ch=${ch1.length} book=${bk.length}`);
}

// W2-4：entries 非数组 → BADFILE
{
  const db = w2db("w2-4.db");
  const ap = path.join(TMP, "w2-4.json"); fs.writeFileSync(ap, JSON.stringify(synArtifact({ entries: "not-array" })));
  const r = importEnrich(db, ap);
  ok(!r.ok && r.code === "BADFILE", "W2-4 entries 非数组拒收", r.message);
}

// W2-5：chapter_summaries 值为对象 → String() 兜底不崩
{
  const db = w2db("w2-5.db");
  const art = synArtifact({ chapter_summaries: { "第1章": { nested: true }, "第2章": "电动机。" } });
  const ap = path.join(TMP, "w2-5.json"); fs.writeFileSync(ap, JSON.stringify(art));
  const r = importEnrich(db, ap);
  const ch1 = cell(db, "SELECT summary s FROM summaries WHERE scope='chapter' AND ref='第1章'").s;
  ok(r.ok && typeof ch1 === "string" && ch1.length > 0, "W2-5 章摘要值为对象 String() 兜底不崩", String(ch1).slice(0, 60));
}

// W2-6：PARTIAL 后 failed_batches 与 JSONL fail 一一对应
{
  const db = w2db("w2-6.db");
  const half = fakeChat((req, n) => (n === 2 ? { ok: false } : idxsOf(req).map((i) => ({ idx: i, prefix: "p" + i, tags: [(blocksOf(req).get(i) || "块").slice(0, 5)], questions: ["q"], summary: "s" }))));
  const r = await runEnrich(db, { config: CFG, chatFn: half, resultsDir: RESULTS, summaries: false, batchSize: 3 });
  const art = JSON.parse(fs.readFileSync(r.artifactPath, "utf8"));
  const jp = enrichResultPath(RESULTS, "w2-6.db");
  const fails = fs.readFileSync(jp, "utf8").split(/\r?\n/).filter((l) => l.trim() && JSON.parse(l).t === "fail").length;
  ok(!r.ok && r.code === "PARTIAL" && Array.isArray(art.failed_batches) && art.failed_batches.length === fails && fails === 1,
    "W2-6 PARTIAL 的 failed_batches 与 JSONL fail 对应", `code=${r.code} art=${art.failed_batches.length} jsonl=${fails}`);
}

console.log("\n===== W3 指纹与 DBBROKEN（V3R-D02/D04+D06）=====");

// W3-1：trigger 篡改 text → 不抛穿层 + 既定契约 + 回滚后零写入（严重 D04）
{
  const db = makeDb("w3-1.db");
  const art = synArtifact({ book: { db: "w3-1.db", title: "w3-1", content_hash: "hash-w3-1.db", chunk_count: 6 } });
  const ap = path.join(TMP, "w3-1.json"); fs.writeFileSync(ap, JSON.stringify(art));
  const dbw = new Database(db);
  dbw.exec(`CREATE TRIGGER tamper BEFORE UPDATE ON chunks BEGIN UPDATE chunks SET text='篡改' WHERE id=NEW.id; END`);
  dbw.close();
  let threw = null, r = null;
  try { r = importEnrich(db, ap); } catch (e) { threw = e; }
  const ctxAfter = cell(db, "SELECT COUNT(*) c FROM chunks WHERE ctx IS NOT NULL").c;
  const schemaBuilt = !!cell(db, "SELECT name n FROM sqlite_master WHERE type='table' AND name='chunk_tags'").n;
  ok(!threw && r && r.ok === false && ctxAfter === 0,
    "W3-1 指纹不符：不抛穿层 + 回滚后 ctx 全 NULL", threw ? `抛了: ${String(threw).slice(0, 120)}` : `ok=${r?.ok} ctx=${ctxAfter} schema=${schemaBuilt}`);
}

// W3-2：预置不兼容 summaries 表 → {ok:false} 人话而非 SqliteError 穿层（严重 D04 逃逸通道）
{
  const db = makeRawDb("w3-2.db", `CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT NOT NULL);
    CREATE TABLE summaries(scope TEXT, ref TEXT);`);
  const dbw = new Database(db);
  dbw.prepare("INSERT INTO chunks(chapter,text) VALUES ('第1章','熔断器是一种保护电器，当电流超过额定值时自动切断电路，防止设备烧毁。')").run();
  dbw.prepare("INSERT INTO meta(key,value) VALUES('content_hash','hash-w3-2.db')").run();
  dbw.close();
  const art = synArtifact({ book: { db: "w3-2.db", title: "w3-2", content_hash: "hash-w3-2.db", chunk_count: 1 } });
  const ap = path.join(TMP, "w3-2.json"); fs.writeFileSync(ap, JSON.stringify(art));
  let threw = null, r = null;
  try { r = importEnrich(db, ap); } catch (e) { threw = e; }
  ok(!threw && r && r.ok === false, "W3-2 tx 内 SqliteError 转 {ok:false} 不穿层", threw ? `抛了: ${String(threw).slice(0, 120)}` : r?.message);
}

// W3-3：fill 0x58 坏文件 → DBBROKEN（G1②）
{
  const p = path.join(TMP, "w3-3.db");
  fs.writeFileSync(p, Buffer.alloc(40960, 0x58));
  const r = importEnrich(p, path.join(TMP, "w2-2.json"));
  ok(!r.ok && r.code === "DBBROKEN", "W3-3 页损坏库 DBBROKEN", r.message);
}

// W3-4：无 chunks 表 → DBBROKEN（两条路径都收）
{
  const raw = makeRawDb("w3-4.db", "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);");
  const r = importEnrich(raw, path.join(TMP, "w2-2.json"));
  ok(!r.ok && r.code === "DBBROKEN", "W3-4 缺 chunks 表 DBBROKEN", r.message);
}

// W3-5：runEnrich 对无 chunks 表库 → DBBROKEN 不抛（严重 D02）
{
  const raw = makeRawDb("w3-5.db", "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);");
  let threw = null, r = null;
  try { r = await runEnrich(raw, { config: CFG, chatFn: goodChat, resultsDir: RESULTS, summaries: false }); } catch (e) { threw = e; }
  ok(!threw && r && r.ok === false && r.code === "DBBROKEN", "W3-5 runEnrich 缺 chunks 表返回 DBBROKEN", threw ? `抛了: ${String(threw).slice(0, 100)}` : r?.code);
}

// W3-6：buildEnrichTaskFile 对坏库 → {error,hint} 不抛（严重 D06）
{
  const p = path.join(TMP, "w3-6.db");
  fs.writeFileSync(p, "我不是数据库".repeat(50));
  let threw = null, r = null;
  try { r = buildEnrichTaskFile(p, path.join(TMP, "tasks")); } catch (e) { threw = e; }
  ok(!threw && r && r.error, "W3-6 buildEnrichTaskFile 坏库返回 {error,hint}", threw ? `抛了: ${String(threw).slice(0, 100)}` : JSON.stringify(r).slice(0, 100));
}

console.log("\n===== W4 桌面层守卫与取消（G3 六条）=====");

// W4-1：并发启动二次调用 → UserError「正在洗数据中」（挂起 chat 制造在途）
{
  makeDb("w4-1.db");
  const hang = fakeChat(() => new Promise(() => {}));
  const first = await startEnrich("w4-1", { chatFn: hang });
  let e2 = null;
  try { await startEnrich("w4-1", { chatFn: hang }); } catch (e) { e2 = e; }
  cancelEnrich("w4-1");
  await new Promise((r) => setTimeout(r, 200));
  ok(first.started && e2 && /正在洗数据中/.test(e2.message), "W4-1 同书并发启动被拒（人话）", e2 ? e2.message : "没抛");
}

// W4-2：导入中守卫（同书导入时拒洗）——jobs 注册表无注入 API，真实集成需加载模型的完整
// 导入管线（超标准轮预算）；降级为静态复核（守卫代码在位且读 jobsStatus 判 stage），
// 同族覆盖由 jobs-fuzz「同书双导第二个被拒」承担（已入账 P2 结论）。
{
  const src = fs.readFileSync(path.join(PROJ, "src/desktop/enrich-job.mjs"), "utf8");
  const hasGuard = /const imp = jobs\.jobsStatus\(\)\[b\.id\]/.test(src)
    && /正在导入中/.test(src)
    && /!\["done", "failed", "catalog", "cancelled"\]\.includes\(imp\.stage\)/.test(src);
  ok(hasGuard, "W4-2 导入中守卫静态复核（读 jobsStatus 判 stage + 人话文案）", "");
}

// W4-3：进度事件序列（enrich→batch×N→import→done，终态唯一）
{
  makeDb("w4-3.db");
  const seen = [];
  const off = onEnrichProgress((e) => { if (e.bookId === "w4-3") seen.push(e.stage); });
  await startEnrich("w4-3", { chatFn: goodChat });
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const j = enrichStatus()["w4-3"];
    if (j && ["done", "failed", "cancelled"].includes(j.stage)) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  off();
  const uniq = [...new Set(seen)];
  // emit 口径：跑批阶段 stage="enrich"（detail 滚动）、入库阶段 stage="import"、终态 done
  ok(seen[0] === "enrich" && seen.includes("import") && seen[seen.length - 1] === "done" && uniq.filter((s) => s === "done").length <= 1,
    "W4-3 进度事件序列（enrich→…→import→done）", seen.join(","));
}

// W4-4：还有未跑的批时取消 → cancelled 态 + 库零写入（闸门在 guardChat：下一批不再发请求）
// 桌面入口 batchSize 固定默认 5，用 12 块造 3 批；第 2 批在途时取消 → 第 3 批 guardChat 抛 CANCELLED
{
  const CH12 = Array.from({ length: 12 }, (_, i) => ({ chapter: `第${(i % 2) + 1}章`, text: `第 ${i + 1} 块：熔断器是一种保护电器，当电流超过额定值时自动切断电路，防止设备烧毁，本块用于对抗测试取消闸门。` }));
  makeDb("w4-4.db", CH12);
  const prev = process.env.BSP_SUMMARY; process.env.BSP_SUMMARY = "0";
  const chat = fakeChat((req) => new Promise((res) => setTimeout(() => res(
    idxsOf(req).map((i) => ({ idx: i, prefix: "p" + i, tags: [(blocksOf(req).get(i) || "块").slice(0, 5)], questions: ["q"], summary: "s" }))
  ), 40)));
  await startEnrich("w4-4", { chatFn: chat });
  // cancelled 态会从注册表撤出（设计如此），终态从事件流验
  const seenStages = [];
  const off = onEnrichProgress((e) => { if (e.bookId === "w4-4") seenStages.push(e.stage); });
  // 等到第 2 批在途（共 3 批），此时取消 → 第 3 批的 guardChat 抛 CANCELLED
  const t1 = Date.now();
  while (Date.now() - t1 < 10000 && chat.calls.length < 2) await new Promise((r) => setTimeout(r, 10));
  cancelEnrich("w4-4");
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (seenStages.includes("cancelled") || seenStages.includes("done") || seenStages.includes("failed")) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  off();
  if (prev === undefined) delete process.env.BSP_SUMMARY; else process.env.BSP_SUMMARY = prev;
  // 取消路径下 schema 可能根本没建（importEnrich 没跑）——无 ctx 列 = 零写入，同样是正确表现
  let ctx;
  try { ctx = cell(path.join(LIB, "w4-4.db"), "SELECT COUNT(*) c FROM chunks WHERE ctx IS NOT NULL").c; } catch { ctx = 0; }
  const st = seenStages[seenStages.length - 1];
  const jerr = enrichStatus()["w4-4"]?.error || "(无)";
  ok(chat.calls.length === 2 && st === "cancelled" && ctx === 0, "W4-4 未跑批取消：只发 2 次 + cancelled + 库零写入", `calls=${chat.calls.length} stage=${st} ctx=${ctx} err=${String(jerr).slice(0, 120)}`);
}

// W4-5：audit 没洗过的书 → NOSCHEMA 不炸
{
  makeDb("w4-5.db");
  const r = await enrichAudit("w4-5");
  ok(r && r.ready === false && r.code === "NOSCHEMA", "W4-5 audit 未洗书 NOSCHEMA", JSON.stringify(r).slice(0, 100));
}

// W4-6：estimateFor null（有 meta 无 chunks 的库）→ failed 态人话
{
  const raw = makeRawDb("w4-6.db", "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);");
  const dbw = new Database(raw);
  dbw.prepare("INSERT INTO meta(key,value) VALUES ('title','w4-6')").run();
  dbw.prepare("INSERT INTO meta(key,value) VALUES ('content_hash','hash-w4-6.db')").run();
  dbw.close();
  // 挂到 LIB 下让 findBookDb 找得到（书库文件必须能被 listBooks 发现）
  fs.copyFileSync(raw, path.join(LIB, "w4-6.db"));
  await startEnrich("w4-6", { chatFn: goodChat });
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const j = enrichStatus()["w4-6"];
    if (j && ["done", "failed", "cancelled"].includes(j.stage)) break;
    await new Promise((r2) => setTimeout(r2, 25));
  }
  const j = enrichStatus()["w4-6"];
  ok(j && j.stage === "failed" && j.error, "W4-6 坏结构书落 failed 人话", JSON.stringify(j?.error || "").slice(0, 120));
}

console.log("\n===== W5 chatFn 抛异常与库层容错（V3R-D02 家族）=====");

// W5-1：chatFn 直接 throw → 不穿层；批记 failed 可续跑
{
  const db = makeDb("w5-1.db");
  let n = 0;
  const boom = fakeChat((req) => { n++; if (n === 1) throw new Error("boom"); return idxsOf(req).map((i) => ({ idx: i, prefix: "p" + i, tags: [(blocksOf(req).get(i) || "块").slice(0, 5)], questions: ["q"], summary: "s" })); });
  let threw = null, r = null;
  try { r = await runEnrich(db, { config: CFG, chatFn: boom, resultsDir: RESULTS, summaries: false, batchSize: 3 }); } catch (e) { threw = e; }
  ok(!threw && r && !r.ok, "W5-1 chatFn 抛异常不穿层（落 PARTIAL/failed 可续跑）", threw ? `抛了: ${String(threw).slice(0, 100)}` : r?.code);
}

// W5-2：续跑补齐（W5-1 之后零失败批重跑 → OK）
{
  const db = path.join(LIB, "w5-1.db");
  const chat = fakeChat(goodHandler);
  const r = await runEnrich(db, { config: CFG, chatFn: chat, resultsDir: RESULTS, summaries: false, batchSize: 3 });
  ok(r.ok && chat.calls.length <= 2, "W5-2 失败批续跑补齐", `calls=${chat.calls.length} code=${r.code}`);
}

// ---------- 收尾 ----------
console.log(`\n===== enrich-adversarial-fuzz：${pass} PASS / ${fail} FAIL / ${obs} OBSERVE =====`);
// 清理：取消所有在途任务句柄
for (const id of Object.keys(enrichStatus())) cancelEnrich(id);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
