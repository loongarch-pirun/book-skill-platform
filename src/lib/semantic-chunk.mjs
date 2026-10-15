// 语义分块（V3 第二波 L2.5）：本地 e5 零成本，两个方向一把尺——
//   merge（并）：同章/同页相邻小块并到目标尺寸（本语料块长 p50≈40~113 字符，主力方向）；
//   split（切）：超长块在相邻句余弦突变处下刀（SemanticChunker 思路，外部长段落资料的方向）。
// 位置：build-book 解析后、建库前，先并后切（并完的块内边界余弦都 ≥ 阈值，split 天然不重复劳动）。
// 开关：BSP_SEMANTIC=1 开启（默认关——存量行为零变化）；embed 可注入（测试用假向量）。
// 铁律：只动块边界不动字——切块按偏移切片、并块以 "\n" 相接，拼回与原文逐字一致。
import { cosine } from "./models.mjs";

export const DEFAULTS = { minLen: 400, minPiece: 150, threshold: 0.72, maxCuts: 8 };
export const MERGE_DEFAULTS = { target: 400, maxLen: 800, threshold: 0.72 };

// 句子跨度（含结尾标点与后续空白）：返回 [[start,end], ...]，切片即得保真文本
export function sentenceSpans(text) {
  const spans = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (/[。！？!?]/.test(text[i])) {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      spans.push([start, j]);
      start = j;
      i = j - 1;
    }
  }
  if (start < text.length) spans.push([start, text.length]);
  return spans;
}

// 在一块内选切点：相邻句相似度 < threshold 处；从最深处下刀，切块互不薄于 minPiece 字符
export function pickCuts(sims, sentLens, { threshold, minPiece, maxCuts }) {
  const cand = sims.map((s, i) => [s, i]).filter(([s]) => s < threshold).sort((a, b) => a[0] - b[0]);
  const cuts = [];
  const acc = (from, to) => sentLens.slice(from, to).reduce((a, b) => a + b, 0);
  for (const [, i] of cand) {
    if (cuts.length >= maxCuts) break;
    const before = cuts.filter(c => c <= i);
    const after = cuts.filter(c => c > i);
    const from = before.length ? before[before.length - 1] : 0;
    const to = after.length ? after[0] : sentLens.length;
    if (acc(from, i) < minPiece || acc(i, to) < minPiece) continue;  // 切出薄片 → 放弃这个点
    cuts.push(i);
  }
  return cuts.sort((a, b) => a - b);
}

/**
 * 对 chunks 逐块做语义切分。返回新数组（原数组不动），块序/章节/页码原样带。
 * @param {Array<{chapter?:string,page?:number,text:string}>} chunks
 * @param {{embed:(texts:string[])=>Promise<ArrayLike<number>[]>, minLen?:number,
 *          minPiece?:number, threshold?:number, maxCuts?:number}} opts
 */
export async function semanticSplitChunks(chunks, opts = {}) {
  const { minLen, minPiece, threshold, maxCuts } = { ...DEFAULTS, ...opts };
  const embed = opts.embed;
  if (typeof embed !== "function") {
    throw new Error("semanticSplitChunks 需要 embed(texts) => 向量数组（真实路径传 e5 embedPassages，测试传假向量）");
  }
  // 第一遍：挑出待切块，收句子批量前向（一次模型调用顶全部块）
  const spansList = [];
  const todo = [];
  const keep = [];
  for (const c of chunks) {
    const spans = c.text.length >= minLen ? sentenceSpans(c.text) : [];
    if (spans.length < 2) { keep.push({ c, spans: null }); continue; }
    keep.push({ c, spans });
    spansList.push(spans);
    for (const [s, e] of spans) todo.push(c.text.slice(s, e));
  }
  if (!todo.length) return chunks.slice();

  const vecs = await embed(todo);
  const out = [];
  let cursor = 0;
  for (const { c, spans } of keep) {
    if (!spans) { out.push(c); continue; }
    const vs = vecs.slice(cursor, cursor + spans.length);
    cursor += spans.length;
    const sims = [];
    for (let i = 0; i + 1 < vs.length; i++) sims.push(cosine(vs[i], vs[i + 1]));
    const sentLens = spans.map(([s, e]) => e - s);
    const cuts = pickCuts(sims, sentLens, { threshold, minPiece, maxCuts });
    if (!cuts.length) { out.push(c); continue; }
    // 下刀：按偏移切片（保真——拼回与原文逐字一致，含块内空白）
    let prev = 0;
    for (const ci of cuts) {
      const at = spans[ci][1];
      out.push({ ...c, text: c.text.slice(prev, at) });
      prev = at;
    }
    out.push({ ...c, text: c.text.slice(prev) });
  }
  return out;
}

// ---------- merge（并）：同章/同页相邻小块并到目标尺寸 ----------
// 组键：章节+页码都相同才可并（PDF 跨页并会丢页码归属，章节是更强的语义边界）。
// 边界信号：前块末句 vs 后块首句的余弦——与贪心结果无关（前块末句不随合并改变），
// 因此全部边界可一次性批量前向，不需要边算边等模型。
const firstSentence = (text) => { const s = sentenceSpans(text); return s.length ? text.slice(s[0][0], s[0][1]) : ""; };
const lastSentence = (text) => { const s = sentenceSpans(text); return s.length ? text.slice(s[s.length - 1][0], s[s.length - 1][1]) : ""; };
const groupOf = (c) => `${c.chapter ?? ""}\u0000${c.page ?? ""}`;

/**
 * 把同章/同页的相邻小块语义合并到目标尺寸。返回新数组（原数组不动）。
 * 规则：达到 target 即收、maxLen 封顶、边界余弦 < threshold 处让路（话题突变不并）；
 * 并块以 "\n" 相接——拼回与原文逐字一致（split("\n") 即原块序列）。
 * @param {Array<{chapter?:string,page?:number,text:string}>} chunks
 * @param {{embed:(texts:string[])=>Promise<ArrayLike<number>[]>, target?:number,
 *          maxLen?:number, threshold?:number}} opts
 */
export async function semanticMergeChunks(chunks, opts = {}) {
  const { target, maxLen, threshold } = { ...MERGE_DEFAULTS, ...opts };
  const embed = opts.embed;
  if (typeof embed !== "function") {
    throw new Error("semanticMergeChunks 需要 embed(texts) => 向量数组（真实路径传 e5 embedPassages，测试传假向量）");
  }
  if (!(target > 0) || maxLen < target) {
    throw new Error(`semanticMergeChunks 参数不合法：target=${target} maxLen=${maxLen}（要 maxLen >= target > 0）`);
  }
  // 第一遍：收集可合并的相邻边界对（同组、双方非空、都有句子边界）
  const pairs = [];
  for (let j = 0; j + 1 < chunks.length; j++) {
    const a = chunks[j], b = chunks[j + 1];
    if (!a.text || !b.text || groupOf(a) !== groupOf(b)) continue;
    const la = lastSentence(a.text), fb = firstSentence(b.text);
    if (la && fb) pairs.push({ j, left: la, right: fb });
  }
  if (!pairs.length) return chunks.slice();
  const vecs = await embed(pairs.flatMap(p => [p.left, p.right]));
  const simAt = new Map(pairs.map((p, i) => [p.j, cosine(vecs[i * 2], vecs[i * 2 + 1])]));

  // 第二遍：贪心合并——空块自成一块（不产出前导 "\n"），无边界证据的邻位不并
  const out = [];
  let i = 0;
  while (i < chunks.length) {
    let acc = chunks[i];
    let j = i + 1;
    while (acc.text && j < chunks.length && chunks[j].text
           && groupOf(acc) === groupOf(chunks[j])
           && acc.text.length + 1 + chunks[j].text.length <= maxLen
           && acc.text.length < target) {
      const sim = simAt.get(j - 1);
      if (sim === undefined || sim < threshold) break;   // 无证据/语义边界 → 不并
      acc = { ...acc, text: acc.text + "\n" + chunks[j].text };
      j++;
    }
    out.push(acc);
    i = j;
  }
  return out;
}
