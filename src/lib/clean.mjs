// 云端大模型全量清洗（clean-book，V3 第五波 C1）：本地规则层（structurize，管乱码/符号/空块）
// 之后的一道语义清洗关——逐批块调云端大模型，结合书画像判定「这本书该有的内容」vs
// 「与书无关/飘的/不知所云的外来污染」（论坛水贴/插楼回复/广告/楼层戳/导航噪音/串台）。
// 双通道与 enrich 同构：runClean 跑批产 JSON 判定清单（本模块，只读库不写库）→
// clean-import 落库（干净块留主库、垃圾块物理 DELETE + 隔离账 quarantine 落原文与理由）。
// 铁律（五道护栏落地）：
//   G1 实义短块保护：短块（<50 字符）且实义字符（汉字+ASCII 字母，数字不算）≥5 → LLM 说删也否决
//     ——「民為貴，君為輕」这类文言短句是核心语料不是垃圾；时间戳/点线目录/「哈哈哈」不触发
//   G2 引文/公式/代码保护：书名号、配对引号、数学符号、代码特征 → 否决（URL 不保护——广告常带）
//   G3 判不准默认 keep：drop 必须带合法 cat 枚举 + ≥4 字理由，否则降级 keep 记 guarded
//   G4 比率闸门（import 侧）：全书删除量 >40% 整单拒收（防模型抽风），20-40% 黄线警告
//   G5 隔离账（import 侧）：每条删除先落 quarantine（原文+理由）再 DELETE，可恢复
// 判定对齐铁律：返回条目必须带 idx 且与本批块集合**完全一致**（缺号/重号/越界整批拒收
// MISALIGN）——判定错位 = 把 keep 判到 drop 上，比 enrich 的串味更灾难，所以不做 position 兜底。
// 失败降级可续跑：网络/超时/坏 JSON → 该批记 failed，重跑只补失败批（JSONL 缓存断点续跑）。
// 例外穿层：CANCELLED（桌面取消闸门）必须向上抛——取消不是失败。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { chat, normalizeLlmConfig } from "./llm.mjs";
import { chunkFingerprint } from "./enrich.mjs";
const require = createRequire(import.meta.url);

export const CLEAN_DEFAULTS = {
  batchSize: 15,         // 每批块数（15 块 ≈ 8-10k in / ~0.8k out；判定输出短，批可以比 enrich 大）
  ctxBlocks: 2,          // 前后文参照块数（孤立看不懂的段落，放回上下文就能判）
  ctxSlice: 120,         // 前后文每块截断长度
  guardMinLen: 50,       // G1 短块上限（≥50 字符的长块不享受 G1 保护，交给 LLM 判）
  guardHan: 5,           // G1 实义字符阈值（汉字+ASCII 字母，**数字不算**——时间戳/楼号不算实义）
  smallBook: 8,          // 块数 < 8 视为夹具/非书，跳过清洗（不算失败）
  dropWarnMax: 0.20,     // G4 黄线：删除占比 >20% 落库但警告
  dropHardMax: 0.40,     // G4 硬线：删除占比 >40% 整单拒收（--force-gate 逃生）
  temperature: 0,        // 判定要稳定，零温度
  maxTokens: 1600,
  timeoutMs: 90000,
  profileTreeMax: 80,    // 章节树最多行数（巨书截断）
};

export const CLEAN_CATS = ["off_topic", "spam", "timestamp", "toc_noise", "ad", "nonsense"];
// v2（2026-10-19）：提示词改版——画像 pollution 成判据核心 + 论坛体专规（kk 实测 v1 全 keep，
// 纯插楼层/点线目录清不动）。版本号进缓存 meta 行，改版自动作废旧判定（loadCleanCache VERSION 判定）。
export const CLEAN_VERSION = 2;

// ---------- 任务读取（只读） ----------
// 与 enrich.buildEnrichTasks 同构；chapter_path 列探测式（老库无列回退 null）。
export function buildCleanTasks(db) {
  const cols = db.prepare("PRAGMA table_info(chunks)").all().map(c => c.name);
  const hasPath = cols.includes("chapter_path");
  const rows = db.prepare(
    `SELECT id, chapter, page, text${hasPath ? ", chapter_path" : ""} FROM chunks ORDER BY id`
  ).all();
  const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
  const chunks = rows.map(r => ({
    idx: r.id, chapter: r.chapter ?? "", chapter_path: r.chapter_path ?? null,
    page: r.page ?? null, text: r.text,
  }));
  return {
    book: {
      title: meta.title || "", content_hash: meta.content_hash || "",
      chunk_count: chunks.length, chunk_fp: chunkFingerprint(chunks),
    },
    chunks,
    meta,
  };
}

// 章节树：chapter_path（优先）→ chapter 去重保序，每行一条完整路径（自带层级，巨书截断）
export function buildChapterTree(chunks, { maxLines = CLEAN_DEFAULTS.profileTreeMax } = {}) {
  const seen = new Set();
  const lines = [];
  for (const c of chunks) {
    const label = c.chapter_path || c.chapter;
    if (!label || seen.has(label)) continue;
    seen.add(label);
    lines.push(label.trim());
    if (lines.length >= maxLines) { lines.push("…（更多章节省略）"); break; }
  }
  return lines.join("\n");
}

// 成本预估（跑批前打印 aids）：调用数 = 1 画像 + 批数
export function estimateClean(task, { batchSize = CLEAN_DEFAULTS.batchSize } = {}) {
  const batchCalls = Math.ceil(task.chunks.length / Math.max(1, batchSize));
  const inChars = task.chunks.reduce((a, c) => a + c.text.length, 0);
  return {
    chunks: task.chunks.length,
    batchCalls,
    calls: batchCalls + 1,
    estInputChars: inChars + batchCalls * 900 + 600,  // 批提示词（前后文+画像+指令）开销粗估
    estOutputChars: task.chunks.length * 30,           // 判定 JSON 粗估（keep 短 drop 长）
  };
}

// ---------- 书画像（第一次调用：书名+章节树 → 内容画像；失败降级 title_only） ----------
const SYSTEM_PROFILE = `你是中文图书编辑。根据书名和章节目录，判断这本书是什么、正文通常长什么样。只输出一个 JSON 对象，不要输出任何其他内容：
{"summary":"这本书讲什么（50字内）","typical":"正文块的典型样子（文体/人称/语言风格/典型长度，60字内）","pollution":["这本书可能混入的外来内容类型，如：论坛水贴/广告/导航菜单，0-4 项"]}`;

export function buildProfileMessages(title, treeText) {
  return [
    { role: "system", content: SYSTEM_PROFILE },
    { role: "user", content: `【书名】${title || "（未知）"}\n【章节目录】\n${treeText || "（无章节信息）"}` },
  ];
}

// 宽容解析画像（与 parseAnswer 同款对称截断；字段不合格 → null → 调用方降级）
export function parseProfile(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    const d = JSON.parse(t.slice(s, e + 1));
    if (!d || typeof d !== "object" || Array.isArray(d)) return null;
    if (typeof d.summary !== "string" || !d.summary.trim()) return null;
    if (typeof d.typical !== "string" || !d.typical.trim()) return null;
    return {
      summary: d.summary.trim().slice(0, 80),
      typical: d.typical.trim().slice(0, 120),
      pollution: (Array.isArray(d.pollution) ? d.pollution : [])
        .map(v => String(v || "").trim()).filter(Boolean).slice(0, 4),
    };
  } catch { return null; }
}

// ---------- 批组装（带前后文参照） ----------
export function makeCleanBatches(chunks, { batchSize = CLEAN_DEFAULTS.batchSize, ctxBlocks = CLEAN_DEFAULTS.ctxBlocks } = {}) {
  const n = Math.max(1, Math.floor(batchSize) || 1);
  const out = [];
  for (let i = 0; i < chunks.length; i += n) {
    const items = chunks.slice(i, i + n);
    out.push({
      items,
      prevCtx: chunks.slice(Math.max(0, i - ctxBlocks), i).map(c => c.text.slice(0, CLEAN_DEFAULTS.ctxSlice)),
      nextCtx: chunks.slice(i + n, i + n + ctxBlocks).map(c => c.text.slice(0, CLEAN_DEFAULTS.ctxSlice)),
    });
  }
  return out;
}

// ---------- 提示词（逐批判定；v2：画像 pollution 成判据核心，论坛体专规） ----------
const SYSTEM_CLEAN = `你是中文图书数据清洗员。给你一本书的内容画像（typical=这本书该有的内容形态，pollution=这本书不该有的污染形态）和一批连续文本块（编号 idx），附前后文参照。逐块判断它是不是「这本书该有的内容」。

判定以画像为准绳：
- 块的主体形态像 typical → keep。正文、对话、诗词、引文、公式、代码、注释、版权页、人名地名——书本身的一切内容，keep。
- 块的主体形态像 pollution → drop。画像把某种形态列进 pollution，就是在明确告诉你这本书要清掉它——不要替编辑心软。
- 拿不准：先问「这块的主体像 typical 还是像 pollution？」——主体像 pollution 就 drop，真看不出才 keep。

drop 只删「主体是污染」的整块：
- 论坛/社区类书：楼层时间戳（如 2010-08-15 14:03）、楼号（如 275楼）、「作者：xx 回复日期：xx」这类排版行是污染标记。块的主体若是读者的提问、感谢、插话、灌水（没有作者的实质论述）→ drop；作者（楼主）的回复或主贴哪怕混在块里也要保——那种块 keep。
- 广告、无关串台内容、纯导航点线目录（如「......44」）、完全不知所云的乱段 → drop。

铁律：
- 宁可漏删，绝不误删正文。每一块 drop 都必须能说出「这块主体是污染」的具体理由。
- 短的正文块（文言短句、诗句、定义、对话）是核心语料，绝不是垃圾。
- 只输出 JSON 数组，本批每个 idx 恰好一项，不得遗漏、不得增删：
[{"idx":0,"verdict":"keep"},{"idx":1,"verdict":"drop","cat":"spam","reason":"读者插楼灌水，无楼主内容"}]
- cat 只能是：off_topic / spam / timestamp / toc_noise / ad / nonsense。drop 必须带 cat 和 reason；keep 不带。`;

export function buildCleanMessages(bookTitle, profile, batch) {
  const profBlock = profile
    ? JSON.stringify(profile, null, 1)
    : "无画像，仅凭书名判断";
  const list = batch.items.map(c => {
    const loc = c.chapter_path || c.chapter;
    return `[idx ${c.idx}]${loc ? `《${loc}》` : ""}\n${c.text}`;
  }).join("\n\n");
  const parts = [
    `【书名】${bookTitle || "（未知）"}`,
    `【内容画像】${profBlock}`,
    batch.prevCtx.length ? `【前文参照】\n${batch.prevCtx.join("\n")}` : "",
    `【本批待判】（共 ${batch.items.length} 块）\n${list}`,
    batch.nextCtx.length ? `【后文参照】\n${batch.nextCtx.join("\n")}` : "",
  ];
  return [
    { role: "system", content: SYSTEM_CLEAN },
    { role: "user", content: parts.filter(Boolean).join("\n\n") },
  ];
}

// ---------- 宽容解析判定（数组；与 parseEnrich 同款对称截断，独立实现） ----------
export function parseCleanAnswer(text) {
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

// 判定对齐：每条必须带 idx 且集合与本批**完全一致**（无 position 兜底——判定错位=删错块）。
// verdict 大小写宽容（模型偶发输出 "KEEP"），归一化为小写。
export function matchVerdicts(rawList, batch) {
  const list = Array.isArray(rawList) ? rawList : [];
  const want = batch.items.map(c => c.idx);
  if (list.length !== want.length) return null;
  const seen = new Set();
  const byIdx = new Map();
  for (const r of list) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    if (!Number.isInteger(r.idx) || !want.includes(r.idx) || seen.has(r.idx)) return null;
    const v = String(r.verdict || "").trim().toLowerCase();
    if (v !== "keep" && v !== "drop") return null;
    seen.add(r.idx);
    byIdx.set(r.idx, { ...r, verdict: v });
  }
  return seen.size === want.length ? byIdx : null;
}

// ---------- 护栏 G1/G2/G3（代码层强制；LLM 说删 → 这里逐条复核） ----------
// G1 实义短块：实义字符 = 汉字 + ASCII 字母（数字不算——时间戳/楼号/页码不是实义）。
// 「民為貴，君為輕」=6 保护；「2010-09-06 21:33 1016楼」=1 不保护；「第一章……3」=3 不保护；
// 「哈哈哈」=3 不保护；「学习了谢谢楼主」=7 保护（宁误保护不误删——损失一个水贴席位 < 丢一段文言）。
export function isSubstantiveShort(text, { minLen = CLEAN_DEFAULTS.guardMinLen, minHan = CLEAN_DEFAULTS.guardHan } = {}) {
  const s = String(text || "");
  if (s.length >= minLen) return false;                       // 长块不享受 G1
  const meaningful = (s.match(/[\u4e00-\u9fffA-Za-z]/g) || []).length;
  return meaningful >= minHan;
}

// G2 引文/公式/代码特征：命中任一即保护。URL 故意不查——广告块常带 URL，保护了就删不掉。
export function hasQuotedOrCodeFeature(text) {
  const s = String(text || "");
  if (/《[^》]{1,60}》/.test(s)) return true;                          // 书名号
  const quotes = (s.match(/[「」『』""'']/g) || []).length;            // 配对引号（成对出现）
  if (quotes >= 2) return true;
  if (/[=±×÷∑∫≠≤≥√π∞ΔθαβλΩω→⇒]/.test(s)) return true;               // 数学/公式符号
  if (/\b(?:function|def|return|import|const|let|var|class)\b/.test(s)) return true;  // 代码关键字
  if (/\{[^{}\n]{1,80}\}/.test(s)) return true;                       // 花括号配对
  if (/^\s*\|.+\|\s*$/m.test(s)) return true;                         // Markdown 表格行
  return false;
}

// G3 drop 理由合格性：cat 枚举 + 理由 ≥4 字（去空白）。不合格 → 降级 keep。
export function isValidDropReason(v) {
  if (!v || typeof v !== "object") return false;
  if (!CLEAN_CATS.includes(String(v.cat || ""))) return false;
  const reason = String(v.reason || "").replace(/\s+/g, "");
  return reason.length >= 4;
}

// 护栏过闸：G2（特征）→ G1（短块）→ G3（理由）顺序复核，LLM 的 drop 被否决即降级 keep 并记 guarded。
// 返回 { verdicts: [{idx, verdict, cat?, reason?, guarded?}], guarded: [{idx, by, why}] }
export function applyGuards(byIdx, batch) {
  const verdicts = [], guarded = [];
  for (const c of batch.items) {
    const v = byIdx.get(c.idx);
    if (v.verdict !== "drop") { verdicts.push({ idx: c.idx, verdict: "keep" }); continue; }
    const whyG2 = hasQuotedOrCodeFeature(c.text) ? "含引文/公式/代码特征" : null;
    const whyG1 = !whyG2 && isSubstantiveShort(c.text) ? "实义短块（文言短句/定义类，宁可保留）" : null;
    const whyG3 = !whyG1 && !whyG2 && !isValidDropReason(v) ? "删除理由不合格（缺 cat 或理由空洞）" : null;
    const why = whyG1 || whyG2 || whyG3;
    if (why) {
      const by = whyG2 ? "G2" : whyG1 ? "G1" : "G3";
      verdicts.push({ idx: c.idx, verdict: "keep", guarded: true, by, why });
      guarded.push({ idx: c.idx, by, why });
    } else {
      verdicts.push({ idx: c.idx, verdict: "drop", cat: String(v.cat), reason: String(v.reason).trim() });
    }
  }
  return { verdicts, guarded };
}

// ---------- 单批：调云端 → 解析 → 对齐 → 护栏。不抛异常（CANCELLED 例外穿层） ----------
export async function cleanBatch(bookTitle, profile, batch, { chatFn = chat, config, ...opts } = {}) {
  const o = { ...CLEAN_DEFAULTS, ...opts };
  let r;
  try {
    r = await chatFn({
      ...config,
      temperature: o.temperature,
      maxTokens: o.maxTokens,
      timeoutMs: o.timeoutMs,
      messages: buildCleanMessages(bookTitle, profile, batch),
    });
  } catch (e) {
    if (e?.code === "CANCELLED") throw e;
    return { ok: false, code: "CHATERR", message: `模型调用抛出异常：${e?.message || e}` };
  }
  if (!r.ok) return { ok: false, code: r.code || "HTTP", message: r.message || "模型调用失败" };
  const rawList = parseCleanAnswer(r.text);
  if (!rawList) return { ok: false, code: "BADRESP", message: "模型未按 JSON 数组格式返回" };
  const byIdx = matchVerdicts(rawList, batch);
  if (!byIdx) return { ok: false, code: "MISALIGN", message: "返回条目的 idx 与本批块对不上（缺号/重号/越界/verdict 非法），整批拒收" };
  const { verdicts, guarded } = applyGuards(byIdx, batch);
  return { ok: true, verdicts, guarded, usage: r.usage || null };
}

// ---------- 结果文件：JSONL 追加缓存 + JSON 产物（与 enrich 同构） ----------
export function cleanResultPath(resultsDir, dbName) {
  return path.join(resultsDir, dbName.replace(/\.db$/, "") + ".jsonl");
}
export function cleanArtifactPath(resultsDir, dbName) {
  return path.join(resultsDir, dbName.replace(/\.db$/, "") + ".json");
}

// 读缓存：三种行 meta/ok/fail；坏行（半行/形状异常）静默跳过（V3R-D09 同款）。
// 三重 stale 判定（A7 铁律同款）：content_hash 不符 → HASH；chunk_fp 不符或缓存无指纹 → STRUCT；
// 缓存版本与当前 CLEAN_VERSION 不符 → VERSION（提示词改版后旧判定不许污染新判定）。
export function loadCleanCache(jsonlPath, contentHash, chunkFp) {
  const out = { verdicts: new Map(), failedBatches: [], hash: null, fp: null, ver: null, profile: null, profileMode: null, stale: false, staleReason: null };
  if (!fs.existsSync(jsonlPath)) return out;
  for (const line of fs.readFileSync(jsonlPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec == null || typeof rec !== "object" || Array.isArray(rec)) continue;
    if (rec.t === "meta") {
      if (typeof rec.content_hash === "string") out.hash = rec.content_hash;
      if (typeof rec.chunk_fp === "string") out.fp = rec.chunk_fp;
      if (Number.isInteger(rec.clean_version)) out.ver = rec.clean_version;
    } else if (rec.t === "profile") {
      if (rec.profile && typeof rec.profile === "object") { out.profile = rec.profile; out.profileMode = rec.mode || "profile"; }
    } else if (rec.t === "ok") {
      if (Array.isArray(rec.verdicts)) {
        for (const v of rec.verdicts) if (v && Number.isInteger(v.idx) && v.verdict) out.verdicts.set(v.idx, v);
      }
    } else if (rec.t === "fail") {
      if (Array.isArray(rec.idxs)) out.failedBatches.push(rec.idxs);
    }
  }
  const hashStale = !!contentHash && out.hash != null && out.hash !== contentHash;
  const fpStale = !!chunkFp && (out.fp == null || out.fp !== chunkFp);
  // 无版本标记（v1 旧格式缓存）也算 stale——「不可判即拒收」（A7 同款铁律），不放行
  const verStale = out.ver !== CLEAN_VERSION;
  out.stale = hashStale || fpStale || verStale;
  out.staleReason = hashStale ? "HASH" : fpStale ? "STRUCT" : verStale ? "VERSION" : null;
  return out;
}

function appendCache(jsonlPath, rec) {
  fs.appendFileSync(jsonlPath, JSON.stringify(rec) + "\n", "utf8");
}

// 压产物：verdicts 只落 drop 与 guarded-keep（纯 keep 不存——产物小、import 够用、审计聚焦）。
// drop 条目带 text_hash（sha256 截 16 hex）供 import 的 TAMPER 闸逐条复核「删的就是看的那块」。
export function textHash16(text) {
  return crypto.createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);
}

export function compactCleanArtifact(jsonlPath, jsonPath, { book, profile, profileMode, stats, verdicts, chunks }) {
  const cache = loadCleanCache(jsonlPath, book.content_hash);
  const all = (verdicts || [...cache.verdicts.values()]).slice().sort((a, b) => a.idx - b.idx);
  const textById = new Map((chunks || []).map(c => [c.idx, c.text]));
  const artifact = {
    version: CLEAN_VERSION,
    book: {
      db: book.db, title: book.title, content_hash: book.content_hash,
      chunk_count: book.chunk_count, chunk_fp: book.chunk_fp ?? null,
    },
    profile: profile || null, profile_mode: profileMode || null,
    stats: { ...stats, judged: all.length },
    // drop 带块原文哈希（import 的 TAMPER 闸逐条对账）；guarded-keep 带护栏标注（审计聚焦）
    verdicts: all.filter(v => v.verdict === "drop" || v.guarded)
      .map(v => v.verdict === "drop"
        ? { idx: v.idx, verdict: "drop", cat: v.cat, reason: v.reason, text_hash: textHash16(textById.get(v.idx) ?? "") }
        : { idx: v.idx, verdict: "keep", guarded: true, by: v.by, why: v.why }),
    failed_batches: cache.failedBatches,
    updated_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(artifact, null, 1), "utf8");
  return artifact;
}

// ---------- 跑批主编排（十步；与 runEnrich 同构） ----------
// 返回 { ok, skipped?, stats, artifactPath, cachePath, code?, message? }；配置错不炸直接回。
export async function runClean(dbPath, opts = {}) {
  const o = { ...CLEAN_DEFAULTS, ...opts };
  const chatFn = opts.chatFn || chat;
  const resultsDir = opts.resultsDir || path.join(process.cwd(), "clean-results");
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  const normCfg = normalizeLlmConfig(opts.config);
  if (normCfg.error) return { ok: false, code: "CONFIG", message: normCfg.error };
  if (!fs.existsSync(dbPath)) return { ok: false, code: "NOBOOK", message: `找不到书库 ${dbPath}` };

  const Database = require("better-sqlite3");
  let db;
  try { db = new Database(dbPath, { readonly: true }); }
  catch (e) { return { ok: false, code: "DBBROKEN", message: `书库打不开：${e.message}` }; }
  let task;
  try { task = buildCleanTasks(db); }
  catch (e) { return { ok: false, code: "DBBROKEN", message: `书库读不了（${e.message}）——缺 chunks 表或文件损坏` }; }
  finally { db.close(); }

  // 前门：小夹具不洗（不算失败）；已清洗过不重洗（--force 强制重跑）。
  // 不比指纹——import 删块后指纹必变，比了 already 永远不触发；结构变化由缓存 STALE 判定兜底。
  if (task.chunks.length < o.smallBook) {
    return { ok: true, skipped: "small", message: `仅 ${task.chunks.length} 块，太小不像书，跳过云端清洗`, stats: { chunks: task.chunks.length, dropped: 0, kept: task.chunks.length } };
  }
  if (!opts.force && task.meta.clean_at) {
    return { ok: true, skipped: "already", message: "这本书已清洗过（--force 强制重跑）", stats: { chunks: task.chunks.length, dropped: 0, kept: task.chunks.length } };
  }
  const dbName = path.basename(dbPath);
  const jsonlPath = cleanResultPath(resultsDir, dbName);
  const jsonPath = cleanArtifactPath(resultsDir, dbName);

  const cache = loadCleanCache(jsonlPath, task.book.content_hash, task.book.chunk_fp);
  if (cache.stale) {
    const why = cache.staleReason === "STRUCT"
      ? (cache.fp == null
        ? `缓存是旧格式（没有块结构指纹），无法判断与当前切片是否一致——书可能被重新加工过`
        : `缓存与当前书库的切片结构不一致（${cache.fp} → ${task.book.chunk_fp}）——书被重新加工过`)
      : cache.staleReason === "VERSION"
        ? (cache.ver == null
          ? `缓存是旧格式（无版本标记），无法确认判定与当前提示词（v${CLEAN_VERSION}）一致——请先移走 ${jsonlPath} 再跑`
          : `缓存是旧版提示词（v${cache.ver}）的判定，当前 v${CLEAN_VERSION} 已改版——请先移走 ${jsonlPath} 再跑`)
        : `缓存与当前书库内容不一致（content_hash 不同）——书被重建过`;
    return { ok: false, code: "STALE", message: `${why}，请先移走 ${jsonlPath} 再跑`, cachePath: jsonlPath };
  }
  if (cache.hash == null) {
    fs.mkdirSync(resultsDir, { recursive: true });
    appendCache(jsonlPath, { t: "meta", db: dbName, content_hash: task.book.content_hash, chunk_fp: task.book.chunk_fp, clean_version: CLEAN_VERSION, at: new Date().toISOString() });
  }

  // 画像：缓存 profile 行 > 生成（失败降级 title_only，不算整体失败）
  let profile = cache.profile, profileMode = cache.profileMode || (profile ? "profile" : null);
  if (!profile) {
    try {
      const pr = await chatFn({
        ...normCfg, temperature: o.temperature, maxTokens: 500, timeoutMs: o.timeoutMs,
        messages: buildProfileMessages(task.book.title, buildChapterTree(task.chunks)),
      });
      if (pr.ok) {
        const p = parseProfile(pr.text);
        if (p) {
          profile = p; profileMode = "profile";
          appendCache(jsonlPath, { t: "profile", profile: p, mode: "profile", at: new Date().toISOString() });
        }
      }
      if (pr.usage) { /* 画像 usage 并入 stats（下方初始化前无法累加，落 stats 后补） */ }
    } catch (e) {
      if (e?.code === "CANCELLED") throw e;   // 取消穿层；画像其余失败一律降级
    }
    if (!profile) profileMode = "title_only";
  }

  const batches = makeCleanBatches(task.chunks, o);
  const pending = batches.filter(b => b.items.some(c => !cache.verdicts.has(c.idx)));
  const stats = {
    chunks: task.chunks.length,
    batches: batches.length, batchesPending: pending.length, batchesFailed: 0,
    dropped: 0, kept: 0, guardedG1: 0, guardedG2: 0, guardedG3: 0,
    calls: 0, usageIn: 0, usageOut: 0, profileMode: profileMode || null,
  };
  for (const b of pending) {
    const r = await cleanBatch(task.book.title, profile, b, { chatFn, ...o, config: normCfg });
    stats.calls++;
    if (r.usage) { stats.usageIn += r.usage.prompt_tokens || 0; stats.usageOut += r.usage.completion_tokens || 0; }
    if (!r.ok) {
      stats.batchesFailed++;
      appendCache(jsonlPath, { t: "fail", idxs: b.items.map(c => c.idx), code: r.code, at: new Date().toISOString() });
      onProgress({ phase: "batch", ok: false, code: r.code, done: cache.verdicts.size, total: task.chunks.length });
      continue;
    }
    for (const v of r.verdicts) cache.verdicts.set(v.idx, v);
    // 补上重跑时缓存里已有判定、本轮没重算的块的统计
    appendCache(jsonlPath, { t: "ok", idxs: b.items.map(c => c.idx), verdicts: r.verdicts, at: new Date().toISOString() });
    onProgress({ phase: "batch", ok: true, done: cache.verdicts.size, total: task.chunks.length });
  }

  // 全量统计重算（续跑场景缓存里已有块不重算——从 cache.verdicts 全量数一遍，不怕重复计数）
  stats.dropped = 0; stats.kept = 0; stats.guardedG1 = 0; stats.guardedG2 = 0; stats.guardedG3 = 0;
  for (const v of cache.verdicts.values()) {
    if (v.verdict === "drop") stats.dropped++;
    else if (v.guarded) { if (v.by === "G1") stats.guardedG1++; else if (v.by === "G2") stats.guardedG2++; else stats.guardedG3++; }
    else stats.kept++;
  }

  compactCleanArtifact(jsonlPath, jsonPath, {
    book: { db: dbName, title: task.book.title, content_hash: task.book.content_hash, chunk_count: task.book.chunk_count, chunk_fp: task.book.chunk_fp },
    profile, profileMode, stats,
    verdicts: [...cache.verdicts.values()],
    chunks: task.chunks,
  });
  return {
    ok: stats.batchesFailed === 0,
    code: stats.batchesFailed ? "PARTIAL" : "OK",
    message: stats.batchesFailed ? `${stats.batchesFailed} 批失败，重跑同一命令续跑（已完成的块走缓存不重复调）` : "全部完成",
    stats, artifactPath: jsonPath, cachePath: jsonlPath,
  };
}
