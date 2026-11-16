#!/usr/bin/env node
/**
 * 起草 v2 卷：30 题（answerable 14 + newbook 2 + refusal 8 + ambiguous 4）
 * 答案句不手写——从库里按「起始标记」自动切 260 字，保证与原文逐字一致。
 * 跑法：node 起草v2.cjs
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const R4 = "C:/Users/JIANG XIAO HUA/Desktop/book-skill-platform-r4";
const r4require = createRequire(path.join(R4, "package.json"));
const Database = r4require("better-sqlite3");
const LIB = path.join(R4, "library");
const HERE = __dirname;

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// ---- 16 道有答案的题：书 / 块 / 起始标记 / 题干 / 金词 / 类型 / 语言 ----
const ANSWERABLE = [
  // Dynamo（2）
  { book: "Dynamo-亚马逊高可用键值存储-2007.pdf", chunk: 60, at: "partitioning scheme relies on consistent hashing",
    q: "In Dynamo, what does the partitioning scheme rely on to distribute load across storage hosts?",
    g: ["consistent hashing", "ring"], kind: "answerable", lang: "en" },
  { book: "Dynamo-亚马逊高可用键值存储-2007.pdf", chunk: 122, at: "timestamp based reconciliation logic",
    q: "Dynamo 遇到同一对象的版本分歧时，用什么办法决定哪一版算数？",
    g: ["last write wins", "timestamp"], kind: "answerable", lang: "cross" },
  // Lamport（1）
  { book: "Lamport-时间时钟与分布式系统排序-1978.pdf", chunk: 37, at: "we use any arbitrary total ordering",
    q: "Lamport 说当两个事件拿到同一个时钟值时，靠什么打破平局？",
    g: ["arbitrary total ordering", "processes"], kind: "answerable", lang: "en" },
  // MapReduce（2）
  { book: "MapReduce-谷歌大规模分布式处理-2004.pdf", chunk: 35, at: "Completed reduce tasks do not need",
    q: "机器故障之后，已经完成的 reduce 任务为什么不需要重跑？",
    g: ["global file system"], kind: "answerable", lang: "cross" },
  { book: "MapReduce-谷歌大规模分布式处理-2004.pdf", chunk: 68, at: "Some counter values are automatically maintained",
    q: "MapReduce 里哪一类计数值是库自己维护的？",
    g: ["counter", "key/value pairs"], kind: "answerable", lang: "cross" },
  // attention（1）
  { book: "attention-is-all-you-need-en.pdf", chunk: 28, at: "We suspect that for large values",
    q: "Why are the dot products scaled by one over the square root of d_k?",
    g: ["softmax", "gradients"], kind: "answerable", lang: "en" },
  // 道德经（2）
  { book: "daodejing-zh.docx", chunk: 25, at: "人法地，地法天",
    q: "「人法地，地法天」后面接着说什么？",
    g: ["天法道", "道法自然"], kind: "answerable", lang: "zh" },
  { book: "daodejing-zh.docx", chunk: 50, at: "善攝生者",
    q: "第五十章说「善攝生者」走路不会遇到什么、入军不会被什么伤到？",
    g: ["兕虎", "甲兵"], kind: "answerable", lang: "zh" },
  // Frankenstein（1）
  { book: "frankenstein-en.epub", chunk: 243, at: "We entered the gloomy prison chamber",
    q: "维克多和伊丽莎白走进牢房时，贾斯汀坐在什么上面？",
    g: ["straw", "manacled"], kind: "answerable", lang: "cross" },
  // 论语 docx（1）
  { book: "lunyu-xueer-zh.docx", chunk: 4, at: "吾日三省吾身",
    q: "曾子每天拿哪三件事反省自己？",
    g: ["爲人謀", "與朋友交", "傳不習"], kind: "answerable", lang: "zh" },
  // 孟子（1）
  { book: "mengzi-zh.docx", chunk: 138, at: "故說詩者，不以文害辭",
    q: "孟子认为解说《诗》的正确做法是什么？",
    g: ["以意逆志", "不以文害辭"], kind: "answerable", lang: "zh" },
  // 简爱（1）
  { book: "pg1260-简爱.epub", chunk: 628, at: "I bolted my door",
    q: "罗切斯特追问时，简爱说自己把房门怎么处理了？",
    g: ["bolted my door"], kind: "answerable", lang: "cross" },
  // 傲慢与偏见（1）
  { book: "pride-and-prejudice-en.epub", chunk: 858, at: "Miss Darcy was tall",
    q: "How is Miss Darcy described in comparison with Elizabeth?",
    g: ["tall", "sixteen"], kind: "answerable", lang: "en" },
  // 福尔摩斯（1）
  { book: "pg1661-福尔摩斯冒险史.epub", chunk: 693, at: "By profession I am a hydraulic engineer",
    q: "《工程师拇指案》里那位访客的职业是什么？",
    g: ["hydraulic engineer"], kind: "answerable", lang: "cross" },
  // Lamport 第二题（补充，保持 answerable=16）
  { book: "Lamport-时间时钟与分布式系统排序-1978.pdf", chunk: 63, at: "This is stronger than the ordinary Clock Condition",
    q: "Why is the Strong Clock Condition not in general satisfied by logical clocks?",
    g: ["stronger relation", "logical clocks"], kind: "answerable", lang: "en" },
  // 孟子第二题
  { book: "mengzi-zh.docx", chunk: 30, at: "我學不厭而教不倦也",
    q: "子贡问孔子「夫子聖矣乎」，孔子自己怎么回答？",
    g: ["學不厭", "教不倦"], kind: "answerable", lang: "zh" },
  // newbook（2）：新入库的两本
  { book: "低压电器检测实训报告（带表格样例）.docx", chunk: 7, at: "总体合格率",
    q: "这批 36 台样本的总体合格率是多少？",
    g: ["91.7%"], kind: "newbook", lang: "zh" },
  { book: "lunyu-xueer-zh.pdf", chunk: 3, at: "愼終追遠",
    q: "曾子说「愼終追遠」会带来什么结果？",
    g: ["民德歸厚"], kind: "newbook", lang: "zh" },
];

// ---- 8 道拒答题：书里确实没有的话题（absent 词已核全库 0 命中）----
const REFUSAL = [
  { book: "lunyu-xueer-zh.docx", q: "《論語·學而》里有讲怎么配置 Docker 容器吗？", absent: ["Docker"] },
  { book: "Dynamo-亚马逊高可用键值存储-2007.pdf", q: "Dynamo 论文里给出了 Blender 三维渲染的参数吗？", absent: ["Blender"] },
  { book: "daodejing-zh.docx", q: "《道德经》里有讲怎么调试 JavaScript 代码吗？", absent: ["JavaScript"] },
  { book: "frankenstein-en.epub", q: "《弗兰肯斯坦》里提到过 Wi-Fi 吗？", absent: ["Wi-Fi"] },
  { book: "MapReduce-谷歌大规模分布式处理-2004.pdf", q: "MapReduce 论文规定了员工年假天数吗？", absent: ["年假"] },
  { book: "pride-and-prejudice-en.epub", q: "《傲慢与偏见》里出现了信用卡账单吗？", absent: ["信用卡"] },
  { book: "attention-is-all-you-need-en.pdf", q: "Attention 这篇论文给出了显卡超频设置吗？", absent: ["超频"] },
  { book: "低压电器检测实训报告（带表格样例）.docx", q: "这份检测报告里有电动汽车充电桩的试验数据吗？", absent: ["充电桩"] },
];

// ---- 4 道歧义题：不点书名，多本可答 ----
const AMBIGUOUS = [
  { q: "刚才提到的那段话，是哪本书里写的？" },
  { q: "「道」到底是什么意思？" },
  { q: "作者当初为什么要写这本书？" },
  { q: "里面那个实验具体是怎么做的？" },
];

// ---------- 生成 ----------
function chunkText(book, id) {
  const db = new Database(path.join(LIB, book + ".db"), { readonly: true });
  const r = db.prepare("SELECT text FROM chunks WHERE id = ?").get(id);
  db.close();
  if (!r) throw new Error(`${book} 没有块 ${id}`);
  return norm(r.text);
}

const items = [];
let n = 0;
const pad = (i) => "V" + String(i).padStart(2, "0");

for (const it of ANSWERABLE) {
  n++;
  const text = chunkText(it.book, it.chunk);
  const idx = text.indexOf(it.at);
  if (idx < 0) throw new Error(`${it.book}#${it.chunk} 找不到起始标记「${it.at}」`);
  const a = text.slice(idx, idx + 260);
  for (const g of it.g) {
    if (!a.toLowerCase().includes(String(g).toLowerCase())) throw new Error(`${pad(n)} 金词「${g}」不在答案句里`);
  }
  items.push({
    id: pad(n), q: it.q, book: it.book, bookId: it.book,
    kind: it.kind, a, g: it.g, expect: null, lang: it.lang, chunk_id: it.chunk,
  });
}
for (const it of REFUSAL) {
  n++;
  items.push({ id: pad(n), q: it.q, book: it.book, bookId: it.book, kind: "refusal", a: null, g: [], absent: it.absent, expect: "refusal", lang: "zh", chunk_id: null });
}
for (const it of AMBIGUOUS) {
  n++;
  items.push({ id: pad(n), q: it.q, book: null, bookId: null, kind: "ambiguous", a: null, g: [], expect: "ambiguous", lang: "zh", chunk_id: null });
}

// 语言分布：zh = 中文问中文书；cross = 中文问英文书（跨语言，最难档）；en = 英文问英文书。
// 一律由「题干有没有汉字 × 书名有没有汉字」推，不手填，避免标签与实际不符。
const CJK = /[\u4e00-\u9fff]/;
// 书的内容语言：读 meta.lang，读不到按书名有没有汉字兜底（不能用书名判断正文语言！）
function contentLang(book) {
  try {
    const db = new Database(path.join(LIB, book + ".db"), { readonly: true });
    const r = db.prepare("SELECT value FROM meta WHERE key='lang'").get();
    db.close();
    if (r?.value) return r.value;
  } catch { /* 坏库按书名兜底 */ }
  return CJK.test(book) ? "zh" : "en";
}
const LANG = new Map();
for (const it of items) if (it.book && !LANG.has(it.book)) LANG.set(it.book, contentLang(it.book));
for (const it of items) {
  if (!it.book) { it.lang = "zh"; continue; }          // 歧义题没有目标书
  const zhBook = LANG.get(it.book) === "zh";
  it.lang = CJK.test(it.q) ? (zhBook ? "zh" : "cross") : (zhBook ? "cross" : "en");
}

const byKind = {};
const byLang = {};
for (const it of items) {
  byKind[it.kind] = (byKind[it.kind] || 0) + 1;
  byLang[it.lang] = (byLang[it.lang] || 0) + 1;
}

const set = {
  setId: "holdout-v2",
  status: "DRAFT",
  frozen: false,
  draftedAt: new Date().toISOString(),
  selfReviewed: false,
  selfReviewedAt: null,
  frozenAt: null,
  reviewedBy: null,
  revision: "v2.1 首版：30 题，与 v1 零重复块、零重复题干；四类配比与 v1 相同",
  total: items.length,
  byKind,
  byLang,
  sourcePolicy: "答案句按「起始标记」从 chunks.text 自动切 260 字，保证逐字一致；起草阶段零检索调用",
  designNote: "出题时已知 v1 的三道漏题（H05/H06/H16）——本题库只有 13 本，知识点天然重叠，只能保证「不复用同一块原文、不复用同一句题干」，无法保证「不知道 v1 的错在哪」。此风险已如实登记。",
  items,
};

fs.writeFileSync(path.join(HERE, "holdout-v2-DRAFT.json"), JSON.stringify(set, null, 1) + "\n");
console.log("已生成 holdout-v2-DRAFT.json");
console.log("题数:", items.length, JSON.stringify(byKind), JSON.stringify(byLang));
for (const it of items) {
  console.log(`${it.id} [${it.kind}/${it.lang}] ${it.q.slice(0, 40)}${it.a ? "  → " + it.a.slice(0, 40) : ""}`);
}
