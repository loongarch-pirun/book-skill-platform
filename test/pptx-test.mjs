// T2 pptx 轻量解析：adm-zip 解 zip+XML，只取内容（文本框文字+图片），不渲染版面。
// page=幻灯片号（从1）。ingest(T3) 与网页映射(T4) 共用 readPptx。
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");
const { readPptx } = await import("../src/lib/pptx.mjs");

const slide = (t) => `<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const zip = new AdmZip();
zip.addFile("ppt/slides/slide1.xml", Buffer.from(slide("第一张原文")));
zip.addFile("ppt/slides/slide2.xml", Buffer.from(slide("第二张原文 &amp; 转义")));
zip.addFile("ppt/slides/slide10.xml", Buffer.from(slide("第十张排序")));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-"));
const p = path.join(TMP, "t.pptx");
zip.writeZip(p);
const s = readPptx(p);
assert.strictEqual(s.length, 3);
assert.strictEqual(s[0].page, 1);
assert.strictEqual(s[1].page, 2);
assert.strictEqual(s[2].page, 10, "按幻灯片号数值排序（slide10 在 slide2 后）");
assert.ok(s[0].text.includes("第一张原文"));
assert.ok(s[1].text.includes("第二张原文 & 转义"), "XML 实体解码");
assert.ok(Array.isArray(s[0].images));
fs.rmSync(TMP, { recursive: true, force: true });
console.log("pptx-test: PASS");