// 脏内容规则过滤（CP1 · 前置过滤真正进库的那一层）
//
// 为什么要有这个文件：CP0 实测（10-产品化\cp0-wash.txt）证明「检索不知所云」的根因不是解析引擎，
// 是解析产物里混着不该进检索正文的东西——arXiv 号、期刊授权声明、作者邮箱、贡献脚注、
// Gutenberg 版权页——它们被当成正文块入库，BM25 一查就把它们顶上来。同一份实测还证明：
// MinerU 自己的块类型标签洗不动正主（这类脏块大多被标成 text，不是 footer），
// 所以必须按内容规则洗，不能靠引擎的 type。
//
// 设计铁律（用户原话「新增一类脏内容只需改一条规则配置而不是改函数」）：
//   ① 规则是数据，不是代码：默认表在本文件，可被外部 JSON 覆盖（BSP_NOISE_RULES 指向的文件，
//      或 ./config/noise-rules.json）。加一类脏内容 = 加一条 JSON，本文件的函数一行不动。
//   ② 每条规则必须能翻转：disabled 掉一条，它命中的块就该回到库里。所以统计按规则分别记账。
//   ③ 只丢整块，不改剩余块一个字节：命中即整块剔除，未命中的块原样保留（原文可回验是产品契约）。
//   ④ 有逃生开关：BSP_NOISE=0 整段关（排障/对照用），关掉后行为与改造前逐块一致。
//   ⑤ 不能把书洗空：全丢光说明判据过宽，抛错让人看见，不静默建出空书（与 R12 同一条教训）。

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// 规则表：一条 = 一类脏内容。字段说明
//   id     唯一名，用于记账与单独关闭
//   re     命中即丢的正则（字符串，便于外部 JSON 覆盖）
//   flags  正则 flags，默认 "iu"
//   scope  "text" 只测块正文；"block_type" 测块的 block_type 列
//   note   为什么这条算脏（写给人看，接线时能自己判断该不该开）
//   enabled 默认是否启用
// ---------------------------------------------------------------------------
export const DEFAULT_RULES = [
  {
    id: "arxiv_id",
    enabled: true,
    scope: "text",
    re: "^arXiv:\\d{4}\\.\\d{4,5}v?\\d*(\\s*\\[[\\w./-]+\\])?(\\s+\\d{1,2}\\s+\\w{3}\\s+\\d{4})?\\s*$",
    whole: true,
    note: "arXiv 预印本编号行（页边竖排被解析成独立块）。实测 attention 命中 17 块，检索「attention」时它会顶掉正文。",
  },
  {
    id: "copyright_grant",
    enabled: true,
    scope: "text",
    re: "hereby grants permission|provided proper attribution|all rights reserved|reproduce the tables|permission to make digital or hard copies",
    note: "期刊/出版社授权声明段。实测 attention 第 2 块就是 Google 授权声明，直接顶到检索结果第一屏。",
  },
  {
    id: "author_email",
    enabled: true,
    scope: "text",
    re: "[\\w.+-]+@[\\w-]+\\.[\\w.]{2,}",
    note: "作者联系邮箱行。实测 attention 命中 8 块（每位作者一行），整段检索会被邮箱刷屏。",
  },
  {
    id: "contribution_footnote",
    enabled: true,
    scope: "text",
    // anchor: "start" —— 只认块开头。为什么：'now at [A-Z]' 不带开头锚定时，
    // 简爱散文里 "...now at last"/"...now at home" 会被整块误杀（实测 5 块正文）。
    anchor: "start",
    re: "equal contribution|listing order is random|work performed while at|now at [A-Z]",
    note: "贡献声明脚注（∗Equal contribution 等）。不是正文，且常与正文混在同一块里被顶上来。只见块首命中，避免误杀散文里的 'now at last'。",
  },
  {
    id: "gutenberg_boilerplate",
    enabled: true,
    scope: "text",
    // 子串必须够独特 —— 'produced by ' 这类通用短语会把论文正文
    // "…produced by each map task" 整块误杀（MapReduce 实测 8 块）。改成只认
    // Gutenberg 才会用的完整短语，且都不许以通用动词开头。
    re: "the project gutenberg (ebook|eBook|license)|project gutenberg™|gutenberg-tm|release date: march|most recently updated:|character set encoding:|^credits: ",
    note: "Gutenberg 电子书版权页与许可证。实测简爱/frankenstein 命中，书首书尾夹击；只认 Gutenberg 独有短语，不用 'produced by ' 这种通用动词。",
  },
  {
    id: "publisher_frontmatter",
    enabled: true,
    scope: "text",
    re: "^(isbn\\b|doi:|issn\\b|copyright ©|© \\d{4}|printed in |first published|published by )",
    note: "版权页元数据行（ISBN/DOI/版权年份/出版地）。命中行首，避免误伤正文里出现的 doi 引用。",
  },
  {
    id: "block_type_footer",
    enabled: true,
    scope: "block_type",
    re: "^(footer|page_footnote|aside_text)$",
    whole: true,
    // maxChars：只丢「短」的页眉页脚（书名/期刊名/页码/"July 1978 Volume 21 Number 7"）。
    // 为什么必须带上限：学术论文的 page_footnote 里常装真内容——Lamport 1978 有 6 条脚注
    // 写着事件序的定义与论证，整类丢会把正文挖空。页眉页脚天生短，长块就不该归它管。
    maxChars: 160,
    note: "引擎判定为页脚/页边注、且短到只可能是页眉页脚条款的块。长脚注保留——那些往往是正文内容。",
  },
];

// 外部覆盖：文件里给 {rules:[...]} 或 [...]，整表替换（不是追加——替换才好「删干净」）
export function loadRules(env = process.env) {
  const candidates = [];
  if (env.BSP_NOISE_RULES) candidates.push(env.BSP_NOISE_RULES);
  candidates.push(path.join(process.cwd(), "config", "noise-rules.json"));
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const arr = Array.isArray(raw) ? raw : raw?.rules;
      if (!Array.isArray(arr) || !arr.length) continue;
      return { rules: arr, source: p };
    } catch (e) {
      // 配置写坏了必须喊出来：静默回落默认表会让人以为新规则生效了
      console.error(`⚠ 脏内容规则表读取失败（${p}）：${e.message} —— 本次用内置默认表`);
    }
  }
  return { rules: DEFAULT_RULES, source: "builtin" };
}

// 编译一次，建库时逐块复用（大书 4000+ 块，每条规则重编译正则太浪费）
export function compileRules(rules) {
  return rules
    .filter((r) => r.enabled !== false)
    .map((r) => {
      let re = null;
      try {
        re = new RegExp(r.re, r.flags || "iu");
      } catch (e) {
        console.error(`⚠ 脏内容规则 ${r.id} 正则非法，已跳过：${e.message}`);
        return null;
      }
      return { ...r, re };
    })
    .filter(Boolean);
}

const fieldOf = (c, scope) => (scope === "block_type" ? String(c.block_type ?? "") : String(c.text ?? ""));

// 编译期把「块首命中」翻译成正则锚定，而不是在匹配时偷偷截断文本——
// 截断会让 note 里写的规则和实际判定不一致，排查时对不上。
const anchored = (r) => (r.anchor === "start" && !r.whole ? { ...r, re: new RegExp("^(?:" + r.re + ")", r.flags || "iu") } : r);

// 主函数：返回 { chunks, report }
//   chunks  = 过滤后要入库的块（未命中的块原样返回，一字不改）
//   report  = { dropped, byRule, total, kept, source } —— 记账，可审计
export function filterNoiseChunks(chunks, { rules, source = "builtin", off = false } = {}) {
  const list = Array.isArray(chunks) ? chunks : [];
  if (off) return { chunks: list, report: { off: true, total: list.length, dropped: 0, byRule: {}, source } };

  const compiled = compileRules(rules || DEFAULT_RULES).map(anchored);
  if (!compiled.length) return { chunks: list, report: { total: list.length, dropped: 0, byRule: {}, source } };

  const kept = [];
  const removed = [];
  const byRule = Object.fromEntries(compiled.map((r) => [r.id, 0]));

  for (const c of list) {
    // 表块是结构化单元（table_html 原样带着），拿正文正则去测会把表内正常出现的
    // 「Release Date」之类数据行误杀，所以表块只走 block_type 规则。
    const isStructural = c.kind === "table" || c.table_html;
    let hit = null;
    for (const r of compiled) {
      if (isStructural && r.scope === "text") continue;
      const v = fieldOf(c, r.scope);
      if (!v) continue;
      // maxChars：给规则加长度上限（页脚规则专用），长块不受该规则管——防「整类丢」把正文挖空
      if (r.maxChars && String(c.text ?? "").length > r.maxChars) continue;
      // whole=true 表示「整块就是这类垃圾」（如纯 arXiv 号行），用锚定正则；
      // 否则「块里出现即算」（如邮箱、授权声明句）。
      if (r.whole) {
        if (r.re.test(v.trim())) { hit = r; break; }
      } else if (r.re.test(v)) { hit = r; break; }
    }
    if (hit) {
      byRule[hit.id] = (byRule[hit.id] || 0) + 1;
      removed.push({ id: c.id ?? null, page: c.page ?? null, rule: hit.id, text: String(c.text ?? "").slice(0, 80) });
    } else {
      kept.push(c);
    }
  }

  if (list.length && !kept.length) {
    throw new Error(`脏内容规则过滤后 0 块：${list.length} 块全部命中规则（判据可能过宽，检查规则表）`);
  }

  return {
    chunks: kept,
    report: { total: list.length, dropped: removed.length, kept: kept.length, byRule, source, removed: removed.slice(0, 20) },
  };
}
