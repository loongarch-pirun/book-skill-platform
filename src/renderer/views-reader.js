// 视图二：翻书（按章翻 / 按主题逛 / 看人物出场块 + 问这段 + 引用跳转高亮）。
// 编目资产（主题/人物）来自 reader:themes / reader:persons 通道（engine.mjs 自建浏览 API）。
// 铁律同 views.js：顶层不碰 DOM，事件绑定走 bindReaderEvents()。
import { $, state, call, toast, show } from "./app.js";
import { esc } from "./views.js";

// ---------- ② 翻书 ----------
// 三种浏览模式：chapter 按章翻 / theme 按主题逛（编目主题分区）/ person 看人物出场块
export function renderReader() {
  const r = state.reader;
  if (!r.bookId) return `<div class="view-title">翻书</div><div class="empty">先去书架点开一本书</div>`;
  const filterBar = r.mode === "chapter" ? "" : `
    <div class="filterbar">正在看：${r.mode === "theme" ? "主题" : "人物"}「<b>${esc(r.filter)}</b>」的 ${r.blocks.length} 个块
      <button class="ghost sm" data-action="backchap">返回目录浏览</button></div>`;
  return `
    <div class="view-title">${esc(r.title || r.bookId)}</div>
    <div class="view-sub">原文一字不改 · 引用跳转后高亮对应块 · 读到哪不服，点「问这段」直接带去问一问</div>
    <div class="catstrip" id="catStrip">${catStripHtml(r)}</div>
    ${filterBar}
    <div class="reader">
      <div class="chaplist" id="chapList"><div class="empty" style="padding:12px">目录加载中…</div></div>
      <div class="blocks" id="blockList"><div class="skeleton">原文加载中…</div></div>
    </div>`;
}

// 编目条：主题分区 chips + 人物表 chips（吃 llm 编目层；无编目时不显示）
function catStripHtml(r) {
  if (!r.catLoaded) return '<div class="catempty">编目数据加载中…</div>';
  if (!r.themes.length && !r.persons.length) return '<div class="catempty">这本书还没有编目数据（可走导入管线或命令行编目流程）</div>';
  const themes = r.themes.map(t =>
    `<button class="catchip theme ${r.mode === "theme" && r.filter === t.name ? "active" : ""}" data-action="theme" data-t="${esc(t.name)}" title="${esc(t.note || "")}">${esc(t.name)}</button>`).join("");
  const persons = r.persons.map(p =>
    `<button class="catchip person ${r.mode === "person" && r.filter === p.name ? "active" : ""}" data-action="person" data-p="${esc(p.name)}" title="${esc(p.note || "")}${p.mention_count ? " · 出场 " + p.mention_count + " 块" : ""}">${esc(p.name)}</button>`).join("");
  return `
    <div class="catrow"><span class="catlabel">主题分区</span><div class="catchips">${themes || '<span class="catnone">（无）</span>'}</div></div>
    <div class="catrow"><span class="catlabel">人物表</span><div class="catchips">${persons || '<span class="catnone">（无）</span>'}</div></div>`;
}

export async function loadReader() {
  const r = state.reader;
  if (state.view !== "reader" || !r.bookId) return;
  const bid = r.bookId; // 异步期间可能换了书/视图：完成后核对，防写错视图
  const stale = () => state.view !== "reader" || state.reader.bookId !== bid;
  try {
    if (!r.chapters.length) {
      const c = await call(window.study.chapters(bid));
      if (stale()) return;
      r.chapters = c.chapters;
      r.title = c.book;
      if (!r.chapter && c.chapters.length) r.chapter = c.chapters[0].name;
      $("#chapList").innerHTML = r.chapters.map((ch) =>
        `<div class="chapitem ${ch.name === r.chapter && r.mode === "chapter" ? "active" : ""}" data-action="chap" data-ch="${esc(ch.name)}"><span>${esc(ch.name)}</span><span class="n">${ch.blocks} 块</span></div>`).join("")
        || '<div class="empty" style="padding:12px">（空书）</div>';
    }
    if (r.mode === "theme") await loadThemeBlocks(r.filter);
    else if (r.mode === "person") await loadPersonBlocks(r.filter);
    else if (r.loadedChapter !== r.chapter) await loadChapter(r.chapter); // 同章不重拉（refresh 防抖）
    if (!r.catLoaded) loadCatalogAssets(); // 编目条后台加载，完了只更新条本身
  } catch (e) { if (!stale()) toast("翻书失败：" + e.message); }
}

// 编目资产（主题/人物）拉取 → 只重画编目条，不碰正文区
async function loadCatalogAssets() {
  const r = state.reader;
  if (!r.bookId || r.catLoaded) return;
  r.catLoaded = true; // 先占位，防并发重复拉
  try {
    const [th, pe] = await Promise.all([
      call(window.study.readerThemes(r.bookId)),
      call(window.study.readerPersons(r.bookId)),
    ]);
    if (state.reader !== r) return; // 期间换了书（新 state 对象），丢弃
    r.themes = th.themes || [];
    r.persons = pe.persons || [];
    const strip = $("#catStrip");
    if (strip) strip.innerHTML = catStripHtml(r);
  } catch (e) { r.catLoaded = false; toast("编目数据加载失败：" + e.message); }
}

async function loadChapter(ch) {
  const r = state.reader;
  if (!ch) return;
  r.mode = "chapter";
  r.filter = null;
  r.chapter = ch;
  try {
    const b = await call(window.study.block(r.bookId, ch));
    r.blocks = b.blocks;
    r.loadedChapter = ch;
    renderBlocks(b.blocks, ch);
    $("#chapList")?.querySelectorAll(".chapitem").forEach((el) => el.classList.toggle("active", el.dataset.ch === ch));
    scrollToHighlight();
  } catch (e) { toast("读原文失败：" + e.message); }
}

async function loadThemeBlocks(theme) {
  const r = state.reader;
  if (!theme) return;
  r.mode = "theme";
  r.filter = theme;
  try {
    const b = await call(window.study.readerThemeBlocks(r.bookId, theme));
    r.blocks = b.blocks;
    renderBlocks(b.blocks, `主题「${theme}」代表块`);
    refreshFilterBar();
  } catch (e) { toast("读主题块失败：" + e.message); }
}

async function loadPersonBlocks(person) {
  const r = state.reader;
  if (!person) return;
  r.mode = "person";
  r.filter = person;
  try {
    const b = await call(window.study.readerPersonBlocks(r.bookId, person));
    r.blocks = b.blocks;
    renderBlocks(b.blocks, `人物「${person}」出场块`);
    refreshFilterBar();
  } catch (e) { toast("读人物块失败：" + e.message); }
}

// 正文区渲染（三种模式共用）；highlightId 由引用跳转设置
function renderBlocks(blocks, label) {
  const r = state.reader;
  $("#blockList").innerHTML = (blocks.length ? blocks : [{ id: 0, n: 0, page: null, text: "（这个筛选下没有块）" }]).map((x) => `
    <div class="block ${x.id === r.highlightId ? "hl" : ""}" id="blk-${x.id}">
      <div class="loc">${esc(label)} · 第 ${x.n} 块${x.page ? " · 第 " + x.page + " 页" : ""}
        ${x.id ? `<button class="askthis" data-action="askthis" data-bid="${x.id}">问这段</button><button class="askthis" data-action="askthischat" data-bid="${x.id}">带去对话</button>` : ""}</div>
      <div class="text">${esc(x.text)}</div>
    </div>`).join("");
}

function refreshFilterBar() {
  const r = state.reader;
  const bar = document.querySelector(".filterbar");
  if (bar) bar.querySelector("b").textContent = r.filter;
  $("#chapList")?.querySelectorAll(".chapitem").forEach((el) => el.classList.remove("active"));
}

function scrollToHighlight() {
  const r = state.reader;
  const hl = $("#blk-" + r.highlightId);
  if (hl) hl.scrollIntoView({ block: "center" });
  r.highlightId = null;
}

// 引用徽标 → 反查章节 → 跳翻书并高亮（模块联动的闭环）
export async function jumpTo(bookId, chunkId) {
  if (!bookId || chunkId == null || chunkId === "") { toast("这条结果没有可跳转的定位"); return; }
  try {
    const loc = await call(window.study.locate(bookId, chunkId));
    if (!loc.chapter) { toast("找不到这一块了（书可能被删过）"); return; }
    state.reader = { bookId, title: null, chapter: loc.chapter, chapters: [], loadedChapter: null, highlightId: chunkId, mode: "chapter", filter: null, themes: [], persons: [], blocks: [], catLoaded: false };
    show("reader"); // show → renderMain → loadReader → loadChapter，高亮在渲染后生效
  } catch (e) { toast("跳转失败：" + e.message); }
}

// 「问这段」→ 把这段原文带进问一问（这本书模式），用户可改写成自己的问题
function askAboutBlock(chunkId) {
  const r = state.reader;
  const blk = r.blocks.find((x) => x.id === chunkId);
  if (!blk) { toast("找不到这段原文了"); return; }
  state.ask = { mode: "book", bookId: r.bookId, question: blk.text, loading: false, result: null, skillSlug: state.ask.skillSlug };
  show("ask");
  toast("已把这段原文带进问一问——可以改写成你的问题，或直接问");
}

// 「带去对话」（C2）→ 原文进对话页输入框草稿：用户改写成自己的问题，或直接回车发送。
// 与问一问同款语义（带进去=给人改的机会），不自动发问——对话是多轮上下文，自动发会污染 history
function askAboutBlockChat(chunkId) {
  const r = state.reader;
  const blk = r.blocks.find((x) => x.id === chunkId);
  if (!blk) { toast("找不到这段原文了"); return; }
  state.chat.draft = blk.text;
  show("chat");
  toast("已把这段原文带进对话——改写成你的问题，或直接回车发送");
}

// ---------- 事件绑定（boot() 里调用） ----------
export function bindReaderEvents() {
  $("#main").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const act = el.dataset.action;
    if (act === "chap") loadChapter(el.dataset.ch);
    else if (act === "theme") loadThemeBlocks(el.dataset.t);
    else if (act === "person") loadPersonBlocks(el.dataset.p);
    else if (act === "backchap") loadChapter(state.reader.chapter || state.reader.chapters[0]?.name);
    else if (act === "askthis") askAboutBlock(+el.dataset.bid);
    else if (act === "askthischat") askAboutBlockChat(+el.dataset.bid); // C2：带去对话
  });
}
