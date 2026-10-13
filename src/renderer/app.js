// 渲染进程外壳：全局状态、导航、启动、首启向导、toast、IPC 包装。
// 四个视图的渲染分散在 views.js（书架）/ views-reader.js（翻书）/ views-ask.js（问一问+技能开关），
// 本文件只做"壳"。事件绑定由各视图模块的 bindXxxEvents() 在 boot() 里统一调用——
// 视图模块顶层绝不碰 DOM（ESM 循环导入下 app.js 的 const 绑定尚未初始化，会 TDZ 崩掉整个渲染层）。
import { renderShelf, bindShelfEvents } from "./views.js";
import { renderReader, loadReader, bindReaderEvents } from "./views-reader.js";
import { renderAsk, renderSkills, loadSkillsView, bindAskEvents } from "./views-ask.js";

export const $ = (s, r = document) => r.querySelector(s);
export const state = {
  view: "shelf",              // shelf | reader | ask | skills
  books: [],                  // booksList 全量（含关掉 skill 的）
  jobs: {},                   // 导入管线任务状态（bookId → {stage,label,detail,error}）
  prompt: null,               // 待编目一键提示词面板（书架）：{bookId, text, chars, path} | null
  reader: { bookId: null, title: null, chapter: null, chapters: [], loadedChapter: null, highlightId: null, mode: "chapter", filter: null, themes: [], persons: [], blocks: [], catLoaded: false },
  ask: { mode: "book", bookId: null, question: "", loading: false, result: null, skillSlug: null },
  skills: { packages: [], loaded: false, viewing: null, detail: null, chapter: null, chapterContent: null, busy: false },
  model: { ready: false, text: "模型加载中…" },
  config: null,
};

// IPC 包装：统一 {ok,data} → 抛错由调用方 toast
export async function call(p) {
  const r = await p;
  if (!r.ok) throw new Error(r.error?.message || "未知错误");
  return r.data;
}

let toastTimer = null;
export function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
}

export function show(view) {
  state.view = view;
  document.querySelectorAll(".navbtn").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  renderMain();
}

function renderMain() {
  const main = $("#main");
  if (state.view === "shelf") main.innerHTML = renderShelf();
  else if (state.view === "reader") { main.innerHTML = renderReader(); loadReader(); }
  else if (state.view === "ask") main.innerHTML = renderAsk();
  else { main.innerHTML = renderSkills(); loadSkillsView(); }
}

export function refresh() { renderMain(); }

// ---------- 首启向导（仅打包态无配置时出现） ----------
async function maybeWizard(cfg) {
  const el = $("#wizard");
  if (!cfg.firstRun) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.innerHTML = `
    <div class="wizard-card">
      <h2>欢迎使用我的书房</h2>
      <p>第一次打开。请选择书库位置：</p>
      <p>· <b>使用现有书库</b>：选一个有 .db 文件的文件夹（比如旧版项目里的 library）</p>
      <p>· <b>从空白开始</b>：以后往书架里拖书就行</p>
      <p style="font-size:12px">模型（约 700MB）会在第一次提问时自动下载。</p>
      <div class="wizard-btns">
        <button class="primary" id="wzPick">选择现有书库文件夹</button>
        <button class="ghost" id="wzBlank">从空白开始</button>
      </div>
    </div>`;
  $("#wzPick").onclick = async () => {
    const dir = await call(window.study.pickLibDir());
    if (!dir) return;
    await call(window.study.configSet({ libraryDir: dir }));
    location.reload();
  };
  $("#wzBlank").onclick = async () => {
    await call(window.study.configSet({}));
    location.reload();
  };
}

// ---------- 模型状态 chip ----------
function bindModelChip() {
  const chip = $("#modelChip");
  const paint = (text, cls) => { chip.textContent = text; chip.className = "chip" + (cls ? " " + cls : ""); };
  window.study.onModelProgress((e) => {
    if (e.status === "progress" && e.total) paint(`下载模型 ${Math.round((e.loaded / e.total) * 100)}%`);
    else if (e.status === "download" || e.status === "initiate") paint("正在准备模型…");
    else if (e.status === "done" || e.status === "ready") paint("模型已就绪", "ok");
  });
  window.study.onEngineReady(() => { state.model.ready = true; paint("模型已就绪", "ok"); $("#sideFoot").textContent = "模型已就绪 · 引擎直连"; });
  window.study.onEngineError((e) => paint("模型加载失败", "bad"));
  $("#sideFoot").textContent = "模型加载中…（首次约 700MB）";
}

// ---------- 导入管线进度：书架卡片横幅（阶段切换才刷书架列表，节流防抖） ----------
function bindJobsProgress() {
  let lastPaint = 0;
  window.study.onJobsProgress((e) => {
    if (!e || !e.bookId) return;
    const prev = state.jobs[e.bookId];
    const stageChanged = !prev || prev.stage !== e.stage;
    state.jobs = { ...state.jobs, [e.bookId]: e };
    if (state.view !== "shelf") return;
    const now = Date.now();
    if (stageChanged || now - lastPaint > 1500) {
      lastPaint = now;
      if (stageChanged) {
        call(window.study.booksList()).then((b) => { state.books = b; refresh(); }).catch(() => refresh());
      } else refresh();
    }
  });
}

// ---------- 启动 ----------
async function boot() {
  document.querySelectorAll(".navbtn").forEach(b => (b.onclick = () => show(b.dataset.view)));
  $("#globalSearch").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const q = e.target.value.trim();
    if (!q) return;
    state.ask = { mode: "library", bookId: null, question: q, loading: false, result: null, skillSlug: null };
    show("ask");
    window.dispatchEvent(new CustomEvent("ask:submit"));
  });
  bindModelChip();
  bindJobsProgress();
  bindShelfEvents();
  bindReaderEvents();
  bindAskEvents();
  try {
    state.config = await call(window.study.configGet());
    await maybeWizard(state.config);
    state.books = await call(window.study.booksList());
    // G-04：先让主进程重扫「待编目」（任务书在、结果不在的挂起 job），再拉状态快照——
    // 覆盖运行时换书库目录 / 主进程那次扫描事件早于页面注册监听而丢失的场景
    await call(window.study.jobsScanPending());
    state.jobs = await call(window.study.jobsStatus());
    state.skills.packages = await call(window.study.skillsList()); // 问一问的技能包选择器要用
  } catch (e) { toast("启动失败：" + e.message); }
  renderMain();
  window.__studyBooted = true; // 冒烟脚本的启动完成信号（test/desktop-smoke-main.js）
}

boot();
