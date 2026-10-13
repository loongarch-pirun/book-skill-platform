// 阶段1：切片保真层
// 用法: node build-book.js <book文件> [-o 输出.db]
// 规则: 原文一字不改（只去页眉页脚/空行、折叠空白），每块带 页码 或 章节 定位
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const AdmZip = require("adm-zip");
const { DOMParser } = require("@xmldom/xmldom");
const mammoth = require("mammoth");

// ---------- 通用：文本工具 ----------
const collapse = (s) => s.replace(/[ \t\u00a0]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
const normLine = (s) => s.replace(/\s+/g, "").replace(/第\s*\d+\s*页/g, "");
const sentenceSplit = (text, maxLen = 900) => {
  if (text.length <= maxLen) return [text];
  const parts = text.split(/(?<=[。！？.!?])\s*/);
  const out = [];
  let buf = "";
  for (const p of parts) {
    if ((buf + p).length > maxLen && buf) { out.push(buf); buf = p; }
    else buf += p;
  }
  if (buf) out.push(buf);
  return out;
};

// ---------- PDF：按页提取，识别重复页眉页脚 ----------
async function parsePdf(file) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    isEvalSupported: false, useSystemFonts: false,
  }).promise;

  // 每页先按 y 坐标重组行
  const pageLines = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const rows = new Map();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], s: it.str });
    }
    const lines = [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, arr]) => arr.sort((a, b) => a.x - b.x).map(o => o.s).join("")
        .replace(/(?<=[A-Za-z0-9,.]) (?=[A-Za-z0-9])/g, m => m).trim());
    pageLines.push(lines);
  }

  // 重复行（出现在 >35% 页面且较短）视为页眉页脚，丢弃
  const freq = new Map();
  for (const lines of pageLines) for (const l of lines) {
    const k = normLine(l);
    if (k.length === 0 || k.length > 80) continue;
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  const junk = new Set([...freq.entries()].filter(([, n]) => n > pageLines.length * 0.35).map(([k]) => k));

  const pages = pageLines.map((lines, idx) => {
    const kept = lines.filter(l => l.trim() && !junk.has(normLine(l)));
    return { page: idx + 1, text: collapse(kept.join("\n")) };
  }).filter(p => p.text);

  // 页内切分：每块带页码
  const chunks = [];
  for (const p of pages)
    for (const seg of sentenceSplit(p.text))
      chunks.push({ chapter: null, page: p.page, text: seg });
  return { format: "pdf", numPages: pages.length, chunks, cleanedJunk: [...junk] };
}

// ---------- EPUB：spine 顺序，每个 xhtml = 章节，<p> = 段 ----------
function parseEpub(file) {
  const zip = new AdmZip(file);  // 非 zip 文件在这里直接抛错（上游 main 统一接住）
  const containerXml = zip.readAsText("META-INF/container.xml");
  const opfPath = new DOMParser().parseFromString(containerXml, "application/xml")
    .getElementsByTagName("rootfile")[0].getAttribute("full-path");
  const opf = new DOMParser().parseFromString(zip.readAsText(opfPath), "application/xml");
  const manifest = new Map();
  for (const it of opf.getElementsByTagName("item"))
    manifest.set(it.getAttribute("id"), it.getAttribute("href"));
  const spine = [...opf.getElementsByTagName("itemref")].map(r => manifest.get(r.getAttribute("idref")));
  const opfDir = path.dirname(opfPath).replaceAll("\\", "/");

  const chunks = [];
  let chapterNo = 0;
  for (const href of spine) {
    if (!/\.x?html?$/i.test(href)) continue;
    const entry = zip.getEntry(path.posix.join(opfDir, href).replaceAll("\\", "/"));
    if (!entry) continue;
    const doc = new DOMParser().parseFromString(zip.readAsText(entry), "application/xhtml+xml");
    const title = collapse(doc.getElementsByTagName("title")[0]?.textContent?.replace(/\s+/g, " ") || "");
    const body = doc.getElementsByTagName("body")[0];
    if (!body) continue;
    const paras = [];
    for (const el of body.getElementsByTagName("*")) {
      const tag = el.tagName.toLowerCase();
      if (!/^(p|h[1-6]|blockquote|li)$/.test(tag)) continue;
      const t = collapse(el.textContent || "");
      if (t.length >= 8) paras.push(t);
    }
    if (!paras.length) continue;
    chapterNo++;
    const chapter = title || `章节 ${chapterNo}`;
    // 长段落也要过 sentenceSplit（900 字上限）：单个大段落直接入块会让向量质量和 FTS 定位双输
    for (const t of paras)
      for (const seg of sentenceSplit(t))
        chunks.push({ chapter, page: null, text: seg });
  }
  return { format: "epub", chapters: chapterNo, chunks, cleanedJunk: [] };
}

// ---------- DOCX：mammoth 转 HTML，标题 → 章节 ----------
const decodeHtml = (s) => s
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
async function parseDocx(file) {
  const { value: html } = await mammoth.convertToHtml({ path: file });
  const chunks = [];
  let chapter = "前言";
  let chapterNo = 0;
  const tagRe = /<(h[1-6]|p)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const t = collapse(decodeHtml(m[2].replace(/<[^>]+>/g, "")));
    if (!t) continue;
    if (/^h[1-6]$/.test(tag)) { chapterNo++; chapter = t; continue; }
    const cm = t.match(/^(第[0-9一二三四五六七八九十百]+章)\s*(.*)$/);
    if (cm) { chapterNo++; chapter = cm[1]; }
    // 长段落也要过 sentenceSplit（同 epub，900 字上限）
    for (const seg of sentenceSplit(t))
      chunks.push({ chapter, page: null, text: seg });
  }
  return { format: "docx", chapters: chapterNo, chunks, cleanedJunk: [] };
}

// ---------- 建库：一书一 .db ----------
function buildDb(file, outPath, parsed) {
  const db = require("better-sqlite3")(outPath);
  try {
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE chunks(
        id INTEGER PRIMARY KEY,
        chapter TEXT,
        page INTEGER,
        text TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        text, content='chunks', content_rowid='id', tokenize='trigram'
      );
    `);
    const totalChars = parsed.chunks.reduce((a, c) => a + c.text.length, 0);
    const setMeta = db.prepare("INSERT INTO meta(key,value) VALUES (?,?)");
    setMeta.run("title", path.basename(file).replace(/\.[^.]+$/, ""));
    setMeta.run("source_file", path.resolve(file));
    setMeta.run("format", parsed.format);
    setMeta.run("built_at", new Date().toISOString());
    setMeta.run("num_pages", String(parsed.numPages || ""));
    setMeta.run("num_chapters", String(parsed.chapters || ""));
    setMeta.run("chunk_count", String(parsed.chunks.length));
    setMeta.run("total_chars", String(totalChars));
    setMeta.run("content_hash", contentHash(file));

    const tx = db.transaction(() => {
      const ins = db.prepare("INSERT INTO chunks(chapter, page, text) VALUES (?,?,?)");
      for (const c of parsed.chunks) {
        const r = ins.run(c.chapter, c.page, c.text);
        db.prepare("INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)").run(r.lastInsertRowid, c.text);
      }
    });
    tx();
    return { chunkCount: parsed.chunks.length, totalChars };
  } finally {
    db.close();  // 中途抛错（磁盘满/锁冲突）不留句柄
  }
}

const contentHash = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);

// ---------- 主流程（可被测试以 main(argv) 调用；直接运行时走 CLI） ----------
async function main(argv = process.argv.slice(2)) {
  const file = argv[0];
  if (!file || !fs.existsSync(file)) {
    console.error("用法: node build-book.js <book文件> [-o 输出.db] [--force]");
    process.exitCode = 1;
    return;
  }
  const force = argv.includes("--force");
  const outArg = argv.includes("-o") ? argv[argv.indexOf("-o") + 1] : null;
  const ext = path.extname(file).toLowerCase();

  // 解析：每种格式单独接错（损坏文件/伪装扩展名在这里现形，而不是蹦一屏英文堆栈）
  let parsed;
  try {
    if (ext === ".pdf") parsed = await parsePdf(file);
    else if (ext === ".epub") parsed = parseEpub(file);
    else if (ext === ".docx") parsed = await parseDocx(file);
    else { console.error("不支持的格式: " + ext + "（支持 .pdf/.epub/.docx）"); process.exitCode = 1; return; }
  } catch (e) {
    console.error(`解析失败（${ext}）: ${e.message}`);
    console.error("文件可能损坏或不是真正的 " + ext + " 文件。");
    process.exitCode = 1;
    return;
  }
  if (!parsed.chunks.length) {
    console.error("解析出 0 块：文件可能是空的、扫描图片型 PDF 或加密文档。");
    process.exitCode = 1;
    return;
  }

  const out = outArg || path.join(path.dirname(file), "..", "library",
    path.basename(file).replace(/\.[^.]+$/, "") + "." + parsed.format + ".db");
  fs.mkdirSync(path.dirname(out), { recursive: true });

  // 重灌保护：build-book 会整库重建（切片编号变化 → 编目边作废），三种情况拦住，--force 放行
  if (fs.existsSync(out)) {
    let old = null;
    try {
      const db = require("better-sqlite3")(out, { readonly: true });
      old = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
      db.close();
    } catch { /* 出路径上是个非库文件 → 视为无历史，直接覆盖 */ }
    if (old && old.content_hash) {
      const sameSource = old.source_file === path.resolve(file);
      const sameHash = old.content_hash === contentHash(file);
      if (!sameSource && !force) {
        console.error(`拒绝：${out} 已存在，且是另一本书（${old.source_file}）的库。换 -o 输出路径，或 --force 覆盖。`);
        process.exitCode = 1;
        return;
      }
      if (sameSource && sameHash && !force) {
        console.log(`跳过：${path.basename(out)} 已由同一文件同内容建过（hash ${old.content_hash}）。要强制重建加 --force。`);
        return { skipped: true };
      }
      if (sameSource && !sameHash && !force) {
        console.error(`拒绝：源文件内容已变（旧 hash ${old.content_hash} ≠ 新 ${contentHash(file)}）。`);
        console.error(`重建会改变切片编号、作废这本书的编目数据（人物/主题/关系全清）。确认要重建就加 --force。`);
        process.exitCode = 1;
        return;
      }
    }
  }

  for (const suffix of ["", "-wal", "-shm"]) {
    const p = out + suffix;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  const { chunkCount, totalChars } = buildDb(file, out, parsed);

  console.log(`建库完成: ${path.basename(out)}`);
  console.log(`  格式: ${parsed.format} | 切片: ${chunkCount} 块 | 原文: ${totalChars} 字符`);
  if (parsed.numPages) console.log(`  页数: ${parsed.numPages}`);
  if (parsed.chapters) console.log(`  章节: ${parsed.chapters}`);
  if (parsed.cleanedJunk.length) console.log(`  已去页眉页脚: ${parsed.cleanedJunk.length} 种重复行`);
  return { chunkCount, totalChars };
}

// ---------- 入口：直接运行才启动 CLI；被 import/require 时只暴露函数（测试用真实实现） ----------
if (require.main === module) {
  main().catch(e => { console.error("建库失败:", e?.stack || e?.message || e); process.exitCode = 1; });
  process.on("unhandledRejection", e => { console.error("未处理的异步错误:", e?.stack || e?.message || e); process.exitCode = 1; });
}

module.exports = { collapse, normLine, sentenceSplit, decodeHtml, parsePdf, parseEpub, parseDocx, buildDb, main, contentHash };
