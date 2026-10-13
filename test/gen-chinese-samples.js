// 用《论语·学而》原文生成中文测试 PDF（4 页，每页 4 章）+ 中文 DOCX
// 生成物仅作"格式测试件"——原文来自维基文库公版书
const fs = require("fs");
const path = require("path");
const { PDFDocument, rgb } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const AdmZip = require("adm-zip");

const BOOKS = path.join(__dirname, "..", "books");
const lines = fs.readFileSync(path.join(BOOKS, "lunyu-xueer-zh.txt"), "utf8")
  .split("\n").map(s => s.trim()).filter(Boolean);
console.log("论语章句:", lines.length, "章");

(async () => {
  // ===== 1. 中文 PDF =====
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fs.readFileSync("C:\\Windows\\Fonts\\simhei.ttf"), { subset: true });
  const perPage = 4;
  const pages = Math.ceil(lines.length / perPage);
  for (let p = 0; p < pages; p++) {
    const page = pdf.addPage([595, 842]); // A4
    page.drawText(`論語 · 學而第一（第 ${p + 1} / ${pages} 頁）`, { x: 60, y: 780, size: 16, font, color: rgb(0.1, 0.1, 0.1) });
    let y = 720;
    for (let i = p * perPage; i < Math.min((p + 1) * perPage, lines.length); i++) {
      // 简单折行：每行 28 个全角字符
      const text = lines[i];
      for (let off = 0; off < text.length; off += 28) {
        page.drawText((off === 0 ? `第${i + 1}章 ` : "       ") + text.slice(off, off + 28), { x: 60, y, size: 12, font });
        y -= 24;
      }
      y -= 12;
    }
  }
  fs.writeFileSync(path.join(BOOKS, "lunyu-xueer-zh.pdf"), await pdf.save());
  console.log("PDF 生成: lunyu-xueer-zh.pdf,", pages, "页");

  // ===== 2. 中文 DOCX（手写 OOXML 最小结构）=====
  const zip = new AdmZip();
  zip.addFile("[Content_Types].xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`));
  zip.addFile("_rels/.rels", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`));
  const paras = lines.map((t, i) =>
    `<w:p><w:r><w:t xml:space="preserve">第${i + 1}章 ${t}</w:t></w:r></w:p>`).join("");
  zip.addFile("word/document.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`));
  fs.writeFileSync(path.join(BOOKS, "lunyu-xueer-zh.docx"), zip.toBuffer());
  console.log("DOCX 生成: lunyu-xueer-zh.docx");
})();
