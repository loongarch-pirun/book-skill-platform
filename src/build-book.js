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
// 结构化原件一并取出来（table_html / table_rows / table_header），块文本仍逐字不变：
// 拍平的 "a | b | c" 定位不到「那一格」，而表结构是可还原到单元格的唯一依据。
const cellAttr = (td, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, "i").exec(td);
  return m ? Math.max(1, parseInt(m[1], 10)) : 1;
};
// <table> 内层 → { html, header, rows:[{ text, cells:[{text,rowspan,colspan}] }] }
// 单元格旁挂 rowspan/colspan（mammoth 对合并单元格会写 colspan/rowspan 属性）；
// 行文本 = 各格文本以 " | " 连接，与旧 tableToText 逐字一致。
function tableFromHtml(inner) {
  const html = `<table>${inner}</table>`;
  const rows = [];
  for (const tr of inner.split(/<\/tr>/i)) {
    const cells = tr.split(/<\/t[dh]>/i)
      .map(td => ({
        text: collapse(decodeHtml(td.replace(/<[^>]+>/g, ""))),
        rowspan: cellAttr(td, "rowspan"), colspan: cellAttr(td, "colspan"),
      }))
      .filter((c, i, arr) => !(i === arr.length - 1 && c.text === ""));  // 劈出尾部空串
    if (cells.some(c => c.text !== "")) rows.push({ text: cells.map(c => c.text).join(" | "), cells });
  }
  return { html, header: rows.length ? rows[0].cells.map(c => c.text) : [], rows };
}
const tableToText = (inner) => tableFromHtml(inner).rows.map(r => r.text);

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

// ---------- P3-① 表格整表成块 ----------
// 表格是结构化单元：逐行进块会被 sentenceSplit 打散混进上下文（表头与数据行
// 分离、行与正文混溶）。连续 fromTable 行合成一个块；整表超过 TABLE_MAX 时
// 按行组切——表头（首行）随每组重复，保证每组可独立读懂。
// 必须在 promotePlainHeadings 之后调用：promote 的「下一段更长才认」不看
// fromTable，先合并会让原本不触发的标题提升触发（干净书零变化红线）。
// 返回新数组（不改入参）；无表书 / 单行表逐字零变化。
const TABLE_MAX = 900;   // 与 sentenceSplit 的 900 字上限同标尺

// 把一组表格行装箱成块：每组 ≤ TABLE_MAX（单行超长保持原子——行是不可分单元，
// 永不跨行切）；表头只在非首组重复（首组自带）。
// meta（可选）= { table_html, table_header, table_rows }：结构原件随块走，
// 块文本仍逐字不变（table_rows 按行号取下本组真实行：非首组首行是重复的表头，
// 结构里仍对应第 0 行）。
function packTable(rows, meta) {
  const withMeta = (rs, idx) => {
    const o = { tag: "p", text: rs.join("\n"), fromTable: true };
    if (meta && meta.table_html) {
      o.table_html = meta.table_html;
      o.table_header = meta.table_header || null;
      o.table_rows = meta.table_rows ? idx.map(i => meta.table_rows[i]) : null;
    }
    return o;
  };
  if (rows.length <= 1) return rows.map((t, k) => withMeta([t], [k]));
  const header = rows[0];
  const groups = [];
  let cur = [{ t: header, i: 0 }];
  let curLen = header.length;
  for (let k = 1; k < rows.length; k++) {
    const row = rows[k];
    if (curLen + 1 + row.length > TABLE_MAX && cur.length > 1) {
      groups.push(cur);                                   // 当前组收口
      cur = [{ t: header, i: 0 }, { t: row, i: k }];      // 新组：表头随行重复
      curLen = header.length + 1 + row.length;
    } else {
      cur.push({ t: row, i: k });
      curLen += 1 + row.length;
    }
  }
  groups.push(cur);
  return groups.map(g => withMeta(g.map(x => x.t), g.map(x => x.i)));
}

// 连续 fromTable 行合并——但只并「同一张表」的行：tid 相同才算同表（md 里
// 空行/任何非表行就是表边界，parseMdFile 逐行维护 tid；docx 每个 <table>
// 元素一个 tid）。ranges = 每个文件的 [start, end) 区间（md 目录书跨文件
// 不相并——不同文件是不同的表）；不传 ranges 视为单一文档（docx）。
function mergeTableRows(items, ranges) {
  const n = ranges ? ranges.length : 1;
  const out = [];
  for (let g = 0; g < n; g++) {
    const [start, end] = ranges ? ranges[g] : [0, items.length];
    let i = start;
    while (i < end) {
      const it = items[i];
      if (!it || !it.fromTable) { out.push(it); i++; continue; }
      const tid = it.tid;
      let j = i + 1;
      while (j < end && items[j].fromTable && (items[j].tid ?? tid) === tid) j++;
      const grp = items.slice(i, j);
      const rows = grp.map(r => r.text).filter(t => t && t.trim());
      // 表结构原件：docx 从 <table> 元素上带下来；md 的 GFM 表没有 rowspan/colspan，
      // 用同一批 cells 现拼一份 HTML（结构等价、无合并跨度），再统一走 packTable。
      const src = grp.find(r => r.table_html);
      let meta = null;
      if (src) {
        meta = { table_html: src.table_html, table_header: src.table_header, table_rows: grp.map(r => r.table_cells || null).filter(Boolean) };
      } else if (grp.every(r => r.table_cells)) {
        const cellsArr = grp.map(r => r.table_cells);
        meta = {
          table_html: `<table>${cellsArr.map(cs => `<tr>${cs.map(c => `<td>${c.text}</td>`).join("")}</tr>`).join("")}</table>`,
          table_header: cellsArr[0].map(c => c.text),
          table_rows: cellsArr.map(cs => cs.map(c => c.text)),
        };
      }
      out.push(...packTable(rows, meta && meta.table_rows.length === rows.length ? meta : null));
      i = j;
    }
  }
  return out;
}

// BSP_TABLE=0 逃生（排障/对照用）：归一化判定与 BSP_STRUCT 同款——剥零宽字符、
// NFKC（全角 "０"→"0"）、trim 后精确比 "0"（P2-04 先例）。
const tableOff = () => String(process.env.BSP_TABLE ?? "").replace(/[\u200b-\u200d]/g, "").normalize("NFKC").trim() === "0";

// P3-② 章节层级 → 路径串（「卷 › 章 › 节」）。空栈/空洞过滤后为空 → null
// （pdf/epub 与无标题书 chapter_path 为 NULL，消费侧回退扁平 chapter）。
const chapterPathOf = (stack) => {
  const parts = (stack || []).filter(s => s && String(s).trim());
  return parts.length ? parts.join(" › ") : null;
};

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

// ---------- PDF 解析引擎选择（R3/R4 分流的实现口） ----------
// 取值规则（三值，唯一落一条，无「看情况」）：
//   BSP_PDF_ENGINE=mineru → 只走 MinerU basic 结构化抽取，不可用即报错（不静默降级）
//   BSP_PDF_ENGINE=legacy → 只走原 pdfjs 文字流（对照/排障/回滚用）
//   未设置（默认）        → MinerU 可用就走 MinerU，不可用回落 legacy
// "可用" = 有 MINERU_HOME 且其下有 doclib 目录（src/lib/mineru.mjs:mineruAvailable）
const pdfEngine = () => String(process.env.BSP_PDF_ENGINE ?? "").replace(/[\u200b-\u200d]/g, "").normalize("NFKC").trim().toLowerCase();

// MinerU 结构化抽取：块级 bbox + 表格 HTML + 公式 LaTeX，替代 :233 只取文字流
// opts.route：判定表落行（R12/R3/R4）。R12 时先按规则丢脏块再转 chunks。
async function parsePdfStructured(file, opts = {}) {
  const M = await import("./lib/mineru.mjs");
  const cfg = M.mineruConfig();
  // 真实页数交给缓存校验：只跑过 1-40 页的旧缓存不能被当成「全量」产物（804 页实测踩过）
  const expectPages = opts.probe && opts.probe.pages ? opts.probe.pages : undefined;
  const r = await M.parsePdfWithMineru(file, cfg, (m) => console.log(m), expectPages);
  if (!r.ok) {
    const tail = (r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" / ");
    throw new Error(`MinerU 解析失败（exit ${r.code}）${tail ? ": " + tail : ""}`);
  }
  const middle = JSON.parse(fs.readFileSync(r.jsonPath, "utf8"));
  const numPages = Array.isArray(middle.pages) ? middle.pages.length : 0;
  // 页数对不上必须炸：解析层只覆盖 40 页却把 801 页的书报成功，是最难发现的一类错
  // （检索时「书的后 95% 不见了」不会报错，只会查不到）。宁可失败让人重跑。
  if (expectPages && numPages && numPages !== expectPages) {
    throw new Error(
      `MinerU 产物页数不符：文本层探针 ${expectPages} 页，产物 ${numPages} 页`
      + `（缓存 ${path.basename(r.jsonPath)} 覆盖不全，删掉该缓存文件或换 --pages 重跑）`
    );
  }
  const { blocks: rawBlocks, dropped } = M.middleToBlocks(middle);

  // R12：脏排版先按规则清洗（只丢命中脏规则的块，其余逐字不动）
  let blocks = rawBlocks;
  let dirtyCleaned = null;
  if (opts.route === "r12_dirty") {
    const R = await import("./lib/pdf-route.mjs");
    const c = R.cleanDirtyBlocks(rawBlocks);
    blocks = c.blocks;
    dirtyCleaned = { removed: c.removed, kept: blocks.length };
    if (!blocks.length) {
      // 全丢光了说明规则打得过宽（一本书全是脏行＝判据写错），不能静默建出空书
      throw new Error(`R12 清洗后 0 块：${rawBlocks.length} 块全部命中脏规则，判据可能过宽`);
    }
  }

  const chunks = M.blocksToChunks(blocks, { sentenceSplit, collapse });

  // R4：OCR 降级之后复测，仍不达标就标 needs_vlm（不自动下载 1.18 GB VLM，交给上层决定）
  let ocrAssess = null;
  let needsVlm = false;
  if (opts.route === "r4_ocr") {
    const R = await import("./lib/pdf-route.mjs");
    ocrAssess = R.assessAfterOcr(blocks, numPages);
    needsVlm = ocrAssess.needsVlm;
  }

  return {
    format: "pdf",
    engine: `mineru:${cfg.tier}`,
    numPages,
    chunks,
    cleanedJunk: [],
    route: opts.route || null,
    routeReason: opts.routeReason || null,
    routeAnnotations: [...(opts.routeAnnotations || []), ...(needsVlm ? ["R4:OCR 后仍不足，标 needs_vlm（未下载 VLM）"] : [])],
    dirtyCleaned,
    ocrAssess,
    // 页码块被 R3 结构性剔除（不是页眉页脚启发式），单独记账
    droppedPageNumbers: dropped.length,
    structReport: {
      engine: `mineru:${cfg.tier}`,
      blocks: blocks.length,
      with_bbox: blocks.filter((b) => b.bbox).length,
      tables: blocks.filter((b) => b.kind === "table").length,
      equations: blocks.filter((b) => b.kind === "equation").length,
      images: blocks.filter((b) => b.kind === "image" || b.kind === "chart").length,
      page_numbers_dropped: dropped.length,
      dirty_removed: dirtyCleaned ? dirtyCleaned.removed.length : 0,
      needs_vlm: needsVlm,
    },
  };
}

// 原实现（pdfjs 文字流 + 双栏重排 + 页眉页脚启发式），保留作回滚与对照基线
async function parsePdfLegacy(file) {
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
  // 契约 §2.2：seq 与 kind 在**所有**引擎上都要显式产出。这里原样只写 page/text，
  // 会让「PDF 100% 有 kind」这句话只在 mineru 引擎上成立——回落 legacy 时 PDF 一样全 NULL，
  // blocks.seq 又得靠 block-schema.mjs 的 id 兜底。兜底只服务老库，不服务新数据。
  let seq = 0;
  for (const p of pages)
    for (const seg of sentenceSplit(p.text))
      chunks.push({ chapter: null, page: p.page, text: seg, seq: ++seq, kind: "text" });
  return { format: "pdf", engine: "legacy", numPages: pages.length, chunks, cleanedJunk: [...junk] };
}

// 判定表入口：先用 pdfjs 数文本层（R3/R4）与脏行（R12），拿到唯一一条 route，
// 再决定走哪条解析通道。判定与抽取分开——判定只读文件、不建库，可单测可复跑。
async function routePdf(file) {
  const R = await import("./lib/pdf-route.mjs");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let probe;
  try {
    probe = await R.probeTextLayer(file, pdfjs);
  } catch (e) {
    // 探针都读不动（加密/坏文件）：不算「算不出阈值」，直接抛给上游按 R13 记 parse_failed
    throw new Error(`PDF 文本层探针失败：${e.message}`, { cause: e });
  }
  const c = R.classifyPdf(probe);
  // 字段名对齐下游（parsePdfStructured 用 route/routeReason/routeAnnotations），
  // 免得每次调用都要在三个名字之间搬一次
  return { route: c.route, routeReason: c.reason, routeAnnotations: c.annotations, probe };
}

// 回落 legacy 时重写判定注解：legacy 只取文字流，R12 的清洗与 R4 的 OCR 都没执行。
// 直接把判定表的注解原样挂上，日志会声称做了解析层没做的事（复核单 🟡 242）。
// routeReason 保留原样（它说的是「为什么判到这条路」，仍然成立），只改注解。
function legacyAnnotations(route, annotations) {
  const list = Array.isArray(annotations) ? annotations : [];
  return list.map((a) => {
    if (/^R12:/.test(a)) return `R12:未执行（回落 legacy 文字流，脏排版未清洗）← 原判定 ${a}`;
    if (/^R4:/.test(a)) return `R4:未执行（回落 legacy 文字流，未跑 OCR）← 原判定 ${a}`;
    return a;
  });
}

// R3/R4 分流入口：默认 MinerU，不可用回落 legacy，显式指定则只认那一条
async function parsePdf(file) {
  const mode = pdfEngine();
  // legacy 模式保留原行为，不做判定表（对照基线要能与旧版逐字比对）
  if (mode === "legacy") return parsePdfLegacy(file);

  const M = await import("./lib/mineru.mjs");
  const usable = M.mineruAvailable();
  const route = await routePdf(file);

  if (mode === "mineru") {
    if (!usable) throw new Error("BSP_PDF_ENGINE=mineru 但 MinerU 不可用：未设 MINERU_HOME 或其下无 doclib 目录");
    return parsePdfStructured(file, route);
  }
  if (!usable) {
    // 无 MinerU 环境的老机器：零行为变化地回落 legacy，但把判定结论留一行，
    // 免得「明明装了 MinerU 该走结构化」的问题被静默吞掉。
    const legacy = await parsePdfLegacy(file);
    legacy.route = route.route;
    legacy.routeReason = route.routeReason + "（MinerU 不可用，回落 legacy 文字流）";
    // 注解必须写实况：legacy 只取文字流，既没跑 R12 清洗、也没跑 R4 的 OCR。
    // 原样挂 routeAnnotations 会让日志声称做了解析层没做的事（复核单 🟡）。
    legacy.routeAnnotations = legacyAnnotations(route.route, route.routeAnnotations);
    return legacy;
  }
  return parsePdfStructured(file, route);
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
      // 带上 heading 标记：下游要把 h1-6 落成 kind='heading'（契约 §2.2），只留纯文本就分不出来了
      if (t.length >= 8 && !PAGE_ONLY.test(t)) paras.push({ text: t, heading: /^h[1-6]$/.test(tag) });
    }
    if (!paras.length) continue;
    files.push({ title, paras });
  }

  // L1 去噪：跨章重复短行 = 跑页眉（出现在 >40% 章节、≤20 字、至少 3 章）。
  // 只删「重复」不删「首次」——章节标题各章不同不会误伤；PDF 路径早有同款逻辑。
  const lineFreq = new Map();
  for (const f of files) {
    for (const k of new Set(f.paras.map(p => normLine(p.text)).filter(k => k.length > 0 && k.length <= 20)))
      lineFreq.set(k, (lineFreq.get(k) || 0) + 1);
  }
  const runningJunk = new Set([...lineFreq.entries()]
    .filter(([, n]) => n >= 3 && n > files.length * 0.4).map(([k]) => k));

  const chunks = [];
  let chapterNo = 0;
  // 契约 §2.2：seq 必须按文档真实顺序自增，不允许落库时拿主键兜底（block-schema.mjs 那句 r.seq ?? r.id）。
  // epub 的顺序天然存在：spine 顺序 → 本章段落顺序 → 段内句序，三层都定，所以这里直接数。
  let seq = 0;
  for (const f of files) {
    const kept = f.paras.filter(p => !runningJunk.has(normLine(p.text)));
    if (!kept.length) continue;
    chapterNo++;
    const chapter = f.title || `章节 ${chapterNo}`;
    // 长段落也要过 sentenceSplit（900 字上限）：单个大段落直接入块会让向量质量和 FTS 定位双输
    for (const p of kept)
      for (const seg of sentenceSplit(p.text))
        chunks.push({ chapter, page: null, text: seg, seq: ++seq, kind: p.heading ? "heading" : "text" });
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
  let tableSeq = 0;   // P3-①：每个 <table> 元素 = 一张表，元素内所有行同 tid
  const tagRe = /<(h[1-6]|p|table)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    if (tag === "table") {
      const tid = ++tableSeq;
      const tbl = tableFromHtml(m[2]);
      // 每行都挂结构原件（同一张表共享 html/header），供 packTable 把 table_html
      // 与 table_rows 一路带到块上——块文本与旧 tableToText 逐字一致。
      for (const row of tbl.rows)
        items.push({
          tag: "p", text: row.text, fromTable: true, tid,
          table_html: tbl.html, table_header: tbl.header, table_cells: row.cells,
        });
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

  // P3-① 表格整表成块（promote 之后——见 mergeTableRows 注释；BSP_TABLE=0 关）
  let tableStats = null;
  let slicedItems = withHeadings;
  if (!tableOff()) {
    const before = withHeadings.filter(it => it.fromTable).length;
    if (before > 1) {
      slicedItems = mergeTableRows(withHeadings);
      const blocks = slicedItems.filter(it => it.fromTable).length;
      if (blocks !== before) tableStats = { rows: before, blocks };
    }
  }

  const chunks = [];
  let chapter = "前言";
  let chapterNo = 0;
  // 契约 §2.2：seq 按文档真实顺序自增（这里就是 slicedItems 的遍历顺序），落库时不拿主键兜底。
  let seq = 0;
  // P3-② 章节层级：docx 按 h1-h6 标签层级入栈；扁平 chapter 行为逐字不变
  let pathStack = [];
  for (const it of slicedItems) {
    if (it.heading) { chapterNo++; chapter = it.text; pathStack = [it.text]; continue; }
    if (/^h[1-6]$/.test(it.tag)) {
      chapterNo++; chapter = it.text;
      const lv = +it.tag[1];
      pathStack = pathStack.slice(0, lv - 1);
      pathStack[lv - 1] = it.text;
      continue;
    }
    const cm = it.text.match(/^(第[0-9一二三四五六七八九十百]+章)\s*(.*)$/);
    if (cm) { chapterNo++; chapter = cm[1]; pathStack = [cm[1]]; }
    // P3-①：整表块原样进块（不过 sentenceSplit——行内的句号不该把表格切碎）。
    // 首行的「第X章」匹配仍生效（与旧行为对齐）；行内不再切章（旧行为把表内
    // 文字误读成章节标记，合并后消失——这是修复不是回归）。
    if (it.fromTable) { chunks.push({ chapter, chapter_path: chapterPathOf(pathStack), page: null, text: it.text, seq: ++seq, kind: it.table_html ? "table" : "text", ...(it.table_html ? { table_html: it.table_html, table_header: it.table_header, table_rows: it.table_rows } : {}) }); continue; }
    // 长段落也要过 sentenceSplit（同 epub，900 字上限）
    for (const seg of sentenceSplit(it.text))
      chunks.push({ chapter, chapter_path: chapterPathOf(pathStack), page: null, text: seg, seq: ++seq, kind: "text" });
  }
  return { format: "docx", chapters: chapterNo, chunks, cleanedJunk: [], tableStats };
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
  let tableSeq = 0;          // P3-① 表格 id：每张表一个（空行/任何非表行 = 表边界）
  let prevWasTableRow = false;
  for (const line of raw.split(/\r?\n/)) {
    const bare = line.replace(/^\s*(?:>\s*)+/, "");         // 先剥 blockquote 标记
    // P3-①：任何非表格行（含空行/围栏/标题/段落）都断表——放在所有分支之前，
    // 围栏等提前 continue 的路径也不会漏断
    if (!/^\s*\|.*\|\s*$/.test(bare)) prevWasTableRow = false;
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
      if (/[\u4e00-\u9fffA-Za-z]/.test(ht)) items.push({ tag: "h", text: ht, level: hm[1].length });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(bare)) {                      // 表格行 → 文本行
      if (!prevWasTableRow) tableSeq++;                     // 新表开始（分隔行不断表）
      prevWasTableRow = true;
      const cells = bare.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue; // 分隔行
      const row = cells.join(" | ");
      if (row.replace(/\|/g, "").trim()) items.push({ tag: "p", text: row, fromTable: true, tid: tableSeq, table_cells: cells.map(t => ({ text: t, rowspan: 1, colspan: 1 })) });
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
  let skipped = [];
  let files;
  if (stat.isDirectory()) {
    const walked = walkMdDetailed(file);
    skipped = walked.skipped;
    files = walked.files.sort((a, b) => a.localeCompare(b, "zh", { numeric: true }));
  } else {
    files = [file];
  }
  const items = [];
  let droppedCode = 0;
  const fileRanges = [];   // 每个文件在 items 里的 [start, end)——表格合并不跨文件
  for (const f of files) {
    const start = items.length;
    const { items: fitems, droppedCode: dc } = parseMdFile(f);
    droppedCode += dc;
    if (!fitems.some(it => it.tag === "h")) {
      items.push({ tag: "h", text: path.basename(f).replace(/\.md$/i, "") });
    }
    items.push(...fitems);
    fileRanges.push([start, items.length]);
  }
  const { chunks, tableStats, chapterNo } = itemsToChunks(items, fileRanges);
  return { format: "md", chapters: chapterNo, chunks, cleanedJunk: [], droppedCode, files: files.length, tableStats, skipped };
}

// txt/md 共用的「条目 → 块」装配段（R10：TXT/MD 同走现管道）。
// 抽出来是为了让 .txt 与 md 走**同一段**代码：以后改章节/表格/切片只在改这一处，
// 不会出现「md 改了 txt 没改」的隐性分叉。
function itemsToChunks(items, fileRanges) {
  const withHeadings = promotePlainHeadings(items);

  // P3-① 表格整表成块（promote 之后——见 mergeTableRows 注释；BSP_TABLE=0 关；
  // ranges 保证 A 文件的尾表与 B 文件的首表不相并）
  let tableStats = null;
  let slicedItems = withHeadings;
  if (!tableOff()) {
    const before = withHeadings.filter(it => it.fromTable).length;
    if (before > 1) {
      slicedItems = mergeTableRows(withHeadings, fileRanges);
      const blocks = slicedItems.filter(it => it.fromTable).length;
      if (blocks !== before) tableStats = { rows: before, blocks };
    }
  }

  const chunks = [];
  // 契约 §2.2：seq 必须按文档真实顺序自增，落库时不许拿主键兜底
  // （block-schema.mjs 的 `r.seq != null ? r.seq : r.id` 只用于老库兼容，不是正向逻辑）
  let seq = 0;
  let chapter = "前言";
  let chapterNo = 0;
  // P3-② 章节层级：pathStack 维护「卷 › 章 › 节」栈（md 按 # 层级）；
  // 扁平 chapter 行为逐字不变（chapter 仍是叶节点名），chapter_path 是新增字段
  let pathStack = [];
  for (const it of slicedItems) {
    if (it.tag === "h" || it.heading) {
      chapterNo++; chapter = it.text;
      // 真标题按 # 层级入栈（越级深跳也稳：栈截断到本级再放）；启发式提升的
      // 标题（tag=p）无层级信息，按顶层重置
      pathStack = it.level ? [...pathStack.slice(0, it.level - 1)] : [];
      pathStack[it.level ? it.level - 1 : 0] = it.text;
      pathStack = pathStack.slice(0, it.level ? it.level : 1);
      continue;
    }
    // P3-①：整表块原样进块（不过 sentenceSplit——行内句号不切表）
    if (it.fromTable) { chunks.push({ chapter, chapter_path: chapterPathOf(pathStack), page: null, text: it.text, seq: ++seq, kind: it.table_html ? "table" : "text", ...(it.table_html ? { table_html: it.table_html, table_header: it.table_header, table_rows: it.table_rows } : {}) }); continue; }
    for (const seg of sentenceSplit(it.text))
      chunks.push({ chapter, chapter_path: chapterPathOf(pathStack), page: null, text: seg, seq: ++seq, kind: "text" });
  }
  return { chunks, tableStats, chapterNo };
}

// R10：.txt → 现管道。txt 没有标记语法，两件事都得从文件本身算出来：
//   ① 段落边界：空行一定是段落边界；此外「一行以句末标点结尾」也判段落结束。
//      依据是不含空行的 txt 常见两种排版——(a) 排版折行：句子中间的硬换行，
//      断处不在句末，要拼回去；(b) 逐行一段：每行都是一句/一段，必须切开
//      （实测 books\lunyu-xueer-zh.txt 16 行全以「？」「。」「」」收尾、无空行，
//      按空行切只剩 1 块 673 字符，一章一句全糊在一起）。
//      两条判据都是纯粹看文件，没有「看情况」。
//   ② 段内折行的换行换成空格（空白归一，字符流不变），不在一句话中间切块。
// 章节靠 promotePlainHeadings 认中文序号行（一、/1. …，与 md 那条同源）。
const TXT_PARA_END = /[。！？!?…；;][」』】）"'”’]*$|[.](?=\s*$)/;
function parseTxt(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const items = [];
  const pushPara = (lines) => {
    const text = collapse(lines.join(" "));
    if (text) items.push({ tag: "p", text });
  };
  for (const block of raw.split(/\n{2,}/)) {
    let buf = [];
    for (const line of block.split("\n")) {
      if (!line.trim()) { if (buf.length) { pushPara(buf); buf = []; } continue; }
      buf.push(line);
      // 句末收尾 → 此处是段落边界，切一刀
      if (TXT_PARA_END.test(line.trim())) { pushPara(buf); buf = []; }
    }
    if (buf.length) pushPara(buf);
  }
  // 没有可用标题时给个书名，避免整本挂在「前言」（与 parseMd 对无标题 md 的处理一致）。
  // 判「有没有标题」要算上 promotePlainHeadings 会提升的那些行——否则「一、」「二、」
  // 型的书会平白多出一层书名章节（实测 fold-test：两章被算成三章）。
  if (!promotePlainHeadings(items).some((it) => it.tag === "h" || it.heading)) {
    items.unshift({ tag: "h", text: path.basename(file).replace(/\.txt$/i, "") });
  }
  const { chunks, tableStats, chapterNo } = itemsToChunks(items, [[0, items.length]]);
  return { format: "txt", chapters: chapterNo, chunks, cleanedJunk: [], droppedCode: 0, files: 1, tableStats, skipped: [] };
}

// ---------- PPTX（R7）：zip 魔数 + ppt/ 目录；每 slide 按形状成块 ----------
// 判定表 R7「每 slide 一个块单元，文本+备注分开」。块粒度取「形状」而不是「整页」：
// 一页里标题形状与正文形状是两类东西，合成一个块会把标题埋进正文的 text stream 里，
// kind 也没法一页两种值。块文本 = 该形状内各段以 \n 连接（段是 <a:p>，字是 <a:t>）。
// 位置：page = slide 文件名里的数字（从 1），block_index = 页内块序号（从 0，与 MinerU 同标尺），
// block_type 用 slide_title / slide_text 标明来源，三者齐了 block_pos.orig_block 才能定位。
// notesSlides 本轮不解析（设计稿 01:85 已写明），所以备注文字不会出现在块里。
const PPT_SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/i;
const PPT_TITLE_PH = new Set(["title", "ctrTitle"]);
function parsePptx(file) {
  const zip = new AdmZip(file);   // 非 zip 在这里直接抛错（上游 main 统一接住记账）
  // 必须按数字升序：字符串序会把 slide10 排到 slide2 前面（12 页以上的书必错）
  const slides = zip.getEntries()
    .map(e => ({ entry: e, no: parseInt((PPT_SLIDE_RE.exec(e.entryName) || [])[1] || "", 10) }))
    .filter(s => Number.isFinite(s.no))
    .sort((a, b) => a.no - b.no);

  const chunks = [];
  let seq = 0;
  let chapterNo = 0;
  for (const s of slides) {
    const doc = new DOMParser().parseFromString(zip.readAsText(s.entry), "application/xml");
    // getElementsByTagName 返回文档顺序 —— 保序靠它，不自己排
    const shapes = [...doc.getElementsByTagName("p:sp")];
    const local = [];
    let title = "";
    for (const sp of shapes) {
      const ph = sp.getElementsByTagName("p:ph")[0];
      // 无 <p:ph> 的形状一律 text：实测「我的书房-项目讲解.pptx」12 页 0 个占位符，
      // 靠版式猜标题不可靠，只有显式声明了 title/ctrTitle 才算标题。
      const isTitle = Boolean(ph) && PPT_TITLE_PH.has(String(ph.getAttribute("type") || "").trim());
      const paras = [];
      for (const p of sp.getElementsByTagName("a:p")) {
        const t = collapse([...p.getElementsByTagName("a:t")].map(x => x.textContent || "").join(""));
        // L1 去噪：纯页码行（"12" / "第 12 页"），与 epub/docx 同一把尺子
        if (!t || PAGE_ONLY.test(t)) continue;
        paras.push(t);
      }
      if (!paras.length) continue;
      if (isTitle && !title) title = paras[0];
      local.push({
        text: paras.join("\n"),
        kind: isTitle ? "heading" : "text",
        block_type: isTitle ? "slide_title" : "slide_text",
        block_index: local.length,
      });
    }
    if (!local.length) continue;   // 纯图片页/空白页：没有可检文字，不产块
    chapterNo++;
    const chapter = title || `幻灯片 ${s.no}`;
    for (const b of local)
      chunks.push({
        chapter, chapter_path: null, page: s.no, text: b.text, seq: ++seq,
        kind: b.kind, block_type: b.block_type, block_index: b.block_index, bbox: null,
      });
  }
  return { format: "pptx", chapters: chapterNo, chunks, numPages: slides.length, cleanedJunk: [] };
}

// ---------- XLSX（R8）：zip 魔数 + xl/ 目录；每 sheet 转表块 ----------
// 判定表 R8「每 sheet 转表块（复用 packTable 的表头重复机制）」：块文本 = 各行以 \n 连接、
// 行内各格以 " | " 连接（与 docx 的 tableFromHtml 逐字同款），结构原件走 {html,header,rows}
// 三键——buildDb:888 只认这三个键，另造键等于 table_json 失联。
// 位置：page = sheet 在 workbook 里的序号（从 1，空 sheet 也占号），block_index = sheet 内块序号（从 0）。
const xlsxEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// 列字母 → 0 基列号（"A"=0，"AA"=26）；单元格靠 r="B3" 定位，不靠出现次序
const xlsxCol = (ref) => {
  const m = /^([A-Z]+)/i.exec(String(ref || ""));
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};
// Excel 日期序列号 → YYYY-MM-DD（基准 1899-12-30，实测 46328 = 2026-11-02，与样书手对一致）
const XLSX_EPOCH_MS = Date.UTC(1899, 11, 30);
const xlsxSerialDate = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return new Date(XLSX_EPOCH_MS + Math.round(n * 86400000)).toISOString().slice(0, 10);
};
// 内置日期格式号（Excel 规范）+ 自定义 formatCode 含 yy/dd 的（样书 165=y"yyy-mm-dd"）
const XLSX_BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 34, 35, 36, 45, 46, 47, 50, 57]);
const xlsxIsDateFmt = (numFmtId, code) =>
  XLSX_BUILTIN_DATE.has(numFmtId) || (/[ymd]/i.test(String(code || "")) && !/[#0]/.test(String(code || "")));
function parseXlsx(file) {
  const zip = new AdmZip(file);
  const read = (n) => { const e = zip.getEntry(n); return e ? zip.readAsText(e) : null; };

  // 共享字符串（样书没有这个部件，全部 inlineStr —— 两条路都得走）
  const shared = [];
  const ssXml = read("xl/sharedStrings.xml");
  if (ssXml) {
    const ss = new DOMParser().parseFromString(ssXml, "application/xml");
    for (const si of ss.getElementsByTagName("si"))
      shared.push([...si.getElementsByTagName("t")].map(x => x.textContent || "").join(""));
  }

  // 样式：cellXfs 的 s="N" 是索引，映射到 numFmtId；numFmtId 决定这格是不是日期
  const styleFmt = [];
  const stXml = read("xl/styles.xml");
  if (stXml) {
    const st = new DOMParser().parseFromString(stXml, "application/xml");
    const custom = new Map();
    for (const nf of st.getElementsByTagName("numFmt"))
      custom.set(parseInt(nf.getAttribute("numFmtId") || "", 10), nf.getAttribute("formatCode") || "");
    const xfs = st.getElementsByTagName("cellXfs")[0];
    if (xfs) for (const xf of xfs.getElementsByTagName("xf")) {
      const id = parseInt(xf.getAttribute("numFmtId") || "0", 10) || 0;
      styleFmt.push({ id, date: xlsxIsDateFmt(id, custom.get(id)) });
    }
  }

  // workbook.xml 的 sheet 顺序 = 展示顺序；r:id 经 workbook.xml.rels 映射到实际部件路径
  const wbXml = read("xl/workbook.xml");
  const relXml = read("xl/_rels/workbook.xml.rels");
  if (!wbXml) throw new Error("xlsx 缺 xl/workbook.xml，不是真正的 xlsx");
  const wb = new DOMParser().parseFromString(wbXml, "application/xml");
  const rels = new Map();
  if (relXml) {
    const rd = new DOMParser().parseFromString(relXml, "application/xml");
    for (const r of rd.getElementsByTagName("Relationship"))
      rels.set(r.getAttribute("Id"), r.getAttribute("Target"));
  }
  const sheets = [...wb.getElementsByTagName("sheet")].map((sh, i) => {
    // xmldom 对 r:id 这种带前缀的属性，getAttribute("r:id") 在部分文件上取不到，兜底扫属性名
    let rid = sh.getAttribute("r:id") || sh.getAttribute("id") || "";
    if (!rid) for (const a of sh.attributes || []) if (/:id$/i.test(a.name)) { rid = a.value; break; }
    let target = rels.get(rid) || "";
    target = String(target).replace(/^\/+/, "").replace(/^\.\//, "");
    if (target && !target.startsWith("xl/")) target = "xl/" + target;
    return { name: sh.getAttribute("name") || `Sheet${i + 1}`, path: target || `xl/worksheets/sheet${i + 1}.xml` };
  });

  const chunks = [];
  let seq = 0;
  sheets.forEach((sheet, idx) => {
    const xml = read(sheet.path);
    if (!xml) return;                                  // 部件缺失：跳过，但 page 号仍占位
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const grid = [];
    for (const row of doc.getElementsByTagName("row")) {
      const cells = [];
      for (const c of row.getElementsByTagName("c")) {
        const col = xlsxCol(c.getAttribute("r"));
        if (col < 0) continue;
        const t = c.getAttribute("t") || "n";
        const vEl = c.getElementsByTagName("v")[0];
        const raw = vEl ? (vEl.textContent || "") : "";
        let val = "";
        if (t === "inlineStr") {
          const is = c.getElementsByTagName("is")[0];
          val = is ? [...is.getElementsByTagName("t")].map(x => x.textContent || "").join("") : "";
        } else if (t === "s") {
          const si = parseInt(raw, 10);
          val = Number.isFinite(si) && shared[si] != null ? shared[si] : "";
        } else if (t === "b") {
          val = raw === "1" ? "TRUE" : "FALSE";
        } else if (raw !== "") {
          const sIdx = parseInt(c.getAttribute("s") || "", 10);
          const fmt = Number.isFinite(sIdx) ? styleFmt[sIdx] : null;
          val = fmt && fmt.date ? xlsxSerialDate(raw) : raw;
        }
        // 单元格里的 NUL 是 xlsx 常见脏字符（页脚/隐藏列残留），去掉再用；
        // 用 split/join 而不是正则，免得 eslint no-control-regex 红
        cells[col] = collapse(String(val).split(String.fromCharCode(0)).join(""));
      }
      if (cells.some(v => v && v.length)) grid.push(cells);
    }
    if (!grid.length) return;                          // 空 sheet 跳过（设计：空 sheet 不产块）
    // 补齐到等宽并掐掉右侧全空列：表块要求矩形，否则表头与数据行错位
    const width = Math.max(...grid.map(r => r.length));
    const rows = grid.map(r => Array.from({ length: width }, (_, i) => r[i] ?? ""));
    let cut = width;
    while (cut > 0 && rows.every(r => !r[cut - 1])) cut--;
    const rect = rows.map(r => r.slice(0, Math.max(1, cut)));
    const cellTexts = rect.map(r => r.map(v => v ?? ""));
    // 块文本按行拼接时掐掉行尾空单元：合并单元格的行（标题行/表头行）会留一串空格，
    // join 出来就是 "标题 |  |  |  |" 的噪声。结构 table_rows 仍保留矩形，可无损还原。
    const rowTexts = cellTexts.map(cs => {
      let n = cs.length;
      while (n > 0 && !cs[n - 1]) n--;
      return cs.slice(0, n).join(" | ");
    });
    const tableHtml = `<table>${cellTexts.map(cs => `<tr>${cs.map(c => `<td>${xlsxEsc(c)}</td>`).join("")}</tr>`).join("")}</table>`;
    const items = packTable(rowTexts, { table_html: tableHtml, table_header: cellTexts[0], table_rows: cellTexts });
    items.forEach((it, bi) => {
      chunks.push({
        chapter: sheet.name, chapter_path: null, page: idx + 1, text: it.text, seq: ++seq,
        kind: it.table_html ? "table" : "text", block_type: "sheet_table", block_index: bi,
        bbox: null, table_html: it.table_html, table_header: it.table_header, table_rows: it.table_rows,
      });
    });
  });
  return { format: "xlsx", chapters: sheets.length, chunks, numPages: sheets.length, cleanedJunk: [] };
}

// R0 目录/文件黑名单（判定表第一道闸，不可关闭——它挡的是「不是书的东西」）：
//   目录级（命中即整段跳过，不递归）：
//     _origin    抓取工具的原始快照目录
//     _private   作者简历/私人备注（清洗层删不掉，只能在入口拦）
//     node_modules / .git / .svn   代码仓库痕迹
//   文件级（设计稿 01:79「文件级 *-raw.* 同理」+ 实测补的 _origin 文件）：
//     *-raw.md / *-raw.txt  上游转换中间产物（assets.mjs:101 书架侧已经跳过，
//                   解析侧原来只拦 md、没拦 txt：实测 books\ 下 3 个 -raw.txt
//                   与同名正文并存，拦不住就一本两命）
//     *_origin.md  d2l 中英对照目录的英文原稿（实测：294 个 md 里 139 个是 _origin，
//                  首行是 "# Using AWS EC2 Instances"，中文正文另有同名 .md；
//                  不拦就一本书两份正文、检索双份命中）
// 判定只看名字，大小写不敏感；命中一律不进解析，数量记账到 skipped。
const DIR_DENYLIST = ["_origin", "_private", "node_modules", ".git", ".svn"];
const FILE_DENY_RE = [/-raw\.(md|txt)$/i, /_origin\.md$/i];
const isDeniedDir = (name) => DIR_DENYLIST.includes(String(name).toLowerCase());
const isDeniedFile = (name) => FILE_DENY_RE.some((re) => re.test(String(name))) || /^_private/i.test(String(name));

// 返回 {files, skipped}：skipped 里记被 R0 拦下的相对路径，建库时打印（可审计，不是静默丢）
function walkMdDetailed(dir, root = dir) {
  const files = [];
  const skipped = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join("/");
    if (isDeniedDir(e.name)) { skipped.push(rel); continue; }
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = walkMdDetailed(p, root);
      files.push(...sub.files);
      skipped.push(...sub.skipped);
    } else if (/\.md$/i.test(e.name)) {
      if (isDeniedFile(e.name)) { skipped.push(rel); continue; }
      files.push(p);
    }
  }
  return { files, skipped };
}

function walkMd(dir) {
  return walkMdDetailed(dir).files;
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
        chapter_path TEXT,
        page INTEGER,
        text TEXT NOT NULL,
        kind TEXT,
        bbox TEXT,
        block_type TEXT,
        image_path TEXT,
        seq INTEGER,
        table_json TEXT,
        block_index INTEGER
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
    // V3R7-①：token 账 + 章节质量（get_outline / read_full_book 闸门 / list_books 展示的地基）。
    // main() 里算好随 parsed 传下来（ESM 动态导入只能发生在 async 的 main）；直调 buildDb
    // 的老测试不传即不写这两个键（回补脚本与 list_books 兜底会补上）。
    if (parsed.token_meta) {
      setMeta.run("total_tokens", String(parsed.token_meta.total_tokens));
      setMeta.run("chapter_quality", JSON.stringify(parsed.token_meta.chapter_quality));
    }
    setMeta.run("content_hash", contentHash(file));
    if (parsed.files) setMeta.run("md_files", String(parsed.files));
    if (parsed.droppedCode) setMeta.run("dropped_code", String(parsed.droppedCode));
    if (parsed.struct) setMeta.run("struct_report", JSON.stringify(parsed.struct));
    if (parsed.tableStats) setMeta.run("table_stats", JSON.stringify(parsed.tableStats));
    // R11：语种按块判定后的整书聚合标签。search.mjs:85 直接读 meta.lang，读不到才现场抽样。
    // 只写标记，不改路径、不改正文。
    if (parsed.lang_meta) {
      setMeta.run("lang", parsed.lang_meta.lang);
      setMeta.run("lang_source", "block-vote");
      setMeta.run("lang_detail", JSON.stringify({
        zhShare: +parsed.lang_meta.zhShare.toFixed(4),
        chars: parsed.lang_meta.chars,
        counts: parsed.lang_meta.counts,
        skipped: parsed.lang_meta.skipped,
        nameLang: parsed.lang_meta.nameLang,
        conflict: parsed.lang_meta.conflict,
      }));
    }

    const tx = db.transaction(() => {
      // 契约 v3 §3 方案 1：11 列（4 原有 + 7 新）。新列只描述块，不碰 text 一个字节。
      const ins = db.prepare(
        "INSERT INTO chunks(chapter, chapter_path, page, text, kind, bbox, block_type, image_path, seq, table_json, block_index) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
      );
      for (const c of parsed.chunks) {
        const r = ins.run(
          c.chapter,
          c.chapter_path ?? null,
          c.page,
          c.text,
          c.kind ?? null,
          // bbox 以 JSON 数组字符串落盘：归一化 [0,1]，顺序 [x0,y0,x1,y1]（契约 §5.1）
          c.bbox ? JSON.stringify(c.bbox) : null,
          c.block_type ?? null,
          c.image_path ?? null,
          Number.isFinite(c.seq) ? c.seq : null,
          // 三合一序列化只在这里做一次（契约 §2.3 写死「不许各拼各的」）
          c.table_html || c.table_header || c.table_rows
            ? JSON.stringify({ html: c.table_html ?? null, header: c.table_header ?? null, rows: c.table_rows ?? null })
            : null,
          Number.isFinite(c.block_index) ? c.block_index : null
        );
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

  // R1/R2 入口闸：扩展名白名单 + 魔数与扩展名一致性（判据只看文件字节，不看文件名语义）。
  // 目录书（md 目录）跳过——目录本身没有扩展名，其下每个 md 由 R0 逐文件判。
  // 命中即拒收 + 落一条台账（library\_rejected.jsonl），不入检索。
  const entryGate = await import("./lib/parse-gate.mjs");
  // 统一的拒收记账助手：打印原因 → 追加一行台账（写失败只警告，拒收结果不变）
  const rejectBook = (stage, code, reason) => {
    console.error(reason);
    const r = entryGate.appendReject({ file, ext, stage, code, reason });
    if (!r.ok) console.error(`  （台账写入失败，拒收仍生效：${r.error}）`);
    else console.error(`  已记账：${r.path}`);
  };
  if (!isDir) {
    // R0 文件级黑名单对「单文件入参」同样成立：目录书靠 walkMdDetailed 拦，
    // 单文件走不到那里。实测 books\ 下三个 *-raw.txt 与正式稿并存，直接喂
    // build-book 会把上游中间产物建成本书（书架侧 assets.mjs:101 是跳过的）。
    if (isDeniedFile(path.basename(file))) {
      rejectBook("gate", "denied", `拒收（denied）：文件名命中 R0 黑名单（-raw / _origin / _private），上游中间产物不是书`);
      process.exitCode = 2;
      return;
    }
    const g = entryGate.gateFile(file);
    if (!g.ok) { rejectBook("gate", g.code, `拒收（${g.code}）：${g.reason}`); process.exitCode = 2; return; }
  }

  // 解析：每种格式单独接错（损坏文件/伪装扩展名在这里现形，而不是蹦一屏英文堆栈）
  let parsed;
  try {
    if (ext === ".pdf") parsed = await parsePdf(file);
    else if (ext === ".epub") parsed = parseEpub(file);
    else if (ext === ".docx") parsed = await parseDocx(file);
    else if (ext === ".md" || ext === ".markdown") parsed = parseMd(file);
    // R10：.txt 原来白名单放行、这里却不认，直接喂 build-book 会报「不支持的格式」
    // 且不进台账（R1 说放行、R10 说走现管道，两边打架）。现在真走现管道。
    else if (ext === ".txt") parsed = parseTxt(file);
    // R7/R8：入口闸已放行 .pptx/.xlsx，这里必须真认得它们，否则会出现
    // 「白名单说能进、分派说不支持」的两头打架（R10 的 .txt 就踩过这坑）。
    else if (ext === ".pptx") parsed = parsePptx(file);
    else if (ext === ".xlsx") parsed = parseXlsx(file);
    else { console.error("不支持的格式: " + ext + "（支持 .pdf/.epub/.docx/.pptx/.xlsx/.txt/.md，或 md 目录）"); process.exitCode = 1; return; }
  } catch (e) {
    // R13：解析器抛错 → 标 parse_failed 记账，不入检索。与 R1/R2 同一条台账，
    // 用 code 区分「输入本来不是书」（unsupported/fake_ext）还是「是书但解不开」
    // （parse_failed：加密、损坏、解析器内部错误）。不抛栈给用户，只留一行原因。
    rejectBook("parse", "parse_failed", `解析失败（${ext}）: ${e.message}\n文件可能损坏、加密或不是真正的 ${ext} 文件。`);
    process.exitCode = 1;
    return;
  }
  // 判定表的落行结果（R12/R3/R4）：一行日志说清这本书为什么走这条路。
  // needs_calibration 要排在「0 块」检查之前——它是「判定不出可信阈值」，与「解析出 0 块」
  // 是两件事，台账里必须分开，否则下次没人知道该修阈值还是该查文件。
  if (parsed.route) {
    console.log(`  解析路径: ${parsed.route} — ${parsed.routeReason}`);
    for (const a of parsed.routeAnnotations || []) console.log(`    · ${a}`);
  }
  if (parsed.route === "needs_calibration") {
    rejectBook("parse", "needs_calibration", `判定表算不出可信阈值：${parsed.routeReason}`);
    process.exitCode = 1;
    return;
  }
  if (!parsed.chunks.length) {
    // 解析成功但一块都没切出来：扫描图片型/空白的 PDF 落到这里。同样是 parse_failed 的一种
    // （R4 的 OCR 降级没救回来时也走这条），必须记账——否则「导入后书架什么都没有」无从追。
    rejectBook("parse", "parse_failed", "解析出 0 块：文件可能是空的、扫描图片型 PDF 或加密文档。");
    process.exitCode = 1;
    return;
  }
  // R12 清洗结果记账：丢了几条、丢的是什么（人工抽查用）
  if (parsed.dirtyCleaned) {
    const c = parsed.dirtyCleaned;
    console.log(`  脏排版清洗: 丢弃 ${c.removed.length} 块（论坛签名/楼层号），保留 ${c.kept} 块`);
    for (const x of c.removed.slice(0, 3)) console.log(`    · p${x.page} ${JSON.stringify(x.text)}`);
  }

  // P3-① 表格整表成块的账（BSP_TABLE=0 或无表书不打印）
  if (parsed.tableStats) {
    console.log(`  表格整表成块: ${parsed.tableStats.rows} 行 → ${parsed.tableStats.blocks} 块（表头随组重复，单块 ≤900 字）`);
  }

  // 结构化改造（V3 第四波 P2）：解析之后、切片之前——清洗坏数据/不全数据/乱码符号。
  // 老板定的新流程：结构化改造 → 切片 → 洗数据（原来是切完片直接洗）。
  // 铁律：干净的书零变化（存量四书块数锁定不受影响）；硬拦只发生在烧算力之前；
  //   BSP_STRUCT=0 可整段关掉（排障用）。修不动的乱码才拦，能修的当场修。
  // onStage 是桌面横幅通知回调（副作用，不是建库本体）：回调抛错不能把建库
  // 拖死——横幅坏了书还得建（P2-05 实测穿出 main 卡「结构化改造中」）。
  // 契约：onStage 必须是同步回调（当前唯一调用方 jobs.mjs 的 emit 即同步）；
  // try 只捕同步抛错——传 async 回调并抛错会变 unhandledRejection，比穿出更糟。
  // 回调异常留一行日志（全程仅 2 次不可能刷屏；空吞会让「横幅永不更新」零信号）
  try { opts.onStage?.("structurize"); } catch (e) { console.error(`  横幅回调异常（不阻断建库）: ${e?.message || e}`); }
  // 开关判定：归一化后只认精确 "0"（P2-04）。容错三件事——首尾空白、零宽
  // 字符（\u200B 不在 trim 的 WhiteSpace 类里，隐形字符会让逃生开关静默
  // 失灵）、全角数字（NFKC 把 "０" 归一成 "0"）
  const structOff = String(process.env.BSP_STRUCT ?? "").replace(/[\u200b-\u200d]/g, "").normalize("NFKC").trim() === "0";
  if (!structOff) {
    const { structurizeChunks, assessCleaned } = await import("./lib/structurize.mjs");
    const st = structurizeChunks(parsed.chunks);
    parsed.chunks = st.chunks;
    parsed.struct = st.report;
    const gate = assessCleaned(parsed.chunks, st.report);
    if (!gate.ok) {
      // R13：结构化改造硬拦（内容太少/乱码严重）同样是「是书但解不开」，记 parse_failed
      rejectBook("parse", "parse_failed", gate.reason);
      process.exitCode = 1;
      return;
    }
    const r = st.report;
    if (r.droppedEmpty || r.droppedGarbage || r.repairedMojibake || r.strippedControls || r.strippedPua || r.strippedFffd || r.strippedSurrogates) {
      console.log(`  结构化改造: 去空块 ${r.droppedEmpty} · 去垃圾块 ${r.droppedGarbage} · 修乱码块 ${r.repairedMojibake} · 清控制符 ${r.strippedControls} / 私用区 ${r.strippedPua} / 替换符 ${r.strippedFffd} / 孤立代理对 ${r.strippedSurrogates} 处`);
    }
  }
  try { opts.onStage?.("slice"); } catch (e) { console.error(`  横幅回调异常（不阻断建库）: ${e?.message || e}`); }

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
  // 书名规范（2026-10-20）：书架标题中文优先——有原文名放括号里（「傲慢与偏见（Pride and Prejudice）」）。
  // 没传 --title 且文件名里没有中文 → 提示补名（不阻断：建库能用，但书架会是一串拼音/英文）。
  // 硬门在 guard：title === id 视为「未起名」，正式收录前必撞红。
  if (!titleArg && !/[\u4e00-\u9fff]/.test(title)) {
    console.error(`⚠ 书名「${title}」不含中文——建议加 --title 起中文名（中文在前，原文名放括号：如 "傲慢与偏见（Pride and Prejudice）"）`);
  }

  // V3R7-①：token 账 + 章节质量 meta——必须在语义分块之后算（块边界变了字符总数才锁定），
  // 建库时一次算好落 meta，读时（get_outline/read_full_book/list_books）零成本。
  const { detectLang, bookTokenTotal, chapterQuality } = await import("./lib/token-estimate.mjs");
  const finalChars = parsed.chunks.reduce((a, c) => a + c.text.length, 0);
  parsed.token_meta = {
    total_tokens: bookTokenTotal(finalChars, detectLang(parsed.chunks.map(c => c.text))),
    chapter_quality: chapterQuality(parsed.chunks),
  };

  // R11 语种标注：按块投票、按字符加权（01:163-168）。只出标签，不改路径。
  // 取块文本全集而不是前 200 块——旧 detectLang 只看开头，中英混排书会被开头几章判反。
  const { resolveLang } = await import("./lib/lang-tag.mjs");
  parsed.lang_meta = resolveLang(parsed.chunks.map(c => c.text), path.basename(file));
  if (parsed.lang_meta.conflict) {
    console.error(`⚠ ${parsed.lang_meta.note}`);
  }

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
  console.log(`  格式: ${parsed.format} | 切片: ${chunkCount} 块 | 原文: ${totalChars} 字符 ≈ ${parsed.token_meta ? Math.round(parsed.token_meta.total_tokens / 1000) + "K" : "?"} token`);
  if (parsed.numPages) console.log(`  页数: ${parsed.numPages}`);
  if (parsed.chapters) console.log(`  章节: ${parsed.chapters}`);
  if (parsed.files) console.log(`  md 文件: ${parsed.files} 篇`);
  if (parsed.skipped && parsed.skipped.length) console.log(`  R0 排除: ${parsed.skipped.length} 个（_origin/_private/-raw/代码仓库痕迹）`);
  if (parsed.droppedCode) console.log(`  已去代码块: ${parsed.droppedCode} 段`);
  if (parsed.cleanedJunk.length) console.log(`  已去页眉页脚: ${parsed.cleanedJunk.length} 种重复行`);
  if (parsed.lang_meta) {
    const lm = parsed.lang_meta;
    console.log(`  语种(R11 块级判定): ${lm.lang} — 中文占字母类字符 ${(lm.zhShare * 100).toFixed(1)}%（zh ${lm.counts.zh} 块 / en ${lm.counts.en} 块 / 公式 ${lm.counts.formula} 块）`);
  }
  return { chunkCount, totalChars, struct: parsed.struct || null };
}

// ---------- 入口：直接运行才启动 CLI；被 import/require 时只暴露函数（测试用真实实现） ----------
if (require.main === module) {
  main().catch(e => { console.error("建库失败:", e?.stack || e?.message || e); process.exitCode = 1; });
  process.on("unhandledRejection", e => { console.error("未处理的异步错误:", e?.stack || e?.message || e); process.exitCode = 1; });
}

module.exports = { collapse, normLine, sentenceSplit, decodeHtml, parsePdf, parseEpub, parseDocx, parsePptx, parseXlsx, parseMd, parseMdFile, parseTxt, itemsToChunks, tableToText, promotePlainHeadings, walkMd, buildDb, main, contentHash };
