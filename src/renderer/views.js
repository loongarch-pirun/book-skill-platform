// 四个视图的渲染与交互：书架 / 翻书 / 问一问 / 技能开关（占位）。
// 所有数据经 window.study.* IPC；事件用主区委托，避免重渲染后反复绑。
import { $, state, call, toast, show, refresh } from "./app.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- ① 书架 ----------
export function renderShelf() {
  const books = state.books;
  return `
    <div class="view-title">书架</div>
    <div class="view-sub">${books.length} 本书 · 点卡片翻书 · 主题签来自编目数据</div>
    <div class="dropzone"><b>把书拖到这里</b>（.epub / .docx / .pdf / .txt）<span class="soon">导入管线第二批上线；现在可先用命令行 node src/embed-all.js 灌书</span></div>
    <div class="shelf">${books.map((b) => `
      <div class="bookcard" data-action="open" data-bid="${esc(b.id)}">
        <h3>${esc(b.title)}</h3>
        <div class="bookmeta">${esc(b.format || "?")} · ${b.chapters ? b.chapters + " 章" : "未分章"} · ${b.chunks || 0} 块</div>
        <div class="tags">${b.catalog?.themes?.length ? b.catalog.themes.slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join("") : '<span class="tag nocat">未编目</span>'}</div>
        <div class="cardfoot">
          <span class="skill-dot ${b.skillEnabled ? "" : "off"}">${b.skillEnabled ? "AI 可查" : "skill 已关"}</span>
          <button class="delbtn" data-action="del" data-bid="${esc(b.id)}">删除</button>
        </div>
      </div>`).join("") || '<div class="empty">书架空空如也——去拖本书进来（导入管线第二批上线）</div>'}
    </div>`;
}

// ---------- ② 翻书 ----------
export function renderReader() {
  const r = state.reader;
  if (!r.bookId) return `<div class="view-title">翻书</div><div class="empty">先去书架点开一本书</div>`;
  return `
    <div class="view-title">${esc(r.title || r.bookId)}</div>
    <div class="view-sub">原文一字不改 · 引用跳转后高亮对应块</div>
    <div class="reader">
      <div class="chaplist" id="chapList"><div class="empty" style="padding:12px">目录加载中…</div></div>
      <div class="blocks" id="blockList"><div class="skeleton">原文加载中…</div></div>
    </div>`;
}

export async function loadReader() {
  const r = state.reader;
  if (state.view !== "reader" || !r.bookId) return;
  try {
    if (!r.chapters.length) {
      const c = await call(window.study.chapters(r.bookId));
      r.chapters = c.chapters;
      r.title = c.book;
      if (!r.chapter && c.chapters.length) r.chapter = c.chapters[0].name;
      $("#chapList").innerHTML = r.chapters.map((ch) =>
        `<div class="chapitem ${ch.name === r.chapter ? "active" : ""}" data-action="chap" data-ch="${esc(ch.name)}"><span>${esc(ch.name)}</span><span class="n">${ch.blocks} 块</span></div>`).join("")
        || '<div class="empty" style="padding:12px">（空书）</div>';
    }
    await loadChapter(r.chapter);
  } catch (e) { toast("翻书失败：" + e.message); }
}

async function loadChapter(ch) {
  const r = state.reader;
  if (!ch) return;
  r.chapter = ch;
  try {
    const b = await call(window.study.block(r.bookId, ch));
    $("#blockList").innerHTML = b.blocks.map((x) => `
      <div class="block ${x.id === r.highlightId ? "hl" : ""}" id="blk-${x.id}">
        <div class="loc">第 ${x.n} 块 / 共 ${b.blocks.length} 块${x.page ? " · 第 " + x.page + " 页" : ""}</div>
        <div class="text">${esc(x.text)}</div>
      </div>`).join("");
    $("#chapList")?.querySelectorAll(".chapitem").forEach((el) => el.classList.toggle("active", el.dataset.ch === ch));
    const hl = $("#blk-" + r.highlightId);
    if (hl) hl.scrollIntoView({ block: "center" });
    r.highlightId = null;
  } catch (e) { toast("读原文失败：" + e.message); }
}

// 引用徽标 → 反查章节 → 跳翻书并高亮（模块联动的闭环）
async function jumpTo(bookId, chunkId) {
  if (!bookId || chunkId == null || chunkId === "") { toast("这条结果没有可跳转的定位"); return; }
  try {
    const loc = await call(window.study.locate(bookId, chunkId));
    if (!loc.chapter) { toast("找不到这一块了（书可能被删过）"); return; }
    state.reader = { bookId, title: null, chapter: loc.chapter, chapters: [], highlightId: chunkId };
    show("reader"); // show → loadReader → loadChapter，高亮在渲染后生效
  } catch (e) { toast("跳转失败：" + e.message); }
}

// ---------- ③ 问一问 ----------
export function renderAsk() {
  const a = state.ask;
  const sel = a.mode === "book"
    ? `<select class="booksel" id="askBook">${state.books.map((b) => `<option value="${esc(b.id)}" ${b.id === a.bookId ? "selected" : ""}>${esc(b.title)}</option>`).join("")}</select>`
    : `<span class="chip">全库模式：引擎自动挑最相关的书</span>`;
  return `
    <div class="view-title">问一问</div>
    <div class="view-sub">答案带引用 · 点引用徽标跳回原文核对</div>
    <div class="askbox">
      <div class="moderow">
        <button class="modebtn ${a.mode === "book" ? "active" : ""}" data-action="mode" data-mode="book">问这本书</button>
        <button class="modebtn ${a.mode === "library" ? "active" : ""}" data-action="mode" data-mode="library">问全库</button>
        ${sel}
      </div>
      <div class="askinput">
        <textarea id="askQ" placeholder="输入问题，回车提交（Shift+回车换行）">${esc(a.question)}</textarea>
        <button class="primary" id="askGo" data-action="askgo" ${a.loading ? "disabled" : ""}>${a.loading ? "检索中…" : "问"}</button>
      </div>
    </div>
    <div id="askOut">${a.loading ? '<div class="skeleton">引擎检索中（平均约 3 秒，首次要先下模型）…</div>' : askResultHtml(a.result)}</div>`;
}

function askResultHtml(r) {
  if (!r) return '<div class="empty">选一本书（或切全库），输入问题开始</div>';
  const routed = r.mode === "library"
    ? `<div class="routed-note">引擎自动翻了 ${r.routed_books?.length || 0} 本书：${(r.routed_books || []).map((b) => esc(b.title)).join("、") || "（没有足够相关的书）"}</div>`
    : "";
  if (!r.results?.length) return routed + '<div class="empty">没有检索到相关内容</div>';
  return routed + `<div class="results">${r.results.map((x) => `
    <div class="result">
      <div class="rhead">
        <span class="rbook">${esc(x.book || "")}</span>
        <span class="cite" data-action="cite" data-bid="${esc(x.bookId || "")}" data-cid="${x.id ?? ""}">${esc(x.loc || "定位")} · 跳原文</span>
        <span class="rscore">${x.rerank != null ? "相关度 " + x.rerank.toFixed(3) : ""}</span>
      </div>
      <div class="rtext">${esc(x.text)}</div>
    </div>`).join("")}</div>`;
}

async function submitAsk() {
  const a = state.ask;
  const q = ($("#askQ")?.value || "").trim();
  if (!q) return;
  a.question = q;
  a.bookId = a.mode === "book" ? ($("#askBook")?.value || a.bookId) : null;
  a.loading = true;
  refresh();
  try {
    a.result = await call(window.study.ask({ bookId: a.bookId, question: q, topN: 4 }));
  } catch (e) { toast("检索失败：" + e.message); a.result = null; }
  a.loading = false;
  refresh();
}

// ---------- ④ 技能开关（第二批占位） ----------
export function renderSkills() {
  return `
    <div class="view-title">技能开关</div>
    <div class="view-sub">每本书的 MCP skill 开关 + 蒸馏技能包管理</div>
    <div class="placeholder"><b>第二批上线</b><br>开关状态已存进书库目录（skill-state.json），MCP 侧已生效；<br>桌面端的开关面板与技能包查看器随阶段 4 第二批一起到。</div>`;
}

// ---------- 事件委托（主区只绑一次） ----------
$("#main").addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const act = el.dataset.action;
  if (act === "open") { state.reader = { bookId: el.dataset.bid, title: null, chapter: null, chapters: [], highlightId: null }; show("reader"); }
  else if (act === "del") {
    e.stopPropagation();
    if (!confirm(`删除《${el.dataset.bid}》的书库？\n只删书库文件，books/ 里的原始书保留，之后可以重新导入。`)) return;
    try {
      await call(window.study.deleteBook(el.dataset.bid));
      state.books = await call(window.study.booksList());
      refresh();
    } catch (err) { toast("删除失败：" + err.message); }
  }
  else if (act === "mode") { state.ask.mode = el.dataset.mode; state.ask.result = null; refresh(); }
  else if (act === "askgo") submitAsk();
  else if (act === "cite") jumpTo(el.dataset.bid, el.dataset.cid);
  else if (act === "chap") loadChapter(el.dataset.ch);
});

$("#main").addEventListener("keydown", (e) => {
  if (e.target.id === "askQ" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitAsk(); }
});

// 顶栏全局搜索 → 切全库模式直接问
window.addEventListener("ask:submit", () => submitAsk());
