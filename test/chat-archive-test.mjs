// P4 云端回答存档单测：append/list/purge/clear/上限/坏行——纯 fs，tmp 目录，不碰真书库。
// 存的是 <libDir>/chat-archive/archive.jsonl（跟书库走，换库天然隔离）。
import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execPath } from "node:process";
import { appendArchive, listArchive, purgeBook, clearArchive } from "../src/desktop/chat-archive.mjs";

// B4/CP3：fork 一个 worker 子进程向 libDir 追加 n 条（验证跨进程锁语义）
const WORKER_PATH = fileURLToPath(import.meta.url).replace(/chat-archive-test\.mjs$/, "fixtures/archive-worker.mjs");
function forkWorker(libDir, worker, count) {
  return new Promise((resolve, reject) => {
    const cp = fork(WORKER_PATH,
      [JSON.stringify({ libDir, from: 0, count, worker })], { execPath, stdio: "ignore" });
    cp.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${worker} exit ${code}`))));
    cp.on("error", reject);
  });
}

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} - ${msg}`);
  cond ? pass++ : fail++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-archive-"));
const libDir = path.join(tmp, "library");
fs.mkdirSync(libDir, { recursive: true });

// 造一条快照（形状同 chat.mjs 落盘：问题/回答/模式/书名/模型/引用[含整段原文]）
const entry = (q, bookId) => ({
  question: q, answer: `答${q}`, mode: bookId ? "book" : "library",
  book: bookId ? `《${bookId}》` : null, model: "deepseek-chat", segments: 2, dropped: 0, usage: null,
  citations: [{ n: 1, book: bookId || "全库", bookId, id: 7, loc: "第一章", quote: "學而時習之", text: "學而時習之，不亦說乎" }],
});

// ---------- 1) 追加 + 列表（新→旧）+ 快照内容完整性 ----------
appendArchive(libDir, entry("问题甲", "a.docx"));
appendArchive(libDir, entry("问题乙", "b.docx"));
appendArchive(libDir, entry("问题丙", "a.docx"));
let items = listArchive(libDir);
ok(items.length === 3 && items[0].question === "问题丙" && items[2].question === "问题甲", "追加 3 条后列表新→旧（倒序）");
ok(typeof items[0].ts === "string" && items[0].citations[0].text === "學而時習之，不亦說乎",
  "快照带时间戳与引用片段原文（书没了也能核对当初依据）");
ok(listArchive(libDir, { limit: 2 }).length === 2, "limit 封顶生效");

// ---------- 2) 删书联动：按 bookId 清，返回条数 ----------
ok(purgeBook(libDir, "a.docx") === 2, "purgeBook 清掉引用 a.docx 的 2 条并返回条数");
items = listArchive(libDir);
ok(items.length === 1 && items[0].question === "问题乙", "清剩引用 b.docx 的那条");
ok(purgeBook(libDir, "不存在的书") === 0, "purgeBook 无匹配返回 0");
ok(listArchive(libDir).length === 1, "无匹配时不误删（文件不重写）");

// ---------- 3) 坏行容忍：解析不了的不挡好数据；purge 保守保留 ----------
fs.appendFileSync(path.join(libDir, "chat-archive", "archive.jsonl"), "这不是JSON\n", "utf8");
appendArchive(libDir, entry("问题丁", "c.docx"));
items = listArchive(libDir);
ok(items.length === 2 && items[0].question === "问题丁", "坏行跳过不挡好数据");
ok(purgeBook(libDir, "zzz") === 0 && listArchive(libDir).length === 2, "purge 保守保留坏行（解析不了的不敢删，防误杀）");

// ---------- 4) 清空 ----------
clearArchive(libDir);
ok(listArchive(libDir).length === 0, "clearArchive 后列表空");
clearArchive(libDir); // 再清一次不炸
ok(true, "重复清空不炸");

// ---------- 5) 上限砍最旧（MAX 500；列表默认 limit 100，这里放大才看得到全量） ----------
for (let i = 1; i <= 502; i++) appendArchive(libDir, entry(`问题${i}`, "a.docx"));
items = listArchive(libDir, { limit: 1000 });
ok(items.length === 500, `超上限砍最旧（实际 ${items.length} 条）`);
ok(items[0].question === "问题502" && items[499].question === "问题3", "砍的是最旧 2 条（问题1、2 出局，最新的留在顶）");

// ---------- 6) 空库目录（从未答过）：不建文件、不炸 ----------
const fresh = path.join(tmp, "fresh");
fs.mkdirSync(fresh, { recursive: true });
ok(listArchive(fresh).length === 0 && purgeBook(fresh, "x") === 0, "空目录：列表空、purge 返回 0");
ok(!fs.existsSync(path.join(fresh, "chat-archive")), "空目录 purge 不创建存档文件（无匹配不写盘）");

// ---------- 7) V13/A-09：砍最旧原子替换 + 无残留 tmp 文件 + 锁自清 ----------
{
  // 7a：超上限后再读——原子替换不破内容（砍最旧语义与 §5 一致，这里验写路径原子性副作用）
  ok(listArchive(libDir, { limit: 1000 }).length === 500, "V13: 原子替换后仍 500 条（内容完好）");
  const dirFiles = fs.readdirSync(path.join(libDir, "chat-archive"));
  ok(!dirFiles.some((f) => f.includes(".tmp-")), "V13: 无 .tmp-* 残留（rename 成功即清）", dirFiles.join(","));
  ok(!dirFiles.some((f) => f.endsWith(".lock")), "V13: 修剪锁用后即清（不残留 .lock）", dirFiles.join(","));
  // 7b：再追加 1 条触发修剪路径 → 原子替换正常、锁自清
  appendArchive(libDir, entry("问题503", "a.docx"));
  ok(listArchive(libDir, { limit: 1000 }).length === 500, "V13: 再触发修剪仍封顶 500");
  const dirFiles2 = fs.readdirSync(path.join(libDir, "chat-archive"));
  ok(!dirFiles2.some((f) => f.includes(".tmp-") || f.endsWith(".lock")),
    "V13: 修剪后目录干净（无 tmp/lock 残留）", dirFiles2.join(","));
}

// ---------- 8) B4/CP3：4 子进程并发 append+prune——锁护住 append，零吞行 ----------
{
  // 独立 libDir，注入 240 条垫底（并发再加 100 条=340 < 500 不触发修剪），
  // 验证「锁内 append」本身不丢行：4 进程各 25 条全数落盘
  const concDir = path.join(tmp, "conc-noprune");
  fs.mkdirSync(concDir, { recursive: true });
  for (let i = 1; i <= 240; i++) appendArchive(concDir, entry(`垫底${i}`, "a.docx"));
  await Promise.all([0, 1, 2, 3].map((w) => forkWorker(concDir, w, 25)));
  const all = fs.readFileSync(path.join(concDir, "chat-archive", "archive.jsonl"), "utf8")
    .split("\n").filter((l) => l.trim());
  const nums = all.map((l) => { try { return JSON.parse(l).question; } catch { return null; } }).filter(Boolean);
  const missing = [];
  for (let w = 0; w < 4; w++) for (let i = 0; i < 25; i++) if (!nums.includes(`w${w}-${i}`)) missing.push(`w${w}-${i}`);
  ok(all.length === 340, `B4: 并发不触发修剪时 4 进程×25 条全落盘（340 行，实际 ${all.length}）`);
  ok(missing.length === 0, `B4: 零吞行（缺 ${missing.length} 条${missing.length ? "：" + missing.slice(0, 5).join(",") : ""}）`);
  ok(!fs.readdirSync(path.join(concDir, "chat-archive")).some((f) => f.endsWith(".lock")),
    "B4: 并发后无 .lock 残留");

  // 再注入 400 条垫底 + 并发 100 条（=740 > 500），验证「并发 append+prune 同锁」：
  // 修剪期间其他进程追加的行不得被旧快照 renameSync 覆盖吞掉
  const pruneDir = path.join(tmp, "conc-prune");
  fs.mkdirSync(pruneDir, { recursive: true });
  for (let i = 1; i <= 400; i++) appendArchive(pruneDir, entry(`垫底${i}`, "a.docx"));
  await Promise.all([0, 1, 2, 3].map((w) => forkWorker(pruneDir, w, 25)));
  const lines = fs.readFileSync(path.join(pruneDir, "chat-archive", "archive.jsonl"), "utf8")
    .split("\n").filter((l) => l.trim());
  const qs = lines.map((l) => { try { return JSON.parse(l).question; } catch { return null; } }).filter(Boolean);
  const lost = [];
  for (let w = 0; w < 4; w++) for (let i = 0; i < 25; i++) if (!qs.includes(`w${w}-${i}`)) lost.push(`w${w}-${i}`);
  ok(lines.length === 500, `B4: 超上限并发后封顶 500 行（实际 ${lines.length}）`);
  ok(lost.length === 0, `B4: 修剪窗口零吞行——并发追加的 100 条全部幸存（缺 ${lost.length} 条${lost.length ? "：" + lost.slice(0, 5).join(",") : ""}）`);
  ok(qs.filter((q) => q.startsWith("w")).length === 100, "B4: 100 条并发行（含触发修剪时刻的行）无一丢失");
  ok(!fs.readdirSync(path.join(pruneDir, "chat-archive")).some((f) => f.endsWith(".lock") || f.includes(".tmp-")),
    "B4: 并发修剪后无 tmp/lock 残留");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`===== chat-archive-test: ${pass} PASS / ${fail} FAIL =====`);
process.exit(fail ? 1 : 0);
