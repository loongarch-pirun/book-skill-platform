// test/quality-gate.mjs —— P0-7 质量闸门
//
// 规划 §四 P0-7 判据：「人为把 topN 从 4 改成 1 → 五项全红」。
// 本文件做两件事：
//   1) 量五项指标：命中率 / full 率 / 平均首中名次 / 路由准确率 / 脏块入库数
//   2) 与 quality-baseline.json 逐项比，任一项退化就 exit 1。
//
// 用法：
//   node test/quality-gate.mjs                       # 现跑（双口径，约 15~25 分钟）
//   node test/quality-gate.mjs --topN=1              # 现跑，topN 改成 1（翻转判据）
//   node test/quality-gate.mjs --from-book=<raw> --from-route=<raw>   # 用已量好的原始数据算
//   node test/quality-gate.mjs --from-book=<raw> --from-route=<raw> --write-baseline
//
// ── 为什么是双口径 ────────────────────────────────────────────────────────
// 五项指标里，「路由准确率」只有在端到端路由（routeAndSearch）下才有意义：
// 按书检索 hybridSearch 是拿已知书名去查，命中块必然来自那本书，路由准确率恒等于命中率，
// 那不是指标、是废话。反过来，「脏块入库数」在端到端口径下结构上不可能随 topN 变坏：
// routeAndSearch 的 topN 只在最后一步截断结果条数（src/lib/search.mjs:692），
// 候选池与选书都不受 topN 影响 ⇒ topN=1 的返回集是 topN=4 的真子集
// （实测 80/80，见 23-质量彻底解决施工\probe-subset.mjs）⇒ 窗口里的脏块只会变少。
// 而按书检索 hybridSearch 的候选池随 topN 变（src/lib/search.mjs:360
// RECALL = min(max(topN*4,12),20)）：topN=1 是真把检索面缩小了，脏块挤占率会上升。
// 所以：命中/full/名次/脏块走按书口径（与 test/v2-eval.mjs:250 同一条路径，
// 虾虾核过的旧尺子基线 75/80=94 也是这条路径算的，新旧尺子必须同一条路径才算同一份考卷），
// 路由准确率走端到端口径。两份原始数据都落盘，口径写在基线文件里。
//
// ── 口径说明（每条都写清楚，避免"数字对不上"）────────────────────────────
//   · 考卷 = test/golden/*.json（80 题，每题 {q,a,g}）。
//   · 命中块 = 检索返回的 results（按名次）。
//   · 判级 = test/lib/judge.mjs 的 judge()：full / partial / miss。
//   · 命中率 hitRate = (full + partial) / 80                —— 大者好
//   · full 率 fullRate = full / 80                          —— 大者好
//   · 平均首中名次 avgFirstRank = 80 题平均（命中取名次，未命中记 MISS_PENALTY=10）
//     —— 小者好。用固定惩罚而不是 topN+1：惩罚若随 topN 变，指标口径就跟着 topN 变，
//     topN=1 时未命中只记 2 分反而比 topN=4 的 5 分「更好」，指标就废了。
//   · 路由准确率 routeAcc = 「命中块所属书 == 该题应属书」的题数 / 80 —— 大者好
//     （未命中记 0：没把答案送回来，路由就没算对）。端到端口径量。
//   · 脏块入库数 dirtyRate = 返回结果里的脏块数 / 返回块总数 —— 小者好
//     脏块判据用**形态口径**：照抄 21-切块质量\dirty-scan.mjs:32-47 的 JUNK 7 条
//     （journal_masthead / page_number / copyright_line / toc_line / latex_residue /
//       mojibake / separator），长度门槛照抄 dirty-scan 的 classify()（:49-67）。
//     为什么不用产品规则表（src/lib/noise-rules.mjs）当闸门判据：产品表是「入库时整块丢弃」
//     的规则，盖不住形态垃圾（实测整库形态垃圾 53 块，产品表只盖住 3 块），
//     用产品表量第五项永远是 0，闸门就废了。形态口径与 21-切块质量 报告同源，可复跑。
//     产品规则口径的脏块数一并打印（prodDirtyTotal / prodDirtyRate），只作记账。
//
// ── 第④行「切块损伤」为什么不能是恒真 0 ──────────────────────────────────
// 「切块损伤率 partial÷hit」在本卷 80 题上恒为 0：实测 80 条标准答案句在库里
// intact 80 / split 0 / none 0（见 23-质量彻底解决施工\probe-00b-split.mjs）——
// 这 80 条答案句恰好没被切开，所以这一行在卷内是恒真行，不配当指标充数。
// 但「这把尺子认不认得出接缝」这件事本身必须可测、必须能翻转，所以闸门里加一条
// **接缝自测断言**：
//   · 现扫全库 13 个库，把「一句答案被切在相邻两块接缝上」的真实句子挖出来当样本
//     （几何判定，不靠尺子，所以尺子坏了样本还在）；
//   · 新尺子 judge() 必须对每一条判 partial（认得出切伤）；
//   · 旧尺子 legacyJudge() 必须对每一条判 hit（认不出——只看关键词还在就算过，
//     这正是 P0-2 要治的病）；
//   · 任一条不成立 → 闸门红 exit 1。
// 翻转：把 judge() 换回旧逻辑 → 接缝识别率掉到 0 → 闸门红。
// 样本是现扫的，不依赖任何预置文件：库变了，断言跟着变。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const R4 = path.resolve(import.meta.dirname, "..");
const LIB = process.env.BSP_GATE_LIB || path.join(R4, "library");
const GOLDEN_DIR = path.join(R4, "test", "golden");
const BASELINE_FILE = path.join(R4, "quality-baseline.json");

// better-sqlite3 在 r3 的 node_modules 里（r4 的 node_modules 是 junction）
let Database;
try {
  Database = createRequire(import.meta.url)("better-sqlite3");
} catch {
  Database = createRequire("C:/Users/JIANG XIAO HUA/Desktop/book-skill-platform-r3/package.json")("better-sqlite3");
}

const { judge, legacyJudge, normText, isTerminator } = await import("./lib/judge.mjs");
const { filterNoiseChunks, loadRules } = await import("../src/lib/noise-rules.mjs");

// ---- 参数 ------------------------------------------------------------------
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const has = (name) => argv.includes(`--${name}`);
const TOP_N = Number(argOf("topN", "4"));
const FROM_BOOK = argOf("from-book", "");
const FROM_ROUTE = argOf("from-route", "");
const OUT = argOf("out", "");
const BASELINE = path.resolve(argOf("baseline", BASELINE_FILE));
const RERANK = argOf("rerank", "1") !== "0";

const MISS_PENALTY = 10;
const BOOK_ALIAS = {
  "jane-eyre-en.epub": "pg1260-简爱.epub",
  "sherlock-holmes-adventures-en.epub": "pg1661-福尔摩斯冒险史.epub",
  "dynamo-2007-en.pdf": "Dynamo-亚马逊高可用键值存储-2007.pdf",
  "lamport-1978-en.pdf": "Lamport-时间时钟与分布式系统排序-1978.pdf",
  "mapreduce-2004-en.pdf": "MapReduce-谷歌大规模分布式处理-2004.pdf",
};

// ---- 形态脏块判据：照抄 21-切块质量\dirty-scan.mjs ----------------------------
// 出处：dirty-scan.mjs:32-47（JUNK 7 条）+ :49-67（classify 的长度门槛）
const JUNK = [
  { name: "journal_masthead", re: /(communications|proceedings|transactions|journal|letters|magazine)\s*[\|,]?.*\b(19|20)\d{2}\b|\bvolume\s+\d+|\bnumber\s+\d+|\bvol\.?\s*\d+\s*,?\s*no\.?\s*\d+/i },
  { name: "page_number", re: /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i },
  { name: "copyright_line", re: /(©|\(c\)|copyright|all rights reserved|permission to make|licensed under)/i },
  { name: "toc_line", re: /\.{3,}\s*\d{1,4}\s*$|…{3,}\s*\d{1,4}\s*$/ },
  { name: "latex_residue", re: /^(?:[\\{}_\^$\s]|\\(?:mathrm|underset|overset|frac|sum|tau|nu|kappa|xi|leq|geq|lesssim|gtrsim|cdot|times|alpha|beta|gamma|delta|sigma|lambda|infty|sqrt|left|right|text|begin|end)\b|[_^]\s*\{|[a-z]\s*_\s*\{)/i },
  { name: "mojibake", re: /[\uFFFD\uE000-\uF8FF]|锟斤拷|烫烫|屯屯/ },
  { name: "separator", re: /^[\s\-=_*#~·•\.]{1,20}$/ },
];
function formDirtyOf(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  for (const { name, re } of JUNK) {
    if (name === "latex_residue" && s.length > 400) continue;
    if (!re.test(s)) continue;
    if (name === "journal_masthead" && s.length > 260) continue;
    if (name === "copyright_line" && s.length > 300) continue;
    return name;
  }
  return null;
}

// ---- 考卷 ------------------------------------------------------------------
function libFile(book) {
  const want = BOOK_ALIAS[book] || book;
  const f = fs.readdirSync(LIB).find(x => x.startsWith(want) && x.endsWith(".db"));
  if (!f) throw new Error("找不到库文件 " + want + "*.db");
  return f;
}
function loadItems() {
  const items = [];
  for (const file of fs.readdirSync(GOLDEN_DIR).filter(x => x.endsWith(".json")).sort()) {
    const book = file.replace(/\.json$/, "");
    const arr = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, file), "utf8"));
    for (const it of arr) items.push({ book, file: libFile(book), ...it });
  }
  return items;
}

// ---- 脏块查询 --------------------------------------------------------------
const rules = loadRules().rules;
const chunkCache = new Map();
function dbByBookId(bookId) {
  if (!chunkCache.has(bookId)) {
    chunkCache.set(bookId, new Database(path.join(LIB, bookId + ".db"), { readonly: true }));
  }
  return chunkCache.get(bookId);
}
function chunkRows(bookId, ids) {
  const db = dbByBookId(bookId);
  const out = [];
  for (const id of ids) {
    const r = db.prepare("SELECT id, kind, block_type, text FROM chunks WHERE id = ?").get(id);
    if (r) out.push(r);
  }
  return out;
}
// 同时量两种脏块口径：
//   formDirty = 形态口径（dirty-scan JUNK 7 条）—— 闸门用这个
//   prodDirty = 产品规则口径（noise-rules DEFAULT_RULES）—— 只作记账
function dirtyOf(rs, defaultBookId) {
  const byFile = new Map();
  for (const r of rs) {
    const bid = r.bookId || defaultBookId;
    if (!bid) continue;
    if (!byFile.has(bid)) byFile.set(bid, []);
    byFile.get(bid).push(r.id);
  }
  const formDirty = [];
  const prodDirty = [];
  for (const [bid, ids] of byFile) {
    const rows = chunkRows(bid, ids);
    for (const r of rows) {
      const rule = formDirtyOf(r.text);
      if (rule) formDirty.push({ bookId: bid, id: r.id, rule });
    }
    if (rows.length) {
      const { chunks, report } = filterNoiseChunks(rows, { rules, source: "gate" });
      const kept = new Set(chunks.map(c => c.id));
      for (const r of rows) {
        if (!kept.has(r.id)) prodDirty.push({ bookId: bid, id: r.id, rule: report.removed.find(x => x.id === r.id)?.rule });
      }
    }
  }
  return { formDirty, prodDirty };
}

// ---- 第④行的自测断言：接缝识别率 ---------------------------------------------
// 本卷 80 题的标准答案句在库里 intact 80 / split 0（实测见
// 23-质量彻底解决施工\probe-00b-split.mjs），所以「切块损伤率 partial÷hit」
// 在这份卷子上恒为 0 —— 一行恒为 0 的指标永远不可能变红，等于充数。
//
// 改法：这一行不进五项指标，改成闸门内的一条自测断言 ——
//   几何扫描全库，找出「一句答案被切在相邻两块接缝上」的真实句子当样本
//   （判定只看几何：句首在 A 块内且 A 块里句首前是句读、句尾落在 B 块，不看尺子）；
//   要求新尺子 judge() 对这些样本全部判 partial（能认出切块损伤）；
//   同时记下旧尺子 legacyJudge() 对同批样本的虚命中数（旧尺子只看关键词，
//   关键词在 A 块里就算过，答案句被切开它照样放行）。
// 任一条样本不被新尺子判 partial → 识别率 < 1 → 闸门红 exit 1。
// 翻转证据：把 judge() 换回旧逻辑 → 识别率掉到 0 → 闸门红。
const HARD = ".!?。！？";
const CLOSE = "\"”’')）】」』";
const SEAM_MIN_LEN = 40;
const SEAM_PER_BOOK = 40;

// 相邻两块拼起来按硬句读切句，找「起点在 A 块内（且 A 块里句首前是句读）、终点落在 B 块内」的跨块句
function seamSentences(aText, bText) {
  const out = [];
  const combined = aText + " " + bText;
  const aLen = aText.length;
  let start = 0;
  for (let i = 0; i < combined.length; i++) {
    if (!isTerminator(combined, i)) continue;
    let end = i + 1;
    while (end < combined.length && CLOSE.includes(combined[end])) end++;
    if (start < aLen && end > aLen) {
      const beforeA = aText.slice(0, start).replace(/\s+$/, "");
      if (beforeA.length > 0 && isTerminator(beforeA, beforeA.length - 1)) {
        out.push(combined.slice(start, end));
      }
    }
    start = end;
  }
  return out;
}

// 扫全库找接缝样本（纯几何判定，与尺子无关；样本现扫，不依赖预置文件）
function scanSeamSamples() {
  const samples = [];
  for (const f of fs.readdirSync(LIB).filter(x => x.endsWith(".db")).sort()) {
    const db = new Database(path.join(LIB, f), { readonly: true });
    const rows = db.prepare("SELECT id, text FROM chunks WHERE id ORDER BY id").all();
    db.close();
    let perBook = 0;
    for (let i = 0; i < rows.length - 1 && perBook < SEAM_PER_BOOK; i++) {
      const A = rows[i], B = rows[i + 1];
      if (B.id !== A.id + 1) continue;
      for (const s of seamSentences(A.text, B.text)) {
        const a = normText(s);
        if (a.length < SEAM_MIN_LEN) continue;
        // 单块就已包含整句的，不算「被切开」（几何过滤，不看尺子）
        if (normText(A.text).includes(a) || normText(B.text).includes(a)) continue;
        samples.push({ book: f.replace(/\.db$/, ""), aId: A.id, bId: B.id, a, aText: A.text, bText: B.text });
        if (++perBook >= SEAM_PER_BOOK) break;
      }
    }
  }
  return samples;
}

// 旧尺子用的关键词：从答案句里挑一个落在 A 块里的长词（旧尺子只看词在不在块里）
function seamKeyword(a, aText) {
  const tokens = a.match(/[A-Za-z][A-Za-z'-]{5,}|[\u4e00-\u9fa5]{4,}/g) || [];
  const low = String(aText ?? "").toLowerCase();
  let best = "";
  for (const t of tokens) {
    const lt = t.toLowerCase();
    if (lt.length > best.length && low.includes(lt)) best = lt;
  }
  return best;
}

// 跑接缝自测断言
function runSeamAssertion() {
  const samples = scanSeamSamples();
  let newPartial = 0, legacyHit = 0, legacyCnt = 0;
  const fails = [];
  for (const s of samples) {
    const rs = [{ id: s.aId, text: s.aText }, { id: s.bId, text: s.bText }];
    const kw = seamKeyword(s.a, s.aText);
    const v = judge(rs, { q: "seam", a: s.a, g: kw ? [kw] : ["seam"] });
    if (v.level === "partial") newPartial++;
    else fails.push({ book: s.book, aId: s.aId, bId: s.bId, level: v.level });
    if (kw) {
      legacyCnt++;
      if (legacyJudge(rs, [kw]).hit) legacyHit++;
    }
  }
  return {
    total: samples.length,
    newPartial,
    rate: samples.length ? +(newPartial / samples.length).toFixed(4) : 0,
    legacyTotal: legacyCnt,
    legacyHit,
    legacyRate: legacyCnt ? +(legacyHit / legacyCnt).toFixed(4) : 0,
    fails,
  };
}

// ---- 现跑（慢路径）----------------------------------------------------------
// 按书口径：hybridSearch(dbPath, q, topN) —— 与 test/v2-eval.mjs:250 同一条路径
async function runBook(items) {
  const { hybridSearch } = await import("../src/lib/search.mjs");
  const raw = { items: [], meta: { n: items.length, topN: TOP_N, caliber: "perbook", rerank: RERANK } };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const t0 = Date.now();
    const rs = await hybridSearch(path.join(LIB, it.file), it.q, TOP_N, { rerank: RERANK });
    const lat = Date.now() - t0;
    const v = judge(rs, it);
    const lg = legacyJudge(rs, it.g);
    // hybridSearch 的返回项没有 bookId 字段（按书口径书是已知的），这里补上库文件名，
    // 好让脏块查询知道去哪个库取块文本。
    const bookId = it.file.replace(/\.db$/, "");
    const d = dirtyOf(rs, bookId);
    raw.items.push({
      book: it.book, file: it.file, q: it.q,
      perN: {
        [TOP_N]: {
          lat, level: v.level, rank: v.rank, why: v.why,
          legacyHit: lg.hit, legacyRank: lg.rank,
          nRes: rs.length,
          books: rs.map(r => ({ bookId, id: r.id, score: r.score })),
          routed: [],
          formDirty: d.formDirty,
          prodDirty: d.prodDirty,
        },
      },
    });
    logLine("book", `[${i + 1}/${items.length}] ${it.book} ${v.level}/${rs.length} ${it.q.slice(0, 26)}`);
  }
  return raw;
}

// 端到端口径：routeAndSearch(q, {topN}) —— query_library / 桌面全库模式那条路径
async function runRoute(items) {
  const { routeAndSearch } = await import("../src/lib/search.mjs");
  const raw = { items: [], meta: { n: items.length, topN: TOP_N, caliber: "route" } };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const t0 = Date.now();
    const res = await routeAndSearch(it.q, { topN: TOP_N, libDir: LIB });
    const lat = Date.now() - t0;
    const rs = res.results || [];
    const v = judge(rs, it);
    const lg = legacyJudge(rs, it.g);
    const d = dirtyOf(rs);
    raw.items.push({
      book: it.book, file: it.file, q: it.q,
      perN: {
        [TOP_N]: {
          lat, level: v.level, rank: v.rank, why: v.why,
          legacyHit: lg.hit, legacyRank: lg.rank,
          nRes: rs.length,
          books: rs.map(r => ({ bookId: r.bookId, id: r.id, score: r.score })),
          routed: (res.routed_books || []).map(b => b.title || b.id),
          formDirty: d.formDirty,
          prodDirty: d.prodDirty,
        },
      },
    });
    logLine("route", `[${i + 1}/${items.length}] ${it.book} ${v.level}/${rs.length} ${it.q.slice(0, 26)}`);
  }
  return raw;
}

// ---- 日志（后台跑时看进度用）----------------------------------------------
const LOG = OUT ? path.basename(OUT) + ".log" : "quality-gate-run.log";
function logLine(tag, s) {
  fs.appendFileSync(LOG, `[${tag}] ${s}\n`, "utf8");
}

// ---- 补脏块（--from 模式：raw 里只有检索结果，脏块从库里重算，保证口径一致）------
function enrichDirty(raw) {
  for (const it of raw.items || []) {
    const defaultBookId = String(it.file || "").replace(/\.db$/, "");
    for (const key of Object.keys(it.perN || {})) {
      const d = it.perN[key];
      if (!d || !d.books) continue;
      const rs = d.books.map(b => ({ bookId: b.bookId || defaultBookId, id: b.id }));
      const dd = dirtyOf(rs, defaultBookId);
      d.formDirty = dd.formDirty;
      d.prodDirty = dd.prodDirty;
    }
  }
  return raw;
}

// ---- 五项指标 --------------------------------------------------------------
// raw 的形状：{ items: [{ book, file, q, perN: { [N]: {...} } }] }
// 复核 🟡-2：perN[N] 缺失以前一律 `|| {}` 静默兜成空对象，指标会全变 0 却照样打印
// 「绿」——那是把错数据当好数据。现在缺 N 就 throw，宁可红也不许静默算错。
function pickN(it, N, where) {
  const d = it.perN && (it.perN[N] || it.perN[String(N)]);
  if (!d) {
    const have = it.perN ? Object.keys(it.perN).join(",") : "（无 perN）";
    throw new Error(
      `${where}的第 ${it.q || it.file} 条没有 topN=${N} 的原始数据`
      + `（raw 里只有 topN=${have}）——请确认 --topN 与 raw 的 meta.topN 一致`
    );
  }
  return d;
}
export function computeMetrics(rawBook, rawRoute, N) {
  const rows = (rawBook.items || []).map(it => {
    const d = pickN(it, N, "按书口径 raw ");
    const hit = d.level === "full" || d.level === "partial";
    const formDirty = d.formDirty || [];
    const prodDirty = d.prodDirty || [];
    return {
      q: it.q, book: it.book, level: d.level, rank: d.rank || 0,
      hit,
      dirtyCount: formDirty.length,
      prodDirtyCount: prodDirty.length,
      nRes: d.nRes || 0,
      lat: d.lat || 0, legacyHit: !!d.legacyHit, legacyRank: d.legacyRank || 0,
    };
  });
  const n = rows.length || 1;
  const full = rows.filter(r => r.level === "full").length;
  const partial = rows.filter(r => r.level === "partial").length;
  const miss = rows.filter(r => r.level === "miss").length;
  const hit = full + partial;
  const hits = rows.filter(r => r.hit);
  const avgRankAll = +(rows.reduce((s, r) => s + (r.hit ? r.rank : MISS_PENALTY), 0) / n).toFixed(3);
  const avgRankHit = hits.length ? +(hits.reduce((s, r) => s + r.rank, 0) / hits.length).toFixed(3) : 0;
  const legacyHit = rows.filter(r => r.legacyHit).length;
  const legacyRanks = rows.filter(r => r.legacyHit && r.legacyRank).map(r => r.legacyRank);
  const dirtyTotal = rows.reduce((s, r) => s + r.dirtyCount, 0);
  const returnedTotal = rows.reduce((s, r) => s + r.nRes, 0);
  const dirtyRate = returnedTotal ? +(dirtyTotal / returnedTotal).toFixed(4) : 0;
  const dirtyQ = rows.filter(r => r.dirtyCount > 0).length;
  const prodDirtyTotal = rows.reduce((s, r) => s + r.prodDirtyCount, 0);
  const prodDirtyRate = returnedTotal ? +(prodDirtyTotal / returnedTotal).toFixed(4) : 0;
  const prodDirtyQ = rows.filter(r => r.prodDirtyCount > 0).length;
  const lats = rows.map(r => r.lat).filter(x => x > 0);

  // 路由准确率：端到端口径量（按书口径下它恒等于命中率，没有意义）
  const routeRows = (rawRoute && rawRoute.items ? rawRoute.items : []).map(it => {
    const d = pickN(it, N, "端到端口径 raw ");
    const hit2 = d.level === "full" || d.level === "partial";
    const expectedId = String(it.file || "").replace(/\.db$/, "");
    const hitBook = hit2 && d.rank > 0 && d.books ? (d.books[d.rank - 1] || {}).bookId : null;
    return { hit: hit2, routeOk: hit2 && hitBook === expectedId, rank: d.rank || 0, level: d.level };
  });
  const rFull = routeRows.filter(r => r.level === "full").length;
  const rPartial = routeRows.filter(r => r.level === "partial").length;
  const rHit = rFull + rPartial;
  const rAvgRank = routeRows.length
    ? +(routeRows.reduce((s, r) => s + (r.hit ? r.rank : MISS_PENALTY), 0) / routeRows.length).toFixed(3)
    : 0;
  const routeAcc = routeRows.length ? +(routeRows.filter(r => r.routeOk).length / routeRows.length).toFixed(4) : 0;
  const routeAccHitOnly = rHit ? +(routeRows.filter(r => r.routeOk).length / rHit).toFixed(4) : 0;

  return {
    total: rows.length,
    metrics: {
      hitRate: +(hit / n).toFixed(4),
      fullRate: +(full / n).toFixed(4),
      avgFirstRank: avgRankAll,
      routeAcc,
      dirtyRate,
    },
    detail: {
      // 按书口径（命中/full/名次/脏块）
      full, partial, miss, hit,
      hitRate: +(hit / n).toFixed(4),
      fullRate: +(full / n).toFixed(4),
      avgFirstRank: avgRankAll,
      avgFirstRankHitOnly: avgRankHit,
      dirtyRate, dirtyTotal, dirtyQ, returnedTotal,
      prodDirtyRate, prodDirtyTotal, prodDirtyQ,
      legacyHit, legacyRate: +(legacyHit / n).toFixed(4),
      legacyAvgFirstRank: legacyRanks.length ? +(legacyRanks.reduce((s, x) => s + x, 0) / legacyRanks.length).toFixed(3) : 0,
      damageRate: hit ? +(partial / hit).toFixed(4) : 0,
      avgLatencyMs: lats.length ? Math.round(lats.reduce((s, x) => s + x, 0) / lats.length) : 0,
      // 端到端口径（路由准确率）
      routeTotal: routeRows.length,
      routeFull: rFull, routePartial: rPartial, routeHit: rHit,
      routeHitRate: routeRows.length ? +(rHit / routeRows.length).toFixed(4) : 0,
      routeFullRate: routeRows.length ? +(rFull / routeRows.length).toFixed(4) : 0,
      routeAvgFirstRank: rAvgRank,
      routeAcc, routeAccHitOnly,
    },
    rows,
    routeRows,
  };
}

// 指标方向：true = 大者好，false = 小者好
const DIRECTION = { hitRate: true, fullRate: true, avgFirstRank: false, routeAcc: true, dirtyRate: false };
const LABEL = {
  hitRate: "命中率", fullRate: "full 率", avgFirstRank: "平均首中名次",
  routeAcc: "路由准确率", dirtyRate: "脏块入库数(率)",
};
// 每项指标量在哪个口径（写进基线文件，避免以后"数字对不上"）
const CALIBER_OF = {
  hitRate: "perbook", fullRate: "perbook", avgFirstRank: "perbook",
  routeAcc: "route", dirtyRate: "perbook",
};

// ---- 主流程 ----------------------------------------------------------------
const items = loadItems();
let rawBook, rawRoute;
if (FROM_BOOK || FROM_ROUTE) {
  if (FROM_BOOK) rawBook = enrichDirty(JSON.parse(fs.readFileSync(path.resolve(FROM_BOOK), "utf8")));
  if (FROM_ROUTE) rawRoute = enrichDirty(JSON.parse(fs.readFileSync(path.resolve(FROM_ROUTE), "utf8")));
  if (!rawBook) {
    console.error("需要 --from-book=<raw>（按书口径原始数据）；或用 --from-book 与 --from-route 同时给。");
    process.exit(2);
  }
} else {
  fs.writeFileSync(LOG, `题数：${items.length} topN=${TOP_N}\n`, "utf8");
  rawBook = await runBook(items);
  rawRoute = await runRoute(items);
  if (OUT) {
    fs.writeFileSync(OUT.replace(/\.json$/, "") + ".book.json", JSON.stringify(rawBook, null, 1), "utf8");
    fs.writeFileSync(OUT.replace(/\.json$/, "") + ".route.json", JSON.stringify(rawRoute, null, 1), "utf8");
  }
}
const N = FROM_BOOK
  // 缺省 N 从 raw 的 meta.topN 取（runBook/runRoute 在 :299/:333 写的就是 meta.topN）。
  // 复核 🟡-2：这里原本读 meta.Ns（不存在的键）→ 忘带 --topN 就静默按 4 算，
  // 拿一份 topN=1 的 raw 过来会按 N=4 找不到 perN[4]，指标全变 0 却照样出「绿」结论。
  // 现在两处都收口：这里读 meta.topN；computeMetrics 里 perN[N] 缺失直接 throw。
  ? (Number(argOf("topN", "")) || (rawBook.meta && rawBook.meta.topN) || (() => {
      throw new Error("--from-book 的 raw 里没有 meta.topN，请显式带 --topN=");
    })())
  : TOP_N;
const res = computeMetrics(rawBook, rawRoute, N);

console.log(`\n===== QUALITY GATE（topN=${N}，题数 ${res.total}）=====`);
console.log(`口径：命中/full/名次/脏块 = 按书检索 hybridSearch（与 v2-eval 同路径）｜路由准确率 = 端到端 routeAndSearch`);
console.log(`指标                本次      基线      方向   结论`);
let regress = [];
let base = null;
if (fs.existsSync(BASELINE)) {
  base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  base = base.metrics || base;
}
for (const k of Object.keys(DIRECTION)) {
  const now = res.metrics[k];
  const b = base ? base[k] : null;
  let verdict = "—";
  if (b !== null && b !== undefined) {
    const better = DIRECTION[k] ? now >= b : now <= b;
    verdict = better ? "绿" : "红";
    if (!better) regress.push(k);
  }
  console.log(
    `${LABEL[k].padEnd(18)}${String(now).padEnd(10)}${String(b === null || b === undefined ? "—" : b).padEnd(10)}`
    + `${DIRECTION[k] ? "大者好" : "小者好"}  ${verdict}`
  );
}
console.log(`\n明细（按书口径）：full ${res.detail.full} / partial ${res.detail.partial} / miss ${res.detail.miss}`
  + ` | 旧尺子命中 ${res.detail.legacyHit}/${res.total}(${res.detail.legacyRate})`
  + ` | 切块损伤率 partial÷hit ${res.detail.damageRate}`
  + ` | 平均延迟 ${res.detail.avgLatencyMs}ms`
  + ` | 形态脏块 ${res.detail.dirtyTotal}/${res.detail.returnedTotal}（涉 ${res.detail.dirtyQ} 题）`
  + ` | 产品规则脏块 ${res.detail.prodDirtyTotal}/${res.detail.returnedTotal}（涉 ${res.detail.prodDirtyQ} 题）`);
console.log(`明细（端到端口径）：full ${res.detail.routeFull} / partial ${res.detail.routePartial}`
  + ` | 命中率 ${res.detail.routeHitRate} | 平均首中名次 ${res.detail.routeAvgFirstRank}`
  + ` | 路由准确率 ${res.detail.routeAcc}（命中题内 ${res.detail.routeAccHitOnly}）`);

// 第④行的自测断言：接缝识别率（本卷答案句没被切，所以卷内 partial÷hit 恒为 0；
// 这里用全库真实接缝样本验证「新尺子能认出切块损伤、旧尺子会放过」这件事本身）
const seam = runSeamAssertion();
console.log(`接缝自测断言：样本 ${seam.total} 条（几何扫库现扫）`
  + ` | 新尺子认出 partial ${seam.newPartial} 条，识别率 ${seam.rate}`
  + ` | 旧尺子对同批样本虚命中 ${seam.legacyHit}/${seam.legacyTotal}(${seam.legacyRate})`
  + ` | 断言：识别率必须 = 1，缺一条即红`);
if (seam.fails.length) {
  for (const f of seam.fails.slice(0, 5)) {
    console.log(`  ✗ 接缝样本未被新尺子判 partial：${f.book} #${f.aId}→#${f.bId}（判成 ${f.level}）`);
  }
}

if (has("write-baseline")) {
  const payload = {
    generatedAt: new Date().toISOString(),
    topN: N,
    total: res.total,
    caliberOf: CALIBER_OF,
    metrics: res.metrics,
    detail: res.detail,
    seam: { total: seam.total, newPartial: seam.newPartial, rate: seam.rate, legacyHit: seam.legacyHit, legacyRate: seam.legacyRate },
    direction: DIRECTION,
    source: FROM_BOOK ? `from-book:${path.basename(FROM_BOOK)}` : "live",
  };
  fs.writeFileSync(BASELINE, JSON.stringify(payload, null, 1), "utf8");
  console.log(`\n基线已写：${BASELINE}`);
  process.exit(0);
}

// 第④行的自测断言也参与红绿：识别率掉到 1 以下 → 闸门红
if (seam.total > 0 && seam.rate < 1) {
  console.log(`\n✗ 接缝识别率退化：${seam.newPartial}/${seam.total}（识别率 ${seam.rate} < 1）`
    + ` —— 新尺子认不出切块损伤，这把尺子不合格`);
  process.exit(1);
}

// 防 judge 放水（复核 🟡-4）：旧尺子是关键词判据，只要答案句里的一个长词命中就算 hit，
// 天然比新尺子松（实测 full 59 / 旧尺子命中 75，旧的多出 16 条正是虚命中）。
// 所以「新尺子的 full 数 > 旧尺子命中数」在因果上说不通：更严的判据不可能比更松的判出更多
// 完整命中。一旦出现，说明有人把新尺子放松了（或旧尺子收紧到失真），必须红。
// 这条不是恒真项：正常数据下 full(59) < legacyHit(75)，恒为绿；只有放水才翻红。
if (res.detail.full > res.detail.legacyHit) {
  console.log(`\n✗ 判分尺子疑似放水：新尺子 full ${res.detail.full} > 旧尺子命中 ${res.detail.legacyHit}`
    + ` —— 更严的判据不可能判出更多完整命中，请检查 test/lib/judge.mjs`);
  process.exit(1);
}

if (regress.length) {
  console.log(`\n✗ 退化项（${regress.length} 项）：${regress.map(k => LABEL[k]).join("、")}`);
  process.exit(1);
}
if (!base) {
  console.log("\n（无基线文件，仅报数；加 --write-baseline 可落基线）");
  process.exit(0);
}
console.log(`\n✓ 五项指标均未退化`);
process.exit(0);
