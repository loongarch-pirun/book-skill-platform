// 新书结构验收：对任意书库跑七项检查（引擎面/字面面/语义面各查一项）。
// 用法: node test/newbook-check.mjs <库.db> [更多库.db...]
// 这是「新书冷接入」验收包的结构件：build-book + embed-book 跑完之后、
// 进金标准考卷之前，先用它兜一遍底——任何一项 FAIL 都说明这本书接入得不健康。
// 语义检查会加载向量模型（走项目 .models/ 缓存，几秒）；纯结构检查可设 SKIP_SEM=1 跳过。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const Database = require("better-sqlite3");

const { configureModels, getEmbedder, assertEngine, EMBED_MODELS, DEFAULT_EMBED } = await import("../src/lib/models.mjs");
configureModels({ modelsDir: path.join(ROOT, ".models") });

let failed = 0, warned = 0;
const assert = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (!cond) failed++; };
const warn = (msg) => { console.log("WARN - " + msg); warned++; };

async function checkOne(dbPath) {
  const name = path.basename(dbPath);
  console.log(`\n---- ${name} ----`);
  if (!fs.existsSync(dbPath)) { assert(false, `库文件存在: ${dbPath}`); return; }

  const db = new Database(dbPath, { readonly: true });
  try {
    const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
    const nChunks = db.prepare("SELECT COUNT(*) c FROM chunks").get().c;
    // 总字数用 JS .length 数（与 build-book 记账同一把尺子）：SQLite LENGTH() 数字符、
    // JS 数 UTF-16 码元，非 BMP 罕字（如孟子里的 𨪆）两种数法差 1——是单位差不是损坏
    const sumChars = db.prepare("SELECT text FROM chunks").all().reduce((a, r) => a + r.text.length, 0);
    const nEmb = db.prepare("SELECT COUNT(*) c FROM chunks WHERE emb IS NOT NULL").get().c;
    const chapters = db.prepare("SELECT DISTINCT COALESCE(chapter,'未分章') chapter FROM chunks ORDER BY chapter").all().map(r => r.chapter);
    const isPdf = (meta.format || "") === "pdf";

    // 1) 账实相符：meta 记的数和库里真的数对得上
    assert(nChunks > 0, `块数 > 0（实际 ${nChunks}）`);
    assert(String(nChunks) === String(meta.chunk_count ?? nChunks),
      `meta.chunk_count 账实相符（meta=${meta.chunk_count ?? "无"} 实际=${nChunks}）`);
    assert(String(sumChars) === String(meta.total_chars ?? sumChars),
      `meta.total_chars 账实相符（meta=${meta.total_chars ?? "无"} 实际=${sumChars}）`);

    // 1b) 章节结构：PDF 按页切片天生无章节（翻书显示「未分章」，既有设计）；
    //     docx/epub 有标题就该分出章来，只有一个「前言」桶说明「# 标题」约定没用上
    if (isPdf) {
      if (+meta.num_chapters >= 1) assert(true, `章节数 ≥ 1（meta.num_chapters=${meta.num_chapters}）`);
      else warn(`PDF 按页切片：无章节概念（meta.num_chapters 空），翻书走「未分章」桶——既有设计非病态`);
    } else {
      assert(+meta.num_chapters >= 1 && chapters.length > 1,
        `章节数 ≥ 1 且不止一个（meta.num_chapters=${meta.num_chapters ?? "无"}，distinct=${chapters.length}）`);
      if (chapters.length === 1 && chapters[0] === "前言")
        warn("全书只有一个「前言」章——txt 转 docx 时没用「# 标题」约定，目录体验会差（检索不受影响）");
    }

    // 2) 块质量：无空块；>3000 才算病态（1500~3000 是英文长句合法溢出，sentenceSplit
    //    按句边界切、单句超 900 就整句成块）；纯符号块（----/====）是抓取残留的垃圾，
    //    一条都不该有；docx/epub 章名不允许空（PDF 允许→未分章）
    const badEmpty = db.prepare("SELECT COUNT(*) c FROM chunks WHERE text IS NULL OR TRIM(text)=''").get().c;
    const badLong = db.prepare("SELECT COUNT(*) c FROM chunks WHERE LENGTH(text) > 3000").get().c;
    const over1500 = db.prepare("SELECT COUNT(*) c FROM chunks WHERE LENGTH(text) > 1500").get().c;
    const nullChap = db.prepare("SELECT COUNT(*) c FROM chunks WHERE chapter IS NULL OR TRIM(chapter)=''").get().c;
    const junkChunks = db.prepare("SELECT id, text FROM chunks").all()
      .filter(r => !/[\u4e00-\u9fff\u3040-\u30ffa-zA-Z0-9]/.test(r.text));
    assert(badEmpty === 0, `无空文本块（${badEmpty}）`);
    assert(junkChunks.length === 0,
      `无纯符号垃圾块（${junkChunks.length}${junkChunks.length ? "，如块 " + junkChunks.slice(0, 3).map(r => r.id + ":" + JSON.stringify(r.text.slice(0, 12))).join(" ") : ""}）`);
    assert(badLong === 0, `无病态超长块 >3000 字（${badLong}）`);
    if (over1500 > 0) warn(`${over1500} 块超过 1500 字——英文长句合法溢出（单句超 900 字整句成块），非病态`);
    if (nullChap > 0 && !isPdf) assert(false, `章名非空（${nullChap} 块为空）`);
    else if (nullChap > 0) warn(`PDF ${nullChap} 块章名为空 → 翻书显示「未分章」（既有设计，非病态）`);

    // 3) 引擎一致性：库内 meta.model 与当前查询引擎必须同台（不一致余弦分全是垃圾）
    try { assertEngine(db, DEFAULT_EMBED); assert(true, `引擎一致（库=${meta.model ?? "未标记"}，当前=${DEFAULT_EMBED}）`); }
    catch (e) { assert(false, `引擎一致：${e.message}`); }

    // 4) 向量全覆盖 + 维度对
    assert(nEmb === nChunks, `向量全覆盖（${nEmb}/${nChunks}）`);
    const cfg = EMBED_MODELS[DEFAULT_EMBED];
    const row = db.prepare("SELECT emb FROM chunks WHERE emb IS NOT NULL LIMIT 1").get();
    const dim = row ? row.emb.byteLength / 4 : 0;
    assert(dim === cfg.dim && String(meta.dim ?? dim) === String(cfg.dim),
      `向量维度 = ${cfg.dim}（实际 ${dim}，meta.dim=${meta.dim ?? "无"}）`);

    // 5) FTS 冒烟：取中间块一个 4 字短语，MATCH 必须能命中该块（trigram 字面腿活着）
    const mid = db.prepare("SELECT id, text FROM chunks ORDER BY id LIMIT 1 OFFSET ?").get(Math.floor(nChunks / 2));
    const cjk = mid.text.match(/[\u4e00-\u9fff]{4,}/);
    const phrase = (cjk ? cjk[0] : mid.text).slice(0, 4);
    let ftsIds = [];
    try {
      ftsIds = db.prepare("SELECT c.id id FROM chunks_fts f JOIN chunks c ON c.id=f.rowid WHERE chunks_fts MATCH ?")
        .all(`"${phrase}"`).map(r => r.id);
    } catch { /* 查询意外 → 下面判 FAIL */ }
    assert(ftsIds.includes(mid.id), `FTS trigram 命中中间块（短语「${phrase}」，命中 ${ftsIds.length} 块）`);

    // 6) 语义冒烟：拿中间块自己的开头当问题，该块必须进全库余弦 top-5
    if (process.env.SKIP_SEM === "1") {
      warn("SKIP_SEM=1：语义冒烟跳过");
    } else {
      const embed = await getEmbedder();
      const [qv] = await embed.embedQueries([mid.text.slice(0, 60)]);
      const all = db.prepare("SELECT id, emb FROM chunks WHERE emb IS NOT NULL").all()
        .map(r => ({ id: r.id, v: new Float32Array(r.emb.buffer, r.emb.byteOffset, r.emb.byteLength / 4) }));
      const { cosine } = await import("../src/lib/models.mjs");
      const scored = all.map(r => ({ id: r.id, s: cosine(qv, r.v) })).sort((a, b) => b.s - a.s);
      const rank = scored.findIndex(r => r.id === mid.id) + 1;
      assert(rank >= 1 && rank <= 5, `语义自检：中间块进余弦 top-5（实际第 ${rank} 名，自分 ${scored[rank - 1]?.s.toFixed(3)}）`);
    }
    console.log(`NEWBOOK_OK ${name} chunks=${nChunks} chapters=${chapters.length} chars=${sumChars} dim=${dim} engine=${meta.model ?? DEFAULT_EMBED}`);
  } finally {
    db.close();
  }
}

const dbs = process.argv.slice(2);
if (dbs.length === 0) {
  console.error("用法: node test/newbook-check.mjs <库.db> [更多库.db...]（SKIP_SEM=1 跳过语义检查）");
  process.exit(1);
}
for (const dbPath of dbs) await checkOne(dbPath);

console.log("\n========== 新书结构验收结果 ==========");
if (failed > 0) { console.log(`有 ${failed} 项 FAIL${warned ? `（另有 ${warned} 项 WARN）` : ""}`); process.exit(1); }
console.log(`全部 PASS${warned ? `（${warned} 项 WARN 见上）` : ""}：账实/块质量/引擎/向量/FTS/语义 六面健康`);
