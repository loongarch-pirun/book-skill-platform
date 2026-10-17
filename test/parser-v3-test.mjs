// V3 第二波解析器升级验收：表格提取 / 中文序号+短行标题 / md 原生解析（文件+目录）/
// L1 去噪 / 存量四书零变化。弹药全部运行时生成（不碰 books/ 与 library/），
// 走 build-book.main 全链（含建库）——账平与 meta 一并验。
// 挂载：test:fast（纯解析无模型；实测 <20s）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const buildBook = require("../src/build-book.js");
const AdmZip = require("adm-zip");
const Database = require("better-sqlite3");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-parserv3-"));
const DB = (n) => path.join(TMP, n + ".db");

let failed = 0;
const assert = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (!cond) failed++; };

// ---------- 运行时造 docx（同 make-table-docx.mjs 的 OOXML 手工拼装） ----------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const para = (t, heading = false) => heading
  ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`
  : `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
const cell = (t, bold = false) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p><w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p></w:tc>`;
const row = (cells, header = false) => `<w:tr>${cells.map((c) => cell(c, header)).join("")}</w:tr>`;
const table = (rows) => `<w:tbl><w:tblPr><w:tblW w:w="9600" w:type="dxa"/><w:tblBorders>
  <w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/>
  <w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${rows.join("")}</w:tbl>`;

const mkDocx = (bodyParts, name) => {
  const zip = new AdmZip();
  zip.addFile("[Content_Types].xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`));
  zip.addFile("_rels/.rels", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`));
  zip.addFile("word/document.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyParts.join("")}</w:body></w:document>`));
  const p = path.join(TMP, name);
  fs.writeFileSync(p, zip.toBuffer());
  return p;
};

// ---------- 驱动 build-book.main（截获 console + 还原 exitCode） ----------
async function runBuild(file, extra = []) {
  const out = DB(path.basename(file).replace(/\W/g, "_"));
  const keepExit = process.exitCode;
  const cap = [];
  const oe = console.error, ol = console.log;
  console.error = (...a) => cap.push(a.map(String).join(" "));
  console.log = (...a) => cap.push(a.map(String).join(" "));
  try {
    const r = await buildBook.main([file, "-o", out, ...extra]);
    return { r, stderr: cap.join(" / "), dbPath: out };
  } finally {
    console.error = oe; console.log = ol; process.exitCode = keepExit;
  }
}
const readDb = (dbPath) => {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare("SELECT id, chapter, page, text FROM chunks ORDER BY id").all();
  const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
  db.close();
  return { rows, meta };
};

// ===== 1) docx 表格提取（tagRe 老缺陷的 before/after） =====
console.log("===== 1) docx 表格提取 =====");
{
  const f = mkDocx([
    para("# 一、检测概述", true),
    para("本报告针对一批低压电器元件开展可靠性验证检测，覆盖断路器、接触器和继电器三类样本。检测依据 GB/T 22200.1-2025 执行。"),
    para("# 二、检测项目汇总表", true),
    para("下表汇总本轮全部检测项目及其判定结果。"),
    table([
      row(["序号", "检测项目", "依据条款", "样本数", "合格数", "判定"], true),
      row(["1", "动作特性验证", "6.3.2", "12", "12", "合格"]),
      row(["2", "介电强度试验", "6.4.1", "12", "11", "1 台不合格"]),
    ]),
    para("介电强度试验中出现 1 台不合格，初步判断为外壳绝缘件存在气泡缺陷。"),
  ], "tbl.docx");
  const { r, dbPath } = await runBuild(f, ["--force"]);
  const { rows, meta } = readDb(dbPath);
  assert(r && r.chunkCount === rows.length, `建库成功且块数账实相符（${rows.length}）`);
  const tbl = rows.filter(x => x.text.includes(" | "));
  assert(tbl.length === 3, `3 个表格行全部入库（实际 ${tbl.length}——老代码这里是 0，2 表全丢）`);
  assert(tbl.some(x => x.text === "序号 | 检测项目 | 依据条款 | 样本数 | 合格数 | 判定"), "表头行逐格保序");
  assert(tbl.some(x => x.text.includes("介电强度试验") && x.text.includes("1 台不合格")), "数据行含不合格单元格");
  assert(tbl.every(x => x.chapter === "二、检测项目汇总表"), `表格行归属正确章节（${tbl[0]?.chapter}）`);
  const jsLen = rows.reduce((a, x) => a + x.text.length, 0);
  assert(jsLen === +meta.total_chars, `字符账平（JS ${jsLen} = meta ${meta.total_chars}）`);
  assert(rows.every(x => x.text.length <= 900), "900 字上限仍在");
}

// ===== 2) 无 Word 标题样式：中文序号 + 短行启发式补章节 =====
console.log("===== 2) 中文序号/短行标题启发式 =====");
{
  const f = mkDocx([
    para("低压电器归类总结"),
    para("一、低压电器概述"),
    para("低压电器通常是指工作在交流电压1200V、直流电压1500V及以下电路中的电气设备，用来对电能的生产、分配、转换和使用起通断、保护、控制作用。"),
    para("（一）按用途分类"),
    para("1. 低压配电电器：用于低压配电系统，进行电能的分配与保护，主要包括刀开关、转换开关、熔断器等。"),
    para("1. 熔断器"),
    para("作用：串联在电路中，当电路发生短路或严重过载时，熔体因过热自动熔断而分断电路，主要用于短路保护。"),
    para("图1  螺旋式熔断器实物图"),
    para("12"),                                   // 纯页码行 → L1 去噪
    para("<TitleInfos />"),                       // HTML 组件残留 → L1 去噪
    para("2. 非自动切换电器：依靠人力直接操作来完成切换，如刀开关、控制按钮、转换开关等。"),
    para("四、总结"),
    para("低压电器种类繁多，按用途可分为低压配电电器和低压控制电器两大类。"),
  ], "cnstyle.docx");
  const { r, dbPath } = await runBuild(f, ["--force"]);
  const { rows, meta } = readDb(dbPath);
  const chs = [...new Set(rows.map(x => x.chapter))];
  assert(r && r.chunkCount > 0, `纯段落 docx 建库成功（${r.chunkCount} 块）`);
  assert(chs.includes("一、低压电器概述") && chs.includes("（一）按用途分类") && chs.includes("四、总结"),
    `中文序号行提升为章节（${JSON.stringify(chs.slice(0, 5))}）`);
  assert(chs.includes("1. 熔断器"), "短序号标题行（1. 熔断器）提升为章节");
  assert(!chs.some(c => /图1|<TitleInfos|^\d+$/.test(c)), "图注/HTML 残留/页码不误升为章节");
  assert(!rows.some(x => x.text === "12" || /^<[^>]*>$/.test(x.text)), "L1 去噪：页码行与整行 HTML 标签已丢");
  const numberedSentence = rows.find(x => x.text.startsWith("1. 低压配电电器"));
  assert(numberedSentence && numberedSentence.chapter === "（一）按用途分类", "带序号的长句子句留作正文不升章节");
  assert(+meta.num_chapters === 4 && chs.length === 5,
    `章数账实相符：4 个标题 + 默认「前言」桶（meta=${meta.num_chapters}，distinct=${chs.length}）`);
}

// ===== 3) md 单文件：标题/表格/代码围栏/链接/图片 =====
console.log("===== 3) md 单文件解析 =====");
{
  const md = `---
title: 测试页
---

# 数组

<u>数组（array）</u>是一种线性数据结构，将相同类型的元素存储在连续的内存空间中。索引（index）用于定位元素。

![数组定义](array.png)

## 数组常用操作

可以根据需求选用数组的两种初始化方式，大多数编程语言会将数组元素初始化为 0：

\`\`\`python title="array.py"
# 这是代码注释，不是标题
arr = [0] * 5
\`\`\`

参见 [初始化章节](./init.md) 与官方文档 <https://example.com>。

| 语言 | 初始化写法 |
| --- | --- |
| Python | \`[0] * 5\` |
| Java | \`new int[5]\` |

### 访问元素

通过索引访问数组元素，索引从 0 开始。
`;
  const p = path.join(TMP, "single.md");
  fs.writeFileSync(p, md, "utf8");
  const { dbPath } = await runBuild(p, ["--force"]);
  const { rows, meta } = readDb(dbPath);
  const chs = [...new Set(rows.map(x => x.chapter))];
  assert(meta.format === "md", `format=md（${meta.format}）`);
  assert(chs.includes("数组") && chs.includes("数组常用操作") && chs.includes("访问元素"),
    `md 标题 → 章节（${JSON.stringify(chs)}）`);
  assert(!rows.some(x => /代码注释|arr = \[0\] \* 5|title="array/.test(x.text)), "代码围栏整段去（含围栏内 # 注释）");
  const py = rows.find(x => x.text.startsWith("Python |"));
  const java = rows.find(x => x.text.startsWith("Java |"));
  assert(py && py.text === "Python | `[0] * 5`" && java && java.text === "Java | `new int[5]`",
    `md 表格行逐行成块（${JSON.stringify(py && py.text)} / ${JSON.stringify(java && java.text)}）`);
  assert(rows.some(x => x.text === "语言 | 初始化写法"), "表头行同样保留");
  assert(rows.some(x => x.text.includes("参见 初始化章节") && !x.text.includes("./init.md")), "链接留文字去地址");
  assert(!rows.some(x => x.text.trim() === "数组定义"), "图片行已去");
  assert(rows.some(x => x.text.includes("数组（array）是一种线性数据结构")), "正文保真（<u> 标签剥掉、文字保留）");
  const jsLen = rows.reduce((a, x) => a + x.text.length, 0);
  assert(jsLen === +meta.total_chars, "md 字符账平");
}

// ===== 4) md 目录：一章一文件拼接 + 书名 =====
console.log("===== 4) md 目录解析 =====");
{
  const dir = path.join(TMP, "mdbook");
  fs.mkdirSync(path.join(dir, "chapter_b"), { recursive: true });
  fs.mkdirSync(path.join(dir, "chapter_a"), { recursive: true });
  fs.writeFileSync(path.join(dir, "chapter_a", "intro.md"), "# 第一章 入门\n\n这是入门章节的正文，介绍基本概念与术语，长度足够成为检索块。结构化改造之后，全文不足一百字符的片段会被视为不全数据而拦下，所以这里的正文要写得足够长，才能真实考察目录书的章节拼接行为。\n", "utf8");
  fs.writeFileSync(path.join(dir, "chapter_b", "adv.md"), "## 进阶主题\n\n没有 H1 的文件用文件名补一章，正文讲进阶内容。这一段同样刻意写长一些，确保整本书的总字数稳过结构化改造的内容下限，让测试聚焦在章节归属而不是被闸门抢走主题。\n", "utf8");
  fs.writeFileSync(path.join(dir, "chapter_a", "notitle.md"), "这一篇没有任何标题行，应该整篇归到文件名章节下。为了凑足全文下限，这里再多写几句：目录书解析时，无标题文件先用文件名补一个章节，再把正文挂到该章节之下，行为与单文件一致。\n", "utf8");
  const { dbPath } = await runBuild(dir, ["--force"]);
  const { rows, meta } = readDb(dbPath);
  const chs = [...new Set(rows.map(x => x.chapter))];
  assert(meta.md_files === "3", `md_files=3 篇（${meta.md_files}）`);
  assert(chs.includes("第一章 入门") && chs.includes("进阶主题") && chs.includes("notitle"),
    `目录书章节（${JSON.stringify(chs)}）`);
  assert(meta.title === "mdbook" || meta.title === path.basename(TMP), `默认书名取目录名/上级目录（${meta.title}）`);
  // 断点守卫：同内容二次构建 → skipped（重灌保护对目录书同样有效）
  const again = await buildBook.main([dir, "-o", dbPath]);
  assert(again && again.skipped === true, "目录书同内容二次构建 → skipped");
}

// ===== 5) 存量四书零变化（块数锁定——升级前已与旧解析器逐块 diff 为零） =====
console.log("===== 5) 存量四书零变化 =====");
{
  const bb = require("../src/build-book.js");
  const cmp = async (label, fn, expectChunks) => {
    const n = await fn(bb);
    assert(n.chunks.length === expectChunks, `${label}：块数锁定 ${expectChunks}（实际 ${n.chunks.length}）`);
  };
  await cmp("lunyu pdf", b => b.parsePdf(path.join(ROOT, "books/lunyu-xueer-zh.pdf")), 4);
  await cmp("lunyu docx", b => b.parseDocx(path.join(ROOT, "books/lunyu-xueer-zh.docx")), 16);
  await cmp("attention pdf", b => b.parsePdf(path.join(ROOT, "books/attention-is-all-you-need-en.pdf")), 51);
  await cmp("p&p epub", b => b.parseEpub(path.join(ROOT, "books/pride-and-prejudice-en.epub")), 2400);
  // 注：2026-10-16 #58 渐进重建前，library/pride-and-prejudice-en.epub.db 里是 2210 块
  // （旧 epub 文件/旧解析产物，与当前 books/ 下的 epub 已不同源）——已用当前源文件重建为
  // 1250 块（语义分块合并），影子库考卷对照打平后替换；这里锁的是「当前源文件解析输出」。
  // 升级时已用 git HEAD 版 build-book 逐块 diff 验证：块数/字符/文本集合全部为零变化。
}

console.log(`\n===== V3 解析器验收：${failed === 0 ? "全部 PASS" : failed + " 项 FAIL"} =====`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 沙箱 rm 被拦则留 temp */ }
process.exit(failed ? 1 : 0);
