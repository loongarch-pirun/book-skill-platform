// 留出集草稿生成器（工作区工具，不进 r4）
// 独立性硬规矩：只读「素材抽取记录.json」，该文件由 library/*.db 的只读 SELECT 产出。
// 本脚本全程不调用 hybridSearch / routeAndSearch / quality-gate，不看任何检索分数。
const fs = require("node:fs");
const path = require("node:path");

const MAT = path.join(__dirname, "素材抽取记录.json");
const OUT = path.join(__dirname, "holdout-DRAFT.json");
const mat = JSON.parse(fs.readFileSync(MAT, "utf8"));

const DRAFTED = new Date().toISOString();
const ORIGIN = "只读 SELECT chunks.text；起草阶段零检索调用";
const NO_TOPIC = new Set([
  "低压电器检测实训报告（带表格样例）.docx",
]);

// i = 素材索引；i=null 表示无答案句（拒答 / 歧义题）
const D = [
  { i: 2,  q: "In Dynamo, what do the values of W and R affect?", g: ["W and R", "availability", "durability", "consistency"], kind: "answerable", lang: "en" },
  { i: 2,  q: "Dynamo 论文里，W 和 R 这两个参数的取值会影响什么？", g: ["W and R", "availability", "durability"], kind: "answerable", lang: "cross" },
  { i: 4,  q: "Why does Lamport say the converse condition cannot be expected to hold?", g: ["converse condition", "imply"], kind: "answerable", lang: "en" },
  { i: 8,  q: "How can the input splits be processed in MapReduce?", g: ["M splits", "parallel", "different machines"], kind: "answerable", lang: "en" },
  { i: 9,  q: "MapReduce 的使用者需要自己指定什么数量？", g: ["reduce tasks", "output files"], kind: "answerable", lang: "cross" },
  { i: 12, q: "What does multi-head attention replace?", g: ["Multi-Head Attention", "single attention function"], kind: "answerable", lang: "en" },
  { i: 16, q: "《道德经》第十五章开头，用哪两个词形容「古之善為士者」？", g: ["微妙玄通", "深不可識"], kind: "answerable", lang: "zh" },
  { i: 18, q: "「聖人常無心」的下一句是什么？", g: ["以百姓心為心"], kind: "answerable", lang: "zh" },
  { i: 20, q: "What does the narrator say is less changeable than the accidents of life?", g: ["feelings of human nature", "accidents of life"], kind: "answerable", lang: "en" },
  { i: 23, q: "《弗兰肯斯坦》里，巡回审判季快到时，叙述者已经在牢里待了多久？", g: ["three months", "assizes"], kind: "answerable", lang: "cross" },
  { i: 24, q: "子貢問「貧而無諂，富而無驕，何如」，孔子怎麼答？", g: ["未若貧而樂", "富而好禮"], kind: "answerable", lang: "zh" },
  { i: 29, q: "孟子说「人皆有不忍人之心」，举了什么例子来证明？", g: ["孺子將入於井", "怵惕惻隱"], kind: "answerable", lang: "zh" },
  { i: 33, q: "What happened to John Reed at college?", g: ["John Reed", "college"], kind: "answerable", lang: "en" },
  { i: 36, q: "《简爱》里，除了 Mr. Rivers，这句话还跟谁打招呼？", g: ["Carlo", "Mr. Rivers"], kind: "answerable", lang: "cross" },
  { i: 41, q: "According to this passage, when was the clergyman recommended to Lady Catherine de Bourgh?", g: ["Hunsford", "Lady Catherine", "vacant"], kind: "answerable", lang: "en" },
  { i: 37, q: "At which church was the wedding to take place?", g: ["St. Saviour", "King's Cross"], kind: "answerable", lang: "en" },

  { i: null, book: "lunyu-xueer-zh.docx", q: "《論語·學而》里有专门讲量子计算的章节吗？", g: [], expect: "refusal", kind: "refusal", lang: "zh" },
  { i: null, book: "Dynamo-亚马逊高可用键值存储-2007.pdf", q: "Dynamo 论文给出 Kubernetes 的部署 yaml 了吗？", g: [], expect: "refusal", kind: "refusal", lang: "cross" },
  { i: null, book: "daodejing-zh.docx", q: "《道德经》第六十一章提到比特币价格了吗？", g: [], expect: "refusal", kind: "refusal", lang: "zh" },
  { i: null, book: "低压电器检测实训报告（带表格样例）.docx", q: "这份检测报告里有 5G 基站的检测数据吗？", g: [], expect: "refusal", kind: "refusal", lang: "zh" },
  { i: null, book: "frankenstein-en.epub", q: "《弗兰肯斯坦》里出现智能手机了吗？", g: [], expect: "refusal", kind: "refusal", lang: "cross" },
  { i: null, book: "MapReduce-谷歌大规模分布式处理-2004.pdf", q: "MapReduce 论文规定了公司年终奖发放标准吗？", g: [], expect: "refusal", kind: "refusal", lang: "cross" },
  { i: null, book: "pride-and-prejudice-en.epub", q: "《傲慢与偏见》里写了多少行 Python 代码？", g: [], expect: "refusal", kind: "refusal", lang: "cross" },
  { i: null, book: "attention-is-all-you-need-en.pdf", q: "Attention Is All You Need 里给出了食堂菜单吗？", g: [], expect: "refusal", kind: "refusal", lang: "cross" },

  { i: null, book: null, q: "这本书的作者是谁？", g: [], expect: "ambiguous", kind: "ambiguous", lang: "zh" },
  { i: null, book: null, q: "书里说的「一致性」是怎么保证的？", g: [], expect: "ambiguous", kind: "ambiguous", lang: "zh" },
  { i: null, book: null, q: "「學而時習之」出自哪一章？", g: [], expect: "ambiguous", kind: "ambiguous", lang: "zh" },
  { i: null, book: null, q: "第一章里出现的那个人名是谁？", g: [], expect: "ambiguous", kind: "ambiguous", lang: "zh" },

  { i: 25, q: "《論語·學而第一》开篇第一章，孔子说的第一句是什么？", g: ["學而時習之", "不亦說乎"], kind: "newbook", lang: "zh" },
  { i: 46, q: "介电强度试验里那台不合格样品，是在多少电压下击穿的？", g: ["1.8 kV", "2.0 kV"], kind: "newbook", lang: "zh" },
];

const items = D.map((d, n) => {
  const m = d.i === null ? null : mat[d.i];
  if (d.i !== null && !m) throw new Error(`素材索引不存在: ${d.i}`);
  const book = m ? m.book : d.book;
  const a = m ? m.text.replace(/\r/g, "").slice(0, 260).trim() : null;
  return {
    id: "H" + String(n + 1).padStart(2, "0"),
    q: d.q,
    book,
    bookId: book,
    kind: d.kind,
    a,
    g: d.g,
    expect: d.expect || null,
    lang: d.lang,
    hasTopicJson: book ? !NO_TOPIC.has(book) : null,
    chunk_id: m ? m.chunk_id : null,
    source: { origin: ORIGIN, draftedAt: DRAFTED, frozenAt: null, reviewedBy: null },
  };
});

const byKind = {};
for (const it of items) byKind[it.kind] = (byKind[it.kind] || 0) + 1;
const byLang = {};
for (const it of items) byLang[it.lang] = (byLang[it.lang] || 0) + 1;

const set = {
  setId: "holdout-v1-DRAFT",
  status: "DRAFT",
  frozen: false,
  draftedAt: DRAFTED,
  frozenAt: null,
  reviewedBy: null,
  selfReviewed: true,
  selfReviewedAt: DRAFTED,
  revision: "v1.1 自答复核：答案句 160→260 字，收紧 H07/H13/H15/H16 四题措辞",
  total: items.length,
  byKind,
  byLang,
  sourcePolicy: "答案句逐字取自 library/*.db 的 chunks.text；起草阶段零检索调用、零分数可见",
  nextStep: "爸爸复核后，由富江写入 r4 的 test/holdout/sets/ 并生成 frozen.json",
  items,
};

fs.writeFileSync(OUT, JSON.stringify(set, null, 1), "utf8");

// 出题自检：答案句必须在原文块里；金词至少一个落在答案句内（some 语义，同 keywordOnlyJudge）
const warn = [];
for (const it of items) {
  if (!it.a) continue;
  const m = mat.find((x) => x.book === it.book && x.chunk_id === it.chunk_id);
  if (!m || !m.text.replace(/\r/g, "").includes(it.a)) warn.push(`${it.id} 答案句不回源`);
  const low = it.a.toLowerCase();
  if (it.g.length && !it.g.some((k) => low.includes(k.toLowerCase()))) warn.push(`${it.id} 金词全不在答案句内`);
}
console.log("生成:", OUT);
console.log("题数:", items.length, "| 题型:", JSON.stringify(byKind), "| 语种:", JSON.stringify(byLang));
console.log("覆盖书数:", new Set(items.map((x) => x.book).filter(Boolean)).size);
console.log("无主题清单书题数:", items.filter((x) => x.hasTopicJson === false).length);
console.log("出题自检警告:", warn.length ? warn.join(" ; ") : "0（全部回源且金词命中）");
