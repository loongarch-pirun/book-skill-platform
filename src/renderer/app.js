// 渲染进程外壳：全局状态、导航、启动、首启向导、toast、IPC 包装。
// 五个视图的渲染分散在 views.js（书架）/ views-reader.js（翻书）/ views-ask.js（问一问+技能开关）/ views-chat.js（对话），
// 本文件只做"壳"。事件绑定由各视图模块的 bindXxxEvents() 在 boot() 里统一调用——
// 视图模块顶层绝不碰 DOM（ESM 循环导入下 app.js 的 const 绑定尚未初始化，会 TDZ 崩掉整个渲染层）。
import { renderShelf, bindShelfEvents } from "./views.js";
import { renderReader, loadReader, bindReaderEvents } from "./views-reader.js";
import { renderAsk, renderSkills, loadSkillsView, bindAskEvents } from "./views-ask.js";
import { renderChat, scrollChatBottom, bindChatEvents } from "./views-chat.js";

export const $ = (s, r = document) => r.querySelector(s);
export const state = {
  view: "shelf",              // shelf | reader | ask | chat | skills
  books: [],                  // booksList 全量（含关掉 skill 的）
  jobs: {},                   // 导入管线任务状态（bookId → {stage,label,detail,error}）
  prompt: null,               // 待编目一键提示词面板（书架）：{bookId, text, chars, path} | null
  reader: { bookId: null, title: null, chapter: null, chapters: [], loadedChapter: null, highlightId: null, mode: "chapter", filter: null, themes: [], persons: [], blocks: [], catLoaded: false },
  ask: { mode: "book", bookId: null, question: "", loading: false, result: null, skillSlug: null },
  llm: { config: null, answer: null, error: null, loading: false, editing: false }, // 云端问答（V2 P2）：配置/回答/错误/状态
  chat: { mode: "book", bookId: null, skillSlug: null, draft: "", messages: [], loading: false, memory: "", memoryBusy: false, archive: { open: false, items: [], loaded: false, busy: false } }, // 对话窗口（V2 P3）+ 输入草稿（C2）+ 存档面板（P4）+ 滚动对话记忆（V3-R6：memory=旧轮次要点，memoryBusy=压缩防重入）
  skills: { packages: [], loaded: false, viewing: null, detail: null, chapter: null, chapterContent: null, busy: false },
  model: { ready: false, text: "模型加载中…" },
  config: null,
};

// 检索段数三处共用（B1 对齐）：问一问本地检索 / 问一问云端总结 / 对话窗口——
// 同一个问题，两页喂给云端、展示给用户的都是同样段数，答案质量可比；
// 后端 chat.mjs 的 topN 默认值同为 6（兜底，IPC 契约不变）
export const RETRIEVE_TOPN = 6;

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
  else if (state.view === "chat") { main.innerHTML = renderChat(); scrollChatBottom(); }
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

// ---------- 云端 AI 状态 chip（C4）：与 modelChip 并列，书架/翻书时也看得见 ----------
// 只回显模型名与 key 尾号（llm-config 的红线）；点击 → 跳问一问并展开配置卡
export function paintCloudChip() {
  const chip = $("#cloudChip");
  if (!chip) return; // 冒烟测试环境无顶栏 DOM，静默跳过
  const c = state.llm.config || {};
  if (c.hasKey) {
    chip.textContent = `云端 AI 已就绪 · ${c.model || ""} · 尾号 ${c.keyTail || ""}`;
    chip.className = "chip ok";
  } else {
    chip.textContent = "云端 AI 未配置";
    chip.className = "chip";
  }
}

function bindCloudChip() {
  $("#cloudChip")?.addEventListener("click", () => {
    state.llm.editing = true; // show → renderMain → cloudBarHtml 读 editing 展开配置卡
    show("ask");
  });
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
  bindCloudChip();
  bindJobsProgress();
  bindShelfEvents();
  bindReaderEvents();
  bindAskEvents();
  bindChatEvents();
  try {
    state.config = await call(window.study.configGet());
    await maybeWizard(state.config);
    state.books = await call(window.study.booksList());
    // G-04：先让主进程重扫「待编目」（任务书在、结果不在的挂起 job），再拉状态快照——
    // 覆盖运行时换书库目录 / 主进程那次扫描事件早于页面注册监听而丢失的场景
    await call(window.study.jobsScanPending());
    state.jobs = await call(window.study.jobsStatus());
    state.skills.packages = await call(window.study.skillsList()); // 问一问的技能包选择器要用
    state.llm.config = await call(window.study.llmConfigGet()); // 云端问答（P2）：配置状态（不含明文 key）
    paintCloudChip(); // C4：顶栏云端 chip 就位（未配置态也要显示，点击可去配）
  } catch (e) { toast("启动失败：" + e.message); }
  renderMain();
  window.__studyBooted = true; // 冒烟脚本的启动完成信号（test/desktop-smoke-main.js）
}

boot();
