// selectBooks 三分支单测（2026-11-16 审查 🟡-2 补齐）
//
// 为什么单独一支：路由预筛是唯一「猜错就整本漏」的地方，但它此前只有静态断言（存在性 +
// 定义顺序）和独立卷子的间接覆盖。三分支里「预筛命中但一本都没扫成 → 退回全库」这条
// 在真库上几乎触发不到（要 13 本全是坏库），等于没验过，所以用临时夹具造出来。
//
// 跑法: node test/selectbooks-test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

import { selectBooks, routeAndSearch, listBooks } from "../src/lib/search.mjs";

const LIB = path.join(import.meta.dirname, "..", "library");
let failed = 0;
const assert = (cond, msg, extra = "") => {
  console.log((cond ? "PASS" : "FAIL") + " - " + msg + (cond ? "" : ` ${extra}`));
  if (!cond) failed++;
};

// ---------- 1) 命中：问句点了书名就只锁那几本 ----------
{
  const books = [
    { id: "a.db", db: "/x/a.db", title: "pride-and-prejudice-en.epub" },
    { id: "b.db", db: "/x/b.db", title: "pg1260-简爱.epub" },
    { id: "c.db", db: "/x/c.db", title: "mengzi-zh.docx" },
  ];
  const r = selectBooks("《傲慢与偏见》里宾利和简怎么了", books);
  assert(r.source === "prefilter", `命中：source=prefilter（实际 ${r.source}）`);
  assert(r.target.length === 1 && r.target[0].id === "a.db",
    `命中：只锁被点名的那本（${r.target.map((b) => b.title).join(",")}）`);

  // 别名（中文问英文书）：pg1260-简爱 → 「简爱」
  const r2 = selectBooks("简爱在桑菲尔德遇到了谁", books);
  assert(r2.source === "prefilter" && r2.target[0]?.id === "b.db",
    `命中：中文别名生效（${r2.target.map((b) => b.title).join(",")}）`);
}

// ---------- 2) 零命中：不猜，退回全库 ----------
{
  const books = [
    { id: "a.db", db: "/x/a.db", title: "pride-and-prejudice-en.epub" },
    { id: "b.db", db: "/x/b.db", title: "mengzi-zh.docx" },
  ];
  const r = selectBooks("量子纠缠的退相干时间是多少", books);
  assert(r.source === "full", `零命中：source=full（实际 ${r.source}）`);
  assert(r.target.length === books.length, `零命中：target 等于全库（${r.target.length}/${books.length}）`);
  assert(r.cands.length === 0, `零命中：cands 为空（${r.cands.length}）`);

  // 空问句、单书库：同样退回全库，不许抛
  assert(selectBooks("", books).source === "full", "零命中：空问句 → full");
  assert(selectBooks("随便问问", books.slice(0, 1)).source === "full", "零命中：书库只有 1 本 → full");
}

// ---------- 3) 降级：预筛命中但一本都没扫成 → 退回全库重扫 ----------
// 夹具：一本「build-only」（无 emb 列，点名它能命中预筛但扫不出向量）
//      + 一本真库拷贝（保证全库重扫有东西可扫）
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-selbooks-"));

  // 3a. build-only 假书：没有 emb 列 → scanBookSem 直接返回 hasSem:false
  const fakeDb = path.join(tmp, "fake-target.pdf.db");
  {
    const db = new Database(fakeDb);
    db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE chunks(id INTEGER PRIMARY KEY, text TEXT, chapter TEXT, page INTEGER);`);
    const setMeta = db.prepare("INSERT INTO meta(key,value) VALUES (?,?)");
    setMeta.run("title", "fake-target.pdf");
    setMeta.run("format", "pdf");
    setMeta.run("chunk_count", "2");
    setMeta.run("total_chars", "100");
    db.prepare("INSERT INTO chunks(id,text,chapter,page) VALUES (1,?,?,1)").run("fake target 的第一段正文", "第一章");
    db.prepare("INSERT INTO chunks(id,text,chapter,page) VALUES (2,?,?,2)").run("fake target 的第二段正文", "第二章");
    db.close();
  }

  // 3b. 真库拷贝：随便挑一本小书（取 library 里块数最少的那本，省拷贝时间）
  const real = listBooks(LIB).filter((b) => b.chunks > 0).sort((a, b) => a.chunks - b.chunks)[0];
  fs.copyFileSync(real.db, path.join(tmp, path.basename(real.db)));

  const out = await routeAndSearch("fake-target 讲了什么", { libDir: tmp, topN: 3 });
  assert(out.route_source === "degraded",
    `降级：source=degraded（实际 ${out.route_source}）`);
  assert(Array.isArray(out.route_candidates) && out.route_candidates.length === 2,
    `降级：route_candidates 报的是实际扫过的 2 本（${out.route_candidates?.length}）`);
  assert(out.route_candidates.includes("fake-target.pdf"),
    "降级：候选里含被点名的假书（说明确实重扫了它）");
  assert(out.considered.length === 2,
    `降级：considered 仍覆盖全库（${out.considered.length} 本）`);
  assert(!out.considered.some((c) => c.title === "fake-target.pdf" && c.n > 0),
    "降级：无向量的假书记 0 分且不入池");

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n===== selectBooks 三分支：${failed ? failed + " 项 FAIL" : "全部通过"} =====`);
process.exit(failed ? 1 : 0);
