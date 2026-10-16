// 反馈样本池单测（V3 第三波-③）：append/list/kind过滤/count/purge/上限/坏行/半行——纯 fs，tmp 目录，不碰真书库。
// 存的是 <libDir>/feedback/pool.jsonl（跟书库走，换库天然隔离；不进 git）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendFeedback, listFeedback, countFeedback, purgeBook, clearFeedback } from "../src/desktop/feedback-pool.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} - ${msg}`);
  cond ? pass++ : fail++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-fbp-"));
const libDir = path.join(tmp, "library");
fs.mkdirSync(libDir, { recursive: true });
const POOL = path.join(libDir, "feedback", "pool.jsonl");

const entry = (kind, q, bookId) => ({
  kind, question: q, book: bookId ? `《${bookId}》` : null, bookId: bookId || null,
  mode: bookId ? "book" : "library",
  detail: { dropped: 1 }, legs: [{ id: 7, fts: 0.9, sem: 0.8, cat: null, enr: null, nom: false }],
});

// ---------- 1) 追加 + 列表（新→旧）+ 形状 ----------
appendFeedback(libDir, entry("no-results", "问题甲", "a.docx"));
appendFeedback(libDir, entry("degraded", "问题乙", "b.docx"));
appendFeedback(libDir, entry("citations-dropped", "问题丙", "a.docx"));
let items = listFeedback(libDir);
ok(items.length === 3 && items[0].question === "问题丙" && items[2].question === "问题甲", "追加 3 条后列表新→旧（倒序）");
ok(typeof items[0].ts === "string" && items[0].legs[0].fts === 0.9 && items[0].detail.dropped === 1,
  "条目带时间戳 + 腿归因 + 细节（升格分析可读）");
ok(listFeedback(libDir, { limit: 2 }).length === 2, "limit 封顶生效");

// ---------- 2) kind 过滤 + 计数 ----------
ok(listFeedback(libDir, { kind: "degraded" }).length === 1
  && listFeedback(libDir, { kind: "degraded" })[0].question === "问题乙", "kind 过滤精确");
ok(countFeedback(libDir) === 3 && countFeedback(libDir, { kind: "no-results" }) === 1, "count 全量/按 kind 计数");

// ---------- 3) 删书联动：bookId 直匹 + citations.bookId 兜底；坏行保守保留；无匹配不重写 ----------
ok(purgeBook(libDir, "a.docx") === 2, "purgeBook 清掉 a.docx 的 2 条并返回条数");
items = listFeedback(libDir);
ok(items.length === 1 && items[0].question === "问题乙", "清剩 b.docx 的那条");
ok(purgeBook(libDir, "不存在的书") === 0, "purgeBook 无匹配返回 0");
ok(listFeedback(libDir).length === 1, "无匹配时不误删（文件不重写）");
fs.appendFileSync(POOL, "这不是JSON\n", "utf8");
appendFeedback(libDir, entry("no-results", "问题丁", "c.docx"));
items = listFeedback(libDir);
ok(items.length === 2 && items[0].question === "问题丁", "坏行跳过不挡好数据");
ok(purgeBook(libDir, "zzz") === 0 && listFeedback(libDir).length === 2, "purge 保守保留坏行（解析不了的不敢删）");
ok(countFeedback(libDir) === 2, "count 不计坏行");

// ---------- 4) 半行保护：崩溃留下的无换行结尾不粘连 ----------
{
  const raw = fs.readFileSync(POOL, "utf8");
  fs.writeFileSync(POOL, raw.trimEnd(), "utf8"); // 模拟崩溃：去掉结尾换行
  appendFeedback(libDir, entry("degraded", "问题戊", "c.docx"));
  items = listFeedback(libDir);
  ok(items[0].question === "问题戊" && items.length === 3, "半行保护：补 \\n 后新旧行不粘连");
}

// ---------- 5) 上限：超 MAX_ENTRIES 砍最旧 ----------
clearFeedback(libDir);
for (let i = 0; i < 505; i++) appendFeedback(libDir, entry("no-results", `批量${i}`));
items = listFeedback(libDir, { limit: 600 });
ok(items.length === 500 && items[0].question === "批量504" && items[499].question === "批量5",
  `上限砍最旧：505 → 500 条（首 ${items[0]?.question} / 尾 ${items[499]?.question}）`);

// ---------- 6) 清空 ----------
clearFeedback(libDir);
ok(listFeedback(libDir).length === 0, "clearFeedback 清空");
ok(purgeBook(libDir, "a.docx") === 0, "清空后 purge 安全返回 0");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`===== feedback-pool-test: ${pass} pass / ${fail} fail =====`);
process.exit(fail ? 1 : 0);
