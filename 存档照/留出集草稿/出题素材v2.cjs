#!/usr/bin/env node
/**
 * 出题素材抽取（v2 卷）：从 13 本书里各挑几块「适合当答案」的原文，供人工出题。
 * 只读 SQL，不调检索、不看得分。
 * 跑法：node 出题素材v2.cjs [每本块数=2] [起始书序号] [本数]
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const R4 = "C:/Users/JIANG XIAO HUA/Desktop/book-skill-platform-r4";
// better-sqlite3 装在 r4 里，工作区没有；从 r4 的 package.json 解析
const r4require = createRequire(path.join(R4, "package.json"));
const Database = r4require("better-sqlite3");
const LIB = path.join(R4, "library");
const PER = Number(process.argv[2] || 2);
const FROM = Number(process.argv[3] || 0);
const CNT = Number(process.argv[4] || 99);

// 已用过的块（v1 卷），避免重复
const v1 = JSON.parse(fs.readFileSync(path.join(R4, "test/holdout/sets/holdout-v1.json"), "utf8"));
const used = new Set(v1.items.map((x) => `${x.book}#${x.chunk_id}`));

const books = fs.readdirSync(LIB).filter((f) => f.endsWith(".db")).sort();
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

for (const f of books.slice(FROM, FROM + CNT)) {
  const bookId = f.replace(/\.db$/, "");
  const db = new Database(path.join(LIB, f), { readonly: true });
  const rows = db.prepare("SELECT id, kind, chapter, length(text) len, text FROM chunks").all();
  db.close();
  // 只要正文块、长度适中、没被 v1 用过（文言文/表格类书块短，放宽到 100 字）
  const ok = (r, minLen) =>
    (!r.kind || r.kind === "text") &&
    r.len >= minLen && r.len <= 1800 &&
    !used.has(`${bookId}#${r.id}`) &&
    !/^\s*(Figure|Table|图|表)\s*\d/i.test(norm(r.text));
  let cand = rows.filter((r) => ok(r, 400));
  if (!cand.length) cand = rows.filter((r) => ok(r, 100));
  // 均匀取样，避免总取开头
  const picked = [];
  for (let i = 0; i < PER && cand.length; i++) picked.push(cand[Math.floor((i + 1) * cand.length / (PER + 1))]);
  console.log(`\n########## ${bookId}  （候选 ${cand.length} 块）`);
  for (const r of picked) {
    console.log(`--- id=${r.id} len=${r.len} chapter=${norm(r.chapter).slice(0, 30) || "-"}`);
    console.log(norm(r.text).slice(0, 460));
  }
}
