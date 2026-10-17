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
    <div class="view-sub">${books.length} 本书 · 点卡片翻书 · 主题签来自编目数据 · 「洗数据」给每块产前置/标签/摘要（走云端，检索永远在本机）</div>
    <div class="dropzone" id="dropzone"><b>把书拖到这里</b>（.epub / .docx / .pdf / .txt）<span class="soon">先放进书架看原件 → 点「开始加工」才切片/向量化/编目（编目结果可稍后导入）</span></div>
    ${promptBoxHTML()}
    <div class="shelf">${books.map((b) => bookCard(b)).join("") || '<div class="empty">书架空空如也——去拖本书进来</div>'}
    </div>`;
}

// 待编目「一键提示词」面板：生成后展开（只读文本域 + 复制/收起）
function promptBoxHTML() {
  const p = state.prompt;
  if (!p) return "";
  const book = state.books.find((b) => b.id === p.bookId);
  return `
    <div class="promptbox">
      <div class="prompthead"><b>《${esc(book?.title || p.bookId)}》的编目提示词</b>
        <span class="promptmeta">${p.chars} 字 · 已存 catalog-tasks/${esc(p.bookId)}.prompt.md</span></div>
      <textarea readonly rows="8" id="promptText">${esc(p.text)}</textarea>
      <div class="promptactions">
        <button class="ghost sm" data-action="promptcopy">复制提示词</button>
        <button class="ghost sm" data-action="promptclose">收起</button>
      </div>
    </div>`;
}

// 书卡片：导入中显示阶段横幅（jobs 状态），失败显示哪一步，待编目给恢复入口。
// raw（#165：仅入库未加工）显示「开始加工」入口（#167 第二段按钮）——洗数据要库，raw 没有。
// 洗数据任务（#140）汇进同一个 state.jobs——stage 名落在同一套分支里，kind 区分取消/重试按钮
function bookCard(b) {
  const job = state.jobs[b.id];
  const raw = b.status === "raw";
  const running = job && !["done", "failed", "catalog", "cancelled"].includes(job.stage);
  let badge = "";
  if (running) {
    badge = `<div class="jobstrip"><span class="jobstage">${esc(job.label || job.stage)}</span>${job.detail ? `<span class="jobdetail">${esc(job.detail)}</span>` : ""}
      <button class="ghost sm" data-action="${job.kind === "enrich" ? "enrichcancel" : "jobcancel"}" data-bid="${esc(b.id)}">取消</button></div>`;
  } else if (job && job.stage === "failed") {
    const isEnrich = job.kind === "enrich";
    badge = `<div class="jobstrip fail"><span class="jobstage">${esc(job.label || "失败")}</span><span class="jobdetail">${esc(job.error || "未知原因")}</span>
      <button class="ghost sm" data-action="${isEnrich ? "enrichretry" : "jobretry"}" data-bid="${esc(b.id)}">${isEnrich ? "重试洗数据" : "重试"}</button></div>`;
  } else if (job && job.stage === "catalog") {
    badge = `<div class="jobstrip wait"><span class="jobstage">待编目</span><span class="jobdetail">任务书已生成，等编目结果</span>
      <button class="ghost sm" data-action="catprompt" data-bid="${esc(b.id)}">生成提示词</button>
      <button class="ghost sm" data-action="catimport" data-bid="${esc(b.id)}">导入编目结果</button></div>`;
  }
  const meta = raw
    ? `<span class="rawtag">未加工</span> ${esc(b.format || "?")} 原件 · 点卡片看原文`
    : `${esc(b.format || "?")} · ${b.chapters ? b.chapters + " 章" : "未分章"} · ${b.chunks || 0} 块`;
  const tags = raw
    ? '<span class="tag nocat">未加工</span>'
    : `${b.catalog?.themes?.length ? b.catalog.themes.slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join("") : '<span class="tag nocat">未编目</span>'}${enrichTag(b)}`;
  // 删书两档按钮（V3 第四波 #168）：raw 书没有库可「移出」，只剩彻底删除；
  //   processed 书两档都在——移出书架=删库留原件（可重新加工），彻底删除=一体全删
  const delBtns = raw
    ? `<button class="delbtn" data-action="purge" data-bid="${esc(b.id)}">彻底删除</button>`
    : `<button class="ghost sm" data-action="del" data-bid="${esc(b.id)}">移出书架</button><button class="delbtn" data-action="purge" data-bid="${esc(b.id)}">彻底删除</button>`;
  return `
    <div class="bookcard" data-action="open" data-bid="${esc(b.id)}">
      <h3>${esc(b.title)}</h3>
      <div class="bookmeta">${meta}</div>
      <div class="tags">${tags}</div>
      ${badge}
      <div class="cardfoot">
        <span class="skill-dot ${b.skillEnabled ? "" : "off"}">${b.skillEnabled ? "AI 可查" : "skill 已关"}</span>
        <span class="cardbtns">${running ? "" : raw
          ? `<button class="ghost sm procbtn" data-action="process" data-bid="${esc(b.id)}">开始加工</button>`
          : `<button class="ghost sm" data-action="enrich" data-bid="${esc(b.id)}">洗数据</button>`}${delBtns}</span>
      </div>
    </div>`;
}

// 洗数据徽标（#140）：已洗→覆盖率+标签数（悬浮看三级摘要）；未洗→引导（没配 key 点了也有人话提示）
function enrichTag(b) {
  const e = b.enrich;
  if (!e || !e.ready) return '<span class="tag nocat">未洗数据</span>';
  const s = e.summaries || {};
  return `<span class="tag enr" title="标签 ${e.tags} 个 · 摘要 ${s.chunk || 0} 块 / ${s.chapter || 0} 章 / ${s.book ? 1 : 0} 全书">已洗 ${e.pct}% · 标签 ${e.tags}</span>`;
}

// ---------- 拖拽导入（V3 #167：第一段只放进书架，加工是第二步） ----------
async function importFile(filePath, name) {
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  if (!["epub", "docx", "pdf", "txt"].includes(ext)) { toast(`不支持 .${ext || "?"}（支持 .epub/.docx/.pdf/.txt）`); return; }
  try {
    const r = await call(window.study.importBook(filePath));
    // 两段式提示：不自动开跑加工——先看原文，用户自己决定什么时候烧算力
    if (r?.stage === "imported") toast("已放进书架——点卡片看原文，点「开始加工」才会切片/向量化/编目");
  } catch (err) {
    toast("导入失败：" + err.message);
  } finally {
    state.books = await call(window.study.booksList());
    refresh();
  }
}

// 剪贴板：优先 Clipboard API；打包 file:// 下若被拒，退回老式 execCommand（返回 false 由调用方提示）
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

// ---------- 事件绑定（boot() 里调用，不趁模块加载） ----------
// 拖拽：document 级拦截——不 preventDefault 的话浏览器会把拖入的文件当页面直接打开，
// 整个界面被顶掉；热区放宽为「书架页全页可落」（#dropzone 只负责高亮），
// 其它视图拖入给明确提示，不再静默无反应（G-03）
export function bindShelfEvents() {
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  const zone = () => document.querySelector("#dropzone"); // 只有书架页有
  document.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // 必须：否则浏览器把文件当页面导航打开
    zone()?.classList.add("over");
  });
  document.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) zone()?.classList.remove("over"); // 拖出窗口才清高亮（子元素间移动不清，防闪烁）
  });
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // 必须：拦住浏览器把文件当页面打开
    zone()?.classList.remove("over");
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    if (!zone()) { toast("先点左侧「书架」，再把书拖进来"); return; } // 其它视图：说清楚，不静默
    // G-02：Electron 32+ 已移除 File.path，直接读 f.path 恒为 undefined
    // （旧链路会把它一路带到主进程解析成 cwd，最后报出与真因不符的「不支持的格式 .?」）
    let fp = "";
    try { fp = window.study.filePathOf(f); } catch { /* 取不到就落下面的人话提示 */ }
    if (!fp) { toast("没拿到文件路径——请重试拖拽"); return; }
    importFile(fp, f.name);
  });
  const main = $("#main");
  main.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const act = el.dataset.action;
    if (act === "open") {
      state.reader = { bookId: el.dataset.bid, title: null, chapter: null, chapters: [], loadedChapter: null, highlightId: null, mode: "chapter", filter: null, themes: [], persons: [], blocks: [], catLoaded: false, original: null };
      show("reader");
    }
    else if (act === "del") {
      // 第一档「移出书架」（V3 #168）：删库留原件——书架回 raw 态，可重新加工
      e.stopPropagation();
      const b = state.books.find((x) => x.id === el.dataset.bid);
      if (!confirm(`将《${b?.title || el.dataset.bid}》移出书架？\n书库文件删除（块/向量/编目/洗数据全没了），books/ 原件保留，之后点「开始加工」可重建。`)) return;
      try {
        const r = await call(window.study.deleteBook(el.dataset.bid));
        state.books = await call(window.study.booksList());
        refresh();
        if (r?.note) toast(r.note); // P4：note 可能带"已连 N 条云端回答存档一起删除"（删书联动）
      } catch (err) { toast("移出书架失败：" + err.message); }
    }
    else if (act === "purge") {
      // 第二档「彻底删除」（V3 #168）：库 + books/ 原件 + 存档/反馈一体删，确认清单先行
      e.stopPropagation();
      const b = state.books.find((x) => x.id === el.dataset.bid);
      const lines = [`彻底删除《${b?.title || el.dataset.bid}》？以下内容全部删除、不可恢复：`];
      if (b && b.status !== "raw") lines.push("· 书库文件（块/向量/编目/洗数据）");
      lines.push(b?.asset?.exists
        ? `· books/ 原件（${b.format || "?"} 文件）`
        : "· books/ 原件（无——这本当初没复制原件，重建要重新导入文件）");
      lines.push("· 引用这本书的云端存档 / 反馈样本");
      if (!confirm(lines.join("\n"))) return;
      try {
        const r = await call(window.study.purgeBook(el.dataset.bid));
        state.books = await call(window.study.booksList());
        refresh();
        if (r?.note) toast(r.note);
      } catch (err) { toast("彻底删除失败：" + err.message); }
    }
    else if (act === "cite") jumpTo(el.dataset.bid, el.dataset.cid);
    else if (act === "jobcancel" || act === "jobretry" || act === "catimport" || act === "catprompt"
      || act === "enrich" || act === "enrichretry" || act === "enrichcancel"
      // V3 #167：raw 书「开始加工」——第二段管线入口（切片→向量化→编目任务书）
      || act === "process") {
      e.stopPropagation();
      shelfJobAction(act, el.dataset.bid);
    }
    else if (act === "promptcopy") {
      const ok = await copyText(state.prompt?.text || "");
      toast(ok ? "已复制——粘给任意 AI 对话框即可（输出 JSON 存到 catalog-results/）" : "复制失败——请手动全选文本框里的内容");
    }
    else if (act === "promptclose") { state.prompt = null; refresh(); }
  });
}
