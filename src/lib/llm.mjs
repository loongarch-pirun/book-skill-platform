// V2 云端问答引擎层（P1）：拼提示词 → 调 OpenAI 兼容 API → 宽容解析 → 引用校验。
//
// 定位（见 docs/V2-云端问答改造规划.md 第 4 节）：
//   - 检索在本地（调用方拿 ask() 的结果进来），本模块只负责「生成」这一段；
//   - 云端答案必须过引用校验才放行——防幻觉红线从检索层延伸到生成层；
//   - 错误不抛异常，全部返回 { ok:false, code, message } 人话，UI 直接展示；
//   - 纯逻辑：零 Electron 依赖、零新依赖（Node 内置 fetch）。测试打本地假端点。
//
// 引用校验与 skill-store 的「引用回源验证」同款算法（剥「一作」校注 + 去空白标点 +
// 子句命中率 ≥60%）——独立实现，不动老模块。

// ---------- 配置校验 ----------
// UI 保存配置前过这里；返回 { baseUrl, apiKey, model } 或 { error }
export function normalizeLlmConfig({ baseUrl, apiKey, model } = {}) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const key = String(apiKey || "").trim();
  const mdl = String(model || "").trim();
  // V2-D18（暴力测试 P0 修）：老正则只查 http(s):// 前缀，"https://a b"（中间空白主机）
  // 能过校验但 fetch 时 URL 非法抛 TypeError，误报成 NETWORK「连不上模型服务」——用户去查
  // 网络而不是改地址。现加空白拒查（正常地址不含空白，尾斜杠已在上一步剥掉）。
  if (!/^https?:\/\//i.test(base) || /\s/.test(base)) return { error: "接口地址要以 http(s):// 开头（例如 https://api.deepseek.com/v1）" };
  if (!key) return { error: "请填 API key" };
  if (!mdl) return { error: "请填模型名（例如 deepseek-chat）" };
  return { baseUrl: base, apiKey: key, model: mdl };
}

// ---------- 历史净化（IPC 边界防御：渲染层传来的对话历史不可信） ----------
// 白名单角色 / 丢空内容与非字符串 / 只留最近 keep 条 / 单条截断 maxLen 字（控 token）
// V3-R6 参数化：默认 6/2000 保持 V2 契约（llm-fuzz 断言不变）；对话窗口传 {keep:12, maxLen:3000}
export function sanitizeHistory(history, { keep = 6, maxLen = 2000 } = {}) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string" && h.content.trim())
    .slice(-keep)
    .map((h) => ({ role: h.role, content: h.content.trim().slice(0, maxLen) }));
}

// ---------- 提示词 ----------
// 铁律三条写死在 system：只依据片段、引用逐字抄、找不到就说没有。输出格式 JSON。
const SYSTEM = `你是一个严谨的读书助手：用户提问后，你会收到一组从书中检索到的「原文片段」，你要只依据这些片段来回答。

铁律：
1. 只根据「原文片段」里的内容回答；片段里找不到答案时，直接说明"给出的原文里没有相关内容"，绝不编造。
2. 引用必须逐字抄自片段（保持原字，尤其繁体原书不要转成简体、不要改字）。
3. 回答简洁清楚，用中文（如果问题用其他语言，随问题语言）。

你的回复必须是一个 JSON 对象，除此之外不要输出任何其他内容。格式：
{"answer":"回答正文（可在句尾用 [1] [2] 标注引用的片段编号）","citations":[{"n":1,"quote":"从片段1中逐字引用的一整句"}]}

- citations 里只放真正支撑你回答的引用，每条 quote 是完整的一句话（不要只引半句）。
- 没有可用引用时 citations 为 []。`;

// 组装 messages：system 在首、历史居中、问题+新鲜片段收尾（每轮检索都是新鲜的）
// V3-R6：memory = 滚动对话记忆（渲染层压缩旧轮次得来），作为独立要点块钉在问题前
export function buildMessages({ question, results, skillChapters = [], history = [], memory = "" }) {
  const q = String(question || "").trim();
  const passages = (results || []).map((r, i) =>
    `[${i + 1}] 《${r.book || "?"}》${r.loc ? "· " + r.loc : ""}：\n${r.text || ""}`);
  const parts = [
    `## 原文片段\n${passages.join("\n\n")}`,
    skillChapters.length
      ? `## 技能包参考章节（辅助理解，引用仍以上面片段为准）\n${skillChapters.map((s) => `【${s.title || "章节"}】\n${s.content || ""}`).join("\n\n")}`
      : "",
    memory ? `## 此前对话要点（更早轮次的记忆压缩，回答时可衔接但引用仍以上面片段为准）\n${memory}` : "",
    `## 问题\n${q}`,
  ].filter(Boolean);
  return [
    { role: "system", content: SYSTEM },
    ...history.map((h) => ({ role: h.role === "assistant" ? "assistant" : "user", content: String(h.content || "") })),
    { role: "user", content: parts.join("\n\n") },
  ];
}

// ---------- 调用（OpenAI 兼容 /chat/completions） ----------
const llmErr = (code, message) => ({ ok: false, code, message });

function errByStatus(status) {
  if (status === 401 || status === 403) return llmErr("AUTH", `API key 无效或无权限（${status}）——去检查配置里的 key`);
  if (status === 404) return llmErr("NOTFOUND", "接口地址或模型名不对（404）——检查接口地址和模型名");
  if (status === 429) return llmErr("RATE", "请求太频繁或余额不足（429）——稍后再试或检查账户");
  if (status >= 500) return llmErr("SERVER", `模型服务暂时出错（${status}）——过一会儿再试`);
  return llmErr("HTTP", `模型服务返回异常（${status}）`);
}

export async function chat({ baseUrl, apiKey, model, messages, timeoutMs = 60000, temperature = 0.3, maxTokens = 1500 }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
        signal: ctl.signal,
      });
    } catch (e) {
      if (e?.name === "AbortError") return llmErr("TIMEOUT", "模型响应超时——网络慢或服务繁忙，可稍后重试");
      return llmErr("NETWORK", "连不上模型服务——检查网络或接口地址");
    }
    if (!res.ok) return errByStatus(res.status);
    let data;
    try { data = await res.json(); } catch { return llmErr("BADRESP", "模型服务返回了无法解析的内容"); }
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) return llmErr("BADRESP", "模型没有返回内容");
    return { ok: true, text: text.trim(), usage: data.usage || null };
  } finally { clearTimeout(timer); }
}

// ---------- 宽容解析（容忍 ```json 围栏 / 前后夹带文字） ----------
// V2-D02（暴力测试 P0 修）：老逻辑对"以 { 开头"的文本跳过截断，模型输出
// 「JSON + 一句解释」（真实高频）时 JSON.parse 遇尾部文字必败 → 无辜降级。
// 现统一为对称截断：无论前后是否夹带，一律取首 { 到尾 } 之间再 parse。
// 双 JSON 连写（{"a"}{"b"}）仍解析失败返回 null——模型极少此形态，拒收安全（登记 OBSERVE）。
export function parseAnswer(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    const d = JSON.parse(t.slice(s, e + 1));
    if (typeof d.answer !== "string" || !d.answer.trim()) return null;
    if (!Array.isArray(d.citations)) d.citations = [];
    return { answer: d.answer.trim(), citations: d.citations };
  } catch { return null; }
}

// ---------- 引用校验（防幻觉红线：展示给用户的每条引用都必须回源命中） ----------
// 同款算法：剥「一作」等校注 + 去空白标点 + 按标点切子句 + 子句命中率 ≥60%
const stripAnnotations = (s) => String(s || "")
  .replace(/一作「[^」]*」/g, "")
  .replace(/一作『[^』]*』/g, "")
  .replace(/一作（[^）]*）/g, "")
  .replace(/或句读爲?:[^。；!?]*[。；!?]?/g, "")
  .replace(/或句读为：[^。；!?]*[。；!?]?/g, "");

const normalize = (s) => String(s || "").replace(/[\s\p{P}\p{S}]/gu, "");

function quoteClauses(quote) {
  return String(quote || "").split(/[。；！？!?;.\n]+/).map(s => normalize(stripAnnotations(s))).filter(c => c.length >= 4);
}

function hitRate(srcText, quote) {
  const src = normalize(stripAnnotations(srcText));
  const cls = quoteClauses(quote);
  // V2-D03（暴力测试 P0 修）：子句归一化后全 <4 字被踢出分母时 total=0，
  // 老逻辑 0/0>=0.6=false 把"短引文"误报成 quote-not-found（幻觉罪名）。
  // 现以 tooShort 标记区分「引文太短无法核验」与「核验未过」两种语义。
  if (!cls.length) return { ok: false, hits: 0, total: 0, tooShort: true };
  const hits = cls.filter(c => src.includes(c)).length;
  return { ok: hits / cls.length >= 0.6, hits, total: cls.length };
}

// 逐条校验：编号必须存在、quote 必须命中对应片段。
// 返回通过列表（补齐 book/loc/id 供 UI 跳转）与被剔除列表。
export function verifyAnswer(parsed, results) {
  const p = parsed || { answer: "", citations: [] };
  const list = Array.isArray(results) ? results : [];
  // V2-D16（暴力测试 P0 修）：citations 非数组（数字/对象）时 for..of 抛 TypeError，
  // 直接调用方（非 askCloud 链路）会崩——入参防御一行。
  const cites = Array.isArray(p.citations) ? p.citations : [];
  const passed = [], dropped = [];
  for (const c of cites) {
    const n = Number(c?.n);
    const quote = String(c?.quote || "").trim();
    const target = Number.isInteger(n) && n >= 1 && n <= list.length ? list[n - 1] : null;
    if (!target) { dropped.push({ n: c?.n, quote, reason: "bad-index" }); continue; }
    if (!quote) { dropped.push({ n, reason: "empty-quote" }); continue; }
    const r = hitRate(target.text, quote);
    if (r.ok) {
      passed.push({ n, quote, book: target.book || "", bookId: target.bookId || null, id: target.id ?? null, loc: target.loc || "" });
    } else {
      dropped.push({ n, quote, reason: r.tooShort ? "quote-too-short" : "quote-not-found", hits: r.hits, total: r.total });
    }
  }
  return { answer: p.answer, citations: passed, dropped };
}

// ---------- 一站式（chat.mjs 调用） ----------
// 规则：citations 为空 = 合法（例如"书中没有相关内容"）；有但全被剔除 = 降级（QUOTE_FAIL）。
// 重试策略（retryOnQuoteFail 默认开）：QUOTE_FAIL / BADRESP 先自动重试一次（附加加强提醒）——
// 实测模型偶发把繁体引文写成简体（字形漂移）或 JSON 崩坏；重试后的输出仍须过同一道校验，
// 防线强度不变，只是把"偶发抽风"与"真幻觉"区分开。
export async function askCloud({ config, question, results, skillChapters, history, memory = "", timeoutMs, temperature, maxTokens, retryOnQuoteFail = true } = {}) {
  const norm = normalizeLlmConfig(config);
  if (norm.error) return llmErr("CONFIG", norm.error);
  const once = async (retryNote) => {
    const messages = buildMessages({ question, results, skillChapters, history, memory });
    if (retryNote) messages[messages.length - 1].content += `\n\n补充要求：${retryNote}`;
    const r = await chat({ ...norm, messages, timeoutMs, temperature, maxTokens });
    if (!r.ok) return r;
    const parsed = parseAnswer(r.text);
    if (!parsed) return llmErr("BADRESP", "云端回答未按格式返回，已降级为原文片段");
    const v = verifyAnswer(parsed, results);
    if (parsed.citations.length > 0 && v.citations.length === 0) {
      return llmErr("QUOTE_FAIL", "云端回答的引用未能通过核验，已降级为原文片段");
    }
    return { ok: true, answer: v.answer, citations: v.citations, dropped: v.dropped.length, usage: r.usage };
  };
  let out = await once(null);
  if (!out.ok && retryOnQuoteFail && (out.code === "QUOTE_FAIL" || out.code === "BADRESP")) {
    out = await once("引用必须逐字抄写上面「原文片段」里的句子，一字不差（保持繁体字形，不要转成简体），并按要求的 JSON 格式输出。");
  }
  return out;
}
