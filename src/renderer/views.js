// 视图一：书架（拖书导入 / 书卡 / 导入任务状态）。
// 铁律：本模块顶层不做任何 DOM 访问——ESM 循环导入下 app.js 的绑定尚未初始化，
// 顶层碰 DOM 会 TDZ 崩掉整个渲染层（批 1 的暗雷，事件绑定统一走 bindShelfEvents()）。
import { $, state, call, toast, show, refresh } from "./app.js";
import { jumpTo } from "./views-reader.js";
import { shelfJobAction } from "./views-ask.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 引用徽标（问一问 results/云端 citations + 对话三处共用一份实现）：
// data-cid 来自检索结果 id（书库内容/云端引用，可含引号），是属性注入面（C30）——
// 单点定义让「漏一处 esc」从结构上不可能，也让探针只测一个入口（评审对抗官 F7-F2/O14）
export const renderCite = (x, withBook = true) => {
  // P3-②：有章节层级路径优先展示（「卷 › 章 › 节」比扁平章名更能定位）；老库/无路径书回退 loc
  const where = x.chapterPath || x.loc || "定位";
  const label = withBook
    ? `${esc(x.book || "")} · ${esc(where)} · 跳原文`
    : `${esc(where)} · 跳原文`;
  return `<span class="cite" data-action="cite" data-bid="${esc(x.bookId || "")}" data-cid="${esc(x.id ?? "")}">${label}</span>`;
};

// ===== 第 2 轮 · 四视图共用状态条（纯函数，顶层不碰 DOM：ESM 循环导入防 TDZ） =====
// 4.1 云端模式醒目提示：只消费 state.llm.config.hasKey（llmConfigGet 现有返回字段），零新 IPC。
// 措辞硬避「云端 AI 配置」六字——renderer-graph-test.mjs:331/:370 在配置卡收起态断言该串不出现。
// 出网范围写全：提问/引用片段之外，加工书（洗数据 clean.mjs、编目 enrich.mjs）发的是整块原文
// （src/lib/clean.mjs:165-174 拼【本批待判】、src/lib/enrich.mjs:184-188 拼 [idx]…\n${text}），
// 量级比「引用片段」大一个数量级——用户有权在开之前就知道。
export function cloudBannerHtml() {
  const on = !!(state.llm?.config?.hasKey);
  return on
    ? `<div class="cloudbanner on"><span class="cbtag">云端模式已开启</span><span>检索<b>始终在本机</b>；会外发的是：提问、引用片段，以及<b>加工书（洗数据 / 编目）时的书内段落</b>——都发给第三方 AI。</span></div>`
    : `<div class="cloudbanner off"><span class="cbtag">本地模式</span><span>书与检索<b>不出本机</b>；当前未接云端 AI，不会有任何内容外发。<b>配好 key 后，加工书（洗数据 / 编目）会把书内段落发出去</b>——再决定要不要配。</span></div>`;
}

// 4.2 英文书语言提示与示例问句：逐书语言取 b.lang（IF-1）。
// 实况（CP3 复核 B6，已由 A 线闭环）：`feat/round2-logic` 的 `54eb504` 打通 lang——
// 编目收尾 jobs.mjs 落 meta.lang，listBooks 读回（旧库无键时现场 detectLang 抽样估、不写库），
// engine.mjs `{ ...b }` 自动带出。本分支 `feat/round2-ui` 尚未含该提交，**合流后**下面
// en/zh 两个精确分支即达；界面无需再改。仅当书没有语言信息（旧库抽样失败 / 书列表未加载）
// 才落到中英双语兜底——绝不按书名猜语言、不新增 IPC。
export function langHintHtml(bookId) {
  const b = bookId ? state.books?.find((x) => x.id === bookId) : null;
  const zhQ = "什么是真正的强大？", enQ = "What is true strength?";
  if (b?.lang === "en") return `<div class="langhint"><b>这本是英文原版</b>：请用英文提问，中文提问可能检不到原文。示例问句：<span class="qe">${enQ}</span></div>`;
  if (b?.lang === "zh") return `<div class="langhint"><b>这本是中文书</b>：用中文提问即可。示例问句：<span class="qe">${zhQ}</span></div>`;
  return `<div class="langhint">读英文书请用<b>英文</b>提问（中文提问可能检不到原文）；中文书用中文问。示例：<span class="qe">${zhQ}</span><span class="qe">${enQ}</span></div>`;
}

// 4.6 有无原件标记：只读 book asset.exists（现有 booksList 返回字段，IF-2 无需新 IPC）；
// 无原件标「库内文本浏览」，不冒充「翻原书」。
// b 为空 = 不知道（书列表没加载完 / 从 chat 直接跳进 reader），不能谎称「无原件」。
export function origFlagHtml(b) {
  if (!b) return "";
  return b?.asset?.exists
    ? `<span class="origflag has" title="books/ 目录里有原始文件，可看原件视图">有原件 · 可看原书</span>`
    : `<span class="origflag" title="没有原始文件，只能看库里切好的原文块">无原件 · 库内文本浏览</span>`;
}

// 4.2 书卡语言标记（IF-1 提供 b.lang；缺字段时不标，绝不按书名猜）
export function bookLangHtml(b) {
  if (b?.lang === "en") return `<span class="booklang en" title="英文书请用英文提问">EN · 英文书</span>`;
  if (b?.lang === "zh") return `<span class="booklang" title="中文书用中文提问即可">ZH · 中文书</span>`;
  return "";
}

// 4.5 四视图「引文 / 回验」状态标签：统一口径，点引用徽标跳原文逐字核对。
export function verifyFlagHtml(mode = "on") {
  const map = {
    on: ["引文可回验", "点引用徽标跳原文逐字核对"],
    pending: ["回验待确认", "命中原文块后可逐字核对"],
    off: ["纯浏览", "本视图不产生引文"],
  };
  const [label, tip] = map[mode] || map.on;
  return `<span class="verifyflag ${mode}" title="${esc(tip)}"><span class="dot"></span>${label}</span>`;
}

// ---------- ① 书架 ----------
export function renderShelf() {
  const books = state.books;
  // 4.4 / 4.7：书架首屏只留「选书 + 导入」——用户眼睛看到的这一屏不带运维/MCP/闸机字样。
  // 运维提示词与用量治理收进默认折叠的 details（内容仍渲染在 Dom 里，需要时点开就能用）；
  // 展开态记在 state.shelfFoldOpen——refresh 会整块重建 innerHTML，不记在外面的话，
  // 用户展开后点里面任意一个开关（它触发 refresh）就会立刻弹回收起，看着像「点了没反应」。
  const ops = `${promptBoxHTML()}${usagePanelHTML()}`;
  const settings = ops.trim()
    ? `<details class="settings-fold"${state.shelfFoldOpen ? " open" : ""}><summary data-action="foldtoggle">设置 · 运维 / 技能 / 对外服务（MCP）</summary><div class="foldbody">${ops}</div></details>`
    : "";
  return `
    <div class="viewhead"><div class="view-title">书架</div>${verifyFlagHtml("off")}</div>
    <div class="view-sub">${books.length} 本书 · 点卡片翻书 · 主题签来自编目数据 · 每本书可生成前置/标签/摘要（可选云端，检索始终在本机）</div>
    ${cloudBannerHtml()}
    ${enrichExportBoxHTML()}
    <div class="dropzone" id="dropzone"><b>把书拖到这里</b>（.epub / .docx / .pdf / .txt）<span class="soon">先放进书架看原件 → 点「开始加工」才切片/向量化/编目（编目结果可稍后导入）</span></div>
    <div class="shelf">${books.map((b) => bookCard(b)).join("") || '<div class="empty">书架空空如也——去拖本书进来</div>'}
    </div>
    ${settings}`;
}

// 对外服务用量面板（W1 治理，2026-10-21）：开关/定时/预算写 usage-policy.json
// （与 skill-state.json 同目录同模式），MCP 闸机读同一份——桌面写、外部智能体守。
// 文案口径（CP3 复核后对齐 A 线 usage-policy.mjs:113）：计数器是**进程级**——
// MCP stdio 一个进程 = 一个智能体会话，桌面长进程同一份计数器、重启清零。
// 故写「本进程会话」，不写「本会话」（后者会被误读成聊天窗口开着的这段时间）。
function usagePanelHTML() {
  const u = state.usage;
  if (!u) return "";
  const { policy, usage, session, open } = u;
  const on = policy.enabled !== false;
  const sch = policy.schedule || {};
  const win = (sch.workdays || []).join(" / ") || "未设置";
  const budget = policy.budget || {};
  const fmtK = (n) => (n || 0) >= 10000 ? (n / 1000).toFixed(1) + "K" : String(n || 0);
  return `
    <div class="usagebox">
      <div class="prompthead"><b>知识库对外服务</b>
        <span class="promptmeta">管外部智能体（MCP）能调动多少——你自己用不受影响</span></div>
      <div class="usagerow">
        <span class="skill-dot ${on && open ? "" : "off"}">${on && open ? "开放中" : on ? "定时关闭中" : "已手动关闭"}</span>
        <button class="ghost sm" data-action="usagetoggle">${on ? "关闭" : "打开"}</button>
      </div>
      <div class="usagemeta">定时：工作日 ${esc(win)}${sch.weekend ? " · 周末也开" : " · 周末关"} · 预算：每进程会话 ${esc(String(budget.perSessionQueries ?? 30))} 次 / ${fmtK(budget.perSessionChars ?? 200000)} 字符</div>
      <div class="usagemeta">今日：调用 ${usage.calls} 次 · 返回 ${fmtK(usage.chars)} 字符 · 拒收 ${usage.rejected} 次 ｜ 本进程会话：${session.calls} 次 · ${fmtK(session.chars)} 字符</div>
      <div class="usagehint">关闭后外部智能体的检索/翻书会被拒并收到提示；书架清单、编目浏览和引文回验永远可用（不吃预算）。</div>
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

// 洗数据外部智能体路：导出任务书后的操作说明面板（只读 + 复制说明/打开文件夹/收起）。
// 复用编目提示词面板的 .promptbox 样式；渲染在书架可见区（cloudBanner 之后），导出即见路径。
function enrichExportBoxHTML() {
  const p = state.enrichExport;
  if (!p) return "";
  const book = state.books.find((b) => b.id === p.bookId);
  return `
    <div class="promptbox">
      <div class="prompthead"><b>《${esc(book?.title || p.bookId)}》的洗数据任务书</b>
        <span class="promptmeta">${p.chunks} 块 · ${p.batches} 批 · 已存 enrich-tasks/${esc(p.bookId)}.json</span></div>
      <textarea readonly rows="6" id="enrichExportText">${esc(p.instructions)}</textarea>
      <div class="promptactions">
        <button class="ghost sm" data-action="enrichcopyinstr">复制操作说明</button>
        <button class="ghost sm" data-action="enrichreveal" data-bid="${esc(p.bookId)}">打开文件夹</button>
        <button class="ghost sm" data-action="enrichexportclose">收起</button>
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
    : `${b.catalog?.themes?.length ? b.catalog.themes.slice(0, 2).map((t) => `<span class="tag">${esc(t)}</span>`).join("") + (b.catalog.themes.length > 2 ? `<span class="tag nocat" title="${esc(b.catalog.themes.slice(2).join("、"))}">+${b.catalog.themes.length - 2}</span>` : "") : '<span class="tag nocat">未编目</span>'}${enrichTag(b)}`;
  // V4 按钮三级制：状态驱动唯一主操作 + 其余收进「⋯」（危险项在菜单里用分隔线隔开，点两次才删）。
  //   未加工 → 开始加工（主，常显，唯一该做的事）；已加工未编目 → 编目；已编目未洗 → 洗数据；
  //   洗完 → 无主操作（重新洗在菜单里）。
  const cataloged = !!(b.catalog && b.catalog.themes && b.catalog.themes.length);
  const enriched = !!(b.enrich && b.enrich.ready);
  let mainBtn = "";
  if (raw) mainBtn = `<button class="primary" data-action="process" data-bid="${esc(b.id)}">开始加工</button>`;
  else if (!cataloged) mainBtn = `<button class="ghost sm" data-action="catprompt" data-bid="${esc(b.id)}">编目</button>`;
  else if (!enriched) mainBtn = `<button class="ghost sm" data-action="enrich" data-bid="${esc(b.id)}">洗数据</button>`;
  // 菜单：普通项在上，分隔线，危险项在下（raw 无库可移出，只有彻底删除）
  const menuNormal = [
    cataloged ? `<button data-action="catprompt" data-bid="${esc(b.id)}">编目提示词</button>` : "",
    cataloged ? `<button data-action="catimport" data-bid="${esc(b.id)}">导入编目结果</button>` : "",
    // 洗数据外部智能体路（无 key）：导出任务书给外部 AI 填 / 导入填好的结果（与编目同模式）
    !raw ? `<button data-action="enrichexport" data-bid="${esc(b.id)}">导出洗数据任务书</button>` : "",
    !raw ? `<button data-action="enrichimport" data-bid="${esc(b.id)}">导入洗数据结果</button>` : "",
    enriched ? `<button data-action="enrich" data-bid="${esc(b.id)}">重新洗数据</button>` : "",
  ].filter(Boolean).join("");
  const menuDanger = raw
    ? `<button class="danger" data-action="purge" data-bid="${esc(b.id)}">彻底删除</button>`
    : `<button data-action="del" data-bid="${esc(b.id)}">移出书架</button><div class="sep"></div><button class="danger" data-action="purge" data-bid="${esc(b.id)}">彻底删除</button>`;
  const menu = `<div class="menu hidden">${menuNormal}${menuNormal ? '<div class="sep"></div>' : ""}${menuDanger}</div>`;
  return `
    <div class="bookcard" data-action="open" data-bid="${esc(b.id)}">
      <h3>${esc(b.title)}</h3>
      <div class="bookmeta">${meta}</div>
      <div class="tags">${tags}</div>
      <div class="tagrow">${origFlagHtml(b)}${bookLangHtml(b)}</div>
      ${badge}
      <div class="cardfoot">
        <span class="skill-dot ${b.skillEnabled ? "" : "off"}">${b.skillEnabled ? "AI 可查" : "skill 已关"}</span>
        <span class="cardbtns">${running ? "" : `${mainBtn}<button class="kebab" data-action="menu" data-bid="${esc(b.id)}" title="更多操作">⋯</button>${menu}`}</span>
      </div>
    </div>`;
}

// 洗数据徽标（#140）：已洗→覆盖率+标签数（悬浮看三级摘要）；未洗→引导（没配 key 点了也有人话提示）
// P4：闸门判 warn（黄线：部分覆盖/丢弃率偏高）→ 文案改「洗数据·部分覆盖」，浮标明示原因
function enrichTag(b) {
  const e = b.enrich;
  if (!e || !e.ready) return '<span class="tag nocat">未洗数据</span>';
  const s = e.summaries || {};
  if (e.enrichGate === "warn") {
    return `<span class="tag enr warn" title="质量闸门黄线：覆盖 ${esc(e.pct)}% · 标签 ${esc(e.tags)} 个 · 摘要 ${s.chunk || 0} 块 / ${s.chapter || 0} 章 / ${s.book ? 1 : 0} 全书（部分覆盖，可重跑补齐）">洗数据·部分覆盖</span>`;
  }
  return `<span class="tag enr" title="标签 ${esc(e.tags)} 个 · 摘要 ${s.chunk || 0} 块 / ${s.chapter || 0} 章 / ${s.book ? 1 : 0} 全书">已洗 ${esc(e.pct)}% · 标签 ${esc(e.tags)}</span>`;
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
  // 「⋯」菜单：点空白处收起（菜单/按钮自身在 main 的 click 里处理）
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".menu") && !e.target.closest('[data-action="menu"]'))
      document.querySelectorAll(".menu").forEach((m) => m.classList.add("hidden"));
  });
  main.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const act = el.dataset.action;
    // 点菜单项 = 既收起（动作执行完 refresh 也会重绘，双保险）
    if (act !== "menu") document.querySelectorAll(".menu").forEach((m) => m.classList.add("hidden"));
    if (act === "menu") {
      // V4 按钮收纳：⋯ 切换菜单显隐；点开一个就收起其它
      e.stopPropagation();
      const menu = el.parentElement.querySelector(".menu");
      if (!menu) return;
      const open = !menu.classList.contains("hidden");
      document.querySelectorAll(".menu").forEach((m) => m.classList.add("hidden"));
      if (!open) menu.classList.remove("hidden");
      return;
    }
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
      // P5：一体删除补齐派生六落点（编目任务书/提示词/结果 + 洗数据任务书/产物/缓存）。
      // 不做逐文件存在性枚举（每次书架刷新多 4 次 stat 不值），实数由删除回执的
      // removedDerived 保证——清单只说「有就删」，回执说「真删了几项」。
      lines.push("· 编目任务书（含提示词）/ 编目结果 / 洗数据任务书、产物与缓存（若存在）");
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
      || act === "enrichexport" || act === "enrichimport" || act === "enrichreveal"
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
    else if (act === "enrichcopyinstr") {
      const ok = await copyText(state.enrichExport?.instructions || "");
      toast(ok ? "已复制操作说明——任务书 JSON 在 enrich-tasks/，整个交给外部 AI 填" : "复制失败——请手动全选文本框里的内容");
    }
    else if (act === "enrichexportclose") { state.enrichExport = null; refresh(); }
    else if (act === "foldtoggle") {
      // S8：details 的展开态要记在 state 里，refresh 重建 innerHTML 时才不会弹回收起
      e.preventDefault();
      state.shelfFoldOpen = !state.shelfFoldOpen;
      refresh();
    }
    else if (act === "usagetoggle") {
      // W1 用量治理：桌面写 usage-policy.json，MCP 闸机读同一份（与 skill-toggle 同模式）
      e.stopPropagation();
      const cur = state.usage?.policy?.enabled !== false;
      try {
        await call(window.study.usageSet({ enabled: !cur }));
        state.usage = await call(window.study.usageGet());
        refresh();
        toast(!cur ? "已开放：外部智能体在允许的时间窗口内可检索/翻书" : "已关闭：外部智能体只能看书架清单、编目和验引文");
      } catch (err) { toast("切换失败：" + err.message); }
    }
  });
}
