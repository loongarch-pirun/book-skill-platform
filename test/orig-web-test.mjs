// T4 原件→网页统一映射：txt/docx/epub/pptx→html，pdf→pdfUrl（交 pdfjs），无原件/坏→error 人话。
// 客户端自开全格式、零第三方 WPS；book:// 与环回 HTTP 共用 originalWeb。
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");
const { originalWeb } = await import("../src/desktop/orig-web.mjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "origweb-"));
const books = path.join(TMP, "books"); const lib = path.join(TMP, "library");
fs.mkdirSync(books); fs.mkdirSync(lib);
fs.writeFileSync(path.join(books, "a.txt"), "_txt 原文第一段。\n_txt 原文第二段。", "utf8");
const pz = new AdmZip();
const slide = (t) => `<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
pz.addFile("ppt/slides/slide1.xml", Buffer.from(slide("PPT第一张原文")));
pz.addFile("ppt/slides/slide2.xml", Buffer.from(slide("PPT第二张原文")));
pz.writeZip(path.join(books, "b.pptx"));
const ez = new AdmZip();
ez.addFile("META-INF/container.xml", Buffer.from(`<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`));
ez.addFile("OEBPS/content.opf", Buffer.from(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`));
ez.addFile("OEBPS/c1.xhtml", Buffer.from(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>EPUB原文段落。</p></body></html>`));
ez.writeZip(path.join(books, "c.epub"));
fs.writeFileSync(path.join(books, "d.pdf"), Buffer.from("%PDF-1.4 fake"));

const txt = await originalWeb(lib, "a.txt", {});
assert.strictEqual(txt.type, "html"); assert.ok(txt.html.includes("_txt 原文第一段"));
const pptxAll = await originalWeb(lib, "b.pptx", {});
assert.strictEqual(pptxAll.type, "html"); assert.ok(pptxAll.html.includes("PPT第一张原文"));
const pptxP2 = await originalWeb(lib, "b.pptx", { page: 2 });
assert.ok(pptxP2.html.includes("PPT第二张原文") && !pptxP2.html.includes("PPT第一张原文"), "page=2 只呈现第2张");
const epub = await originalWeb(lib, "c.epub", {});
assert.strictEqual(epub.type, "html"); assert.ok(epub.html.includes("EPUB原文段落"));
const pdf = await originalWeb(lib, "d.pdf", {});
assert.strictEqual(pdf.type, "pdf"); assert.ok(pdf.pdfUrl.includes("d.pdf"));
const missing = await originalWeb(lib, "nope.txt", {});
assert.strictEqual(missing.type, "error"); assert.ok(missing.message.length > 0);
fs.rmSync(TMP, { recursive: true, force: true });
console.log("orig-web-test: PASS");