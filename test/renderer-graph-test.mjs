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
};
global.CustomEvent = global.CustomEvent || class CustomEvent { constructor(t) { this.type = t; } };
global.location = { reload() {} };

// ---------- window.study IPC stub（记录调用，返回约定形状） ----------
const ipcCalls = [];
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
  jobsCancel: () => reply({}),
  jobsPickResult: () => reply(null),
  jobsResumeCatalog: () => reply({}),
  ask: () => { ipcCalls.push("ask"); return reply({ mode: "book", results: [] }); },
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
assert(ipcCalls.includes("booksList") && ipcCalls.includes("jobsStatus") && ipcCalls.includes("skillsList"),
  `boot 拨通 booksList/jobsStatus/skillsList（实际：${[...new Set(ipcCalls)].join(",")}）`);
assert(mainEl.innerHTML.includes("测试书"), "书架显示书卡（booksList 数据落地）");

// ---------- 3) 翻书视图：点卡片进翻书（open 委托）+ loadReader 接线 ----------
const click = (action, data = {}) => {
  const el = { dataset: { action, ...data } };
  const ev = { target: { closest: (s) => (s === "[data-action]" ? el : null) } };
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

// ---------- 6) jobs 进度事件 → 书架横幅 ----------
app.show("shelf");
await sleep(10);
studyStub.__jobsCb?.({ bookId: "new.docx", stage: "vector", label: "向量化中", detail: "向量 3/10 块" });
await sleep(30);
assert(Object.keys(app.state.jobs).length === 1, "jobs 进度事件落进 state.jobs");

console.log("\n========== 结果 ==========");
if (failed > 0) { console.log(`有 ${failed} 项 FAIL`); process.exit(1); }
console.log("全部 PASS：渲染模块图 + boot 接线 + 四视图入口 + 技能包/任务条数据流");
