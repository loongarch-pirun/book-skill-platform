// V3 第二波洗数据跑批验收（src/lib/enrich.mjs）：
// 四重验真（idx 对齐/标签回源/截断上限/宽容解析）+ 断点续跑 + stale 缓存 + 章书摘要 +
// 任务书导出与外部结果验真闭环 + 原文一字不改（跑批不写库）。
// 假 chat 注入（不连网络，test:fast 里 <5s）；临时库用 os.tmpdir()（Node 视角的真实临时目录）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import {
  ENRICH_DEFAULTS, buildEnrichTasks, makeBatches, estimateEnrich, buildEnrichMessages,
  parseEnrich, validateEnrichEntry, matchEntries, enrichBatch, runEnrich, runSummaryPass,
  loadEnrichCache, compactEnrichArtifact, validateEnrichResult, buildEnrichTaskFile,
  enrichResultPath, enrichArtifactPath, chunkFingerprint,
} from "../src/lib/enrich.mjs";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

let failed = 0;
const assert = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (!cond) failed++; };

const CFG = { baseUrl: "http://fake.local/v1", apiKey: "k", model: "m" };

// ---------- 夹具 ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-enrich-"));
const CHUNKS = [
  { chapter: "第一章 低压电器", text: "低压断路器是配电系统的核心保护电器，当电流超过设定值时自动切断电路。熔断器利用金属熔断特性实现短路保护，两者常配合使用。" },
  { chapter: "第一章 低压电器", text: "接触器通过电磁线圈的通断来控制主触点的闭合，适用于频繁启动的电动机控制回路，选型时要看线圈电压与触点容量。" },
  { chapter: "第一章 低压电器", text: "热继电器依靠电流热效应推动动作机构，对电动机过载和缺相运行提供保护，其整定电流可按额定电流的百分数调节。" },
  { chapter: "第二章 电动机", text: "三相异步电动机的转速由同步转速与转差率决定，改变极对数或供电频率即可实现调速，变频调速是目前最常用的方案。" },
  { chapter: "第二章 电动机", text: "电动机启动电流可达额定值的数倍，直接启动会影响电网电压，因此较大容量的电动机需要星三角或软启动器降压启动。" },
  { chapter: "第二章 电动机", text: "伺服电动机以高精度定位著称，编码器把转角换成脉冲反馈给驱动器，构成半闭环控制系统，数控机床广泛采用。" },
  { chapter: "第三章 安全规范", text: "在带电区域内作业必须执行停电、验电、装设接地线、悬挂标识牌的技术措施，并由专人监护。" },
  { chapter: "第三章 安全规范", text: "绝缘手套、绝缘靴与验电器要定期做预防性试验，超期或破损的防护用品一律报废，不得降级使用。" },
];

function makeDb(name, chunks, meta = {}) {
  const p = path.join(TMP, name);
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(p + suffix, { force: true });  // 同名重建（stale/孤儿用例）
  const db = new Database(p);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT NOT NULL);`);
  const ins = db.prepare("INSERT INTO chunks(chapter,page,text) VALUES (?,?,?)");
  for (const c of chunks) ins.run(c.chapter, null, c.text);
  const sm = db.prepare("INSERT INTO meta(key,value) VALUES (?,?)");
  for (const [k, v] of Object.entries({ title: name.replace(/\.db$/, ""), content_hash: "hash-aaa", ...meta })) sm.run(k, String(v));
  db.close();
  return p;
}

// 假 chat：handler(req, callNo) 返回字符串/对象/{ok:false}
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
// 从 user 消息里解析 idx 列表，按 handler 逐块造返回
const idxsOf = (req) => [...req.messages[1].content.matchAll(/\[idx (\d+)\]/g)].map(m => +m[1]);
const goodBatch = (req) => idxsOf(req).map(i => ({
  idx: i, prefix: `这是第 ${i} 块的前置。`, tags: ["断路器", "熔断器", "保护电器"],
  questions: ["这块讲了什么？", "有什么注意事项？", "选型要看什么？", "第四个问题超长了" + "啊".repeat(90)],
  summary: "块摘要：" + "摘".repeat(320),
}));

// ---------- 1) buildEnrichTasks / makeBatches / 成本预估 ----------
{
  const db = makeDb("t1.db", CHUNKS);
  const d = new Database(db, { readonly: true });
  const task = buildEnrichTasks(d);
  d.close();
  assert(task.chunks.length === 8 && task.skipped === 0, `buildEnrichTasks：8 块全 eligible（skipped=${task.skipped}）`);
  assert(task.book.content_hash === "hash-aaa" && task.book.title === "t1", "任务书带 content_hash 与书名");
  assert(makeBatches(task.chunks, 3).length === 3 && makeBatches(task.chunks, 5).length === 2, "makeBatches 分批正确");
  const est = estimateEnrich(task, { batchSize: 4, chaptersPerCall: 2 });
  assert(est.calls === Math.ceil(8 / 4) + Math.ceil(3 / 2) + 1 && est.chunks === 8, `estimateEnrich 自洽（calls=${est.calls}）`);
  const db2 = makeDb("t1b.db", [{ chapter: "微", text: "太短" }]);
  const d2 = new Database(db2, { readonly: true });
  assert(buildEnrichTasks(d2).skipped === 1, "minChars 门：短块跳过并计数");
  d2.close();
}

// ---------- 2) 单批正常 + 截断上限 + 标签回源 ----------
{
  const batch = CHUNKS.slice(0, 2).map((c, i) => ({ idx: i + 1, chapter: c.chapter, text: c.text }));
  const out = await enrichBatch(batch, { chatFn: fakeChat(goodBatch), config: CFG });
  assert(out.ok && out.entries.length === 2, "正常批：2 条目");
  assert(out.entries[0].tags.length === 3, `tags 截到 3（实际 ${out.entries[0].tags.length}）`);
  assert(out.entries[0].questions.length === 3 && out.entries[0].questions[2].length <= 80, "questions 截到 3 且每条 ≤80 字");
  assert(out.entries[0].prefix.length <= 200 && out.entries[0].summary.length <= 300, "prefix/summary 长度上限生效");
  assert(out.tagsDropped > 0, `自造/不命中标签被丢弃并计数（dropped=${out.tagsDropped}）`);
  assert(out.entries[0].tags.every(t => batch[0].text.includes(t) || batch[0].text.toLowerCase().includes(t.toLowerCase())), "留下的标签全部回源命中");
}

// ---------- 3) 归一化命中（大小写/标点不敏感） ----------
{
  const chunk = { idx: 9, chapter: "c", text: "使用 Docker 容器部署应用时，B+ 树索引能加速范围查询，U.S.A. 的缩写无关紧要。" };
  const v = validateEnrichEntry({ tags: ["Docker", "B+ 树", "b+树", "树索引", "X"] }, chunk);
  assert(v.entry.tags.includes("Docker"), "Latin 大小写不敏感命中（Docker ↔ docker）");
  assert(v.entry.tags.some(t => t.replace(/[\s\p{P}\p{S}]/gu, "") === "B树"), "标点空白不敏感命中（B+ 树 ↔ B树）");
  assert(!v.entry.tags.includes("X"), "单词标签被丢（归一化后 <2 字符）");
  assert(v.tagsDropped.length === 1, `不命中标签计数（${v.tagsDropped}）`);
  const vCap = validateEnrichEntry({ tags: ["断路器", "熔断器", "保护电器", "电路", "设定值", "自动切断"] }, CHUNKS[0]);
  assert(vCap.entry.tags.length === 5 && vCap.tagsCapped === 1, `tags 超 5 个截断并计数（tags=${vCap.entry.tags.length}, capped=${vCap.tagsCapped}）`);
}

// ---------- 4) 对齐：错位拒收 / 位置兜底 ----------
{
  const batch = CHUNKS.slice(0, 3).map((c, i) => ({ idx: i + 1, chapter: c.chapter, text: c.text }));
  assert(matchEntries([{ idx: 1 }, { idx: 1 }, { idx: 3 }], batch) === null, "重号 → 拒收");
  assert(matchEntries([{ idx: 1 }, { idx: 2 }], batch) === null, "缺号（条数不符）→ 拒收");
  assert(matchEntries([{ idx: 1 }, { idx: 2 }, { idx: 99 }], batch) === null, "越界 idx → 拒收");
  assert(matchEntries([{ idx: 1 }, { tags: [] }, { idx: 3 }], batch) === null, "混带（部分有 idx）→ 拒收");
  const pos = matchEntries([{ tags: [] }, { tags: [] }, { tags: [] }], batch);
  assert(pos && pos.mode === "position" && pos.byIdx.get(2), "全无 idx 且条数相等 → 位置兜底");
  const out = await enrichBatch(batch, { chatFn: fakeChat(() => [{ idx: 1 }, { idx: 1 }, { idx: 3 }]), config: CFG });
  assert(!out.ok && out.code === "MISALIGN", "整批错位 → ok:false MISALIGN（一个字符都不信）");
}

// ---------- 5) 宽容解析 ----------
{
  assert(parseEnrich('```json\n[{"idx":1}]\n```')?.length === 1, "围栏 json 解析");
  assert(parseEnrich('结果是：[{"idx":1}] 以上')?.length === 1, "前后夹带文字 → 对称截断");
  assert(parseEnrich("[{\"a\":1}{\"b\":2}]") === null, "双数组连写 → 拒收");
  assert(parseEnrich("模型啥也没返回") === null, "无数组 → null");
  const out = await enrichBatch(CHUNKS.slice(0, 1).map((c, i) => ({ idx: i + 1, ...c })), { chatFn: fakeChat(() => "完全不是 JSON"), config: CFG });
  assert(!out.ok && out.code === "BADRESP", "坏 JSON → BADRESP（不抛异常穿层）");
}

// ---------- 6) runEnrich：全自动 + 失败续跑 + stale + 孤儿 + 不写库 ----------
{
  const dir = path.join(TMP, "run1");
  const db = makeDb("run.db", CHUNKS);
  const dbRO = new Database(db, { readonly: true });
  const before = dbRO.prepare("SELECT group_concat(text) t FROM chunks").get().t;
  dbRO.close();

  // 第一跑：第 1 个 chat 调用（第一批）网络失败，其余正常；关摘要隔离计数
  const chat1 = fakeChat((req, n) => (n === 1 ? { ok: false, code: "NETWORK", message: "连不上" } : goodBatch(req)));
  const r1 = await runEnrich(db, { config: CFG, chatFn: chat1, resultsDir: dir, batchSize: 4, summaries: false });
  assert(!r1.ok && r1.code === "PARTIAL" && r1.stats.batchesFailed === 1 && r1.stats.batches === 2, `第一批失败 → PARTIAL（failed=${r1.stats.batchesFailed}）`);
  assert(chat1.calls.length === 2, `失败的批不阻断后续批（共 ${chat1.calls.length} 次调用）`);
  assert(fs.existsSync(enrichResultPath(dir, "run.db")), "JSONL 缓存落盘");

  // 第二跑：只补失败的那一批
  const chat2 = fakeChat(goodBatch);
  const r2 = await runEnrich(db, { config: CFG, chatFn: chat2, resultsDir: dir, batchSize: 4, summaries: false });
  assert(r2.ok && r2.stats.batchesPending === 1 && chat2.calls.length === 1, `续跑只补失败批（pending=${r2.stats.batchesPending}，调用 ${chat2.calls.length} 次）`);
  assert(r2.stats.usageIn === 100, `usage 累计（${r2.stats.usageIn}）`);

  // 产物 + 原文一字不改
  const artifact = JSON.parse(fs.readFileSync(enrichArtifactPath(dir, "run.db"), "utf8"));
  assert(artifact.entries.length === 8 && artifact.book.content_hash === "hash-aaa", "压成的 JSON 产物 8 条 + hash 登记");
  const dbRO2 = new Database(db, { readonly: true });
  const after = dbRO2.prepare("SELECT group_concat(text) t FROM chunks").get().t;
  dbRO2.close();
  assert(before === after, "跑批后原文逐字未改（enrich 不写库）");

  // stale：同库名同目录但 content_hash 变了 → 拒续跑
  const dbOther = makeDb("run.db", CHUNKS, { content_hash: "hash-bbb" });
  const r3 = await runEnrich(dbOther, { config: CFG, chatFn: fakeChat(goodBatch), resultsDir: dir, batchSize: 4, summaries: false });
  assert(!r3.ok && r3.code === "STALE", "content_hash 变 → STALE 拒续跑");

  // 孤儿条目：库里块少了（idx 7,8 不在），同 hash → **结构变 = STALE_STRUCT**（P4 新契约）：
  // content_hash 相同只说明源文件没变，块结构变了旧缓存按 idx 硬套就会串味——拒续跑，
  // 人话指「先移走缓存再跑」。这比旧行为的「静默清孤儿后继续」安全（清掉的条目若其实
  // 对应着还在的块，就是无声的数据丢失）。
  const dbLess = makeDb("run.db", CHUNKS.slice(0, 6), { content_hash: "hash-aaa" });
  const r4 = await runEnrich(dbLess, { config: CFG, chatFn: fakeChat(goodBatch), resultsDir: dir, batchSize: 4, summaries: false });
  assert(!r4.ok && r4.code === "STALE" && /切片结构|重新加工/.test(r4.message), "同 hash 但块结构变 → STALE_STRUCT 拒续跑（P4）", r4.message);
  // A7 修复（毛求疵对抗审查实证）：旧版缓存（meta 行无 chunk_fp，模拟 P4 之前写的缓存）+
  // 同 content_hash 重加工 → 缓存结构不可判，照样 STALE_STRUCT 拒收。「无指纹」不等于
  // 「没变过」——旧条目按 idx 硬套新块就是静默串味（串味全链路实证），拒收发生在任何
  // 云端调用之前，缓存一个字节都不改（无 meta 补写、无 entries 追加）。
  const legacyJsonl = enrichResultPath(dir, "run.db");
  const legacyLines = fs.readFileSync(legacyJsonl, "utf8").split(/\r?\n/)
    .map(l => { try { const r = JSON.parse(l); if (r && r.t === "meta") delete r.chunk_fp; return JSON.stringify(r); } catch { return l; } });
  fs.writeFileSync(legacyJsonl, legacyLines.join("\n"), "utf8");
  const legacySha = crypto.createHash("sha256").update(fs.readFileSync(legacyJsonl)).digest("hex");
  const chat4b = fakeChat(goodBatch);
  const r4b = await runEnrich(dbLess, { config: CFG, chatFn: chat4b, resultsDir: dir, batchSize: 4, summaries: false });
  assert(!r4b.ok && r4b.code === "STALE" && /旧格式|无法判断|重新加工/.test(r4b.message), "A7：旧版缓存（无 chunk_fp）→ 结构不可判 STALE_STRUCT 拒收", r4b.message);
  assert(chat4b.calls.length === 0, "A7：拒收发生在任何云端调用之前（零花费）");
  assert(crypto.createHash("sha256").update(fs.readFileSync(legacyJsonl)).digest("hex") === legacySha, "A7：STALE 不写缓存（无 meta 补写、无 entries 追加）");
  // 孤儿清理路径仍在（结构判据相符时）：fp 相符的缓存里手加一条越界 ok 记录（idx 99）→
  // 不 stale、越界条目被清、续跑零调用、产物只有合法 6 条
  const dir2 = path.join(TMP, "run2");
  const db6 = makeDb("run2.db", CHUNKS.slice(0, 6), { content_hash: "hash-aaa" });
  const rA = await runEnrich(db6, { config: CFG, chatFn: fakeChat(goodBatch), resultsDir: dir2, batchSize: 4, summaries: false });
  assert(rA.ok, "run2 首跑收尾（fp 相符基线）");
  const j2 = enrichResultPath(dir2, "run2.db");
  fs.appendFileSync(j2, JSON.stringify({ t: "ok", idxs: [99], entries: [{ idx: 99, tags: ["幽灵"], questions: [], prefix: "x", summary: "y" }], mode: "byIdx", at: new Date().toISOString() }) + "\n", "utf8");
  const chat4c = fakeChat(goodBatch);
  const rC = await runEnrich(db6, { config: CFG, chatFn: chat4c, resultsDir: dir2, batchSize: 4, summaries: false });
  assert(rC.ok && chat4c.calls.length === 0, "fp 相符 → 不 stale，续跑零调用（全命中）");
  const art4c = JSON.parse(fs.readFileSync(enrichArtifactPath(dir2, "run2.db"), "utf8"));
  assert(art4c.entries.length === 6 && !art4c.entries.some(e => e.idx === 99), "越界旧条目被清（块已不存在，孤儿清理路径仍在）");
}

// ---------- 7) 章摘要/书摘要 ----------
{
  const sumDb = makeDb("sum.db", CHUNKS);
  const dSum = new Database(sumDb, { readonly: true });
  const task = buildEnrichTasks(dSum);
  dSum.close();
  const entriesMap = new Map(task.chunks.map(c => [c.idx, { idx: c.idx, prefix: "前置", tags: [], questions: [], summary: `${c.chapter}的摘要` }]));
  const chat = fakeChat(req => req.messages[0].content.includes("章节摘要")
    ? [...new Set([...req.messages[1].content.matchAll(/【(.+?)】/g)].map(m => m[1]))].map(ch => ({ chapter: ch, summary: "章摘要：" + "总".repeat(320) }))
    : "全书摘要正文");
  const s = await runSummaryPass(task, entriesMap, { chatFn: chat, config: CFG, chaptersPerCall: 8 });
  assert(Object.keys(s.chapterSummaries).length === 3, `3 章各得摘要（实际 ${Object.keys(s.chapterSummaries).length}）`);
  assert(Object.values(s.chapterSummaries).every(v => v.length <= 300), "章摘要 300 字上限");
  assert(s.bookSummary.length > 0 && s.bookSummary.length <= 500, "书摘要产出且 ≤500 字");
  assert(chat.calls.length === 2, `章批 1 次 + 书 1 次（实际 ${chat.calls.length}）`);
  // 章名对不上 → 该批 failed，不污染
  const chatBad = fakeChat(() => [{ chapter: "不存在的章", summary: "x" }]);
  const s2 = await runSummaryPass(task, entriesMap, { chatFn: chatBad, config: CFG });
  assert(s2.failed === 1 && Object.keys(s2.chapterSummaries).length === 0 && s2.bookSummary === "", "章名错位 → 该批作废、书摘要跳过");
}

// ---------- 7b) V3R-D11：摘要失败进 stats（机器可验）+ usage 逐次累加 ----------
{
  const db = makeDb("t7b.db", CHUNKS);
  const dir = path.join(TMP, "run7b");
  // 块批正常；第 1 次章批返坏章名（该批作废 failed）；chaptersPerCall=2 → 3 章 = 2 次章批 + 1 次书摘要
  const chat = fakeChat((req, n) => {
    const sys = req.messages[0].content;
    if (sys.includes("章节摘要")) {
      const chs = [...new Set([...req.messages[1].content.matchAll(/【(.+?)】/g)].map(m => m[1]))];
      return n === 3 ? [{ chapter: "不存在的章", summary: "x" }] : chs.map(ch => ({ chapter: ch, summary: "章摘要：" + ch }));
    }
    if (sys.includes("全书摘要")) return "全书摘要正文";
    return goodBatch(req);
  });
  const r = await runEnrich(db, { config: CFG, chatFn: chat, resultsDir: dir, batchSize: 4, chaptersPerCall: 2 });
  assert(r.ok && r.stats.batchesFailed === 0, "块批全成 → ok（摘要失败不阻断跑批）");
  assert(r.stats.summariesFailed === 1, `D11：章摘要失败数进 stats（summariesFailed=${r.stats.summariesFailed}）`);
  const art = JSON.parse(fs.readFileSync(r.artifactPath, "utf8"));
  assert(art.stats.summariesFailed === 1, "D11：artifact.stats 同步带 summariesFailed（失败机器可验）");
  assert(r.stats.calls === 5, `调用数=块2+章2+书1（实际 ${r.stats.calls}）`);
  // usage 逐次累加：5 次调用各 100/50 = 500/250（旧代码只留最后一次摘要 usage → 300，少计）
  assert(r.stats.usageIn === 500 && r.stats.usageOut === 250, `D11：usage 逐次累加（in=${r.stats.usageIn} out=${r.stats.usageOut}）`);
}

// ---------- 8) 任务书导出 + 外部结果验真闭环 ----------
{
  const dir = path.join(TMP, "tasks");
  const db = makeDb("task.db", CHUNKS);
  const { outPath } = buildEnrichTaskFile(db, dir);
  const file = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert(file.instructions.length === 3 && file.batches.length === 2 && file.book.content_hash === "hash-aaa", "任务书：instructions/batches/hash 齐全");
  assert(typeof file.book.chunk_fp === "string" && file.book.chunk_fp.length === 16 && file.book.eligible === 8,
    "任务书带 chunk_fp/eligible（P4：外部智能体通道也能带指纹回去）", JSON.stringify(file.book).slice(0, 120));
  assert(file.batches[0].every(b => typeof b.idx === "number" && b.text), "任务书批次带全局 idx 与原文");
  const dTask = new Database(db, { readonly: true });
  const task = buildEnrichTasks(dTask);
  dTask.close();
  // 智能体照任务书产出（标签取自原文）
  const good = {
    book: { content_hash: "hash-aaa" },
    entries: task.chunks.map(c => ({ idx: c.idx, prefix: "p", tags: [c.text.slice(0, 4)], questions: ["q"], summary: "s" })),
  };  const v = validateEnrichResult(good, task);
  assert(v.errors.length === 0 && v.entries.length === 8 && v.stats.covered === 8, "外部合法结果 → 全量验真通过");
  const vDup = validateEnrichResult({ ...good, entries: [...good.entries, { ...good.entries[0] }] }, task);
  assert(vDup.stats.dup === 1 && vDup.entries.length === 8, "重复 idx → 计 dup 按首条入账");
  const vOrphan = validateEnrichResult({ ...good, entries: [...good.entries, { idx: 999, tags: [] }] }, task);
  assert(vOrphan.stats.orphan === 1, "越界 idx → 计 orphan 忽略");
  const vHash = validateEnrichResult({ book: { content_hash: "other" }, entries: good.entries }, task);
  assert(vHash.errors.some(e => e.includes("content_hash")), "hash 不符 → 拒收");
  const vBad = validateEnrichResult({ entries: good.entries.map((e, i) => i === 2 ? { ...e, tags: ["不存在的词xyz"] } : e) }, task);
  assert(vBad.stats.tagsDropped === 1 && vBad.entries[2].tags.length === 0, "外部结果同样过标签回源验真");
}

// ---------- 9) 配置错不炸 / 空任务 ----------
{
  const dir = path.join(TMP, "cfg");
  const db = makeDb("cfg.db", CHUNKS);
  const r = await runEnrich(db, { config: { baseUrl: "http://fake.local/v1", model: "m" }, chatFn: fakeChat(goodBatch), resultsDir: dir });
  assert(!r.ok && r.code === "CONFIG" && /key/.test(r.message), "缺 key → CONFIG 人话返回（不抛异常）");
  const rMiss = await runEnrich(path.join(TMP, "no-such.db"), { config: CFG, chatFn: fakeChat(goodBatch), resultsDir: dir });
  assert(!rMiss.ok && rMiss.code === "NOBOOK", "库不存在 → NOBOOK");
  const dbEmpty = makeDb("empty.db", [{ chapter: "微", text: "短" }]);
  const chatE = fakeChat(goodBatch);
  const rE = await runEnrich(dbEmpty, { config: CFG, chatFn: chatE, resultsDir: path.join(TMP, "empty"), summaries: false });
  assert(rE.ok && chatE.calls.length === 0 && rE.stats.chunks === 0 && rE.stats.skipped === 1, "全短块 → 0 调用直接收尾");
}

// ---------- 9b) P4：块结构指纹 chunkFingerprint + 缓存结构判据 ----------
{
  const shaped = CHUNKS.map((c, i) => ({ idx: i + 1, ...c }));
  const fp = chunkFingerprint(shaped);
  assert(/^[0-9a-f]{16}$/.test(fp), `chunkFingerprint：16 位十六进制（${fp}）`);
  assert(fp === chunkFingerprint(shaped), "chunkFingerprint：同输入同值（稳定）");
  const changed = shaped.map((c) => ({ ...c }));
  changed[3] = { ...changed[3], text: changed[3].text + "。" };
  assert(chunkFingerprint(changed) !== fp, "chunkFingerprint：换一字即变");
  assert(chunkFingerprint([...shaped].reverse()) !== fp, "chunkFingerprint：顺序敏感（逐块序列化）");
  assert(chunkFingerprint([{ idx: 1, text: "x" }]) !== chunkFingerprint([{ idx: 2, text: "x" }]),
    "chunkFingerprint：idx 进指纹（同文本不同编号=不同结构）");
  assert(chunkFingerprint([{ idx: 1, text: "x" }]) === chunkFingerprint([{ id: 1, text: "x" }]),
    "chunkFingerprint：idx/id 两种形状同值（任务书与库行两处调用）");
  assert(chunkFingerprint([]) === chunkFingerprint(null) && /^[0-9a-f]{16}$/.test(chunkFingerprint([])),
    "chunkFingerprint：空数组/非数组有确定值不抛");
  // 任务书带指纹与 eligible
  const d = new Database(makeDb("fp.db", CHUNKS), { readonly: true });
  const t = buildEnrichTasks(d);
  d.close();
  assert(t.book.chunk_fp === fp && t.book.eligible === 8, "buildEnrichTasks：book.chunk_fp/eligible 随任务书出海");
  // 缓存结构判据：meta 带 chunk_fp 不符 → stale/STRUCT；相符 → 不 stale；hash 不符优先 HASH
  const jp = path.join(TMP, "fp.jsonl");
  fs.writeFileSync(jp, JSON.stringify({ t: "meta", db: "fp.db", content_hash: "hash-aaa", chunk_fp: "a".repeat(16) }) + "\n", "utf8");
  const c1 = loadEnrichCache(jp, "hash-aaa", "b".repeat(16));
  assert(c1.stale && c1.staleReason === "STRUCT", "loadEnrichCache：chunk_fp 不符 → stale + STRUCT");
  const c2 = loadEnrichCache(jp, "hash-aaa", "a".repeat(16));
  assert(!c2.stale && c2.staleReason === null, "loadEnrichCache：chunk_fp 相符 → 不 stale");
  const c3 = loadEnrichCache(jp, "hash-zzz", "a".repeat(16));
  assert(c3.stale && c3.staleReason === "HASH", "loadEnrichCache：hash 不符优先报 HASH（先内容后结构）");
  const c4 = loadEnrichCache(jp, "hash-aaa");
  assert(!c4.stale, "loadEnrichCache：两参旧调用不判结构（兼容）");
  // A7：三参调用 + meta 无 chunk_fp → 结构不可判，stale STRUCT（「无指纹」≠「没变过」——
  // 同 content_hash 重加工后旧条目按 idx 硬套新块即静默串味，对抗审查实证全链路）
  const jpNoFp = path.join(TMP, "nofp.jsonl");
  fs.writeFileSync(jpNoFp, JSON.stringify({ t: "meta", db: "fp.db", content_hash: "hash-aaa" }) + "\n", "utf8");
  const c5 = loadEnrichCache(jpNoFp, "hash-aaa", "a".repeat(16));
  assert(c5.stale && c5.staleReason === "STRUCT", "loadEnrichCache：meta 无 chunk_fp + 三参 → stale STRUCT（A7）");
  const c6 = loadEnrichCache(jpNoFp, "hash-aaa");
  assert(!c6.stale, "loadEnrichCache：两参旧调用对无 fp 缓存照样不判（compactEnrichArtifact 重读路径）");
}

// ---------- 10) 默认参数快照（防误改） ----------
assert(ENRICH_DEFAULTS.batchSize === 5 && ENRICH_DEFAULTS.maxTags === 5 && ENRICH_DEFAULTS.maxQuestions === 3
  && ENRICH_DEFAULTS.minChars === 40 && ENRICH_DEFAULTS.chaptersPerCall === 8,
  `默认参数锁定（${JSON.stringify({ b: ENRICH_DEFAULTS.batchSize, t: ENRICH_DEFAULTS.maxTags, q: ENRICH_DEFAULTS.maxQuestions })}）`);

// ---------- 收尾 ----------
{
  const batch = CHUNKS.slice(0, 1).map((c, i) => ({ idx: i + 1, ...c }));
  const msgs = buildEnrichMessages(batch);
  assert(msgs.length === 2 && msgs[1].content.includes("[idx 1]") && msgs[0].content.includes("idx"), "提示词带全局 idx 与铁律");
  const cache = loadEnrichCache(enrichResultPath(path.join(TMP, "run1"), "run.db"), "hash-aaa");
  assert(cache.entries.size === 8 && !cache.stale, "loadEnrichCache 读回 8 条且 hash 相符");
  const art = compactEnrichArtifact(enrichResultPath(path.join(TMP, "run1"), "run.db"), path.join(TMP, "run1", "again.json"), { book: { db: "run.db", title: "t", content_hash: "hash-aaa", chunk_count: 8 }, stats: {} });
  assert(art.entries.length === 8, "compactEnrichArtifact 可重复压出同一产物");
}

console.log(`\n===== 洗数据跑批验收：${failed === 0 ? "全部 PASS" : failed + " 项 FAIL"} =====`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
