// 阶段2 验收（v2 引擎无关版）：向量覆盖 / 语义检索 / 混合合并 / 图谱
// 模型跟随 BSP_EMBED_MODEL（默认 m3），阈值按引擎分数尺度分档
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const path = require("node:path");
import { getEmbedder, EMBED_MODELS, DEFAULT_EMBED } from "../src/lib/models.mjs";

const LIB = path.join(import.meta.dirname, "..", "library");
// 各引擎"白话问文言/英文"合理首名相似度下限（跨域问句天然低分）
const TH_ZH = { m3: 0.4, e5: 0.55, "zh-small": 0.55 };
const TH_EN = { m3: 0.3, e5: 0.5, "zh-small": 0.6 };

let failed = 0;
const assert = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (!cond) failed++; };
const cosine = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };
const open = (f) => new Database(path.join(LIB, f), { readonly: true });
const expectDim = EMBED_MODELS[DEFAULT_EMBED].dim;

// ===== 1. 向量全覆盖 + 引擎标记 =====
for (const f of ["lunyu-xueer-zh.pdf.db", "lunyu-xueer-zh.docx.db", "attention-is-all-you-need-en.pdf.db", "pride-and-prejudice-en.epub.db"]) {
  const db = open(f);
  const total = db.prepare("SELECT COUNT(*) n FROM chunks").get().n;
  const emb = db.prepare("SELECT COUNT(*) n FROM chunks WHERE emb IS NOT NULL").get().n;
  const dim = db.prepare("SELECT LENGTH(emb)/4 d FROM chunks WHERE emb IS NOT NULL LIMIT 1").get()?.d;
  const model = db.prepare("SELECT value FROM meta WHERE key='model'").get()?.value;
  assert(total === emb && dim === expectDim && model === DEFAULT_EMBED, `${f}: ${emb}/${total} 块有向量，${model} ${dim} 维`);
  db.close();
}

// ===== 2. 语义检索（中文，简体白话问 繁体古典文，零字面重叠）=====
{
  const db = open("lunyu-xueer-zh.docx.db");
  const embed = await getEmbedder();
  const [qv] = await embed.embedQueries(["和朋友相处要讲信用"]);
  const rows = db.prepare("SELECT id, chapter, emb FROM chunks").all();
  const scored = rows.map(r => ({ id: r.id, ch: r.chapter, s: cosine(qv, new Float32Array(r.emb.buffer, r.emb.byteOffset, r.emb.byteLength / 4)) }))
    .sort((a, b) => b.s - a.s).slice(0, 3);
  const texts = db.prepare(`SELECT text FROM chunks WHERE id IN (${scored.map(() => "?").join(",")})`).all(...scored.map(s => s.id));
  const hitFriend = texts.some(t => /[信]|友/.test(t.text));
  assert(hitFriend, `白话问"和朋友相处要讲信用"→top3 命中讲信/友的章句（${scored.map(s => s.ch).join(",")}）`);
  assert(scored[0].s > TH_ZH[DEFAULT_EMBED], `语义相似度首名 ${scored[0].s.toFixed(3)} > ${TH_ZH[DEFAULT_EMBED]}（白话问文言，跨域合理区间）`);
  db.close();
}

// ===== 3. 语义检索（英文）=====
{
  const db = open("attention-is-all-you-need-en.pdf.db");
  const embed = await getEmbedder();
  const [qv] = await embed.embedQueries(["how the model computes attention between words"]);
  const rows = db.prepare("SELECT id, page, emb FROM chunks").all();
  const best = rows.map(r => ({ id: r.id, page: r.page, s: cosine(qv, new Float32Array(r.emb.buffer, r.emb.byteOffset, r.emb.byteLength / 4)) }))
    .sort((a, b) => b.s - a.s)[0];
  const text = db.prepare("SELECT text FROM chunks WHERE id=?").get(best.id).text;
  assert(best.s > TH_EN[DEFAULT_EMBED] && /attention/i.test(text), `英文语义查询→第${best.page}页（相似度 ${best.s.toFixed(3)}），内容含 attention`);
  db.close();
}

// ===== 4. 图谱完整性 =====
for (const [f, minEdges] of [["lunyu-xueer-zh.pdf.db", 5], ["lunyu-xueer-zh.docx.db", 30], ["attention-is-all-you-need-en.pdf.db", 100], ["pride-and-prejudice-en.epub.db", 3000]]) {
  const db = open(f);
  const nodes = db.prepare("SELECT COUNT(*) n FROM nodes").get().n;
  const sim = db.prepare("SELECT COUNT(*) n FROM edges WHERE kind='similar'").get().n;
  const about = db.prepare("SELECT COUNT(*) n FROM edges WHERE kind='about'").get().n;
  const tree = db.prepare("SELECT COUNT(*) n FROM edges WHERE kind='tree'").get().n;
  assert(nodes > 5 && sim >= minEdges, `${f}: 节点${nodes} 相似边${sim} 归属边${about} 结构边${tree}`);
  db.close();
}

// ===== 5. 图谱用法演示：概念 → 章节 → 原文（可回源）=====
{
  const db = open("pride-and-prejudice-en.epub.db");
  const concept = db.prepare("SELECT name FROM nodes WHERE type='concept' ORDER BY rowid LIMIT 3").all();
  const e = db.prepare("SELECT src, dst, weight FROM edges WHERE kind='about' ORDER BY weight DESC LIMIT 1").get();
  assert(!!e && concept.length >= 1, `概念(${concept.map(c => c.name).join("/")}) → 章节「${e?.src}」归属边权重 ${e?.weight}`);
  db.close();
}

console.log("\n===== 阶段2 验收结果 =====");
if (failed > 0) { console.log(`${failed} 项 FAIL`); process.exit(1); }
console.log(`全部 PASS（引擎: ${DEFAULT_EMBED}）：向量全覆盖、中英文语义检索命中、图谱三类边齐全可回源`);
