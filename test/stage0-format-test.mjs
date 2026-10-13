// 阶段0 试金石 2：解析管线实测 —— 直接调 src/build-book.js 的真实实现（不再复制代码）
// 验收：pdf/epub/docx 三条真实管线出块；长段落过 sentenceSplit；损坏文件抛错；
//       重灌保护三态（同内容跳过 / 换源拒绝 / 内容变更拒绝，--force 放行）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOKS = path.join(__dirname, "..", "books");
const { parsePdf, parseEpub, parseDocx, sentenceSplit, main } = require("../src/build-book.js");
const Database = require("better-sqlite3");

let failed = 0;
const assert = (cond, msg) => {
  console.log((cond ? "PASS" : "FAIL") + " - " + msg);
  if (!cond) failed++;
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-stage0-"));

// ===== 管线A：真实 parsePdf（PDF 按页提原文）=====
{
  const en = await parsePdf(path.join(BOOKS, "attention-is-all-you-need-en.pdf"));
  assert(en.format === "pdf" && en.numPages >= 10, `英文PDF真实管线: ${en.numPages} 页，format=pdf`);
  const p1 = en.chunks.filter(c => c.page === 1).map(c => c.text).join("\n");
  assert(p1.includes("Attention Is All You Need"), "英文PDF第1页含标题（块带页码定位）");
  assert(en.chunks.every(c => typeof c.page === "number"), "英文PDF所有块都带页码");
  assert(en.cleanedJunk.length >= 0, `页眉页脚识别运行（去重行 ${en.cleanedJunk.length} 种）`);

  const zh = await parsePdf(path.join(BOOKS, "lunyu-xueer-zh.pdf"));
  assert(zh.numPages === 4, `中文PDF真实管线: ${zh.numPages} 页`);
  const allZh = zh.chunks.map(c => c.text).join("\n");
  assert(allZh.includes("學而時習之") && allZh.includes("不患人之不己知"), "中文PDF原文齐全（首尾章句在）");
  const pageOf = (s) => zh.chunks.find(c => c.text.includes(s))?.page;
  assert(pageOf("學而時習之") === 1 && pageOf("不患人之不己知") === 4, "中文PDF页码定位正确（1/4 页）");
}

// ===== 管线B：真实 parseEpub（spine 顺序 + 长段落切分）=====
{
  const pp = parseEpub(path.join(BOOKS, "pride-and-prejudice-en.epub"));
  assert(pp.format === "epub" && pp.chapters > 5, `epub真实管线: ${pp.chapters} 个章节`);
  assert(pp.chunks.some(c => c.text.includes("Mr. Bennet")), "epub第1章关键人物 Mr. Bennet 可定位");
  const maxLen = Math.max(...pp.chunks.map(c => c.text.length));
  assert(maxLen <= 900, `epub长段落全部过 sentenceSplit（最大块 ${maxLen} ≤ 900 字）`);
  assert(pp.chunks.every(c => c.chapter && c.page === null), "epub所有块带章节定位");
}

// ===== 管线C：真实 parseDocx（mammoth + 长段落切分）=====
{
  const lu = await parseDocx(path.join(BOOKS, "lunyu-xueer-zh.docx"));
  assert(lu.format === "docx" && lu.chapters === 16, `docx真实管线: ${lu.chapters} 章（全16章）`);
  const all = lu.chunks.map(c => c.text).join("\n");
  assert(all.includes("學而時習之") && all.includes("患不知人也"), "docx原文首尾章句在");
  const maxLen = Math.max(...lu.chunks.map(c => c.text.length));
  assert(maxLen <= 900, `docx长段落全部过 sentenceSplit（最大块 ${maxLen} ≤ 900 字）`);
}

// ===== sentenceSplit 单元：不丢字、封顶 900 =====
{
  const longText = "甲。".repeat(700);  // 1400 字，全中文句号
  const parts = sentenceSplit(longText);
  assert(parts.every(p => p.length <= 900), `sentenceSplit 封顶 900（${parts.length} 段，最长 ${Math.max(...parts.map(p => p.length))}）`);
  assert(parts.join("") === longText, "sentenceSplit 拼回 == 原文（保真不丢字）");
  assert(sentenceSplit("短句").length === 1, "短文本单块直出");
}

// ===== 损坏文件：伪装扩展名必须抛错（而不是建出一个空库）=====
{
  const garbage = path.join(tmp, "not-a-book.epub");
  fs.writeFileSync(garbage, "这根本不是 epub，是一段纯文本。");
  let epubThrew = false;
  try { parseEpub(garbage); } catch { epubThrew = true; }
  assert(epubThrew, "损坏 epub 被 parseEpub 抛错拒收");

  const garbageDocx = path.join(tmp, "not-a-book.docx");
  fs.writeFileSync(garbageDocx, "这也不是 docx。");
  let docxThrew = false;
  try { await parseDocx(garbageDocx); } catch { docxThrew = true; }
  assert(docxThrew, "损坏 docx 被 parseDocx 抛错拒收");
}

// ===== 重灌保护三态（在临时目录对真实小书跑 CLI main）=====
{
  const outDb = path.join(tmp, "lunyu-xueer-zh.docx.db");
  const src = path.join(BOOKS, "lunyu-xueer-zh.docx");

  const keepExit = process.exitCode;
  const r1 = await main([src, "-o", outDb]);
  assert(r1 && !r1.skipped && fs.existsSync(outDb), "重灌保护: 首次建库正常落盘");
  assert(new Database(outDb, { readonly: true }).prepare("SELECT value FROM meta WHERE key='content_hash'").get()?.value?.length === 16,
    "重灌保护: content_hash 已写入 meta（不再是只写不读的死数据）");

  const r2 = await main([src, "-o", outDb]);
  assert(r2 && r2.skipped === true, "重灌保护: 同源同内容 → 跳过（幂等）");

  // 篡改 hash 模拟"源文件内容已变"
  const db = new Database(outDb);
  db.prepare("UPDATE meta SET value='deadbeefdeadbeef' WHERE key='content_hash'").run();
  db.close();
  process.exitCode = 0;
  await main([src, "-o", outDb]);
  assert(process.exitCode === 1, "重灌保护: 同源不同内容 → 拒绝（提示 --force）");

  // 另一本书想覆盖同一个输出路径
  process.exitCode = 0;
  const other = path.join(BOOKS, "daodejing-zh.docx");
  await main([other, "-o", outDb]);
  assert(process.exitCode === 1, "重灌保护: 换源覆盖 → 拒绝（提示 -o 或 --force）");

  // --force 放行
  process.exitCode = 0;
  const r3 = await main([other, "-o", outDb, "--force"]);
  assert(r3 && !r3.skipped && fs.existsSync(outDb), "重灌保护: --force 明确放行重建");
  process.exitCode = keepExit;
}

// ===== 汇总 =====
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n========== 试金石 2 结果 ==========");
if (failed > 0) { console.log(`有 ${failed} 项 FAIL`); process.exit(1); }
console.log("全部 PASS：三条真实解析管线 + sentenceSplit 保真 + 损坏文件拒收 + 重灌保护三态");
