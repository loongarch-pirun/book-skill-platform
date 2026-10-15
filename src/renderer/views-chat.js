// 视图五：对话（V2 P3）——多轮问答：本地检索找依据，云端写回答，引用点跳原文。
// 铁律同其它视图：顶层不碰 DOM（ESM 循环导入防 TDZ）；事件绑定走 bindChatEvents()；
// 对话历史放渲染层（主进程无状态），每次发送带上近几轮（净化在主进程边界做）。
import { $, state, call, toast, refresh, show, RETRIEVE_TOPN } from "./app.js";
import { cloudBarHtml } from "./views-ask.js"; // C5：云端状态条/配置卡与问一问共用一份实现
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
        <button class="ghost sm" data-action="archtoggle">${c.archive.open ? "收起存档" : c.archive.loaded ? `存档 ${c.archive.items.length}` : "存档"}</button>
        <button class="ghost sm" data-action="chatclear">清空对话</button>
      </div>
      ${c.archive.open ? archivePanelHtml() : ""}
      ${cloudBarHtml()}
      <div id="chatMsgs" class="chatmsgs">${chatMsgsHtml()}</div>
      <div class="chatinput">
        <textarea id="chatQ" placeholder="问吧——比如「什么是真正的强大？」（回车发送，Shift+回车换行）">${esc(c.draft)}</textarea>
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
  if (m.role === "note") return `<div class="chatmeta">${esc(m.content || "")}</div>`;
  if (m.error) {
    const deg = (m.results || []).length
      ? `<div class="degfold"><button class="ghost sm" data-action="degtoggle">看本地检索到的 ${m.results.length} 段原文</button>
      <div class="deglist hidden">${m.results.map(degItemHtml).join("")}</div></div>`
      : "";
    return `<div class="msg ai"><div class="bubble err">${esc(m.error)}${variantChipsHtml(m.rewrite)}${deg}</div></div>`;
  }
  const cites = (m.citations || []).map((x) =>
    `<span class="cite" data-action="cite" data-bid="${esc(x.bookId || "")}" data-cid="${x.id ?? ""}">${esc(x.book || "")} · ${esc(x.loc || "定位")} · 跳原文</span>`).join("");
  // V3-R7：引用为空 = 大概率书里没有——诚实标注而不是让用户猜
  const noHit = (m.citations || []).length === 0 ? ` · <span class="dropwarn">书里可能没有相关内容——换个问法试试</span>` : "";
  const meta = m.segments ? `<div class="chatmeta">取材 ${m.segments} 段原文${m.book ? " · 《" + esc(m.book) + "》" : ""}${m.mode === "library" ? " · 全库模式" : ""}${noHit}</div>` : "";
  return `<div class="msg ai"><div class="bubble">
    <div class="atext">${esc(m.content)}</div>
    ${meta}
    ${cites ? `<div class="cacites">${cites}</div>` : ""}
    ${variantChipsHtml(m.rewrite)}
    ${m.dropped ? `<div class="dropwarn">${m.dropped} 条引用未通过核验已隐藏</div>` : ""}
  </div></div>`;
}

// 改写变体 chips（V3-R1）：云端改写出的「书里可能的说法」——点按即以该问法重新提问
// 跳过第一条（原句就是用户刚问的）；挂在成功气泡与错误气泡下都出现
function variantChipsHtml(rw) {
  const vs = (rw && rw.used && Array.isArray(rw.variants) ? rw.variants : []).slice(1);
  if (!vs.length) return "";
  return `<div class="cacites"><span class="chip">换个问法试试：</span>${vs.map((v) =>
    `<button class="ghost sm" data-action="askchip" data-q="${esc(v)}">${esc(v)}</button>`).join("")}</div>`;
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

// ---------- 云端回答存档面板（P4）：快照新→旧，引用徽标走全局 cite → jumpTo ----------
function fmtTs(ts) {
  try { return new Date(ts).toLocaleString("zh-CN", { hour12: false }); } catch { return String(ts || ""); }
}

function archivePanelHtml() {
  const a = state.chat.archive;
  const head = `<div class="archhead">云端回答存档 · 新→旧<span class="spacer"></span>
    <button class="ghost sm" data-action="archclear">清空存档</button>
    <button class="ghost sm" data-action="archtoggle">收起</button></div>`;
  if (a.busy) return `<div class="archpanel"><div class="skeleton">存档读取中…</div></div>`;
  if (!a.items.length) return `<div class="archpanel">${head}<div class="empty">还没有存档——每有一条云端回答，这里就留一份：问题、依据片段、回答，引用可点回原文</div></div>`;
  const items = a.items.map((e) => `
    <div class="architem">
      <div class="archmeta">${esc(fmtTs(e.ts))} · ${e.mode === "library" ? "全库模式" : "《" + esc(e.book || "?") + "》"} · ${esc(e.model || "")}${e.dropped ? ` · ${e.dropped} 条引用未过核验已隐藏` : ""}</div>
      <div class="archq">问：${esc(e.question || "")}</div>
      <div class="archa">${esc(e.answer || "")}</div>
      ${(e.citations || []).length ? `<div class="cacites">${e.citations.map((x) => `<span class="cite" data-action="cite" data-bid="${esc(x.bookId || "")}" data-cid="${x.id ?? ""}">${esc(x.book || "")} · ${esc(x.loc || "定位")} · 跳原文</span>`).join("")}</div>` : ""}
    </div>`).join("");
  return `<div class="archpanel">${head}<div class="archlist">${items}</div></div>`;
}

// 首次打开拉一次（loaded 守卫防重复拨 IPC）；新回答入库后由 sendChat 重置 loaded 再拉
async function loadArchive() {
  const a = state.chat.archive;
  if (a.loaded || a.busy) return;
  a.busy = true;
  refresh();
  try {
    a.items = await call(window.study.chatArchiveList({ limit: 100 }));
    a.loaded = true;
  } catch (e) { toast("存档读取失败：" + e.message); }
  a.busy = false;
  refresh();
}

// ---------- 发送（每轮：本地检索 → 云端写作 → 引用校验；历史带近 12 条 + 滚动记忆 V3-R6） ----------
function buildHistory() {
  const out = [];
  for (const m of state.chat.messages.slice(-12)) {
    if (m.role === "user" && m.content) out.push({ role: "user", content: m.content });
    else if (m.role === "assistant" && !m.error && m.content) out.push({ role: "assistant", content: m.content });
  }
  return out;
}

// 滚动对话记忆（V3-R6）：历史变长自动把旧轮次压成 ≤200 字要点（主进程云端压缩），
// 存进 state.chat.memory 随每轮钉进上下文；显示列表同步折叠并留提示行。
// 压缩失败静默——对话继续，只是记忆没更新；BSP_MEMORY=0 时主进程优雅跳过。
function histOf(msgs) {
  return msgs
    .filter((m) => (m.role === "user" && m.content) || (m.role === "assistant" && !m.error && m.content))
    .map((m) => ({ role: m.role, content: m.content }));
}
async function maybeCompact() {
  const c = state.chat;
  if (c.memoryBusy) return;
  const usable = histOf(c.messages);
  if (usable.length < 14) return; // 7 轮起压
  c.memoryBusy = true;
  try {
    const old = usable.slice(0, usable.length - 6);
    const r = await call(window.study.chatCompact({ history: old, prevMemory: c.memory || "" }));
    if (r && r.ok && r.memory) {
      c.memory = r.memory;
      c.messages = c.messages.slice(-6);
      c.messages.unshift({ role: "note", content: "更早的对话已折叠为记忆（要点仍在本轮上下文里）" });
    }
  } catch { /* 静默：记忆失败不影响对话 */ }
  c.memoryBusy = false;
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
      memory: c.memory || "", // V3-R6：滚动对话记忆随轮携带
    }));
    if (r.degraded) c.messages.push({ role: "assistant", error: r.error, results: r.results || [], rewrite: r.rewrite }); // A1：降级通道，错误消息携带本地原文 + 换法建议
    else {
      c.messages.push({ role: "assistant", content: r.answer, citations: r.citations || [], dropped: r.dropped || 0, segments: r.segments, book: r.book, mode: r.mode, rewrite: r.rewrite });
      if (c.archive.open) { c.archive.loaded = false; loadArchive(); } // P4：存档面板开着，就地刷进新快照
      maybeCompact(); // V3-R6：异步不阻塞（压缩失败静默）
    }
  } catch (e) {
    c.messages.push({ role: "assistant", error: e.message });
  }
  c.loading = false;
  c.draft = ""; // 已发送：草稿随消息入列，输入框清空（C2 draft 生命周期）
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
    else if (act === "chatclear") { state.chat.messages = []; state.chat.memory = ""; refresh(); } // 清空连记忆一起清（V3-R6）
    else if (act === "askchip") { state.chat.draft = el.dataset.q || ""; refresh(); sendChat(); } // 换个问法 chips（V3-R1）
    // 云端配置（C5）：状态条/配置卡用 ask 页同款 cloudBarHtml，llmedit/llmsave/llmtest/llmclose
    // 处理器在 bindAskEvents（#main 监听全局存活）——这里不再需要跳页的 chatcfg
    else if (act === "goskills") show("skills"); // 书全关时的引导（A2）
    else if (act === "degtoggle") { const box = el.closest(".degfold")?.querySelector(".deglist"); if (box) box.classList.toggle("hidden"); } // 折叠降级原文（A1）
    // ---------- 云端回答存档（P4） ----------
    else if (act === "archtoggle") {
      state.chat.archive.open = !state.chat.archive.open;
      if (state.chat.archive.open) loadArchive(); // 开着就拉一次（loaded 守卫防重复）
      refresh();
    }
    else if (act === "archclear") {
      if (!confirm("清空全部云端回答存档？此操作不可恢复（书库和技能包不受影响）")) return;
      try {
        await call(window.study.chatArchiveClear());
        state.chat.archive.items = [];
        state.chat.archive.loaded = true;
        toast("存档已清空");
      } catch (e) { toast("清空失败：" + e.message); }
      refresh();
    }
  });
  $("#main").addEventListener("keydown", (e) => {
    if (e.target.id === "chatQ" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  // 换书同步 + 清技能包（B6）：同问一问页——技能包属于某一本书，切书即清，要参考就重新勾
  $("#main").addEventListener("change", (e) => {
    if (e.target.id === "chatBook") { state.chat.bookId = e.target.value; state.chat.skillSlug = null; refresh(); }
  });

  // 输入同步草稿（C2）：refresh 会按 draft 重画输入框——不实时回写的话，
  // 用户输到一半触发的任何重画都会把输入打回旧草稿（带去对话的原文就是这么进来的）
  $("#main").addEventListener("input", (e) => {
    if (e.target.id === "chatQ") state.chat.draft = e.target.value;
  });
}
