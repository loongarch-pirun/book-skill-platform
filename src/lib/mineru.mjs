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
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

// 默认取值全部可用环境变量覆盖：产品化时装包路径会变，代码里不写死一处
export function mineruConfig(env = process.env) {
  // home 探测链（按优先级）：显式环境变量 → 用户约定的默认目录 ~/.mineru。
  // 为什么要有第 3 档：不设环境变量时 home 为空串，mineruAvailable() 直接 false，
  // parsePdf 会静默回落 pdfjs 文字流（build-book.js:436-444 的 legacy 分支）——
  // 解析层等于白换，而且用户看不到任何报错。这档只负责「去常见位置找」，
  // 找没找到仍由 mineruAvailable() 的 doclib 存在性判定，判定逻辑一行不动。
  const home = env.BSP_MINERU_HOME || env.MINERU_HOME || path.join(os.homedir(), ".mineru");
  const python = env.BSP_MINERU_PYTHON || "python";
  const tier = env.BSP_MINERU_TIER || "basic";   // 本轮只认 basic，不加载 VLM
  const timeoutMs = Number(env.BSP_MINERU_TIMEOUT_MS || 30 * 60 * 1000);
  return { home, python, tier, timeoutMs };
}

// 通道是否可用（不抛错，让调用方回退旧实现）。
//
// 为什么不能只看 `home/doclib` 目录存在（2026-11-13 修的假阳性）：
// doclib/ 目录是**解析产物的缓存落点**，跑过一次就永久存在，服务此刻死没死它都还在。
// 干净机器上只要残留一个空的 doclib/，mineruAvailable() 就返回 true，parsePdf 于是
// 不回落 legacy 而直接调 CLI；CLI 是纯 HTTP 客户端（client.py:446-447），服务没起就抛
// ServerNotRunningError，整个导入失败——比回落更糟，而且用户看到的是一句 Python 栈。
// 所以判据改成「有产物目录 + 真能连上 doclib 服务」两道：
//   1) doclib/ 存在（产物缓存的落点，兼作「这台机器配过 MinerU」的廉价先验）；
//   2) endpoint 指向的服务此刻活着（GET /api/v1/server/status 200）。
// 第 2 道是同步函数里做不了的网络探测，因此拆成 `mineruAvailable()`（同步、廉价，
// 只做第 1 道，供 build-book.js:476 分流用）与 `mineruReachable()`（异步、真探活）。
// 调用方要「确保能真跑」时用前者 && 后者，见 src/build-book.js 的 parsePdf。
export function mineruAvailable(cfg = mineruConfig()) {
  return Boolean(cfg.home && fs.existsSync(path.join(cfg.home, "doclib")));
}

// 读 doclib 的 endpoint 与 token：服务端口可能漂移（strict_port=False），
// 实际 base_url 由 doclib 启动时写进 endpoint.json，不能写死 15980。
export function doclibEndpoint(cfg = mineruConfig()) {
  const file = path.join(cfg.home, "doclib.endpoint.json");
  let base = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const t = (j.transports || []).find((x) => x.type === "tcp" && x.base_url);
    if (t) base = String(t.base_url).replace(/\/+$/, "");
  } catch { /* 服务还没起过，或文件写了一半 */ }
  let token = null;
  try {
    const m = /token:\s*(\S+)/.exec(fs.readFileSync(path.join(cfg.home, "config.yaml"), "utf8"));
    if (m) token = m[1];
  } catch { /* 没有 config.yaml 就是没配过 */ }
  return { base, token, endpointFile: file };
}

// 真探活：服务在跑且 parse-server healthy 才算可用。
// 超时给 2.5s：调用点在导入流程里，不能在「服务没起」的机器上白等半分钟。
export async function mineruReachable(cfg = mineruConfig(), timeoutMs = 2500) {
  const { base, token } = doclibEndpoint(cfg);
  if (!base || !token) return false;
  try {
    const r = await fetch(`${base}/api/v1/server/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return j?.parse_server?.local?.healthy === true;
  } catch { return false; }
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
  // 页数未知：同样只认认得页范围的缓存——取覆盖最广的，同覆盖取最新。
  // 认不出页范围的（span 会被算成 0）一律不命中：宁可返回 null 去真跑一遍，
  // 也不拿一个不知道覆盖多少页的产物冒充全量（这与已知分支用 x.range 守卫是同一条道理）。
  const known = all.filter((x) => x.range);
  if (!known.length) return null;
  const best = known
    .map((x) => ({ ...x, span: x.range.end - x.range.start + 1 }))
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
//
// 只有三类内容项**不该**进正文，它们由调用方单独取成结构化字段：
//   table_body（HTML → table_html/table_rows）
//   image_body / chart_body（图片路径，不塞 base64）
// 其余每一个承载文字的类型都必须收进来，否则就是静默改字。历史坑（2026-11-13 实测）：
//   1) contentText 原来只认 `type === "text" && typeof c.content === "string"`，
//      但 MinerU 的 text 是**可嵌套**的：
//        {"type":"text","content":[{"type":"text","content":"…"}]}
//      内层 content 是数组，判断不成立 → 整块变空串。Project Gutenberg 许可条款
//      （1473 字 ×4 处）、目录页章节名全丢在这里，共丢 12296 字。
//   2) equation_inline 523 个（16953 字）无任何调用方取；attention 论文的
//      "For each of these we use " + [h=8] + ". Due to" 落库后变成
//      "…we use . Due to" ——「用了几个头」的答案 8 被吃掉了。
//   3) code / algorithm 块 21+3 个整块丢弃（6336 字），MapReduce 的 map/reduce
//      伪代码、MATLAB 工作区 dump 都没进库。
//   4) 各类 caption / footnote（table/image/chart）共 11720 字不全。
// 所以这里改成**递归收下所有承载文字的项**，只为不认识的类型保留「宁可留字」的默认行为。
const NON_TEXT_ITEM = new Set(["table_body", "image_body", "chart_body"]);

// 公式与代码需要边界空格，否则 "we use" + "h=8" 会粘成一个词
const SPACED_ITEM = new Set(["equation_inline", "equation", "code_body", "algorithm_body"]);

function contentText(content) {
  if (typeof content === "string") return content;          // equation：LaTeX 字符串
  if (typeof content === "number") return String(content);
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    if (NON_TEXT_ITEM.has(c.type)) continue;                // 由调用方单独取
    if (c.type === "code_body" || c.type === "algorithm_body") {
      // 代码要保换行：逐行拼接，行间不插空格
      const body = typeof c.content === "string" ? c.content : contentText(c.content);
      if (body) parts.push("\n" + body.trim() + "\n");
      continue;
    }
    if (c.type === "text") {
      // text 的 content 可能是字符串，也可能是**数组**（可嵌套），必须递归
      const t = contentText(c.content);
      if (t) parts.push(t);
      continue;
    }
    if (c.type === "hyperlink") { const t = contentText(c.content); if (t) parts.push(t); continue; }
    if (SPACED_ITEM.has(c.type) || c.type === "equation_inline") {
      const t = contentText(c.content);
      if (t) parts.push(` ${t} `);                          // 两侧留空，防粘连
      continue;
    }
    // image_caption / chart_caption / table_caption / image_footnote / chart_footnote…
    // 以及任何未枚举但带文字的类型：一律递归取字（宁可留字不可丢字）
    const t = contentText(c.content);
    if (t) parts.push(t);
  }
  return parts.join("");
}

// 目录/列表类块：每个内容项是独立一行，直接拼会变成
// 「第1章 绪论第2章 机器人机械结构…」——字都在但结构没了。按行取字。
function contentLines(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const lines = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    if (NON_TEXT_ITEM.has(c.type)) continue;
    const t = contentLines(c.content);
    if (t && t.trim()) lines.push(t.trim());
  }
  return lines.join("\n");
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
        // 图注 + 图脚注都要（脚注常是「WeChat ID: meetmath」这类来源信息，丢了就查不到出处）
        const cap = (Array.isArray(b.content) ? b.content : [])
          .filter((c) => c && (c.type === "image_caption" || c.type === "chart_caption"))
          .map((c) => contentText(c.content)).filter(Boolean).join("\n");
        const note = (Array.isArray(b.content) ? b.content : [])
          .filter((c) => c && (c.type === "image_footnote" || c.type === "chart_footnote"))
          .map((c) => contentText(c.content)).filter(Boolean).join("\n");
        const body = (Array.isArray(b.content) ? b.content : [])
          .find((c) => c && (c.type === "image_body" || c.type === "chart_body"));
        const imagePath = body && typeof body.image_path === "string" ? body.image_path : null;
        const text = [cap, note].filter(Boolean).join("\n");
        blocks.push({ ...base, kind: t, text, image_path: imagePath });
        continue;
      }
      // 其余按文字块处理（含未知类型——宁可留字不可丢字）
      // list / index 是「一行一项」的结构块，必须按行拼，否则目录会糊成一行
      const text = (t === "list" || t === "index") ? contentLines(b.content) : contentText(b.content);
      if (!text || !text.trim()) continue;
      const kind = t === "paragraph_title" || t === "doc_title" ? "heading"
        : t === "ref_text" ? "ref"
          : t === "page_footnote" ? "footnote"
            : t === "code" || t === "algorithm" ? "code" : "text";
      blocks.push({ ...base, kind, text });
    }
  }
  return { blocks, dropped };
}

// 块 → chunks（沿用 chunks 表四列：chapter/chapter_path/page/text，其余字段随附）
//
// 2026-11-13 起：先在块序列上归并出「语义单元」，再按句切分。原因是实测发现
// **一块一 chunk 与语义单位不一致**，而 e5-small(int8) 系统性偏袒短文本
// （问题内去均值后 log(长度) 与余弦的 Pearson r=-0.1799，n=95000）：标题单独成块
// 就会永远 top1、而答案正文被挤出召回窗。13 本 middle.json 实测（13-可用性\unit-sim.mjs）：
//   一块一单元    13745 单元，<60 字占 31.9%，p50=129
//   归并后        6171 单元，<60 字占 6.4%，p50=510
// 三条规则（阈值全部来自 13-可用性\merge-rules-census.mjs / row-merge-risk.mjs 的实测分布）：
//   R1 标题并入：heading 紧接其后一块，同页、非同行并排、竖直间距 ≤0.12 → 标题作为首行并入
//   R2 题注并入：table_caption 与紧随的 table 同 bbox → 题注作表格文本首行，不单独成块
//   R3 续行/打包：相邻 text 同页非同行；前块未以终止符结尾且短(≤600)、间距 ≤0.06 → 续行；
//      否则两段累计 ≤400 且间距 ≤0.12 → 打包（换行分隔），上限 900 与 sentenceSplit 同标尺
// 归并只发生在同一页内、且不跨 image/chart（无字图块）与 table（自带 table_html）。
// 单元的 bbox 取各块并集，seq/block_index 取首块 —— 仍然指得回「原书某页某块」。
const UNIT_TARGET = 400;          // 打包目标长度
const UNIT_MAX = 900;             // 与 sentenceSplit 的 900 同标尺（合并后仍会再切）
const GAP_CONT = 0.06;            // 续行允许的竖直间距（页面高度占比）
const GAP_PACK = 0.12;            // 打包允许的竖直间距
const GAP_HEADING = 0.12;         // 标题与其正文的竖直间距上限
const SENT_END = /[.?!。！？；;:：)\]\]}」』】”"']\s*$/;   // 视为「本段说完了」
const HEADING_TARGETS = new Set(["text", "code", "equation", "ref", "footnote", "table"]);

function bboxOf(b) { return Array.isArray(b?.bbox) && b.bbox.length === 4 ? b.bbox : null; }

// 同一行（行重叠占较矮块高度的 60% 以上）
function rowOverlap(a, b) {
  const A = bboxOf(a), B = bboxOf(b);
  if (!A || !B) return 0;
  const ov = Math.min(A[3], B[3]) - Math.max(A[1], B[1]);
  if (ov <= 0) return 0;
  return ov / Math.max(1e-6, Math.min(A[3] - A[1], B[3] - B[1]));
}

// 竖直间距（下一块顶边 − 上一块底边），缺 bbox 返回 null（按「不知道」保守处理）
function vGap(a, b) {
  const A = bboxOf(a), B = bboxOf(b);
  if (!A || !B) return null;
  return B[1] - A[3];
}

function unionBbox(parts) {
  const boxes = parts.map(bboxOf).filter(Boolean);
  if (!boxes.length) return null;
  return [
    Math.min(...boxes.map((x) => x[0])), Math.min(...boxes.map((x) => x[1])),
    Math.max(...boxes.map((x) => x[2])), Math.max(...boxes.map((x) => x[3])),
  ];
}

// 块序列 → 语义单元（每单元含若干块，text 以换行分隔）
export function blocksToUnits(blocks) {
  const units = [];
  let cur = null;
  const close = () => { if (cur) { units.push(cur); cur = null; } };

  for (const b of blocks) {
    if (!b.text || !b.text.trim()) {
      // 无字块（纯图/纯图表）与其它块不合并：它占据版面位置，自己一条
      close();
      if (b.kind === "image" || b.kind === "chart") units.push({ parts: [b], text: "", kind: b.kind, page: b.page });
      continue;
    }
    if (!cur) { cur = { parts: [b], text: b.text, kind: b.kind, page: b.page }; continue; }

    const last = cur.parts[cur.parts.length - 1];
    const samePage = b.page === last.page;
    const g = samePage ? vGap(last, b) : null;
    const sameRow = samePage && rowOverlap(last, b) >= 0.6;
    const L = cur.text.length;

    // R2 表格题注并入表格（tableBlocks 产的题注与表格共用 bbox）
    if (cur.parts.length === 1 && cur.kind === "table_caption" && b.kind === "table" && samePage) {
      const A = bboxOf(last), B = bboxOf(b);
      const sameBox = A && B && Math.abs(A[0] - B[0]) < 0.02 && Math.abs(A[1] - B[1]) < 0.02;
      if (sameBox || rowOverlap(last, b) >= 0.6) {
        cur.parts.push(b);
        cur.text = `${cur.text}\n${b.text}`;
        cur.kind = "table";
        continue;
      }
    }
    // R1 标题并入其后正文
    if (cur.parts.length === 1 && cur.kind === "heading" && samePage && !sameRow
        && HEADING_TARGETS.has(b.kind) && (g === null || g <= GAP_HEADING)
        && L + b.text.length <= UNIT_MAX) {
      cur.parts.push(b);
      cur.text = `${cur.text}\n${b.text}`;
      cur.kind = b.kind;
      continue;
    }
    // R3 续行 / 打包（仅正文之间的相邻块）
    if (cur.kind === "text" && b.kind === "text" && samePage && !sameRow) {
      const joined = L + 1 + b.text.length;
      if (L <= 600 && !SENT_END.test(cur.text) && (g === null || g <= GAP_CONT) && joined <= UNIT_MAX) {
        cur.parts.push(b);
        cur.text = `${cur.text} ${b.text}`;
        continue;
      }
      if (L < UNIT_TARGET && (g === null || g <= GAP_PACK) && joined <= UNIT_MAX) {
        cur.parts.push(b);
        cur.text = `${cur.text}\n${b.text}`;
        continue;
      }
    }
    close();
    cur = { parts: [b], text: b.text, kind: b.kind, page: b.page };
  }
  close();
  return units;
}

export function blocksToChunks(blocks, { sentenceSplit, collapse } = {}) {
  const chunks = [];
  for (const u of blocksToUnits(blocks)) {
    const first = u.parts[0];
    const base = {
      chapter: null, chapter_path: null, page: first.page,
      kind: u.kind, bbox: unionBbox(u.parts) || first.bbox || null,
      block_type: first.block_type, block_index: first.block_index,
      image_path: first.image_path || null, seq: first.seq,
    };
    if (!u.text || !u.text.trim()) {
      // 纯图块：留一条，检索侧可据此回答「这页有图」
      chunks.push({ ...base, text: "" });
      continue;
    }
    const text = collapse ? collapse(u.text) : u.text;
    const segs = sentenceSplit ? sentenceSplit(text) : [text];
    // 单元的表格结构只跟第一段走（同一单元里不会有第二张表：R2 只并入题注，table 自成单元结束点）
    const tablePart = u.parts.find((p) => p.table_html);
    for (const seg of segs) {
      chunks.push({
        ...base, text: seg,
        ...(tablePart && seg === segs[0]
          ? { table_html: tablePart.table_html, table_rows: tablePart.table_rows, table_header: tablePart.table_header }
          : {}),
      });
    }
  }
  return chunks;
}
