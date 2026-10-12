// 向量化 + 概念关联图谱（模型可换：m3 / e5 / zh-small）
// 用法: node embed-book.js <book.db> [模型key，默认 m3]
// 干三件事：
//   1) 用向量模型给每块原文算向量（存 chunks.emb），模型名写进 meta.model
//   2) 生成概念节点（英文按词频、中文按二字组频，零 LLM）
//   3) 生成边：书→章节（结构）、章节→概念（归属）、块↔块（语义近邻 top3）
// 换模型时：库内旧向量自动作废重灌（保证查询和建库用同一个引擎）
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const SIM_TOPK = 3;

const cosine = (a, b) => {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
};

const EN_STOP = new Set(("the a an and or of to in is are was were be been being on for with as at by from this that these those it its their his her hers him them himself herself whom whose not but they we you he she which what if then than so such can could will would may might must have has had do does did our your i me my mine mr mrs said one two more most other no nor only own same too very just also into over under again further once here there when where why how all any both each few shall should ought per chapter volume".split(" ")));
const CN_STOP = new Set(["一个","我们","他们","没有","什么","这个","那个","以及","或者","但是","如果","因为","所以","可以","这些","那些","就是","也是","都是","子曰","夫子","不可","不知","不如","之謂","乎者"]);

function extractConcepts(chunks) {
  const en = { freq: new Map() }, cn = { freq: new Map() };
  for (const c of chunks) {
    const words = c.text.toLowerCase().match(/[a-z]{3,}/g) || [];
    for (const w of words) if (!EN_STOP.has(w)) en.freq.set(w, (en.freq.get(w) || 0) + 1);
    const cjk = c.text.replace(/[^\u4e00-\u9fff]/g, "");
    for (let i = 0; i + 2 <= cjk.length; i++) {
      const g = cjk.slice(i, i + 2);
      if (!CN_STOP.has(g)) cn.freq.set(g, (cn.freq.get(g) || 0) + 1);
    }
  }
  const enTop = [...en.freq.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w, n]) => ({ name: w, freq: n }));
  const cnTop = [...cn.freq.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w, n]) => ({ name: w, freq: n }));
  return [...enTop, ...cnTop];
}

(async () => {
  const dbPath = process.argv[2];
  const modelKey = process.argv[3] || process.env.BSP_EMBED_MODEL || "e5";
  if (!dbPath || !fs.existsSync(dbPath)) { console.error("用法: node embed-book.js <book.db> [m3|e5|zh-small]"); process.exit(1); }
  // L4 误导修复：embed-book 只吃建好的库。拿书原文件来的人最常见，给下一步指令
  if (!dbPath.toLowerCase().endsWith(".db")) {
    console.error(`embed-book 吃的是建好的库文件（.db），你给的是「${path.basename(dbPath)}」。`);
    console.error(`先建库: node src/build-book.js "${dbPath}" ，再对本命令输出的 .db 跑向量化。`);
    process.exit(1);
  }

  const models = await import(pathToFileURL(path.join(__dirname, "lib", "models.mjs")).href);
  const catalog = await import(pathToFileURL(path.join(__dirname, "lib", "catalog.mjs")).href);
  const db = require("better-sqlite3")(dbPath);
  const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
  const title = meta.title || path.basename(dbPath, ".db");
  const cols = db.prepare("PRAGMA table_info(chunks)").all().map(c => c.name);
  if (!cols.includes("emb")) db.exec("ALTER TABLE chunks ADD COLUMN emb BLOB");
  // 编目层迁移（幂等）：nodes/edges 加 source/ref 列、回填 rule 标记、建 theme_vecs 表
  // 有了这层，下面重建规则图谱时 DELETE 只清 rule 层，llm 编目成果（主题/人物/关系）安然无恙
  catalog.ensureCatalogSchema(db);

  // 引擎一致性：库内向量无法证明是本引擎（没标签或标签不同）→ 一律重灌
  // 宁可多算一遍，也不能让"查询用A引擎、库里是B引擎"的错位发生
  const hasEmb = db.prepare("SELECT COUNT(*) c FROM chunks WHERE emb IS NOT NULL").get().c > 0;
  if (hasEmb && meta.model !== modelKey) {
    console.log(`库内向量引擎=${meta.model || "未标记"}，本次要「${modelKey}」→ 全量重灌`);
    db.exec("UPDATE chunks SET emb = NULL");
  }

  // 1) 向量（跳过已算过的）
  const todo = db.prepare("SELECT id, text FROM chunks WHERE emb IS NULL ORDER BY id").all();
  let dim = 0;
  const stampMeta = () => {
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('model',?)").run(modelKey);
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('dim',?)").run(String(dim));
  };
  if (todo.length) {
    console.log(`[1/3] 向量化 ${todo.length} 块（模型: ${modelKey}，本地运行）...`);
    const embed = await models.getEmbedder(modelKey);
    dim = embed.dim;
    const BATCH = 64;
    const upd = db.prepare("UPDATE chunks SET emb = ? WHERE id = ?");
    const tx = db.transaction((rows, vecs) => {
      for (let i = 0; i < rows.length; i++) upd.run(Buffer.from(vecs[i].buffer, vecs[i].byteOffset, vecs[i].byteLength), rows[i].id);
    });
    for (let off = 0; off < todo.length; off += BATCH) {
      const rows = todo.slice(off, off + BATCH);
      const vecs = await embed.embedPassages(rows.map(r => r.text));
      tx(rows, vecs);
      const done = Math.min(off + BATCH, todo.length);
      process.stdout.write(`\r  进度 ${done}/${todo.length}`);
    }
    console.log("\n  完成");
    stampMeta();
  } else {
    console.log("[1/3] 库内向量已是本引擎（标签一致），跳过");
    dim = +meta.dim || models.EMBED_MODELS[modelKey].dim;
  }
  const nEmb = db.prepare("SELECT COUNT(*) c FROM chunks WHERE emb IS NOT NULL").get().c;
  const SIM_THRESHOLD = models.EMBED_MODELS[modelKey].simThreshold;

  // 2) 概念节点
  console.log("[2/3] 提取概念节点...");
  const chunks = db.prepare("SELECT id, chapter, page, text FROM chunks ORDER BY id").all();
  const concepts = extractConcepts(chunks);
  // 图谱表结构已由 ensureCatalogSchema 就位（含 source/ref 列 + dst 索引）
  // 关键改动：重建规则层只清 rule/NULL 来源，llm 编目层（主题/人物/关系边）跨重灌存活
  db.exec("DELETE FROM nodes WHERE source IS NULL OR source='rule'; DELETE FROM edges WHERE source IS NULL OR source='rule';");
  const insNode = db.prepare("INSERT INTO nodes(type, name, ref, source) VALUES(?,?,?,'rule')");
  const insEdge = db.prepare("INSERT INTO edges(src_type, src, dst_type, dst, kind, weight, source) VALUES(?,?,?,?,?,?,'rule')");
  insNode.run("book", title, null);

  // 3) 边：结构 + 归属 + 语义近邻
  console.log("[3/3] 生成边（结构/归属/语义近邻）...");
  const chapters = [...new Set(chunks.map(c => c.chapter).filter(Boolean))];
  const chTx = db.transaction(() => {
    for (const ch of chapters) { insNode.run("chapter", ch, null); insEdge.run("book", title, "chapter", ch, "tree", 1); }
    for (const c of concepts) {
      insNode.run("concept", c.name, null);
      // 概念出现在哪些章节 → 章节→概念 边
      const inCh = {};
      for (const ch of chunks) if (ch.chapter && ch.text.includes(c.name)) inCh[ch.chapter] = (inCh[ch.chapter] || 0) + 1;
      for (const [ch, n] of Object.entries(inCh)) insEdge.run("chapter", ch, "concept", c.name, "about", n);
    }
  });
  chTx();

  // 语义近邻边：全量向量两两算（个人书库量级可接受）
  const embs = db.prepare("SELECT id, emb FROM chunks WHERE emb IS NOT NULL ORDER BY id").all()
    .map(r => ({ id: r.id, v: new Float32Array(r.emb.buffer, r.emb.byteOffset, r.emb.byteLength / 4) }));
  let edgeCount = 0;
  const simTx = db.transaction(() => {
    for (let i = 0; i < embs.length; i++) {
      const sims = [];
      for (let j = 0; j < embs.length; j++) {
        if (i === j) continue;
        const s = cosine(embs[i].v, embs[j].v);
        if (s >= SIM_THRESHOLD) sims.push([j, s]);
      }
      sims.sort((a, b) => b[1] - a[1]);
      for (const [j, s] of sims.slice(0, SIM_TOPK)) { insEdge.run("chunk", String(embs[i].id), "chunk", String(embs[j].id), "similar", s); edgeCount++; }
    }
  });
  simTx();
  db.close();
  console.log(`\n完成: 向量 ${nEmb} 块(${dim}维, ${modelKey}) | 概念 ${concepts.length} 个 | 章节 ${chapters.length} 个 | 相似边 ${edgeCount} 条 (门槛${SIM_THRESHOLD})`);
})();
