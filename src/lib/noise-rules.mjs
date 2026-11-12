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
//   unless 命中这条正则的块**不丢**（保留）。用于「同一形状里混着真内容」的场景：
//          署名行和纯联系行都带邮箱，但署名行载着作者身份，丢了就问不出来作者是谁。
//          可写具名谓词（如 "byline"）引用代码里的比较型判据，也可写正则（向后兼容）。
//          具名谓词登记在 NAMED_PREDICATES；新增保留理由才需要加谓词，加脏内容类型仍只需加 JSON。
//   note   为什么这条算脏（写给人看，接线时能自己判断该不该开）
//   enabled 默认是否启用
// ---------------------------------------------------------------------------
// 人名对识别（供 unless 用）
//
// 【为什么改了两版 —— O1 的教训】
// 第一版是「两个相邻大写词 = 人名对」，配一张单位词黑名单（ORG_WORDS）做负向断言。
// 独立验收（11-全盘替换\CP1-附加核查-unless版.md 观察项 O1）构造真垃圾实测推翻了它：
//   「contact: support@example.com for more info」「Email us at info@spam.org now」
//   「University of Toronto contact@cs.toronto.edu」—— 三条纯联系行全被放行。
// 根因不是黑名单少列了几个词，而是判据方向错了：黑名单永远列不全，等于把「确定是署名」
// 松成了「不排除是署名」。同一份核查也给了翻转方式（删掉 University 一词，第三条立刻变丢弃），
// 证明旧判定完全押在黑名单完整性上。
//
// 第二版（现行）改成正向白名单，只认一件事：**邮箱的本地部分和块里的人名对得上**。
//   - 真正的署名行，邮箱必然由某个作者名派生（avaswani@ ⊃ Vaswani、jeff@ ← Jeffrey、
//     rsg@ ← R. Stockton Gaines 的缩写）—— 这是署名行的定义性特征。
//   - 联系行的邮箱是岗位名（support@ / info@ / editor@），和块里的任何词都对不上，
//     哪怕块里凑出一堆大写词也没用。
// 这样判据不再依赖「穷举所有单位词」，而是依赖「邮箱与名字是否同源」，方向反过来了。
//
// 【代价，如实记下】这条判据不可能写成纯正则——它要比较邮箱本地部分与块内人名的对应关系。
// 所以设计铁律①（规则是数据）在这里退了一步：**规则表仍是数据，但 unless 的判据逻辑是代码**，
// 通过具名谓词（unless: "byline"）引用，外部 JSON 可以整条关掉或换成自己的正则。
// 加一类新脏内容仍然只需加一条 JSON；只有「新增一种保留理由」才需要加一个谓词。
const ORG_STOP = new Set(
  [
    "Google", "Brain", "Research", "University", "Institute", "Department", "Laboratory", "Lab",
    "College", "School", "Academy", "Center", "Centre", "Inc", "Ltd", "Corp", "Corporation",
    "Company", "Group", "Team", "Division", "Foundation", "Society", "Association",
    "Laboratories", "Universidad", "Università", "Universität",
  ].map((w) => w.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase())
);

// 角色邮箱：这是「纯联系行」的本质特征 —— 本地部分不是人名而是岗位。
// 与旧黑名单不同，这张表小、封闭、稳定：邮箱命名惯例就那么几十个，不像单位名无穷无尽。
const ROLE_LOCAL = new Set(
  [
    "postmaster", "hostmaster", "webmaster", "abuse", "noreply", "donotreply", "admin", "administrator",
    "support", "help", "helpdesk", "info", "information", "contact", "contactus", "sales", "marketing",
    "press", "media", "office", "enquiries", "inquiries", "service", "services", "mail", "email",
    "editor", "editors", "editorial", "team", "hr", "jobs", "careers", "billing", "accounts", "finance",
    "legal", "privacy", "security", "feedback", "complaints", "subscribe", "unsubscribe", "news",
    "newsletter", "events", "workshop", "conference", "chair", "program", "secretariat", "registrar",
    "admission", "admissions", "library", "reception", "frontdesk", "general", "hello",
    "permissions", "submissions", "copyright", "publisher", "reprints", "ordering", "orders",
  ]
);

const EMAIL_TOKEN = /[\w.+-]+@[\w-]+\.[\w.]{2,}/g;

const normWord = (s) =>
  String(s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");

// `{jdoe, jsmith}@cs.stanford.edu` 这类合署邮箱拆成单个邮箱：学术论文极常见，
// 不拆会把一条真署名行误判成联系行（实测用例 C 第一版就栽在这里）。
function explodeEmails(text) {
  const out = [];
  const groupRe = /\{\s*([^{}]+?)\s*\}\s*@\s*([\w.-]+)/g;
  let m;
  let rest = String(text);
  while ((m = groupRe.exec(rest))) {
    for (const part of m[1].split(/[,;]/)) {
      const local = part.trim().replace(/^[<>"']|[<>"']$/g, "");
      if (local) out.push(`${local}@${m[2]}`);
    }
  }
  rest = rest.replace(groupRe, " ");
  return out.concat(rest.match(EMAIL_TOKEN) || []);
}

function isRoleMailbox(localRaw) {
  const l = String(localRaw).toLowerCase();
  if (ROLE_LOCAL.has(l)) return true;
  const parts = l.split(/[._\-+]/).filter(Boolean);
  if (parts.some((p) => ROLE_LOCAL.has(p))) return true;
  for (const r of ROLE_LOCAL) {
    if (r.length >= 5 && l.startsWith(r)) return true; // support123 / info2024
  }
  return false;
}

// 署名行判据：块里邮箱的本地部分能与块内人名对上（缩写式也算）。
export function isBylineBlock(text) {
  const t = String(text ?? "");
  const emails = explodeEmails(t);
  if (!emails.length) return false;

  // 域名片段不算人名（挡掉 google-brain@google.com 这种「自己跟自己对上」）
  const domainWords = new Set();
  for (const e of emails) {
    for (const w of String(e.split("@")[1] || "").split(/[.\-_0-9]/)) {
      const n = normWord(w);
      if (n.length >= 2) domainWords.add(n);
    }
  }

  const names = [];
  const initials = [];
  const re = /\b[A-Z][\p{L}'’.\-]{0,30}/gu;
  let m;
  while ((m = re.exec(t))) {
    const raw = m[0];
    const bare = raw.replace(/[.'’\-]+$/, "");
    // "R. Stockton Gaines" 里的 "R." —— 单字母不单独当人名，但要进缩写池，
    // 否则 rsg@ 这种「首字母缩写」邮箱永远对不上（实测用例栽过一次）。
    if (normWord(bare).length === 1) {
      const ch = normWord(bare)[0];
      if (ch) initials.push(ch);
      continue;
    }
    const n = normWord(bare);
    if (!n.length) continue;
    if (ORG_STOP.has(n) || domainWords.has(n)) continue;
    if (n.length >= 3) {
      names.push(n);
      initials.push(n[0]);
    }
  }
  if (!names.length) return false;

  const initialsStr = initials.join("");
  for (const e of emails) {
    const localRaw = e.split("@")[0];
    if (isRoleMailbox(localRaw)) continue;
    const local = normWord(localRaw);
    if (local.length < 3) {
      // 极短本地部分只可能是缩写邮箱（rsg@）
      if (local.length >= 2 && initialsStr.includes(local)) return true;
      continue;
    }
    for (const n of names) {
      if (local === n) return true;
      if (local.includes(n)) return true;      // avaswani ⊃ vaswani
      if (n.startsWith(local)) return true;    // jeff ← Jeffrey
    }
    if (local.length <= 5 && initialsStr.includes(local)) return true; // rsg ↔ R. Stockton Gaines
  }
  return false;
}

// unless 的具名谓词。外部 JSON 里写 unless: "byline" 即可引用；
// 写别名字符串仍当正则处理（向后兼容旧规则表）。
const NAMED_PREDICATES = { byline: isBylineBlock };
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
    // unless：署名行不能丢。实测（CP2 对照抓到）attention 的 8 块「作者姓名 + 单位 + 邮箱」被整块
    // 丢掉后，问「这篇论文的作者是谁」前 3 条全是参考文献——比不过滤更糟。
    // 现行判据 "byline" = 邮箱本地部分与块内人名同源（见文件上方 O1 注释）。
    // 早先的黑名单式判据会把「contact: support@example.com」这类联系行放进来，已废弃。
    unless: "byline",
    note: "纯联系邮箱行（无署名的邮箱清单）。带姓名的署名行由 unless 放行——那份行载着作者身份，丢了就问不出作者是谁。",
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

// unless：命中保留判据的块不丢。编译期一并处理，缺省无这项。
// 支持两种写法：
//   unless: "byline"            → 引用具名谓词（比较型判据，纯正则表达不了）
//   unless: "(?i)Firstname"     → 旧写法，当正则处理（外部 JSON 兼容）
const withUnless = (r) => {
  if (!r.unless) return r;
  const pred = NAMED_PREDICATES[r.unless];
  if (pred) return { ...r, unlessFn: pred, unlessKind: r.unless };
  try { return { ...r, unlessRe: new RegExp(r.unless, r.flags || "iu") }; }
  catch (e) { console.error(`⚠ 规则 ${r.id} 的 unless 正则非法，本次当成没有保留项：${e.message}`); return r; }
};

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

  const compiled = compileRules(rules || DEFAULT_RULES).map(anchored).map(withUnless);
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
      // unless：这一条虽然命中，但它同时具备 should-keep 的特征（如邮箱行里带着作者姓名）→ 放行
      if (r.unlessFn) {
        if (r.unlessFn(v)) continue;
      } else if (r.unlessRe && r.unlessRe.test(v)) continue;
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
