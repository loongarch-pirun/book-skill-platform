// 查询改写（V3-R1）：把口语问法改写成「书里更可能出现的说法」，供多路检索使用。
// 定位：检索前的「问句翻译」——只产出问法，不碰检索打分。
// 铁律：失败/超时/无 key/坏 JSON 一律 {ok:false, fallback:true}，调用方退回单路现状
// （不填 key 零变化原则的云端版）；BSP_REWRITE=0 时调用方直接跳过本模块。
import { chat } from "./llm.mjs";

const SYSTEM = `你是一个检索查询改写器：用户会对一个本地书库提问，书里有古籍（繁体）、英文小说、论文和现代文档。
请你把用户的问法改写成「书里更可能出现的说法」，用于关键词与语义检索。

要求：
1. 只输出一个 JSON 对象，不要任何其他内容，格式：
   {"variants":["问法1","问法2"],"terms":["词1","词2"]}
2. variants：第一条必须是用户的原问题，后面跟 0~3 条改写（同义词、书内术语、换一种问法），每条不超过 40 字
3. terms：3~6 个适合当检索关键词的词（书里可能出现的名词/术语/人名）
4. 不要解释；没有把握的专有名词不要编造`;

// 宽容解析（与 llm.parseAnswer 同款对称截断；独立实现，不动 llm.mjs）
// 变体去重、每条 ≤80 字、总数 ≤4 且原句保底必含；terms 去重 ≤8、每条 ≤40 字。
export function parseRewrite(text, original) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  let d;
  try { d = JSON.parse(t.slice(s, e + 1)); } catch { return null; }
  const clean = (arr, cap, maxLen) => [...new Set((Array.isArray(arr) ? arr : [])
    .map(v => String(v || "").trim())
    .filter(v => v && v.length <= maxLen))].slice(0, cap);
  const variants = clean(d.variants, 4, 80);
  if (!variants.length) return null;
  if (!variants.some(v => v === original)) variants.unshift(original);  // 原句保底必含
  return { variants: variants.slice(0, 4), terms: clean(d.terms, 8, 40) };
}

export async function rewriteQuery({ config, question, history = [], timeoutMs = 8000 } = {}) {
  const q = String(question || "").trim();
  if (!q) return { ok: false, code: "EMPTY", fallback: true };
  // 近 4 轮上下文：多轮对话里问题常带代词/省略（「那霸道呢？」），改写器需要看到上文
  // F-V3c 加固（本轮 review）：历史元素防御——null/非对象/非字符串内容一律丢弃（原实现在 h.role 处裸抛）
  const recent = (Array.isArray(history) ? history : [])
    .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string" && h.content.trim())
    .slice(-4);
  const ctx = recent.length
    ? `\n\n【最近对话（用于理解代词与省略）】\n${recent.map(h => `${h.role === "assistant" ? "答" : "问"}：${h.content}`).join("\n")}`
    : "";
  const r = await chat({
    ...config, temperature: 0.2, maxTokens: 300, timeoutMs,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `【用户问题】\n${q}${ctx}` },
    ],
  });
  if (!r.ok) return { ok: false, code: r.code, fallback: true };
  const parsed = parseRewrite(r.text, q);
  if (!parsed) return { ok: false, code: "BADRESP", fallback: true };
  return { ok: true, ...parsed, usage: r.usage };
}
