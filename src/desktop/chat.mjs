// V2 云端问答编排（P2）：本地检索（复用 engine.ask，同一条代码路径）→ 云端生成 → 引用校验。
//
// 设计（见 docs/V2-云端问答改造规划.md）：
//   - 检索一行不改：ask() 里包含 H3 关书过滤、技能包参考——本模块只做"串起来"；
//   - 云端只碰生成：把检索片段交给 llm.askCloud，回答必须过引用回源校验（不过的引用剔除，
//     全不过则 QUOTE_FAIL 降级——UI 展示"请直接看下方原文"）；
//   - 错误全部抛 UserError 人话（IPC 层统一包装，UI toast 直接展示）。
import { ask, UserError } from "./engine.mjs";
import { loadLlmConfig, readLlmKey, saveLlmConfig } from "./llm-config.mjs";
import { askCloud, chat, sanitizeHistory } from "../lib/llm.mjs";

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
  const r = await chat({
    baseUrl: cfg.baseUrl, apiKey: key, model: cfg.model,
    messages: [{ role: "user", content: "只回复两个字：收到" }],
    maxTokens: 16, timeoutMs: 20000,
  });
  if (!r.ok) throw new UserError(r.message);
  return { reply: String(r.text || "").trim().slice(0, 40) };
}

// ---------- 云端总结：本地检索 → 云端生成 → 引用回源校验 ----------
// topN 默认 6（比桌面默认 4 稍宽：总结要多一点素材；上限 20 由 ask 把关）
// history：多轮对话历史（渲染层持有传来；净化后透传给云端——白名单/截断/近 6 条）
export async function cloudSummary({ bookId = null, question, topN = 6, skillSlug = null, history = [] } = {}) {
  const q = String(question || "").trim();
  if (!q) throw new UserError("先提问再总结");
  const cfg = loadLlmConfig();
  const key = readLlmKey();
  if (!key) throw new UserError("云端 AI 还没配置——先在问一问页面填 API key");

  // 1) 本地检索（与「问一问」完全同一条路径；关掉 skill 的书在这里被 H3 拦下）
  const base = await ask({ bookId: bookId || undefined, question: q, topN, skillSlug });
  const raw = base.results || [];
  if (!raw.length) throw new UserError("这次检索没有找到相关内容，云端总结跳过——换个问法试试");
  // 单书检索的 result 不带 book（UI 里由卡片上下文体现）——云端提示词需要一个明确的书名标题
  const results = raw.map((r) => ({ ...r, book: r.book || base.book || "" }));
  const skillChapters = (base.skill?.matched || []).map((m) => ({ title: m.title, content: m.content }));

  // 2) 云端生成 + 引用校验（防幻觉延伸到生成层；历史净化后随请求带上）
  const r = await askCloud({
    config: { baseUrl: cfg.baseUrl, apiKey: key, model: cfg.model },
    question: q, results, skillChapters, history: sanitizeHistory(history),
  });
  if (!r.ok) {
    // 降级通道（UI 对齐 A1）：云端失败不丢本地果实——已检索到的原文一并回给 UI，
    // 对话页在错误气泡下挂「本地原文」折叠区；问一问页本地结果本就在下方，天然降级。
    return { degraded: true, error: r.message, results, mode: base.mode, book: base.book || null };
  }
  return { answer: r.answer, citations: r.citations, dropped: r.dropped, usage: r.usage, segments: raw.length, mode: base.mode, book: base.book || null };
}
