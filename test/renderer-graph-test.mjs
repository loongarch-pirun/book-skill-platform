// 渲染进程模块图冒烟：用最小 DOM/window stub 直接 import 入口 app.js——
// 专抓三类沙箱里看不到的雷：① ESM 循环导入 TDZ（批 1 暗雷：视图模块顶层碰 DOM，
// app.js 的 const 绑定尚未初始化就访问 → 整个渲染层崩）；② 视图模块间缺失导出；
// ③ boot 流程里的接线错误（loadReader 没接上之类——批 1 实测漏过）。
// 真正的 UI 渲染靠 Electron（本沙箱起不来 Chromium 渲染进程，见 desktop-smoke-main.js 头注）。
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0, observed = 0;
const assert = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (!cond) failed++; };
// OBSERVE：登记不修的轻微项（暴力测试传统三分法）——条件必须成立才记，不成立按 FAIL 算
const obs = (cond, msg, note = "") => {
  if (cond) { observed++; console.log("OBSERVE - " + msg + (note ? " | " + note : "")); }
  else { failed++; console.log("FAIL - " + msg + "（OBSERVE 条件不成立）" + note); }
};

// ---------- 最小 DOM stub（任意选择器回记忆化元素，贴近真 DOM） ----------
const elCache = new Map();
const makeEl = (sel = "") => {
  const el = {
    sel, innerHTML: "", textContent: "", value: "", checked: false, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    querySelector: (s) => getEl(s), querySelectorAll: () => [],
    closest: () => null, scrollIntoView() {}, remove() {}, focus() {},
  };
  return el;
};
const getEl = (s) => { if (!elCache.has(s)) elCache.set(s, makeEl(s)); return elCache.get(s); };
const mainEl = getEl("#main");
global.document = {
  querySelector: (s) => getEl(s),
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  addEventListener: () => {}, // views.js 拖拽监听挂在 document 级（G-03 防浏览器导航），stub 放行
};
global.CustomEvent = global.CustomEvent || class CustomEvent { constructor(t) { this.type = t; } };
global.location = { reload() {} };
global.confirm = () => true; // 删书/清存档确认框（views.js del、views-chat.js archclear）——桩里一律放行

// ---------- window.study IPC stub（记录调用，返回约定形状） ----------
const ipcCalls = [];
let chatSummaryCalls = 0;
let askTopN = null;
const chatSummaryArgs = [];
const archiveCalls = [];
let archiveCleared = false;
const reply = (data) => Promise.resolve({ ok: true, data });
const studyStub = {
  configGet: () => { ipcCalls.push("configGet"); return reply({ dirs: {}, firstRun: false, packaged: false }); },
  configSet: () => reply({}),
  pickLibDir: () => reply(null),
  // V3 #167：书架空两本——一本已加工（processed）、一本仅入库未加工（raw，等「开始加工」）
  booksList: () => { ipcCalls.push("booksList"); return reply([
    { id: "t.docx", title: "测试书", chunks: 3, skillEnabled: true, status: "processed", catalog: { cataloged: true, themes: ["主题一"] }, enrich: { ready: false } },
    { id: "rawbook.docx", title: "未加工书", chunks: 0, skillEnabled: true, status: "raw", format: "txt", catalog: { cataloged: false, themes: [], persons: 0 }, enrich: { ready: false } },
  ]); },
  bookCatalog: () => reply({}),
  deleteBook: (bookId) => { ipcCalls.push("deleteBook"); return reply({}); },
  // V3 #168 两档删除第二档：彻底删除（库 + books/ 原件一体删）
  purgeBook: (bookId) => { ipcCalls.push("purgeBook"); return reply({ purged: bookId, removedAsset: true, note: "已彻底删除" }); },
  importBook: () => reply({}),
  // V3 #167 拆两段：第二段加工入口（raw 书「开始加工」按钮 → jobs:start）
  jobsStart: (bookId) => { ipcCalls.push("jobsStart"); return reply({ bookId, stage: "catalog", clusters: 2 }); },
  // G-02：拖拽取真实路径（webUtils 仅在 preload 可用，经这里转发）——R6 静态对账要求
  // studyStub 覆盖 preload 全部 API，漏一个就等于测试里断了条真实契约没人知道
  filePathOf: (f) => (f && (f.path || f.name)) || "",
  chatCompact: () => reply({ ok: false, skipped: true }), // V3-R6：对账要求 stub 覆盖全部 preload API（真行为由主进程测）
  jobsStatus: () => { ipcCalls.push("jobsStatus"); return reply({}); },
  jobsScanPending: () => { ipcCalls.push("jobsScanPending"); return reply([]); },
  jobsCatalogPrompt: (bookId) => { ipcCalls.push("jobsCatalogPrompt"); return reply({ bookId, chars: 42, path: `catalog-tasks/${bookId}.prompt.md`, text: "【编目任务书】测试提示词正文……" }); },
  jobsCancel: () => reply({}),
  jobsPickResult: () => reply(null),
  jobsResumeCatalog: () => reply({}),
  // 洗数据一键入口（V3 #140）：stub 覆盖 preload 全部 API（漏一个=真实契约在测试里断掉没人知道）
  enrichStart: (bookId) => { ipcCalls.push("enrichStart"); return reply({ started: true, bookId, estimate: { calls: 4, chunks: 6, chapters: 2 } }); },
  enrichCancel: () => reply({ cancelled: true, note: "已取消" }),
  enrichStatus: () => reply({}),
  enrichAudit: (bookId) => { ipcCalls.push("enrichAudit"); return reply({ ready: false }); },
  ask: (payload) => { ipcCalls.push("ask"); askTopN = payload?.topN; return reply({ mode: "book", results: [{ id: 1, book: "测试书", bookId: "t.docx", loc: "第一章", text: "學而時習之", rerank: 0.9 }] }); },
  llmConfigGet: () => { ipcCalls.push("llmConfigGet"); return reply({ baseUrl: "", model: "", hasKey: false, keyTail: null, encryption: "unknown", warning: null }); },
  llmConfigSet: () => reply({ baseUrl: "https://x", model: "m", hasKey: true, keyTail: "…test", encryption: "safeStorage", warning: null }),
  llmTest: () => reply({ reply: "收到" }),
  chatSummary: (payload) => { chatSummaryCalls++; chatSummaryArgs.push(payload); return chatSummaryCalls === 2
    ? reply({ degraded: true, error: "云端引用核验失败，已降级为原文片段", results: [{ book: "测试书", bookId: "t.docx", id: 1, loc: "第一章", text: "本地原文甲" }], mode: "book", book: "测试书" })
    : reply({ answer: "测试总结", citations: [], dropped: 0, segments: 6, book: "测试书", mode: "book" }); },
  chatArchiveList: (payload) => { archiveCalls.push(payload); return reply([{ ts: "2026-10-14T08:00:00.000Z", question: "存档里的旧问题", answer: "存档里的旧回答", mode: "book", book: "测试书", model: "deepseek-chat", dropped: 0, citations: [{ n: 1, book: "测试书", bookId: "t.docx", id: 1, loc: "第一章", quote: "學而時習之", text: "學而時習之" }] }]); },
  chatArchiveClear: () => { archiveCleared = true; return reply({ cleared: true }); },
  chapters: () => { ipcCalls.push("chapters"); return reply({ book: "测试书", chapters: [{ name: "第一章", blocks: 3, tokens: 3000 }], quality: { verdict: "messy", coverage: 0.85 }, totalTokens: 9000, notes: ["仅 85% 的块带章节标记——未覆盖的块用检索读"] }); },
  block: () => { ipcCalls.push("block"); return reply({ book: "测试书", chapter: "第一章", blocks: [{ n: 1, id: 1, page: null, text: "學而時習之" }] }); },
  locate: () => reply({ chapter: "第一章" }),
  readerThemes: () => { ipcCalls.push("readerThemes"); return reply({ book: "测试书", themes: [{ name: "主题一", note: "", representatives: [] }] }); },
  readerThemeBlocks: () => { ipcCalls.push("readerThemeBlocks"); return reply({ blocks: [{ n: 1, id: 9, page: null, text: "主題代表塊" }] }); },
  readerPersons: () => { ipcCalls.push("readerPersons"); return reply({ book: "测试书", persons: [{ name: "人物甲", note: "", match_names: ["甲"], mention_count: 2 }] }); },
  readerPersonBlocks: () => { ipcCalls.push("readerPersonBlocks"); return reply({ blocks: [{ n: 1, id: 5, page: null, text: "人物出場塊" }] }); },
  // 原书视图（V3 #166）
  bookOriginal: () => { ipcCalls.push("bookOriginal"); return reply({ bookId: "t.docx", ext: "docx", name: "t.docx", size: 1024, url: "book://asset/t.docx", render: "html" }); },
  bookOpenExternal: () => { ipcCalls.push("bookOpenExternal"); return reply({ opened: "books/t.docx" }); },
  skillsList: () => { ipcCalls.push("skillsList"); return reply([{ slug: "t", title: "测试技能", description: "d", coverage: "3/9", chapters: 2, sources: ["测试书"] }]); },
  skillRead: () => reply({ slug: "t", skill_md: "# t", index: [{ file: "chapters/ch01-a.md", title: "第一章", tokens_est: 100 }] }),
  skillToggle: () => reply({}),
  engineStatus: () => reply({}),
  warmup: () => reply({}),
  onModelProgress: () => {}, onEngineReady: () => {}, onEngineError: () => {}, onJobsProgress: (cb) => { studyStub.__jobsCb = cb; }, onEnrichProgress: () => {},
};
global.window = { study: studyStub, addEventListener() {}, dispatchEvent() {} };

// ---------- 1) 导入整张模块图（TDZ/缺失导出在这里现形） ----------
let app;
try {
  app = await import("../src/renderer/app.js");
  assert(true, "模块图导入无 TDZ/缺失导出（批 1 暗雷回归防线）");
} catch (e) {
  assert(false, `模块图导入失败：${e.message}`);
  console.log("\n========== 结果 ==========");
  console.log("模块图就挂了，后续断言无意义");
  process.exit(1);
}

// ---------- 2) boot 跑完：书架渲染 + 关键 IPC 都拨了 ----------
await sleep(50); // boot 是异步的，等几个 IPC 往返
assert(mainEl.innerHTML.includes("书架"), "boot 后渲染出书架视图");
assert(ipcCalls.includes("booksList") && ipcCalls.includes("jobsScanPending") && ipcCalls.includes("jobsStatus") && ipcCalls.includes("skillsList") && ipcCalls.includes("llmConfigGet"),
  `boot 拨通 booksList/jobsScanPending/jobsStatus/skillsList/llmConfigGet（实际：${[...new Set(ipcCalls)].join(",")}）`);
assert(mainEl.innerHTML.includes("测试书"), "书架显示书卡（booksList 数据落地）");
assert(getEl("#cloudChip").textContent.includes("云端 AI 未配置"), "C4：boot 后顶栏云端 chip 显示未配置态（与 modelChip 并列）");

// ---------- 2b) V3 #167 两段式：raw 卡片带「开始加工」（无洗数据按钮）→ 点击拨通 jobsStart ----------
assert(mainEl.innerHTML.includes("未加工书") && mainEl.innerHTML.includes("开始加工"),
  "raw 卡片渲染「未加工」态 + 「开始加工」按钮（#167 书架入口）");
{
  // 单独渲染一本 raw 书验证按钮分流：有「开始加工」按钮、无「洗数据」按钮（没有库可洗）
  // （view-sub 文案里也提「洗数据」三个字——断言必须认 data-action，不认全文；
  //   renderShelf 读 state.books，直接改状态再 refresh，不麻烦 IPC stub）
  const realBooks = app.state.books;
  app.state.books = [{ id: "rawbook.docx", title: "未加工书", chunks: 0, skillEnabled: true, status: "raw", format: "txt", catalog: { cataloged: false, themes: [], persons: 0 }, enrich: { ready: false } }];
  app.refresh();
  assert(mainEl.innerHTML.includes('data-action="process"') && !mainEl.innerHTML.includes('data-action="enrich"'),
    "raw 卡片只有「开始加工」按钮没有「洗数据」按钮（#167 按钮分流：没库可洗）");
  // V3 #168 两档删除：raw 书没有库可「移出」——只有彻底删除；processed 书两档都在
  assert(mainEl.innerHTML.includes('data-action="purge"') && !mainEl.innerHTML.includes('data-action="del"'),
    "raw 卡片只有「彻底删除」（#168：没库可移出，purge 删 books/ 原件）");
  app.state.books = [{ id: "t.docx", title: "测试书", chunks: 3, skillEnabled: true, status: "processed", format: "docx", asset: { exists: true }, catalog: { cataloged: true, themes: ["主题一"] }, enrich: { ready: false } }];
  app.refresh();
  assert(mainEl.innerHTML.includes('data-action="del"') && mainEl.innerHTML.includes('data-action="purge"'),
    "processed 卡片「移出书架」+「彻底删除」两档都在（#168）");
  app.state.books = realBooks;
  app.refresh();
}

// ---------- 3) 翻书视图：点卡片进翻书（open 委托）+ loadReader 接线 ----------
const click = (action, data = {}) => {
  const el = { dataset: { action, ...data } };
  const ev = { target: { closest: (s) => (s === "[data-action]" ? el : null) }, stopPropagation() {} };
  for (const fn of mainEl.listeners.click || []) fn(ev);
};
click("process", { bid: "rawbook.docx" });
await sleep(30);
assert(ipcCalls.includes("jobsStart"), "点「开始加工」→ jobsStart 拨通（#167 第二段入口）");

// V3 #168 两档删除：点「彻底删除」→ purgeBook 拨通（确认清单+真删在主进程侧验）
click("purge", { bid: "rawbook.docx" });
await sleep(30);
assert(ipcCalls.includes("purgeBook"), "点「彻底删除」→ purgeBook 拨通（#168 第二档入口）");
click("del", { bid: "t.docx" });
await sleep(30);
assert(ipcCalls.includes("deleteBook"), "点「移出书架」→ deleteBook 拨通（#168 第一档入口）");

const fireChange = (sel, value) => { // 模拟 <select> 换书（B6 断言用）
  const el = getEl(sel);
  el.id = sel.replace("#", "");
  el.value = value;
  for (const fn of mainEl.listeners.change || []) fn({ target: el });
};
const fireInput = (sel, value) => { // 模拟输入（C2 草稿同步断言用）
  const el = getEl(sel);
  el.id = sel.replace("#", "");
  el.value = value;
  for (const fn of mainEl.listeners.input || []) fn({ target: el });
};
const fireKeydown = (sel, key, opts = {}) => { // 模拟按键（P4-R2 Enter 防连点断言用）
  const el = getEl(sel);
  el.id = sel.replace("#", "");
  const ev = { target: el, key, shiftKey: !!opts.shift, prevented: false, preventDefault() { ev.prevented = true; } };
  for (const fn of mainEl.listeners.keydown || []) fn(ev);
  return ev;
};
click("open", { bid: "t.docx" }); // 模拟点书架卡片
await sleep(30);
assert(ipcCalls.includes("chapters"), "点卡片进翻书自动拨 chapters（loadReader 接线回归——批 1 实测没接上）");
assert(getEl("#chapList").innerHTML.includes("第一章"), "翻书目录渲染出章节（#chapList）");
assert(getEl("#chapList").innerHTML.includes("≈3K"), "目录章条带 token 账（get_outline 对称，fmtK K 记法）");
assert(getEl("#chapList").innerHTML.includes("章节名可疑"), "章节质量徽标渲染（messy → 「章节名可疑」）");
assert(getEl("#chapList").innerHTML.includes("仅 85% 的块带章节标记"), "outline notes（覆盖率提示）透传渲染");
click("chap", { ch: "第一章" }); // 点目录章节
await sleep(20);
assert(getEl("#blockList").innerHTML.includes("學而時習之"), "原文块渲染（繁体原文透传，#blockList）");
click("theme", { t: "主题一" }); // 点主题 chip
await sleep(20);
assert(getEl("#blockList").innerHTML.includes("主題代表塊"), "主题筛选渲染代表块（reader:themeBlocks 接线）");
click("person", { p: "人物甲" }); // 点人物 chip
await sleep(20);
assert(getEl("#blockList").innerHTML.includes("人物出場塊"), "人物筛选渲染出场块（reader:personBlocks 接线）");
click("askthis", { bid: 5 }); // 问这段
await sleep(10);
assert(app.state.ask.question.includes("人物出場塊"), "「问这段」把原文带进问一问");
click("askthischat", { bid: 5 }); // C2：带去对话
await sleep(10);
assert(app.state.chat.draft?.includes("人物出場塊"), "C2：「带去对话」把原文带进对话输入草稿（不自动发问，给人改的机会）");
app.show("skills");
await sleep(30);
assert(mainEl.innerHTML.includes("每本书的 skill 开关"), "技能面板渲染开关区");
assert(mainEl.innerHTML.includes("测试技能") && mainEl.innerHTML.includes("3/9"), "技能包卡片带 coverage 徽标（frontmatter coverage 字段接线）");

// ---------- 5) 问一问视图：技能包选择器 ----------
app.show("ask");
await sleep(10);
assert(mainEl.innerHTML.includes("用技能包回答"), "问一问带技能包勾选（state.skills.packages 已由 boot 预拉）");
assert(mainEl.innerHTML.includes("测试技能"), "技能包下拉列出可选包");

// ---------- 5b) 云端问答（V2 P2）：状态条 + 配置卡展开/收起 ----------
assert(mainEl.innerHTML.includes("云端 AI 未配置"), "问一问带云端 AI 状态条（未配置引导）");
click("llmedit", {});
await sleep(10);
assert(mainEl.innerHTML.includes("云端 AI 配置") && mainEl.innerHTML.includes("测试连接"), "配置卡展开（llmedit 接线）");
click("llmclose", {});
await sleep(10);
assert(!mainEl.innerHTML.includes("云端 AI 配置"), "配置卡收起（llmclose 接线）");

// ---------- 5b-2) 保存配置 + 云端错误内嵌条（A3）：失败 → 持久错误条 + 重试入口 ----------
getEl("#llmBase").value = "https://api.deepseek.com/v1";
getEl("#llmModel").value = "deepseek-chat";
getEl("#llmKey").value = "sk-test";
click("llmedit", {});
await sleep(10);
click("llmsave", {});
await sleep(20);
assert(app.state.llm.config?.hasKey === true, "问一问：保存配置后 hasKey 落地（llmsave 接线）");
assert(getEl("#cloudChip").textContent.includes("已就绪") && getEl("#cloudChip").textContent.includes("尾号"),
  "C4：保存配置后顶栏云端 chip 刷为就绪态（模型名+尾号，不回显全文）");
getEl("#askQ").value = "测试问题";
click("askgo", {});
await sleep(20);
const realChatSummary = studyStub.chatSummary;
studyStub.chatSummary = () => Promise.resolve({ ok: false, error: { message: "模拟云端炸了" } });
click("clsummary", {});
await sleep(20);
assert(mainEl.innerHTML.includes("模拟云端炸了") && mainEl.innerHTML.includes("重新总结"),
  "问一问：云端错误进内嵌条（持久可见 + 重试入口，A3）");
studyStub.chatSummary = realChatSummary;

// ---------- 5c) 对话窗口（V2 P3）：发消息 → 消息流入列 ----------
app.show("chat");
await sleep(10);
assert(mainEl.innerHTML.includes("多轮问答"), "对话视图渲染（P3 导航接线）");
// C2：带去对话的草稿透传进输入框（第一次发送前 draft 还在）
assert(mainEl.innerHTML.includes("人物出場塊"), "C2：对话输入框渲染草稿（带去对话的原文，可改可直接发）");
// C5：对话页内嵌云端状态条/配置卡——与问一问共用 cloudBarHtml 单一实现
assert(mainEl.innerHTML.includes("云端 AI 已就绪") && mainEl.innerHTML.includes("换配置"),
  "C5：对话页内嵌云端状态条（ask 页同款 cloudBarHtml，配置入口不再要跳页）");
click("llmedit", {});
await sleep(10);
assert(mainEl.innerHTML.includes("云端 AI 配置") && app.state.view === "chat",
  "C5：对话页就地展开配置卡（llmedit 不跳页，bindAskEvents 处理器服务两页）");
click("llmclose", {});
await sleep(10);
assert(!mainEl.innerHTML.includes("云端 AI 配置"), "C5：对话页配置卡收起");
getEl("#chatQ").value = "什么是真正的强大？";
click("chatgo", {});
await sleep(30);
assert(app.state.chat.messages.length === 2 && app.state.chat.messages[1].content === "测试总结", "对话：发送 → user+assistant 入列（chatSummary 接线）");
assert(mainEl.innerHTML.includes("什么是真正的强大？") && mainEl.innerHTML.includes("测试总结"), "对话：消息流双气泡渲染");
assert(mainEl.innerHTML.includes("取材 6 段原文") && mainEl.innerHTML.includes("《测试书》"), "对话：AI 回答带取材 meta 行（A4）");
// C2：input 委托实时同步草稿——用户接着打字，draft 回写，任何 refresh 都不会把输入打回旧值
fireInput("#chatQ", "这段和老子说的关系");
await sleep(5);
assert(app.state.chat.draft === "这段和老子说的关系", "C2：输入委托实时同步草稿（refresh 不打回）");
// A1：第二次调用走降级通道（云端失败不丢本地原文）——错误气泡挂「本地原文」折叠区
getEl("#chatQ").value = "再问一句";
click("chatgo", {});
await sleep(30);
assert(app.state.chat.messages.length === 4 && app.state.chat.messages[3].error?.includes("降级") && app.state.chat.messages[3].results?.length === 1,
  "对话：云端失败 → error 消息携带本地检索结果（A1 降级通道）");
assert(mainEl.innerHTML.includes("看本地检索到的 1 段原文") && mainEl.innerHTML.includes("本地原文甲") && mainEl.innerHTML.includes('class="deglist hidden"'),
  "对话：错误气泡挂本地原文折叠区（引用可跳，A1）");
click("chatclear", {});
await sleep(10);
assert(app.state.chat.messages.length === 0, "对话：清空接线");

// ---------- 5d) 书全关引导（A2）：问一问/对话两页空态都给「去开书」按钮 ----------
const savedEnabled = app.state.books.map((b) => b.skillEnabled);
app.state.books.forEach((b) => { b.skillEnabled = false; });
app.show("ask");
await sleep(10);
assert(mainEl.innerHTML.includes("去「技能开关」打开"), "问一问：书全关时显示去开书引导（A2）");
app.show("chat");
await sleep(10);
assert(mainEl.innerHTML.includes("去「技能开关」打开"), "对话：书全关时显示去开书引导（A2）");
app.state.books.forEach((b, i) => { b.skillEnabled = savedEnabled[i]; });
app.show("shelf");
await sleep(10);

// ---------- 5e) B 档对齐：topN 三处同源 / 换书清技能包 / 文案口吻统一 ----------
app.show("ask");
await sleep(10);
getEl("#askQ").value = "段数对齐测试";
click("askgo", {});
await sleep(20);
assert(askTopN === 6, `B1：问一问本地检索 topN 走共享常量 RETRIEVE_TOPN（实际 ${askTopN}）`);
click("clsummary", {});
await sleep(20);
assert(chatSummaryArgs.length > 0 && chatSummaryArgs.every((a) => a?.topN === 6),
  `B1：云端总结两页 topN 一致为 6（实际 ${chatSummaryArgs.map((a) => a?.topN).join(",")}）`);
assert(mainEl.innerHTML.includes("回车发送"), "B2：问一问输入提示统一为「回车发送」");
app.state.ask.skillSlug = "t"; // 模拟已勾选技能包
fireChange("askBook", "t.docx");
await sleep(10);
assert(app.state.ask.skillSlug === null, "B6：问一问换书清技能包（技能包不跨书挂载）");
app.show("chat");
await sleep(10);
assert(mainEl.innerHTML.includes("回车发送"), "B2：对话输入提示统一为「回车发送」");
app.state.chat.skillSlug = "t";
fireChange("chatBook", "t.docx");
await sleep(10);
assert(app.state.chat.bookId === "t.docx" && app.state.chat.skillSlug === null,
  "B6：对话换书同步 bookId 并清技能包");
// C2：草稿生命周期收尾——发送成功后清空（消息已入列，输入框回到空白）
fireInput("#chatQ", "草稿收尾测试");
click("chatgo", {});
await sleep(30);
assert(app.state.chat.draft === "", "C2：发送成功后草稿清空（draft 生命周期闭环）");

// ---------- 5f) P4 云端回答存档：开关接线 / 快照渲染 / 引用徽标 / 清空 ----------
app.show("chat");
await sleep(10);
assert(mainEl.innerHTML.includes("存档") && !mainEl.innerHTML.includes("云端回答存档"), "P4：对话页带存档开关（默认收起）");
click("archtoggle", {});
await sleep(20);
assert(mainEl.innerHTML.includes("云端回答存档") && mainEl.innerHTML.includes("存档里的旧问题") && mainEl.innerHTML.includes("存档里的旧回答"),
  "P4：存档面板打开并渲染快照（问题+回答+书名+模型）");
assert(mainEl.innerHTML.includes("跳原文") && archiveCalls.length === 1, "P4：快照引用徽标可跳原文（chatArchiveList 拨通一次）");
click("archclear", {});
await sleep(20);
assert(archiveCleared === true && app.state.chat.archive.items.length === 0, "P4：清空存档接线（chatArchiveClear + items 归零）");
click("archtoggle", {});
await sleep(10);
assert(!mainEl.innerHTML.includes("云端回答存档"), "P4：存档面板收起");

// ---------- 6) jobs 进度事件 → 书架横幅 ----------
app.show("shelf");
await sleep(10);
studyStub.__jobsCb?.({ bookId: "new.docx", stage: "vector", label: "向量化中", detail: "向量 3/10 块" });
await sleep(30);
assert(Object.keys(app.state.jobs).length === 1, "jobs 进度事件落进 state.jobs");

// ---------- 7) 待编目一键提示词：按钮 → 生成 → 面板展开（G-04 之后的第 5 步防线） ----------
// 用已在书架上的 t.docx 发 catalog 事件（横幅只对 state.books 里存在的书渲染卡片）
studyStub.__jobsCb?.({ bookId: "t.docx", stage: "catalog", label: "待编目", detail: "任务书已生成，等编目结果" });
await sleep(30);
assert(mainEl.innerHTML.includes("生成提示词"), "待编目卡片带「生成提示词」按钮");
click("catprompt", { bid: "t.docx" });
await sleep(40);
assert(app.state.prompt?.bookId === "t.docx" && app.state.prompt.text.includes("编目任务书"), "点击后拉回提示词全文（state.prompt）");
assert(mainEl.innerHTML.includes('id="promptText"') && mainEl.innerHTML.includes("复制提示词") && mainEl.innerHTML.includes("收起"),
  "提示词面板渲染（只读文本框 + 复制/收起按钮）");

// ---------- 8) P4 前端契约（R1~R6）：对话页事件面 + Enter 防连点 + 历史顺序 + 折叠区 + dropped 行 + IPC 对账 ----------
// 先切回对话页——sendChat 里的 refresh() 重渲染当前视图，停在书架页的话下面的渲染断言全落空
app.show("chat");
await sleep(10);
// R1：#main 四类监听器齐——input 是 C2 草稿同步的唯一线索，漏绑的话「带去对话」的
// 原文会被任何 refresh 打回旧值（批 1 暗雷在对话页的对应物；click/keydown/change 缺一即断功能）
assert(["click", "keydown", "change", "input"].every((t) => (mainEl.listeners[t] || []).length > 0),
  `P4-R1: #main 四类监听器齐（实际注册：${Object.keys(mainEl.listeners).filter((t) => mainEl.listeners[t].length).join(",")}）`);

// R2：Enter 防连点双发——sendChat 的 loading 守卫是第一道闸；连点/回车+按钮双发
// 会重复扣 token 且消息列塞重复问答。Shift+回车必须放行换行不发送。
// （替换桩自带局部计数器——不碰全局 chatSummaryCalls，避免与前面用例的计数缠在一起）
let releaseChat = null, r2Calls = 0;
app.state.chat.messages = []; // 清掉前面用例的遗留消息，本轮计数从零开始
studyStub.chatSummary = () => { r2Calls++; return new Promise((res) => {
  releaseChat = () => res({ ok: true, data: { answer: "防连点回答", citations: [], dropped: 0, segments: 6, book: "测试书", mode: "book" } });
}); };
getEl("#chatQ").value = "连点测试";
click("chatgo", {});
assert(mainEl.innerHTML.includes("思考中"), "P4-R2: 发送中按钮进 loading 态（防连点的视觉面）");
fireKeydown("#chatQ", "Enter"); // 第一次还没回来，回车再点一次
await sleep(5);
assert(r2Calls === 1,
  `P4-R2: loading 期间 Enter 不再双发（chatSummary 调用 ${r2Calls} 次，守卫挡下第二次）`);
const shiftEv = fireKeydown("#chatQ", "Enter", { shift: true });
assert(r2Calls === 1 && !shiftEv.prevented,
  "P4-R2b: Shift+回车不发送也不 preventDefault（换行语义放行）");
releaseChat();
await sleep(30);
assert(app.state.chat.messages.length === 2 && app.state.chat.messages[1].content === "防连点回答",
  "P4-R2c: 唯一一次发送正常落地（user+assistant 各一条，无重复）");
studyStub.chatSummary = realChatSummary;

// R3：buildHistory 窗口 6→12（V3-R6 政策）——8 条消息含 2 条 error 时，窗口全包、
// 先滤 error 后送出 6 条有效历史；主进程 sanitizeHistory 同步 12/3000。行为锁定防静默漂移。
app.state.chat.messages = [
  { role: "user", content: "旧问题一" }, { role: "assistant", content: "旧回答一" },
  { role: "assistant", error: "旧错误" },
  { role: "user", content: "问题二" }, { role: "assistant", content: "回答二" },
  { role: "user", content: "问题三" }, { role: "assistant", content: "回答三" },
  { role: "assistant", error: "新错误" },
];
const histBefore = chatSummaryArgs.length;
// 主进程同场景（sanitizeHistory 先滤后切）会送出几条——必须在发送前算：
// 发送本身会再追加 2 条有效消息，事後算会把测试自己的发送算进去
const validAll = app.state.chat.messages.filter((m) => (m.role === "user" || m.role === "assistant") && !m.error && m.content);
getEl("#chatQ").value = "历史顺序测试";
click("chatgo", {});
await sleep(30);
const sentHistory = chatSummaryArgs[histBefore]?.history || [];
assert(sentHistory.length === 6 && sentHistory[0].content === "旧问题一" && sentHistory[5].content === "回答三",
  `P4-R3: buildHistory 窗口 6→12（V3-R6）：全量滤 error 后送出 ${sentHistory.length} 条，首条「${sentHistory[0]?.content}」——行为锁定防静默漂移`);
assert(sentHistory.every((h) => h.role === "user" || h.role === "assistant") && sentHistory.every((h) => !h.error),
  "P4-R3b: 送出的历史无 error 条目、角色合法（主进程边界还有一道净化，双保险）");
// 主进程 sanitizeHistory 同步 12/3000（V3-R6）——同场景两侧一致，旧「顺序不对称」场景不再触发，登记保留
assert(validAll.length === 6,
  `P4-R3c: 同场景主进程 sanitizeHistory（12/3000）会送出 ${Math.min(validAll.length, 12)} 条（渲染层送 ${sentHistory.length} 条——两侧一致）`);
obs(true, "P4-R3d buildHistory/sanitizeHistory 过滤顺序不对称登记",
  `渲染层 slice(-6) 先于过滤、主进程先过滤后 slice(-6)：error 消息挤占近 6 条窗口时，渲染层把窗口外的有效历史一起误伤（少送 ${validAll.length - sentHistory.length} 条）。上下文变少不影响正确性，轻微，登记不修`);

// R3e：V3R-D14 两层压缩窗对账——渲染层 maybeCompact 切「除最后 6 条外全部」，
// 主进程 compactHistory 必须全量压缩（旧代码再保「最后 4 条」→ 中间 4 条既不进记忆、
// 又不在渲染层保留窗里，静默丢失，提示行对这 4 条也不实）。静态对账锁口径：任一侧单独改数立红。
{
  const chatSrc = fs.readFileSync(path.join(ROOT, "src/renderer/views-chat.js"), "utf8");
  const mainSrc = fs.readFileSync(path.join(ROOT, "src/desktop/chat.mjs"), "utf8");
  assert(/usable\.slice\(0, usable\.length - 6\)/.test(chatSrc) && /c\.messages = c\.messages\.slice\(-6\)/.test(chatSrc),
    "P4-R3e: 渲染层压缩边界在位（送除最后 6 条外全部 + 成功后保留近 6 条）");
  assert(/const old = arr;/.test(mainSrc) && !/arr\.slice\(0, arr\.length - 4\)/.test(mainSrc),
    "P4-R3e2: 主进程 compactHistory 全量压缩不二次切窗（旧 -4 口径丢中间 4 条，D14 修复锁定）");
}

// R4：降级折叠区开关——A1 的「看本地检索到的 N 段原文」按钮要真的能展开/收起
// （stub 的 closest 恒 null，专门造一条带 .degfold→.deglist 链的假事件目标）
const toggleCalls = [];
const degBox = { classList: { toggle: (c) => toggleCalls.push(c) } };
const degBtn = {
  dataset: { action: "degtoggle" },
  closest: (s) => (s === "[data-action]" ? degBtn : s === ".degfold" ? { querySelector: () => degBox } : null),
};
for (const fn of mainEl.listeners.click || []) fn({ target: degBtn, stopPropagation() {} });
assert(toggleCalls.includes("hidden"),
  `P4-R4: 降级折叠区开关接线（degtoggle → .deglist.classList.toggle("hidden")，实测调用：${toggleCalls.join(",") || "无"}）`);

// R5：dropped>0 → 引用核验丢弃警告行（用户得知道有几条引用被隐藏了，不然以为就这些）
// （替换桩同样自带局部计数器——计数逻辑在原装 stub 里，换桩不碰全局）
let r5Calls = 0;
studyStub.chatSummary = () => { r5Calls++; return reply({ answer: "带丢弃的回答", citations: [], dropped: 2, segments: 6, book: "测试书", mode: "book" }); };
getEl("#chatQ").value = "丢弃警告测试";
click("chatgo", {});
await sleep(30);
assert(mainEl.innerHTML.includes("2 条引用未通过核验已隐藏"),
  "P4-R5: dropped>0 → dropwarn 警告行（隐藏了几条引用必须告知用户）");
assert(mainEl.innerHTML.includes("带丢弃的回答"),
  "P4-R5b: 带 dropped 的回答正常渲染（警告行不挡回答本体）");
assert(r5Calls === 1,
  `P4-R5c: dropped 用例只发一次（chatSummary 调用 ${r5Calls} 次）`);
studyStub.chatSummary = realChatSummary;

// R6：preload ↔ ipc.mjs ↔ studyStub 三方静态对账——
// ① preload 每个 invoke 通道都在 ipc.mjs 有注册（不然点了没反应）；
// ② ipc.mjs 每个 handle 都被 preload 消费（不然是死通道）；
// ③ studyStub 覆盖 preload 全部 API（测试契约完整，漏一个断链没人知道）。
const preloadSrc = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
const ipcSrc = fs.readFileSync(path.join(ROOT, "src", "desktop", "ipc.mjs"), "utf8");
const preloadInvoke = [...preloadSrc.matchAll(/(\w+):\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\("([^"]+)"/g)].map((m) => [m[1], m[2]]);
const preloadOn = [...preloadSrc.matchAll(/(\w+):\s*\([^)]*\)\s*=>\s*ipcRenderer\.on\("([^"]+)"/g)].map((m) => m[1]);
const ipcChannels = [...ipcSrc.matchAll(/handle\("([^"]+)"/g)].map((m) => m[1]);
const invokeSet = new Set(preloadInvoke.map(([, ch]) => ch));
const handleSet = new Set(ipcChannels);
const orphanInvoke = [...invokeSet].filter((ch) => !handleSet.has(ch));
// on* 是主→渲染事件通道（ipcRenderer.on，不走 handle 注册），不参与 invoke 对账
const orphanHandle = [...handleSet].filter((ch) => !invokeSet.has(ch));
const stubKeys = Object.keys(studyStub);
const missingStub = [...new Set([...preloadInvoke.map(([m]) => m), ...preloadOn])].filter((m) => !stubKeys.includes(m));
assert(preloadInvoke.length > 0 && ipcChannels.length > 0,
  `P4-R6: 静态对账样本量正常（preload invoke ${preloadInvoke.length} 条 / ipc handle ${ipcChannels.length} 条——0 条说明正则失效，对账形同虚设）`);
assert(orphanInvoke.length === 0,
  `P4-R6a: preload 每个 invoke 通道都有 ipc 注册（孤儿：${orphanInvoke.join(",") || "无"}）`);
assert(orphanHandle.length === 0,
  `P4-R6b: ipc 每个 handle 都被 preload 消费（孤儿：${orphanHandle.join(",") || "无"}）`);
assert(missingStub.length === 0,
  `P4-R6c: studyStub 覆盖 preload 全部 API（缺：${missingStub.join(",") || "无"}）`);
assert(invokeSet.size === handleSet.size,
  `P4-R6d: 两端通道数一致（invoke ${invokeSet.size} / handle ${handleSet.size}——不一致说明有单向漂移）`);

console.log("\n========== 结果 ==========");
if (failed > 0) { console.log(`有 ${failed} 项 FAIL`); process.exit(1); }
console.log(`全部 PASS（含 ${observed} 项 OBSERVE 登记）：渲染模块图 + boot 接线 + 四视图入口 + 技能包/任务条数据流 + P4 前端契约 R1~R6`);
