// 编目核心库：E5 聚堆 + LLM 编目结果校验/入库 + 检索端编目信号
// 三段闭环：catalog-export（聚堆出任务书）→ 云端智能体（命名归档）→ catalog-import（校验入库）
// 被 catalog-export.mjs / catalog-import.mjs / search.mjs / register-tools.mjs / embed-book.js(动态) 共用
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import { z } from "zod";
import { cosine, getEmbedder, assertEngine, DEFAULT_EMBED } from "./models.mjs";

// ---------- 词频统计（与 embed-book.js 规则图谱同一套停用词，保持一致） ----------
const EN_STOP = new Set(("the a an and or of to in is are was were be been being on for with as at by from this that these those it its their his her hers him them himself herself whom whose not but they we you he she which what if then than so such can could will would may might must have has had do does did our your i me my mine mr mrs said one two more most other no nor only own same too very just also into over under again further once here there when where why how all any both each few shall should ought per chapter volume".split(" ")));
const CN_STOP = new Set(["一个", "我们", "他们", "没有", "什么", "这个", "那个", "以及", "或者", "但是", "如果", "因为", "所以", "可以", "这些", "那些", "就是", "也是", "都是", "子曰", "夫子", "不可", "不知", "不如", "之謂", "乎者"]);

function termFreq(texts) {
  const en = new Map(), cn = new Map();
  for (const text of texts) {
    const words = text.toLowerCase().match(/[a-z]{3,}/g) || [];
    for (const w of words) if (!EN_STOP.has(w)) en.set(w, (en.get(w) || 0) + 1);
    const cjk = text.replace(/[^\u4e00-\u9fff]/g, "");
    for (let i = 0; i + 2 <= cjk.length; i++) {
      const g = cjk.slice(i, i + 2);
      if (!CN_STOP.has(g)) cn.set(g, (cn.get(g) || 0) + 1);
    }
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, n]) => ({ t, n }));
  return [...top(en), ...top(cn)].slice(0, 16);
}

// ---------- 1) schema 迁移（幂等，export/import/embed-book 三入口共用） ----------
// nodes/edges 加 source 列（'rule'=规则图谱层 | 'llm'=编目层），edges 加 ref 列（存关系描述）
export function ensureCatalogSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS nodes(
    id INTEGER PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, ref TEXT, source TEXT);
    CREATE TABLE IF NOT EXISTS edges(
    src_type TEXT, src TEXT, dst_type TEXT, dst TEXT, kind TEXT, weight REAL, ref TEXT, source TEXT);`);
  const nodeCols = db.prepare("PRAGMA table_info(nodes)").all().map(c => c.name);
  if (!nodeCols.includes("source")) db.exec("ALTER TABLE nodes ADD COLUMN source TEXT");
  const edgeCols = db.prepare("PRAGMA table_info(edges)").all().map(c => c.name);
  if (!edgeCols.includes("source")) db.exec("ALTER TABLE edges ADD COLUMN source TEXT");
  if (!edgeCols.includes("ref")) db.exec("ALTER TABLE edges ADD COLUMN ref TEXT");
  db.exec(`UPDATE nodes SET source='rule' WHERE source IS NULL;
           UPDATE edges SET source='rule' WHERE source IS NULL;
           CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_type, src);
           CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_type, dst);
           CREATE TABLE IF NOT EXISTS theme_vecs(name TEXT PRIMARY KEY, vec BLOB);`);
}

// ---------- 2) 聚类：中心化（对付 e5 高锥效应）+ 密度种子贪心质心 ----------
// 实测参数（P&P 2210 块）：TH=0.38 → 86 堆 / 覆盖 89% / 0.9 秒
export function clusterChunks(db, { th = 0.38, minSize = 5, maxClusters = 0 } = {}) {
  const rows = db.prepare("SELECT id, chapter, emb FROM chunks WHERE emb IS NOT NULL ORDER BY id").all();
  if (!rows.length) return { clusters: [], method: "no-vectors", covered: 0, total: 0 };
  const total = rows.length;

  // 小书（<60 块）：有章节走章节堆（一章一堆），无章节整书单堆
  if (total < 60) {
    const byCh = new Map();
    for (const r of rows) {
      const key = r.chapter || "";
      if (!byCh.has(key)) byCh.set(key, []);
      byCh.get(key).push(r.id);
    }
    if (byCh.size > 1) {
      const clusters = [...byCh.entries()].map(([ch, ids], i) => ({
        id: `c${String(i + 1).padStart(3, "0")}`, members: ids, repIds: ids.slice(0, 2),
      }));
      return { clusters, method: "chapter-fallback", covered: total, total };
    }
    return { clusters: [{ id: "c001", members: rows.map(r => r.id), repIds: rows.slice(0, 2).map(r => r.id) }], method: "single", covered: total, total };
  }

  // 大书：贪心聚类，失败自动降阈值重试（0.02 步长，最多 4 次），全部失败走章节堆兜底
  for (let attempt = 0; attempt < 4; attempt++) {
    const curTh = +(th - attempt * 0.02).toFixed(3);
    const res = greedyCluster(rows, curTh, minSize);
    if (res.effective >= 3 && res.coverage >= 0.5) return finalizeClusters(res, curTh, maxClusters);
  }
  const byCh = new Map();
  for (const r of rows) {
    const key = r.chapter || "";
    if (!byCh.has(key)) byCh.set(key, []);
    byCh.get(key).push(r.id);
  }
  if (byCh.size > 1) {
    const clusters = [...byCh.entries()].map(([ch, ids], i) => ({ id: `c${String(i + 1).padStart(3, "0")}`, members: ids, repIds: ids.slice(0, 2) }));
    return { clusters, method: "chapter-fallback(retry-exhausted)", covered: total, total };
  }
  return { clusters: [{ id: "c001", members: rows.map(r => r.id), repIds: rows.slice(0, 2).map(r => r.id) }], method: "single(retry-exhausted)", covered: total, total };
}

function greedyCluster(rows, th, minSize) {
  const n = rows.length;
  const dim = rows[0].emb.length / 4;
  const V = new Float32Array(n * dim);
  const mean = new Float64Array(dim);
  for (let i = 0; i < n; i++) {
    const v = new Float32Array(rows[i].emb.buffer, rows[i].emb.byteOffset, rows[i].emb.byteLength / 4);
    for (let d = 0; d < dim; d++) mean[d] += v[d];
  }
  for (let d = 0; d < dim; d++) mean[d] /= n;
  for (let i = 0; i < n; i++) {
    const v = new Float32Array(rows[i].emb.buffer, rows[i].emb.byteOffset, rows[i].emb.byteLength / 4);
    let norm = 0;
    for (let d = 0; d < dim; d++) { const c = v[d] - mean[d]; V[i * dim + d] = c; norm += c * c; }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d++) V[i * dim + d] /= norm;
  }
  const cosIJ = (i, j) => { let s = 0; const a = i * dim, b = j * dim; for (let d = 0; d < dim; d++) s += V[a + d] * V[b + d]; return s; };

  // 邻接表（只留 cos>=0.30 的边，省内存）
  const nbr = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const s = cosIJ(i, j);
    if (s >= 0.30) { nbr[i].push({ j, s }); nbr[j].push({ j: i, s }); }
  }
  const density = nbr.map(l => l.filter(x => x.s >= th).length);
  const order = [...Array(n).keys()].sort((a, b) => density[b] - density[a]);
  const assign = new Int32Array(n).fill(-1);
  const clusters = [];  // { idxs: [行号] }
  for (const seed of order) {
    if (assign[seed] >= 0) continue;
    const ci = clusters.length;
    const idxs = [seed];
    assign[seed] = ci;
    for (const { j, s } of nbr[seed]) if (s >= th && assign[j] < 0) { assign[j] = ci; idxs.push(j); }
    clusters.push({ idxs });
  }

  const centroidOf = (idxs) => {
    const c = new Float32Array(dim);
    for (const i of idxs) for (let d = 0; d < dim; d++) c[d] += V[i * dim + d];
    let nn = 0; for (let d = 0; d < dim; d++) nn += c[d] * c[d];
    nn = Math.sqrt(nn) || 1;
    for (let d = 0; d < dim; d++) c[d] /= nn;
    return c;
  };

  // 两轮质心吸收：大堆质心再收 cos>=0.9*th 的未分配块
  for (let round = 0; round < 2; round++) {
    for (let ci = 0; ci < clusters.length; ci++) {
      const cl = clusters[ci];
      if (cl.idxs.length < minSize) continue;
      const cen = centroidOf(cl.idxs);
      for (let i = 0; i < n; i++) {
        if (assign[i] >= 0) continue;
        let s = 0; for (let d = 0; d < dim; d++) s += cen[d] * V[i * dim + d];
        if (s >= 0.9 * th) { assign[i] = ci; cl.idxs.push(i); }
      }
    }
  }

  // 碎堆归并：小堆整体并给最近大堆（cos>=0.7*th），并不进则成员标记未覆盖（assign=-2）
  const bigIdx = clusters.map((cl, i) => ({ i, size: cl.idxs.length })).filter(x => x.size >= minSize).map(x => x.i);
  const bigCens = new Map(bigIdx.map(i => [i, centroidOf(clusters[i].idxs)]));
  for (let ci = 0; ci < clusters.length; ci++) {
    if (bigIdx.includes(ci)) continue;
    const cl = clusters[ci];
    const cen = centroidOf(cl.idxs);
    let bestI = -1, bestS = -1;
    for (const bi of bigIdx) {
      let s = 0; const bc = bigCens.get(bi); for (let d = 0; d < dim; d++) s += cen[d] * bc[d];
      if (s > bestS) { bestS = s; bestI = bi; }
    }
    if (bestI >= 0 && bestS >= 0.7 * th) { clusters[bestI].idxs.push(...cl.idxs); cl.idxs = []; }
    else for (const i of cl.idxs) assign[i] = -2;
  }

  const effective = clusters.filter(cl => cl.idxs.length >= minSize).length;
  const covered = clusters.reduce((a, cl) => a + (cl.idxs.length >= minSize ? cl.idxs.length : 0), 0);
  return { V, dim, rows, clusters, effective, coverage: covered / n, th };
}

function finalizeClusters(res, th, maxClusters) {
  let clusters = res.clusters
    .filter(cl => cl.idxs.length >= 5)
    .sort((a, b) => b.idxs.length - a.idxs.length);
  let covered = clusters.reduce((a, cl) => a + cl.idxs.length, 0);
  if (maxClusters > 0 && clusters.length > maxClusters) {
    clusters = clusters.slice(0, maxClusters);
    covered = clusters.reduce((a, cl) => a + cl.idxs.length, 0);
  }
  // 代表块：与堆质心最近的 2 块
  const dim = res.dim, V = res.V;
  const out = clusters.map((cl, i) => {
    const cen = new Float32Array(dim);
    for (const idx of cl.idxs) for (let d = 0; d < dim; d++) cen[d] += V[idx * dim + d];
    let nn = 0; for (let d = 0; d < dim; d++) nn += cen[d] * cen[d];
    nn = Math.sqrt(nn) || 1;
    for (let d = 0; d < dim; d++) cen[d] /= nn;
    const scored = cl.idxs.map(idx => {
      let s = 0; for (let d = 0; d < dim; d++) s += cen[d] * V[idx * dim + d];
      return { idx, s };
    }).sort((a, b) => b.s - a.s);
    return {
      id: `c${String(i + 1).padStart(3, "0")}`,
      members: scored.map(x => res.rows[x.idx].id),
      repIds: scored.slice(0, 2).map(x => res.rows[x.idx].id),
    };
  });
  return { clusters: out, method: `centered-greedy-th${th}-min5`, covered, total: res.rows.length };
}

// ---------- 3) 任务书生成 ----------
const INSTRUCTIONS = `你是图书馆编目员。请只依据本任务书中的证据（词频、代表块、章节分布）为这本书编目，禁止使用你对该书的既有知识补充证据中不存在的细节。

输出单个 JSON 对象（不要 markdown 围栏、不要解释文字），字段如下：
{
  "task_ref": "<原样返回 book.db 字段>",
  "themes": [ { "id": "t1", "name": "主题名", "note": "一句话中文说明" } ],
  "persons": [ { "name": "人物标准名", "match_names": ["书中真实出现的写法", "..."], "note": "身份一句话" } ],
  "relations": [ { "a": "人物名", "b": "人物名", "note": "关系一句话" } ],
  "assignments": [ { "cluster": "c001", "theme": "t1" } ]
}

硬性要求：
1. assignments 必须覆盖 clusters 里出现的每一个 id，且只允许出现这些 id；每个 cluster 恰好分给一个 theme。
2. themes 数量建议 5~12 个，每个 theme 至少被一个 cluster 使用。
3. persons 的 match_names 里每个字符串必须是书中原文真实出现的写法（导入程序会逐一在原文检索验证，任何一条不存在则整批拒绝）。没有把握的写法不要写。
4. 只有真实出场的人物才列入 persons；relations 的 a/b 必须是 persons 里出现过的名字。
5. 主题名与人物名用与书中原文一致的语言（英文书用英文，中文书用中文）；说明性文字用中文。`;

export function buildTask(db, clusterRes) {
  const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
  const get = db.prepare("SELECT id, chapter, text FROM chunks WHERE id = ?");
  const allText = db.prepare("SELECT text FROM chunks").all().map(r => r.text).join("");
  const cjk = (allText.match(/[\u4e00-\u9fff]/g) || []).length;
  const lang = allText.length && cjk > allText.length * 0.15 ? "zh" : "en";
  const chapterCount = new Set(db.prepare("SELECT DISTINCT chapter FROM chunks WHERE chapter IS NOT NULL AND chapter != ''").all().map(r => r.chapter)).size;
  const clusters = clusterRes.clusters.map(cl => {
    const rows = cl.members.map(id => get.get(id));
    const terms = termFreq(rows.map(r => r.text));
    const chCount = new Map();
    for (const r of rows) { const ch = r.chapter || ""; if (ch) chCount.set(ch, (chCount.get(ch) || 0) + 1); }
    const chapters = [...chCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ch, n]) => ({ ch, n }));
    const samples = (cl.repIds || cl.members.slice(0, 2)).map(id => {
      const r = get.get(id);
      return { chunk: id, text: (r.text || "").slice(0, 200) };
    });
    return { id: cl.id, size: cl.members.length, members: cl.members, top_terms: terms, chapters, samples };
  });
  return {
    task_version: "1",
    generated_at: new Date().toISOString(),
    book: {
      db: path.basename(db.name), title: meta.title || path.basename(db.name), lang,
      chunks: +meta.chunk_count || 0, chapters: chapterCount, total_chars: +meta.total_chars || 0,
    },
    provenance: {
      cluster_model: meta.model || null, cluster_method: clusterRes.method,
      clustered_at: new Date().toISOString(), clusters: clusters.length, covered_chunks: clusterRes.covered,
    },
    clusters,
    instructions: INSTRUCTIONS,
  };
}

// ---------- 3.5) 一键提示词：任务书 → 可直接粘贴给任意 AI 的完整提示词 ----------
// 唯一真源 = 任务书里的 instructions 字段（不在这里另写一套规则，避免两端漂移）；
// members 截前 20 个省 token（cluster id 的用处只是 assignments 覆盖核对，前 20 够判断归属）。
export function buildPromptText(task) {
  const b = task.book || {};
  const clusters = task.clusters || [];
  const out = [];
  out.push(`请在阅读下面的【编目任务书】后，为《${b.title || b.db || "这本书"}》产出编目结果 JSON。`);
  out.push("");
  out.push("===== 编目任务书 =====");
  out.push(`book: ${b.db}（共 ${b.chunks ?? "?"} 块 / ${b.chapters ?? "?"} 章 / ${b.total_chars ?? "?"} 字，语言 ${b.lang || "?"}）`);
  out.push("");
  out.push(task.instructions || "(任务书缺 instructions 字段——本文件可能不是本程序生成的，建议重新走一遍导入)");
  out.push("");
  out.push(`===== clusters（共 ${clusters.length} 堆）=====`);
  for (const c of clusters) {
    const members = (c.members || []).slice(0, 20);
    const more = (c.members || []).length > members.length ? `（只列前 20/${c.members.length}，其余不影响归属判断）` : "";
    out.push(`- ${c.id}（${c.size} 块）${more}`);
    out.push(`  members: ${members.join(",")}`);
    if (c.top_terms?.length) out.push(`  高频词: ${c.top_terms.map((t) => `${t.t}×${t.n}`).join(" ")}`);
    if (c.chapters?.length) out.push(`  章节分布: ${c.chapters.map((x) => `${x.ch}×${x.n}`).join(" / ")}`);
    for (const s of c.samples || []) out.push(`  代表块 #${s.chunk}: ${String(s.text || "").replace(/\s+/g, " ").slice(0, 200)}`);
  }
  out.push("");
  out.push("===== 操作说明（给人看，AI 无需响应）=====");
  // book.db 是库文件名（xxx.db）；结果文件按 bookId 命名（去 .db），与 jobs/catalog-import 的约定一致
  const resultName = String(b.db || "<bookId>").replace(/\.db$/, "");
  out.push(`1. 拿到 AI 输出的 JSON 后，保存为文件：catalog-results/${resultName}.json`);
  out.push("2. 回到「我的书房」书架，在这张书卡上点「导入编目结果」并选中该文件——五重校验通过即入库。");
  return out.join("\n");
}

// ---------- 4) 编目结果校验（五重：JSON/zod schema/人物验真/cluster 全覆盖/引用完整） ----------
const ResultSchema = z.object({
  task_ref: z.string().min(1),
  themes: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), note: z.string().optional() })).min(1),
  persons: z.array(z.object({
    name: z.string().min(1),
    match_names: z.array(z.string().min(1)).min(1),
    note: z.string().optional(),
  })).optional().default([]),
  relations: z.array(z.object({ a: z.string().min(1), b: z.string().min(1), note: z.string().optional() })).optional().default([]),
  assignments: z.array(z.object({ cluster: z.string().min(1), theme: z.string().min(1) })).min(1),
});

export function parseResultText(text) {
  let t = String(text).trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  return JSON.parse(t);
}

export function validateResult(db, task, result) {
  const errors = [], warnings = [];
  const parsed = ResultSchema.safeParse(result);
  if (!parsed.success) {
    for (const iss of parsed.error.issues) errors.push(`schema: ${iss.path.join(".")} ${iss.message}`);
    return { ok: false, errors, warnings };
  }
  const r = parsed.data;
  if (r.task_ref !== task.book.db) errors.push(`task_ref 不匹配: ${r.task_ref} != ${task.book.db}`);
  const taskIds = new Set(task.clusters.map(c => c.id));
  const got = r.assignments.map(a => a.cluster);
  const gotSet = new Set(got);
  if (got.length !== gotSet.size) errors.push("assignments 存在重复的 cluster");
  for (const id of gotSet) if (!taskIds.has(id)) errors.push(`assignments 引用了任务书里不存在的 cluster: ${id}`);
  for (const id of taskIds) if (!gotSet.has(id)) errors.push(`cluster ${id} 未被 assignment 覆盖`);
  const themeIds = new Set(r.themes.map(t => t.id));
  for (const a of r.assignments) if (!themeIds.has(a.theme)) errors.push(`assignment 引用了不存在的 theme: ${a.theme}`);
  const used = new Set(r.assignments.map(a => a.theme));
  for (const t of r.themes) if (!used.has(t.id)) errors.push(`theme ${t.id}(${t.name}) 没有被任何 cluster 使用`);
  const names = new Set(r.persons.map(p => p.name));
  for (const rel of r.relations) {
    if (!names.has(rel.a)) errors.push(`relations.a 不是已声明人物: ${rel.a}`);
    if (!names.has(rel.b)) errors.push(`relations.b 不是已声明人物: ${rel.b}`);
  }
  // 防幻觉：人物 match_names 必须在原文真实出现
  const check = db.prepare("SELECT COUNT(*) n FROM chunks WHERE instr(lower(text), lower(?)) > 0");
  for (const p of r.persons) for (const m of p.match_names) {
    if (!check.get(m).n) errors.push(`人物「${p.name}」的 match_name「${m}」在原文中不存在（防幻觉校验）`);
  }
  if (r.themes.length > 20) warnings.push(`主题数 ${r.themes.length} 偏多`);
  if (r.persons.length > 30) warnings.push(`人物数 ${r.persons.length} 偏多`);
  return { ok: errors.length === 0, errors, warnings, data: r };
}

// ---------- 5) 入库（事务 + mention 扫描 + 主题向量） ----------
export async function importCatalog(db, task, result, { dryRun = false } = {}) {
  // 引擎一致性卫兵（放在校验前面：库和当前引擎不同空间时，theme_vecs 会写入错空间的向量，
  // 主题语义路从此失灵——这种错必须在入库前拦住，而不是入库后靠 eval 掉分才发现）
  assertEngine(db, DEFAULT_EMBED);
  const v = validateResult(db, task, result);
  if (!v.ok) {
    const e = new Error("编目结果校验失败:\n" + v.errors.map(x => " - " + x).join("\n"));
    e.errors = v.errors;
    throw e;
  }
  const r = v.data;
  const stats = { themes: r.themes.length, persons: r.persons.length, relations: r.relations.length, mention_edges: 0, covered_chunks: 0 };
  if (dryRun) return { ...stats, warnings: v.warnings, dry_run: true };

  ensureCatalogSchema(db);
  const embed = await getEmbedder();
  const chunkBaseline = db.prepare("SELECT COUNT(*) n, IFNULL(SUM(LENGTH(text)),0) b FROM chunks").get();

  // 主题名向量（必须在事务外算：transformers.js 是异步的）
  const themeNames = r.themes.map(t => t.name);
  const themeVecs = themeNames.length ? await embed.embedPassages(themeNames) : [];

  const tx = db.transaction(() => {
    // 幂等：重跑先清旧 llm 数据
    db.exec("DELETE FROM nodes WHERE source='llm'; DELETE FROM edges WHERE source='llm'; DELETE FROM theme_vecs;");
    const insNode = db.prepare("INSERT INTO nodes(type,name,ref,source) VALUES(?,?,?,'llm')");
    const insEdge = db.prepare("INSERT INTO edges(src_type,src,dst_type,dst,kind,weight,ref,source) VALUES(?,?,?,?,?,?,?,'llm')");

    for (const t of r.themes) insNode.run("theme", t.name, JSON.stringify({ note: t.note || "", id: t.id }));
    for (const p of r.persons) insNode.run("person", p.name, JSON.stringify({ note: p.note || "", match_names: p.match_names }));

    // chunk→theme belongs 边（cluster→theme 映射展开到成员块）
    const themeNameOf = new Map(r.assignments.map(a => [a.cluster, r.themes.find(t => t.id === a.theme)?.name]));
    for (const cl of task.clusters) {
      const tn = themeNameOf.get(cl.id);
      if (!tn) continue;
      for (const m of cl.members) { insEdge.run("chunk", String(m), "theme", tn, "belongs", 1, null); stats.covered_chunks++; }
    }

    // 人物关系边（ref 存关系描述）
    for (const rel of r.relations) insEdge.run("person", rel.a, "person", rel.b, "relation", 1, rel.note || "");

    // mention 边：match_names 全文扫描（英文词边界正则 / 中文 includes），按人物去重
    const chunks = db.prepare("SELECT id, text FROM chunks").all();
    const updPerson = db.prepare("UPDATE nodes SET ref=? WHERE type='person' AND name=? AND source='llm'");
    for (const p of r.persons) {
      const matched = new Set();
      for (const m of p.match_names) {
        const hasCJK = /[\u4e00-\u9fff]/.test(m);
        const re = hasCJK ? null : new RegExp(`\\b${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        for (const c of chunks) {
          if (hasCJK ? c.text.includes(m) : re.test(c.text)) matched.add(c.id);
        }
      }
      for (const id of matched) { insEdge.run("chunk", String(id), "person", p.name, "mention", 1, null); stats.mention_edges++; }
      const old = JSON.parse(db.prepare("SELECT ref FROM nodes WHERE type='person' AND name=? AND source='llm'").get(p.name).ref || "{}");
      updPerson.run(JSON.stringify({ ...old, mention_count: matched.size }), p.name);
    }

    // 主题名向量缓存
    const insVec = db.prepare("INSERT OR REPLACE INTO theme_vecs(name, vec) VALUES(?,?)");
    themeNames.forEach((name, i) => {
      const vec = themeVecs[i];
      insVec.run(name, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
    });

    // provenance + 保真基线（回滚演练与保真断言用）
    const meta = db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)");
    meta.run("catalog_model", embed.key);
    meta.run("catalog_at", new Date().toISOString());
    meta.run("catalog_themes", String(r.themes.length));
    meta.run("catalog_persons", String(r.persons.length));
    meta.run("catalog_chunk_count", String(chunkBaseline.n));
    meta.run("catalog_text_bytes", String(chunkBaseline.b));
  });
  tx();
  return stats;
}

// ---------- 6) 检索端编目信号（人物 literal + 关系扩散 + 主题语义） ----------
// 人物路：问题词边界匹配 match_names → mention 边取块，IDF 衰减（低频人物强信号）
//   同块信号求和封顶 1：同时提及多个"问题点名人物"的块累加优势（人物关系题的答案块特征）
// 关系扩散：问题点名的名字沿 relation 边一跳找相关人物（如问题提 Jane+Bingley → 扩散到 Caroline），
//   其 mention 块按 0.5 衰减加成——关系边在这里兑现检索价值
// 主题路：cos(qv, theme_vecs) 相对 margin 命中 → belongs 边取块；引擎不一致时自动跳过
export function loadCatalogSignal(db, q, qv, embedKey) {
  const hit = new Map();  // chunkId -> { w, tag }
  const qLow = String(q || "").toLowerCase();
  const add = (id, w, tag) => {
    const prev = hit.get(id);
    if (!prev) hit.set(id, { w: Math.min(1, w), tag });
    else hit.set(id, { w: Math.min(1, prev.w + w), tag: prev.tag.includes(tag) ? prev.tag : prev.tag + "+" + tag });
  };
  const mentionEdge = db.prepare("SELECT src FROM edges WHERE kind='mention' AND dst_type='person' AND dst=?");
  try {
    const persons = db.prepare("SELECT name, ref FROM nodes WHERE type='person' AND source='llm'").all();
    const infoOf = (p) => { try { return JSON.parse(p.ref || "{}"); } catch { return {}; } };
    const matched = new Map();  // name -> factor
    for (const p of persons) {
      const info = infoOf(p);
      const names = info.match_names || [];
      const isMatched = names.some(n => {
        if (!n) return false;
        return /[\u4e00-\u9fff]/.test(n)
          ? qLow.includes(n.toLowerCase())
          : new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(qLow);
      });
      if (!isMatched) continue;
      const factor = Math.min(1, 30 / Math.max(1, info.mention_count || 1));
      matched.set(p.name, factor);
      for (const row of mentionEdge.all(p.name)) add(+row.src, factor, "person");
    }
    // 关系一跳扩散（默认关，BSP_EXPAND=1 开；扩散权重随点名人物的因子衰减）
    // 实测矩阵结论：扩散在当前金标准上是纯噪声（把"达西"扇出到冷门人物重掷骰子），
    // 且关掉后三道关键题全过——关系边的主要价值在 list_catalog 浏览，不在检索信号
    if (matched.size && process.env.BSP_EXPAND === "1") {
      const minFactor = Math.min(...matched.values());
      const expanded = new Map();  // 相关人物名 -> factor
      for (const e of db.prepare("SELECT src, dst FROM edges WHERE kind='relation' AND source='llm'").all()) {
        let other = null;
        if (matched.has(e.src)) other = e.dst;
        else if (matched.has(e.dst)) other = e.src;
        if (!other || matched.has(other) || expanded.has(other)) continue;
        const p = persons.find(x => x.name === other);
        if (!p) continue;
        const info = infoOf(p);
        expanded.set(other, Math.min(1, 30 / Math.max(1, info.mention_count || 1)) * minFactor);
      }
      for (const [name, factor] of expanded)
        for (const row of mentionEdge.all(name)) add(+row.src, factor * 0.5, "person");
    }
  } catch { /* 未编目/表不存在 → 静默跳过 */ }
  try {
    if (qv && embedKey) {
      const cm = db.prepare("SELECT value FROM meta WHERE key='catalog_model'").get()?.value;
      if (cm === embedKey) {
        const tvs = db.prepare("SELECT name, vec FROM theme_vecs").all();
        if (tvs.length) {
          const sims = tvs.map(t => ({
            name: t.name,
            s: cosine(qv, new Float32Array(t.vec.buffer, t.vec.byteOffset, t.vec.byteLength / 4)),
          })).sort((a, b) => b.s - a.s);
          // margin（可调 BSP_THEME_MARGIN，默认 0.05）：主题名余弦经常挤成一团，
          // margin 太松会让"看似都像"的错误主题抢答；单主题书不受影响
          // strength 上限（可调 BSP_THEME_CAP，默认 0.6）：主题信号是弱先验，权重大了会挤掉答案块
          const MARGIN = +(process.env.BSP_THEME_MARGIN || 0.05);
          const CAP = +(process.env.BSP_THEME_CAP || 0.6);
          if (sims[0].s >= 0.73 && (sims.length < 2 || sims[0].s - sims[1].s >= MARGIN)) {
            const strength = Math.min(1, Math.max(0, (sims[0].s - 0.73) / 0.1)) * CAP;
            for (const row of db.prepare("SELECT src FROM edges WHERE kind='belongs' AND dst_type='theme' AND dst=?").all(sims[0].name))
              add(+row.src, strength, "theme");
          }
        }
      }
    }
  } catch { }
  return { hit };
}

// ---------- 7) 回滚（整批删 llm 层，rule 层与 chunks 永不受伤） ----------
export function rollbackCatalog(db) {
  ensureCatalogSchema(db);
  db.exec(`DELETE FROM nodes WHERE source='llm';
           DELETE FROM edges WHERE source='llm';
           DELETE FROM theme_vecs;
           DELETE FROM meta WHERE key LIKE 'catalog_%';`);
}

// ---------- 8) 编目浏览（MCP list_catalog 用） ----------
export function getCatalogSummary(dbPath, themeFilter) {
  let db;
  try { db = new Database(dbPath, { readonly: true }); } catch { return { cataloged: false }; }
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name IN ('nodes','edges','theme_vecs')").all().map(r => r.name);
    if (!tables.includes("nodes") || !tables.includes("edges")) return { cataloged: false };
    // 只读连接无法迁移：没有 source 列说明这本书从未走过编目/新版 embed 流程
    const nodeCols = db.prepare("PRAGMA table_info(nodes)").all().map(c => c.name);
    if (!nodeCols.includes("source")) return { cataloged: false, note: "这本书还没有编目（可运行 catalog-export / catalog-import 流程）" };
    const nThemes = db.prepare("SELECT COUNT(*) c FROM nodes WHERE type='theme' AND source='llm'").get().c;
    if (!nThemes) return { cataloged: false, note: "这本书还没有编目（可运行 catalog-export / catalog-import 流程）" };
    const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
    const belongs = db.prepare(`SELECT e.dst theme, COUNT(*) n FROM edges e WHERE e.kind='belongs' AND e.source='llm' GROUP BY e.dst`).all();
    const chRows = db.prepare(`SELECT e.dst theme, c.chapter ch, COUNT(*) n FROM edges e JOIN chunks c ON c.id = +e.src
      WHERE e.kind='belongs' AND e.source='llm' AND c.chapter IS NOT NULL AND c.chapter != ''
      GROUP BY e.dst, c.chapter ORDER BY n DESC`).all();
    const chMap = new Map();
    for (const r of chRows) {
      if (!chMap.has(r.theme)) chMap.set(r.theme, []);
      if (chMap.get(r.theme).length < 5) chMap.get(r.theme).push(r.ch);
    }
    const themes = db.prepare("SELECT name, ref FROM nodes WHERE type='theme' AND source='llm' ORDER BY rowid").all().map(t => {
      let note = "";
      try { note = JSON.parse(t.ref || "{}").note || ""; } catch { }
      const b = belongs.find(x => x.theme === t.name);
      return { name: t.name, note, chunks: b ? b.n : 0, chapters: chMap.get(t.name) || [] };
    });
    const persons = db.prepare("SELECT name, ref FROM nodes WHERE type='person' AND source='llm' ORDER BY rowid").all().map(p => {
      let info = {};
      try { info = JSON.parse(p.ref || "{}"); } catch { }
      return { name: p.name, note: info.note || "", match_names: info.match_names || [], mention_count: info.mention_count || 0 };
    });
    const relations = db.prepare("SELECT src, dst, ref FROM edges WHERE kind='relation' AND source='llm' ORDER BY rowid").all()
      .map(e => ({ a: e.src, b: e.dst, note: e.ref || "" }));
    const out = { cataloged: true, cataloged_at: meta.catalog_at || null, catalog_model: meta.catalog_model || null, themes, persons, relations };
    if (themeFilter) {
      const f = String(themeFilter).toLowerCase();
      const th = themes.filter(t => t.name.toLowerCase().includes(f));
      out.theme_filter = themeFilter;
      out.filtered_themes = th;
      if (th.length) {
        const get = db.prepare("SELECT id, chapter, text FROM chunks WHERE id = ?");
        out.theme_representatives = {};
        for (const t of th) {
          const ids = db.prepare("SELECT src FROM edges WHERE kind='belongs' AND dst_type='theme' AND dst=? LIMIT 5").all(t.name).map(r2 => +r2.src);
          out.theme_representatives[t.name] = ids.map(id => {
            const c = get.get(id);
            return { chunk: id, chapter: c?.chapter || "", preview: (c?.text || "").slice(0, 80) };
          });
        }
      }
    }
    return out;
  } finally { db.close(); }
}

// ---------- 9) 图谱深查（MCP get_person / get_theme 用，P-D） ----------
// 与 getCatalogSummary 同层的只读查询：把"看一眼全图"升级成"按人/按主题摸到原文块"。
// 检索层零改动——这两个函数是浏览接口，不是检索信号（loadCatalogSignal 一行不动）。
const REP_CHUNKS = 5;
function catalogGuard(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE name IN ('nodes','edges')").all().map(r => r.name);
  if (!tables.includes("nodes") || !tables.includes("edges")) return { cataloged: false };
  const nodeCols = db.prepare("PRAGMA table_info(nodes)").all().map(c => c.name);
  if (!nodeCols.includes("source")) return { cataloged: false, note: "这本书还没有编目（可运行 catalog-export / catalog-import 流程）" };
  return null;
}

// 节点名匹配：精确 → 忽略大小写 → 片段包含（片段命中时给出候选清单，避免智能体猜错名字白跑一趟）
function matchNode(rows, name) {
  const q = String(name || "").trim().toLowerCase();
  return rows.find(x => x.name === name)
    || rows.find(x => x.name.toLowerCase() === q)
    || rows.find(x => x.name.toLowerCase().includes(q))
    || null;
}

// 代表块：均匀抽样（首/25%/50%/75%/末）——覆盖全书弧线，比"取前 5 块"信息量大；
// 确定性无随机（同输入同输出，测试可断言）
function representativeChunks(db, ids, n = REP_CHUNKS) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const picks = sorted.length <= n ? sorted
    : Array.from({ length: n }, (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (n - 1))]);
  const get = db.prepare("SELECT id, chapter, page, text FROM chunks WHERE id = ?");
  const out = [];
  for (const id of picks) {
    const c = get.get(id);
    if (!c) continue;
    out.push({
      chunk: id, chapter: c.chapter || "", page: c.page ?? null,
      loc: c.page ? `第${c.page}页` : (c.chapter || ""), preview: (c.text || "").slice(0, 80),
    });
  }
  return out;
}

// 人物深查：身份 / 书中写法 / 出场块数 / 关系边 / 提到他她的代表原文块
export function getPersonDetail(dbPath, name) {
  let db;
  try { db = new Database(dbPath, { readonly: true }); } catch { return { cataloged: false }; }
  try {
    const g = catalogGuard(db);
    if (g) return g;
    const persons = db.prepare("SELECT name, ref FROM nodes WHERE type='person' AND source='llm' ORDER BY rowid").all();
    if (!persons.length) return { cataloged: false, note: "这本书还没有编目（可运行 catalog-export / catalog-import 流程）" };
    const p = matchNode(persons, name);
    if (!p) return { cataloged: true, error: "person-not-found", name: String(name || ""), available: persons.map(x => x.name) };
    let info = {};
    try { info = JSON.parse(p.ref || "{}"); } catch { }
    const mentionIds = db.prepare("SELECT src FROM edges WHERE kind='mention' AND dst_type='person' AND dst=? AND source='llm'")
      .all(p.name).map(r => +r.src);
    const relations = db.prepare("SELECT src, dst, ref FROM edges WHERE kind='relation' AND source='llm' AND (src=? OR dst=?)")
      .all(p.name, p.name).map(e => ({
        a: e.src, b: e.dst, note: e.ref || "",
        other: e.src === p.name ? e.dst : e.src, // 关系另一头（智能体追问"那还有谁"用得上）
      }));
    return {
      cataloged: true, person: p.name, note: info.note || "",
      match_names: info.match_names || [], mention_count: info.mention_count || 0,
      mention_chunks: mentionIds.length,
      relations, representative_chunks: representativeChunks(db, mentionIds),
    };
  } finally { db.close(); }
}

// 主题深查：说明 / 覆盖块数 / 章节分布 / 代表原文块
export function getThemeDetail(dbPath, name) {
  let db;
  try { db = new Database(dbPath, { readonly: true }); } catch { return { cataloged: false }; }
  try {
    const g = catalogGuard(db);
    if (g) return g;
    const themes = db.prepare("SELECT name, ref FROM nodes WHERE type='theme' AND source='llm' ORDER BY rowid").all();
    if (!themes.length) return { cataloged: false, note: "这本书还没有编目（可运行 catalog-export / catalog-import 流程）" };
    const t = matchNode(themes, name);
    if (!t) return { cataloged: true, error: "theme-not-found", name: String(name || ""), available: themes.map(x => x.name) };
    let note = "";
    try { note = JSON.parse(t.ref || "{}").note || ""; } catch { }
    const belongsIds = db.prepare("SELECT src FROM edges WHERE kind='belongs' AND dst=? AND source='llm'")
      .all(t.name).map(r => +r.src);
    // 章节分布（封顶 8：代表性分布，与 getCatalogSummary 的 chMap 同语义）
    const chRows = db.prepare(`SELECT c.chapter ch, COUNT(*) n FROM edges e JOIN chunks c ON c.id = +e.src
      WHERE e.kind='belongs' AND e.source='llm' AND e.dst=? AND c.chapter IS NOT NULL AND c.chapter != ''
      GROUP BY c.chapter ORDER BY n DESC`).all(t.name);
    return {
      cataloged: true, theme: t.name, note,
      chunks: belongsIds.length,
      chapters: chRows.slice(0, 8).map(r => ({ chapter: r.ch, n: r.n })),
      chapters_total: chRows.length,
      representative_chunks: representativeChunks(db, belongsIds),
    };
  } finally { db.close(); }
}
