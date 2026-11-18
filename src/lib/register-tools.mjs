// MCP 工具注册（stdio server 与测试客户端共用同一份注册逻辑）
import { z } from "zod";
import { listBooks, hybridSearch, routeAndSearch, currentLibDir } from "./search.mjs";
import { getCatalogSummary, getPersonDetail, getThemeDetail, expandNeighborhood } from "./catalog.mjs";
import { similarChunks } from "./similar.mjs";
import { lookupEntry } from "./lookup.mjs";
import { readChapter, readRange, readFullBook, RANGE_CAP, CHAPTER_TOKEN_CAP, FULL_READ_TOKEN_CAP } from "./browse.mjs";
import { getOutline } from "./outline.mjs";
import { checkCitation } from "./cite-check.mjs";
import { saveSkill as defaultSaveSkill, readSkill, listSkills } from "./skill-store.mjs";
import { checkSkills } from "./skill-health.mjs";
import { loadSkillState } from "./skill-state.mjs";
import { loadUsagePolicy, serviceStatus, checkBudget, chargeUsage, recordUsage } from "./usage-policy.mjs";
import { buildAnchor, formatDeepLink } from "./anchor.mjs";
import { startOrigServer } from "../desktop/orig-server.mjs";

// T6：给检索结果附锚点+深链+环回网页 URL（智能体 webview 看原文/点深链拉回客户端）。
// 环回服务懒起（MCP stdio 进程自己起一个，仅 127.0.0.1+token）。
let _origSrv = null;
async function withWeb(results) {
  if (!Array.isArray(results) || !results.length) return results;
  if (process.env.BSP_ORIG_WEB === "0") return results; // 回退开关：不起环回服务/不附 webUrl
  _origSrv ||= await startOrigServer({ libDir: currentLibDir() });
  return results.map((r) => {
    const a = buildAnchor(r);
    return { ...r, anchor: a, deepLink: formatDeepLink(a), webUrl: _origSrv.bookUrl(r.bookId || r.book, r.page ?? null) };
  });
}

// 按 book 片段找书（与 query_book 同一套匹配；找不到返回 null 和可选书目）
function matchBook(book) {
  const q = String(book).toLowerCase();
  return listBooks().filter(b => b.id.toLowerCase().includes(q) || b.title.toLowerCase().includes(q));
}

// topN 统一上限：模型一次索要 999 条会拖垮上下文，zod 拒收 + 处理器兜底夹取
// 导出为测试钩子（guard-test 直接断言这两层）
export const TOPN_SCHEMA = z.number().int().min(1).max(20).optional().describe("返回条数，默认 4，最多 20。多书检索时会另附不超过 16 条同段落邻接上下文（带 nbr/nbrOf 标记，用于补全被切断的上下文），它们不占 topN 名额");
export const clampTopN = (n) => Math.min(Math.max(1, Math.floor(Number(n) || 4)), 20);

// maxBooks 统一上限（P5）：路由窗口 [1..8]，默认 3——与 TOPN 同款 zod + 处理器双层防呆
// 2026-10-16 V3 第二波：书库 7→12 本，默认 2 会把真相关书切出窗口（论语题实测被凤凰架构/孟子挤掉），抬到 3
export const MAXBOOKS_SCHEMA = z.number().int().min(1).max(8).optional().describe("全库检索最多挑几本书，默认 4，最多 8；资料库多时可调大");
export const clampMaxBooks = (n) => Math.min(Math.max(1, Math.floor(Number(n) || 4)), 8);

// ---------- 三级暴露闸机（W1 用量治理，2026-10-21） ----------
// metadata 常开（导航/发现类，成本≈0）；search 受开关+定时门控并计次；
// deepRead 门控+按返回字符扣预算。桌面端自己用不走这里（用户自己的会话自己看得见成本），
// 闸机只治「外部智能体挂上来无节制调用」这一种漏水。
// 铁律对齐 lib 层：拒绝返回 {error, hint}，不许 throw 穿层。
const TOOL_TIERS = {
  list_books: "metadata", list_catalog: "metadata", get_person: "metadata",
  get_theme: "metadata", expand: "metadata", get_outline: "metadata",
  list_skills: "metadata", read_skill: "metadata", cite_check: "metadata", check_skills: "metadata",
  query_book: "search", query_library: "search", similar_chunks: "search", lookup: "search",
  save_skill: "search",
  read_full_book: "deepRead", get_chapter: "deepRead", read_range: "deepRead",
};

// V02（第2轮 P0）：未登记工具一律拒绝注册，不许静默降级到 metadata 绕过闸机。
// IPC 是公开 API——定档表是工具集的唯一正本，缺档 = 配置错，fail-closed 抛错而非放行。
export function assertRegistered(name) {
  if (!Object.prototype.hasOwnProperty.call(TOOL_TIERS, name))
    throw new Error(`未登记工具: ${name}`);
  return TOOL_TIERS[name];
}

// 差集自检：注册名集合必须与定档表完全一致（多一个少一个都拒绝注册）。
export function assertTierCoverage(names) {
  const missing = names.filter(n => !Object.prototype.hasOwnProperty.call(TOOL_TIERS, n));
  if (missing.length) throw new Error(`未登记工具: ${missing.join(", ")}`);
  const extra = Object.keys(TOOL_TIERS).filter(n => !names.includes(n));
  if (extra.length) throw new Error(`定档表多出未注册工具: ${extra.join(", ")}`);
  return true;
}

function measureChars(result) {
  try {
    return (result?.content || []).reduce((n, c) => n + (typeof c?.text === "string" ? c.text.length : 0), 0);
  } catch { return 0; }
}

function errResult(error, hint, reason) {
  return { content: [{ type: "text", text: JSON.stringify({ error, hint, reason }) }] };
}

// V01（第2轮 P0）：事前估算深读请求的字符体量，喂给 checkBudget 的 estChars。
// 纯函数：不查库/不读盘，只看工具名与请求参数，按「申请规模」估，不是按工具会截断到多少估——
// 大区间请求要在 handler 查库取块之前被拦，别等截断完才发现超量。
// 字符口径：1 token 最坏≈4 字符（英文），中文更省，取 4 保守高估。
// read_range 按申请跨度估并钳到 RANGE_CAP（工具自身 clampRangeBlocks 上限 80 块）：
//   单块字符上界取 2000 → 满额 80×2000=160000 字符，刻意落在
//   (deepReadChars=80000, perSessionChars=200000] 窗口内：保证 checkBudget 命中
//   「single-call-too-big」而不是先撞「chars-exhausted」（检查次序见 usage-policy.mjs:104-107）。
//   不钳会让 estChars 飙到千万级、先撞会话总闸，reason 就不是单次超限了。
// 整章/全文有自身 token 闸兜底，事前按该工具的最大返回体量估（不放大、不误杀）。
const CHARS_PER_TOKEN = 4;
const CHARS_PER_BLOCK = 2000;
function estimateDeepReadChars(name, args = {}) {
  if (name === "read_range") {
    const from = Number(args.from) || 1;
    const to = Number(args.to) || from;
    const span = Math.max(1, Math.floor(to - from + 1));
    return Math.min(span, RANGE_CAP) * CHARS_PER_BLOCK;
  }
  if (name === "get_chapter") return CHAPTER_TOKEN_CAP * CHARS_PER_TOKEN;
  if (name === "read_full_book") return FULL_READ_TOKEN_CAP * CHARS_PER_TOKEN;
  return 0; // metadata/search 档：字符闸不适用
}

async function gateCall(tier, tool, handler, args, estChars = 0) {
  if (tier === "metadata") return handler(args);
  const libDir = currentLibDir();
  const policy = loadUsagePolicy(libDir);
  const st = serviceStatus(policy);
  if (!st.open) {
    recordUsage(libDir, { tool, tier, chars: 0, ok: false, reason: st.reason });
    return errResult("知识库对外服务未开放", st.hint, st.reason);
  }
  const gate = checkBudget(policy, tier, estChars);
  if (!gate.ok) {
    recordUsage(libDir, { tool, tier, chars: 0, ok: false, reason: gate.reason });
    return errResult(gate.error, gate.hint, gate.reason);
  }
  const out = await handler(args);
  const chars = measureChars(out);
  chargeUsage(tier, chars);
  recordUsage(libDir, { tool, tier, chars, ok: true });
  return out;
}

// 导出为测试钩子（usage-gate-test 直接断言分级与拒收语义；estimateDeepReadChars 供 V01 断言）
// B3/CP3：gateCall 第 5 参 sessionId 的分账是进程级语义——MCP stdio 一进程=一会话
// （04 重新审视报告 :100「或如实文档化为进程级」退路），生产调用不传 sessionId 落 default 桶。
export { TOOL_TIERS, gateCall, estimateDeepReadChars };

// gate=false：自家验收测试豁免对外闸机——stage3/guard/similar-fuzz 起进程测的是工具协议
// 与数据链路，不该被定时窗/预算/开关左右断言（2026-10-21 18:51 主人关闸后 stage3 全红的
// 教训；闸机治外部智能体，不治自家测试。对外拒收语义由 usage-gate-test 带闸直测）
export function registerServerTools(server, { gate = true, deps = {} } = {}) {
  const { saveSkill = defaultSaveSkill, handlerOverrides = {} } = deps;
  const registered = [];
  const reg = (name, def, handler) => {
    const tier = assertRegistered(name); // V02 fail-closed：缺档抛错，拒绝注册
    registered.push(name);
    const effective = handlerOverrides[name] || handler;
    // V01：调用前按 name/args 现算 estChars 传进闸机，超量在 handler 查库取块之前短路
    const wrapped = gate
      ? async (args) => gateCall(tier, name, effective, args, estimateDeepReadChars(name, args ?? {}))
      : effective;
    server.registerTool(name, def, wrapped);
  };
  reg("list_books", {
    title: "书架清单",
    description: "列出知识库里所有的书：标题、**summary（这本书讲什么，一两句话）**、格式、切片数、≈token 总量、章节质量。回答前**先调用它**，按 summary 判断哪本书可能回答用户的问题，**不要只凭书名猜**；拿不准就再调 list_catalog 看该书的主题与人物，或直接用 query_library 跨书检索。再按 total_tokens 决定读法：≤10K 用 read_full_book 全文直读，更大用 get_outline 看地图再翻章。summary 为 null 表示这本书还没有简介，只能按书名判断。",
    inputSchema: {},
  }, async () => {
    const books = listBooks();
    return { content: [{ type: "text", text: JSON.stringify(books, null, 2) }] };
  });

  reg("list_catalog", {
    title: "编目浏览",
    description: "浏览某本书的编目结构：主题分区（每区含说明/覆盖块数/章节分布）+ 人物表（身份/书中写法/出场块数）+ 人物关系网。回答人物关系类问题（谁拆散了谁、谁是谁的谁）前先浏览这里，再按图索骥去 query_book 查原文。",
    inputSchema: {
      book: z.string().describe("书名或书名片段，如 pride、论语"),
      theme: z.string().optional().describe("可选，按主题名过滤（如 marriage、婚礼），命中主题会附代表性块预览"),
    },
  }, async ({ book, theme }) => {
    const matches = matchBook(book);
    if (!matches.length)
      return { content: [{ type: "text", text: JSON.stringify({ error: `找不到书「${book}」`, available: listBooks().map(x => x.title) }) }] };
    const out = getCatalogSummary(matches[0].db, theme);
    if (!out.cataloged)
      return { content: [{ type: "text", text: JSON.stringify({ book: matches[0].title, cataloged: false, note: out.note || "这本书还没有编目，直接用 query_book 检索即可" }) }] };
    out.book = matches[0].title;
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  reg("get_person", {
    title: "人物深查",
    description: "按人物名深查某本书的编目：身份说明、书中写法（match_names）、出场块数、关系边（和谁什么关系），以及提到他/她的代表原文块（带章节/页码 + 80 字预览）。推荐动线：list_catalog 看全图 → get_person 摸到原文块 → query_book 取完整原文。",
    inputSchema: {
      book: z.string().describe("书名或书名片段，如 pride、论语"),
      name: z.string().describe("人物名或名字片段，如 Elizabeth、达西"),
    },
  }, async ({ book, name }) => {
    const matches = matchBook(book);
    if (!matches.length)
      return { content: [{ type: "text", text: JSON.stringify({ error: `找不到书「${book}」`, available: listBooks().map(x => x.title) }) }] };
    const out = getPersonDetail(matches[0].db, name);
    out.book = matches[0].title;
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  reg("get_theme", {
    title: "主题深查",
    description: "按主题名深查某本书的编目：主题说明、覆盖块数、章节分布（这块主题集中在哪几章）、代表原文块（带章节/页码 + 80 字预览）。推荐动线：list_catalog 看全图 → get_theme 摸到原文块 → query_book 取完整原文。",
    inputSchema: {
      book: z.string().describe("书名或书名片段，如 pride、论语"),
      name: z.string().describe("主题名或名字片段，如 pemberley、婚礼"),
    },
  }, async ({ book, name }) => {
    const matches = matchBook(book);
    if (!matches.length)
      return { content: [{ type: "text", text: JSON.stringify({ error: `找不到书「${book}」`, available: listBooks().map(x => x.title) }) }] };
    const out = getThemeDetail(matches[0].db, name);
    out.book = matches[0].title;
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  reg("expand", {
    title: "人物关系网（图邻域）",
    description: "给一个人物名，沿人物关系边拉出邻居网：每个邻居带关系描述、出场块数、代表原文块（章节/页码 + 80 字预览）。回答「还有谁牵涉其中」「这件事还牵连哪些人」类问题时用它顺藤摸瓜，再对邻居继续 get_person 深查或 query_book 查原文。推荐动线：list_catalog 看全图 → get_person 摸全档案 → expand 拉邻居网 → 邻居继续深挖。",
    inputSchema: {
      book: z.string().describe("书名或书名片段，如 pride、论语"),
      name: z.string().describe("人物名或名字片段，如 Elizabeth、达西"),
      perNeighbor: z.number().int().min(1).max(5).optional().describe("每个邻居返回的代表块数，默认 3，最多 5"),
    },
  }, async ({ book, name, perNeighbor }) => {
    const matches = matchBook(book);
    if (!matches.length)
      return { content: [{ type: "text", text: JSON.stringify({ error: `找不到书「${book}」`, available: listBooks().map(x => x.title) }) }] };
    const out = expandNeighborhood(matches[0].db, name, { perNeighbor });
    out.book = matches[0].title;
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  reg("lookup", {
    title: "章节直达（工作资料寻址）",
    description: "按章节标题/编号精确直达某章节的全部原文块（精确→前缀→包含三级匹配，如查错误码 E1001、条款号 3.2、流程步骤标题）。分工：查错误码/条款号/流程步骤标题用它精确直达；查概念/情节/术语解释用 query_book。文档需按 # 标题 约定导入才有章节可查（PDF 无章节；EPUB 章节名可能是正文片段——get_outline 会标 messy，按名落空就用 read_range 按块号读）。",
    inputSchema: {
      book: z.string().describe("书名或书名片段，如 员工手册、mengzi"),
      key: z.string().describe("章节标题或编号，如 E1001、3.2 安装步骤、第一章"),
      maxBlocks: z.number().int().min(1).max(40).optional().describe("本章最多返回的块数，默认 20，最多 40"),
    },
  }, async ({ book, key, maxBlocks }) => {
    const matches = matchBook(book);
    if (!matches.length)
      return { content: [{ type: "text", text: JSON.stringify({ error: `找不到书「${book}」`, available: listBooks().map(x => x.title) }) }] };
    const out = lookupEntry(matches[0].db, key, { maxBlocks });
    out.book = matches[0].title;
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  reg("cite_check", {
    title: "引文回验（防幻觉自检）",
    description: "检查一段引文是否真在某本书里逐字存在：命中返回所在块号/章节/页码（可跳原文），未命中明确告知不要采用。写完带引用的答案后用它自检——宁可报告「书中没有依据」，也不许编造引文。",
    inputSchema: {
      book: z.string().describe("书名或书名片段，如 论语、pride"),
      quote: z.string().describe("要验证的引文原文（从检索/翻章结果里照抄的那句）"),
    },
  }, async ({ book, quote }) => {
    const matches = matchBook(book);
    if (!matches.length)
      return { content: [{ type: "text", text: JSON.stringify({ error: `找不到书「${book}」`, available: listBooks().map(x => x.title) }) }] };
    const out = checkCitation(matches[0].db, quote);
    out.book = matches[0].title;
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  reg("read_full_book", {
    title: "全文直读（小书）",
    description: "≤10K token 的小书全文一口气端出（论语/道德经/attention 这个量级）——小书走检索是纯损耗还可能漏，全文进上下文零检索误差。超过 10K token 返回 too-big 并给体量与指路（get_outline 看地图 → get_chapter/read_range 翻章）。先用 list_books 看每本书的 total_tokens 再决定用不用它。",
    inputSchema: {
      book: z.string().describe("书名或书名片段，如 论语、道德经、attention"),
    },
  }, async ({ book }) => {
    const matches = matchBook(book);
    if (!matches.length)
      return { content: [{ type: "text", text: JSON.stringify({ error: `找不到书「${book}」`, available: listBooks().map(x => x.title) }) }] };
    const out = readFullBook(matches[0].db);
    out.book = matches[0].title;
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  reg("get_outline", {
    title: "全书地图",
    description: "列出某本书的章节清单：每章章名 + 块数 + ≈token + 起始块号，附全书 token 总量与章节质量标记。这是翻书动线的第一跳：先看地图决定读哪章，再用 get_chapter/read_range 翻目标章。PDF 无章节时报 no-chapters（改用 read_range/query_book）；EPUB 章节名不可靠时标 messy（按名翻章可能落空，优先 read_range）。",
    inputSchema: {
      book: z.string().describe("书名或书名片段，如 凤凰架构、pride、mengzi"),
      maxChapters: z.number().int().min(1).max(500).optional().describe("最多返回几章，默认 100，最多 500；超出会在 note 里告知总数"),
    },
  }, async ({ book, maxChapters }) => {
    const matches = matchBook(book);
    if (!matches.length)
      return { content: [{ type: "text", text: JSON.stringify({ error: `找不到书「${book}」`, available: listBooks().map(x => x.title) }) }] };
    const out = getOutline(matches[0].db, { maxChapters });
    out.book = matches[0].title;
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  reg("get_chapter", {
    title: "整章通读",
    description: "按章节名取某本书一章的完整原文（比 lookup 上限更高，为「通读/摘录全文」设计；三级匹配精确→前缀→包含，命中多章取文档序第一个）。截断按 token 闸（8K）为主、块数上限 60 为辅，note 里带真实 token 账与续读块号。PDF 无章节时报 no-chapters——改用 query_book 或 read_range；EPUB 章节名可能是正文片段（get_outline 会标 messy）——按名落空时用 read_range。",
    inputSchema: {
      book: z.string().describe("书名或书名片段，如 pride、mengzi"),
      chapter: z.string().describe("章节名（或前缀/包含匹配），如 梁惠王上、Chapter 8"),
      maxBlocks: z.number().int().min(1).max(60).optional().describe("最多返回块数（硬上限），默认 60；token 闸 8K 可能提前截断"),
    },
  }, async ({ book, chapter, maxBlocks }) => {
    const matches = matchBook(book);
    if (!matches.length)
      return { content: [{ type: "text", text: JSON.stringify({ error: `找不到书「${book}」`, available: listBooks().map(x => x.title) }) }] };
    const out = readChapter(matches[0].db, chapter, { maxBlocks });
    out.book = matches[0].title;
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  reg("read_range", {
    title: "原文区间读",
    description: "按块号区间连续读某本书的原文（from/to 都是 query_book/lookup/get_chapter/read_full_book 结果里的 id）。适合「把这一段完整读给我」「从第 X 块接着往下读」。截断按 token 闸（8K）为主、块数上限 80 为辅，区间过宽会截断并给续读游标（带 token 账）；区间为空会报本书块号范围。无章节的书（PDF/ messy EPUB）优先用它。",
    inputSchema: {
      book: z.string().describe("书名或书名片段，如 pride、mengzi"),
      from: z.number().int().min(1).describe("起始块号（含）"),
      to: z.number().int().min(1).describe("结束块号（含）"),
      maxBlocks: z.number().int().min(1).max(80).optional().describe("最多返回块数（硬上限），默认 80；token 闸 8K 可能提前截断"),
    },
  }, async ({ book, from, to, maxBlocks }) => {
    const matches = matchBook(book);
    if (!matches.length)
      return { content: [{ type: "text", text: JSON.stringify({ error: `找不到书「${book}」`, available: listBooks().map(x => x.title) }) }] };
    const out = readRange(matches[0].db, from, to, { maxBlocks });
    out.book = matches[0].title;
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  reg("query_book", {
    title: "单书检索",
    description: "在指定的某一本书里检索。回答带页码（PDF）或章节（epub/docx）定位，原文一字不改。book 参数可用书名片段匹配。人物关系类问题建议先用 list_catalog 看人物表和关系网。",
    inputSchema: {
      book: z.string().describe("书名或书名片段，如 论语、attention、pride"),
      question: z.string().describe("要查的问题"),
      topN: TOPN_SCHEMA,
    },
  }, async ({ book, question, topN }) => {
    const n = clampTopN(topN);
    const matches = matchBook(book);
    if (!matches.length) {
      // 书名没匹配上 → 不报错，自动路由到与问题最相关的那本书（与总入口同一套挑书逻辑）
      const routed = await routeAndSearch(question, { topN: n, maxBooks: 1 });
      if (!routed.routed_books.length)
        return { content: [{ type: "text", text: JSON.stringify({ error: `找不到书「${book}」且书库为空`, available: listBooks().map(x => x.title) }) }] };
      return { content: [{ type: "text", text: JSON.stringify({ book: routed.routed_books[0].title, question, note: `未找到名为「${book}」的书，已自动选择最相关的书`, results: await withWeb(routed.results) }, null, 2) }] };
    }
    const b = matches[0];
    const note = matches.length > 1 ? `书名「${book}」匹配到 ${matches.length} 本，已选「${b.id}」（其余：${matches.slice(1).map(m => m.id).join("、")}）。要查特定版本请用完整书名。` : undefined;
    const results = await hybridSearch(b.db, question, n);
    return { content: [{ type: "text", text: JSON.stringify({ book: b.title, question, note, results: await withWeb(results) }, null, 2) }] };
  });

  reg("query_library", {
    title: "全库检索（自动挑书）",
    description: "不知道该查哪本书时用这个：系统自动判断问题牵涉哪些书（可多本），现场组装答案，每条结果都带书的归属和定位。maxBooks 控制最多挑几本（默认 4），资料库多时可调大。",
    inputSchema: {
      question: z.string().describe("要查的问题"),
      topN: TOPN_SCHEMA,
      maxBooks: MAXBOOKS_SCHEMA,
    },
  }, async ({ question, topN, maxBooks }) => {
    const out = await routeAndSearch(question, { topN: clampTopN(topN), maxBooks: clampMaxBooks(maxBooks) });
    out.results = await withWeb(out.results);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  reg("similar_chunks", {
    title: "相似块查询（以块找块）",
    description: "给一个块号或一句话，用向量找全书最相似的 N 块——回答「这段话还有哪里讲过类似的事」。chunk_id 入口纯库内余弦（零模型、最快）；text 入口需现场编码查询，引擎与书库不一致时直接报错而不是给垃圾分。结果带章节/页码，可直接引用。",
    inputSchema: {
      book: z.string().describe("书名或书名片段，如 pride、论语"),
      chunk_id: z.number().int().optional().describe("参照块号（query_book 结果里的 id）"),
      text: z.string().optional().describe("参照的一段话（与 chunk_id 二选一）"),
      topN: TOPN_SCHEMA,
    },
  }, async ({ book, chunk_id, text, topN }) => {
    const matches = matchBook(book);
    if (!matches.length)
      return { content: [{ type: "text", text: JSON.stringify({ error: `找不到书「${book}」`, available: listBooks().map(x => x.title) }) }] };
    const out = await similarChunks(matches[0].db, { chunkId: chunk_id, text, topN: clampTopN(topN) });
    out.book = matches[0].title;
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  reg("save_skill", {
    title: "技能落盘",
    description: "把蒸馏好的技能文件集写入 skills/ 目录（SKILL.md + references/ 或 chapters/ + 可选 glossary/patterns/cheatsheet）。整包提交（幂等覆盖）。落盘前做两道校验：结构校验（slug/路径白名单/frontmatter）+ 引用回源验证——blockquote 里的「〔书名·章节〕」引文会到 library 原文比对，造假整包拒收并指出造假位置。更新已有技能：先 read_skill 取全文，修改后整包重交。引用规则：原文照抄检索结果（繁体照抄），行尾加〔别名·章节〕，别名必须是 SKILL.md frontmatter sources 里声明的映射。",
    inputSchema: {
      slug: z.string().describe("技能标识，小写字母/数字/连字符，如 daodejing；中文写进 frontmatter title"),
      files: z.array(z.object({
        path: z.string().describe("相对路径：SKILL.md | references/chNN-小写连字符.md（或 chapters/ 同格式） | glossary.md | patterns.md | cheatsheet.md | catalog.json"),
        content: z.string().describe("完整文件内容（markdown）"),
      })).min(1).max(120).describe("整包文件集，必须包含 SKILL.md"),
    },
  }, async ({ slug, files }) => {
    const out = saveSkill(slug, files); // 由 deps 注入；生产默认 defaultSaveSkill
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  reg("read_skill", {
    title: "技能阅读（按需加载）",
    description: "读已落盘的技能。不带 chapter：返回 SKILL.md 全文 + 章节索引（含每章预估 token），先看索引再决定读哪章——章节文件按需加载，不读不占上下文。带 chapter：返回该章全文。",
    inputSchema: {
      slug: z.string().describe("技能标识，如 daodejing"),
      chapter: z.string().optional().describe("章节文件名，如 ch01-wu-wei。省略时只返回 SKILL.md + 索引"),
    },
  }, async ({ slug, chapter }) => {
    // 技能级开关（W3.5，2026-10-21）：skill-state.json 里记 false 的技能对 MCP 拒收——
    // 键空间与书级开关共用一份扁平文件（bookId 与技能 slug 不重叠，各查各的键）
    if (loadSkillState(currentLibDir())[slug] === false)
      return { content: [{ type: "text", text: JSON.stringify({ error: "skill-disabled", hint: `技能「${slug}」已被主人在桌面客户端关闭（技能开关页）——不读它的内容，也不要尝试变体拼写绕过`, available: listSkills().filter(s => loadSkillState(currentLibDir())[s.slug] !== false).map(s => s.slug) }) }] };
    const out = readSkill(slug, chapter);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  reg("list_skills", {
    title: "技能清单",
    description: "列出 skills/ 目录里已落盘且未被关闭的技能（标题/描述/章节数/来源书）。回答任务前先看有没有现成技能可复用——有现成手册就不必重新检索全书。主人关掉的技能不在此列（按需可请主人在桌面客户端打开）。",
    inputSchema: {},
  }, async () => {
    const st = loadSkillState(currentLibDir());
    const out = listSkills().filter(s => st[s.slug] !== false);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  reg("check_skills", {
    title: "技能体检（红黄绿）",
    description: "对 skills/ 全部技能包做红黄绿体检：红=源书被删/引文回源失败/索引断链/覆盖声称对不上（不可信不可用），黄=源书被关/无章节文件/catalog.json 异常（能用但提醒），绿=全部通过。书库增删后、或准备复用旧技能前先跑它——书多了以后旧技能会悄悄失效，别拿过期手册答题。只读体检、不写不改：修技能是智能体自己的事（read_skill 取全文 → 修改 → save_skill 整包重交，三道质检）。",
    inputSchema: {},
  }, async () => {
    const out = checkSkills();
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  // V02：注册完毕再核一次「注册名集合 === 定档表」，双向差集都为 0 才放行。
  assertTierCoverage(registered);
}
