// 导入管线验收（4.6）：jobs.mjs 四步（切片→向量→编目任务书→恢复入库）。
// 全部在系统临时目录的假书库上进行，不碰真 library；模型用项目 .models/ 现有缓存。
// 慢速（要加载嵌入模型）——挂 test:slow。
// 覆盖审计修正：H1（编目直调 lib，任务书/结果目录紧挨书库）、H2（build-book require
// 复用 + 显式 -o、embed-book spawn 显式传参、阶段横幅不造假百分比）、
// 暂停恢复（待编目不卡死）、重导入幂等、txt 分支。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const Database = require("better-sqlite3");

const { startImport, resumeCatalog, cancelImport, scanPending, jobsStatus, jobDirs } = await import("../src/desktop/jobs.mjs");
const { configureSearch } = await import("../src/lib/search.mjs");
const { configureModels } = await import("../src/lib/models.mjs");

let failed = 0;
const assert = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (!cond) failed++; };

// ---------- 假书库（临时目录） ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-jobs-"));
const libDir = path.join(tmp, "library");
fs.mkdirSync(libDir, { recursive: true });
configureSearch({ libDir });
configureModels({ modelsDir: path.join(ROOT, ".models") }); // 用现有缓存，不重下
process.env.BSP_LIB_DIR = libDir;
process.env.BSP_MODELS_DIR = path.join(ROOT, ".models");

const dirs = jobDirs();
assert(dirs.libDir === libDir && dirs.tasksDir === path.join(tmp, "catalog-tasks") && dirs.resultsDir === path.join(tmp, "catalog-results"),
  `目录约定：任务书/结果紧挨书库（${path.relative(tmp, dirs.tasksDir)}）——迁库一起走，CLI 的 cwd 假设不沾边（H1）`);

// ---------- 1) 参数校验（不碰模型） ----------
{
  let e1 = null;
  try { await startImport(path.join(tmp, "no-such-book.epub")); } catch (e) { e1 = e; }
  assert(e1 && /找不到文件/.test(e1.message), "不存在的文件 → 明确报错");
  const fake = path.join(tmp, "fake.zip");
  fs.writeFileSync(fake, "pk");
  let e2 = null;
  try { await startImport(fake); } catch (e) { e2 = e; }
  assert(e2 && /不支持的格式/.test(e2.message), "不支持的格式 → 明确报错（不进管线）");
  const c = cancelImport("whatever.docx");
  assert(c.cancelled === false, "取消不存在的任务 → 不崩，明确回复");
}

// ---------- 2) scanPending：待编目检测（任务书在/结果在/库没了的组合） ----------
{
  fs.mkdirSync(dirs.tasksDir, { recursive: true });
  fs.mkdirSync(dirs.resultsDir, { recursive: true });
  fs.writeFileSync(path.join(dirs.tasksDir, "ghost.docx.json"), JSON.stringify({ book: { db: "ghost.docx.db" } }));
  fs.writeFileSync(path.join(libDir, "ghost.docx.db"), ""); // 库还在 → 该挂起
  fs.writeFileSync(path.join(dirs.tasksDir, "gone.docx.json"), JSON.stringify({ book: { db: "gone.docx.db" } })); // 库没了 → 作废
  fs.writeFileSync(path.join(dirs.tasksDir, "done.docx.json"), JSON.stringify({ book: { db: "done.docx.db" } }));
  fs.writeFileSync(path.join(dirs.resultsDir, "done.docx.json"), "{}"); // 结果已在 → 不挂
  const pending = scanPending();
  assert(pending.length === 1 && pending[0] === "ghost.docx",
    `scanPending 只挂「任务书在+结果不在+库还在」的（实际：${pending.join(",") || "无"}；done 有结果不挂、gone 库没了不挂）`);
  assert(jobsStatus()["ghost.docx"]?.stage === "catalog", "挂起的任务在 jobsStatus 里是待编目态（重启恢复横幅的数据源）");
  // 清掉这些假任务书，别干扰后面的真导入
  for (const f of ["ghost.docx.json", "gone.docx.json", "done.docx.json"]) fs.rmSync(path.join(dirs.tasksDir, f), { force: true });
  fs.rmSync(path.join(dirs.resultsDir, "done.docx.json"), { force: true });
  fs.rmSync(path.join(libDir, "ghost.docx.db"), { force: true });
}

// ---------- 3) 完整四步：docx 导入 → 停在待编目 → 恢复入库 ----------
{
  const src = path.join(ROOT, "books", "lunyu-xueer-zh.docx");
  const events = [];
  const off = (await import("../src/desktop/jobs.mjs")).onJobsProgress((e) => events.push(e.stage));
  const r = await startImport(src);
  off();
  const dbPath = path.join(libDir, "lunyu-xueer-zh.docx.db");
  assert(fs.existsSync(dbPath), "四步①切片：库文件落在书库目录（显式 -o，不建到 books/ 旁——H2-②）");
  assert(fs.existsSync(path.join(tmp, "books", "lunyu-xueer-zh.docx")), "原件进了书库旁的 books/（自包含，重导入不依赖原位置）");
  const nEmb = new Database(dbPath, { readonly: true }).prepare("SELECT COUNT(*) n FROM chunks WHERE emb IS NOT NULL").get().n;
  assert(nEmb > 0, `四步②向量：${nEmb} 块带向量（spawn embed-book 显式传参——H2-①）`);
  const taskPath = path.join(dirs.tasksDir, "lunyu-xueer-zh.docx.json");
  assert(fs.existsSync(taskPath), "四步③编目：任务书落在 catalog-tasks/（H1 直调 lib，不碰 CLI cwd）");
  assert(r.stage === "catalog", `四步停在「待编目」不卡死（stage=${r.stage}，${r.clusters} 堆任务）`);
  assert(events.includes("slice") && events.includes("vector") && events.includes("catalog"),
    `阶段横幅事件齐全（${events.join("→")}；只报阶段不造假百分比——H2-③）`);
  assert(jobsStatus()["lunyu-xueer-zh.docx"]?.stage === "catalog", "jobsStatus 记录待编目态（书架横幅数据源）");

  // 手写一份合法编目结果（从任务书读 cluster ids，保证全覆盖；人物用真实原文词过防幻觉）
  const task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
  const result = {
    task_ref: "lunyu-xueer-zh.docx.db",
    themes: [{ id: "t1", name: "为学", note: "学习与修养" }],
    persons: [{ name: "孔子", match_names: ["孔子"], note: "师" }], // 「孔子」在学而篇原文真实出现？先验一下
    relations: [],
    assignments: task.clusters.map((c, i) => ({ cluster: c.id, theme: "t1" })),
  };
  // 「孔子」若不在原文（记忆：学而篇开篇是「子曰」，可能没有「孔子」二字）→ 换成一定在的词
  const has = new Database(dbPath, { readonly: true }).prepare("SELECT COUNT(*) n FROM chunks WHERE instr(text, ?) > 0").get("孔子").n;
  if (!has) result.persons = [{ name: "子曰", match_names: ["子曰"], note: "师言" }];
  const resultPath = path.join(dirs.resultsDir, "lunyu-xueer-zh.docx.json");
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 1));

  const before = new Database(dbPath, { readonly: true }).prepare("SELECT COUNT(*) n FROM nodes WHERE source='llm'").get().n;
  const rr = await resumeCatalog("lunyu-xueer-zh.docx");
  const after = new Database(dbPath, { readonly: true }).prepare("SELECT COUNT(*) n FROM nodes WHERE source='llm'").get().n;
  assert(rr.stage === "done" && rr.themes === 1, `四步④恢复入库：主题 ${rr.themes} · 人物 ${rr.persons}（五重校验+mention 扫描）`);
  assert(after > before, `llm 编目层从 ${before} → ${after} 节点（真入库）`);
  assert(jobsStatus()["lunyu-xueer-zh.docx"]?.stage === "done", "jobsStatus 转完成态");

  // 假结果必须被拒（防幻觉红线在管线里仍然生效）：task_ref 对不上 → 整批拒收
  const badPath = path.join(dirs.resultsDir, "lunyu-xueer-zh.json");
  fs.writeFileSync(badPath, JSON.stringify({ ...result, task_ref: "wrong.db" }));
  let badErr = null;
  try { await resumeCatalog("lunyu-xueer-zh.docx", badPath); } catch (e) { badErr = e; }
  assert(badErr && /task_ref 不匹配/.test(badErr.message), "task_ref 不匹配 → 整批拒收（校验不放松）");
  fs.rmSync(badPath, { force: true });

  // ---------- 4) 重导入幂等：同书再拖一次 → 切片跳过 → 结果已在 → 自动入库到 done ----------
  const r2 = await startImport(src);
  assert(r2.stage === "done", `重导入幂等：同源同内容切片跳过、结果已在自动入库（stage=${r2.stage}）`);
}

// ---------- 5) txt 分支：转 docx → 建库（小文本，秒级） ----------
{
  const txt = path.join(tmp, "小语.txt");
  fs.writeFileSync(txt, "道可道，非常道。\n名可名，非常名。\n无名天地之始。\n有名万物之母。\n".repeat(30), "utf8");
  const r = await startImport(txt);
  const dbPath = path.join(libDir, "小语.docx.db");
  assert(fs.existsSync(dbPath) && r.stage === "catalog", "txt 分支：txt2docx 转换 → 建库成功，走到待编目");
  assert(fs.existsSync(path.join(dirs.tasksDir, "小语.docx.json")), "txt 分支任务书也落 catalog-tasks/");
}

// ---------- 汇总 ----------
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n========== 导入管线结果 ==========");
if (failed > 0) { console.log(`有 ${failed} 项 FAIL`); process.exit(1); }
console.log("全部 PASS：四步管线 + 目录约定 + 暂停恢复 + 假结果拒收 + 重导入幂等 + txt 分支");
