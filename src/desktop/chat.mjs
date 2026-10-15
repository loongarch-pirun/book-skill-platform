// V2 云端问答编排（P2）：本地检索（复用 engine.ask，同一条代码路径）→ 云端生成 → 引用校验。
//
// 设计（见 docs/V2-云端问答改造规划.md）：
//   - 检索一行不改：ask() 里包含 H3 关书过滤、技能包参考——本模块只做"串起来"；
//   - 云端只碰生成：把检索片段交给 llm.askCloud，回答必须过引用回源校验（不过的引用剔除，
//     全不过则 QUOTE_FAIL 降级——UI 展示"请直接看下方原文"）；
//   - 错误全部抛 UserError 人话（IPC 层统一包装，UI toast 直接展示）。
import { ask, attachSkill, UserError, dirs } from "./engine.mjs";
import { loadLlmConfig, readLlmKey, saveLlmConfig } from "./llm-config.mjs";
import { askCloud, chat, sanitizeHistory } from "../lib/llm.mjs";
import { appendArchive, listArchive, purgeBook, clearArchive } from "./chat-archive.mjs";
import { findBook, multiVariantSearch, currentLibDir } from "../lib/search.mjs";
import { loadSkillState } from "../lib/skill-state.mjs";
import { rewriteQuery } from "../lib/query-rewrite.mjs";

// ---------- 配置读写（给 UI；get 不含明文 key，set 不落半成品） ----------
export function configGet() {
  return loadLlmConfig();
}

export function configSet(patch) {
  const r = saveLlmConfig(patch || {});
  if (!r.ok) throw new UserError(r.error);
  return r.config;
}

// ---------- 测试连接：发最小 chat 请求验证 地址/模型/key 三件套 ----------
export async function testConnection() {
  const cfg = loadLlmConfig();
  const key = readLlmKey();
  if (!key) throw new UserError("还没配置 API key——先填上再测");
  // V2-D15（暴力测试 P1 修）：空 baseUrl 时 fetch 相对 URL "/chat/completions" 抛
  // TypeError，被误报成 NETWORK「连不上模型服务」——用户去查网络而不是填地址。
  if (!String(cfg.baseUrl || "").trim()) throw new UserError("还没配置接口地址——先填上再测");
  const r = await chat({
    baseUrl: cfg.baseUrl, apiKey: key, model: cfg.model,
    messages: [{ role: "user", content: "只回复两个字：收到" }],
    maxTokens: 16, timeoutMs: 20000,
  });
  if (!r.ok) throw new UserError(r.message);
  return { reply: String(r.text || "").trim().slice(0, 40) };
}

// ---------- 查询改写编排（V3-R1）：单书模式先改写 → 多问法检索；其余现状单路 ----------
// 双保险门：① BSP_REWRITE=0 或无 key 调用方根本不进来（config 缺失时 rewriteQuery 自降级）
// ② 重切路径绕过了 ask()，engine.ask 的 H3 开关门在这里原样补上（关 skill 的书照样拒答）
// 全库模式 v1 走现状单路：跨书改写路由（变体可能命中别的书）留给两轮检索波次。
// 导出：query-rewrite-test 端到端直调（配置经参数注入，不碰 readLlmKey）。
export async function askWithRewrite({ bookId, question, topN, skillSlug, history, config }) {
  const single = Boolean(bookId);
  const rw = (single && process.env.BSP_REWRITE !== "0")
    ? await rewriteQuery({ config, question, history: sanitizeHistory(history, { keep: 12, maxLen: 3000 }) })
    : { ok: false, fallback: true };
  const singlePath = async () => ({ base: await ask({ bookId: bookId || undefined, question, topN, skillSlug }), rewrite: { used: false, variants: rw.ok ? rw.variants : [] } });
  if (!rw.ok || rw.variants.length <= 1) return singlePath();
  const b = findBook(bookId);
  if (!b) return singlePath();
  const st = loadSkillState(currentLibDir());
  if (st[b.id] === false) throw new UserError(`《${b.title}》的 skill 已关——去「技能开关」面板打开才能问`);
  const results = await multiVariantSearch(b.db, rw.variants, topN);
  let base = { mode: "book", book: b.title, bookId: b.id, results };
  if (skillSlug) base = await attachSkill(base, String(skillSlug), question);
  return { base, rewrite: { used: true, variants: rw.variants } };
}

// ---------- 云端总结：本地检索 → 云端生成 → 引用回源校验 ----------
// topN 默认 6（比桌面默认 4 稍宽：总结要多一点素材；上限 20 由 ask 把关）
// history：多轮对话历史（渲染层持有传来；净化后透传给云端——白名单/截断/近 6 条）
export async function cloudSummary({ bookId = null, question, topN = 6, skillSlug = null, history = [], memory = "" } = {}) {
  const q = String(question || "").trim();
  if (!q) throw new UserError("先提问再总结");
  const cfg = loadLlmConfig();
  const key = readLlmKey();
  if (!key) throw new UserError("云端 AI 还没配置——先在问一问页面填 API key");

  // 1) 本地检索：单书模式先查询改写 → 多问法检索（V3-R1）；
  //    改写失败/超时/无 key/BSP_REWRITE=0/全库模式 → ask() 现状单路（零变化原则）
  const { base, rewrite } = await askWithRewrite({
    bookId, question: q, topN, skillSlug, history,
    config: { baseUrl: cfg.baseUrl, apiKey: key, model: cfg.model },
  });
  const raw = base.results || [];
  if (!raw.length) throw new UserError("这次检索没有找到相关内容，云端总结跳过——换个问法试试");
  // 单书检索的 result 不带 book（UI 里由卡片上下文体现）——云端提示词需要一个明确的书名标题
  // V2-D30（暴力测试 P4-E2E 修，规划外新发现）：bookId 也要同步补——老逻辑只补 book 名，
  // verifyAnswer 从片段取 bookId 得 null，UI 引用徽标 data-bid 为空、跳原文断链
  // （全库模式的结果本就带 bookId，两道都补：r.bookId || base.bookId）
  const results = raw.map((r) => ({ ...r, book: r.book || base.book || "", bookId: r.bookId || base.bookId || null }));
  const skillChapters = (base.skill?.matched || []).map((m) => ({ title: m.title, content: m.content }));

  // 2) 云端生成 + 引用校验（防幻觉延伸到生成层；历史净化后随请求带上）
  const r = await askCloud({
    config: { baseUrl: cfg.baseUrl, apiKey: key, model: cfg.model },
    question: q, results, skillChapters,
    history: sanitizeHistory(history, { keep: 12, maxLen: 3000 }), memory,
  });
  if (!r.ok) {
    // 降级通道（UI 对齐 A1）：云端失败不丢本地果实——已检索到的原文一并回给 UI，
    // 对话页在错误气泡下挂「本地原文」折叠区；问一问页本地结果本就在下方，天然降级。
    return { degraded: true, error: r.message, results, mode: base.mode, book: base.book || null, rewrite };
  }
  // P4 引用快照：每次成功回答落一份（问题 + 引用片段原文 + 回答）——失败不落（没答案可存）。
  // citations 的 n 是 1 基片段编号，回填整段 text：书哪天没了，存档里仍留着当初的依据。
  // 存档失败绝不能炸掉回答——try 兜底静默（快照是锦上添花，回答才是本体）。
  try {
    appendArchive(dirs().libDir, {
      question: q,
      answer: r.answer,
      mode: base.mode,
      book: base.book || null,
      model: cfg.model,
      segments: raw.length,
      dropped: r.dropped || 0,
      usage: r.usage || null,
      citations: (r.citations || []).map((c) => {
        const src = results[c.n - 1] || {}; // n 越界/缺页都退空串，不炸
        return { n: c.n, book: c.book, bookId: c.bookId, id: c.id, loc: c.loc, quote: c.quote, text: src.text || "" };
      }),
    });
  } catch { /* 存档失败不影响回答 */ }
  return { answer: r.answer, citations: r.citations, dropped: r.dropped, usage: r.usage, segments: raw.length, mode: base.mode, book: base.book || null, rewrite };
}

// ---------- P4 存档：列表 / 删书联动 / 清空（UI 消费；libDir 取不到时安全退化） ----------
export function archiveList({ limit } = {}) {
  const libDir = dirs()?.libDir;
  return libDir ? listArchive(libDir, { limit }) : [];
}

// 删书联动：清掉引用了这本书的全部存档，返回条数。清理失败不挡删书本体（返回 0）。
export function purgeArchives(bookId) {
  const libDir = dirs()?.libDir;
  if (!libDir) return 0;
  try { return purgeBook(libDir, bookId); } catch { return 0; }
}

export function archiveClear() {
  const libDir = dirs()?.libDir;
  if (libDir) clearArchive(libDir);
  return { cleared: true };
}

// ---------- 对话记忆压缩（V3-R6）：旧轮次 → ≤200 字要点，渲染层持有并钉进后续上下文 ----------
// 无状态设计：渲染层在历史变长时主动调用（chat:compact）；压缩失败静默降级——对话继续，只是记忆没更新。
// BSP_MEMORY=0 一键关；askCloud 侧 context 用量由「keep 4 条即时 + memory ≤800 字」兜住。
export async function compactHistory({ history = [], prevMemory = "" } = {}) {
  if (process.env.BSP_MEMORY === "0") return { ok: false, skipped: true, note: "对话记忆已关闭（BSP_MEMORY=0）" };
  const arr = sanitizeHistory(history, { keep: 9999, maxLen: 3000 });
  if (arr.length < 8) return { ok: false, skipped: true, note: "轮次不足 8 条，无需压缩" };
  const cfg = loadLlmConfig();
  const key = readLlmKey();
  if (!key) return { ok: false, skipped: true, note: "云端 AI 未配置" };
  const old = arr.slice(0, arr.length - 4);  // 最近 4 条不压（保留即时上下文）
  const prior = String(prevMemory || "").trim();
  const r = await chat({
    baseUrl: cfg.baseUrl, apiKey: key, model: cfg.model,
    temperature: 0.2, maxTokens: 400, timeoutMs: 15000,
    messages: [
      { role: "system", content: "你是对话记忆压缩器：把一段「读书助手与用户」的对话历史压成 200 字以内的要点记忆——用户关心什么、聊到哪些书与话题、已有哪些结论与待办。只输出要点文本本身，不要客套。" },
      { role: "user", content: (prior ? `【已有记忆（合并进新要点）】\n${prior}\n\n` : "") + old.map(h => `${h.role === "assistant" ? "答" : "问"}：${h.content}`).join("\n") },
    ],
  });
  if (!r.ok) return { ok: false, code: r.code };
  return { ok: true, memory: r.text.trim().slice(0, 800), compacted: old.length };
}
