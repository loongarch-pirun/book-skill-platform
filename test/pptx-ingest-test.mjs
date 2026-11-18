// T3 pptx 入库：build-book 已有 parsePptx（page=幻灯片号），缺口在 assets/jobs 白名单。
// 钉：① buildBook 建 pptx 库 chunks.page=幻灯片号；② resolveAsset/listShelf 认 pptx 原件。
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");
const Database = require("better-sqlite3");
const buildBook = await import("../src/build-book.js");
const { resolveAsset, listShelf } = await import("../src/lib/assets.mjs");

const slide = (t) => `<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const FILLER = "这里补足正文长度以免触发内容太少闸门，讲的是幻灯片正文的连续叙述与要点展开，每页都应有足够文字。";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pptxing-"));
const books = path.join(TMP, "books"); const lib = path.join(TMP, "library");
fs.mkdirSync(books); fs.mkdirSync(lib);
const zip = new AdmZip();
zip.addFile("ppt/slides/slide1.xml", Buffer.from(slide("第一张原文。" + FILLER.repeat(2))));
zip.addFile("ppt/slides/slide2.xml", Buffer.from(slide("第二张原文。" + FILLER.repeat(2))));
const src = path.join(books, "t.pptx");
zip.writeZip(src);
const dbPath = path.join(lib, "t.pptx.db");
{
  const keep = process.exitCode; const oe = console.error, ol = console.log;
  console.error = () => {}; console.log = () => {};
  try { await buildBook.main([src, "-o", dbPath, "--force", "--title", "t"]); } finally { console.error = oe; console.log = ol; process.exitCode = keep; }
}
const db = new Database(dbPath, { readonly: true });
const rows = db.prepare("SELECT page, chapter, text FROM chunks ORDER BY id").all();
db.close();
assert.ok(rows.length >= 2, `pptx 建库有块（${rows.length}）`);
assert.ok(rows.some(r => r.page === 1) && rows.some(r => r.page === 2), "page=幻灯片号 1/2");
assert.ok(rows.every(r => r.chapter), "chapter 非空");
const asset = resolveAsset(lib, "t.pptx");
assert.strictEqual(asset.exists, true, "resolveAsset 认 pptx 原件");
assert.strictEqual(asset.ext, "pptx");
const shelf = listShelf(lib);
assert.ok(shelf.some(b => b.id === "t.pptx"), "listShelf 含 pptx 书");
fs.rmSync(TMP, { recursive: true, force: true });
console.log("pptx-ingest-test: PASS");