// v2 金标准评测（考卷）：跨语言问答题 × 自动判分
// 用法: node test/v2-eval.mjs [--rerank off|on|both]
// 判分规则：top4 结果里出现金标准关键词（任一）算命中
// 引擎一致性：库内 meta.model 必须和当前 BSP_EMBED_MODEL 一致，否则拒绝跑
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import { hybridSearch } from "../src/lib/search.mjs";
import { getEmbedder, DEFAULT_EMBED } from "../src/lib/models.mjs";

const LIB = path.join(import.meta.dirname, "..", "library");

const GOLDEN = [
  // ===== 论语·学（繁体版原文，金标准用书中原字） =====
  { book: "lunyu-xueer-zh.docx", q: "学了之后经常温习会怎么样", g: ["不亦說乎"] },
  { book: "lunyu-xueer-zh.docx", q: "别人不了解我我也不生气，算怎样的人", g: ["不亦君子乎"] },
  { book: "lunyu-xueer-zh.docx", q: "君子专心做人的根本，根本立住了会怎样", g: ["本立而道生"] },
  { book: "lunyu-xueer-zh.docx", q: "曾子每天反省自己的哪几件事", g: ["吾日三省", "三省"] },
  { book: "lunyu-xueer-zh.docx", q: "治理一个大国要怎么做", g: ["使民以時"] },
  { book: "lunyu-xueer-zh.docx", q: "年轻人怎么对待父母兄长和朋友", g: ["汎愛眾", "愛眾", "弟子入則孝"] },
  { book: "lunyu-xueer-zh.docx", q: "礼的运用以什么为贵", g: ["禮之用"] },
  { book: "lunyu-xueer-zh.docx", q: "不担心别人不了解自己，该担心什么", g: ["患不知人"] },
  { book: "lunyu-xueer-zh.docx", q: "贫穷不谄媚富贵不骄傲，更好的境界是什么", g: ["貧而樂", "貧而無諂"] },
  // ===== 道德经（繁体校勘版原文，金标准用书中原字） =====
  { book: "daodejing-zh.docx", q: "可以说出来的道就不是永恒的道吗", g: ["非常道", "非恆道"] },
  { book: "daodejing-zh.docx", q: "最高的善像什么", g: ["水善利萬", "上善若水"] },
  { book: "daodejing-zh.docx", q: "了解别人叫聪明，了解自己叫什么", g: ["自知者明"] },
  { book: "daodejing-zh.docx", q: "再远的路从哪里开始", g: ["始於足下"] },
  { book: "daodejing-zh.docx", q: "天下最柔弱的东西是什么", g: ["莫柔弱於水"] },
  { book: "daodejing-zh.docx", q: "治理大国像做什么菜", g: ["烹小鮮"] },
  { book: "daodejing-zh.docx", q: "功业成就之后怎么办才符合天道", g: ["功遂身退"] },
  { book: "daodejing-zh.docx", q: "杯子装满了不如怎样", g: ["不如其已"] },
  { book: "daodejing-zh.docx", q: "缤纷的颜色动听的音乐厚味让人怎样", g: ["目盲", "耳聾", "口爽"] },
  // ===== Attention 论文 =====
  { book: "attention-is-all-you-need-en.pdf", q: "what kind of model does the paper propose that uses only attention", g: ["transformer"] },
  { book: "attention-is-all-you-need-en.pdf", q: "how many GPUs were used for training the big model", g: ["p100"] },
  { book: "attention-is-all-you-need-en.pdf", q: "which translation benchmark is used for english to german", g: ["wmt 2014", "wmt"] },
  { book: "attention-is-all-you-need-en.pdf", q: "what BLEU score did the big model get on english to german", g: ["28.4"] },
  { book: "attention-is-all-you-need-en.pdf", q: "what functions encode token positions", g: ["sine", "cosine"] },
  { book: "attention-is-all-you-need-en.pdf", q: "how long does one training step take on the big model", g: ["0.4"] },
  { book: "attention-is-all-you-need-en.pdf", q: "which convolutional sequence models are cited as prior work", g: ["convs2s", "bytenet"] },
  { book: "attention-is-all-you-need-en.pdf", q: "论文里的缩放点积注意力是什么", g: ["dot-product", "scaled"] },
  { book: "attention-is-all-you-need-en.pdf", q: "这篇论文用了几张显卡训练", g: ["p100"] },
  // ===== Frankenstein =====
  { book: "frankenstein-en.epub", q: "who writes the letters that open the novel", g: ["walton"] },
  { book: "frankenstein-en.epub", q: "who is falsely accused of william's murder", g: ["justine"] },
  { book: "frankenstein-en.epub", q: "who teaches the creature language in the cottage", g: ["felix"] },
  { book: "frankenstein-en.epub", q: "what does the creature ask victor to create for him", g: ["companion", "female"] },
  { book: "frankenstein-en.epub", q: "which university does victor attend", g: ["ingolstadt"] },
  { book: "frankenstein-en.epub", q: "which outdated philosopher's work first inspires victor", g: ["agrippa"] },
  { book: "frankenstein-en.epub", q: "怪物最后说要把自己怎么样", g: ["flames", "pyre"] },
  { book: "frankenstein-en.epub", q: "弗兰肯斯坦在哪个城市读大学", g: ["ingolstadt"] },
  // ===== 傲慢与偏见 =====
  { book: "pride-and-prejudice-en.epub", q: "what is the famous opening sentence about", g: ["truth universally acknowledged"] },
  { book: "pride-and-prejudice-en.epub", q: "how many daughters does the bennet family have", g: ["five"] },
  { book: "pride-and-prejudice-en.epub", q: "whom does mr collins marry after being rejected", g: ["charlotte"] },
  { book: "pride-and-prejudice-en.epub", q: "who finds lydia and wickham in london", g: ["gardiner"] },
  { book: "pride-and-prejudice-en.epub", q: "what is mr darcy's estate called", g: ["pemberley"] },
  // 判分注：Caroline Bingley 在书中多以 "Miss Bingley" 出现（同一人两种原文写法），
  // 最佳答案块（如第11章"Miss Bingley's civility"）不含字面 caroline → 判卷接受两种表面形式
  { book: "pride-and-prejudice-en.epub", q: "who tries to separate jane and bingley", g: ["caroline", "miss bingley"] },
  { book: "pride-and-prejudice-en.epub", q: "达西先生的庄园叫什么名字", g: ["pemberley"] },
  { book: "pride-and-prejudice-en.epub", q: "what legal arrangement means the estate passes to collins", g: ["entail"] },
];

const args = process.argv.slice(2);
const ri = args.indexOf("--rerank");
const mode = ri >= 0 ? args[ri + 1] : "both";
const TOPN = 4;

// 1) 校验金标准真的在书里（防止我记错原文导致误判）
const valid = [];
for (const e of GOLDEN) {
  const f = fs.readdirSync(LIB).find(x => x.startsWith(e.book) && x.endsWith(".db"));
  if (!f) { console.log(`[丢弃] ${e.book}: 找不到库文件`); continue; }
  const db = new Database(path.join(LIB, f), { readonly: true });
  const ok = e.g.some(g => db.prepare("SELECT COUNT(*) n FROM chunks WHERE instr(lower(text), lower(?)) > 0").get(g).n > 0);
  db.close();
  if (ok) valid.push({ ...e, file: f });
  else console.log(`[丢弃] 「${e.q}」金标准 ${e.g.join("/")} 不在书里（我记错原文了）`);
}
console.log(`有效题数: ${valid.length}/${GOLDEN.length}（引擎: ${DEFAULT_EMBED}）\n`);

// 2) 引擎一致性检查
const activeKey = (await getEmbedder()).key;
const dbModels = [...new Set(valid.map(e => {
  const db = new Database(path.join(LIB, e.file), { readonly: true });
  const m = db.prepare("SELECT value FROM meta WHERE key='model'").get()?.value || "(无)";
  db.close();
  return m;
}))];
// 旧库（v1 时代）没写模型名，历史事实是全部用 zh-small 灌的
const legacyOk = dbModels.every(m => m === activeKey || (m === "(无)" && activeKey === "zh-small"));
if (!legacyOk) {
  console.error(`引擎不一致！库里是 [${dbModels.join(",")}]，当前查询用 ${activeKey}。先用 embed-book.js 把库灌成 ${activeKey} 再跑评测。`);
  process.exit(1);
}

// 3) 跑卷子
const judge = (results, goldens) => {
  const low = results.map(r => r.text.toLowerCase());
  for (let i = 0; i < low.length; i++) {
    const g = goldens.find(x => low[i].includes(x.toLowerCase()));
    if (g) return { hit: true, rank: i + 1, golden: g };
  }
  return { hit: false };
};

for (const rr of mode === "both" ? [false, true] : [mode === "on"]) {
  let hits = 0, latSum = 0, rankSum = 0, latMax = 0;
  const perBook = new Map();
  const misses = [];
  for (const e of valid) {
    const t0 = Date.now();
    const rs = await hybridSearch(path.join(LIB, e.file), e.q, TOPN, { rerank: rr });
    const lat = Date.now() - t0;
    latSum += lat; latMax = Math.max(latMax, lat);
    const { hit, rank } = judge(rs, e.g);
    if (hit) { hits++; rankSum += rank; } else misses.push(e.q);
    const b = perBook.get(e.book) || { n: 0, hit: 0 };
    b.n++; if (hit) b.hit++;
    perBook.set(e.book, b);
  }
  const rate = (100 * hits / valid.length).toFixed(0);
  console.log(`===== 复试官${rr ? "开" : "关"} =====`);
  for (const [b, s] of perBook) console.log(`  ${b.padEnd(34)} ${s.hit}/${s.n}`);
  console.log(`  总分: ${hits}/${valid.length} = ${rate} 分 | 首次命中平均第 ${(rankSum / Math.max(hits, 1)).toFixed(1)} 名 | 平均延迟 ${(latSum / valid.length).toFixed(0)}ms (最慢 ${latMax}ms)`);
  if (misses.length) console.log(`  漏题: ${misses.join(" | ")}`);
  console.log(`EVAL_RESULT ${JSON.stringify({ model: activeKey, rerank: rr, total: valid.length, hits, rate: +rate, avgLatencyMs: Math.round(latSum / valid.length) })}`);
  console.log("");
}
