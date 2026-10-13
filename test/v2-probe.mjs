// v2 探针：实测候选模型在本机 CPU 上的加载和编码速度
// 用法: node test/v2-probe.mjs m3|e5|rerank
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const ROOT = path.join(import.meta.dirname, "..");

const WHICH = process.argv[2];
const SAMPLES = [
  { db: "library/lunyu-xueer-zh.docx.db", tag: "zh" },
  { db: "library/daodejing-zh.docx.db", tag: "zh" },
  { db: "library/frankenstein-en.epub.db", tag: "en" },
  { db: "library/pride-and-prejudice-en.epub.db", tag: "en" },
];
const QUERIES = [
  { q: "孔子认为怎样才算好学", tag: "zh" },
  { q: "什么是道", tag: "zh" },
  { q: "how does the creature learn to speak", tag: "en" },
  { q: "who is Mr Darcy and what is he like", tag: "en" },
];

function pickChunks() {
  const out = [];
  for (const s of SAMPLES) {
    const db = new Database(path.join(ROOT, s.db), { readonly: true });
    const rows = db.prepare("SELECT text FROM chunks WHERE length(text) BETWEEN 150 AND 600 LIMIT 2").all();
    db.close();
    rows.forEach(r => out.push({ text: r.text, tag: s.tag }));
  }
  return out;
}

const tf = await import("@huggingface/transformers");
tf.env.remoteHost = process.env.HF_ENDPOINT || "https://hf-mirror.com";
tf.env.cacheDir = path.join(ROOT, ".models");
tf.env.allowLocalModels = true;

if (WHICH === "m3" || WHICH === "e5") {
  const cfg = WHICH === "m3"
    ? { id: "Xenova/bge-m3", dtype: "int8", pooling: "cls", prefix: "" }
    : { id: "Xenova/multilingual-e5-small", dtype: "int8", pooling: "mean", prefix: "passage: " };
  console.log(`[probe] ${cfg.id} (dtype=${cfg.dtype})`);
  const t0 = Date.now();
  const pipe = await tf.pipeline("feature-extraction", cfg.id, { dtype: cfg.dtype });
  console.log(`  加载(含下载): ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const chunks = pickChunks();
  console.log(`  样本块数: ${chunks.length}`);

  const embed1 = async (t) => new Float32Array((await pipe(t, { pooling: cfg.pooling, normalize: true })).data);
  const v0 = await embed1(cfg.prefix + chunks[0].text);
  console.log(`  向量维度: ${v0.length}`);

  const t1 = Date.now();
  for (const c of chunks) await embed1(cfg.prefix + c.text);
  const perChunk = (Date.now() - t1) / chunks.length;
  console.log(`  平均每块编码: ${perChunk.toFixed(0)} ms  → 3165 块全库约 ${(3165 * perChunk / 60000).toFixed(1)} 分钟`);

  const qcfg = WHICH === "e5" ? "query: " : "";
  const t2 = Date.now();
  const qs = await Promise.all(QUERIES.map(x => embed1(qcfg + x.q)));
  console.log(`  查询编码(4条并发): ${Date.now() - t2} ms`);

  const cos = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };
  const vecs = [];
  for (const c of chunks) vecs.push(await embed1(cfg.prefix + c.text));
  QUERIES.forEach((x, qi) => {
    const sims = vecs.map((v, ci) => ({ tag: chunks[ci].tag, s: cos(qs[qi], v) })).sort((a, b) => b.s - a.s);
    console.log(`  问[${x.tag}] "${x.q}" 最像: ${sims[0].tag}(${sims[0].s.toFixed(3)}) / 次${sims[1].tag}(${sims[1].s.toFixed(3)})`);
  });
  console.log("SUMMARY: " + JSON.stringify({ which: WHICH, dim: v0.length, perChunkMs: +perChunk.toFixed(0) }));
} else if (WHICH === "rerank") {
  const ID = "Xenova/bge-reranker-base";
  console.log(`[probe] ${ID} (dtype=int8)`);
  const t0 = Date.now();
  const tok = await tf.AutoTokenizer.from_pretrained(ID);
  const model = await tf.AutoModelForSequenceClassification.from_pretrained(ID, { dtype: "int8" });
  console.log(`  加载(含下载): ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const chunks = pickChunks();
  const q = QUERIES[0].q;
  const pairs = [];
  for (let i = 0; i < 20; i++) pairs.push({ q, text: chunks[i % chunks.length].text, tag: chunks[i % chunks.length].tag });
  const t1 = Date.now();
  const scores = [];
  for (const p of pairs) {
    const inputs = tok(p.q, { text_pair: p.text, padding: true, truncation: true, max_length: 512 });
    const { logits } = await model(inputs);
    scores.push(1 / (1 + Math.exp(-logits.data[0])));
  }
  const per = (Date.now() - t1) / pairs.length;
  console.log(`  20 对打分总耗时: ${Date.now() - t1} ms, 平均每对 ${per.toFixed(0)} ms`);
  console.log(`  分数样例: ${scores.slice(0, 5).map(s => s.toFixed(3)).join(", ")}`);
  console.log("SUMMARY: " + JSON.stringify({ which: "rerank", perPairMs: +per.toFixed(0) }));
} else {
  console.log("用法: node test/v2-probe.mjs m3|e5|rerank");
}
