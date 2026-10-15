// 洗数据跑批（V3 第二波 L3，R2）：逐批块调云端，一次产出四样——
//   前置 prefix（向量化时与原文一起 embed，增强语义）/ 标签 tags（≤5，倒排提名）/
//   假设问题 questions（≤3，问式提名）/ 块摘要 summary（章书摘要的原料）。
// 双通道（与编目闭环同构）：
//   应用内一键：runEnrich(dbPath, {config}) 带 key 直跑，JSONL 缓存断点续跑；
//   外部智能体：buildEnrichTaskFile 导任务书 → 智能体产结果 JSON → validateEnrichResult 验真（#137 入库）。
// 铁律（四条判断标准落地）：
//   ① 标签回源验真 100%：每个标签 normalize 后必须被该块原文包含，否则丢弃并计数；
//   ② 原文一字不改：enrich 只产附加字段，绝不回写 chunks.text（本模块根本不写库）；
//   ③ 声称机器可验：结果的 idx 必须与任务块一一对应，错位/缺号整批拒收（MISALIGN）；
//   ④ 失败降级可续跑：网络/超时/坏 JSON → 该批记 failed，重跑只补失败批，不阻断其他批。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { chat, normalizeLlmConfig } from "./llm.mjs";
const require = createRequire(import.meta.url);

export const ENRICH_DEFAULTS = {
  batchSize: 5,          // 每批块数（5 块 ≈ 2~3k in / ~2k out，保守不爆上下文）
  minChars: 40,          // 短块不洗（前置/摘要对 40 字以下块无意义），计入 skipped
  maxTags: 5,
  maxQuestions: 3,
  prefixMax: 200,        // 前置长度上限（超长截断）
  summaryMax: 300,       // 块摘要长度上限
  questionMax: 80,       // 假设问题长度上限
  temperature: 0.2,
  maxTokens: 2400,
  timeoutMs: 60000,
  chaptersPerCall: 8,    // 章摘要每批章节数
  chapterSummaryMax: 300,
  bookSummaryMax: 500,
  bookInputMax: 12000,   // 书摘要输入的章节摘要总长上限（超长截断——巨章节数书的书摘要天然有损）
};

// 归一化：去空白与标点（标签回源比对用；Latin 大小写不敏感——"Docker" 命中 "docker"）
const norm = (s) => String(s || "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
const cap = (s, n) => (s.length > n ? s.slice(0, n) : s);

// ---------- 任务书 ----------
// 从书库读块（只读）。idx =  chunks.id（全局编号，提示词与缓存同一套编号空间，杜绝两套表错位）。
export function buildEnrichTasks(db, { minChars = ENRICH_DEFAULTS.minChars } = {}) {
  const rows = db.prepare("SELECT id, chapter, page, text FROM chunks ORDER BY id").all();
  const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
  const chunks = rows.map(r => ({ idx: r.id, chapter: r.chapter ?? "", page: r.page ?? null, text: r.text }));
  const eligible = chunks.filter(c => c.text.length >= minChars);
  return {
    book: { title: meta.title || "", content_hash: meta.content_hash || "", chunk_count: chunks.length },
    chunks: eligible,
    skipped: chunks.length - eligible.length,
  };
}

export function makeBatches(chunks, batchSize = ENRICH_DEFAULTS.batchSize) {
  const n = Math.max(1, Math.floor(batchSize) || 1);
  const out = [];
  for (let i = 0; i < chunks.length; i += n) out.push(chunks.slice(i, i + n));
  return out;
}

// 成本预估（规划 aids，不是计费）：调用数 = 块批 + 章批 + 1 次书摘要；字符数为粗估
export function estimateEnrich(task, { batchSize = ENRICH_DEFAULTS.batchSize, chaptersPerCall = ENRICH_DEFAULTS.chaptersPerCall } = {}) {
  const chapters = new Set(task.chunks.map(c => c.chapter)).size;
  const inChars = task.chunks.reduce((a, c) => a + c.text.length, 0);
  const batchCalls = Math.ceil(task.chunks.length / Math.max(1, batchSize));
  const chapterCalls = Math.ceil(chapters / Math.max(1, chaptersPerCall));
  return {
    chunks: task.chunks.length,
    skipped: task.skipped,
    chapters,
    calls: batchCalls + chapterCalls + 1,
    batchCalls,
    chapterCalls,
    estInputChars: inChars + batchCalls * 400,      // 提示词开销粗估
    estOutputChars: task.chunks.length * 380,       // 四样产物的粗估
  };
}

// ---------- 提示词 ----------
const SYSTEM_ENRICH = `你是严谨的读书助手，为本地书库的每个「原文块」生成检索辅助信息。用户会给出若干原文块（每块带编号），请为每个块产出四样东西，并输出一个 JSON 数组，除此之外不要输出任何其他内容。

每个数组元素对应一个块：
{"idx":编号,"prefix":"…","tags":["…"],"questions":["…"],"summary":"…"}

四样东西的要求：
1. prefix（前置）：1~2 句话说明这个块的主题（供向量化时增强语义）。概括即可，不要大段抄原文。
2. tags（标签）：0~5 个关键词或短语。铁律：每个标签必须是该块原文中出现过的字词（可以是原文中某个词的一部分，如原文「熔断器」可取标签「熔断」），严禁自造——自造标签会被机器验真直接丢弃。
3. questions（假设问题）：0~3 个「用户可能对着这个块提的问题」，要具体（如「低压电器的符号是什么」），不要空泛。
4. summary（块摘要）：1~2 句话的摘要。

其他铁律：
- idx 必须与用户给的块编号完全一致，一个块对应一个元素，不许合并、拆分、增删；
- 原文是繁体就保持繁体，不要转成简体；
- 只依据给定块的内容，不引用外部知识，不猜测；
- 块内确实没有可提炼内容时，tags/questions 给空数组、prefix/summary 给空字符串，绝不许编造。`;

export function buildEnrichMessages(batch) {
  const list = batch.map(c => `[idx ${c.idx}]${c.chapter ? `《${c.chapter}》` : ""}\n${c.text}`).join("\n\n");
  return [
    { role: "system", content: SYSTEM_ENRICH },
    { role: "user", content: `下面是 ${batch.length} 个原文块：\n\n${list}` },
  ];
}

// ---------- 宽容解析（与 llm.parseAnswer 同款对称截断；独立实现，不动 llm.mjs） ----------
// 容忍 ```json 围栏与前后夹带文字；双数组连写/截断 → null（拒收安全）
export function parseEnrich(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf("["), e = t.lastIndexOf("]");
  if (s < 0 || e <= s) return null;
  try {
    const d = JSON.parse(t.slice(s, e + 1));
    return Array.isArray(d) ? d : null;
  } catch { return null; }
}

// ---------- 验真 ----------
// 单块条目 → 归一化产物。tagsDropped（回源失败）/ tagsCapped（超 5 个被截）分别计数。
export function validateEnrichEntry(raw, chunk, opts = {}) {
  const o = { ...ENRICH_DEFAULTS, ...opts };
  const src = norm(chunk.text);
  const tagsDropped = [];
  const rawTags = [...new Set((Array.isArray(raw?.tags) ? raw.tags : [])
    .map(v => String(v || "").trim())
    .filter(Boolean))];
  const tags = rawTags
    .filter(v => {
      const nv = norm(v);
      const ok = nv.length >= 2 && src.includes(nv);
      if (!ok) tagsDropped.push(v);
      return ok;
    })
    .slice(0, o.maxTags);
  const questions = [...new Set((Array.isArray(raw?.questions) ? raw.questions : [])
    .map(v => String(v || "").trim())
    .filter(Boolean))]
    .map(v => cap(v, o.questionMax))
    .slice(0, o.maxQuestions);
  return {
    entry: {
      idx: chunk.idx,
      prefix: cap(String(raw?.prefix || "").trim(), o.prefixMax),
      tags,
      questions,
      summary: cap(String(raw?.summary || "").trim(), o.summaryMax),
    },
    tagsDropped,
    tagsCapped: Math.max(0, rawTags.length - tags.length - tagsDropped.length),
  };
}

// 批次对齐：模型返回的条目必须与本批 idx 集合一一对应。
// 模式 idx（首选）：每条带 idx 且恰好覆盖；模式 position（兜底）：完全无 idx 字段但条数相等；
// 其余（缺号/重号/越界/混带）→ null = 整批拒收，一个字符都不信。
export function matchEntries(rawList, batch) {
  const list = Array.isArray(rawList) ? rawList : [];
  if (list.length !== batch.length) return null;
  const want = new Set(batch.map(c => c.idx));
  const withIdx = list.filter(r => r && Number.isInteger(r.idx));
  if (withIdx.length === list.length) {
    const seen = new Set();
    for (const r of list) {
      if (!want.has(r.idx) || seen.has(r.idx)) return null;
      seen.add(r.idx);
    }
    return { mode: "idx", byIdx: new Map(list.map(r => [r.idx, r])) };
  }
  if (withIdx.length === 0) {
    return { mode: "position", byIdx: new Map(batch.map((c, i) => [c.idx, list[i]])) };
  }
  return null;
}

// 单批：调云端 → 解析 → 验真。不抛异常（lib 层铁律：失败返回 {ok:false, code}）。
export async function enrichBatch(batch, { chatFn = chat, config, ...opts } = {}) {
  const o = { ...ENRICH_DEFAULTS, ...opts };
  const r = await chatFn({
    ...config,
    temperature: o.temperature,
    maxTokens: o.maxTokens,
    timeoutMs: o.timeoutMs,
    messages: buildEnrichMessages(batch),
  });
  if (!r.ok) return { ok: false, code: r.code || "HTTP", message: r.message || "模型调用失败" };
  const rawList = parseEnrich(r.text);
  if (!rawList) return { ok: false, code: "BADRESP", message: "模型未按 JSON 数组格式返回" };
  const matched = matchEntries(rawList, batch);
  if (!matched) return { ok: false, code: "MISALIGN", message: "返回条目的 idx 与本批块对不上（缺号/重号/越界），整批拒收" };
  const entries = [];
  let tagsDropped = 0, tagsCapped = 0;
  for (const c of batch) {
    const v = validateEnrichEntry(matched.byIdx.get(c.idx), c, o);
    entries.push(v.entry);
    tagsDropped += v.tagsDropped.length;
    tagsCapped += v.tagsCapped;
  }
  return { ok: true, entries, tagsDropped, tagsCapped, mode: matched.mode, usage: r.usage || null };
}

// ---------- 结果文件：JSONL 追加缓存（O(1) 写，崩了不丢进度）+ 结束压成 JSON 产物 ----------
export function enrichResultPath(resultsDir, dbName) {
  return path.join(resultsDir, dbName.replace(/\.db$/, "") + ".jsonl");
}
export function enrichArtifactPath(resultsDir, dbName) {
  return path.join(resultsDir, dbName.replace(/\.db$/, "") + ".json");
}

// 读缓存：末条覆盖（重跑的批会追加新条）；返回 { entries: Map, failedBatches: number[][], hash }
export function loadEnrichCache(jsonlPath, contentHash) {
  const out = { entries: new Map(), failedBatches: [], hash: null };
  if (!fs.existsSync(jsonlPath)) return out;
  for (const line of fs.readFileSync(jsonlPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }   // 半行损坏（崩溃写入中）→ 跳过
    if (rec.t === "meta") out.hash = rec.content_hash;
    else if (rec.t === "ok") for (const e of rec.entries) out.entries.set(e.idx, e);
    else if (rec.t === "fail") out.failedBatches.push(rec.idxs);
  }
  out.stale = !!contentHash && out.hash != null && out.hash !== contentHash;
  return out;
}

function appendCache(jsonlPath, rec) {
  fs.appendFileSync(jsonlPath, JSON.stringify(rec) + "\n", "utf8");
}

// 压成最终产物（外部智能体通道与 #137 入库都读这个 JSON）。
// entries 可由调用方传入（runEnrich 传的是已清孤儿条目的版本）；不传则从 JSONL 重读。
export function compactEnrichArtifact(jsonlPath, jsonPath, { book, stats, entries: entriesIn }) {
  const cache = loadEnrichCache(jsonlPath, book.content_hash);
  const entries = (entriesIn || [...cache.entries.values()])
    .slice().sort((a, b) => a.idx - b.idx);
  const artifact = {
    version: 1,
    book: { db: book.db, title: book.title, content_hash: book.content_hash, chunk_count: book.chunk_count },
    stats: { ...stats, entries: entries.length },
    entries,
    failed_batches: cache.failedBatches,
    updated_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(artifact, null, 1), "utf8");
  return artifact;
}

// ---------- 跑批主编排 ----------
// 返回 { ok, stats, artifactPath, cachePath, message? }；config 缺 key 等配置错不炸，直接回。
export async function runEnrich(dbPath, opts = {}) {
  const o = { ...ENRICH_DEFAULTS, ...opts };
  const chatFn = opts.chatFn || chat;
  const resultsDir = opts.resultsDir || path.join(process.cwd(), "enrich-results");
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  const normCfg = normalizeLlmConfig(opts.config);
  if (normCfg.error) return { ok: false, code: "CONFIG", message: normCfg.error };
  if (!fs.existsSync(dbPath)) return { ok: false, code: "NOBOOK", message: `找不到书库 ${dbPath}` };

  const Database = require("better-sqlite3");
  let db;
  try { db = new Database(dbPath, { readonly: true }); }
  catch (e) { return { ok: false, code: "DBBROKEN", message: `书库打不开：${e.message}` }; }
  let task;
  try { task = buildEnrichTasks(db, { minChars: o.minChars }); } finally { db.close(); }

  const dbName = path.basename(dbPath);
  const jsonlPath = enrichResultPath(resultsDir, dbName);
  const jsonPath = enrichArtifactPath(resultsDir, dbName);
  const cache = loadEnrichCache(jsonlPath, task.book.content_hash);
  if (cache.stale) {
    return { ok: false, code: "STALE", message: `缓存与当前书库内容不一致（content_hash 不同）——书被重建过，请先移走 ${jsonlPath} 再跑`, cachePath: jsonlPath };
  }
  if (cache.hash == null) {
    fs.mkdirSync(resultsDir, { recursive: true });
    appendCache(jsonlPath, { t: "meta", db: dbName, content_hash: task.book.content_hash, at: new Date().toISOString() });
  }

  const validIdx = new Set(task.chunks.map(c => c.idx));
  for (const idx of cache.entries.keys()) if (!validIdx.has(idx)) cache.entries.delete(idx);  // 孤儿条目（块已不存在）

  const batches = makeBatches(task.chunks, o.batchSize);
  const pending = batches.filter(b => b.some(c => !cache.entries.has(c.idx)));
  const stats = {
    chunks: task.chunks.length, skipped: task.skipped, chapters: new Set(task.chunks.map(c => c.chapter)).size,
    batches: batches.length, batchesPending: pending.length, batchesFailed: 0,
    tagsDropped: 0, tagsCapped: 0, calls: 0, usageIn: 0, usageOut: 0,
  };
  for (const b of pending) {
    const r = await enrichBatch(b, { chatFn, ...o, config: normCfg });
    stats.calls++;
    if (r.usage) { stats.usageIn += r.usage.prompt_tokens || 0; stats.usageOut += r.usage.completion_tokens || 0; }
    if (!r.ok) {
      stats.batchesFailed++;
      appendCache(jsonlPath, { t: "fail", idxs: b.map(c => c.idx), code: r.code, at: new Date().toISOString() });
      onProgress({ phase: "batch", ok: false, code: r.code, done: cache.entries.size, total: task.chunks.length });
      continue;
    }
    stats.tagsDropped += r.tagsDropped;
    stats.tagsCapped += r.tagsCapped;
    for (const e of r.entries) cache.entries.set(e.idx, e);
    appendCache(jsonlPath, { t: "ok", idxs: b.map(c => c.idx), entries: r.entries, mode: r.mode, at: new Date().toISOString() });
    onProgress({ phase: "batch", ok: true, done: cache.entries.size, total: task.chunks.length });
  }

  // 章摘要/书摘要（全部块洗完才有意义；失败不阻断，登记后跳过）
  let summaries = null;
  if (o.summaries !== false && cache.entries.size > 0) {
    summaries = await runSummaryPass(task, cache.entries, { chatFn, ...o, config: normCfg, onProgress });
    stats.calls += summaries.calls;
    if (summaries.usage) { stats.usageIn += summaries.usage.prompt_tokens || 0; stats.usageOut += summaries.usage.completion_tokens || 0; }
  }

  const artifact = compactEnrichArtifact(jsonlPath, jsonPath, {
    book: { db: dbName, title: task.book.title, content_hash: task.book.content_hash, chunk_count: task.book.chunk_count },
    stats,
    entries: [...cache.entries.values()],
  });
  if (summaries) {
    artifact.chapter_summaries = summaries.chapterSummaries;
    artifact.book_summary = summaries.bookSummary;
    fs.writeFileSync(jsonPath, JSON.stringify(artifact, null, 1), "utf8");
  }
  return {
    ok: stats.batchesFailed === 0,
    code: stats.batchesFailed ? "PARTIAL" : "OK",
    message: stats.batchesFailed ? `${stats.batchesFailed} 批失败，重跑同一命令续跑（已完成的块走缓存不重复调）` : "全部完成",
    stats, artifactPath: jsonPath, cachePath: jsonlPath,
  };
}

// ---------- 章摘要/书摘要 ----------
// 章批：每批 chaptersPerCall 个章，输入=该章的块摘要（超长截断）；对齐校验同块批（章名原样）。
export async function runSummaryPass(task, entriesMap, { chatFn = chat, config, chaptersPerCall = ENRICH_DEFAULTS.chaptersPerCall, onProgress = () => {} } = {}) {
  const chunkById = new Map(task.chunks.map(c => [c.idx, c]));   // 预建索引：条目×全书查找是 O(n²)
  const byChapter = new Map();
  for (const e of entriesMap.values()) {
    const c = chunkById.get(e.idx);
    if (!c) continue;
    if (!byChapter.has(c.chapter)) byChapter.set(c.chapter, []);
    byChapter.get(c.chapter).push(e);
  }
  const chapterSummaries = {};
  let calls = 0, failed = 0, usage = null;
  const names = [...byChapter.keys()];
  for (let i = 0; i < names.length; i += chaptersPerCall) {
    const group = names.slice(i, i + chaptersPerCall);
    const list = group.map(ch => `【${ch}】\n${byChapter.get(ch).map(e => e.summary || e.prefix).filter(Boolean).join("\n").slice(0, 4000)}`).join("\n\n");
    const r = await chatFn({
      ...config, temperature: 0.2, maxTokens: 2000, timeoutMs: 60000,
      messages: [
        { role: "system", content: "你是严谨的读书助手。用户给出一本书若干章节的块摘要，请为每个章节写一段 300 字以内的章节摘要。只输出一个 JSON 数组，不要任何其他内容，格式：[{\"chapter\":\"章节名（原样返回）\",\"summary\":\"…\"}]。铁律：chapter 必须原样返回；只依据给定摘要概括，不引用外部知识。" },
        { role: "user", content: `书名《${task.book.title || ""}》，共 ${group.length} 章：\n\n${list}` },
      ],
    });
    calls++;
    if (r.usage) usage = r.usage;
    if (!r.ok) { failed++; continue; }
    const arr = parseEnrich(r.text);
    if (!arr || arr.length !== group.length) { failed++; continue; }
    const want = new Set(group);
    const seen = new Set();
    let bad = false;
    for (const it of arr) {
      if (!it || typeof it.chapter !== "string" || !want.has(it.chapter) || seen.has(it.chapter)) { bad = true; break; }
      seen.add(it.chapter);
    }
    if (bad) { failed++; continue; }
    for (const it of arr) chapterSummaries[it.chapter] = cap(String(it.summary || "").trim(), ENRICH_DEFAULTS.chapterSummaryMax);
    onProgress({ phase: "chapter", done: Object.keys(chapterSummaries).length, total: names.length });
  }
  // 书摘要：一章一次，输入=全部章节摘要（超长截断）
  let bookSummary = "";
  const chapterList = Object.entries(chapterSummaries).map(([ch, s]) => `【${ch}】${s}`).join("\n").slice(0, ENRICH_DEFAULTS.bookInputMax);
  if (chapterList) {
    const r = await chatFn({
      ...config, temperature: 0.2, maxTokens: 800, timeoutMs: 60000,
      messages: [
        { role: "system", content: "你是严谨的读书助手。用户给出一本书的全部章节摘要，请写一段 500 字以内的全书摘要（这本书讲什么、覆盖哪些主题）。只依据给定摘要，不引用外部知识。直接输出摘要正文，不要 JSON、不要标题。" },
        { role: "user", content: `书名《${task.book.title || ""}》：\n\n${chapterList}` },
      ],
    });
    calls++;
    if (r.usage) usage = r.usage;
    if (r.ok) bookSummary = cap(String(r.text || "").trim(), ENRICH_DEFAULTS.bookSummaryMax);
    else failed++;
  }
  return { chapterSummaries, bookSummary, calls, failed, usage };
}

// ---------- 任务书导出（外部智能体通道；不需要 key） ----------
// 形状与 catalog-tasks 同构：instructions 是唯一真源，智能体照它产出 enrich-results/<同名>.json
export function buildEnrichTaskFile(dbPath, outDir) {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { readonly: true });
  let task;
  try { task = buildEnrichTasks(db); } finally { db.close(); }
  const dbName = path.basename(dbPath);
  const batches = makeBatches(task.chunks).map(b => b.map(c => ({ idx: c.idx, chapter: c.chapter, text: c.text })));
  const file = {
    version: 1,
    book: { db: dbName, title: task.book.title, content_hash: task.book.content_hash, chunk_count: task.book.chunk_count },
    instructions: [
      "为每个原文块产出四样：prefix（前置 1~2 句）/ tags（0~5 个，必须取自块内原文出现的字词，自造会被机器丢弃）/ questions（0~3 个假设问题）/ summary（块摘要 1~2 句）。",
      "输出一个 JSON 数组，每个元素 {\"idx\":块编号,\"prefix\":\"…\",\"tags\":[…],\"questions\":[…],\"summary\":\"…\"}；idx 必须与给定编号一一对应，不许增删合并。",
      "原文是繁体保持繁体；只依据块内容，不引用外部知识；无内容可提炼时给空值，绝不编造。",
    ],
    batches,
  };
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, dbName.replace(/\.db$/, "") + ".json");
  fs.writeFileSync(outPath, JSON.stringify(file, null, 1), "utf8");
  return { outPath, chunks: task.chunks.length, skipped: task.skipped, batches: batches.length };
}

// ---------- 外部结果验真（#137 入库前共用；与跑批通道同一套验真函数） ----------
// 返回 { entries, stats, errors }；errors 非空 = 拒收（一个字符都不入库）。
export function validateEnrichResult(result, task) {
  const errors = [];
  if (!result || typeof result !== "object") return { entries: [], stats: {}, errors: ["结果不是 JSON 对象"] };
  if (result.book?.content_hash && task.book.content_hash && result.book.content_hash !== task.book.content_hash) {
    errors.push(`content_hash 不一致（结果 ${result.book.content_hash} ≠ 书库 ${task.book.content_hash}）——书被重建过，结果作废`);
  }
  const list = Array.isArray(result.entries) ? result.entries : null;
  if (!list) return { entries: [], stats: {}, errors: [...errors, "结果缺少 entries 数组"] };
  const want = new Set(task.chunks.map(c => c.idx));
  const byIdx = new Map();
  let dup = 0, orphan = 0;
  for (const e of list) {
    if (!e || !Number.isInteger(e.idx)) { errors.push(`条目 idx 非法: ${JSON.stringify(e?.idx)}`); continue; }
    if (!want.has(e.idx)) { orphan++; continue; }
    if (byIdx.has(e.idx)) { dup++; continue; }
    byIdx.set(e.idx, e);
  }
  const entries = [];
  let tagsDropped = 0, tagsCapped = 0;
  for (const c of task.chunks) {
    const raw = byIdx.get(c.idx);
    if (!raw) continue;   // 缺号的块：不产条目（#137 入库时这些块就是「未覆盖」）
    const v = validateEnrichEntry(raw, c);
    entries.push(v.entry);
    tagsDropped += v.tagsDropped.length;
    tagsCapped += v.tagsCapped;
  }
  return {
    entries,
    stats: { total: task.chunks.length, covered: entries.length, dup, orphan, tagsDropped, tagsCapped },
    errors: [...errors, dup ? `重复 idx ${dup} 条（已按首条入账）` : "", orphan ? `越界 idx ${orphan} 条（块不存在，已忽略）` : ""].filter(Boolean),
  };
}
