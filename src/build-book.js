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
  // V3R-D08（一般）：全文无句末标点（长逗号枚举，中文常见）或单句超长时，parts 只有一段、
  // buf 为空串使上面 `&& buf` 恒假——整段直通突破 maxLen（实测 2051 字无标点文本原样返 1 块）。
  // 硬切兜底：任何仍超长的段按 maxLen 平切。切的是块边界、字一个不动（拼回语义不变），
  // 存量带标点语料每段都 ≤ maxLen，本分支不触发——块数锁定不受影响。
  const hard = [];
  for (const p of out) {
    if (p.length <= maxLen) { hard.push(p); continue; }
    for (let i = 0; i < p.length; i += maxLen) hard.push(p.slice(i, i + maxLen));
  }
  return hard;
};

// ---------- 新增：结构识别工具（中文序号/短行标题/表格/L1 去噪） ----------
// 纯页码行（L1 去噪）："12" / "第 12 页" / "第12页"
const PAGE_ONLY = /^第?\s*\d+\s*页?$/;
// 中文序号标题行：一、/ （一） / 1. / 1.1 / 1、（行本身要短，长行是正文不是标题）
const CN_NUM_HEADING = /^([一二三四五六七八九十百]+、|（[一二三四五六七八九十百]+）|\d+(?:\.\d+)*[、．.]\s+\S)/;
// 句读标点：出现即认定是正文行（标题不带句读；含全角冒号——"输出："是标签不是标题）
const SENT_PUNCT = /[。，；！？、,.;:!?…~：]/;
// 图注/表注行：永远不是标题（"图1  螺旋式熔断器实物图"）
const CAPTION_LINE = /^(图|表|附图|公式|式)\s*\d+|^(fig(ure)?|table)\s*\d+/i;
// 短行无标点标题候选（启发式）：短、无句读、有实质字符、非纯数字、非列表符、
// 非残留语法（#注释/反引号/竖线/尖括号——围栏漏网代码与 HTML 组件的行迹）
const isShortHeadingCandidate = (t) =>
  t.length <= 20 &&
  !SENT_PUNCT.test(t) &&
  !/^\d+$/.test(t) &&
  !/^[-*+•·]/.test(t) &&
  !CAPTION_LINE.test(t) &&
  !/^[#`|<>]/.test(t) &&
  !/[<>]/.test(t) &&
  /[\u4e00-\u9fffA-Za-z]/.test(t);
// 标题行长度上限（中文序号/短行两种规则共用）：超长行是正文
const HEADING_MAX = 30;

// w:tbl 内容 → 文本行（每行 "a | b | c"）。OOXML 表格经 mammoth 转 <table>，
// 老 tagRe 只吃 h/p → 表格内容整块丢弃（自产样例 docx 坐实：2 表 72 格全丢）。
const tableToText = (inner) => {
  const out = [];
  for (const tr of inner.split(/<\/tr>/i)) {
    const cells = tr.split(/<\/t[dh]>/i)
      .map(td => collapse(decodeHtml(td.replace(/<[^>]+>/g, ""))))
      .filter((c, i, arr) => !(i === arr.length - 1 && c === ""));  // 劈出尾部空串
    if (cells.some(c => c !== "")) out.push(cells.join(" | "));
  }
  return out;
};

// 无 Word 标题样式时的章节提升：中文序号行（一、/（一）/1.）+ 短行无标点标题
// （下一段明显更长才认，防止把图注/短列表项误升）。表格行不参与（单元格不是标题）。
// 返回新数组（不改入参）。
const promotePlainHeadings = (items) => items.map((it, i) => {
  if (it.tag !== "p" || it.fromTable || it.text.length > HEADING_MAX) return it;
  // 中文序号行也要无句读（检验去掉序号前缀后的部分——"一、"自带顿号不能算）：
  // "2. 针对……的工作。"是带序号的句子不是标题
  if (CN_NUM_HEADING.test(it.text) && !SENT_PUNCT.test(it.text.replace(CN_NUM_HEADING, ""))) return { ...it, heading: true };
  if (!isShortHeadingCandidate(it.text)) return it;
  const next = items[i + 1];
  const need = Math.max(30, it.text.length * 2);
  if (next && next.tag === "p" && next.text.length >= need) return { ...it, heading: true };
  return it;
});

// ---------- PDF：按页提取，识别重复页眉页脚 ----------
// 双栏论文重排：扫描中部候选栏界，选「跨越项最少且左右份额均衡」的位置 → 按「通栏行 + 左栏 + 右栏」阅读序重组。
// 单栏页行文通宽，任何中部栏界都有大量项跨越 → 检测不触发，走原同行 x 序拼接路径，行为零变化
// （attention 单栏 51 块锁定为证）。
function reflowPage(items) {
  const rows = new Map();
  for (const it of items) {
    if (!rows.has(it.y)) rows.set(it.y, []);
    rows.get(it.y).push(it);
  }
  const rowArr = [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, arr]) => arr.sort((a, b) => a.x - b.x));
  const plain = () => rowArr.map(r => r.map(o => o.s).join("").trim());
  if (rowArr.length < 4) return plain();

  const xs = items.map(it => it.x);
  const minX = Math.min(...xs), extent = Math.max(...xs) - minX;
  if (extent < 100) return plain();
  const n = items.length;

  // 栏界扫描：中部 20%~80% 区域 5pt 步进；合法=右栏份额 20%~70% 且跨越项 ≤10%；
  // 取跨越最少者（双栏页栏间空隙处跨越≈0，单栏页通宽行文处处高跨越→无合法界）；
  // 多个合法位取最长连续段的中点=栏间空隙中央，离两栏边缘都远，抗宽度估噪
  let boundary = null, bestCross = Infinity;
  const cands = [];
  for (let x = minX + extent * 0.2; x <= minX + extent * 0.8; x += 5) {
    let cross = 0, right = 0;
    for (const it of items) {
      if (it.x < x - 2 && it.xe > x + 2) cross++;
      else if (it.x >= x) right++;
    }
    if (right / n < 0.2 || right / n > 0.7 || cross / n > 0.1) { cands.push(null); continue; }
    cands.push({ x, cross });
    if (cross < bestCross) bestCross = cross;
  }
  if (bestCross < Infinity) {
    let runStart = -1, bestRun = null;
    for (let i = 0; i <= cands.length; i++) {
      const ok = i < cands.length && cands[i] && cands[i].cross <= bestCross + 1;
      if (ok && runStart < 0) runStart = i;
      if (!ok && runStart >= 0) {
        const run = { a: cands[runStart].x, b: cands[i - 1].x };
        if (!bestRun || run.b - run.a > bestRun.b - bestRun.a) bestRun = run;
        runStart = -1;
      }
    }
    if (bestRun) boundary = (bestRun.a + bestRun.b) / 2;
  }
  if (boundary === null) return plain();

  // 双栏重排：跨栏界项=通栏行（先落盘并冲刷待写栏）；栏界左=左栏待写，右=右栏待写。
  // 容差与扫描一致（±2）：估宽误差 ±2pt 内的邻栏界项归邻栏，不误判通栏
  const out = [];
  let pendL = [], pendR = [];
  const flush = () => { for (const l of pendL) out.push(l); for (const l of pendR) out.push(l); pendL = []; pendR = []; };
  for (const row of rowArr) {
    const cross = row.filter(it => it.x < boundary - 2 && it.xe > boundary + 2);
    const left = row.filter(it => it.xe <= boundary + 2);
    const right = row.filter(it => it.x >= boundary - 2);
    if (cross.length) { flush(); const t = cross.map(o => o.s).join("").trim(); if (t) out.push(t); }
    if (left.length) { const t = left.map(o => o.s).join("").trim(); if (t) pendL.push(t); }
    if (right.length) { const t = right.map(o => o.s).join("").trim(); if (t) pendR.push(t); }
  }
  flush();
  return out;
}

async function parsePdf(file) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    isEvalSupported: false, useSystemFonts: false,
  }).promise;

  // 每页：收集带坐标与宽度的文本项 → 组行 → 双栏检测重排（单栏页零变化）
  const pageLines = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const w = typeof it.width === "number" ? it.width : it.str.length * 5;
      items.push({ y: Math.round(it.transform[5]), x: it.transform[4], xe: it.transform[4] + w, s: it.str });
    }
    pageLines.push(reflowPage(items));
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

  const files = [];
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
      // L1 去噪：纯页码行（"12"/"第 12 页"）是排版残留不是内容
      if (t.length >= 8 && !PAGE_ONLY.test(t)) paras.push(t);
    }
    if (!paras.length) continue;
    files.push({ title, paras });
  }

  // L1 去噪：跨章重复短行 = 跑页眉（出现在 >40% 章节、≤20 字、至少 3 章）。
  // 只删「重复」不删「首次」——章节标题各章不同不会误伤；PDF 路径早有同款逻辑。
  const lineFreq = new Map();
  for (const f of files) {
    for (const k of new Set(f.paras.map(normLine).filter(k => k.length > 0 && k.length <= 20)))
      lineFreq.set(k, (lineFreq.get(k) || 0) + 1);
  }
  const runningJunk = new Set([...lineFreq.entries()]
    .filter(([, n]) => n >= 3 && n > files.length * 0.4).map(([k]) => k));

  const chunks = [];
  let chapterNo = 0;
  for (const f of files) {
    const kept = f.paras.filter(t => !runningJunk.has(normLine(t)));
    if (!kept.length) continue;
    chapterNo++;
    const chapter = f.title || `章节 ${chapterNo}`;
    // 长段落也要过 sentenceSplit（900 字上限）：单个大段落直接入块会让向量质量和 FTS 定位双输
    for (const t of kept)
      for (const seg of sentenceSplit(t))
        chunks.push({ chapter, page: null, text: seg });
  }
  return { format: "epub", chapters: chapterNo, chunks, cleanedJunk: [...runningJunk] };
}

// ---------- DOCX：mammoth 转 HTML，标题 → 章节；表格 → 文本行；无样式标题 → 中文序号/短行启发式 ----------
const decodeHtml = (s) => s
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
async function parseDocx(file) {
  const { value: html } = await mammoth.convertToHtml({ path: file });
  // 第一遍：按文档顺序收集块级元素（h1-6 / p / table→文本行），不过滤
  const items = [];
  const tagRe = /<(h[1-6]|p|table)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    if (tag === "table") {
      for (const row of tableToText(m[2])) items.push({ tag: "p", text: row, fromTable: true });
      continue;
    }
    const t = collapse(decodeHtml(m[2].replace(/<[^>]+>/g, "")));
    // L1 去噪：纯页码行（docx 正文里偶有手打页码）；整行就是个 HTML 组件标签
    // （<br/>/<TitleInfos />——转 docx 时逃过标签剥离的模板残留，不是内容）
    if (!t || PAGE_ONLY.test(t) || /^<[^>]*>$/.test(t)) continue;
    // md 转 docx 的产物标题会带 "# " 前缀（章节名是元数据，剥掉不影响原文块）
    items.push({ tag, text: /^h[1-6]$/.test(tag) ? t.replace(/^#+\s*/, "") : t });
  }
  // 第二遍：无 Word 标题样式时，用中文序号/短行启发式补章节（皮润作业式纯段落文档）
  const withHeadings = items.some(it => /^h[1-6]$/.test(it.tag))
    ? items
    : promotePlainHeadings(items);

  const chunks = [];
  let chapter = "前言";
  let chapterNo = 0;
  for (const it of withHeadings) {
    if (it.heading) { chapterNo++; chapter = it.text; continue; }
    if (/^h[1-6]$/.test(it.tag)) { chapterNo++; chapter = it.text; continue; }
    const cm = it.text.match(/^(第[0-9一二三四五六七八九十百]+章)\s*(.*)$/);
    if (cm) { chapterNo++; chapter = cm[1]; }
    // 长段落也要过 sentenceSplit（同 epub，900 字上限）
    for (const seg of sentenceSplit(it.text))
      chunks.push({ chapter, page: null, text: seg });
  }
  return { format: "docx", chapters: chapterNo, chunks, cleanedJunk: [] };
}

// ---------- MD：单文件或目录（一章一文件），markdown 语法剥离，标题 → 章节 ----------
const mdInline = (t) => t
  .replace(/!\[[^\]]*\]\([^)]*\)/g, "")        // 图片（地址无检索价值）
  .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")     // 行内链接留文字
  .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")    // 引用链接留文字
  .replace(/<[^>]+>/g, "")                     // HTML 标签/居中容器
  .replace(/\$/g, "");                         // 数学定界符（内容保留）

// 一个 md 文件 → 块级元素列表（heading/text）。代码围栏整段去：
// 围栏内 `# 注释`/`| 表格`/`> 引用` 会被误判结构，且多语言 tab 重复三遍纯属噪声。
// 围栏识别用状态机（不用全文正则）：blockquote 里的 ```bash、未闭合围栏、
// ~~~ 围栏都能正确处理；正则方案在这三种情况下会漏（凤凰架构 setup-docker.md 坐实）。
function parseMdFile(file) {
  let raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  raw = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");   // front matter
  raw = raw.replace(/<!--[\s\S]*?-->/g, "");                 // HTML 注释

  const items = [];
  let droppedCode = 0;
  let fence = null;   // { char, len } 围栏开启中
  for (const line of raw.split(/\r?\n/)) {
    const bare = line.replace(/^\s*(?:>\s*)+/, "");         // 先剥 blockquote 标记
    const fm = bare.match(/^\s*(`{3,}|~{3,})(.*)$/);        // info 串可带空格（python title=""）
    if (fm) {
      const [mark, info] = [fm[1], fm[2].trim()];
      if (!fence) { fence = { char: mark[0], len: mark.length }; droppedCode++; continue; }
      if (mark[0] === fence.char && mark.length >= fence.len && !info) fence = null;
      continue;                                             // 围栏内行一律丢
    }
    if (fence) continue;
    const hm = bare.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (hm) {
      const ht = collapse(mdInline(hm[2]));
      if (/[\u4e00-\u9fffA-Za-z]/.test(ht)) items.push({ tag: "h", text: ht });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(bare)) {                      // 表格行 → 文本行
      const cells = bare.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue; // 分隔行
      const row = cells.join(" | ");
      if (row.replace(/\|/g, "").trim()) items.push({ tag: "p", text: row, fromTable: true });
      continue;
    }
    if (/^\s*(?:={3,}|-{3,}|\*{3,}|:{3,}|={2,}\s*".*")\s*$/.test(bare)) continue; // 分隔线/mkdocs tab
    let t = bare
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")               // 列表标记
      .replace(/^\s{4,}(?=\S)/, "");                         // 缩进代码块标记
    t = collapse(mdInline(t));
    if (t) items.push({ tag: "p", text: t });
  }
  return { items, droppedCode };
}

// 目录 → 一书：md 文件按自然序拼接，无标题文件用文件名补一章
function parseMd(file) {
  const stat = fs.statSync(file);
  const files = stat.isDirectory()
    ? walkMd(file).sort((a, b) => a.localeCompare(b, "zh", { numeric: true }))
    : [file];
  const items = [];
  let droppedCode = 0;
  for (const f of files) {
    const { items: fitems, droppedCode: dc } = parseMdFile(f);
    droppedCode += dc;
    if (!fitems.some(it => it.tag === "h")) {
      items.push({ tag: "h", text: path.basename(f).replace(/\.md$/i, "") });
    }
    items.push(...fitems);
  }
  const withHeadings = promotePlainHeadings(items);
  const chunks = [];
  let chapter = "前言";
  let chapterNo = 0;
  for (const it of withHeadings) {
    if (it.tag === "h" || it.heading) { chapterNo++; chapter = it.text; continue; }
    for (const seg of sentenceSplit(it.text))
      chunks.push({ chapter, page: null, text: seg });
  }
  return { format: "md", chapters: chapterNo, chunks, cleanedJunk: [], droppedCode, files: files.length };
}

function walkMd(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(p));
    else if (/\.md$/i.test(e.name)) out.push(p);
  }
  return out;
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
    setMeta.run("title", parsed.title || path.basename(file).replace(/\.[^.]+$/, ""));
    setMeta.run("source_file", path.resolve(file));
    setMeta.run("format", parsed.format);
    setMeta.run("built_at", new Date().toISOString());
    setMeta.run("num_pages", String(parsed.numPages || ""));
    setMeta.run("num_chapters", String(parsed.chapters || ""));
    setMeta.run("chunk_count", String(parsed.chunks.length));
    setMeta.run("total_chars", String(totalChars));
    setMeta.run("content_hash", contentHash(file));
    if (parsed.files) setMeta.run("md_files", String(parsed.files));
    if (parsed.droppedCode) setMeta.run("dropped_code", String(parsed.droppedCode));
    if (parsed.struct) setMeta.run("struct_report", JSON.stringify(parsed.struct));

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

const contentHash = (target) => {
  const h = crypto.createHash("sha256");
  if (fs.statSync(target).isDirectory()) {
    // 目录书：按相对路径序把每个 md 的名字+内容喂进哈希（增删改任一篇都会变）
    for (const f of walkMd(target).sort((a, b) => a.localeCompare(b, "zh", { numeric: true })))
      h.update(path.relative(target, f)).update(fs.readFileSync(f));
  } else {
    h.update(fs.readFileSync(target));
  }
  return h.digest("hex").slice(0, 16);
};

// ---------- 主流程（可被测试以 main(argv) 调用；直接运行时走 CLI） ----------
// opts.onStage(stage)：阶段回调（桌面横幅用）——"structurize"（结构化改造）在清洗前、
// "slice"（切片）在语义分块前触发；CLI 不传即静默（存量行为零变化）。
async function main(argv = process.argv.slice(2), opts = {}) {
  const file = argv[0];
  if (!file || !fs.existsSync(file)) {
    console.error("用法: node build-book.js <book文件|md目录> [-o 输出.db] [--force] [--title 书名]");
    process.exitCode = 1;
    return;
  }
  const force = argv.includes("--force");
  const titleArg = argv.includes("--title") ? argv[argv.indexOf("--title") + 1] : null;
  const outArg = argv.includes("-o") ? argv[argv.indexOf("-o") + 1] : null;
  const isDir = fs.statSync(file).isDirectory();
  const ext = isDir ? ".md" : path.extname(file).toLowerCase();

  // 解析：每种格式单独接错（损坏文件/伪装扩展名在这里现形，而不是蹦一屏英文堆栈）
  let parsed;
  try {
    if (ext === ".pdf") parsed = await parsePdf(file);
    else if (ext === ".epub") parsed = parseEpub(file);
    else if (ext === ".docx") parsed = await parseDocx(file);
    else if (ext === ".md" || ext === ".markdown") parsed = parseMd(file);
    else { console.error("不支持的格式: " + ext + "（支持 .pdf/.epub/.docx/.md，或 md 目录）"); process.exitCode = 1; return; }
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

  // 结构化改造（V3 第四波 P2）：解析之后、切片之前——清洗坏数据/不全数据/乱码符号。
  // 老板定的新流程：结构化改造 → 切片 → 洗数据（原来是切完片直接洗）。
  // 铁律：干净的书零变化（存量四书块数锁定不受影响）；硬拦只发生在烧算力之前；
  //   BSP_STRUCT=0 可整段关掉（排障用）。修不动的乱码才拦，能修的当场修。
  opts.onStage?.("structurize");
  if (process.env.BSP_STRUCT !== "0") {
    const { structurizeChunks, assessCleaned } = await import("./lib/structurize.mjs");
    const st = structurizeChunks(parsed.chunks);
    parsed.chunks = st.chunks;
    parsed.struct = st.report;
    const gate = assessCleaned(parsed.chunks, st.report);
    if (!gate.ok) {
      console.error(gate.reason);
      process.exitCode = 1;
      return;
    }
    const r = st.report;
    if (r.droppedEmpty || r.droppedGarbage || r.repairedMojibake || r.strippedControls || r.strippedPua || r.strippedFffd) {
      console.log(`  结构化改造: 去空块 ${r.droppedEmpty} · 去垃圾块 ${r.droppedGarbage} · 修乱码块 ${r.repairedMojibake} · 清控制符 ${r.strippedControls} / 私用区 ${r.strippedPua} / 替换符 ${r.strippedFffd} 处`);
    }
  }
  opts.onStage?.("slice");

  // 语义分块（BSP_SEMANTIC=1，默认关——存量行为零变化）：本地 e5 零成本，先并后切——
  // ① merge：同章/同页相邻小块并到 ~400 字符（本语料块长 p50≈40~113，检索每问只取 6 段，
  //    块太小则上下文稀薄；相邻块余弦实测 p10≈0.84，阈值 0.72 是安全阀不是主力）；
  // ② split：并完仍超长的块（单句超 900 的长段落资料）在相邻句余弦突变处补切。
  // 两向都只动块边界不动字：并块以 "\n" 相接、切块按偏移切片，拼回逐字保真。
  if (process.env.BSP_SEMANTIC === "1") {
    try {
      const { semanticMergeChunks, semanticSplitChunks } = await import("./lib/semantic-chunk.mjs");
      const { configureModels, getEmbedder } = await import("./lib/models.mjs");
      configureModels({ modelsDir: path.join(__dirname, "..", ".models") });
      const emb = await getEmbedder();
      const embed = (t) => emb.embedPassages(t);
      const before = parsed.chunks.length;
      parsed.chunks = await semanticMergeChunks(parsed.chunks, { embed });
      parsed.chunks = await semanticSplitChunks(parsed.chunks, { embed });
      const after = parsed.chunks.length;
      if (after !== before) console.log(`  语义分块: ${before} → ${after} 块（相邻小块先并到 ~400 字符，超长块余弦突变处补切）`);
    } catch (e) {
      console.error(`语义切分失败，按未切分继续（${e.message}）`);
    }
  }

  // 书名：--title 优先；目录书默认取上级目录名（凤凰架构/fenix → 凤凰架构）；
  // 单文件仍取文件名去后缀（行为零变化）
  const title = titleArg || (isDir ? path.basename(path.dirname(path.resolve(file)))
    : path.basename(file).replace(/\.[^.]+$/, ""));
  parsed.title = title;

  const out = outArg || path.join(path.dirname(file), "..", "library",
    title + "." + parsed.format + ".db");
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
      // 同一本书的判据以内容 hash 为主：jobs 导入会把原件复制进 books/ 再建库，
      // 源路径永远是副本路径（与原件路径不同）——按路径判"另一本书"会误杀
      // 「先手动建库再 GUI 导入同一本书」这个合法场景（P2 逮到）。sha256 同
      // 即同一本书；路径同+hash 同=跳过；路径同+hash 变=内容已变拒绝重建
      // （会作废编目）；路径不同+hash 不同=真的是另一本，拒绝。
      const sameSource = old.source_file === path.resolve(file);
      const sameHash = old.content_hash === contentHash(file);
      if (!sameSource && !sameHash && !force) {
        console.error(`拒绝：${out} 已存在，且内容与「${old.source_file}」的库不同（hash 不同）。换 -o 输出路径，或 --force 覆盖。`);
        process.exitCode = 1;
        return;
      }
      if (sameHash && !force) {
        console.log(`跳过：${path.basename(out)} 已由同一内容建过（hash ${old.content_hash}，源 ${old.source_file}）。要强制重建加 --force。`);
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
  if (parsed.files) console.log(`  md 文件: ${parsed.files} 篇`);
  if (parsed.droppedCode) console.log(`  已去代码块: ${parsed.droppedCode} 段`);
  if (parsed.cleanedJunk.length) console.log(`  已去页眉页脚: ${parsed.cleanedJunk.length} 种重复行`);
  return { chunkCount, totalChars, struct: parsed.struct || null };
}

// ---------- 入口：直接运行才启动 CLI；被 import/require 时只暴露函数（测试用真实实现） ----------
if (require.main === module) {
  main().catch(e => { console.error("建库失败:", e?.stack || e?.message || e); process.exitCode = 1; });
  process.on("unhandledRejection", e => { console.error("未处理的异步错误:", e?.stack || e?.message || e); process.exitCode = 1; });
}

module.exports = { collapse, normLine, sentenceSplit, decodeHtml, parsePdf, parseEpub, parseDocx, parseMd, parseMdFile, tableToText, promotePlainHeadings, walkMd, buildDb, main, contentHash };
