// P4 云端回答存档单测：append/list/purge/clear/上限/坏行——纯 fs，tmp 目录，不碰真书库。
// 存的是 <libDir>/chat-archive/archive.jsonl（跟书库走，换库天然隔离）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendArchive, listArchive, purgeBook, clearArchive } from "../src/desktop/chat-archive.mjs";

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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`===== chat-archive-test: ${pass} PASS / ${fail} FAIL =====`);
process.exit(fail ? 1 : 0);
