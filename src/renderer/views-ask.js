// 视图三/四：问一问（双模式 + 技能包参考 + 引用跳转）+ 技能开关（每本书开关 + 技能包查看器）。
// 铁律同 views.js：顶层不碰 DOM，事件绑定走 bindAskEvents()。
import { $, state, call, toast, refresh, show } from "./app.js";
import { esc } from "./views.js";

// ---------- ③ 问一问 ----------
export function renderAsk() {
  const a = state.ask;
  const active = state.books.filter((b) => b.skillEnabled); // 关掉 skill 的书不可问（H3 桌面路径）
  // 书全关时不只显示空下拉——给「去开书」按钮，指路技能开关页（A2，与对话页同款引导）
  const noBookGuide = '<span class="chip">没有可问的书</span><button class="ghost sm" data-action="goskills">去「技能开关」打开</button>';
  const sel = a.mode === "book"
    ? (active.length
        ? `<select class="booksel" id="askBook">${active.map((b) => `<option value="${esc(b.id)}" ${b.id === a.bookId ? "selected" : ""}>${esc(b.title)}</option>`).join("")}</select>`
        : noBookGuide)
    : (active.length ? `<span class="chip">全库模式：引擎自动挑最相关的书</span>` : noBookGuide);
  const pkgs = state.skills.packages;
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
      <div class="skillpickrow">
        <label class="skillpick"><input type="checkbox" id="useSkill" ${a.skillSlug ? "checked" : ""} ${pkgs.length ? "" : "disabled"}> 用技能包回答</label>
        ${pkgs.length
          ? `<select id="skillSel" class="booksel">${pkgs.map((p) => `<option value="${esc(p.slug)}" ${p.slug === a.skillSlug ? "selected" : ""}>${esc(p.title)}${p.coverage ? `（覆盖 ${esc(p.coverage)}）` : ""}</option>`).join("")}</select>
             <span class="chip">匹配章节随答案一起给，按需加载不占检索</span>`
          : '<span class="chip">（还没有技能包——去对话里让智能体落一个）</span>'}
      </div>
      ${cloudBarHtml()}
    </div>
    <div id="askOut">${a.loading ? '<div class="skeleton">引擎检索中（平均约 3 秒，首次要先下模型）…</div>' : askResultHtml(a.result)}</div>`;
}

function askResultHtml(r) {
  if (!r) return '<div class="empty">选一本书（或切全库），输入问题开始</div>';
  const routed = r.mode === "library"
    ? `<div class="routed-note">引擎自动翻了 ${r.routed_books?.length || 0} 本书：${(r.routed_books || []).map((b) => esc(b.title)).join("、") || "（没有足够相关的书）"}</div>`
    : "";
  const skill = r.skill ? skillCtxHtml(r.skill) : "";
  if (!r.results?.length) return routed + skill + '<div class="empty">没有检索到相关内容</div>';
  return routed + skill + cloudAnswerHtml(r) + `<div class="results">${r.results.map((x) => `
    <div class="result">
      <div class="rhead">
        <span class="rbook">${esc(x.book || "")}</span>
        <span class="cite" data-action="cite" data-bid="${esc(x.bookId || "")}" data-cid="${x.id ?? ""}">${esc(x.loc || "定位")} · 跳原文</span>
        <span class="rscore">${x.rerank != null ? "相关度 " + x.rerank.toFixed(3) : ""}</span>
      </div>
      <div class="rtext">${esc(x.text)}</div>
    </div>`).join("")}</div>`;
}

// 技能包参考区：匹配上的章节全文（按需加载的落地）；无匹配时明示，不装懂
function skillCtxHtml(s) {
  const head = `技能包《${esc(s.slug)}》参考${s.matched.length ? "" : "（没有匹配章节，以下按普通检索）"}`;
  const chapters = s.matched.map((m) => `
    <div class="sctxchap">
      <div class="sctxmeta"><b>${esc(m.title)}</b> · ${esc(m.file)} · 约 ${m.tokens_est} token · 匹配分 ${m.score}</div>
      <div class="sctxtext">${esc(m.content)}</div>
    </div>`).join("");
  return `<div class="skillctx"><div class="sctxhead">${head}</div>${chapters}</div>`;
}

// ---------- 云端问答（V2 P2）：状态条 / 配置卡 / 云端总结区 ----------
// 状态条：未配置→引导填 key；已配置→显示模型与 key 尾号（key 永不回显全文）
function cloudBarHtml() {
  const L = state.llm;
  const c = L.config || {};
  if (L.editing) {
    return `
      <div class="cloudcfg">
        <div class="cfgtitle">云端 AI 配置（OpenAI 兼容接口 · DeepSeek / 智谱 GLM 等通用）</div>
        <div class="cfgrow"><input id="llmBase" placeholder="接口地址，如 https://api.deepseek.com/v1" value="${esc(c.baseUrl || "")}"></div>
        <div class="cfgrow"><input id="llmModel" placeholder="模型名，如 deepseek-chat" value="${esc(c.model || "")}"></div>
        <div class="cfgrow"><input id="llmKey" type="password" placeholder="${c.hasKey ? "已存 key（尾号 " + esc(c.keyTail || "") + "），留空不改" : "API key（sk-…，仅保存在本机）"}"></div>
        <div class="cfgbtns">
          <button class="primary sm" data-action="llmsave">保存</button>
          <button class="ghost sm" data-action="llmtest">测试连接</button>
          <button class="ghost sm" data-action="llmclose">取消</button>
        </div>
        <div class="cfgwarn">检索永远在本机；发送给云端 AI 的只有「你的问题 + 这次检索到的原文片段」。</div>
        ${c.warning ? `<div class="cfgwarn">${esc(c.warning)}</div>` : ""}
      </div>`;
  }
  return `
    <div class="cloudrow">
      ${c.hasKey
        ? `<span class="chip ok">云端 AI 已就绪 · ${esc(c.model || "")} · 尾号 ${esc(c.keyTail || "")}</span>`
        : '<span class="chip">云端 AI 未配置——填一把 API key，就能让它基于原文写总结</span>'}
      <button class="ghost sm" data-action="llmedit">${c.hasKey ? "换配置" : "填 API key"}</button>
    </div>`;
}

// 云端总结区：按钮 → 写作中 → 回答（引用徽标跳原文，复用全局 cite 事件）
function cloudAnswerHtml(r) {
  const L = state.llm;
  const c = L.config || {};
  if (!c.hasKey) return ""; // 未配置不显示按钮（上方状态条有引导）
  if (L.error) return `
    <div class="cloudans errbox"><div class="clouderr">${esc(L.error)}</div>
      <div class="cfoot"><button class="ghost sm" data-action="clsummary">重新总结</button></div></div>`;
  if (L.loading) return `
    <div class="cloudans"><div class="cskel">云端 AI 正在写作（基于上面 ${r.results.length} 段原文，约几秒到半分钟）…</div></div>`;
  if (L.answer) {
    const a = L.answer;
    return `
      <div class="cloudans">
        <div class="chead">云端总结 · ${esc(c.model || "")}${a.book ? " · 取材《" + esc(a.book) + "》" : ""}${a.dropped ? ` · <span class="dropwarn">${a.dropped} 条引用未通过核验已隐藏</span>` : ""}</div>
        <div class="catext">${esc(a.answer)}</div>
        ${a.citations?.length ? `<div class="cacites">${a.citations.map((x) => `<span class="cite" data-action="cite" data-bid="${esc(x.bookId || "")}" data-cid="${x.id ?? ""}">${esc(x.book)} · ${esc(x.loc || "定位")} · 跳原文</span>`).join("")}</div>` : ""}
        <div class="cfoot"><button class="ghost sm" data-action="clsummary">重新总结</button></div>
      </div>`;
  }
  return `
    <div class="cloudans">
      <button class="primary sm" data-action="clsummary">让云端 AI 总结这次检索</button>
      <span class="chip">基于以上 ${r.results.length} 段原文写作 · 引用可回源</span>
    </div>`;
}

async function submitAsk() {
  const a = state.ask;
  const q = ($("#askQ")?.value || "").trim();
  if (!q) return;
  state.llm.answer = null; state.llm.error = null; // 新问题：上一次的云端总结/错误失效，清掉
  a.question = q;
  a.bookId = a.mode === "book" ? ($("#askBook")?.value || a.bookId) : null;
  a.skillSlug = $("#useSkill")?.checked ? ($("#skillSel")?.value || null) : null;
  a.loading = true;
  refresh();
  try {
    a.result = await call(window.study.ask({ bookId: a.bookId, question: q, topN: 4, skillSlug: a.skillSlug }));
  } catch (e) { toast("检索失败：" + e.message); a.result = null; }
  a.loading = false;
  refresh();
}

// ---------- ④ 技能开关 ----------
export function renderSkills() {
  const s = state.skills;
  if (s.viewing) return skillViewer(s);
  return `
    <div class="view-title">技能开关</div>
    <div class="view-sub">上区：每本书给 AI 用的 skill 开关（桌面与 MCP 同吃一份状态）· 下区：蒸馏技能包</div>
    <div class="panel">
      <div class="panel-head">每本书的 skill 开关</div>
      ${state.books.map((b) => `
        <div class="togglerow">
          <span class="tt">${esc(b.title)}</span>
          <span class="td">${b.chunks || 0} 块${b.catalog?.cataloged ? " · 已编目" : ""}</span>
          <button class="switch ${b.skillEnabled ? "on" : ""}" data-action="toggleskill" data-bid="${esc(b.id)}">${b.skillEnabled ? "AI 可查" : "已关"}</button>
        </div>`).join("") || '<div class="empty">书架为空</div>'}
      <div class="panel-note">关掉后：桌面问不到、MCP 的 query_book / query_library 也查不到这本书；已落盘的技能包引用回源验证不受影响（内部显式豁免）。</div>
    </div>
    <div class="panel">
      <div class="panel-head">蒸馏技能包（skills/ 目录）</div>
      <div class="pkgrid">${s.packages.map((p) => `
        <div class="pkgcard">
          <h4>${esc(p.title)}</h4>
          <div class="pkdesc">${esc(p.description || "")}</div>
          <div class="pkmeta">${p.coverage ? `覆盖 <b>${esc(p.coverage)}</b> 章` : "覆盖未声明"} · ${p.chapters} 个章节文件 · 来源：${esc((p.sources || []).join("、") || "?")}</div>
          <div class="pkfoot"><button class="ghost sm" data-action="viewskill" data-slug="${esc(p.slug)}">查看</button></div>
        </div>`).join("") || '<div class="empty">还没有技能包——对话里让智能体用 save_skill 落一个</div>'}
      </div>
    </div>`;
}

// 技能包查看器：SKILL.md 原文 + 章节索引 → 点章节按需加载全文
function skillViewer(s) {
  const d = s.detail;
  if (!d) return `<div class="view-title">技能包</div><div class="skeleton">加载中…</div>`;
  return `
    <div class="view-title">技能包《${esc(d.slug)}》</div>
    <div class="view-sub"><button class="ghost sm" data-action="backskills">← 返回技能开关</button></div>
    <div class="panel">
      <div class="panel-head">SKILL.md（主索引 · 常驻约 1.5K token）</div>
      <div class="skillmd">${esc(d.skill_md)}</div>
    </div>
    <div class="panel">
      <div class="panel-head">章节索引（按需加载，不读不占上下文）</div>
      ${(d.index || []).map((c) => `
        <div class="chapidx ${s.chapter === c.file ? "active" : ""}" data-action="viewchapter" data-file="${esc(c.file)}">
          <span>${esc(c.title)}</span><span class="n">${esc(c.file)} · 约 ${c.tokens_est} token</span>
        </div>`).join("") || '<div class="empty">（没有章节文件）</div>'}
      ${s.chapterContent ? `<div class="panel-head" style="margin-top:12px">${esc(s.chapter)}</div><div class="skillmd">${esc(s.chapterContent)}</div>` : ""}
    </div>`;
}

// 进技能视图时拉一次包列表（loaded 守卫防 renderMain→loadSkillsView→refresh 循环）
export async function loadSkillsView() {
  const s = state.skills;
  if (s.loaded || s.busy) return;
  s.busy = true;
  try {
    s.packages = await call(window.study.skillsList());
    s.loaded = true;
  } catch (e) { toast("技能包列表加载失败：" + e.message); }
  s.busy = false;
  refresh();
}

// ---------- 书架任务条动作（取消 / 重试 / 导入编目结果） ----------
export async function shelfJobAction(act, bookId) {
  try {
    if (act === "jobcancel") {
      const r = await call(window.study.jobsCancel(bookId));
      toast(r.cancelled ? (r.note || "已取消") : "没有进行中的导入");
    } else if (act === "jobretry") {
      const job = state.jobs[bookId];
      if (!job?.filePath) { toast("找不到原始文件路径，请重新把书拖进书架"); return; }
      await call(window.study.importBook(job.filePath));
    } else if (act === "catprompt") {
      const r = await call(window.study.jobsCatalogPrompt(bookId));
      state.prompt = { bookId, text: r.text, chars: r.chars, path: r.path };
      toast(`提示词已生成（${r.chars} 字）——复制后粘给任意 AI，结果存回 catalog-results/`);
    } else if (act === "catimport") {
      const picked = await call(window.study.jobsPickResult());
      await call(window.study.jobsResumeCatalog(bookId, picked));
      toast("编目入库完成");
    }
  } catch (e) { toast(e.message); }
  finally {
    state.books = await call(window.study.booksList());
    state.jobs = await call(window.study.jobsStatus());
    refresh();
  }
}

// ---------- 事件绑定（boot() 里调用） ----------
export function bindAskEvents() {
  $("#main").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const act = el.dataset.action;
    if (act === "mode") { state.ask.mode = el.dataset.mode; state.ask.result = null; refresh(); }
    else if (act === "askgo") submitAsk();
    // ---------- 云端问答（V2 P2） ----------
    else if (act === "goskills") show("skills"); // 书全关引导（A2）
    else if (act === "llmedit") { state.llm.editing = true; refresh(); }
    else if (act === "llmclose") { state.llm.editing = false; refresh(); }
    else if (act === "llmsave") {
      const baseUrl = $("#llmBase")?.value.trim() || undefined;
      const model = $("#llmModel")?.value.trim() || undefined;
      const apiKey = $("#llmKey")?.value.trim() || undefined;
      try {
        const cfg = await call(window.study.llmConfigSet({ baseUrl, model, apiKey }));
        state.llm.config = cfg;
        state.llm.editing = false;
        state.llm.error = null;
        toast("云端 AI 配置已保存" + (cfg.keyTail ? `（key 尾号 ${cfg.keyTail}）` : ""));
      } catch (err) { toast("保存失败：" + err.message); }
      refresh();
    }
    else if (act === "llmtest") {
      toast("正在测试连接…");
      try {
        const r = await call(window.study.llmTest());
        toast(`连接成功——模型回复「${r.reply}」`);
      } catch (err) { toast("连接失败：" + err.message); }
    }
    else if (act === "clsummary") {
      const q = (state.ask.question || "").trim();
      if (!state.ask.result || !q) { toast("先提问检索一次，再让云端总结"); return; }
      state.llm.loading = true;
      state.llm.answer = null;
      refresh();
      try {
        const r = await call(window.study.chatSummary({
          bookId: state.ask.mode === "book" ? state.ask.bookId : null,
          question: q,
          topN: 6,
          skillSlug: state.ask.skillSlug,
        }));
        state.llm.answer = r;
        state.llm.error = null;
      } catch (err) { state.llm.error = err.message; } // A3：云端错误进内嵌条（持久可见 + 重试入口），不再 toast 一闪而过
      state.llm.loading = false;
      refresh();
    }
    else if (act === "toggleskill") {
      const b = state.books.find((x) => x.id === el.dataset.bid);
      if (!b) return;
      try {
        await call(window.study.skillToggle(b.id, !b.skillEnabled));
        b.skillEnabled = !b.skillEnabled;
        refresh();
        toast(b.skillEnabled ? `《${b.title}》的 skill 已打开` : `《${b.title}》的 skill 已关——桌面和 MCP 都查不到它了`);
      } catch (err) { toast("开关失败：" + err.message); }
    }
    else if (act === "viewskill") {
      state.skills.viewing = el.dataset.slug;
      state.skills.detail = null;
      state.skills.chapter = null;
      state.skills.chapterContent = null;
      refresh();
      try {
        state.skills.detail = await call(window.study.skillRead(el.dataset.slug));
      } catch (err) { toast("读取技能包失败：" + err.message); }
      refresh();
    }
    else if (act === "viewchapter") {
      const s = state.skills;
      s.chapter = el.dataset.file;
      s.chapterContent = null;
      refresh();
      try {
        const r = await call(window.study.skillRead(s.viewing, s.chapter));
        s.chapterContent = r.content;
      } catch (err) { toast("读取章节失败：" + err.message); }
      refresh();
    }
    else if (act === "backskills") {
      state.skills.viewing = null;
      state.skills.detail = null;
      state.skills.chapter = null;
      state.skills.chapterContent = null;
      refresh();
    }
  });

  $("#main").addEventListener("keydown", (e) => {
    if (e.target.id === "askQ" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitAsk(); }
  });

  // 顶栏全局搜索 → 切全库模式直接问
  window.addEventListener("ask:submit", () => submitAsk());
}
