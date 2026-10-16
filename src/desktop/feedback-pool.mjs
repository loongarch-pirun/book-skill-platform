// V3 第三波-③ 反馈样本回写：失败样本自动进本地池（检索空手 / 降级 / 引用剔除三信号），
// 可导出草稿 → 人工挑题升格考卷（金词回源+探针实跑后入卷）。
//
// 铁律：只在本地——文件跟书库走（<libDir>/feedback/pool.jsonl），不进 git（library/ 已忽略）、
// 不进云端；写失败由调用方 try 兜底（回写失败绝不能炸掉回答）。
//
// 存放：<libDir>/feedback/pool.jsonl（一行一条 JSON，追加写；删书联动同 chat-archive）。
// 与 chat-archive.mjs 同款工程纪律：原子追加（V2-D04 修法：O_APPEND 小写原子）+ 半行保护 +
// 上限砍最旧 + 坏行保守保留。
import fs from "node:fs";
import path from "node:path";

// 上限防无界增长：超出砍最旧（个人规模 500 条够用；读全量重写，n≤500 成本可忽略）
const MAX_ENTRIES = 500;

function poolPath(libDir) { return path.join(libDir, "feedback", "pool.jsonl"); }

// 读全量行；没有池文件（首次使用）= 空列表——读失败也按空处理，不挡调用方
function readLines(libDir) {
  try {
    return fs.readFileSync(poolPath(libDir), "utf8").split("\n").filter((l) => l.trim());
  } catch { return []; }
}

function writeLines(libDir, lines) {
  fs.mkdirSync(path.join(libDir, "feedback"), { recursive: true });
  fs.writeFileSync(poolPath(libDir), lines.join("\n") + "\n", "utf8");
}

// 追加一条失败样本（entry 由调用方备料：kind/question/book/bookId/mode/detail/legs）；
// 超上限自动砍最旧。写失败会抛——调用方（chat.mjs）必须 try 兜底。
// 原子追加同 chat-archive：appendFileSync 单行追加，仅超上限才读全量重写。
export function appendFeedback(libDir, entry) {
  const p = poolPath(libDir);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // 半行保护：上次崩溃可能留下无换行结尾的半行——先补 \n，防止新旧行粘连成一条坏行
  const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(p, sep + line + "\n", "utf8");
  const lines = readLines(libDir);
  if (lines.length > MAX_ENTRIES) writeLines(libDir, lines.slice(-MAX_ENTRIES));
}

// 列表：新 → 旧，limit 封顶；可选按 kind 过滤。坏行跳过不挡好数据。
export function listFeedback(libDir, { limit = 100, kind = null } = {}) {
  const lines = readLines(libDir);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (kind && e.kind !== kind) continue;
      out.push(e);
    } catch { /* 坏行跳过 */ }
  }
  return out;
}

// 总数（按 kind 可选）：导出工具与 UI 徽标用；坏行不计。
export function countFeedback(libDir, { kind = null } = {}) {
  const lines = readLines(libDir);
  let n = 0;
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      if (!kind || e.kind === kind) n++;
    } catch { /* 坏行不计 */ }
  }
  return n;
}

// 删书联动：清掉 bookId 命中的条目，返回清了几条（0 = 没动文件）。
// 坏行保守保留（解析不了的不敢删，防误杀）；一条都不匹配时不重写文件（与 archive 同口径）。
export function purgeBook(libDir, bookId) {
  if (typeof bookId !== "string" || !bookId) return 0;
  const lines = readLines(libDir);
  const kept = lines.filter((l) => {
    try {
      const e = JSON.parse(l);
      return !(e.bookId === bookId || (e.citations || []).some((c) => c && c.bookId === bookId));
    } catch { return true; }
  });
  const removed = lines.length - kept.length;
  if (removed > 0) writeLines(libDir, kept);
  return removed;
}

// 清空全部（维护用）；本来就没有也算成功。
export function clearFeedback(libDir) {
  try { fs.rmSync(poolPath(libDir), { force: true }); } catch { /* 没有池文件 */ }
}
