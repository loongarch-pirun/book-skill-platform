// 视图一：书架（拖书导入 / 书卡 / 导入任务状态）。
// 铁律：本模块顶层不做任何 DOM 访问——ESM 循环导入下 app.js 的绑定尚未初始化，
// 顶层碰 DOM 会 TDZ 崩掉整个渲染层（批 1 的暗雷，事件绑定统一走 bindShelfEvents()）。
import { $, state, call, toast, show, refresh } from "./app.js";
import { jumpTo } from "./views-reader.js";
import { shelfJobAction } from "./views-ask.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- ① 书架 ----------
export function renderShelf() {
  const books = state.books;
  return `
    <div class="view-title">书架</div>
    <div class="view-sub">${books.length} 本书 · 点卡片翻书 · 主题签来自编目数据</div>
    <div class="dropzone" id="dropzone"><b>把书拖到这里</b>（.epub / .docx / .pdf / .txt）<span class="soon">自动切片 → 向量化 → 生成编目任务书（编目结果可稍后导入）</span></div>
    <div class="shelf">${books.map((b) => bookCard(b)).join("") || '<div class="empty">书架空空如也——去拖本书进来</div>'}
    </div>`;
}

// 书卡片：导入中显示阶段横幅（jobs 状态），失败显示哪一步，待编目给恢复入口
function bookCard(b) {
  const job = state.jobs[b.id];
  let badge = "";
  if (job && !["done", "failed", "catalog", "cancelled"].includes(job.stage)) {
    badge = `<div class="jobstrip"><span class="jobstage">${esc(job.label || job.stage)}</span>${job.detail ? `<span class="jobdetail">${esc(job.detail)}</span>` : ""}
      <button class="ghost sm" data-action="jobcancel" data-bid="${esc(b.id)}">取消</button></div>`;
  } else if (job && job.stage === "failed") {
    badge = `<div class="jobstrip fail"><span class="jobstage">导入失败</span><span class="jobdetail">${esc(job.error || "未知原因")}</span>
      <button class="ghost sm" data-action="jobretry" data-bid="${esc(b.id)}">重试</button></div>`;
  } else if (job && job.stage === "catalog") {
    badge = `<div class="jobstrip wait"><span class="jobstage">待编目</span><span class="jobdetail">任务书已生成，等编目结果</span>
      <button class="ghost sm" data-action="catimport" data-bid="${esc(b.id)}">导入编目结果</button></div>`;
  }
  return `
    <div class="bookcard" data-action="open" data-bid="${esc(b.id)}">
      <h3>${esc(b.title)}</h3>
      <div class="bookmeta">${esc(b.format || "?")} · ${b.chapters ? b.chapters + " 章" : "未分章"} · ${b.chunks || 0} 块</div>
      <div class="tags">${b.catalog?.themes?.length ? b.catalog.themes.slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join("") : '<span class="tag nocat">未编目</span>'}</div>
      ${badge}
      <div class="cardfoot">
        <span class="skill-dot ${b.skillEnabled ? "" : "off"}">${b.skillEnabled ? "AI 可查" : "skill 已关"}</span>
        <button class="delbtn" data-action="del" data-bid="${esc(b.id)}">删除</button>
      </div>
    </div>`;
}

// ---------- 拖拽导入（接 jobs.mjs 真管线） ----------
async function importFile(filePath, name) {
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  if (!["epub", "docx", "pdf", "txt"].includes(ext)) { toast(`不支持 .${ext || "?"}（支持 .epub/.docx/.pdf/.txt）`); return; }
  try {
    await call(window.study.importBook(filePath));
  } catch (err) {
    toast("导入失败：" + err.message);
  } finally {
    state.books = await call(window.study.booksList());
    refresh();
  }
}

// ---------- 事件绑定（boot() 里调用，不趁模块加载） ----------
// 拖拽用 #main 委托（boot 时 #main 还是空的，dropzone 要等 renderMain 才存在；dragover/drop 冒泡）
export function bindShelfEvents() {
  const main = $("#main");
  main.addEventListener("dragover", (e) => {
    const dz = e.target.closest?.("#dropzone");
    if (!dz) return;
    e.preventDefault(); // 不 preventDefault 浏览器会直接打开文件而不是 drop
    dz.classList.add("over");
  });
  main.addEventListener("dragleave", (e) => {
    e.target.closest?.("#dropzone")?.classList.remove("over");
  });
  main.addEventListener("drop", (e) => {
    const dz = e.target.closest?.("#dropzone");
    if (!dz) return;
    e.preventDefault();
    dz.classList.remove("over");
    const f = e.dataTransfer.files?.[0];
    if (f) importFile(f.path, f.name);
  });
  main.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const act = el.dataset.action;
    if (act === "open") {
      state.reader = { bookId: el.dataset.bid, title: null, chapter: null, chapters: [], loadedChapter: null, highlightId: null, mode: "chapter", filter: null, themes: [], persons: [], blocks: [], catLoaded: false };
      show("reader");
    }
    else if (act === "del") {
      e.stopPropagation();
      if (!confirm(`删除《${el.dataset.bid}》的书库？\n只删书库文件，books/ 里的原始书保留，之后可以重新导入。`)) return;
      try {
        await call(window.study.deleteBook(el.dataset.bid));
        state.books = await call(window.study.booksList());
        refresh();
      } catch (err) { toast("删除失败：" + err.message); }
    }
    else if (act === "cite") jumpTo(el.dataset.bid, el.dataset.cid);
    else if (act === "jobcancel" || act === "jobretry" || act === "catimport") {
      e.stopPropagation();
      shelfJobAction(act, el.dataset.bid);
    }
  });
}
