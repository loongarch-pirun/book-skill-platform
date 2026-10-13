// 通用工具：txt → docx（每行一段）。用法: node txt2docx.js <in.txt> <out.docx>
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const [, , inFile, outFile] = process.argv;
if (!inFile || !outFile) { console.error("用法: node txt2docx.js <in.txt> <out.docx>"); process.exit(1); }
const lines = fs.readFileSync(inFile, "utf8").split("\n").map(s => s.trim()).filter(Boolean);
// "# 标题" 约定：输出 Heading1 段落（mammoth 会转成 <h1>，build-book 据此分章节）。
// 普通行仍是正文段——老 txt 没有 # 行，行为零变化。
const isHeading = (t) => /^#\s+\S/.test(t);
const zip = new AdmZip();
zip.addFile("[Content_Types].xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`));
zip.addFile("_rels/.rels", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const paraXml = (t) => isHeading(t)
  ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">${esc(t.replace(/^#\s+/, ""))}</w:t></w:r></w:p>`
  : `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
const paras = lines.map(paraXml).join("");
zip.addFile("word/document.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`));
fs.writeFileSync(outFile, zip.toBuffer());
console.log(`OK: ${path.basename(outFile)} (${lines.length} 段)`);
