// 通用工具：维基文库页面 → 干净 txt（供 txt2docx 转 docx 再建库）
// 用法: node fetch-wikisource.mjs <页面标题> <out.txt> [更多页面标题...]
// 例:   node fetch-wikisource.mjs "孟子/梁惠王上" books/mengzi-zh.txt
//       node fetch-wikisource.mjs "孟子/梁惠王上" "孟子/梁惠王下" ... books/mengzi-zh.txt
// 清洗规则：剥 header/footer/PD-old/Category 模板、onlyinclude 标签、[[链接|显示]]→显示、
//           残留 {{模板}} 整删；页面有 ===N=== 小节的，每节输出一个 "# 篇名·N" 标题行
//           （txt2docx 的 # 约定 → docx Heading → build-book 识别为章节）。
// 说明：维基文库对无 UA 请求限流，自带 UA + 失败重试；多页之间 sleep 1s 讲礼貌。
import fs from "node:fs";

const UA = "book-skill-platform-fetch/1.0 (personal knowledge base book import)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWikitext(title, tries = 5) {
  const url = `https://zh.wikisource.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&format=json&prop=wikitext`;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (!j.parse || !j.parse.wikitext) throw new Error(`页面不存在或无内容: ${title}`);
      return j.parse.wikitext["*"];
    } catch (e) {
      lastErr = e;
      // 429 限流退避要长：15/30/60/90s；其他错误 1.5/3/4.5/6s
      const is429 = String(lastErr.message).includes("429");
      await sleep(is429 ? 15000 * (i + 1) : 1500 * (i + 1));
    }
  }
  throw new Error(`抓取失败 ${title}: ${lastErr.message}`);
}

// wikitext → { sections: [{ label, paras: [] }] }
function cleanWikitext(wt, pageBasename) {
  let s = wt;
  s = s.replace(/\{\{header[\s\S]*?\}\}/g, "");
  s = s.replace(/\{\{footer\}\}/g, "");
  s = s.replace(/\{\{PD-old[^}]*\}\}/g, "");
  s = s.replace(/<\/?onlyinclude>/g, "");
  s = s.replace(/\[\[Category:[^\]]*\]\]/g, "");
  s = s.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1"); // [[目标|显示]] → 显示
  s = s.replace(/\[\[([^\]]*)\]\]/g, "$1"); // [[目标]] → 目标
  s = s.replace(/\{\{[^{}]*\}\}/g, ""); // 残留模板整删（不支持嵌套，维基文库古籍页够用）
  // -{H|zh-hans:简体;zh-hant:繁體}- 中文变体转换标记 → 取繁体（全书繁体路线）；
  // -{云}- 无分支的直接取内容。相邻标记（-{於}--{後}-）逐对剥掉。
  s = s.replace(/-\{([\s\S]*?)\}-/g, (m, inner) => {
    const ht = inner.match(/zh-hant:([^;}]*)/);
    if (ht) return ht[1];
    const last = inner.split(/[;|]/).pop();
    return last.includes(":") ? last.slice(last.indexOf(":") + 1) : last;
  });

  const sections = [];
  let cur = null;
  for (const rawLine of s.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // 维基文库页脚导航行：「上一篇　回目录　下一篇」（部分篇目有，囬録/目录两种写法）——
    // 是模板渲染的导航不是正文，滤掉（漏进去会多出 8 个纯导航垃圾块）
    if (/^上一篇[　\s]*回目[録录]?[　\s]*下一篇$/.test(line)) continue;
    // wiki 分隔线 ---- / ==== 等：篇与篇之间的装饰线，不是正文
    if (/^[-=*_~#]{2,}$/.test(line)) continue;
    const hm = line.match(/^===\s*([^=]+?)\s*===$/);
    if (hm) {
      const label = `${pageBasename}·${hm[1]}`;
      cur = { label, paras: [] };
      sections.push(cur);
      continue;
    }
    if (/^(={2,}|Category:)/.test(line)) continue;
    const para = line.replace(/^　+/, "").trim();
    if (!para) continue;
    if (!cur) cur = { label: pageBasename, paras: [] }, sections.push(cur);
    cur.paras.push(para);
  }
  return sections;
}

const [, , outFile, ...titles] = process.argv;
if (!outFile || titles.length === 0) {
  console.error("用法: node fetch-wikisource.mjs <out.txt> <页面标题> [更多页面标题...]");
  process.exit(1);
}

const lines = [];
let totalParas = 0;
for (const title of titles) {
  const wt = await fetchWikitext(title);
  const basename = title.split("/").pop();
  const secs = cleanWikitext(wt, basename);
  for (const sec of secs) {
    // 只有一个小节且标题==页名时不重复输出标题行（如論語/學而第一 单页一章）
    if (!(secs.length === 1 && sec.label === basename && sec.paras.length)) lines.push(`# ${sec.label}`);
    else if (sec.label !== basename) lines.push(`# ${sec.label}`);
    for (const p of sec.paras) { lines.push(p); totalParas++; }
  }
  console.log(`  ${title}: ${secs.length} 节 / ${secs.reduce((n, x) => n + x.paras.length, 0)} 段`);
  if (titles.indexOf(title) < titles.length - 1) await sleep(2000);
}

fs.writeFileSync(outFile, lines.join("\n") + "\n", "utf8");
console.log(`OK: ${outFile}（${lines.length} 行 / ${totalParas} 正文段）`);
