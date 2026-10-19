// token 估算与章节质量（V3R7 第1批）：建库记账 / list_books 展示 / get_outline / read_full_book
// 闸门共用同一把尺子——系数用实测校准过：P&P 710,791 字符 × 0.25 = 177.7K token，与审计账吻合。
// 纯函数零依赖（不碰 db / 不加载模型）——建库热路径与测试都能直接用。
export const ZH_COEFF = 0.75;   // 中文：cl100k 量级约 1 token / 1.3 字
export const EN_COEFF = 0.25;   // 英文：约 4 字符 / token（含空格摊薄）

// CJK 字符类：统一表意文字 + 兼容表意 + 假名 +  CJK 符号标点 + 全角形式（估算够用，不追求语料级精确）
const CJK_RE = /[\u2e80-\u303f\u3040-\u30ff\u3190-\u319f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

export const coeffFor = (lang) => (lang === "zh" ? ZH_COEFF : EN_COEFF);

// 单段文本 token 估算：逐字符判 CJK（中英混排的书比整书一个系数准）
export function estimateTokens(text) {
  const s = String(text ?? "");
  let cjk = 0;
  for (const ch of s) if (CJK_RE.test(ch)) cjk++;
  return Math.round(cjk * ZH_COEFF + (s.length - cjk) * EN_COEFF);
}

// 语言判别：抽样文本的 CJK 字符占比 ≥0.2 判中文（工作资料里夹英文术语不影响判定）
export function detectLang(texts) {
  let cjk = 0, all = 0;
  for (const t of (texts || []).slice(0, 200)) {
    const s = String(t ?? "").slice(0, 200);
    for (const ch of s) { all++; if (CJK_RE.test(ch)) cjk++; }
    if (all >= 20000) break;
  }
  if (!all) return "en";
  return cjk / all >= 0.2 ? "zh" : "en";
}

// 全书 token 账：总字符 × 语言系数（与 total_chars 同源的粗账，给闸门和展示用）
export function bookTokenTotal(totalChars, lang) {
  return Math.round(Math.max(0, Number(totalChars) || 0) * coeffFor(lang));
}

// 章节列可信度（get_outline 的展示策略依据）：
//   none    —— 章节列基本不可用（覆盖率不足半数，PDF 无章节）→ 提示 read_range/query_book
//   messy   —— 有章节但名字可能是正文片段（EPUB 通病：avg_name_len>30）→ 警告按名翻章可能落空
//   reliable—— 名字是正常标题 → 放心按名翻
// 注意：verdict 只判「名字可不可信」；覆盖率部分缺失（如 85%）不降级——名字本身是好的，
// 地图完不完整由调用方按 coverage 单独给提示（见 outline.mjs 的完整性 note）。
export function qualityFromStats({ total = 0, withChapter = 0, avgNameLen = 0 }) {
  if (!total) return { coverage: 0, avg_name_len: 0, verdict: "none" };
  const coverage = withChapter / total;
  const verdict = coverage < 0.5 ? "none" : avgNameLen > 30 ? "messy" : "reliable";
  return { coverage: Math.round(coverage * 100) / 100, avg_name_len: Math.round(avgNameLen), verdict };
}

// 从块数组算章节质量（建库期用；回补脚本走 SQL 聚合后调 qualityFromStats）
export function chapterQuality(chunks) {
  const total = (chunks || []).length;
  const named = (chunks || []).filter(c => c.chapter != null && c.chapter !== "");
  const avg = named.length ? named.reduce((a, c) => a + c.chapter.length, 0) / named.length : 0;
  return qualityFromStats({ total, withChapter: named.length, avgNameLen: avg });
}
