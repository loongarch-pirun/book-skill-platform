// 阶段3 验收：用官方 SDK 客户端（模拟任意智能体）接入 MCP server 实测全部工具
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerServerTools } from "../src/lib/register-tools.mjs";

let failed = 0;
const assert = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (!cond) failed++; };

// 起服务端（复用与 stdio server 完全相同的工具注册逻辑）
const server = new McpServer({ name: "book-skill", version: "0.3.0" });
registerServerTools(server);
const client = new Client({ name: "test-agent", version: "1.0.0" });
const [cT, sT] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(sT), client.connect(cT)]);

// 夹具：用户可能在客户端把某本书的 skill 收起（H3 过滤会让所有工具查不到它——书全关时
// list_books 返回 0）。本套测的是工具协议与数据链路，临时全开、末尾还原，
// 不让用户的开关状态左右验收结论（guard-test 第 7 节同款做法）
const LIB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "library");
const { loadSkillState, setSkillEnabled } = await import("../src/lib/skill-state.mjs");
const beforeState = loadSkillState(LIB_DIR);
for (const id of Object.keys(beforeState).filter((id) => beforeState[id] === false)) setSkillEnabled(LIB_DIR, id, true);

// 1. 工具清单
const tools = await client.listTools();
const names = tools.tools.map(t => t.name).sort();
assert(JSON.stringify(names) === JSON.stringify(["cite_check", "expand", "get_chapter", "get_outline", "get_person", "get_theme", "list_books", "list_catalog", "list_skills", "lookup", "query_book", "query_library", "read_full_book", "read_range", "read_skill", "save_skill", "similar_chunks"]), `智能体能看到 17 个工具: ${names.join(", ")}`);

// 2. list_books（V3 第五波：书架随用户增删动态——数量对账 library/*.db 实数，≥5 防空转）
const lb = await client.callTool({ name: "list_books", arguments: {} });
const books = JSON.parse(lb.content[0].text);
const libDbCount = fs.readdirSync(path.join(import.meta.dirname, "..", "library")).filter(f => f.endsWith(".db")).length;
assert(books.length === libDbCount && books.length >= 5 && books.every(b => b.title && b.format), `list_books 返回 ${books.length} 本书（=库数 ${libDbCount}）且全带 title/format`);

// 3. query_book 单书（书名精确匹配到 PDF 版，带页码定位）
const qb = await client.callTool({ name: "query_book", arguments: { book: "lunyu-xueer-zh.pdf", question: "不患人之不己知", topN: 3 } });
const qbR = JSON.parse(qb.content[0].text);
assert(qbR.results?.length >= 1 && /lunyu/i.test(qbR.book) && qbR.results.some(r => r.loc === "第4页"),
  `query_book 精确书名命中且带页码定位（${qbR.results?.[0]?.loc}）`);

// 3b. query_book 模糊书名（"lunyu" 同时匹配 PDF+DOCX 两本 → 明确告知选了哪本）
const qb2 = await client.callTool({ name: "query_book", arguments: { book: "lunyu", question: "不患人之不己知", topN: 3 } });
const qb2R = JSON.parse(qb2.content[0].text);
assert(qb2R.results?.length >= 1 && qb2R.note && /匹配到 2 本/.test(qb2R.note),
  `query_book 模糊书名多本命中时明确提示（${qb2R.note || ""}）`);

// 3c. query_book 中文书名（匹配不到拼音名 → 自动路由到最相关的书）
const qb3 = await client.callTool({ name: "query_book", arguments: { book: "论语", question: "不患人之不己知", topN: 3 } });
const qb3R = JSON.parse(qb3.content[0].text);
assert(qb3R.results?.length >= 1 && /lunyu/i.test(qb3R.book) && qb3R.note,
  `query_book 书名未命中时自动路由: ${qb3R.book}`);

// 4. query_library 动态挑书（中文问题应在中文书里挑，不碰英文书）
// 注：2026-10-13 孟子入书库后，「和朋友相处要讲信用」会同时路由到孟子(0.865)+论语(0.862)
// ——两本都正当相关（孟子亦論朋友），最终答案仍由论语块居首。故断言收紧为：
// 论语必须在路由清单里 + 不许混进英文书，不规定两本中文书谁第一。
// 2026-10-16 V3 第二波：书库 7→12 本，默认窗口 2→3（2 本时论语被凤凰架构/孟子挤出，
// 实测语义分 0.86x 三分天下）。现断言：论语在清单 + 不混英文书 + 默认窗口就是 3 本。
// 2026-10-19 kkndme 收录后 9 库：dense-book 效应——kk(0.882)/凤凰(0.879) max-chunk 分
// 仅高过论语(0.862) 0.003，3 窗口把论语挤出，终局答案错配到「凤凰@数字证书」章。
// 默认窗口 3→4（第 4 本进池后论语两块「與朋友交」回到 top3 的 1、3 位）。
const ql = await client.callTool({ name: "query_library", arguments: { question: "和朋友相处要讲信用", topN: 3 } });
const qlR = JSON.parse(ql.content[0].text);
const routedTitles = qlR.routed_books.map(b => b.title);
assert(qlR.routed_books.length >= 1 && /lunyu/i.test(routedTitles.join(","))
  && routedTitles.every(t => !/frankenstein|attention|prejudice/i.test(t))
  && qlR.routed_books.length === 4,
  `query_library 自动挑书: ${qlR.routed_books.map(b => b.title + "(" + b.best_sim + ")").join(", ")}`);
assert(qlR.results.length >= 1 && qlR.results.every(r => r.book && r.loc !== undefined), `总入口结果带书的归属 + 定位`);

// 4b. 英文问题路由到英文书
const ql2 = await client.callTool({ name: "query_library", arguments: { question: "attention mechanism in transformers", topN: 3 } });
const ql2R = JSON.parse(ql2.content[0].text);
assert(/attention/i.test(ql2R.routed_books[0].title), `英文问题自动路由到英文书: ${ql2R.routed_books[0].title}`);

// 4c. maxBooks（P5）：路由窗口可调——同一问题收窄到 1 本只挑最相关的，=2 得默认前四中的前两
// 2026-10-16：默认窗口 2→3 后，ql4（=2）应得默认前三中的前两；ql3（=1）只拿冠军
// 2026-10-19：默认 3→4 后，ql4（=2）应得默认前四中的前两（不写死名次，只数本数）
const ql3 = await client.callTool({ name: "query_library", arguments: { question: "和朋友相处要讲信用", topN: 3, maxBooks: 1 } });
const ql3R = JSON.parse(ql3.content[0].text);
const ql4 = await client.callTool({ name: "query_library", arguments: { question: "和朋友相处要讲信用", topN: 3, maxBooks: 2 } });
const ql4R = JSON.parse(ql4.content[0].text);
assert(ql3R.routed_books.length === 1 && ql4R.routed_books.length === Math.min(2, qlR.routed_books.length),
  `query_library maxBooks 收窄/放宽: maxBooks=1 → ${ql3R.routed_books.length} 本，maxBooks=2 → ${ql4R.routed_books.length} 本，默认 ${qlR.routed_books.length} 本`);

// 5. 引用完整性：结果文本非空、含原文
assert(qlR.results.every(r => r.text && r.text.length > 10), `所有结果带原文（可回源核对）`);

// 6. list_catalog 编目浏览（P&P 已编目：12 主题 / 25 人物 / 26 关系）
const lc = await client.callTool({ name: "list_catalog", arguments: { book: "pride" } });
const lcR = JSON.parse(lc.content[0].text);
assert(lcR.cataloged === true && lcR.themes?.length === 12 && lcR.persons?.length === 25 && lcR.relations?.length === 26,
  `list_catalog 编目浏览: ${lcR.themes?.length} 主题 / ${lcR.persons?.length} 人物 / ${lcR.relations?.length} 关系`);

// 6b. list_catalog 人物关系断言（谁拆散了简和宾利 → 卡罗琳）
const carolineRel = lcR.relations.find(r => (r.a === "Caroline Bingley" && r.b === "Jane Bennet") || (r.b === "Caroline Bingley" && r.a === "Jane Bennet"));
assert(!!carolineRel && /拆散|拆开/.test(carolineRel.note), `list_catalog 关系网可查"谁拆散了简和宾利": ${carolineRel ? carolineRel.a + " ↔ " + carolineRel.b : "未找到"}`);

// 6c. list_catalog 主题过滤 + 代表块
const lc2 = await client.callTool({ name: "list_catalog", arguments: { book: "pride", theme: "pemberley" } });
const lc2R = JSON.parse(lc2.content[0].text);
assert(lc2R.filtered_themes?.length >= 1 && lc2R.theme_representatives && Object.values(lc2R.theme_representatives).flat().every(x => x.preview && x.chapter !== undefined),
  `list_catalog 主题过滤带代表块预览: ${lc2R.filtered_themes?.map(t => t.name).join(" / ")}`);

// 6d. list_catalog 1 堆小书（论语 pdf：全库 7 本现已全部编目）
const lc3 = await client.callTool({ name: "list_catalog", arguments: { book: "lunyu-xueer-zh.pdf" } });
const lc3R = JSON.parse(lc3.content[0].text);
assert(lc3R.cataloged === true && lc3R.themes?.length === 1 && lc3R.persons?.length === 5,
  `list_catalog 1 堆小书浏览: ${lc3R.themes?.map(t => t.name).join("/")} / 人物 ${lc3R.persons?.length}`);

// 6e. list_catalog 找不到的书
const lc4 = await client.callTool({ name: "list_catalog", arguments: { book: "不存在的书" } });
const lc4R = JSON.parse(lc4.content[0].text);
assert(!!lc4R.error && Array.isArray(lc4R.available), `list_catalog 书名未命中返回错误+书目清单`);

// 7. save_skill / read_skill / list_skills 端到端（引用回源用真库；临时技能测完即删）
const E2E_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "e2e-check");
const SKILL_MD = `---
name: e2e-check
title: 端到端测试技能
description: stage3 端到端临时技能，测完即删
sources:
  道德经: daodejing-zh
---
# 端到端测试
`;
const sv = await client.callTool({ name: "save_skill", arguments: { slug: "e2e-check", files: [
  { path: "SKILL.md", content: SKILL_MD },
  { path: "chapters/ch01-test.md", content: "# 测试章\n\n> 上善若水，水善利萬物而不爭。〔道德经·第八章〕\n" },
] } });
const svR = JSON.parse(sv.content[0].text);
assert(svR.ok === true && svR.citations_checked === 1, `save_skill 落盘成功且引用回源通过（校验 ${svR.citations_checked} 条）`);

// 7b. 假引文整包拒收（防幻觉红线走 MCP 通道依然有效）
const sv2 = await client.callTool({ name: "save_skill", arguments: { slug: "e2e-check", files: [
  { path: "SKILL.md", content: SKILL_MD },
  { path: "chapters/ch01-test.md", content: "# 测试章\n\n> 这是编造的假引文不存在的句子。〔道德经·第八章〕\n" },
] } });
const sv2R = JSON.parse(sv2.content[0].text);
assert(sv2R.ok === false && sv2R.errors?.[0]?.reason === "quote-not-found", "save_skill 假引文经 MCP 通道整包拒收");

// 7c. list_skills + read_skill（不带 chapter → 索引；带 chapter → 按需取章）
const ls = await client.callTool({ name: "list_skills", arguments: {} });
const lsR = JSON.parse(ls.content[0].text);
assert(lsR.some(s => s.slug === "e2e-check"), "list_skills 能看到刚落盘的技能");
const rd2 = await client.callTool({ name: "read_skill", arguments: { slug: "e2e-check" } });
const rd2R = JSON.parse(rd2.content[0].text);
assert(rd2R.skill_md && rd2R.index?.length === 1, "read_skill 不带 chapter 返回 SKILL.md + 章节索引");
const rd = await client.callTool({ name: "read_skill", arguments: { slug: "e2e-check", chapter: "ch01-test.md" } });
const rdR = JSON.parse(rd.content[0].text);
assert(rdR.content && rdR.content.includes("上善若水"), "read_skill 按 chapter 按需取章");

// 8. get_person 人物深查（P-D）：关系网从"看得到"变"摸得到原文块"
const gp = await client.callTool({ name: "get_person", arguments: { book: "pride", name: "Caroline Bingley" } });
const gpR = JSON.parse(gp.content[0].text);
assert(gpR.cataloged === true && gpR.person === "Caroline Bingley" && gpR.mention_chunks > 10
  && gpR.relations.some(r => r.other === "Jane Bennet" && /拆散|拆开/.test(r.note))
  && gpR.representative_chunks.every(c => c.chunk && c.loc !== undefined && c.preview),
  `get_person 深查: ${gpR.person} 出场 ${gpR.mention_chunks} 块 / 关系 ${gpR.relations?.length} 条 / 代表块 ${gpR.representative_chunks?.map(c => "#" + c.chunk).join(",")}`);

// 8b. 名字未命中 → 给候选清单（智能体换个写法再来，不必瞎猜）
const gp2 = await client.callTool({ name: "get_person", arguments: { book: "pride", name: "Zaphod" } });
const gp2R = JSON.parse(gp2.content[0].text);
assert(gp2R.error === "person-not-found" && gp2R.available?.length === 25, "get_person 名字未命中返回候选清单");

// 9. get_theme 主题深查（P-D）：覆盖块数 + 章节分布 + 代表块
const gt = await client.callTool({ name: "get_theme", arguments: { book: "pride", name: "pemberley" } });
const gtR = JSON.parse(gt.content[0].text);
assert(gtR.cataloged === true && gtR.chunks > 0 && gtR.chapters?.length > 0
  && gtR.representative_chunks?.length === Math.min(5, gtR.chunks),
  `get_theme 深查: ${gtR.theme} 覆盖 ${gtR.chunks} 块 / 章节分布 ${gtR.chapters?.map(c => c.chapter + "×" + c.n).join(" ")}`);

// 10. similar_chunks 以块找块（P-E）：块入口零模型、排除自身、按余弦降序
const sc = await client.callTool({ name: "similar_chunks", arguments: { book: "pride", chunk_id: 243, topN: 3 } });
const scR = JSON.parse(sc.content[0].text);
assert(scR.results?.length === 3 && scR.query?.chunk === 243 && scR.results.every(r => r.id !== 243)
  && scR.results.every((r, i, a) => i === 0 || a[i - 1].score >= r.score),
  `similar_chunks 块入口: ${scR.results?.length} 条、不含自身 #243、降序（首位 #${scR.results?.[0]?.id} 分 ${scR.results?.[0]?.score}）`);

// 10b. text 入口（现场编码查询：引擎不一致直接报错而不是给垃圾分）
const sc2 = await client.callTool({ name: "similar_chunks", arguments: { book: "pride", text: "Mr Darcy wrote a letter to explain his conduct", topN: 4 } });
const sc2R = JSON.parse(sc2.content[0].text);
assert(sc2R.results?.length === 4 && !!sc2R.embed_model && sc2R.results.every(r => r.text && r.loc !== undefined),
  `similar_chunks text 入口: ${sc2R.results?.length} 条（引擎 ${sc2R.embed_model}，带定位 + 原文可引用）`);

// 10c. 两个入口都不给 → 明确报错（不静默返回空结果骗人）
const sc3 = await client.callTool({ name: "similar_chunks", arguments: { book: "pride", topN: 3 } });
const sc3R = JSON.parse(sc3.content[0].text);
assert(sc3R.error === "missing-query", "similar_chunks: 未给参照（chunk_id/text 皆空）→ missing-query");

// 11. expand 图邻域（P2）：给一个人物，沿关系边一跳拉出邻居网——「还有谁牵涉其中」的顺藤摸瓜
const ex = await client.callTool({ name: "expand", arguments: { book: "pride", name: "Elizabeth", perNeighbor: 2 } });
const exR = JSON.parse(ex.content[0].text);
assert(exR.cataloged === true && exR.person === "Elizabeth Bennet" && exR.matched_by === "fuzzy"
  && exR.neighbors.length >= 5 && exR.neighbors.every((n, i, a) => i === 0 || a[i - 1].mention_count >= n.mention_count)
  && exR.neighbors.every(n => n.representative_chunks.length === Math.min(2, n.mention_count)
    && n.representative_chunks.every(c => c.chunk !== undefined && c.loc !== undefined && c.preview)),
  `expand 邻居网: ${exR.person} 拉到 ${exR.neighbors?.length} 个邻居（前排 ${exR.neighbors?.slice(0, 3).map(n => n.name + "×" + n.mention_count).join("、")}）`);

// 11b. expand 名字未命中 → 候选清单（智能体换个写法再来）
const ex2 = await client.callTool({ name: "expand", arguments: { book: "pride", name: "Zaphod" } });
const ex2R = JSON.parse(ex2.content[0].text);
assert(ex2R.error === "person-not-found" && ex2R.available?.length === 25, "expand 名字未命中返回候选清单");

// 12. lookup 章节直达（P4）：按标题/编号精确直达——错误码/条款号/流程步骤的正门
const lk = await client.callTool({ name: "lookup", arguments: { book: "mengzi", key: "梁惠王上·1" } });
const lkR = JSON.parse(lk.content[0].text);
assert(lkR.matched_chapter === "梁惠王上·1" && lkR.match_level === "exact" && lkR.total === 2
  && lkR.blocks.length === 2 && lkR.blocks[0].id < lkR.blocks[1].id && lkR.blocks.every(b => b.text),
  `lookup 章节直达: 「${lkR.matched_chapter}」${lkR.total} 块（${lkR.match_level} 命中，id 升序带原文）`);

// 12b. PDF 型无章节 → no-chapters 指引改走 query_book（不静默给错东西）
const lk2 = await client.callTool({ name: "lookup", arguments: { book: "lunyu-xueer-zh.pdf", key: "第一章" } });
const lk2R = JSON.parse(lk2.content[0].text);
assert(lk2R.error === "no-chapters" && /query_book/.test(lk2R.hint || ""), `lookup: PDF 无章节 → no-chapters + 指引（${lk2R.error}）`);

// 12c. 未命中 → 章节清单（cap 30）供智能体目录导航
const lk3 = await client.callTool({ name: "lookup", arguments: { book: "mengzi", key: "不存在的章" } });
const lk3R = JSON.parse(lk3.content[0].text);
assert(lk3R.error === "not-found" && lk3R.available?.length === 30 && lk3R.available_total === 261,
  `lookup: 未命中 → ${lk3R.available?.length}/${lk3R.available_total} 章候选清单（目录导航）`);

fs.rmSync(E2E_DIR, { recursive: true, force: true });  // 临时技能测完即删
for (const [id, v] of Object.entries(beforeState)) setSkillEnabled(LIB_DIR, id, v !== false);  // 还原用户开关，夹具不留痕

console.log("\n===== 阶段3 验收结果 =====");
if (failed > 0) { console.log(`${failed} 项 FAIL`); process.exit(1); }
console.log("全部 PASS：标准 MCP 协议接入成功，十四工具可用（编目浏览/人物主题深查/图邻域展开/章节直达/整章通读/区间读/相似检索/技能落盘），自动挑书路由正确，引用可回源");
process.exit(0);
