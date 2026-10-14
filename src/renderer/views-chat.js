// 视图五：对话（V2 P3）——多轮问答：本地检索找依据，云端写回答，引用点跳原文。
// 铁律同其它视图：顶层不碰 DOM（ESM 循环导入防 TDZ）；事件绑定走 bindChatEvents()；
// 对话历史放渲染层（主进程无状态），每次发送带上近几轮（净化在主进程边界做）。
import { $, state, call, refresh, show, RETRIEVE_TOPN } from "./app.js";
import { esc } from "./views.js";

// ---------- 渲染 ----------
export function renderChat() {
  const c = state.chat;
  const active = state.books.filter((b) => b.skillEnabled);
  const noBookGuide = '<span class="chip">没有可问的书</span><button class="ghost sm" data-action="goskills">去「技能开关」打开</button>';
  const sel = c.mode === "book"
    ? (active.length
        ? `<select class="booksel" id="chatBook">${active.map((b) => `<option value="${esc(b.id)}" ${b.id === c.bookId ? "selected" : ""}>${esc(b.title)}</option>`).join("")}</select>`
        : noBookGuide)
    : (active.length ? '<span class="chip">全库模式：引擎自动挑最相关的书</span>' : noBookGuide);
  const pkgs = state.skills.packages;
  const cfg = state.llm.config || {};
  return `
    <div class="view-title">对话</div>
    <div class="view-sub">多轮问答 · 本地检索找依据 · 云端写回答 · 引用点跳原文</div>
    <div class="chatwrap">
      <div class="moderow">
        <button class="modebtn ${c.mode === "book" ? "active" : ""}" data-action="chatmode" data-mode="book">问这本书</button>
        <button class="modebtn ${c.mode === "library" ? "active" : ""}" data-action="chatmode" data-mode="library">问全库</button>
        ${sel}
        ${pkgs.length ? `<label class="skillpick"><input type="checkbox" id="chatUseSkill" ${c.skillSlug ? "checked" : ""}> 用技能包</label>
          <select id="chatSkillSel" class="booksel">${pkgs.map((p) => `<option value="${esc(p.slug)}" ${p.slug === c.skillSlug ? "selected" : ""}>${esc(p.title)}</option>`).join("")}</select>` : ""}
        <span class="spacer"></span>
        <button class="ghost sm" data-action="chatclear">清空对话</button>
      </div>
      ${!cfg.hasKey ? '<div class="cloudrow"><span class="chip">云端 AI 未配置——对话需要一把 API key</span><button class="ghost sm" data-action="chatcfg">去「问一问」配置</button></div>' : ""}
      <div id="chatMsgs" class="chatmsgs">${chatMsgsHtml()}</div>
      <div class="chatinput">
        <textarea id="chatQ" placeholder="问吧——比如「什么是真正的强大？」（回车发送，Shift+回车换行）"></textarea>
        <button class="primary" id="chatGo" data-action="chatgo" ${c.loading ? "disabled" : ""}>${c.loading ? "思考中…" : "发送"}</button>
      </div>
    </div>`;
}

function chatMsgsHtml() {
  const c = state.chat;
  if (!c.messages.length) return '<div class="empty">开始聊吧——每一轮都会先从书里找到原文，再让云端 AI 基于原文回答（引用可点开核对）。</div>';
  const parts = c.messages.map(msgHtml);
  if (c.loading) parts.push('<div class="msg ai"><div class="bubble skeleton">正在检索书库并写作（约几秒）…</div></div>');
  return parts.join("");
}

function msgHtml(m) {
  if (m.role === "user") return `<div class="msg user"><div class="bubble">${esc(m.content)}</div></div>`;
  if (m.error) {
    const deg = (m.results || []).length
      ? `<div class="degfold"><button class="ghost sm" data-action="degtoggle">看本地检索到的 ${m.results.length} 段原文</button>
      <div class="deglist hidden">${m.results.map(degItemHtml).join("")}</div></div>`
      : "";
    return `<div class="msg ai"><div class="bubble err">${esc(m.error)}${deg}</div></div>`;
  }
  const cites = (m.citations || []).map((x) =>
    `<span class="cite" data-action="cite" data-bid="${esc(x.bookId || "")}" data-cid="${x.id ?? ""}">${esc(x.book || "")} · ${esc(x.loc || "定位")} · 跳原文</span>`).join("");
  const meta = m.segments ? `<div class="chatmeta">取材 ${m.segments} 段原文${m.book ? " · 《" + esc(m.book) + "》" : ""}${m.mode === "library" ? " · 全库模式" : ""}</div>` : "";
  return `<div class="msg ai"><div class="bubble">
    <div class="atext">${esc(m.content)}</div>
    ${meta}
    ${cites ? `<div class="cacites">${cites}</div>` : ""}
    ${m.dropped ? `<div class="dropwarn">${m.dropped} 条引用未通过核验已隐藏</div>` : ""}
  </div></div>`;
}

// 降级原文条目（A1）：与问一问结果卡同规格，引用徽标可跳原文核对
function degItemHtml(x) {
  return `<div class="degitem">
    <div class="deghead"><span class="degbook">${esc(x.book || "")}</span>
      <span class="cite" data-action="cite" data-bid="${esc(x.bookId || "")}" data-cid="${x.id ?? ""}">${esc(x.loc || "定位")} · 跳原文</span></div>
    <div class="degtext">${esc(x.text || "")}</div>
  </div>`;
}

// 渲染完滚到底部（由 app.js renderMain 在赋值 innerHTML 后调用）
export function scrollChatBottom() {
  const el = $("#chatMsgs");
  if (el && typeof el.scrollTop !== "undefined") el.scrollTop = el.scrollHeight;
}

// ---------- 发送（每轮：本地检索 → 云端写作 → 引用校验；历史带近 6 条） ----------
function buildHistory() {
  const out = [];
  for (const m of state.chat.messages.slice(-6)) {
    if (m.role === "user" && m.content) out.push({ role: "user", content: m.content });
    else if (m.role === "assistant" && !m.error && m.content) out.push({ role: "assistant", content: m.content });
  }
  return out;
}

async function sendChat() {
  const c = state.chat;
  if (c.loading) return;
  const q = ($("#chatQ")?.value || "").trim();
  if (!q) return;
  c.bookId = c.mode === "book" ? ($("#chatBook")?.value || c.bookId) : c.bookId;
  c.skillSlug = state.skills.packages.length && $("#chatUseSkill")?.checked ? ($("#chatSkillSel")?.value || null) : null;
  const history = buildHistory();
  c.messages.push({ role: "user", content: q });
  c.loading = true;
  refresh();
  try {
    const r = await call(window.study.chatSummary({
      bookId: c.mode === "book" ? c.bookId : null,
      question: q,
      topN: RETRIEVE_TOPN,
      skillSlug: c.skillSlug,
      history,
    }));
    if (r.degraded) c.messages.push({ role: "assistant", error: r.error, results: r.results || [] }); // A1：降级通道，错误消息携带本地原文
    else c.messages.push({ role: "assistant", content: r.answer, citations: r.citations || [], dropped: r.dropped || 0, segments: r.segments, book: r.book, mode: r.mode });
  } catch (e) {
    c.messages.push({ role: "assistant", error: e.message });
  }
  c.loading = false;
  refresh();
}

// ---------- 事件绑定（boot() 里调用） ----------
export function bindChatEvents() {
  $("#main").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const act = el.dataset.action;
    if (act === "chatmode") { state.chat.mode = el.dataset.mode; state.chat.skillSlug = null; refresh(); } // 切模式清技能包（B6）
    else if (act === "chatgo") sendChat();
    else if (act === "chatclear") { state.chat.messages = []; refresh(); }
    else if (act === "chatcfg") { state.llm.editing = true; show("ask"); } // 去问一页展开配置卡
    else if (act === "goskills") show("skills"); // 书全关时的引导（A2）
    else if (act === "degtoggle") { const box = el.closest(".degfold")?.querySelector(".deglist"); if (box) box.classList.toggle("hidden"); } // 折叠降级原文（A1）
  });
  $("#main").addEventListener("keydown", (e) => {
    if (e.target.id === "chatQ" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  // 换书同步 + 清技能包（B6）：同问一问页——技能包属于某一本书，切书即清，要参考就重新勾
  $("#main").addEventListener("change", (e) => {
    if (e.target.id === "chatBook") { state.chat.bookId = e.target.value; state.chat.skillSlug = null; refresh(); }
  });
}
