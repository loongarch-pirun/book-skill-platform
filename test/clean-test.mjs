// clean-book 全离线测试（假 chatFn 零真钱）：护栏 G1-G3 单元 / G4 闸门 / 判定对齐 /
// 宽容解析 / 断点续跑+双 stale / 孟子零误杀（真库+恒 keep）/ import 对账（quarantine/
// chunks/FTS/meta 六键）/ 悬空边清理 / TAMPER 回滚 / 恢复全对账 / CANCELLED 穿层 /
// 画像降级 / SMALL 跳过。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import {
  buildCleanTasks, buildChapterTree, buildProfileMessages, parseProfile,
  parseCleanAnswer, matchVerdicts,
  isSubstantiveShort, hasQuotedOrCodeFeature, isValidDropReason, applyGuards,
  cleanBatch, loadCleanCache, runClean,
} from "../src/lib/clean.mjs";
import { importClean, auditClean, restoreClean } from "../src/lib/clean-import.mjs";

let failed = 0;
const assert = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (!cond) failed++; };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), msg + (JSON.stringify(a) === JSON.stringify(b) ? "" : `（got ${JSON.stringify(a)?.slice?.(0, 120)} want ${JSON.stringify(b)?.slice?.(0, 120)}）`));

// 临时库构造（DDL 与 build-book.js:522 一致：chunks + external content FTS5 + meta）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "clean-test-"));
function mkDb(name, blocks, { withFts = true, withEdges = false, embCol = false } = {}) {
  const p = path.join(TMP, name);
  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);");
  db.exec(`CREATE TABLE chunks(
    id INTEGER PRIMARY KEY, chapter TEXT, chapter_path TEXT, page INTEGER, text TEXT NOT NULL
  );`);
  if (embCol) db.exec("ALTER TABLE chunks ADD COLUMN emb BLOB;");
  if (withFts) {
    db.exec(`CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='trigram');`);
  }
  if (withEdges) {
    db.exec("CREATE TABLE edges(src_type TEXT, src TEXT, dst_type TEXT, dst TEXT, kind TEXT, weight REAL, ref TEXT, source TEXT);");
  }
  const ins = db.prepare("INSERT INTO chunks(chapter, chapter_path, page, text) VALUES (?,?,?,?)");
  const insFts = withFts ? db.prepare("INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)") : null;
  const tx = db.transaction(() => {
    blocks.forEach((b, i) => {
      const r = ins.run(b.chapter ?? "章", b.chapter_path ?? null, null, b.text);
      if (insFts) insFts.run(r.lastInsertRowid, b.text);
    });
  });
  tx();
  db.close();
  return p;
}

// 假 chatFn 工厂：画像调用回合法画像 JSON；判定调用按脚本（Map idx→verdict 对象）生成
function mkChat(script = new Map(), opts = {}) {
  let profileCalls = 0, cleanCalls = 0;
  const fn = async ({ messages }) => {
    const sys = messages[0]?.content || "";
    if (sys.includes("图书编辑")) {
      profileCalls++;
      if (opts.profileFails) return { ok: true, text: "不是 JSON" };
      return { ok: true, text: '{"summary":"测试书","typical":"正文块","pollution":["论坛水贴"]}', usage: { prompt_tokens: 100, completion_tokens: 50 } };
    }
    cleanCalls++;
    const userMsg = messages[1]?.content || "";
    // 只取「本批待判」段里的 idx（前后文参照不带 [idx] 前缀，天然区分）
    const judged = [...userMsg.matchAll(/\[idx (\d+)\]/g)].map(m => +m[1]);
    const out = judged.map(idx => {
      const v = script.get(idx);
      return v || { idx, verdict: "keep" };
    });
    return { ok: true, text: JSON.stringify(out), usage: { prompt_tokens: 800, completion_tokens: 100 } };
  };
  fn.calls = () => ({ profileCalls, cleanCalls });
  return fn;
}

const config = { baseUrl: "https://fake.example/v1", apiKey: "sk-test", model: "fake" };
const resultsDir = () => fs.mkdtempSync(path.join(TMP, "res-"));
// 超长无特征文本（>50 字符且不含 G2 特征）——凡希望 drop 放行的样块都用它拼
const longText = "这一段的正文内容足够长所以完全不受短块护栏保护，属于稳稳超过五十字符红线以上的长块，可以放心交给判定流水线处理不需要担忧。";

// ---------- 1) G1 实义短块保护 ----------
console.log("===== 1) G1 isSubstantiveShort 边界用例 =====");
{
  assert(isSubstantiveShort("民為貴，君為輕。") === true, "G1: 文言短句「民為貴，君為輕」（实义6）保护");
  assert(isSubstantiveShort("2010-09-06 21:33 1016楼") === false, "G1: 楼层时间戳（实义1）不保护");
  assert(isSubstantiveShort("第一章……3") === false, "G1: 目录点线块（实义3）不保护");
  assert(isSubstantiveShort("哈哈哈") === false, "G1: 「哈哈哈」（实义3）不保护");
  assert(isSubstantiveShort("学习了谢谢楼主") === true, "G1: 「学习了谢谢楼主」（实义7）保护（宁误保护不误删）");
  assert(isSubstantiveShort("a".repeat(50)) === false, "G1: ≥50 字符长块不享受 G1");
  assert(isSubstantiveShort("mark") === false, "G1: 纯英文 4 字母不保护");
  assert(isSubstantiveShort("hello") === true, "G1: 英文 5 字母保护");
  assert(isSubstantiveShort("顶一下") === false, "G1: 「顶一下」（实义3）不保护");
}

// ---------- 2) G2 引文/公式/代码特征 ----------
console.log("===== 2) G2 hasQuotedOrCodeFeature =====");
{
  assert(hasQuotedOrCodeFeature("《红楼梦》是名著") === true, "G2: 书名号保护");
  assert(hasQuotedOrCodeFeature("他说「你好」然后走了") === true, "G2: 配对引号保护");
  assert(hasQuotedOrCodeFeature("公式 x=1 且 a≤b") === true, "G2: 数学符号保护");
  assert(hasQuotedOrCodeFeature("function foo() { return 1; }") === true, "G2: 代码关键字保护");
  assert(hasQuotedOrCodeFeature("访问 https://spam.example 领奖") === false, "G2: URL 不保护（广告常带）");
  assert(hasQuotedOrCodeFeature("普通一段话没有任何特征") === false, "G2: 普通文本不触发");
}

// ---------- 3) G3 + applyGuards 全链 ----------
console.log("===== 3) G3 理由合格性 + applyGuards 顺序过闸 =====");
{
  assert(isValidDropReason({ cat: "spam", reason: "读者插楼水贴，与正文无关" }) === true, "G3: 合法 drop 理由");
  assert(isValidDropReason({ cat: "nonsense", reason: "abc" }) === false, "G3: 理由 <4 字不合格");
  assert(isValidDropReason({ cat: "xxx", reason: "理由足够长了" }) === false, "G3: cat 非枚举不合格");
  assert(isValidDropReason({ cat: "spam" }) === false, "G3: 缺 reason 不合格");
  const blocks = [
    { text: "民為貴，君為輕。", chapter: "尽心" },             // 0: G1 保护（实义6）
    { text: "《史记》有云，天下大势分久必合。", chapter: "尽心" }, // 1: G2 保护（书名号）
    { text: "哈哈哈哈", chapter: "尽心" },                      // 2: 实义4 无护栏 → drop 放行
    { text: "不敢妄言，如果能够提供更详细的信息或许可以试着分析", chapter: "尽心" }, // 3: G1（实义≥5）保护
  ];
  const batch = { items: blocks.map((b, i) => ({ idx: i, ...b })), prevCtx: [], nextCtx: [] };
  const byIdx = new Map([
    [0, { idx: 0, verdict: "drop", cat: "nonsense", reason: "不知所云的短句" }],
    [1, { idx: 1, verdict: "drop", cat: "off_topic", reason: "与本书无关的引用" }],
    [2, { idx: 2, verdict: "drop", cat: "spam", reason: "论坛灌水帖子内容" }],
    [3, { idx: 3, verdict: "drop", cat: "spam", reason: "读者的插楼回复灌水" }],
  ]);
  const g = applyGuards(byIdx, batch);
  eq(g.verdicts.map(v => v.verdict), ["keep", "keep", "drop", "keep"], "G 闸: 文言/书名号/长实义块被拦回，纯水贴放行");
  eq(g.guarded.map(x => x.by), ["G1", "G2", "G1"], "G 闸: guarded 记录 G1/G2/G1");
}

// ---------- 4) 判定对齐 MISALIGN + 宽容解析 ----------
console.log("===== 4) matchVerdicts + parseCleanAnswer =====");
{
  const batch = { items: [{ idx: 5, text: "甲" }, { idx: 6, text: "乙" }], prevCtx: [], nextCtx: [] };
  assert(matchVerdicts([{ idx: 5, verdict: "keep" }, { idx: 6, verdict: "keep" }], batch) !== null, "对齐: 完整 idx 集合通过");
  assert(matchVerdicts([{ idx: 5, verdict: "keep" }], batch) === null, "对齐: 缺号整批拒收");
  assert(matchVerdicts([{ idx: 5, verdict: "keep" }, { idx: 7, verdict: "keep" }], batch) === null, "对齐: 越界整批拒收");
  assert(matchVerdicts([{ idx: 5, verdict: "keep" }, { idx: 5, verdict: "drop" }], batch) === null, "对齐: 重号整批拒收");
  assert(matchVerdicts([{ idx: 5, verdict: "KEEP" }, { idx: 6, verdict: " Drop " }], batch) !== null, "对齐: verdict 大小写宽容");
  assert(matchVerdicts([{ idx: 5, verdict: "delete" }, { idx: 6, verdict: "keep" }], batch) === null, "对齐: verdict 非法值拒收");
  assert(parseCleanAnswer('```json\n[{"idx":0,"verdict":"keep"}]\n```')?.length === 1, "解析: 围栏包裹");
  assert(parseCleanAnswer('前置说明 [ {"idx":0,"verdict":"keep"} ] 后置')?.length === 1, "解析: 前后夹带");
  assert(parseCleanAnswer("不是 JSON") === null, "解析: 坏文本返回 null");
}

// ---------- 5) 单批 cleanBatch + CANCELLED 穿层 ----------
console.log("===== 5) cleanBatch 调用链 =====");
{
  const blocks = [
    { idx: 0, text: "甲块正文内容足够长，超过五十个字符的保护线，判定删除可以放行的样例文本。", chapter: "一" },
    { idx: 1, text: "乙块正文内容同样足够长超过保护线，带楼层时间戳的插楼水贴样例 2010-09-06 21:33 1016楼。", chapter: "一" },
  ];
  const batch = { items: blocks, prevCtx: [], nextCtx: [] };
  const chat = mkChat(new Map([[1, { idx: 1, verdict: "drop", cat: "spam", reason: "插楼水贴无疑" }]]));
  const r = await cleanBatch("测试书", null, batch, { chatFn: chat, config });
  assert(r.ok === true && r.verdicts[1].verdict === "drop" && r.verdicts[1].cat === "spam", "cleanBatch: drop 判定通过护栏放行");
  assert(r.usage && r.usage.prompt_tokens === 800, "cleanBatch: usage 透传");
  const badChat = async () => ({ ok: true, text: "坏输出" });
  const r2 = await cleanBatch("测试书", null, batch, { chatFn: badChat, config });
  assert(r2.ok === false && r2.code === "BADRESP", "cleanBatch: 坏输出 → BADRESP 不抛");
  const alignChat = async () => ({ ok: true, text: JSON.stringify([{ idx: 0, verdict: "keep" }]) });
  const r3 = await cleanBatch("测试书", null, batch, { chatFn: alignChat, config });
  assert(r3.ok === false && r3.code === "MISALIGN", "cleanBatch: 缺号 → MISALIGN 整批拒收");
  const cancelChat = async () => { const e = new Error("cancelled"); e.code = "CANCELLED"; throw e; };
  let threw = false;
  try { await cleanBatch("测试书", null, batch, { chatFn: cancelChat, config }); }
  catch (e) { threw = e?.code === "CANCELLED"; }
  assert(threw, "cleanBatch: CANCELLED 唯一穿层例外");
}

// ---------- 6) 画像 ----------
console.log("===== 6) buildProfileMessages + parseProfile =====");
{
  const m = buildProfileMessages("孟子", "梁惠王上\n  尽心上");
  assert(m[0].role === "system" && m[0].content.includes("JSON"), "画像: messages 结构");
  const p = parseProfile('```json\n{"summary":"儒家经典","typical":"文言对话体","pollution":["注解","水贴"]}\n```');
  assert(p && p.summary === "儒家经典" && p.pollution.length === 2, "画像: 宽容解析+字段归一");
  assert(parseProfile('{"summary":""}') === null, "画像: 空 summary 拒收");
  assert(parseProfile("垃圾") === null, "画像: 坏文本 null");
  const chunks = [{ chapter_path: "卷一›章一", chapter: "章一", text: "x" }, { chapter_path: "卷一›章二", chapter: "章二", text: "y" }];
  const tree = buildChapterTree(chunks);
  assert(tree.includes("卷一›章一") && tree.includes("卷一›章二") && tree.split("\n").length === 2, "章节树: 去重保序完整路径");
}

// ---------- 7) 端到端 runClean（假 chatFn）+ SMALL + 已清洗跳过 ----------
console.log("===== 7) runClean 端到端 =====");
{
  const blocks = Array.from({ length: 30 }, (_, i) => ({
    chapter: `章${Math.floor(i / 10) + 1}`, chapter_path: `卷${Math.floor(i / 10) + 1}›章${Math.floor(i / 10) + 1}`,
    // idx 7 = kk 脏书典型长水贴（>50 字符带楼层戳 → 不触发 G1，LLM 判删应放行）
    text: i === 7
      ? "楼主分析得透彻，不过我觉得还要考虑汇率因素，美元 QE 的影响不能忽视啊。2010-09-06 21:33 1016楼"
      : `第${i}段正文内容，讲述房地产市场的供需关系与货币现象，这是楼主 kkndme 的原文分析。`,
  }));
  const dbPath = mkDb("e2e.db", blocks, { withEdges: true });
  // 预埋一条 chunk 锚定的 rule 相似边（import 后应被清理：指向被删的 id=8）
  {
    const db = new Database(dbPath);
    db.prepare("INSERT INTO edges(src_type, src, dst_type, dst, kind, weight, ref, source) VALUES ('chunk','7','chunk','8','similar',0.9,NULL,'rule')").run();
    db.close();
  }
  const resDir = resultsDir();
  // mkDb 的 chunk id 从 1 起（lastInsertRowid）：水贴 blocks[7] 的 id=8
  const script = new Map([[8, { idx: 8, verdict: "drop", cat: "spam", reason: "网友灌水回复无疑" }]]);
  const chat = mkChat(script);
  const r = await runClean(dbPath, { chatFn: chat, config, resultsDir: resDir });
  assert(r.ok === true && r.code === "OK", "runClean: 全部批成功");
  assert(r.stats.dropped === 1 && r.stats.kept === 29, `runClean: 删 1 留 29（got drop=${r.stats.dropped} keep=${r.stats.kept}）`);
  assert(r.stats.guardedG1 + r.stats.guardedG2 + r.stats.guardedG3 === 0, "runClean: 无护栏拦截（长水贴不触发 G1）");
  assert(r.stats.profileMode === "profile", "runClean: 画像模式 profile");
  const art = JSON.parse(fs.readFileSync(r.artifactPath, "utf8"));
  eq(art.verdicts.length, 1, "产物: 只存 drop/guarded（纯 keep 不存）");
  assert(art.verdicts[0].verdict === "drop" && typeof art.verdicts[0].text_hash === "string" && art.verdicts[0].text_hash.length === 16, "产物: drop 带 text_hash 16hex");

  // 落库对账
  const ir = importClean(dbPath, r.artifactPath, {});
  assert(ir.ok === true && ir.stats.dropped === 1, "import: 落库成功删 1 块");
  const au = auditClean(dbPath);
  assert(au.ready === true && au.quarantined === 1 && au.chunks === 29, "audit: quarantine 1 行 / chunks 29");
  assert(au.ftsAligned === true, "audit: FTS 与 chunks 对账一致（rebuild 生效）");
  assert(au.report && au.report.dropped === 1 && au.report.gate.verdict === "pass", "audit: clean_report 账实一致");
  const db = new Database(dbPath, { readonly: true });
  const q = db.prepare("SELECT chunk_id, text, reason, cat, book_title FROM quarantine").get();
  assert(q && q.chunk_id === 8 && q.text.includes("楼主分析得透彻") && q.book_title === null, "隔离账: 原文+理由落账");
  const dangling = db.prepare("SELECT COUNT(*) c FROM edges WHERE CAST(src AS INTEGER)=8 OR CAST(dst AS INTEGER)=8").get().c;
  assert(dangling === 0, "悬空边: chunk 锚定边已清理");
  const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(x => [x.key, x.value]));
  assert(["clean_at", "clean_report", "clean_chunk_fp", "clean_content_hash", "clean_version"].every(k => meta[k] != null), "meta: 五键落账（clean_profile 仅有画像时）");
  db.close();

  // 已清洗跳过（already）
  const r2 = await runClean(dbPath, { chatFn: chat, config, resultsDir: resDir });
  assert(r2.skipped === "already", "runClean: 已清洗且结构未变 → skipped already");

  // GATE：43% 删除整单拒收（drop 样块全部 >50 字符，避开 G1）
  const gateBlocks = Array.from({ length: 30 }, (_, i) => ({
    chapter: "章", chapter_path: null, text: longText + `（编号${i}）`,
  }));
  const dbPath3 = mkDb("gate.db", gateBlocks);
  // id 从 1 起：删 ids 1..13（13/30=43%）
  const bigScript = new Map(gateBlocks.map((_, i) => [i + 1, i < 13
    ? { idx: i + 1, verdict: "drop", cat: "spam", reason: "灌水内容判定删除样例" } : { idx: i + 1, verdict: "keep" }]));
  const resDir3 = resultsDir();
  const r3 = await runClean(dbPath3, { chatFn: mkChat(bigScript), config, resultsDir: resDir3 });
  JSON.parse(fs.readFileSync(r3.artifactPath, "utf8")); // 产物可解析（gate 拒收场景产物仍要落盘可审）
  const ir3 = importClean(dbPath3, r3.artifactPath, {});
  assert(ir3.ok === false && ir3.code === "GATE" && ir3.gate.verdict === "block", `GATE: 43% 删除整单拒收（got ${ir3.code}）`);
  const au3 = auditClean(dbPath3);
  assert(au3.ready === false || au3.quarantined === 0, "GATE: 拒收后零写入");
  // 20-40% 黄线：warn 但放行（删 ids 1..7 = 23%）
  const midScript = new Map(gateBlocks.map((_, i) => [i + 1, i < 7
    ? { idx: i + 1, verdict: "drop", cat: "spam", reason: "灌水内容判定删除样例" } : { idx: i + 1, verdict: "keep" }]));
  const dbPath4 = mkDb("warn.db", gateBlocks.map((b, i) => ({ ...b, text: b.text + `（w${i}）` })));
  const r4 = await runClean(dbPath4, { chatFn: mkChat(midScript), config, resultsDir: resultsDir() });
  const ir4 = importClean(dbPath4, r4.artifactPath, {});
  assert(ir4.ok === true && ir4.gate.verdict === "warn", `GATE warn: 23% 删除放行且标 warn（got ${ir4.ok}/${ir4.gate?.verdict}）`);

  // TAMPER：产物 text_hash 篡改 → 整单拒收（drop 块 >50 字符避开 G1）
  const tamperBlocks = Array.from({ length: 20 }, (_, i) => ({ chapter: "章", text: longText + `（t${i}）` }));
  const dbPath5 = mkDb("tamper.db", tamperBlocks);
  const tScript = new Map([[4, { idx: 4, verdict: "drop", cat: "ad", reason: "广告内容判定删除样例" }]]);
  const r5 = await runClean(dbPath5, { chatFn: mkChat(tScript), config, resultsDir: resultsDir() });
  const art5 = JSON.parse(fs.readFileSync(r5.artifactPath, "utf8"));
  art5.verdicts[0].text_hash = "0".repeat(16);
  const tamperPath = path.join(TMP, "tamper-art.json");
  fs.writeFileSync(tamperPath, JSON.stringify(art5));
  const ir5 = importClean(dbPath5, tamperPath, {});
  assert(ir5.ok === false && ir5.code === "TAMPER", "TAMPER: text_hash 对不上整单拒收");
  const au5 = auditClean(dbPath5);
  assert(au5.ready === false || au5.quarantined === 0, "TAMPER: 拒收后零写入");
}

// ---------- 8) 恢复全对账 ----------
console.log("===== 8) restoreClean 恢复 =====");
{
  const blocks = Array.from({ length: 20 }, (_, i) => ({ chapter: "章", text: longText + `第${i}段。` }));
  const dbPath = mkDb("restore.db", blocks);
  const script = new Map([[3, { idx: 3, verdict: "drop", cat: "spam", reason: "误删测试块内容样例" }], [6, { idx: 6, verdict: "drop", cat: "ad", reason: "广告判定样例内容" }]]);
  const resDir = resultsDir();
  const r = await runClean(dbPath, { chatFn: mkChat(script), config, resultsDir: resDir });
  importClean(dbPath, r.artifactPath, {});
  assert(auditClean(dbPath).chunks === 18, "恢复前置: 已删 2 块");
  // list / dry-run
  const l = restoreClean(dbPath, { all: true, dryRun: true });
  assert(l.ok === true && l.candidates.length === 2, "恢复: dry-run 列出 2 块");
  // 指定恢复 #3
  const r1 = restoreClean(dbPath, { ids: [3] });
  assert(r1.ok === true && r1.restored === 1, "恢复: 指定块插回");
  const db = new Database(dbPath, { readonly: true });
  const back = db.prepare("SELECT text FROM chunks WHERE id=3").get();
  assert(back && back.text.includes("第2段。") && back.text.startsWith(longText.slice(0, 10)), "恢复: 原文一字不差插回原 id（id=i+1 错位，id=3=第2段）");
  const qLeft = db.prepare("SELECT COUNT(*) c FROM quarantine").get().c;
  assert(qLeft === 1, "恢复: quarantine 只剩未恢复的 1 条");
  const ftsOk = db.prepare("SELECT COUNT(*) c FROM chunks_fts").get().c === 19;
  assert(ftsOk, "恢复: FTS rebuild 后与 chunks 对账");
  const log = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='clean_restore_log'").get().value);
  assert(Array.isArray(log) && log[0].restored === 1 && log[0].ids.includes(3), "恢复: restore_log 落账");
  db.close();
  // 全部恢复
  const r2 = restoreClean(dbPath, { all: true });
  assert(r2.ok === true && r2.restored === 1, "恢复: --all 恢复剩余 1 块");
  assert(auditClean(dbPath).chunks === 20, "恢复: 全部回原（chunks=20）");
}

// ---------- 9) 断点续跑 + 双 stale ----------
console.log("===== 9) 断点续跑 + STALE =====");
{
  const blocks = Array.from({ length: 25 }, (_, i) => ({ chapter: "章", text: `续跑测试块${i}，内容足够长不触发护栏。` }));
  const dbPath = mkDb("resume.db", blocks);
  const resDir = resultsDir();
  let n = 0;
  const flakyChat = async (req) => {
    n++;
    if (req.messages[0].content.includes("图书编辑")) return { ok: true, text: '{"summary":"s","typical":"t","pollution":[]}' };
    if (n % 2 === 0) return { ok: false, code: "TIMEOUT", message: "超时" };
    const judged = [...req.messages[1].content.matchAll(/\[idx (\d+)\]/g)].map(m => +m[1]);
    return { ok: true, text: JSON.stringify(judged.map(idx => ({ idx, verdict: "keep" }))), usage: { prompt_tokens: 10, completion_tokens: 5 } };
  };
  const r1 = await runClean(dbPath, { chatFn: flakyChat, config, resultsDir: resDir });
  assert(r1.code === "PARTIAL" && r1.stats.batchesFailed > 0, "续跑: 失败批登记 PARTIAL");
  assert(r1.ok === false, "续跑: PARTIAL ok=false");
  const cache = loadCleanCache(path.join(resDir, "resume.jsonl"), null, null);
  const cached = cache.verdicts.size;
  assert(cached > 0 && cached < 25, `续跑: 部分块已缓存（${cached}/25）`);
  // 重跑（正常 chat）：只补失败批
  const r2 = await runClean(dbPath, { chatFn: mkChat(), config, resultsDir: resDir });
  assert(r2.ok === true && r2.code === "OK" && r2.stats.batchesPending < r2.stats.batches, "续跑: 重跑只补失败批");
  assert(loadCleanCache(path.join(resDir, "resume.jsonl"), null, null).verdicts.size === 25, "续跑: 全量判定齐");

  // 双 stale：content_hash 变 → HASH
  const c = loadCleanCache(path.join(resDir, "resume.jsonl"), "different-hash", null);
  assert(c.stale === true && c.staleReason === "HASH", "stale: content_hash 变 → HASH");
  // chunk_fp 变 → STRUCT；缓存无指纹 → STRUCT（A7：无指纹≠没变过）
  const c2 = loadCleanCache(path.join(resDir, "resume.jsonl"), null, "different-fp");
  assert(c2.stale === true && c2.staleReason === "STRUCT", "stale: chunk_fp 变 → STRUCT");
  const c3 = loadCleanCache(path.join(resDir, "fresh-no-meta.jsonl"), null, "some-fp");
  assert(c3.stale === false, "stale: 缓存文件不存在不判 stale");
}

// ---------- 10) 画像降级 + SMALL + STALE 拒跑 ----------
console.log("===== 10) 降级与前门 =====");
{
  const blocks = Array.from({ length: 20 }, (_, i) => ({ chapter: "章", text: `画像降级测试块${i}，内容长于护栏阈值线。` }));
  const dbPath = mkDb("profile.db", blocks);
  const r = await runClean(dbPath, { chatFn: mkChat(new Map(), { profileFails: true }), config, resultsDir: resultsDir() });
  assert(r.ok === true && r.stats.profileMode === "title_only", "画像: 失败降级 title_only 不炸");

  const tiny = mkDb("tiny.db", Array.from({ length: 5 }, (_, i) => ({ chapter: "章", text: `小库块${i}` })));
  const r2 = await runClean(tiny, { chatFn: mkChat(), config, resultsDir: resultsDir() });
  assert(r2.ok === true && r2.skipped === "small", "SMALL: <8 块跳过不算失败");

  // runClean STALE：旧缓存 + 新库（重灌）
  const dbPath3 = mkDb("stale.db", blocks.map((b, i) => ({ ...b, text: b.text + `S${i}` })));
  const resDir3 = resultsDir();
  await runClean(dbPath3, { chatFn: mkChat(), config, resultsDir: resDir3 });
  // 重灌同路径库（content_hash 无 → 指纹变）
  fs.rmSync(dbPath3);
  mkDb("stale.db", blocks.slice(0, 15).map((b, i) => ({ ...b, text: b.text + `X${i}` })));
  const r3 = await runClean(dbPath3, { chatFn: mkChat(), config, resultsDir: resDir3 });
  assert(r3.ok === false && r3.code === "STALE" && r3.staleReasonHint !== "ignore", "STALE: 重灌后缓存拒跑（指纹/哈希不符）");
}

// ---------- 11) 孟子零误杀（真块结构 + 恒 keep；tmp 副本上跑，不污染真库） ----------
console.log("===== 11) 孟子零误杀 =====");
{
  const mengzi = path.join(import.meta.dirname, "..", "library", "mengzi-zh.docx.db");
  if (fs.existsSync(mengzi)) {
    const resDir = resultsDir();
    // 拷到 tmp 再跑：真库可能已被真跑清洗落过 clean_at（already 跳过会废掉断言），
    // 且测试不该改真库 meta。WAL 三件套齐拷（checkpoint 不到时主文件缺最新事务）。
    const tmpDb = path.join(resDir, "mengzi-copy.db");
    fs.copyFileSync(mengzi, tmpDb);
    for (const ext of ["-wal", "-shm"]) {
      if (fs.existsSync(mengzi + ext)) fs.copyFileSync(mengzi + ext, tmpDb + ext);
    }
    // force=true：真库可能已被真跑清洗落过 clean_at（tmp 副本带着）——already 跳过会让
    // 断言空转（skipped 分支没有 artifactPath，前两个断言也只是假阳性）。强制走全流程。
    const r = await runClean(tmpDb, { chatFn: mkChat(), config, resultsDir: resDir, force: true });
    assert(r.ok === true && r.stats.dropped === 0, `孟子零误杀: 真块结构恒 keep → 删 0（got ${r.stats?.dropped}）`);
    assert(r.stats.kept === r.stats.chunks, "孟子零误杀: kept=chunks");
    const ir = importClean(tmpDb, r.artifactPath, {});
    assert(ir.ok === true && ir.message.includes("零删除"), "孟子零误杀: import 零删除路径");
  } else {
    console.log("SKIP - 孟子库不在位（library/mengzi-zh.docx.db）");
  }
}

// ---------- 12) CHUNKS 无 chapter_path 列的老库兼容 ----------
console.log("===== 12) 老库无 chapter_path 列 =====");
{
  const p = path.join(TMP, "old.db");
  const db = new Database(p);
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT NOT NULL);");
  db.prepare("INSERT INTO chunks(chapter, page, text) VALUES ('章', NULL, ?)").run("老库块内容足够长，不触发任何护栏判定。");
  db.prepare("INSERT INTO meta(key,value) VALUES ('title','老书')").run();
  db.close();
  const t = buildCleanTasks(new Database(p, { readonly: true }));
  assert(t.chunks.length === 1 && t.chunks[0].chapter_path === null && t.book.title === "老书", "老库: 探测回退 chapter_path=null");
}

// ---------- 收尾 ----------
console.log(`\n===== clean-test: ${failed ? failed + " 项 FAIL" : "全部 PASS"} =====`);
if (failed) { console.error(`${failed} 项 FAIL`); process.exit(1); }
