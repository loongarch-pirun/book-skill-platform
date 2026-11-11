// R11 语种标注：按「块」判，整书 lang 是块级聚合标签（01-耦合与改造设计.md:163-168 3.4 节）。
//
// 为什么要按块而不是按整本抽样：
//   现 detectLang（token-estimate.mjs:21-29）只取前 200 块、每块前 200 字、累计 2 万字符就停，
//   一本书的语种被「开头那几章」决定。中英混排的技术书（d2l 那类）开头若恰好是代码/英文原稿，
//   整本就判反。按块投票、按字符加权，开头是什么不影响结论。
//
// 本模块只产出标记，不改任何路径、不改任何正文——语种是标签不是路径开关（01:89 R11）。

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN = /[A-Za-z]/;
const LATEX_CMD = /\\[A-Za-z]{2,}/g;

// 单块语种：zh | en | formula | null（null = 这一块不参与投票）
//   formula：无中文、几乎无拉丁字母、且至少两个 LaTeX 命令 → 纯公式块（01:167 说标 formula 不硬判语种）
//   null   ：空块 / 纯数字符号块（没有可判的字母，投了也是噪声）
export function tagBlockLang(text) {
  const s = String(text ?? "");
  if (!s.trim()) return null;
  const cmds = (s.match(LATEX_CMD) || []).length;
  // 数拉丁字母前先摘掉 LaTeX 命令名：`\varepsilon` 里那 10 个字母是命令名不是英文单词，
  // 不摘的话纯公式块会因为命令名够长而被判成 en。
  const body = s.replace(LATEX_CMD, " ");
  let cjk = 0, latin = 0;
  for (const ch of body) {
    if (CJK.test(ch)) cjk++;
    else if (LATIN.test(ch)) latin++;
  }
  if (cjk === 0 && latin < body.length * 0.25 && cmds >= 2) return "formula";
  if (cjk === 0 && latin === 0) return null;
  // 与 detectLang 同一条线（cjk / (cjk + latin) >= 0.2 判 zh），只是把分母从「全部字符」
  // 换成「字母类字符」——不含标点/数字/空白，避免代码符号把中文占比冲淡。
  return cjk / (cjk + latin) >= 0.2 ? "zh" : "en";
}

// 整书聚合：块级标签 → { lang, zhShare, counts, chars }
//   按字符加权而不是按块数：一本中文书里夹大量英文短注释，块数可能过半但字符仍以中文为主。
//   zhShare 只在 zh/en 两类之间算（formula 和 null 不投票），所以"没中文"的书 zhShare=0。
export function aggregateLang(texts) {
  const chars = { zh: 0, en: 0, formula: 0 };
  const counts = { zh: 0, en: 0, formula: 0 };
  let skipped = 0;
  for (const t of texts || []) {
    const tag = tagBlockLang(t);
    if (!tag) { skipped++; continue; }
    chars[tag] += String(t ?? "").length;
    counts[tag] += 1;
  }
  const natural = chars.zh + chars.en;
  return {
    lang: natural && chars.zh > chars.en ? "zh" : "en",
    zhShare: natural ? chars.zh / natural : 0,
    chars,
    counts,
    skipped,
  };
}

// 文件名/路径里能读出来的语种意图：zh | en | null
//   只认显式标记（-zh / _en / chinese / 中文 / 纯中文标题），不做「看到英文判定 en」这种猜测——
//   文件名叫 Pride and Prejudice 但内容可以是任何语种，这类情况交给冲突标注去报，不自行改写。
export function langFromName(name) {
  const base = String(name ?? "").replace(/\.[^./\\]+$/, "");
  if (/[\u4e00-\u9fff]/.test(base)) return "zh";
  if (/[-_.]zh(?=[-_.]|$)/i.test(base) || /chinese|中文/i.test(base)) return "zh";
  if (/[-_.]en(?=[-_.]|$)/i.test(base) || /english/i.test(base)) return "en";
  return null;
}

// R11 判定：内容语种 vs 文件名语种
//   返回 { lang, nameLang, conflict, note } —— conflict 只用于打印与落 meta，
//   绝不参与选路径（01:89「不改路径，只改语种标记」）。
export function resolveLang(texts, fileName) {
  const agg = aggregateLang(texts);
  const nameLang = langFromName(fileName);
  const conflict = !!(nameLang && nameLang !== agg.lang);
  return {
    lang: agg.lang,
    nameLang,
    conflict,
    note: conflict
      ? `R11 语种标注：正文判为 ${agg.lang}（中文占字母类字符 ${(agg.zhShare * 100).toFixed(1)}%），文件名标记为 ${nameLang}——只改语种标记，不改路径`
      : null,
    ...agg,
  };
}
