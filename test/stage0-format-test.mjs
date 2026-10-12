// 阶段0 试金石 2：四种书源文件 × 三条解析管线实测
// 验收：英文PDF/中文PDF按页提原文并定位页码；epub按章节提原文；docx提纯文本
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOKS = path.join(__dirname, "..", "books");
let failed = 0;
const assert = (cond, msg) => {
  console.log((cond ? "PASS" : "FAIL") + " - " + msg);
  if (!cond) failed++;
};

// ===== 管线A：pdfjs-dist（PDF 按页提原文）=====
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
async function extractPdfPages(file) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    isEvalSupported: false, useSystemFonts: false,
  }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const tc = await p.getTextContent();
    pages.push(tc.items.map(it => it.str).join(""));
  }
  return { numPages: doc.numPages, pages };
}

// A1: 英文 PDF（arxiv 论文，15页）
const en = await extractPdfPages(path.join(BOOKS, "attention-is-all-you-need-en.pdf"));
assert(en.numPages >= 10, `英文PDF解析: 共 ${en.numPages} 页`);
const p1 = en.pages[0];
assert(p1.includes("Attention Is All You Need"), "英文PDF第1页含标题《Attention Is All You Need》");
const absPage = en.pages.findIndex(t => t.includes("attention mechanism"));
assert(absPage >= 0, `关键词"attention mechanism"定位到第 ${absPage + 1} 页`);

// A2: 中文 PDF（论语·学而，4页）
const zh = await extractPdfPages(path.join(BOOKS, "lunyu-xueer-zh.pdf"));
assert(zh.numPages === 4, `中文PDF解析: 共 ${zh.numPages} 页`);
const page1 = zh.pages.findIndex(t => t.includes("學而時習之"));
const page4 = zh.pages.findIndex(t => t.includes("不患人之不己知"));
assert(page1 === 0, `"學而時習之"在第 ${page1 + 1} 页（预期第1页）`);
assert(page4 === 3, `"不患人之不己知"在第 ${page4 + 1} 页（预期第4页）`);

// ===== 管线B：epub（adm-zip 解压 + xmldom 解析，按 spine 顺序）=====
const AdmZip = require("adm-zip");
const { DOMParser } = require("@xmldom/xmldom");
const epub = new AdmZip(path.join(BOOKS, "pride-and-prejudice-en.epub"));
const containerXml = epub.readAsText("META-INF/container.xml");
const opfPath = new DOMParser().parseFromString(containerXml, "application/xml")
  .getElementsByTagName("rootfile")[0].getAttribute("full-path");
const opf = new DOMParser().parseFromString(epub.readAsText(opfPath), "application/xml");
const manifest = new Map();
for (const it of opf.getElementsByTagName("item"))
  manifest.set(it.getAttribute("id"), it.getAttribute("href"));
const spine = [...opf.getElementsByTagName("itemref")].map(r => manifest.get(r.getAttribute("idref")));
assert(spine.length > 5, `epub解析: OPF 结构正常，spine 共 ${spine.length} 个文档`);
const opfDir = path.dirname(opfPath);
let epubText = "", chapters = 0;
for (const href of spine) {
  const entry = epub.getEntry(path.posix.join(opfDir, href).replaceAll("\\", "/"));
  if (!entry) continue;
  const raw = epub.readAsText(entry);
  if (!/xhtml|html/.test(href)) continue;
  const doc = new DOMParser().parseFromString(raw, "application/xhtml+xml");
  const t = (doc.documentElement ? doc.documentElement.textContent : "").replace(/\s+/g, " ").trim();
  if (t.length > 200) chapters++;
  epubText += " " + t;
}
assert(chapters > 5, `epub正文文档 ${chapters} 个（非空）`);
assert(epubText.includes("Pride and Prejudice") && epubText.includes("Austen"), "epub含书名《Pride and Prejudice》与作者 Austen");
const ch1 = epubText.indexOf("Mr. Bennet");
assert(ch1 > 0, `epub第1章关键人物"Mr. Bennet"可定位（偏移 ${ch1}）`);

// ===== 管线C：mammoth（DOCX 提纯文本）=====
const mammoth = require("mammoth");
const docx = await mammoth.extractRawText({ path: path.join(BOOKS, "lunyu-xueer-zh.docx") });
assert(docx.value.includes("第1章") && docx.value.includes("學而時習之"), "DOCX含第1章论语原文");
assert(docx.value.includes("第16章") && docx.value.includes("患不知人也"), "DOCX含第16章（全16章齐）");

// ===== 汇总 =====
console.log("\n========== 试金石 2 结果 ==========");
console.log(`英文PDF: ${en.numPages}页 | 中文PDF: ${zh.numPages}页 | epub章节: ${chapters} | docx: ${docx.value.length}字符`);
if (failed > 0) { console.log(`有 ${failed} 项 FAIL`); process.exit(1); }
console.log("全部 PASS");
