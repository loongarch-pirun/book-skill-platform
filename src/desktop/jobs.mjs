// 导入管线（4.6，按对账审计 H1/H2 修正版实现）：
//   切片 → 向量化 → 编目（任务书 + 暂停等结果）→（恢复）五重校验入库
// H1：编目两步绕开 CLI（catalog-export/import 按 process.cwd() 找书库，迁库即瞎），
//     直调 lib 已导出的 clusterChunks/buildTask/parseResultText/importCatalog。
// H2：build-book 用 require 复用且显式 -o（输出路径自己说了算，不从 Downloads 旁建库）；
//     embed-book spawn 显式传 db 路径；进度只做阶段横幅，不做假百分比（H2-③）。
// 铁轨：jobs 状态经 onJobsProgress 订阅 → 主进程转发 jobs:progress 事件 → 书架卡片横幅。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { clusterChunks, buildTask, parseResultText, importCatalog } from "../lib/catalog.mjs";
import { currentLibDir } from "../lib/search.mjs";
import { UserError } from "./engine.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const EMBED_SCRIPT = path.join(import.meta.dirname, "..", "embed-book.js");
const TXT2DOCX_SCRIPT = path.join(import.meta.dirname, "..", "txt2docx.js");
const EXT_FMT = { pdf: "pdf", epub: "epub", docx: "docx", txt: "docx" }; // txt 先转 docx 再建库

// 子进程 node 化：打包态 process.execPath 是 BookSkillPlatform.exe——缺这个变量，
// 子进程被当成 GUI 应用启动：脚本一行不执行、进程永不退出 → Promise 永不 resolve，
// 卡片永久卡在「向量化中」/「准备文件」（G-01，两次打包态探针实测）。
// 开发态（electron.exe）把 .js 参数当 app 入口跑、跑完自退，加变量后行为不变（实测零副作用）。
const nodeEnv = () => ({ ...process.env, ELECTRON_RUN_AS_NODE: "1" });

// ---------- 目录约定：任务书/结果/原件紧挨书库（迁库一起走；dev 态即项目根三个目录） ----------
export function jobDirs() {
  const libDir = currentLibDir();
  const root = path.join(libDir, "..");
  return { libDir, root, tasksDir: path.join(root, "catalog-tasks"), resultsDir: path.join(root, "catalog-results"), booksDir: path.join(root, "books") };
}

// ---------- 任务注册表 + 进度订阅 ----------
const jobs = new Map();   // bookId → { stage, label, detail, error, filePath, taskPath, child }
const cancelled = new Set();
const subs = new Set();

// 事件/状态出海前剥掉 child（ChildProcess 不可 structured clone，带上会炸 IPC）
const plain = (j) => { const { child, ...rest } = j; return rest; };

function emit(bookId, patch) {
  const j = jobs.get(bookId) || { stage: "slice", startedAt: Date.now() };
  Object.assign(j, patch, { bookId });
  jobs.set(bookId, j);
  for (const fn of subs) { try { fn(plain(j)); } catch { /* 订阅者崩不拖垮管线 */ } }
}
export function jobsStatus() { return Object.fromEntries([...jobs].map(([k, v]) => [k, plain(v)])); }
export function onJobsProgress(fn) { subs.add(fn); return () => subs.delete(fn); }

// ---------- 主流程：拖一本书进来 → 四步管线 ----------
export async function startImport(filePath) {
  const file = path.resolve(String(filePath || ""));
  if (!fs.existsSync(file)) throw new UserError(`找不到文件：${file}`);
  const ext = (path.extname(file).match(/^\.(.+)$/) || [])[1]?.toLowerCase();
  const fmt = EXT_FMT[ext];
  if (!fmt) throw new UserError(`不支持的格式 .${ext || "?"}（支持 .epub / .docx / .pdf / .txt）`);
  const { libDir, tasksDir, resultsDir, booksDir } = jobDirs();
  fs.mkdirSync(libDir, { recursive: true });
  const base = path.basename(file).replace(/\.[^.]+$/, "");
  const bookId = `${base}.${fmt}`;
  const outDb = path.join(libDir, `${bookId}.db`);
  const cur = jobs.get(bookId);
  if (cur && !["done", "failed", "catalog", "cancelled"].includes(cur.stage)) {
    throw new UserError(`《${base}》正在导入中（${cur.label || cur.stage}），稍候或先取消`);
  }
  cancelled.delete(bookId);
  emit(bookId, { stage: "slice", label: "准备文件", detail: path.basename(file), error: null, filePath: file });

  // 0) 原件进 books/（自包含：以后重导入不依赖 Downloads 里的原始文件）；txt 先转 docx。
  //    失败必须落 failed 态——否则横幅卡「准备文件」，且 stage=slice 不在完成态列表里，
  //    这本书会被「正在导入中」永远拒之门外（P2 逮到的卡死缺陷）
  let source;
  try {
    if (ext === "txt") {
      fs.mkdirSync(booksDir, { recursive: true });
      const kept = path.join(booksDir, `${base}.txt`);
      fs.copyFileSync(file, kept);
      source = await txtToDocx(kept); // 稳定路径：重导入时源文件 hash 稳定，重灌保护认得出
    } else {
      fs.mkdirSync(booksDir, { recursive: true });
      const dest = path.join(booksDir, path.basename(file));
      if (path.resolve(dest) !== file) fs.copyFileSync(file, dest);
      source = dest;
    }
  } catch (e) {
    const why = e instanceof UserError ? e.message : `准备文件失败：${e.message || e}`;
    emit(bookId, { stage: "failed", label: "导入失败", error: why });
    throw new UserError(why);
  }
  if (cancelled.has(bookId)) return cancelResult(bookId);

  // 1) 切片：require 复用 build-book.main（H2-② 显式 -o）。main 是 CLI 出身：
  //    失败时不抛错，只打 console.error + 置 process.exitCode——这里截获输出人话化，
  //    并把 exitCode 还回去（否则会把 Electron 主进程的退出码毒成 1）。
  emit(bookId, { stage: "slice", label: "切片中", detail: "解析原文 → 分块（≤900 字/块）" });
  const buildBook = require("../build-book.js");
  const keepExit = process.exitCode;
  const captured = [];
  const origErr = console.error;
  console.error = (...a) => captured.push(a.map(String).join(" "));
  let r;
  try { r = await buildBook.main([source, "-o", outDb]); }
  finally { console.error = origErr; process.exitCode = keepExit; }
  if (!r) {
    const why = captured.join(" / ").replace(/\s+/g, " ").slice(0, 200);
    emit(bookId, { stage: "failed", label: "导入失败", error: `切片失败：${why || "文件可能损坏、是扫描版 PDF 或格式不符"}` });
    throw new UserError(`切片失败：${why || "文件可能损坏、是扫描版 PDF 或格式不符"}`);
  }
  if (cancelled.has(bookId)) return cancelResult(bookId);

  // 2) 向量化：spawn embed-book.js <db>（显式传参；环境变量由 engine.init 回写的是
  //    BSP_LIB_DIR/BSP_SKILLS_DIR/BSP_MODELS_DIR 三个目录，nodeEnv() 另行补 ELECTRON_RUN_AS_NODE）
  emit(bookId, { stage: "vector", label: "向量化中", detail: r.skipped ? "库已存在，补向量/概念图谱" : "首次要下嵌入模型（约 112MB）" });
  const code = await runEmbed(bookId, outDb);
  if (cancelled.has(bookId)) return cancelResult(bookId);
  if (code !== 0) {
    emit(bookId, { stage: "failed", label: "导入失败", error: "向量化失败（模型下载失败或磁盘空间不足）" });
    throw new UserError("向量化失败：模型下载失败或磁盘空间不足（详细输出在启动终端里）");
  }

  // 3) 编目：聚堆 → 任务书落 catalog-tasks/（H1 直调 lib）。结果已在 → 直接入库；
  //    否则暂停在「待编目」——不卡死书架，等智能体/用户产出结果后点「导入编目结果」。
  emit(bookId, { stage: "catalog", label: "编目中", detail: "聚堆 → 生成任务书" });
  const dbRo = new Database(outDb, { readonly: true });
  let clusterRes, task;
  try { clusterRes = clusterChunks(dbRo); task = buildTask(dbRo, clusterRes); }
  catch (e) {
    const why = `编目聚堆失败：${e.message || e}`;
    emit(bookId, { stage: "failed", label: "导入失败", error: why });
    throw new UserError(why);
  } finally { dbRo.close(); }
  fs.mkdirSync(tasksDir, { recursive: true });
  const taskPath = path.join(tasksDir, `${bookId}.json`);
  fs.writeFileSync(taskPath, JSON.stringify(task, null, 1), "utf8");

  const rp = path.join(resultsDir, `${bookId}.json`);
  if (fs.existsSync(rp)) return resumeCatalog(bookId, rp); // 结果已在 → 顺着入库
  emit(bookId, { stage: "catalog", label: "待编目", detail: `任务书已生成（${task.clusters.length} 堆），等编目结果`, taskPath });
  return { bookId, stage: "catalog", taskPath, clusters: task.clusters.length };
}

// ---------- 恢复：导入编目结果（五重校验 + 入库；校验失败整批拒收） ----------
export async function resumeCatalog(bookId, resultPath) {
  const id = String(bookId || "");
  const { libDir, tasksDir, resultsDir } = jobDirs();
  const taskPath = path.join(tasksDir, `${id}.json`);
  if (!fs.existsSync(taskPath)) throw new UserError(`找不到「${id}」的编目任务书（${taskPath}）——这本书还没走到编目这步`);
  const task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
  const rp = resultPath ? path.resolve(String(resultPath)) : path.join(resultsDir, `${id}.json`);
  if (!fs.existsSync(rp)) throw new UserError(`找不到编目结果文件：${rp}——可以用「选择文件」挑一个结果 JSON`);
  let result;
  try { result = parseResultText(fs.readFileSync(rp, "utf8")); }
  catch (e) { throw new UserError(`编目结果不是合法 JSON：${e.message}`); }
  const dbPath = path.join(libDir, `${id}.db`);
  if (!fs.existsSync(dbPath)) throw new UserError(`书库文件不见了：${dbPath}`);

  emit(id, { stage: "catalog", label: "编目入库中", detail: "五重校验 → 入库", error: null });
  // 坏库文件/库被外部改坏：new Database 与 importCatalog 都要包住——裸 SqliteError
  // 冒泡到 IPC 是一屏英文堆栈，不是人话（P2 逮到）
  let db;
  try { db = new Database(dbPath); } catch (e) {
    const why = `书库打不开（${e.message}）——文件可能损坏或被占用`;
    emit(id, { stage: "failed", label: "导入失败", error: why });
    throw new UserError(why);
  }
  try {
    const stats = await importCatalog(db, task, result);
    emit(id, { stage: "done", label: "完成", detail: `主题 ${stats.themes} · 人物 ${stats.persons} · 关系 ${stats.relations}`, error: null });
    return { bookId: id, stage: "done", ...stats };
  } catch (e) {
    const why = e.errors?.length ? `校验失败：${e.errors[0]}` : (e.message || "入库失败");
    emit(id, { stage: "failed", label: "导入失败", error: why });
    throw new UserError(why);
  } finally { db.close(); }
}

// 取消：杀掉向量化子进程；切片阶段（进程内）拦不住，跑完即止（cancelled 集合把着后续步骤）
export function cancelImport(bookId) {
  const j = jobs.get(bookId);
  if (!j) return { cancelled: false, note: "没有进行中的导入" };
  cancelled.add(bookId);
  if (j.child) { try { j.child.kill(); } catch { /* 已退出 */ } }
  const wasSlice = j.stage === "slice";
  jobs.delete(bookId);
  for (const fn of subs) { try { fn({ bookId, stage: "cancelled" }); } catch { /* 同上 */ } }
  return { cancelled: true, note: wasSlice ? "切片这一步拦不住（很快），后续步骤已取消" : "已取消" };
}

// 启动时恢复「待编目」横幅：任务书在、结果不在、库还在 → 挂起等导入
export function scanPending() {
  const { tasksDir, resultsDir, libDir } = jobDirs();
  if (!fs.existsSync(tasksDir)) return [];
  const out = [];
  for (const f of fs.readdirSync(tasksDir).filter((x) => x.endsWith(".json"))) {
    const bookId = f.replace(/\.json$/, "");
    if (fs.existsSync(path.join(resultsDir, f))) continue;       // 结果已在：等用户点导入或已入库
    if (!fs.existsSync(path.join(libDir, `${bookId}.db`))) continue; // 库没了，任务书作废
    out.push(bookId);
    emit(bookId, { stage: "catalog", label: "待编目", detail: "任务书已生成，等编目结果", error: null, taskPath: path.join(tasksDir, f) });
  }
  return out;
}

// ---------- 内部：向量化子进程（进度行透传为 detail） ----------
function runEmbed(bookId, dbPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [EMBED_SCRIPT, dbPath], { env: nodeEnv() });
    const j = jobs.get(bookId);
    if (j) j.child = child;
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/进度\s+(\d+)\/(\d+)/);
      if (m) emit(bookId, { stage: "vector", detail: `向量 ${m[1]}/${m[2]} 块` });
      if (buf.length > 4000) buf = buf.slice(-1000);
    });
    child.stderr.on("data", (d) => { buf += d.toString(); });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

// txt → docx（复用 txt2docx.js CLI；稳定临时路径保证重导入幂等）。
// stderr 要拼进错误——txt2docx 的人话提示（如「UTF-16 请另存为 UTF-8」）被吞掉
// 只剩「转换失败」，用户等于没得到可执行的修复指引（P2 逮到的 D-09）
async function txtToDocx(txtPath) {
  const out = path.join(os.tmpdir(), "bsp-import", path.basename(txtPath).replace(/\.txt$/, ".docx"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TXT2DOCX_SCRIPT, txtPath, out], { env: nodeEnv() });
    let err = "";
    child.stderr.on("data", d => err += d);
    child.on("close", (code) => code === 0
      ? resolve()
      : reject(new UserError(`txt 转 docx 失败：${err.trim().split("\n")[0].slice(0, 150) || `退出码 ${code}`}`)));
    child.on("error", reject);
  });
  return out;
}

function cancelResult(bookId) {
  jobs.delete(bookId);
  cancelled.delete(bookId);
  return { bookId, stage: "cancelled" };
}
