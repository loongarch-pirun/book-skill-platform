// test/book-summary-test.mjs —— list_books 简介的数据面校验（2026-11-16）
//
// 为什么单独一支：简介是「给模型看的说明书」，写错比不写更糟——模型会照错的简介
// 去翻一本书，然后答错，而且你查不出错在哪。所以每条简介的硬事实都必须能被库里的
// 实际内容验证：不写推断、不写评价。
//
// 四条判据（V2，按语种分别验）：
//   1. 覆盖：每个库有且只有一条简介，没有多余条目（改名/删书必须同步改这个文件）
//   2. 长度：≤200 字（list_books 是每次对话都调的常驻调用，超了就是每次多付 token）
//   3. 硬事实命中：
//      · 中文书（lang=zh）→ 中文 2-gram 命中率 ≥40%（古籍是繁体，查库前转繁）
//      · 英文书（lang=en）→ 英文专名命中率 ≥70%（人物名/术语，这些是最容易写错的）
//   4. 同质化：任意两条简介的 3-gram Jaccard ≤0.5（防「本书探讨了人性的复杂」这类套话）
//
// V1 的教训：一开始用「所有实词命中率 ≥60%」一条尺子量所有书，结果英文书的
// 中文简介只有 4% 命中——那不是简介写错，是尺子用错了（拿中文量英文）。
//
// 跑法: node test/book-summary-test.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { convS2T } from "../src/lib/keywords.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const LIB = path.join(import.meta.dirname, "..", "library");
const FILE = path.join(import.meta.dirname, "..", "src", "lib", "book-summaries.json");

let failed = 0;
const assert = (cond, msg, extra = "") => {
  console.log((cond ? "PASS" : "FAIL") + " - " + msg + (cond ? "" : ` ${extra}`));
  if (!cond) failed++;
};

const all = JSON.parse(fs.readFileSync(FILE, "utf8"));
const map = Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith("_")));
const ids = fs.readdirSync(LIB).filter((f) => f.endsWith(".db")).map((f) => f.replace(/\.db$/, ""));

// ---------- 1) 覆盖：一一对应 ----------
{
  const missing = ids.filter((id) => !map[id]);
  const extra = Object.keys(map).filter((k) => !ids.includes(k));
  assert(!missing.length, `覆盖：每个库都有简介（缺 ${missing.length} 个）`, missing.join(", "));
  assert(!extra.length, `覆盖：没有多余条目（多 ${extra.length} 个）`, extra.join(", "));
}

// ---------- 2) 长度 ----------
{
  const lens = Object.values(map).map((v) => v.length);
  const long = Object.entries(map).filter(([, v]) => v.length > 200);
  assert(!long.length, `长度：全部 ≤200 字（最长 ${Math.max(...lens)}，平均 ${Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)}）`,
    long.map(([k, v]) => `${k}=${v.length}`).join(", "));
}

// 句首/常见词不算专名（它们在任何英文书里都可能出现，验不出事实）
const STOP = new Set(["The", "And", "With", "From", "That", "This", "For", "His", "Her", "Are", "Was",
  "Were", "Its", "Into", "Than", "Then", "They", "Their", "PDF", "DOCX", "EPUB", "Page", "Pages"]);

const properNouns = (s) => [...new Set((s.match(/\b[A-Z][A-Za-z'-]{2,}\b/g) || []).filter((w) => !STOP.has(w)))];
const cjkGrams = (s, n = 2) => {
  const out = new Set();
  for (const seg of s.replace(/[^\u4e00-\u9fff]/g, " ").split(/\s+/).filter(Boolean))
    for (let i = 0; i + n <= seg.length; i++) out.add(seg.slice(i, i + n));
  return [...out];
};

// ---------- 3) 硬事实命中（按语种） ----------
for (const id of ids) {
  const sum = map[id];
  if (!sum) continue;
  const db = new Database(path.join(LIB, id + ".db"), { readonly: true });
  const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map((r) => [r.key, r.value]));
  const probe = (term) => {
    // 双形都试（原形在前）——古籍是繁体（简介写简体，要转繁才查得到），
    // 而简体书转了繁反而查不到。只试一种形会冤枉另一半书。
    // 与 catalog.mjs 的 entityAliasTerms 同款做法。
    for (const t of new Set([term, convS2T(term)])) {
      if (db.prepare("SELECT COUNT(*) n FROM chunks WHERE text LIKE ?").get(`%${t}%`).n > 0) return true;
    }
    return false;
  };
  const lang = meta.lang || "zh";

  if (lang === "en") {
    const names = properNouns(sum);
    const hit = names.filter(probe);
    const rate = hit.length / Math.max(1, names.length);
    db.close();
    assert(rate >= 0.7,
      `${id}（en）: 英文专名命中 ${(rate * 100).toFixed(0)}%（${hit.length}/${names.length}）`,
      `未命中：${names.filter((n) => !hit.includes(n)).slice(0, 6).join(", ")}`);
  } else {
    const grams = cjkGrams(sum);
    const hit = grams.filter(probe);
    const rate = hit.length / Math.max(1, grams.length);
    db.close();
    assert(rate >= 0.4,
      `${id}（zh）: 中文 2-gram 命中 ${(rate * 100).toFixed(0)}%（${hit.length}/${grams.length}）`);
  }
}

// ---------- 4) 同质化：任意两条 3-gram Jaccard ≤0.5 ----------
{
  const tri = (s) => new Set(cjkGrams(s, 3));
  const keys = Object.keys(map);
  const sets = Object.fromEntries(keys.map((k) => [k, tri(map[k])]));
  const jac = (a, b) => {
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / Math.max(1, a.size + b.size - inter);
  };
  let worst = { v: 0, pair: "" };
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++) {
      const v = jac(sets[keys[i]], sets[keys[j]]);
      if (v > worst.v) worst = { v, pair: `${keys[i]} ↔ ${keys[j]}` };
    }
  assert(worst.v <= 0.5,
    `同质化：最高 3-gram 相似度 ${worst.v.toFixed(2)}（上限 0.5）${worst.pair ? ` @ ${worst.pair}` : ""}`);
}

console.log(failed ? `\n${failed} 项 FAIL` : "\n全部 PASS");
process.exit(failed ? 1 : 0);
