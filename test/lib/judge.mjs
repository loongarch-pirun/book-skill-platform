// test/lib/judge.mjs —— 判分尺子（三级：full / partial / miss）
//
// 为什么换尺子：旧尺子（test/v2-eval.mjs:235-242 的 judge）只看「命中块里有没有关键词」。
// 关键词在书里到处都是，切块把答案句切成两半也照样判过——它测不出切块损伤，
// 只能测出「词出现过」。这把尺子换掉之后，「切块损伤」才第一次能被量化。
//
// 三级定义（判据见规划 P0-2）：
//   full    —— 标准答案句 a 完整落在某一个命中块里（逐字包含）
//   partial —— a 没完整落在任何单块里：
//              (a) 把相邻两个命中块拼起来才完整（接缝两侧各一半）；或
//              (b) 命中块里只有 a 的前半截，后半截掉在块外（块尾在句中被切断）
//   miss    —— a 既不完整也不成段地出现在命中结果里
//
// 附带导出 legacyJudge：旧尺子原样保留（仅关键词包含），
// 用来在同一份考卷上跑「旧尺子 vs 新尺子」，量出旧尺子到底松了多少。
//
// 不接任何大模型，纯确定性字符串判定。

const HARD = ".!?。！？";          // 硬句读
const CLOSE = "\"”’')）】」』";     // 闭引号/闭括号

/** 归一化：折叠所有空白，便于跨块/跨行比较（块文本里的换行、连续空格都会归一） */
export function normText(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/** 判断 text[i] 是否为真句读：小数点（28.4）不算句读 */
export function isTerminator(text, i) {
  const ch = text[i];
  if (!HARD.includes(ch)) return false;
  if (ch === ".") {
    const prev = text[i - 1] ?? "";
    const next = text[i + 1] ?? "";
    if (/\d/.test(prev) && /\d/.test(next)) return false; // 小数
  }
  return true;
}

/**
 * 旧尺子（原样照抄 test/v2-eval.mjs:235-242 的语义）：
 * 只要命中块里出现任一关键词就算 hit。goldens 是关键词数组。
 */
export function legacyJudge(results, goldens) {
  const low = (results ?? []).map(r => String(r?.text ?? "").toLowerCase());
  const gs = (goldens ?? []).map(g => String(g).toLowerCase());
  for (let i = 0; i < low.length; i++) {
    const g = gs.find(x => low[i].includes(x));
    if (g) return { hit: true, rank: i + 1, golden: g };
  }
  return { hit: false };
}

/** 最长公共前缀长度：a 的前 k 个字符整体出现在 text 里，取最大 k */
function longestPrefixIn(text, a, minK = 0) {
  const maxK = Math.min(a.length, text.length);
  for (let k = maxK; k >= minK; k--) {
    if (text.includes(a.slice(0, k))) return k;
  }
  return 0;
}

/**
 * 新尺子。
 * @param results 命中块数组 [{ text, ... }]，按名次排序
 * @param golden  { q, a, g }，a 是标准答案句（逐字取自原文），g 是兼容用的关键词
 * @returns { level: "full"|"partial"|"miss", rank, ...诊断字段 }
 */
export function judge(results, golden) {
  const a = normText(golden?.a);
  const g = (golden?.g ?? []).map(x => String(x).toLowerCase());
  const legacy = legacyJudge(results, g);
  const texts = (results ?? []).map(r => normText(r?.text ?? ""));

  if (!a) {
    // 没有标准答案句 —— 这题没法用新尺子判
    return { level: "miss", rank: 0, reason: "no-a", legacy };
  }

  // 1) full：a 完整落在某一个命中块里
  for (let i = 0; i < texts.length; i++) {
    if (texts[i].includes(a)) {
      return { level: "full", rank: i + 1, block: i, legacy, why: "a 完整落在命中块里" };
    }
  }

  // 2) partial：拼两个命中块才完整（接缝两侧各一半）
  //    注意：即使两个块都检回，a 仍不算 full —— full 的定义是「答案句完整落在
  //    某一个命中块内」。两个块拼起来才完整 = 切块把答案句切开了，损伤依然在。
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      if ((texts[i] + " " + texts[j]).includes(a)) {
        const physAdj = Number.isInteger(results?.[i]?.id) && Number.isInteger(results?.[j]?.id)
          ? Math.abs(results[i].id - results[j].id) === 1 : null;
        return {
          level: "partial", rank: i + 1, block: i, joined: true, pair: [i + 1, j + 1],
          physAdjacent: physAdj, legacy,
          why: `a 被切成两半：命中块 #${i + 1} + #${j + 1} 拼起来才完整`
            + (physAdj === true ? "（两块在库里是相邻的，正卡在接缝上）" : ""),
        };
      }
    }
  }

  // 3) partial：命中块里只有 a 的前半截（块尾在句中被切断）
  //    门槛：前缀至少占 a 的一半，且至少 4 个字符（避免把「沾边几个字」当成命中）
  const required = Math.max(4, Math.ceil(a.length * 0.5));
  let best = 0, bestRank = 0;
  for (let i = 0; i < texts.length; i++) {
    const k = longestPrefixIn(texts[i], a, required);
    if (k > best) { best = k; bestRank = i + 1; }
  }
  if (best >= required) {
    return {
      level: "partial", rank: bestRank, block: bestRank - 1, cut: true, prefixLen: best,
      legacy, why: `命中块里只有 a 的前 ${best}/${a.length} 字，答案句在块尾被切断`,
    };
  }

  // 4) miss：a 的内容压根没被检索到
  return { level: "miss", rank: 0, bestPrefix: best, legacy, why: "命中结果里找不到答案句" };
}

/** 一把尺子跑完一组题：返回逐题判定 + 汇总 */
export function judgeAll(resultsByQuestion, goldens) {
  const rows = [];
  for (const g of goldens) {
    const res = resultsByQuestion[g.q] ?? [];
    const v = judge(res, g);
    rows.push({ q: g.q, a: g.a, g: g.g, ...v });
  }
  const n = rows.length;
  const full = rows.filter(r => r.level === "full").length;
  const partial = rows.filter(r => r.level === "partial").length;
  const miss = rows.filter(r => r.level === "miss").length;
  const hit = full + partial;
  const legacyHit = rows.filter(r => r.legacy?.hit).length;
  const ranks = rows.filter(r => r.level !== "miss").map(r => r.rank);
  return {
    rows,
    total: n,
    full, partial, miss,
    hit,                       // 新尺子：能答对（full + partial）
    fullRate: n ? +(full / n).toFixed(4) : 0,
    hitRate: n ? +(hit / n).toFixed(4) : 0,
    damageRate: hit ? +(partial / hit).toFixed(4) : 0,   // 切块损伤率 = partial ÷ hit
    avgFirstRank: ranks.length ? +(ranks.reduce((s, x) => s + x, 0) / ranks.length).toFixed(2) : 0,
    legacyHit,                                            // 旧尺子命中数（同一份考卷）
    legacyRate: n ? +(legacyHit / n).toFixed(4) : 0,
  };
}
