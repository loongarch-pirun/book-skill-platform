// 洗数据一键入口（V3 第二波 #140）：书架卡片「洗数据」按钮 → runEnrich 应用内通道
//   （llm.json 里配好的 key）→ importEnrich 自动入库 → 完成态带统计。
// 模式完全复刻 jobs.mjs（导入管线）：状态 Map + emit/onEnrichProgress 订阅出海
//   → 主进程转发 enrich:progress 事件 → 书架卡片横幅（renderer 汇进同一个 state.jobs）。
// 铁律：
//   - 前置失败（无 key/书不在/正在导入/STALE）抛 UserError 人话（IPC → {ok:false} → toast）；
//   - 后台跑批失败绝不 throw 穿层——落 failed 态进横幅（lib 层铁律同款）；
//   - 检索算法一行不碰：只调 runEnrich/importEnrich/auditEnrich 三个 lib 入口；
//   - 产物落 <书库上级>/enrich-results/（与 catalog 任务书同构：迁库一起走；
//     dev 态即项目根/enrich-results，与 CLI 默认同址——两处跑的缓存互通，断点续跑不分通道）。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { runEnrich, buildEnrichTasks, estimateEnrich } from "../lib/enrich.mjs";
import { importEnrich, auditEnrich } from "../lib/enrich-import.mjs";
import { listBooks, currentLibDir } from "../lib/search.mjs";
import { chat } from "../lib/llm.mjs";
import { loadLlmConfig, readLlmKey } from "./llm-config.mjs";
import { UserError } from "./engine.mjs";
import * as jobs from "./jobs.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

// ---------- 任务注册表 + 进度订阅（jobs.mjs 同款；bookId 不会两边同时在跑，见 startEnrich 守卫） ----------
const enrichJobs = new Map();   // bookId → { stage, label, detail, error, kind:"enrich", startedAt, stats? }
const cancelled = new Set();
const subs = new Set();

// 事件/状态出海前拷贝（本任务无 child，但拷贝一层防调用方 mutate 注册表）
const plain = (j) => ({ ...j });

function emit(bookId, patch) {
  const j = enrichJobs.get(bookId) || { stage: "enrich", kind: "enrich", startedAt: Date.now() };
  Object.assign(j, patch, { bookId, kind: "enrich" });
  enrichJobs.set(bookId, j);
  for (const fn of subs) { try { fn(plain(j)); } catch { /* 订阅者崩不拖垮管线 */ } }
}
export function enrichStatus() { return Object.fromEntries([...enrichJobs].map(([k, v]) => [k, plain(v)])); }
export function onEnrichProgress(fn) { subs.add(fn); return () => subs.delete(fn); }

// ---------- 内部工具 ----------
// 产物目录：<书库上级>/enrich-results（dev 态 = 项目根/enrich-results，与 CLI 默认同址）
function resultsDirOf() { return path.join(currentLibDir(), "..", "enrich-results"); }

function findBookDb(bookId) {
  const id = String(bookId || "");
  const b = listBooks(currentLibDir(), { includeDisabled: true }).find((x) => x.id === id);
  if (!b) throw new UserError(`书库里找不到「${id || "?"}」`);
  if (!fs.existsSync(b.db)) throw new UserError(`书库文件不见了：${b.db}`);
  return b;
}

// 成本预估（开一次只读库）：块数/章数/云端调用次数——启动时回给 UI，用户知道约多少批
function estimateFor(dbPath) {
  let db;
  try { db = new Database(dbPath, { readonly: true }); }
  catch { return null; }
  try { return estimateEnrich(buildEnrichTasks(db)); }
  catch { return null; }
  finally { db.close(); }
}

const pct = (a, b) => ((a / Math.max(1, b)) * 100).toFixed(0);

// ---------- 启动：前置检查（人话错误）→ 后台跑批（立即返回，进度走事件） ----------
// opts 仅测试注入用（chatFn）；生产不传。
export async function startEnrich(bookId, opts = {}) {
  const b = findBookDb(bookId);
  const cur = enrichJobs.get(b.id);
  if (cur && !["done", "failed", "cancelled"].includes(cur.stage)) {
    throw new UserError(`《${b.title}》正在洗数据中（${cur.label || cur.stage}），稍候或先取消`);
  }
  // 同一本书正在导入（切片/向量化/编目中）→ 拒：库在写，只读开会 SQLITE_BUSY
  const imp = jobs.jobsStatus()[b.id];
  if (imp && !["done", "failed", "catalog", "cancelled"].includes(imp.stage)) {
    throw new UserError(`《${b.title}》正在导入中（${imp.label || imp.stage}）——等导入完成再洗`);
  }
  // key 检查：没配 → 指路问一问页（"不填 key 零变化"——按钮点了也只是人话提示，不炸不静默）
  const cfg = loadLlmConfig();
  const key = readLlmKey();
  if (!key) {
    throw new UserError("还没配云端 AI——去「问一问」页填 API key 就能一键洗数据（洗数据要走云端，检索永远在本机）");
  }
  const config = { baseUrl: cfg.baseUrl, apiKey: key, model: cfg.model };

  const estimate = estimateFor(b.db);
  cancelled.delete(b.id);
  emit(b.id, { stage: "enrich", label: "洗数据中", detail: "准备批次…", error: null, stats: null });
  // 后台跑（不 await：长任务几分钟到几十分钟，IPC 通道不能挂着）
  void runPipeline(b, config, opts).catch((e) => {
    // 兜底：runPipeline 内部已全兜，这里只防万一（绝不 throw 穿层）
    emit(b.id, { stage: "failed", label: "洗数据失败", error: e?.message || "未知错误" });
  });
  return { started: true, bookId: b.id, estimate };
}

// 后台主管线：跑批 → 自动入库。任何失败落 failed 态，不 throw。
async function runPipeline(b, config, opts) {
  const id = b.id;
  // 取消闸门：包一层 chatFn——已取消就不再发云端请求（抛穿 runEnrich 的批循环，
  // 由下面 catch 落 cancelled 态；已写盘的 ok 批在 JSONL 缓存里，重跑接着来不断点）
  const guardChat = async (req) => {
    if (cancelled.has(id)) { const e = new Error("已取消"); e.code = "CANCELLED"; throw e; }
    return opts.chatFn ? opts.chatFn(req) : chat(req);
  };
  try {
    const r = await runEnrich(b.db, {
      config,
      chatFn: guardChat,
      resultsDir: resultsDirOf(),
      summaries: process.env.BSP_SUMMARY !== "0", // BSP_SUMMARY=0 只洗块不产章/书摘要
      onProgress: (p) => {
        if (cancelled.has(id)) return;
        if (p.phase === "batch") {
          emit(id, {
            stage: "enrich",
            label: "洗数据中",
            detail: p.ok === false
              ? `这一批失败（${p.code || "?"}），已洗 ${p.done}/${p.total} 块`
              : `已洗 ${p.done}/${p.total} 块`,
          });
        } else if (p.phase === "chapter") {
          emit(id, { stage: "enrich", label: "写章摘要", detail: `${p.done}/${p.total} 章` });
        }
      },
    });
    if (cancelled.has(id)) throw Object.assign(new Error("已取消"), { code: "CANCELLED" });
    if (!r.ok) {
      // STALE/CONFIG/NOBOOK 等人的消息直接进横幅（runEnrich 的 message 已带修复指引）
      emit(id, { stage: "failed", label: "洗数据失败", error: r.message, code: r.code });
      return;
    }
    emit(id, { stage: "import", label: "入库中", detail: "验真 → 写库（原文一字不改）", error: null });
    const imp = importEnrich(b.db, r.artifactPath, {
      onProgress: (p) => emit(id, { stage: "import", label: "入库中", detail: `写库 ${p.done}/${p.total}` }),
    });
    if (!imp.ok) {
      emit(id, { stage: "failed", label: "入库失败", error: imp.message, code: imp.code });
      return;
    }
    const s = imp.stats;
    emit(id, {
      stage: "done", label: "完成",
      detail: `覆盖 ${s.imported}/${s.eligible}（${pct(s.imported, s.eligible)}%） · 标签 ${s.tags} · 摘要 ${s.chapterSummaries} 章${s.bookSummary ? "+全书" : ""}`,
      stats: s, artifactPath: r.artifactPath, error: null,
    });
  } catch (e) {
    if (cancelled.has(id) || e?.code === "CANCELLED") {
      // 取消不是失败：从注册表撤掉（与 jobs.mjs cancelImport 同款——不留完成态残影）
      enrichJobs.delete(id);
      cancelled.delete(id);
      for (const fn of subs) { try { fn({ bookId: id, stage: "cancelled", kind: "enrich" }); } catch { /* 同上 */ } }
      return;
    }
    emit(id, { stage: "failed", label: "洗数据失败", error: e?.message || "未知错误" });
  }
}

// ---------- 取消：无子进程可杀——闸门在 chatFn 包装（下一批不再发请求） ----------
// 已在路上的那一批最多等一个超时（60s）；说明写清楚，不装快。
export function cancelEnrich(bookId) {
  const id = String(bookId || "");
  const j = enrichJobs.get(id);
  if (!j || ["done", "failed", "cancelled"].includes(j.stage)) {
    return { cancelled: false, note: "没有进行中的洗数据" };
  }
  cancelled.add(id);
  return { cancelled: true, note: "已取消——正在路上的那一批跑完就停（最多约 1 分钟），已洗好的块在缓存里，重跑接着来" };
}

// ---------- 库侧复查（只读）：回源率/覆盖率/三级摘要计数/原文指纹 ----------
export function enrichAudit(bookId) {
  const b = findBookDb(bookId);
  return auditEnrich(b.db);
}
