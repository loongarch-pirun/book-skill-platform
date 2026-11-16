#!/usr/bin/env node
/**
 * v2 卷验真（只读）：五件事逐一核
 *   1) 答案句 a 在指定块里逐字存在
 *   2) 金词 g 全部出现在 a 里
 *   3) 块不复用（与 v1 同书同块 = 0）；题干不与 v1 重复（3-gram Jaccard < 0.5）
 *   4) 拒答题 absent 词全库 0 命中
 *   5) 歧义题多书可答（LIKE 命中书数 ≥2，或命中指代正则）
 * 跑法：node 验真v2.cjs
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const R4 = "C:/Users/JIANG XIAO HUA/Desktop/book-skill-platform-r4";
const r4require = createRequire(path.join(R4, "package.json"));
const Database = r4require("better-sqlite3");
const LIB = path.join(R4, "library");

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const v2 = JSON.parse(fs.readFileSync(path.join(__dirname, "holdout-v2-DRAFT.json"), "utf8"));
const v1 = JSON.parse(fs.readFileSync(path.join(R4, "test/holdout/sets/holdout-v1.json"), "utf8"));

const grams = (s) => {
  const t = norm(s).toLowerCase().replace(/\s/g, "");
  const out = new Set();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
};
const jac = (a, b) => {
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
};

let fail = 0;
const bad = (m) => { console.log("FAIL - " + m); fail++; };
const ok = (m) => console.log("PASS - " + m);

const books = fs.readdirSync(LIB).filter((f) => f.endsWith(".db")).map((f) => f.replace(/\.db$/, ""));

// 1) + 2)
for (const it of v2.items.filter((x) => x.a)) {
  const db = new Database(path.join(LIB, it.book + ".db"), { readonly: true });
  const r = db.prepare("SELECT text FROM chunks WHERE id = ?").get(it.chunk_id);
  db.close();
  if (!r) { bad(`${it.id} 块 ${it.chunk_id} 不存在`); continue; }
  const text = norm(r.text);
  if (!text.includes(norm(it.a))) bad(`${it.id} 答案句不在块 ${it.chunk_id} 里`);
  else ok(`${it.id} 答案句逐字回源（${it.book}#${it.chunk_id}，${norm(it.a).length} 字）`);
  const missing = (it.g || []).filter((g) => !norm(it.a).toLowerCase().includes(String(g).toLowerCase()));
  if (missing.length) bad(`${it.id} 金词不在答案句内：${missing.join("/")}`);
}

// 3) 块复用 + 题干相似度
const used = new Set(v1.items.filter((x) => x.chunk_id).map((x) => `${x.book}#${x.chunk_id}`));
const reuse = v2.items.filter((x) => x.chunk_id && used.has(`${x.book}#${x.chunk_id}`));
reuse.length ? bad(`块复用 ${reuse.length} 处：${reuse.map((x) => x.id).join("/")}`) : ok("块复用 = 0（v2 没碰 v1 用过的任何一块原文）");

let maxJ = 0, maxPair = "";
for (const a of v2.items) for (const b of v1.items) {
  const j = jac(a.q, b.q);
  if (j > maxJ) { maxJ = j; maxPair = `${a.id}~${b.id}`; }
}
maxJ < 0.5 ? ok(`题干最高相似度 ${maxJ.toFixed(3)}（${maxPair}）< 0.5，不与 v1 重复`)
           : bad(`题干过近：${maxPair} Jaccard=${maxJ.toFixed(3)}`);

// 4) absent 词全库 0 命中
for (const it of v2.items.filter((x) => x.kind === "refusal")) {
  const t = it.absent[0];
  const hits = [];
  for (const b of books) {
    const db = new Database(path.join(LIB, b + ".db"), { readonly: true });
    const n = db.prepare("SELECT COUNT(*) c FROM chunks WHERE text LIKE ?").get("%" + t + "%").c;
    db.close();
    if (n) hits.push(`${b}:${n}`);
  }
  hits.length ? bad(`${it.id} 判定词「${t}」在库里有命中：${hits.join(",")}`)
              : ok(`${it.id} 判定词「${t}」全库 0 命中（真拒答）`);
}

// 5) 歧义题
const VAGUE = /(?:这|那|该|此|本)\s*(?:本|篇|个)?\s*(?:书|論文|论文|文章|文檔|文档|教材|報告|报告)|this\s+(?:paper|book|article|document|story|novel)|the\s+(?:paper|book|article)|these\s+notes/i;
const AMB_KW = { V26: ["道"], V28: ["实验", "experiment"], V30: ["实验", "experiment"] };
for (const it of v2.items.filter((x) => x.kind === "ambiguous")) {
  const kw = AMB_KW[it.id];
  if (kw) {
    let n = 0; const hitBooks = [];
    for (const b of books) {
      const db = new Database(path.join(LIB, b + ".db"), { readonly: true });
      let c = 0;
      for (const k of kw) c += db.prepare("SELECT COUNT(*) c FROM chunks WHERE text LIKE ?").get("%" + k + "%").c;
      db.close();
      if (c) { n++; hitBooks.push(b); }
    }
    n >= 2 ? ok(`${it.id} 多书可答（${n} 本命中「${kw.join("/")}」：${hitBooks.slice(0, 4).join(",")}…）`)
           : bad(`${it.id} 只有 ${n} 本书命中，不构成歧义`);
  } else {
    VAGUE.test(it.q) ? ok(`${it.id} 命中指代正则（无指代对象 → 应判 ambiguous）`)
                     : bad(`${it.id} 既无多书关键词、也不命中指代正则`);
  }
}

console.log(`\n===== 验真结果：${fail ? fail + " 项 FAIL" : "全部通过"} =====`);
process.exit(fail ? 1 : 0);
