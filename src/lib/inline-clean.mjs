// 行级清洗核心（inline-clean）：clean-book「整块判、整块删」之后的块内净化关。
//   治四类行级噪音 + 跟帖问/答分离（规则切分，LLM 兜底另册）：
//     页码行（块首/尾孤立数字）· 楼层号（孤立「N楼」行）· 跟帖署名（•用户+日期 / 作者：X回复日期）· 结构分隔线（——— === ~~~ ---）
//   L1 只删行（strip），L2 只切不删（split：主帖段留原块，跟帖段切新块——2a 策略，老板 2026-10-20 拍板）。
// 位次：build → clean（整块删）→ inline-clean（块内净化）→ embed → enrich。必须在 embed 前：改 text/切块都作废向量。
// 护栏（与 clean-book 五护栏同哲学）：
//   I1 strip 后剩余 <20 字（块被删成空气）→ 拒收该块（降级 keep 交人工看）；
//   I2 切出的跟帖段 <20 字丢弃（无检索价值）；主帖段 <30 字不切（切了没意义）；
//   I3 判不准 keep（LLM 兜底拿不准的原样保留）；
//   I4 整书净化率闸：删行字数占比 >40% 拒收、>25% 警告（--force-gate 双 flag 强过）；
//   I6 版本闸：INLINE_VERSION 写 meta；改规则必须 bump；缓存行无标记 = stale。
// 「楼主」开头行是正文（kk 实测 174 行）——所以所有规则全部行级 trim 后整行匹配，绝不子串删。
// I1 为何按「剩余字数」不按「删行占比」：所有删除都命中确认的结构行正则（不存在误删正文的路径），
// 真正的风险是 strip 后块成空气——kk 实测「整块皆跟帖」的块删行 35% 但剩余仍有百字跟帖正文，
// 按行数占比会误拦（2026-10-20 实测修正）。
// **顺序关键**：必须先在原文上找跟帖边界切段，再对各段删行——反过来先删行会把署名边界删掉，切分失效。
import crypto from "node:crypto";
import { buildCleanTasks } from "./clean.mjs";
import { bookTokenTotal, detectLang } from "./token-estimate.mjs";

export const INLINE_VERSION = 1;

export const INLINE_DEFAULTS = {
  minRemainChars: 20,       // I1：strip 后剩余字数下限（低于此 = 块被删成空气，拒收交人工）
  minReplyChars: 20,        // I2：跟帖段短于此丢弃
  minMainChars: 30,         // I2：主帖段短于此不切
  gateWarn: 0.25,           // I4 黄线（删行字数/全书字数；论坛体署名行占比天然高，对齐 clean-book 20→25 放宽）
  gateHard: 0.4,            // I4 硬线（与 clean-book dropHardMax 对齐）
};

const gateNum = (envName, dflt) => {
  const v = process.env[envName];
  if (v == null || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
export function inlineGateThresholds() {
  return {
    warn: gateNum("BSP_INLINE_GATE_WARN", INLINE_DEFAULTS.gateWarn),
    hard: gateNum("BSP_INLINE_GATE_HARD", INLINE_DEFAULTS.gateHard),
  };
}

// ---------- L1 行级噪音（trim 后整行匹配） ----------
// page 只对段首/段尾行生效（段中部孤立数字可能是正文编号或数据，保守不碰）
const NOISE_PATTERNS = [
  { cat: "floor", re: /^\d{1,4}楼$/, edge: null },
  { cat: "sign-bullet", re: /^[•·]\S{1,24}\d{4}-\d{2}-\d{2}[\d: ]*$/, edge: null },
  { cat: "sign-author", re: /^作者[:：].*回复日期.*$/, edge: null },
  { cat: "sep", re: /^[—=~\-_]{6,}$/, edge: null },
  { cat: "page", re: /^\d{1,4}$/, edge: true },
];

// ---------- L2 跟帖边界（行级强信号，kk 实测覆盖 60.1% 块） ----------
// 边界行本身是噪音（署名行，随段切掉），其后的内容是新跟帖段的起点。
const REPLY_BOUNDARY = [
  /^作者[:：].*回复日期.*$/,
  /^[•·]\S{1,24}\d{4}-\d{2}-\d{2}[\d: ]*$/,
];

export function textHash16(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 16);
}

// 单段 L1：删行级噪音。返回 { text, removed: [{cat, chars}], removedLines, totalLines, boundaryChars }
// boundaryChars：段首是跟帖边界行时，该行被切掉不算噪音删除，单列。
function stripSegment(rawLines) {
  const removed = [];
  const kept = [];
  let boundaryChars = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const t = rawLines[i].trim();
    const isEdge = i === 0 || i === rawLines.length - 1;
    const hit = NOISE_PATTERNS.find(p => (!p.edge || isEdge) && p.re.test(t));
    if (hit) removed.push({ cat: hit.cat, chars: rawLines[i].length });
    else kept.push(rawLines[i]);
  }
  return { text: kept.join("\n"), removed, removedLines: removed.length, totalLines: rawLines.length, boundaryChars };
}

// 公开包装：单块 L1（无切段场景）。返回 { text, removed, removedLines, totalLines }。
export function stripNoiseLines(text) {
  const s = stripSegment(String(text).split("\n"));
  return { text: s.text, removed: s.removed, removedLines: s.removedLines, totalLines: s.totalLines };
}

// 单块 L2：在**原文**上按跟帖边界切段。返回 [{kind, text(原文段), boundaryLineChars}] 或 null。
export function splitByReplyBoundary(rawText) {
  const lines = String(rawText).split("\n");
  const cutIdx = [];
  for (let i = 1; i < lines.length; i++) {           // 第 0 行不可能是跟帖起点（块首是主帖）
    const t = lines[i].trim();
    if (REPLY_BOUNDARY.some(re => re.test(t))) cutIdx.push(i);
  }
  if (!cutIdx.length) return null;
  const bounds = [...cutIdx, lines.length];
  const segments = [];
  for (let s = 0; s < bounds.length; s++) {
    const start = s === 0 ? 0 : bounds[s - 1];
    const end = bounds[s];
    const raw = lines.slice(start, end);
    // 跟帖段首行是边界行（署名），切掉
    const body = s === 0 ? raw : raw.slice(1);
    if (body.join("").trim()) segments.push({ kind: s === 0 ? "main" : "reply", lines: body, boundaryChars: s === 0 ? 0 : (raw[0]?.length || 0) });
  }
  return segments.length > 1 ? segments : null;
}

// 单块完整计划：先切段（原文上）后删行（各段内）。返回 { action, after, replies, removed, removedChars, guarded, why }
// action: 'keep'（原样） | 'strip'（只删行） | 'split'（删行+切跟帖）
export function planBlock(rawText, opts = {}) {
  const d = { ...INLINE_DEFAULTS, ...opts };
  const raw = String(rawText);
  const segs = splitByReplyBoundary(raw);
  const removedAll = [];
  const push = (r) => { for (const x of r.removed) removedAll.push(x); };
  const sumChars = (extra) => removedAll.reduce((a, x) => a + x.chars, 0) + (extra || 0);

  if (!segs) {
    const s = stripSegment(raw.split("\n"));
    push(s);
    if (s.removedLines === 0) return { action: "keep", after: raw, replies: [], removed: [], removedChars: 0, removedLines: 0, beforeChars: raw.length, guarded: null };
    // I1：strip 后块被删成空气 → 拒收交人工（删除全部命中结构正则，无正文误删路径）
    if (s.text.trim().length < d.minRemainChars) {
      return { action: "keep", after: raw, replies: [], removed: [], removedChars: 0, removedLines: 0, beforeChars: raw.length, guarded: "I1", why: `净化后只剩 ${s.text.trim().length} 字（< ${d.minRemainChars}），块被删成空气，整块拒收` };
    }
    return { action: "strip", after: s.text.trim(), replies: [], removed: removedAll, removedChars: sumChars(), removedLines: s.removedLines, beforeChars: raw.length, guarded: null };
  }

  const strippedSegs = segs.map(g => ({ kind: g.kind, ...stripSegment(g.lines), boundaryChars: g.boundaryChars }));
  const main = strippedSegs.find(g => g.kind === "main");
  const replySegs = strippedSegs.filter(g => g.kind === "reply");
  const mainText = main ? main.text.trim() : "";
  // I2：主帖段太短 → 不切，退化为 strip（跟帖段并回原块，内容不丢——不算「删除」）
  if (!mainText || mainText.length < d.minMainChars) {
    if (replySegs.length === 0 && strippedSegs.every(g => g.removedLines === 0)) {
      return { action: "keep", after: raw, replies: [], removed: [], removedChars: 0, removedLines: 0, beforeChars: raw.length, guarded: null };
    }
    const joined = strippedSegs.map(g => g.text).join("\n").trim();
    // I1：净化后块成空气 → 拒收交人工
    if (joined.length < d.minRemainChars) {
      return { action: "keep", after: raw, replies: [], removed: [], removedChars: 0, removedLines: 0, beforeChars: raw.length, guarded: "I1", why: `净化后只剩 ${joined.length} 字（< ${d.minRemainChars}），块被删成空气，整块拒收` };
    }
    for (const g of strippedSegs) push(g);
    return {
      action: "strip", after: joined, replies: [],
      removed: removedAll, removedChars: sumChars(strippedSegs.reduce((a, g) => a + g.boundaryChars, 0)),
      removedLines: strippedSegs.reduce((a, g) => a + g.removedLines, 0), beforeChars: raw.length, guarded: null,
    };
  }
  // I2：跟帖段短于下限丢弃
  const keptReplies = replySegs.filter(g => g.text.trim().length >= d.minReplyChars).map(g => g.text.trim());
  const droppedReplies = replySegs.filter(g => g.text.trim().length < d.minReplyChars);
  for (const g of strippedSegs) push(g);
  return {
    action: keptReplies.length ? "split" : "strip",
    after: mainText, replies: keptReplies,
    removed: removedAll,
    removedChars: sumChars(strippedSegs.reduce((a, g) => a + g.boundaryChars, 0) + droppedReplies.reduce((a, g) => a + g.text.length + g.boundaryChars, 0)),
    removedLines: strippedSegs.reduce((a, g) => a + g.removedLines, 0) + droppedReplies.length,
    beforeChars: raw.length, guarded: null,
  };
}

// 全书只读扫描产计划。db 必须 readonly 打开。返回 { ok, blocks, stats, book }；不抛异常。
export function buildInlinePlan(db, opts = {}) {
  try {
    const task = buildCleanTasks(db);
    const blocks = [];
    const stats = { total: 0, keep: 0, strip: 0, split: 0, guardedI1: 0, removedLines: 0, removedChars: 0, newChunks: 0, beforeChars: 0, afterChars: 0 };
    for (const c of task.chunks) {
      const p = planBlock(c.text, opts);
      const replyChars = p.replies.reduce((a, r) => a + r.length, 0);
      blocks.push({
        id: c.idx, chapter: c.chapter || null, chapter_path: c.chapter_path ?? null, page: c.page ?? null,
        text_hash: textHash16(c.text), action: p.action, after: p.after, replies: p.replies,
        removed: p.removed, removedLines: p.removedLines, removedChars: p.removedChars,
        beforeChars: p.beforeChars, afterChars: p.action === "keep" ? p.beforeChars : p.after.length + replyChars,
        guarded: p.guarded, why: p.why || null,
      });
      stats.total++;
      stats[p.action]++;
      if (p.guarded) stats.guardedI1++;
      stats.removedLines += p.removedLines;
      stats.removedChars += p.removedChars;
      stats.newChunks += p.replies.length;
      stats.beforeChars += p.beforeChars;
      stats.afterChars += blocks[blocks.length - 1].afterChars;
    }
    const ratio = stats.beforeChars ? stats.removedChars / stats.beforeChars : 0;
    return { ok: true, blocks, stats: { ...stats, cleanRatio: Number(ratio.toFixed(4)) }, book: task.book };
  } catch (e) {
    return { ok: false, code: "DBBROKEN", message: `书库读不了（缺 chunks 表？）：${e?.message || e}` };
  }
}

// 门禁预判（事务前）：I4 净化率双闸。返回 { ok, gate, message? }
export function checkInlineGate(stats, forceGate = false) {
  const th = inlineGateThresholds();
  const ratio = stats.cleanRatio || 0;
  const gate = { verdict: "pass", ratio, warn: th.warn, hard: th.hard };
  if (ratio > th.hard && !forceGate) {
    gate.verdict = "block";
    return { ok: false, gate, message: `行级净化要删掉 ${(ratio * 100).toFixed(1)}% 的字（> ${(th.hard * 100).toFixed(0)}% 硬线）——疑似规则误判，整单拒收。人工核查计划清单后可用 --force-gate 放行` };
  }
  if (ratio > th.warn) gate.verdict = "warn";
  return { ok: true, gate };
}

// 成本预估（LLM 兜底另册：本版只跑规则，云端调用 0）
export function estimateInline(plan) {
  return {
    chunks: plan.stats.total, strip: plan.stats.strip, split: plan.stats.split,
    keep: plan.stats.keep, guarded: plan.stats.guardedI1, newChunks: plan.stats.newChunks,
    removedChars: plan.stats.removedChars, cleanRatio: plan.stats.cleanRatio,
    cloudCalls: 0,
  };
}

// token 账（给 CLI 展示用；尺子与 syncBookMeta 同源）
export function inlineTokenEstimate(chars, sampleText) {
  return bookTokenTotal(chars, detectLang([sampleText || ""]));
}
