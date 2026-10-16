// 洗数据信号提名验收（V3 第三波-①）：三路匹配/地板/配额/df 过滤/开关零变化/真库冒烟
// 跑法: node test/enrich-nom-test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const Database = require("better-sqlite3");

import { loadEnrichSignal } from "../src/lib/enrich-signal.mjs";
import { hybridSearch } from "../src/lib/search.mjs";

const LIB = path.join(__dirname, "..", "library");
const LUNYU = path.join(LIB, "lunyu-xueer-zh.docx.db");   // 真库：唯一洗过数据的书
const NOENR = path.join(LIB, "attention-is-all-you-need-en.pdf.db"); // 未洗数据的库
let failed = 0;
const assert = (cond, msg, extra = "") => {
  console.log((cond ? "PASS" : "FAIL") + " - " + msg + (cond ? "" : ` ${extra}`));
  if (!cond) failed++;
};
const ids = (rs) => rs.map((r) => r.id).join(",");

// ===== 1) 模块级：真库（论语）信号产出 =====
{
  const db = new Database(LUNYU, { readonly: true });
  const r = loadEnrichSignal(db, "學而時習之是什麼意思");
  const c1 = r.hit.get(1);
  assert(c1 && c1.w >= 0.8 && c1.tag.includes("tag"), `三源全中：chunk#1 w=${c1?.w} tag=${c1?.tag}`);
  const r2 = loadEnrichSignal(db, "先王之道是什麼");
  const top2 = [...r2.hit.entries()].sort((a, b) => b[1].w - a[1].w)[0];
  assert(top2 && top2[0] === 12 && top2[1].w >= 0.5, `「先王之道」命中 chunk#12（w=${top2?.[1].w}）`);
  assert(loadEnrichSignal(db, "").hit.size === 0, "空问题 → 空信号");
  db.close();
}
{
  const db = new Database(NOENR, { readonly: true });
  assert(loadEnrichSignal(db, "transformer attention").hit.size === 0, "未洗数据的库 → 静默返回空（零变化前提）");
  db.close();
}

// ===== 2) 夹具临时库：提名/地板/配额/df 过滤/加权腿（可控场景） =====
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-enrnom-"));
const TDB = path.join(dir, "t.db");
{
  const db = new Database(TDB);
  db.exec(`
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, text TEXT, chapter TEXT, page INTEGER, tags TEXT, questions TEXT);
    CREATE TABLE chunk_tags(tag TEXT NOT NULL, chunk_id INTEGER NOT NULL, PRIMARY KEY(tag, chunk_id));
    CREATE TABLE summaries(scope TEXT NOT NULL, ref TEXT NOT NULL, summary TEXT NOT NULL, updated_at TEXT, PRIMARY KEY(scope, ref));
  `);
  const insC = db.prepare("INSERT INTO chunks(id, text, chapter, page, tags, questions) VALUES(?,?,?,?,?,?)");
  const insT = db.prepare("INSERT INTO chunk_tags(tag, chunk_id) VALUES(?,?)");
  const insS = db.prepare("INSERT INTO summaries(scope, ref, summary, updated_at) VALUES('chunk',?,?,?)");
  const cn = "一二三四五六七八九十";
  for (let i = 1; i <= 8; i++) insC.run(i, `無關段落${cn[i - 1]}`, "第1章", null, "[]", null);
  insC.run(9, "無關段落壬", "第1章", null, "[]", JSON.stringify(["青鋒寶劍該如何保養？"]));
  insC.run(10, "獨孤九式的精要", "第1章", null, "[]", null);   // 在池（字面命中）+ 摘要信号
  insC.run(11, "無關段落癸", "第1章", null, "[]", null);      // 只挂弱摘要（1 词 → 0.12 < 地板）
  for (let i = 1; i <= 8; i++) insT.run(`門派${cn[i - 1]}`, i); // df=1：8 块各有专属标签 → 配额场景
  for (let i = 1; i <= 5; i++) insT.run("廢話", i);             // df=5/11 > 30% → 标签级过滤
  insT.run("廢話", 9);
  insS.run("10", "獨孤九式劍法的心得", "t");
  insS.run("11", "獨孤一劍", "t");                              // 「獨孤」1 词命中 → 0.12 被地板丢
  db.close();
}

// 2a) 配额：8 个候选只提名 6 个（模式 0 同问句空池空果 = 零变化）
{
  process.env.BSP_ENRICH_NOM = "0";
  const r0 = await hybridSearch(TDB, "門派與廢話的心法", 30, { rerank: false });
  assert(r0.length === 0, `模式 0：全池外问句结果为空（${ids(r0)}）`);
  process.env.BSP_ENRICH_NOM = "1";
  const r1 = await hybridSearch(TDB, "門派與廢話的心法", 30, { rerank: false });
  const noms = r1.filter((r) => r.nom);
  assert(noms.length === 6, `配额封顶：8 候选只提名 6（实际 ${noms.length}）`);
  assert(noms.every((r) => r.enr === "tag"), "提名都带 tag 来源标");
  assert(!r1.some((r) => r.id === 9), "df 过滤：只挂高频标签「廢話」的块不进提名");
}

// 2b) 问题路提名（池外）+ 2c) 地板：单摘要 0.12 不配提名
{
  process.env.BSP_ENRICH_NOM = "1";
  const rq = await hybridSearch(TDB, "青鋒寶劍的保養要領", 10, { rerank: false });
  const n9 = rq.find((r) => r.id === 9);
  assert(n9 && n9.nom && n9.enr === "question", `问题路提名：chunk#9 凭假设问题进窗（enr=${n9?.enr}）`);
  const rs = await hybridSearch(TDB, "獨孤九式的精要", 10, { rerank: false });
  assert(!rs.some((r) => r.id === 11), "地板：单摘要命中 0.12 < 0.15 被无效化（chunk#11 不进）");
  const n10 = rs.find((r) => r.id === 10);
  assert(n10 && !n10.nom, "chunk#10 在池（字面命中）不进提名");
}

// 2d) 加权腿（模式 2）：池内块涨分且带 enrW；池外块不受加权腿影响
{
  process.env.BSP_ENRICH_NOM = "0";
  const m0 = (await hybridSearch(TDB, "獨孤九式的精要", 10, { rerank: false })).find((r) => r.id === 10);
  process.env.BSP_ENRICH_NOM = "2";
  const r2 = await hybridSearch(TDB, "獨孤九式的精要", 10, { rerank: false });
  const m2 = r2.find((r) => r.id === 10);
  assert(m0 && m2 && m2.score > m0.score && m2.enrW > 0 && m2.enr === "summary",
    `加权腿：池内块涨分（${m0?.score.toFixed(3)} → ${m2?.score.toFixed(3)}，enrW=${m2?.enrW}）`);
  assert(!r2.some((r) => r.id === 11), "加权腿只作用于池内：池外弱信号块仍不进（chunk#11 缺席）");
}

// ===== 3) 开关零变化（真库）：模式 0 与未设置 / 未洗数据的库完全一致 =====
{
  delete process.env.BSP_ENRICH_NOM;
  const a = await hybridSearch(LUNYU, "學而時習之的意思", 6, { rerank: false });
  process.env.BSP_ENRICH_NOM = "0";
  const b = await hybridSearch(LUNYU, "學而時習之的意思", 6, { rerank: false });
  assert(ids(a) === ids(b), `模式 0 与未设置结果一致（${ids(a)}）`);
  assert(a.every((r) => !r.enr && !r.nom), "模式 0 结果不带 enr/nom 字段");
  process.env.BSP_ENRICH_NOM = "1";
  const c = await hybridSearch(NOENR, "multi head attention", 4, { rerank: false });
  process.env.BSP_ENRICH_NOM = "0";
  const d = await hybridSearch(NOENR, "multi head attention", 4, { rerank: false });
  assert(ids(c) === ids(d), "未洗数据的库：模式 1 与 0 结果一致（静默跳过）");
  delete process.env.BSP_ENRICH_NOM;
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`===== enrich-nom-test: ${failed ? failed + " FAIL" : "全部 PASS"} =====`);
process.exit(failed ? 1 : 0);
