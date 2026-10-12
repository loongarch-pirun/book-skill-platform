// MCP 工具注册（stdio server 与测试客户端共用同一份注册逻辑）
import { z } from "zod";
import { listBooks, findBook, hybridSearch, routeAndSearch } from "./search.mjs";
import { getCatalogSummary } from "./catalog.mjs";

// 按 book 片段找书（与 query_book 同一套匹配；找不到返回 null 和可选书目）
function matchBook(book) {
  const q = String(book).toLowerCase();
  return listBooks().filter(b => b.id.toLowerCase().includes(q) || b.title.toLowerCase().includes(q));
}

// topN 统一上限：模型一次索要 999 条会拖垮上下文，zod 拒收 + 处理器兜底夹取
// 导出为测试钩子（guard-test 直接断言这两层）
export const TOPN_SCHEMA = z.number().int().min(1).max(20).optional().describe("返回条数，默认 4，最多 20");
export const clampTopN = (n) => Math.min(Math.max(1, Math.floor(Number(n) || 4)), 20);

export function registerServerTools(server) {
  server.registerTool("list_books", {
    title: "书架清单",
    description: "列出知识库里所有的书（标题/格式/切片数/定位方式）。回答前先调用它了解有哪些书可查。",
    inputSchema: {},
  }, async () => {
    const books = listBooks();
    return { content: [{ type: "text", text: JSON.stringify(books, null, 2) }] };
  });

  server.registerTool("list_catalog", {
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

  server.registerTool("query_book", {
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
      return { content: [{ type: "text", text: JSON.stringify({ book: routed.routed_books[0].title, question, note: `未找到名为「${book}」的书，已自动选择最相关的书`, results: routed.results }, null, 2) }] };
    }
    const b = matches[0];
    const note = matches.length > 1 ? `书名「${book}」匹配到 ${matches.length} 本，已选「${b.id}」（其余：${matches.slice(1).map(m => m.id).join("、")}）。要查特定版本请用完整书名。` : undefined;
    const results = await hybridSearch(b.db, question, n);
    return { content: [{ type: "text", text: JSON.stringify({ book: b.title, question, note, results }, null, 2) }] };
  });

  server.registerTool("query_library", {
    title: "全库检索（自动挑书）",
    description: "不知道该查哪本书时用这个：系统自动判断问题牵涉哪些书（可多本），现场组装答案，每条结果都带书的归属和定位。",
    inputSchema: {
      question: z.string().describe("要查的问题"),
      topN: TOPN_SCHEMA,
    },
  }, async ({ question, topN }) => {
    const out = await routeAndSearch(question, { topN: clampTopN(topN) });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });
}
