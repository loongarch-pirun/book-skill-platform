// 渲染进程模块图冒烟：用最小 DOM/window stub 直接 import 入口 app.js——
// 专抓三类沙箱里看不到的雷：① ESM 循环导入 TDZ（批 1 暗雷：视图模块顶层碰 DOM，
// app.js 的 const 绑定尚未初始化就访问 → 整个渲染层崩）；② 视图模块间缺失导出；
// ③ boot 流程里的接线错误（loadReader 没接上之类——批 1 实测漏过）。
// 真正的 UI 渲染靠 Electron（本沙箱起不来 Chromium 渲染进程，见 desktop-smoke-main.js 头注）。
import { setTimeout as sleep } from "node:timers/promises";

let failed = 0;
const assert = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (!cond) failed++; };

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

// ---------- window.study IPC stub（记录调用，返回约定形状） ----------
const ipcCalls = [];
let chatSummaryCalls = 0;
const reply = (data) => Promise.resolve({ ok: true, data });
const studyStub = {
  configGet: () => { ipcCalls.push("configGet"); return reply({ dirs: {}, firstRun: false, packaged: false }); },
  configSet: () => reply({}),
  pickLibDir: () => reply(null),
  booksList: () => { ipcCalls.push("booksList"); return reply([{ id: "t.docx", title: "测试书", chunks: 3, skillEnabled: true, catalog: { cataloged: true, themes: ["主题一"] } }]); },
  bookCatalog: () => reply({}),
  deleteBook: () => reply({}),
  importBook: () => reply({}),
  jobsStatus: () => { ipcCalls.push("jobsStatus"); return reply({}); },
  jobsScanPending: () => { ipcCalls.push("jobsScanPending"); return reply([]); },
  jobsCatalogPrompt: (bookId) => { ipcCalls.push("jobsCatalogPrompt"); return reply({ bookId, chars: 42, path: `catalog-tasks/${bookId}.prompt.md`, text: "【编目任务书】测试提示词正文……" }); },
  jobsCancel: () => reply({}),
  jobsPickResult: () => reply(null),
  jobsResumeCatalog: () => reply({}),
  ask: () => { ipcCalls.push("ask"); return reply({ mode: "book", results: [{ id: 1, book: "测试书", bookId: "t.docx", loc: "第一章", text: "學而時習之", rerank: 0.9 }] }); },
  llmConfigGet: () => { ipcCalls.push("llmConfigGet"); return reply({ baseUrl: "", model: "", hasKey: false, keyTail: null, encryption: "unknown", warning: null }); },
  llmConfigSet: () => reply({ baseUrl: "https://x", model: "m", hasKey: true, keyTail: "…test", encryption: "safeStorage", warning: null }),
  llmTest: () => reply({ reply: "收到" }),
  chatSummary: () => { chatSummaryCalls++; return chatSummaryCalls === 2
    ? reply({ degraded: true, error: "云端引用核验失败，已降级为原文片段", results: [{ book: "测试书", bookId: "t.docx", id: 1, loc: "第一章", text: "本地原文甲" }], mode: "book", book: "测试书" })
    : reply({ answer: "测试总结", citations: [], dropped: 0, segments: 6, book: "测试书", mode: "book" }); },
  chapters: () => { ipcCalls.push("chapters"); return reply({ book: "测试书", chapters: [{ name: "第一章", blocks: 3 }] }); },
  block: () => { ipcCalls.push("block"); return reply({ book: "测试书", chapter: "第一章", blocks: [{ n: 1, id: 1, page: null, text: "學而時習之" }] }); },
  locate: () => reply({ chapter: "第一章" }),
  readerThemes: () => { ipcCalls.push("readerThemes"); return reply({ book: "测试书", themes: [{ name: "主题一", note: "", representatives: [] }] }); },
  readerThemeBlocks: () => { ipcCalls.push("readerThemeBlocks"); return reply({ blocks: [{ n: 1, id: 9, page: null, text: "主題代表塊" }] }); },
  readerPersons: () => { ipcCalls.push("readerPersons"); return reply({ book: "测试书", persons: [{ name: "人物甲", note: "", match_names: ["甲"], mention_count: 2 }] }); },
  readerPersonBlocks: () => { ipcCalls.push("readerPersonBlocks"); return reply({ blocks: [{ n: 1, id: 5, page: null, text: "人物出場塊" }] }); },
  skillsList: () => { ipcCalls.push("skillsList"); return reply([{ slug: "t", title: "测试技能", description: "d", coverage: "3/9", chapters: 2, sources: ["测试书"] }]); },
  skillRead: () => reply({ slug: "t", skill_md: "# t", index: [{ file: "chapters/ch01-a.md", title: "第一章", tokens_est: 100 }] }),
  skillToggle: () => reply({}),
  engineStatus: () => reply({}),
  warmup: () => reply({}),
  onModelProgress: () => {}, onEngineReady: () => {}, onEngineError: () => {}, onJobsProgress: (cb) => { studyStub.__jobsCb = cb; },
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

// ---------- 3) 翻书视图：点卡片进翻书（open 委托）+ loadReader 接线 ----------
const click = (action, data = {}) => {
  const el = { dataset: { action, ...data } };
  const ev = { target: { closest: (s) => (s === "[data-action]" ? el : null) }, stopPropagation() {} };
  for (const fn of mainEl.listeners.click || []) fn(ev);
};
click("open", { bid: "t.docx" }); // 模拟点书架卡片
await sleep(30);
assert(ipcCalls.includes("chapters"), "点卡片进翻书自动拨 chapters（loadReader 接线回归——批 1 实测没接上）");
assert(getEl("#chapList").innerHTML.includes("第一章"), "翻书目录渲染出章节（#chapList）");
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
getEl("#chatQ").value = "什么是真正的强大？";
click("chatgo", {});
await sleep(30);
assert(app.state.chat.messages.length === 2 && app.state.chat.messages[1].content === "测试总结", "对话：发送 → user+assistant 入列（chatSummary 接线）");
assert(mainEl.innerHTML.includes("什么是真正的强大？") && mainEl.innerHTML.includes("测试总结"), "对话：消息流双气泡渲染");
assert(mainEl.innerHTML.includes("取材 6 段原文") && mainEl.innerHTML.includes("《测试书》"), "对话：AI 回答带取材 meta 行（A4）");
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

console.log("\n========== 结果 ==========");
if (failed > 0) { console.log(`有 ${failed} 项 FAIL`); process.exit(1); }
console.log("全部 PASS：渲染模块图 + boot 接线 + 四视图入口 + 技能包/任务条数据流");
