// MCP 工具注册（stdio server 与测试客户端共用同一份注册逻辑）
import { z } from "zod";
import { listBooks, hybridSearch, routeAndSearch } from "./search.mjs";
import { getCatalogSummary, getPersonDetail, getThemeDetail, expandNeighborhood } from "./catalog.mjs";
import { similarChunks } from "./similar.mjs";
import { lookupEntry } from "./lookup.mjs";
import { readChapter, readRange } from "./browse.mjs";
import { saveSkill, readSkill, listSkills } from "./skill-store.mjs";

// 按 book 片段找书（与 query_book 同一套匹配；找不到返回 null 和可选书目）
function matchBook(book) {
  const q = String(book).toLowerCase();
  return listBooks().filter(b => b.id.toLowerCase().includes(q) || b.title.toLowerCase().includes(q));
}

// topN 统一上限：模型一次索要 999 条会拖垮上下文，zod 拒收 + 处理器兜底夹取
// 导出为测试钩子（guard-test 直接断言这两层）
export const TOPN_SCHEMA = z.number().int().min(1).max(20).optional().describe("返回条数，默认 4，最多 20");
export const clampTopN = (n) => Math.min(Math.max(1, Math.floor(Number(n) || 4)), 20);

// maxBooks 统一上限（P5）：路由窗口 [1..8]，默认 2——与 TOPN 同款 zod + 处理器双层防呆
export const MAXBOOKS_SCHEMA = z.number().int().min(1).max(8).optional().describe("全库检索最多挑几本书，默认 2，最多 8；资料库多时可调大");
export const clampMaxBooks = (n) => Math.min(Math.max(1, Math.floor(Number(n) || 2)), 8);

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

  server.registerTool("get_person", {
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

  server.registerTool("get_theme", {
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

  server.registerTool("expand", {
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

  server.registerTool("lookup", {
    title: "章节直达（工作资料寻址）",
    description: "按章节标题/编号精确直达某章节的全部原文块（精确→前缀→包含三级匹配，如查错误码 E1001、条款号 3.2、流程步骤标题）。分工：查错误码/条款号/流程步骤标题用它精确直达；查概念/情节/术语解释用 query_book。文档需按 # 标题 约定导入才有章节可查（PDF 无章节、EPUB 章节值不可靠）。",
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

  server.registerTool("get_chapter", {
    title: "整章通读",
    description: "按章节名取某本书一章的完整原文（比 lookup 上限更高，为「通读/摘录全文」设计；三级匹配精确→前缀→包含，命中多章取文档序第一个）。读长章被截断时按 note 里的提示用 read_range 续读。PDF 无章节时报 no-chapters——改用 query_book 或 read_range。",
    inputSchema: {
      book: z.string().describe("书名或书名片段，如 pride、mengzi"),
      chapter: z.string().describe("章节名（或前缀/包含匹配），如 梁惠王上、Chapter 8"),
      maxBlocks: z.number().int().min(1).max(60).optional().describe("最多返回块数，默认 60"),
    },
  }, async ({ book, chapter, maxBlocks }) => {
    const matches = matchBook(book);
    if (!matches.length)
      return { content: [{ type: "text", text: JSON.stringify({ error: `找不到书「${book}」`, available: listBooks().map(x => x.title) }) }] };
    const out = readChapter(matches[0].db, chapter, { maxBlocks });
    out.book = matches[0].title;
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  server.registerTool("read_range", {
    title: "原文区间读",
    description: "按块号区间连续读某本书的原文（from/to 都是 query_book/lookup/get_chapter 结果里的 id）。适合「把这一段完整读给我」「从第 X 块接着往下读」。区间过宽会截断并给续读游标；区间为空会报本书块号范围。",
    inputSchema: {
      book: z.string().describe("书名或书名片段，如 pride、mengzi"),
      from: z.number().int().min(1).describe("起始块号（含）"),
      to: z.number().int().min(1).describe("结束块号（含）"),
      maxBlocks: z.number().int().min(1).max(80).optional().describe("最多返回块数，默认 80"),
    },
  }, async ({ book, from, to, maxBlocks }) => {
    const matches = matchBook(book);
    if (!matches.length)
      return { content: [{ type: "text", text: JSON.stringify({ error: `找不到书「${book}」`, available: listBooks().map(x => x.title) }) }] };
    const out = readRange(matches[0].db, from, to, { maxBlocks });
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
    description: "不知道该查哪本书时用这个：系统自动判断问题牵涉哪些书（可多本），现场组装答案，每条结果都带书的归属和定位。maxBooks 控制最多挑几本（默认 2），资料库多时可调大。",
    inputSchema: {
      question: z.string().describe("要查的问题"),
      topN: TOPN_SCHEMA,
      maxBooks: MAXBOOKS_SCHEMA,
    },
  }, async ({ question, topN, maxBooks }) => {
    const out = await routeAndSearch(question, { topN: clampTopN(topN), maxBooks: clampMaxBooks(maxBooks) });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  server.registerTool("similar_chunks", {
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

  server.registerTool("save_skill", {
    title: "技能落盘",
    description: "把蒸馏好的技能文件集写入 skills/ 目录（SKILL.md + chapters/ + 可选 glossary/patterns/cheatsheet）。整包提交（幂等覆盖）。落盘前做两道校验：结构校验（slug/路径白名单/frontmatter）+ 引用回源验证——blockquote 里的「〔书名·章节〕」引文会到 library 原文比对，造假整包拒收并指出造假位置。更新已有技能：先 read_skill 取全文，修改后整包重交。引用规则：原文照抄检索结果（繁体照抄），行尾加〔别名·章节〕，别名必须是 SKILL.md frontmatter sources 里声明的映射。",
    inputSchema: {
      slug: z.string().describe("技能标识，小写字母/数字/连字符，如 daodejing；中文写进 frontmatter title"),
      files: z.array(z.object({
        path: z.string().describe("相对路径：SKILL.md | chapters/chNN-小写连字符.md | glossary.md | patterns.md | cheatsheet.md | catalog.json"),
        content: z.string().describe("完整文件内容（markdown）"),
      })).min(1).max(120).describe("整包文件集，必须包含 SKILL.md"),
    },
  }, async ({ slug, files }) => {
    const out = saveSkill(slug, files);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  server.registerTool("read_skill", {
    title: "技能阅读（按需加载）",
    description: "读已落盘的技能。不带 chapter：返回 SKILL.md 全文 + 章节索引（含每章预估 token），先看索引再决定读哪章——章节文件按需加载，不读不占上下文。带 chapter：返回该章全文。",
    inputSchema: {
      slug: z.string().describe("技能标识，如 daodejing"),
      chapter: z.string().optional().describe("章节文件名，如 ch01-wu-wei。省略时只返回 SKILL.md + 索引"),
    },
  }, async ({ slug, chapter }) => {
    const out = readSkill(slug, chapter);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  server.registerTool("list_skills", {
    title: "技能清单",
    description: "列出 skills/ 目录里所有已落盘的技能（标题/描述/章节数/来源书）。回答任务前先看有没有现成技能可复用——有现成手册就不必重新检索全书。",
    inputSchema: {},
  }, async () => {
    const out = listSkills();
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });
}
