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
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { chat, normalizeLlmConfig } from "./llm.mjs";
import { detectGarbled } from "./structurize.mjs";
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

// ---------- 块结构指纹与闸门阈值（V3 第四波 P4） ----------
// 指纹：逐块 [idx, 文本长度, 文本 sha1 前 8 位] 序列化后取 sha256 截 16 位。
// 存在意义：P3 改切片规则后源文件不变 → content_hash 相同 → 旧产物会按 idx
// 硬套新块、静默串味（条目对得上号、内容全错位）。任何一块的编号/长度/内容
// 变了指纹就变，STALE_STRUCT 有机器可判的判据。兼容：老产物无此字段时退化为
// chunk_count 比对（importEnrich 侧）。
export function chunkFingerprint(chunks) {
  const list = Array.isArray(chunks) ? chunks : [];
  const h = crypto.createHash("sha256");
  for (const c of list) {
    const text = String(c?.text ?? "");
    const id = c?.idx ?? c?.id ?? null;
    h.update(JSON.stringify([id, text.length, crypto.createHash("sha1").update(text).digest("hex").slice(0, 8)]));
    h.update("\n");
  }
  return h.digest("hex").slice(0, 16);
}

// 脏库上限（前门体检）：合格块里带乱码/控制符的占比超过此值 → 拒洗（DIRTY）。
// 逃生开关 BSP_ENRICH_DIRTY=0。实测依据（17 本真库只读扫）：16 本零乱码块，
// 最高 system-design-primer 0.08%（1/1188）——5% 离真实分布有 60 倍安全边际。
export const ENRICH_DIRTY_MAX = 0.05;

// 双档闸门阈值（黄线 warn=入库+标记 / 硬线 block=拒收）。环境变量可覆盖——
// 回归对比时不想改代码就能调档（BSP_GATE_COVERAGE_WARN 等）。
const gateNum = (envName, dflt) => {
  const v = process.env[envName];
  if (v == null || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
export function enrichGateThresholds() {
  return {
    coverageWarn: gateNum("BSP_GATE_COVERAGE_WARN", 0.95),
    coverageHard: gateNum("BSP_GATE_COVERAGE_HARD", 0.60),
    dropWarn: gateNum("BSP_GATE_DROP_WARN", 0.10),
    dropHard: gateNum("BSP_GATE_DROP_HARD", 0.50),
    summaryWarn: gateNum("BSP_GATE_SUMMARY_WARN", 0.20),
    summaryHard: gateNum("BSP_GATE_SUMMARY_HARD", 0.50),
  };
}

// 闸门评定（纯函数，不碰库不碰网）：入库前给产物判 pass/warn/block。
// 输入都是 importEnrich 事务前就算好的数（covered/tagsDropped/tagsKept/章摘要数），
// 阈值现读（env 可覆盖）。block 级任何一条命中即 block；否则 warn 级命中即 warn。
// 覆盖率按**合格块**算（短块不计入分母——论语 9/16 按总块数算只有 56% 会被误杀）。
export function evaluateEnrichGate(input = {}) {
  const th = enrichGateThresholds();
  const inp = input || {};   // null 也容错（lib 铁律：不抛）
  const eligible = Math.max(0, Number(inp.eligible) || 0);
  const covered = Math.max(0, Number(inp.covered) || 0);
  const tagsDropped = Math.max(0, Number(inp.tagsDropped) || 0);
  const tagsKept = Math.max(0, Number(inp.tagsKept) || 0);
  // 章摘要缺口：仅传入 chapterTotal>0 才参与判定（未开摘要/章摘要全失败时不冤枉）
  const chapterCount = Math.max(0, Number(inp.chapterCount) || 0);
  const chapterTotal = Math.max(0, Number(inp.chapterTotal) || 0);

  const coverage = eligible ? Math.min(1, covered / eligible) : 1;   // 0 合格块=无可洗对象，不误杀
  const dropRate = (tagsDropped + tagsKept) ? tagsDropped / (tagsDropped + tagsKept) : 0;
  const summaryGap = chapterTotal ? Math.min(1, 1 - chapterCount / chapterTotal) : null;

  const reasons = [];
  let verdict = "pass";
  const judge = (value, warn, hard, fmt) => {
    if (value > hard) { verdict = "block"; reasons.push(`硬线：${fmt(value)} > ${fmt(hard)}`); return; }
    if (value > warn) { if (verdict === "pass") verdict = "warn"; reasons.push(`黄线：${fmt(value)} > ${fmt(warn)}`); }
  };
  judge(coverage < 1 ? 1 - coverage : 0, 1 - th.coverageWarn, 1 - th.coverageHard, (v) => `合格块缺口 ${(v * 100).toFixed(0)}%`);
  judge(dropRate, th.dropWarn, th.dropHard, (v) => `标签丢弃率 ${(v * 100).toFixed(0)}%`);
  if (summaryGap != null) {
    judge(summaryGap, th.summaryWarn, th.summaryHard, (v) => `章摘要缺口 ${(v * 100).toFixed(0)}%`);
  }
  return {
    verdict,
    coverage: Number(coverage.toFixed(4)),
    dropRate: Number(dropRate.toFixed(4)),
    summaryGap: summaryGap == null ? null : Number(summaryGap.toFixed(4)),
    reasons,
  };
}

// 归一化：去空白与标点（标签回源比对用；Latin 大小写不敏感——"Docker" 命中 "docker"）
const norm = (s) => String(s || "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
const cap = (s, n) => (s.length > n ? s.slice(0, n) : s);

// ---------- 任务书 ----------
// 从书库读块（只读）。idx =  chunks.id（全局编号，提示词与缓存同一套编号空间，杜绝两套表错位）。
// P4：book.chunk_fp 块结构指纹、book.eligible 合格块数——随任务书/产物/缓存 meta 三处流转，
// 重新切片（结构变）有机器可判的判据，不再只靠 content_hash（源文件不变时它不变）。
export function buildEnrichTasks(db, { minChars = ENRICH_DEFAULTS.minChars } = {}) {
  const rows = db.prepare("SELECT id, chapter, page, text FROM chunks ORDER BY id").all();
  const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
  const chunks = rows.map(r => ({ idx: r.id, chapter: r.chapter ?? "", page: r.page ?? null, text: r.text }));
  const eligible = chunks.filter(c => c.text.length >= minChars);
  return {
    book: {
      title: meta.title || "", content_hash: meta.content_hash || "",
      chunk_count: chunks.length, chunk_fp: chunkFingerprint(chunks), eligible: eligible.length,
    },
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
// V3R-W5-1：chatFn 直接 throw（网络库 bug/测试注入）也按失败批处理——记 failed 可续跑，不穿层。
// 例外：CANCELLED（桌面取消闸门 guardChat 抛的）必须穿层——取消不是失败，见 enrich-job runPipeline。
export async function enrichBatch(batch, { chatFn = chat, config, ...opts } = {}) {
  const o = { ...ENRICH_DEFAULTS, ...opts };
  let r;
  try {
    r = await chatFn({
      ...config,
      temperature: o.temperature,
      maxTokens: o.maxTokens,
      timeoutMs: o.timeoutMs,
      messages: buildEnrichMessages(batch),
    });
  } catch (e) {
    if (e?.code === "CANCELLED") throw e;
    return { ok: false, code: "CHATERR", message: `模型调用抛出异常：${e?.message || e}` };
  }
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

// 读缓存：末条覆盖（重跑的批会追加新条）；返回 { entries: Map, failedBatches: number[][], hash, fp }
// V3R-D09（一般）：除半行损坏（JSON 解析失败）外，形状异常行（null 行/entries:null/条目无 idx/缺 idxs）
// 同样当坏行跳过——手改或裁剪过的缓存不该让 runEnrich 炸 TypeError 穿层
// P4：第三参 chunkFp 传入当前书库的块结构指纹；meta 行带 chunk_fp 且不符 → stale + reason:"STRUCT"
// （书被重新加工过，切片结构变了，旧缓存按 idx 硬套会串味——人话指「先移走缓存再跑」）。
// A7 修复（毛求疵对抗审查）：调用方传了 chunkFp 而 meta 行**没有** chunk_fp（P4 之前格式/
// meta 行整个缺失）→ 缓存结构不可判，同样 stale STRUCT——「无指纹」不等于「没变过」，
// 旧条目按 idx 硬套新块就是静默串味（实证：同 content_hash 重加工全链路）。两参旧调用
// （compactEnrichArtifact 的重读）不传 chunkFp → 不判结构，行为不变。
export function loadEnrichCache(jsonlPath, contentHash, chunkFp) {
  const out = { entries: new Map(), failedBatches: [], hash: null, fp: null };
  if (!fs.existsSync(jsonlPath)) return out;
  for (const line of fs.readFileSync(jsonlPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }   // 半行损坏（崩溃写入中）→ 跳过
    if (rec == null || typeof rec !== "object" || Array.isArray(rec)) continue;  // null/标量/数组行 → 跳过
    if (rec.t === "meta") {
      if (typeof rec.content_hash === "string") out.hash = rec.content_hash;
      if (typeof rec.chunk_fp === "string") out.fp = rec.chunk_fp;
    } else if (rec.t === "ok") {
      if (Array.isArray(rec.entries)) {
        for (const e of rec.entries) if (e && Number.isInteger(e.idx)) out.entries.set(e.idx, e);
      }
    } else if (rec.t === "fail") {
      if (Array.isArray(rec.idxs)) out.failedBatches.push(rec.idxs);
    }
  }
  const hashStale = !!contentHash && out.hash != null && out.hash !== contentHash;
  const fpStale = !!chunkFp && (out.fp == null || out.fp !== chunkFp);
  out.stale = hashStale || fpStale;
  out.staleReason = hashStale ? "HASH" : fpStale ? "STRUCT" : null;
  return out;
}

function appendCache(jsonlPath, rec) {
  fs.appendFileSync(jsonlPath, JSON.stringify(rec) + "\n", "utf8");
}

// 压成最终产物（外部智能体通道与 #137 入库都读这个 JSON）。
// entries 可由调用方传入（runEnrich 传的是已清孤儿条目的版本）；不传则从 JSONL 重读。
// P4：book 带 chunk_fp/eligible（老调用方不传则写 null——入库侧按「无指纹」走 chunk_count 兜底）。
export function compactEnrichArtifact(jsonlPath, jsonPath, { book, stats, entries: entriesIn }) {
  const cache = loadEnrichCache(jsonlPath, book.content_hash);
  const entries = (entriesIn || [...cache.entries.values()])
    .slice().sort((a, b) => a.idx - b.idx);
  const artifact = {
    version: 1,
    book: {
      db: book.db, title: book.title, content_hash: book.content_hash, chunk_count: book.chunk_count,
      chunk_fp: book.chunk_fp ?? null, eligible: book.eligible ?? null,
    },
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
  // V3R-D02（严重）：坏库（无 chunks 表等）→ DBBROKEN 返回，不裸抛穿层到 CLI/桌面
  try { task = buildEnrichTasks(db, { minChars: o.minChars }); }
  catch (e) { return { ok: false, code: "DBBROKEN", message: `书库读不了（${e.message}）——缺 chunks 表或文件损坏` }; }
  finally { db.close(); }

  const dbName = path.basename(dbPath);
  const jsonlPath = enrichResultPath(resultsDir, dbName);
  const jsonPath = enrichArtifactPath(resultsDir, dbName);

  // 前门体检（P4）：脏库拒洗——合格块里带乱码/控制符的占比 > ENRICH_DIRTY_MAX 就拒，
  // 在**任何云端调用之前**（e5 不加载，纯正则 O(总字符)，d2l 5506 块实测 19ms）。脏书洗数据
  // 等于把坏文本喂给云端、产出的标签/摘要全是垃圾。逃生开关 BSP_ENRICH_DIRTY=0。
  // 实测：17 本真库最高 0.08%，阈值 5% 有 60 倍安全边际（见 ENRICH_DIRTY_MAX 注释）。
  if (process.env.BSP_ENRICH_DIRTY !== "0" && task.chunks.length > 0) {
    let dirtyChunks = 0;
    for (const c of task.chunks) if (detectGarbled(c.text).bad > 0) dirtyChunks++;
    const dirtyRatio = dirtyChunks / task.chunks.length;
    if (dirtyRatio > ENRICH_DIRTY_MAX) {
      return {
        ok: false, code: "DIRTY",
        message: `这本书还有 ${(dirtyRatio * 100).toFixed(0)}% 的块带乱码/控制符（${dirtyChunks}/${task.chunks.length} 个合格块）——先重新加工（结构化改造）再洗数据，否则会把坏文本喂给云端`,
      };
    }
  }

  const cache = loadEnrichCache(jsonlPath, task.book.content_hash, task.book.chunk_fp);
  if (cache.stale) {
    const why = cache.staleReason === "STRUCT"
      ? (cache.fp == null
        ? `缓存是旧格式（没有块结构指纹），无法判断与当前切片是否一致——书可能被重新加工过`
        : `缓存与当前书库的切片结构不一致（块结构指纹 ${cache.fp} → ${task.book.chunk_fp}）——书被重新加工过`)
      : `缓存与当前书库内容不一致（content_hash 不同）——书被重建过`;
    return { ok: false, code: "STALE", message: `${why}，请先移走 ${jsonlPath} 再跑`, cachePath: jsonlPath };
  }
  if (cache.hash == null) {
    fs.mkdirSync(resultsDir, { recursive: true });
    appendCache(jsonlPath, { t: "meta", db: dbName, content_hash: task.book.content_hash, chunk_fp: task.book.chunk_fp, at: new Date().toISOString() });
  }

  const validIdx = new Set(task.chunks.map(c => c.idx));
  for (const idx of cache.entries.keys()) if (!validIdx.has(idx)) cache.entries.delete(idx);  // 孤儿条目（块已不存在）

  const batches = makeBatches(task.chunks, o.batchSize);
  const pending = batches.filter(b => b.some(c => !cache.entries.has(c.idx)));
  const stats = {
    chunks: task.chunks.length, skipped: task.skipped, chapters: new Set(task.chunks.map(c => c.chapter)).size,
    batches: batches.length, batchesPending: pending.length, batchesFailed: 0,
    tagsDropped: 0, tagsCapped: 0, calls: 0, usageIn: 0, usageOut: 0, summariesFailed: 0,
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
    // V3R-D11：章/书摘要失败数进 stats（artifact.stats 同带）——「失败机器可验」不打折；
    // usage 逐次累加（旧代码只留最后一次调用，token 少计）
    stats.summariesFailed = summaries.failed;
    stats.usageIn += summaries.usageIn;
    stats.usageOut += summaries.usageOut;
  }

  const artifact = compactEnrichArtifact(jsonlPath, jsonPath, {
    book: {
      db: dbName, title: task.book.title, content_hash: task.book.content_hash,
      chunk_count: task.book.chunk_count, chunk_fp: task.book.chunk_fp, eligible: task.book.eligible,
    },
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
  let calls = 0, failed = 0, usageIn = 0, usageOut = 0;
  const names = [...byChapter.keys()];
  for (let i = 0; i < names.length; i += chaptersPerCall) {
    const group = names.slice(i, i + chaptersPerCall);
    const list = group.map(ch => `【${ch}】\n${byChapter.get(ch).map(e => e.summary || e.prefix).filter(Boolean).join("\n").slice(0, 4000)}`).join("\n\n");
    let r;
    try {
      r = await chatFn({
        ...config, temperature: 0.2, maxTokens: 2000, timeoutMs: 60000,
        messages: [
          { role: "system", content: "你是严谨的读书助手。用户给出一本书若干章节的块摘要，请为每个章节写一段 300 字以内的章节摘要。只输出一个 JSON 数组，不要任何其他内容，格式：[{\"chapter\":\"章节名（原样返回）\",\"summary\":\"…\"}]。铁律：chapter 必须原样返回；只依据给定摘要概括，不引用外部知识。" },
          { role: "user", content: `书名《${task.book.title || ""}》，共 ${group.length} 章：\n\n${list}` },
        ],
      });
    } catch (e) {
      if (e?.code === "CANCELLED") throw e;   // 取消穿层（同 enrichBatch 例外）
      failed++; continue;                      // 其余异常按该章批失败降级，不穿层
    }
    calls++;
    // V3R-D11：usage 逐次累加（旧代码整体覆盖只留最后一次，token 少计）
    if (r.usage) { usageIn += r.usage.prompt_tokens || 0; usageOut += r.usage.completion_tokens || 0; }
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
    let r;
    try {
      r = await chatFn({
        ...config, temperature: 0.2, maxTokens: 800, timeoutMs: 60000,
        messages: [
          { role: "system", content: "你是严谨的读书助手。用户给出一本书的全部章节摘要，请写一段 500 字以内的全书摘要（这本书讲什么、覆盖哪些主题）。只依据给定摘要，不引用外部知识。直接输出摘要正文，不要 JSON、不要标题。" },
          { role: "user", content: `书名《${task.book.title || ""}》：\n\n${chapterList}` },
        ],
      });
    } catch (e) {
      if (e?.code === "CANCELLED") throw e;   // 取消穿层（同 enrichBatch 例外）
      failed++; r = null;                      // 书摘要失败不阻断（块/章摘要在缓存里）
    }
    if (r) {
      calls++;
      if (r.usage) { usageIn += r.usage.prompt_tokens || 0; usageOut += r.usage.completion_tokens || 0; }
      if (r.ok) bookSummary = cap(String(r.text || "").trim(), ENRICH_DEFAULTS.bookSummaryMax);
      else failed++;
    }
  }
  return { chapterSummaries, bookSummary, calls, failed, usageIn, usageOut };
}

// ---------- 任务书导出（外部智能体通道；不需要 key） ----------
// 形状与 catalog-tasks 同构：instructions 是唯一真源，智能体照它产出 enrich-results/<同名>.json
// V3R-D06（严重）：坏库（无 chunks 表/垃圾文件）→ 返回 {error,message,hint}，不裸抛（lib 铁律）
export function buildEnrichTaskFile(dbPath, outDir) {
  const Database = require("better-sqlite3");
  let db;
  try { db = new Database(dbPath, { readonly: true }); }
  catch (e) {
    return { error: true, message: `书库打不开：${e.message}`, hint: "确认这是 book-skill-platform 建的书库（.db 文件），不是随便一个数据库" };
  }
  let task;
  try { task = buildEnrichTasks(db); }
  catch (e) {
    return { error: true, message: `书库读不了：${e.message}`, hint: "缺 chunks 表或文件损坏——先跑 embed-book 建库，或换一个有效的书库" };
  } finally { db.close(); }
  const dbName = path.basename(dbPath);
  const batches = makeBatches(task.chunks).map(b => b.map(c => ({ idx: c.idx, chapter: c.chapter, text: c.text })));
  const file = {
    version: 1,
    book: {
      db: dbName, title: task.book.title, content_hash: task.book.content_hash, chunk_count: task.book.chunk_count,
      chunk_fp: task.book.chunk_fp, eligible: task.book.eligible,
    },
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
// 返回 { entries, stats, errors }。V3R-D12（一般）：旧注释「errors 非空 = 拒收」与行为不符——
// errors 实为「提醒级」：importEnrich 把它们当 warnings 照常入库（缺号块留 NULL 报覆盖率、
// 坏 idx 条目不写、重号按首条），硬拒收只有调用方的 content_hash 不符（STALE）。注释与代码对齐，防误导接班人。
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
