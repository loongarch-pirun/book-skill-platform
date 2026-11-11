// MinerU basic 档解析通道（前置过滤施工 · 解析层）
//
// 为什么要有这个文件：build-book.js 的 PDF 分支原来只吃 pdfjs 的文字流
// （src/build-book.js:233 `page.getTextContent()`），表格被拍平成 "a | b | c"
// （:98 packTable），公式/图/表结构全丢。MinerU basic 档能给出块级结构：
// 每块带 bbox（归一化 [0,1]）+ 页面下标，表格是 HTML，公式是 LaTeX。
//
// 三条实测确定的事实（本轮 2026-11-11/12 实测，见 前置过滤-施工\logs\）：
//   1. 不能用 `mineru.exe` 直调——报 authentication_error/invalid_doclib_token；
//      必须 `python -m mineru.cli.main parse`，且必须设 MINERU_HOME。
//   2. `mineru parse --json` 只回 parse 元数据（status/path），**不吐结构化 JSON**；
//      `mineru read --json` 只给 markdown 文本，**不给 bbox**。
//   3. 拿 bbox 的唯一路 = 读 doclib 缓存 JSON：
//      `$MINERU_HOME/doclib/parsed/<sha256前2位>/<sha256>/<tier>/<page_range>_<epochms>.json`
//
// 本模块只做「取产物 + 转块」，不写库、不碰 DDL（那是建库官的域）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

// 默认取值全部可用环境变量覆盖：产品化时装包路径会变，代码里不写死一处
export function mineruConfig(env = process.env) {
  const home = env.BSP_MINERU_HOME || env.MINERU_HOME || "";
  const python = env.BSP_MINERU_PYTHON || "python";
  const tier = env.BSP_MINERU_TIER || "basic";   // 本轮只认 basic，不加载 VLM
  const timeoutMs = Number(env.BSP_MINERU_TIMEOUT_MS || 30 * 60 * 1000);
  return { home, python, tier, timeoutMs };
}

// 通道是否可用：没有 MINERU_HOME 就是不可用（不抛错，让调用方回退旧实现）
export function mineruAvailable(cfg = mineruConfig()) {
  return Boolean(cfg.home && fs.existsSync(path.join(cfg.home, "doclib")));
}

export const sha256Of = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// doclib 缓存文件名形如 "1-801_1794419609966.json"（页范围_epochms）或 "1_17944.json"（单页）。
// 解析出 [start, end]；认不出的返回 null（宁可不命中，也不拿错页数的产物冒充）。
function pageRangeOf(name) {
  const m = /^(\d+)(?:-(\d+))?_\d+\.json$/.exec(String(name));
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end };
}

// doclib 缓存里找本次解析产物。
// **必须校验页范围**：缓存是按 (sha256, tier, 页范围) 存的，只跑过 1-40 页的旧产物同样命中
// 同一个目录。早先只按 mtime 取最新 → --pages all 跑「全量」时拿到 1-40 页的旧 JSON，
// 结果 801 页的书只建出 40 页还报成功（真 bug，kk-dirty-full 实测复现）。
// expectPages 给定时只认「从第 1 页起、覆盖到 expectPages」的那份；没有就返回 null 去真跑一遍。
// expectPages 未知（探测不到页数）时退化为取覆盖最广的一份，而不是 mtime 最新的一份。
export function findMiddleJson(home, sha256, tier, expectPages) {
  const dir = path.join(home, "doclib", "parsed", sha256.slice(0, 2), sha256, tier);
  if (!fs.existsSync(dir)) return null;
  const all = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      return { path: p, name: f, size: st.size, mtime: st.mtimeMs, range: pageRangeOf(f) };
    });
  if (!all.length) return null;

  const want = Number(expectPages);
  if (Number.isFinite(want) && want > 0) {
    const hit = all
      .filter((x) => x.range && x.range.start === 1 && x.range.end >= want)
      .sort((a, b) => a.range.end - b.range.end || b.mtime - a.mtime)[0];
    return hit ? hit.path : null;
  }
  // 页数未知：取覆盖最广的，同覆盖取最新
  const best = all
    .map((x) => ({ ...x, span: x.range ? x.range.end - x.range.start + 1 : 0 }))
    .sort((a, b) => b.span - a.span || b.mtime - a.mtime)[0];
  return best ? best.path : null;
}

function run(cmd, args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, windowsHide: true });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退出 */ }
      resolve({ code: -1, out, err: err + "\n[timeout]" });
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e && e.message || e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

// 跑一次解析。返回 { ok, code, stdout, stderr, sha256, jsonPath, tier }
// 已有**覆盖全量页**的缓存时不重复烧算力（MinerU 自己带 cache_hit，这里再按页范围挡一次）
export async function parsePdfWithMineru(file, cfg = mineruConfig(), log = () => {}, expectPages) {
  const sha256 = sha256Of(file);
  const cached = findMiddleJson(cfg.home, sha256, cfg.tier, expectPages);
  if (cached) return { ok: true, cached: true, code: 0, stdout: "", stderr: "", sha256, jsonPath: cached, tier: cfg.tier };

  const env = {
    ...process.env,
    MINERU_HOME: cfg.home,
    PYTHONIOENCODING: "utf-8",
  };
  // --wait 必须显式给：`mineru parse` 默认只等 60 秒就返回「解析仍在进行中」（exit 1），
  // 801 页的书 60 秒根本跑不完。这里按同一个 timeoutMs 换算成秒，让 CLI 与本地进程守时一致。
  const waitSec = Math.max(60, Math.ceil((cfg.timeoutMs || 1_800_000) / 1000) - 30);
  const args = ["-m", "mineru.cli.main", "parse", file,
    "--tier", cfg.tier, "--pages", "all", "--format", "markdown", "--force", "--wait", String(waitSec)];
  log(`  MinerU ${cfg.tier} 解析中（首次可能数十秒，最长等 ${waitSec}s）…`);
  const r = await run(cfg.python, args, { env, timeoutMs: cfg.timeoutMs });
  if (r.code !== 0) return { ok: false, code: r.code, stdout: r.out, stderr: r.err, sha256, jsonPath: null, tier: cfg.tier };
  const jsonPath = findMiddleJson(cfg.home, sha256, cfg.tier, expectPages);
  return { ok: Boolean(jsonPath), code: r.code, stdout: r.out, stderr: r.err, sha256, jsonPath, tier: cfg.tier };
}

// content 数组 → 纯文本（保留原字符，只按顺序拼接；不删字不改字）
function contentText(content) {
  if (typeof content === "string") return content;          // equation：LaTeX 字符串
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "text" && typeof c.content === "string") parts.push(c.content);
    else if (c.type === "hyperlink" && Array.isArray(c.content)) parts.push(contentText(c.content));
    // image_body / chart_body / table_body 的 content 是空串或 HTML，由调用方单独取
  }
  return parts.join("");
}

// 单元格 HTML → 文本。上标/下标/公式是语义不是装饰：直接剥标签会把
// O(n<sup>2</sup> · d) 读成 O(n2 · d)（实测 attention 表 1 就有），等于改字。
// 所以 sup→^{...}、sub→_{...}、eq→ 保留 LaTeX，其余标签才剥。
const cellText = (s) => s
  .replace(/<sup[^>]*>([\s\S]*?)<\/sup>/gi, "^{$1}")
  .replace(/<sub[^>]*>([\s\S]*?)<\/sub>/gi, "_{$1}")
  .replace(/<eq[^>]*>([\s\S]*?)<\/eq>/gi, " $1 ")
  .replace(/<br\s*\/?>/gi, " ")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/\s+/g, " ").trim();

// 合并单元格是结构信息（rowspan/colspan），丢了就还原不出表。
// 每格返回 { text, rowspan, colspan }；行长不齐由 colspan 补齐语义。
export function tableStructureFromHtml(html) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const cells = [];
    const tdRe = /<t([dh])([^>]*)>([\s\S]*?)<\/t\1>/gi;
    let c;
    while ((c = tdRe.exec(m[1])) !== null) {
      const attrs = c[2] || "";
      const rs = /rowspan\s*=\s*"?(\d+)/i.exec(attrs);
      const cs = /colspan\s*=\s*"?(\d+)/i.exec(attrs);
      cells.push({
        text: cellText(c[3]),
        rowspan: rs ? Number(rs[1]) : 1,
        colspan: cs ? Number(cs[1]) : 1,
      });
    }
    if (cells.some((x) => x.text !== "")) rows.push(cells);
  }
  return { rows, header: rows[0] || [], html };
}

// 一行 → 字符串（保留合并跨度标记，表头与数据行同一套写法）
const rowText = (row) => row.map((c) =>
  c.colspan > 1 || c.rowspan > 1 ? `${c.text}[${c.rowspan}x${c.colspan}]` : c.text
).join(" | ");

const TABLE_MAX = 900;   // 与 sentenceSplit / 原 packTable 同标尺

// 表格 → 若干块：表头随组重复（沿用既有约定），但每块额外带 table_html，
// 「那一格」靠结构定位而不是靠字符串猜。
function tableBlocks(block, page) {
  const capRaw = Array.isArray(block.content) ? block.content.filter((c) => c && c.type === "table_caption") : [];
  const caption = capRaw.map((c) => contentText(c.content)).filter(Boolean).join("\n");
  const bodyRaw = Array.isArray(block.content) ? block.content.find((c) => c && c.type === "table_body") : null;
  const html = bodyRaw && typeof bodyRaw.content === "string" ? bodyRaw.content : "";
  const { rows } = tableStructureFromHtml(html);
  if (!rows.length) {
    if (!caption) return [];
    return [{ page, text: caption, kind: "table_caption", bbox: block.bbox }];
  }
  const header = rows[0];
  const out = [];
  let cur = [header], curLen = rowText(header).length;
  const headerLen = curLen;
  for (let i = 1; i < rows.length; i++) {
    const line = rowText(rows[i]);
    if (curLen + 1 + line.length > TABLE_MAX && cur.length > 1) {
      out.push(cur);
      cur = [header, rows[i]];
      curLen = headerLen + 1 + line.length;
    } else {
      cur.push(rows[i]);
      curLen += 1 + line.length;
    }
  }
  out.push(cur);
  const pieces = [];
  if (caption) pieces.push({ page, text: caption, kind: "table_caption", bbox: block.bbox });
  for (const g of out) {
    pieces.push({
      page,
      text: g.map(rowText).join("\n"),
      kind: "table",
      bbox: block.bbox,
      table_html: html,                       // 结构原件，不拍平
      table_rows: g.map((r) => r.map((c) => c.text)),
      table_header: header.map((c) => c.text),
    });
  }
  return pieces;
}

// middle JSON → 块数组。判定规则表（每条都能从 JSON 本身算出来，无人工判断）：
//   text / ref_text / doc_title / paragraph_title / page_footnote / aside_text → 文字块
//   footer                                                                    → 文字块（页脚常是出版信息）
//   page_number                                                               → 丢弃（纯页码，P3 同款）
//   equation                                                                  → 公式块（LaTeX 原样）
//   table                                                                     → 表题块 + 表格块（带 table_html）
//   image / chart                                                             → 图注块 + 图块（bbox 定位，不塞 base64）
export function middleToBlocks(middle) {
  const pages = Array.isArray(middle?.pages) ? middle.pages : [];
  const blocks = [];
  const dropped = [];
  let seq = 0;
  for (let pi = 0; pi < pages.length; pi++) {
    const pg = pages[pi];
    const page = pi + 1;                       // 页号靠数组下标（块本身无 page_idx）
    const bl = Array.isArray(pg?.blocks) ? pg.blocks : [];
    for (const b of bl) {
      if (!b || typeof b !== "object") continue;
      const t = b.type;
      const bbox = Array.isArray(b.bbox) && b.bbox.length === 4 ? b.bbox : null;
      const base = { page, seq: ++seq, bbox, block_type: t, block_index: b.index };
      if (t === "page_number") { dropped.push({ page, type: t, text: contentText(b.content) }); continue; }
      if (t === "equation") {
        const latex = typeof b.content === "string" ? b.content : contentText(b.content);
        if (latex && latex.trim()) blocks.push({ ...base, kind: "equation", text: latex });
        continue;
      }
      if (t === "table") { blocks.push(...tableBlocks(b, page).map((x) => ({ ...base, ...x }))); continue; }
      if (t === "image" || t === "chart") {
        const cap = (Array.isArray(b.content) ? b.content : [])
          .filter((c) => c && (c.type === "image_caption" || c.type === "chart_caption"))
          .map((c) => contentText(c.content)).filter(Boolean).join("\n");
        const body = (Array.isArray(b.content) ? b.content : [])
          .find((c) => c && (c.type === "image_body" || c.type === "chart_body"));
        const imagePath = body && typeof body.image_path === "string" ? body.image_path : null;
        blocks.push({ ...base, kind: t, text: cap, image_path: imagePath });
        continue;
      }
      // 其余按文字块处理（含未知类型——宁可留字不可丢字）
      const text = contentText(b.content);
      if (!text || !text.trim()) continue;
      const kind = t === "paragraph_title" || t === "doc_title" ? "heading"
        : t === "ref_text" ? "ref"
          : t === "page_footnote" ? "footnote" : "text";
      blocks.push({ ...base, kind, text });
    }
  }
  return { blocks, dropped };
}

// 块 → chunks（沿用 chunks 表四列：chapter/chapter_path/page/text，其余字段随附）
// 文字块按句切分（900 字上限，与既有 sentenceSplit 同标尺）；块内不跨块合并，
// 保证每块都能定位到「原书某页某 bbox」。
export function blocksToChunks(blocks, { sentenceSplit, collapse } = {}) {
  const chunks = [];
  for (const b of blocks) {
    if (!b.text || !b.text.trim()) {
      // 纯图块（无图注）也要留一条：它占据版面位置，检索侧可据此回答「这页有图」
      if (b.kind === "image" || b.kind === "chart") {
        chunks.push({
          chapter: null, chapter_path: null, page: b.page,
          text: "", kind: b.kind, bbox: b.bbox, block_type: b.block_type,
          image_path: b.image_path || null, seq: b.seq,
        });
      }
      continue;
    }
    const text = collapse ? collapse(b.text) : b.text;
    const segs = sentenceSplit ? sentenceSplit(text) : [text];
    for (const seg of segs) {
      chunks.push({
        chapter: null, chapter_path: null, page: b.page,
        text: seg, kind: b.kind, bbox: b.bbox, block_type: b.block_type,
        image_path: b.image_path || null, seq: b.seq,
        ...(b.table_html ? { table_html: b.table_html, table_rows: b.table_rows, table_header: b.table_header } : {}),
      });
    }
  }
  return chunks;
}
