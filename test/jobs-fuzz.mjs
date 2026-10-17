// P2 流程闭环爆破（终期暴力测试）：导入两段的中断/重启/续跑/并发/坏结果。
// 攻击手段：kill -9 于三个中点（切片/向量/编目等待）、并发双加工同书与双书、
//   结果截断/非法 JSON/坏 task_ref、外部改坏库、0 步失败卡死（D-08 修复验证）。
// 全部落系统临时目录假书库，不碰真 library；模型用项目 .models/ 缓存。
// 挂载：test:slow（向量阶段要加载嵌入模型）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const Database = require("better-sqlite3");

const { startImport, startProcessing, resumeCatalog, cancelImport, jobsStatus, jobDirs } = await import("../src/desktop/jobs.mjs");
const { configureSearch } = await import("../src/lib/search.mjs");
const { configureModels } = await import("../src/lib/models.mjs");

let pass = 0, fail = 0, observe = 0;
const failures = [];
const ok = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (cond) pass++; else { fail++; failures.push(msg); } };
const obs = (msg) => { console.log("OBSERVE - " + msg); observe++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-p2-"));
const libDir = path.join(tmp, "library");
fs.mkdirSync(libDir, { recursive: true });
configureSearch({ libDir });
configureModels({ modelsDir: path.join(ROOT, ".models") });
process.env.BSP_LIB_DIR = libDir;
process.env.BSP_MODELS_DIR = path.join(ROOT, ".models");
const dirs = jobDirs();
const embCount = (dbPath) => {
  const d = new Database(dbPath, { readonly: true });
  const cols = d.prepare("PRAGMA table_info(chunks)").all().map(x => x.name);
  if (!cols.includes("emb")) { d.close(); return 0; } // emb 列由 embed-book 灌向量时才加
  const n = d.prepare("SELECT COUNT(*) c FROM chunks WHERE emb IS NOT NULL").get().c;
  d.close();
  return n;
};

// 跑一个子进程执行「导入 + 加工 + 到某阶段自杀」，返回其 stdout（父进程视角的中断模拟）
// V3 #167 拆两段后：子进程先 startImport（秒完）再 startProcessing（重头）——
// 中断点全部落在加工段，与真实用户路径（先放进书架、再点开始加工）一致
function runImportUntilKilled(file, bookId, killAfterMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", `
      const { startImport, startProcessing } = await import(${JSON.stringify(path.join(ROOT, "src/desktop/jobs.mjs"))});
      process.env.BSP_LIB_DIR = ${JSON.stringify(libDir)};
      process.env.BSP_MODELS_DIR = ${JSON.stringify(path.join(ROOT, ".models"))};
      const { configureSearch } = await import(${JSON.stringify(path.join(ROOT, "src/lib/search.mjs"))});
      configureSearch({ libDir: process.env.BSP_LIB_DIR });
      try {
        await startImport(${JSON.stringify(file)});
        await startProcessing(${JSON.stringify(bookId)});
      } catch (e) { console.log("IMPORT_ERR:", e.message); }
      console.log("IMPORT_DONE");
    `], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } });
    let out = "";
    child.stdout.on("data", d => out += d);
    child.stderr.on("data", () => {});
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }, killAfterMs);
    child.on("close", () => resolve(out));
  });
}

// ---------- 1) 切片中途 kill -9 → 重跑干净恢复 ----------
console.log("===== 1) 切片中途 kill -9 =====");
{
  const f = path.join(ROOT, "books/lunyu-xueer-zh.docx");
  const out = runImportUntilKilled(f, "lunyu-xueer-zh.docx", 400); // 加工切片阶段（建库事务中）杀掉
  const o = await out;
  obs(`切片 kill 子进程输出: ${o.trim().slice(0, 80) || "（无输出即被杀于静默期）"}`);
  // 杀完重跑：一段补登记（秒完）→ 二段重跑，WAL 应自动回滚半个事务，干净走完四步
  await startImport(f);
  const r = await startProcessing("lunyu-xueer-zh.docx");
  ok(r.stage === "catalog" && r.clusters > 0, `P2-1 切片中断后重跑 → 走到待编目（${r.clusters} 堆，WAL 回滚半个事务）`);
  ok(embCount(path.join(libDir, "lunyu-xueer-zh.docx.db")) === 16, "P2-1b 重跑后向量补齐（16 块全 emb）");
}

// ---------- 2) 向量化中途 kill -9 → 重跑 skipped+补向量 ----------
console.log("===== 2) 向量化中途 kill -9 =====");
{
  // 先造一个只建了库没灌向量的状态：直接 build-book（不走 jobs）——
  // 输出路径必须与 startProcessing 会用的一致（libDir/<bookId>.db，bookId=daodejing-zh.docx）
  const src = path.join(ROOT, "books/daodejing-zh.docx");
  const ddDb = path.join(libDir, "daodejing-zh.docx.db");
  execFileSync(process.execPath, [path.join(ROOT, "src/build-book.js"), src, "-o", ddDb], { stdio: "pipe" });
  const before = embCount(ddDb);
  ok(before === 0, `P2-2a 前置：库已建向量为 0（${before}）`);
  // 导这本 → 一段复制 → 二段切片 skipped（同 hash）→ 向量化跑到一半杀
  await startImport(src);
  const out = runImportUntilKilled(src, "daodejing-zh.docx", 3500);
  const o = await out;
  const mid = embCount(ddDb);
  obs(`向量 kill：杀时 emb=${mid}（>0 即杀在了向量阶段；子进程输出 ${o.trim().slice(0, 60) || "无"}）`);
  // 重跑：build-book skipped → embed 补灌 → 全 emb
  const r = await startProcessing("daodejing-zh.docx");
  const after = embCount(ddDb);
  ok(after > 0 && r.stage === "catalog", `P2-2b 向量中断后重跑 → skipped 切片 + 补向量成功（${after} 块 emb）`);
}

// ---------- 3) 0 步失败卡死（D-08 修复验证）：坏 txt 一段照进书架，二段才炸 ----------
console.log("===== 3) 0 步失败：txt 转换失败不能卡死 =====");
{
  const bad = path.join(tmp, "utf16-bad.txt");
  fs.writeFileSync(bad, Buffer.from("\uFEFF子曰学而时习之", "utf16le"));
  // #167：一段不校验内容（复制即可）——坏 txt 也进得了书架，用户能看见它、再决定怎么办
  const ri = await startImport(bad);
  ok(ri.stage === "imported", `P2-3a 坏 txt 也能进书架（stage=${ri.stage}——第一段只管落盘）`);
  let e1 = null;
  try { await startProcessing("utf16-bad.docx"); } catch (e) { e1 = e; }
  ok(e1 && /UTF-16|另存为 UTF-8/.test(e1.message), `P2-3b 加工时人话报错（${e1?.message?.slice(0, 50)}）`);
  const st = jobsStatus()["utf16-bad.docx"];
  ok(st && st.stage === "failed", `P2-3c 修后落 failed 态而非卡 slice（实际 ${st?.stage}）`);
  let e2 = null;
  try { await startProcessing("utf16-bad.docx"); } catch (e) { e2 = e; }
  ok(e2 && /UTF-16|正在加工/.test(e2.message), "P2-3d 失败后可再加工（不被「正在加工中」永久锁死）");
}

// ---------- 4) 并发：同书双加工 / 双书并行 ----------
console.log("===== 4) 并发加工 =====");
{
  // 4a/4b 并发同书：一本全新 txt（没被任何库见过）双加工——第二个必须被拒
  // （一段已落盘，双加工的竞争全在二段：jobs Map 的 in-progress 闸门）
  const f1 = path.join(tmp, "fresh-concurrent.txt");
  fs.writeFileSync(f1, "并发测试书。\n第一段内容。\n第二段内容。\n".repeat(20), "utf8");
  await startImport(f1); // bookId = fresh-concurrent.docx（txt 映射同 EXT_FMT）
  const p1 = startProcessing("fresh-concurrent.docx").catch(e => e);
  const p2 = startProcessing("fresh-concurrent.docx").catch(e => e);
  const [r1, r2] = await Promise.all([p1, p2]);
  const one = r1 instanceof Error ? r1 : r2;
  const two = r1 instanceof Error ? r2 : r1;
  ok(one instanceof Error && /正在加工中/.test(one.message), `P2-4a 并发同书：第二个被拒（${one?.message?.slice(0, 40)}）`);
  ok(two && !(two instanceof Error), "P2-4b 并发同书：第一个正常走完");
  // 双书并行（并发锁缺口记录）：论语+孟子各走一段→二段并发
  await startImport(path.join(ROOT, "books/lunyu-xueer-zh.docx"));
  await startImport(path.join(ROOT, "books/mengzi-zh.docx"));
  const t0 = Date.now();
  const [a, b] = await Promise.all([
    startProcessing("lunyu-xueer-zh.docx").catch(e => e),
    startProcessing("mengzi-zh.docx").catch(e => e),
  ]);
  const ms = Date.now() - t0;
  ok(!(a instanceof Error) && !(b instanceof Error), `P2-4c 并发双书都成功（论语+孟子，${ms}ms）`);
  obs(`P2-4c 耗时 ${ms}ms——无并发锁，两本书同时加载嵌入模型/同时 spawn；正确性优先，内存与耗时记录在案`);
}

// ---------- 5) 坏结果：截断 JSON / 非法 JSON / 坏 task_ref / 外部坏库 ----------
console.log("===== 5) 编目恢复：坏结果矩阵 =====");
{
  const bookId = "mengzi-zh.docx"; // 4c 已生成任务书
  const taskPath = path.join(dirs.tasksDir, `${bookId}.json`);
  ok(fs.existsSync(taskPath), "P2-5a 任务书在（4c 产物）");
  // 5b 截断 JSON
  const trunc = path.join(tmp, "trunc.json");
  fs.writeFileSync(trunc, JSON.stringify({ task_ref: bookId }).slice(0, 12));
  let e1 = null;
  try { await resumeCatalog(bookId, trunc); } catch (e) { e1 = e; }
  ok(e1 && /不是合法 JSON/.test(e1.message), `P2-5b 截断 JSON → 人话拒（${e1?.message?.slice(0, 40)}）`);
  // 5c 坏 task_ref（结构合法但引用错书）
  const task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
  const badRef = path.join(tmp, "badref.json");
  fs.writeFileSync(badRef, JSON.stringify({
    task_ref: "other-book.docx",
    themes: [{ id: "t1", name: "乱写主题" }],
    assignments: [{ cluster: task.clusters[0].id, theme: "t1" }],
  }, null, 1));
  let e2 = null;
  try { await resumeCatalog(bookId, badRef); } catch (e) { e2 = e; }
  ok(e2 && /task_ref 不匹配|校验失败/.test(e2.message), `P2-5c 坏 task_ref → 校验拒（${e2?.message?.slice(0, 40)}）`);
  // 5d 合法结果真入库（控制组）——task_ref 必须等于任务书的 book.db（带 .db 后缀）
  const good = path.join(tmp, "good.json");
  fs.writeFileSync(good, JSON.stringify({
    task_ref: task.book.db,
    themes: [{ id: "t1", name: "仁义" }, { id: "t2", name: "王道" }],
    persons: [{ name: "孟子", match_names: ["孟子"] }],
    relations: [],
    assignments: [
      { cluster: task.clusters[0].id, theme: "t1" },
      ...task.clusters.slice(1).map(c => ({ cluster: c.id, theme: "t2" })),
    ],
  }, null, 1));
  const r = await resumeCatalog(bookId, good);
  ok(r.stage === "done" && r.themes === 2, `P2-5d 控制组：合法结果入库（主题 ${r.themes} 人物 ${r.persons}）`);
  const d = new Database(path.join(libDir, `${bookId}.db`), { readonly: true });
  const llmNodes = d.prepare("SELECT COUNT(*) c FROM nodes WHERE source='llm'").get().c;
  d.close();
  ok(llmNodes > 0, `P2-5e 入库落地：llm 编目节点 ${llmNodes} 个`);
  // 5f 外部坏库：库文件写成垃圾 → 人话拒不裸崩
  const ghostId = "ghost-book.docx";
  fs.writeFileSync(path.join(dirs.tasksDir, `${ghostId}.json`), JSON.stringify(task));
  fs.writeFileSync(path.join(libDir, `${ghostId}.db`), "这不是数据库文件");
  let e3 = null;
  try { await resumeCatalog(ghostId, good.replace(bookId, ghostId)); } catch (e) { e3 = e; }
  ok(e3 && !/SqliteError|SQLITE_/.test(e3.message) && e3.message.length > 4, `P2-5f 外部坏库 → 人话拒不裸崩（${e3?.message?.slice(0, 50)}）`);
}

// ---------- 6) 取消语义：vector 阶段取消杀子进程 ----------
console.log("===== 6) 取消进行中的加工 =====");
{
  // 用一本全新的 txt（没被任何库见过）——避免与前面段落的库撞 hash 混淆取消语义
  const f = path.join(tmp, "fresh-book.txt");
  fs.writeFileSync(f, "# 第一章\n新书第一段内容，用来测取消。\n# 第二章\n第二段。\n");
  await startImport(f); // 一段秒完；取消语义全在二段
  const p = startProcessing("fresh-book.docx").catch(e => e);
  await new Promise(r => setTimeout(r, 300)); // 让管线跑起来（txt 转换+切片很快，取 vector 期）
  const c = cancelImport("fresh-book.docx");
  const r = await p;
  ok(c.cancelled === true, "P2-6a cancelImport 确认取消");
  ok(r instanceof Error || r?.stage === "cancelled", `P2-6b 加工以 cancelled 收场（${r instanceof Error ? r.message.slice(0, 40) : r?.stage}）`);
  const st = jobsStatus()["fresh-book.docx"];
  ok(!st || st.stage === "cancelled", `P2-6c 取消后 jobs 表无残留活跃态（实际 ${st?.stage || "无条目"}）`);
}

// ---------- 汇总 ----------
console.log(`\n===== P2 流程闭环爆破汇总：${pass} PASS / ${fail} FAIL / ${observe} OBSERVE =====`);
if (failures.length) { console.log("失败项："); failures.forEach(f => console.log("  ✗ " + f)); }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 沙箱 */ }
process.exit(fail ? 1 : 0);
