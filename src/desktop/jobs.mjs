// 导入管线（4.6 按对账审计 H1/H2 修正版实现；V3 第四波 #167「导入拆两段」重构为两段）：
//   第一段 startImport：复制原件进 books/ + 登记（丢入即可看原文，不烧算力）；
//   第二段 startProcessing：切片 → 向量化 → 编目（任务书 + 暂停等结果）→（恢复）五重校验入库。
// H1：编目两步绕开 CLI（catalog-export/import 按 process.cwd() 找书库，迁库即瞎），
//     直调 lib 已导出的 clusterChunks/buildTask/parseResultText/importCatalog。
// H2：build-book 用 require 复用且显式 -o（输出路径自己说了算，不从 Downloads 旁建库）；
//     embed-book spawn 显式传 db 路径；进度只做阶段横幅，不做假百分比（H2-③）。
// 铁轨：jobs 状态经 onJobsProgress 订阅 → 主进程转发 jobs:progress 事件 → 书架卡片横幅。
// 任务带 phase 字段（import/process）——渲染层据此区分「重试导入」与「重试加工」。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { clusterChunks, buildTask, parseResultText, importCatalog, buildPromptText } from "../lib/catalog.mjs";
import { currentLibDir } from "../lib/search.mjs";
import { resolveAsset, safeBookId } from "../lib/assets.mjs";
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
const gens = new Map();   // bookId → 代际号（每次 start / 取消都 bump）
const subs = new Set();

// 事件/状态出海前剥掉 child（ChildProcess 不可 structured clone，带上会炸 IPC）
const plain = (j) => { const { child, ...rest } = j; return rest; };

// 代际（评审对抗官 F6-F1：墓碑是 bookId 级的「取消态」，挡不住「取消后立刻
// 重导入 → 旧管线收尾污染新条目甚至 cancelResult 删掉新条目」——生产窗口是
// 旧管线整段剩余运行时间，秒级到分钟级）。旧管线每处 emit/cancelResult 都带
// 启动时的代际号，代际不符一律落空/不碰条目
const curGen = (bookId) => gens.get(bookId) || 0;
const nextGen = (bookId) => { const g = curGen(bookId) + 1; gens.set(bookId, g); return g; };

function emit(bookId, patch, g) {
  if (g !== undefined && g !== curGen(bookId)) return;   // 旧代落空（不许污染新代条目）
  // 墓碑：取消后管线还在收尾，其后的 emit 不许复活条目——否则取消的书仍挂
  // 「结构化改造中」/「加工失败」幽灵横幅，卡住重导入（C21/C1/C2 坐实）
  if (cancelled.has(bookId)) return;
  const j = jobs.get(bookId) || { stage: "slice", startedAt: Date.now() };
  Object.assign(j, patch, { bookId });
  jobs.set(bookId, j);
  for (const fn of subs) { try { fn(plain(j)); } catch { /* 订阅者崩不拖垮管线 */ } }
}
export function jobsStatus() { return Object.fromEntries([...jobs].map(([k, v]) => [k, plain(v)])); }
export function onJobsProgress(fn) { subs.add(fn); return () => subs.delete(fn); }

// ---------- 主流程·第一段：导入（V3 第四波 #167「导入拆两段」） ----------
// 丢一本书进来只做资产层落盘：复制原件进 books/ + 登记书架条目。
// 不切片不向量化——用户先能看原文（book:// 原书视图），再决定点不点「开始加工」。
// 失败必须落 failed 态——否则横幅卡「放进书架」，且 stage=slice 不在完成态列表里，
// 这本书会被「正在导入中」永远拒之门外（P2 逮到的卡死缺陷，拆段后照样防）
export async function startImport(filePath) {
  const raw = String(filePath ?? "").trim();
  // 空路径防御：旧的拖拽链路会传 undefined 进来，path.resolve("") 静默解析成 cwd，
  // existsSync(cwd) 又为真，最后抛出与真因不符的「不支持的格式 .?」（G-02 故障链）
  if (!raw) throw new UserError("没拿到文件路径——请重试拖拽");
  const file = path.resolve(raw);
  if (!fs.existsSync(file)) throw new UserError(`找不到文件：${file}`);
  const ext = (path.extname(file).match(/^\.(.+)$/) || [])[1]?.toLowerCase();
  const fmt = EXT_FMT[ext];
  if (!fmt) throw new UserError(`不支持的格式 .${ext || "?"}（支持 .epub / .docx / .pdf / .txt）`);
  const { booksDir } = jobDirs();
  fs.mkdirSync(booksDir, { recursive: true }); // 连带把 libDir 上级建出来
  const base = path.basename(file).replace(/\.[^.]+$/, "");
  const bookId = `${base}.${fmt}`;
  const cur = jobs.get(bookId);
  if (cur && !["done", "failed", "catalog", "cancelled"].includes(cur.stage)) {
    throw new UserError(`《${base}》正在${cur.phase === "process" ? "加工" : "导入"}中（${cur.label || cur.stage}），稍候或先取消`);
  }
  cancelled.delete(bookId);
  const g = nextGen(bookId); // 新代：旧管线的 emit/cancelResult 从此落空
  emit(bookId, { phase: "import", stage: "slice", label: "放进书架", detail: path.basename(file), error: null, filePath: file }, g);

  // 0) 原件进 books/（自包含：以后加工/重导入不依赖 Downloads 里的原始文件）；
  //    txt 保持 .txt 落盘（bookId 才是 <base>.docx——转 docx 是加工段的事）
  try {
    const dest = path.join(booksDir, ext === "txt" ? `${base}.txt` : path.basename(file));
    if (path.resolve(dest) !== file) fs.copyFileSync(file, dest);
  } catch (e) {
    const why = e instanceof UserError ? e.message : `放进书架失败：${e.message || e}`;
    emit(bookId, { phase: "import", stage: "failed", label: "导入失败", error: why }, g);
    throw new UserError(why);
  }
  if (cancelled.has(bookId)) return cancelResult(bookId, g);

  emit(bookId, { phase: "import", stage: "done", label: "已放进书架", detail: "点「开始加工」才会切片/向量化/编目", error: null }, g);
  return { bookId, stage: "imported", note: "原件已复制进 books/——先看原文，点「开始加工」才建库" };
}

// ---------- 主流程·第二段：加工（V3 第四波 #167） ----------
// 切片 → 向量化 → 编目（任务书 + 暂停等结果）→（恢复）五重校验入库。
// 入口是书架 raw 卡片的「开始加工」：原件从 books/ 经 resolveAsset 定位（资产层唯一真身，
// 不认拖拽时的原路径——Downloads 会清、迁库不失效）；txt 书 bookId 是 <base>.docx、
// 原件是 <base>.txt（EXT_FMT 同款映射，resolveAsset 兜底）。重跑幂等沿用旧语义：
// 切片同 hash 跳过、向量补齐、编目任务书重生成（结果已在则顺着入库）。
export async function startProcessing(bookId) {
  const id = safeBookId(bookId);
  if (!id) throw new UserError("书名不合法");
  const { libDir, tasksDir, resultsDir } = jobDirs();
  const cur = jobs.get(id);
  if (cur && !["done", "failed", "catalog", "cancelled"].includes(cur.stage)) {
    throw new UserError(`《${id}》正在加工中（${cur.label || cur.stage}），稍候或先取消`);
  }
  const asset = resolveAsset(libDir, id);
  if (!asset.exists) throw new UserError(`books/ 里找不到《${id}》的原件——这本书没有可加工的原件（可能是旧管线建的库）`);
  if (!EXT_FMT[asset.ext]) throw new UserError(`不支持的格式 .${asset.ext}（支持 .epub / .docx / .pdf / .txt）`);
  const outDb = path.join(libDir, `${id}.db`);
  cancelled.delete(id);
  const g = nextGen(id); // 新代：取消后旧管线残留的 emit/cancelResult 全部落空
  // 本管线统一经 emitG 发声（带代际号）——直接 emit 会绕过代际校验
  const emitG = (patch) => emit(id, patch, g);
  emitG({ phase: "process", stage: "slice", label: "准备文件", detail: path.basename(asset.path), error: null, filePath: asset.path });

  // 0) 切片源：txt 先转 docx（输出名带内容 hash：重跑幂等、换源不碰撞）；
  //    其余直接用 books/ 里的原件。失败落 failed 态（P2 逮到的 0 步卡死缺陷）
  let source;
  try {
    source = asset.ext === "txt" ? await txtToDocx(asset.path, id) : asset.path;
  } catch (e) {
    // 取消导致的转换中断：按取消收尾，不弹「加工失败」（用户主动取消不是错误，毛 O3）
    if (cancelled.has(id)) return cancelResult(id, g);
    const why = e instanceof UserError ? e.message : `准备文件失败：${e.message || e}`;
    emitG({ phase: "process", stage: "failed", label: "加工失败", error: why });
    throw new UserError(why);
  }
  if (cancelled.has(id)) return cancelResult(id, g);

  // 1) 结构化改造 + 切片：require 复用 build-book.main（H2-② 显式 -o）。main 是 CLI 出身：
  //    失败时不抛错，只打 console.error + 置 process.exitCode——这里截获输出人话化，
  //    并把 exitCode 还回去（否则会把 Electron 主进程的退出码毒成 1）。
  //    V3 第四波 P2：结构化改造（清洗坏数据/不全数据/乱码符号）是切片前的独立一步，
  //    经 onStage 回调在横幅上单独占一格——硬拦（修不动的乱码/内容太少）发生在烧算力之前。
  emitG({ stage: "slice", label: "结构化改造中", detail: "清洗坏数据/不全数据/乱码符号，过了才切片" });
  const buildBook = require("../build-book.js");
  const keepExit = process.exitCode;
  const captured = [];
  const origErr = console.error;
  console.error = (...a) => captured.push(a.map(String).join(" "));
  let r;
  try {
    r = await buildBook.main([source, "-o", outDb], {
      onStage: (s) => {
        if (s === "slice") emitG({ stage: "slice", label: "切片中", detail: "解析原文 → 分块（≤900 字/块）" });
      },
    });
  }
  finally { console.error = origErr; process.exitCode = keepExit; }
  if (!r) {
    const why = captured.join(" / ").replace(/\s+/g, " ").slice(0, 200);
    const msg = `加工失败：${why || "文件可能损坏、是扫描版 PDF 或格式不符"}`;
    emitG({ stage: "failed", label: "加工失败", error: msg });
    throw new UserError(msg);
  }
  // 结构化改造账（P2）：真洗了东西横幅说一声，干净的书零刷屏（存量行为零变化）
  const st = r.struct;
  if (st && (st.droppedEmpty || st.droppedGarbage || st.repairedMojibake || st.strippedControls || st.strippedPua || st.strippedFffd || st.strippedSurrogates)) {
    emitG({ stage: "slice", detail: `结构化改造：去空块 ${st.droppedEmpty} · 去垃圾块 ${st.droppedGarbage} · 修乱码块 ${st.repairedMojibake} · 清符号 ${st.strippedControls + st.strippedPua + st.strippedFffd + st.strippedSurrogates} 处` });
  }
  if (cancelled.has(id)) return cancelResult(id, g);

  // 2) 向量化：spawn embed-book.js <db>（显式传参；环境变量由 engine.init 回写的是
  //    BSP_LIB_DIR/BSP_SKILLS_DIR/BSP_MODELS_DIR 三个目录，nodeEnv() 另行补 ELECTRON_RUN_AS_NODE）
  emitG({ stage: "vector", label: "向量化中", detail: r.skipped ? "库已存在，补向量/概念图谱" : "首次要下嵌入模型（约 112MB）" });
  const code = await runEmbed(id, outDb, g);
  if (cancelled.has(id)) return cancelResult(id, g);
  if (code !== 0) {
    emitG({ stage: "failed", label: "加工失败", error: "向量化失败（模型下载失败或磁盘空间不足）" });
    throw new UserError("向量化失败：模型下载失败或磁盘空间不足（详细输出在启动终端里）");
  }

  // 3) 编目：聚堆 → 任务书落 catalog-tasks/（H1 直调 lib）。结果已在 → 直接入库；
  //    否则暂停在「待编目」——不卡死书架，等智能体/用户产出结果后点「导入编目结果」。
  emitG({ stage: "catalog", label: "编目中", detail: "聚堆 → 生成任务书" });
  const dbRo = new Database(outDb, { readonly: true });
  let clusterRes, task;
  try { clusterRes = clusterChunks(dbRo); task = buildTask(dbRo, clusterRes); }
  catch (e) {
    const why = `编目聚堆失败：${e.message || e}`;
    emitG({ stage: "failed", label: "加工失败", error: why });
    throw new UserError(why);
  } finally { dbRo.close(); }
  fs.mkdirSync(tasksDir, { recursive: true });
  const taskPath = path.join(tasksDir, `${id}.json`);
  fs.writeFileSync(taskPath, JSON.stringify(task, null, 1), "utf8");

  const rp = path.join(resultsDir, `${id}.json`);
  if (fs.existsSync(rp)) return resumeCatalog(id, rp, g); // 结果已在 → 顺着入库
  emitG({ stage: "catalog", label: "待编目", detail: `任务书已生成（${task.clusters.length} 堆），等编目结果`, taskPath });
  return { bookId: id, stage: "catalog", taskPath, clusters: task.clusters.length };
}

// ---------- 恢复：导入编目结果（五重校验 + 入库；校验失败整批拒收） ----------
// g：代际号（startProcessing 内部续跑时透传；IPC 直调时缺省=当前代）
export async function resumeCatalog(bookId, resultPath, g) {
  // 入口闸门（C2/C10）：id 用于拼 taskPath/dbPath/默认 rp——不过闸可 `../` 逃逸；
  // resultPath 是用户「选择文件」直传的结果 JSON（设计如此，非 id 派生，不在闸范围）
  const id = safeBookId(bookId);
  if (!id) throw new UserError("书名不合法");
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

  emit(id, { stage: "catalog", label: "编目入库中", detail: "五重校验 → 入库", error: null }, g);
  // 坏库文件/库被外部改坏：new Database 与 importCatalog 都要包住——裸 SqliteError
  // 冒泡到 IPC 是一屏英文堆栈，不是人话（P2 逮到）
  let db;
  try { db = new Database(dbPath); } catch (e) {
    const why = `书库打不开（${e.message}）——文件可能损坏或被占用`;
    emit(id, { stage: "failed", label: "入库失败", error: why }, g);
    throw new UserError(why);
  }
  try {
    const stats = await importCatalog(db, task, result);
    emit(id, { stage: "done", label: "完成", detail: `主题 ${stats.themes} · 人物 ${stats.persons} · 关系 ${stats.relations}`, error: null }, g);
    return { bookId: id, stage: "done", ...stats };
  } catch (e) {
    const why = e.errors?.length ? `校验失败：${e.errors[0]}` : (e.message || "入库失败");
    emit(id, { stage: "failed", label: "入库失败", error: why }, g);
    throw new UserError(why);
  } finally { db.close(); }
}

// 取消：杀掉子进程；切片阶段（进程内）拦不住，跑完即止（墓碑把着后续步骤）。
// bump 代际：旧管线（main/embed 还在跑）之后的所有 emit/cancelResult 全部失效
export function cancelImport(bookId) {
  const j = jobs.get(bookId);
  if (!j) return { cancelled: false, note: "没有进行中的任务" };
  nextGen(bookId);
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
    // 文件名派生的 id 也要过闸（C2/scanPending）：历史脏文件（含 ../ 等）
    // 不上横幅——否则任务书路径可指向库外，且后续 resume 流程接手脏 id
    const bookId = safeBookId(f.replace(/\.json$/, ""));
    if (!bookId) {
      // 脏任务书静默跳过会埋排障坑（用户看不到也删不掉）——留一行痕迹
      console.warn(`  跳过非法任务书文件名: ${f}`);
      continue;
    }
    if (fs.existsSync(path.join(resultsDir, f))) continue;       // 结果已在：等用户点导入或已入库
    if (!fs.existsSync(path.join(libDir, `${bookId}.db`))) continue; // 库没了，任务书作废
    out.push(bookId);
    emit(bookId, { stage: "catalog", label: "待编目", detail: "任务书已生成，等编目结果", error: null, taskPath: path.join(tasksDir, f) });
  }
  return out;
}

// ---------- 一键提示词：任务书 → 可直粘给任意 AI 的完整提示词（落盘 + 返回全文） ----------
// 编目第④步保持半自动设计：提示词不代打 AI，只把「人工整理任务书」变成「复制粘贴」。
export function catalogPrompt(bookId) {
  // 入口闸门（C2/C11）：taskPath/outPath 都由 id 派生——不过闸可读库外任务书、
  // 还能把 prompt.md 写到上级目录（逃逸写）
  const id = safeBookId(bookId);
  if (!id) throw new UserError("书名不合法");
  const { tasksDir } = jobDirs();
  const taskPath = path.join(tasksDir, `${id}.json`);
  if (!fs.existsSync(taskPath)) throw new UserError(`找不到《${id}》的编目任务书——这本书还没走到编目这步`);
  let task;
  try { task = JSON.parse(fs.readFileSync(taskPath, "utf8")); }
  catch (e) { throw new UserError(`任务书不是合法 JSON（${e.message}）——可先重新导入这本书`); }
  const text = buildPromptText(task);
  const outPath = path.join(tasksDir, `${id}.prompt.md`);
  try { fs.writeFileSync(outPath, text, "utf8"); }
  catch (e) { throw new UserError(`提示词落盘失败：${e.message}`); }
  return { bookId: id, chars: text.length, path: outPath, text };
}

// ---------- 内部：向量化子进程（进度行透传为 detail；g=代际号） ----------
function runEmbed(bookId, dbPath, g) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [EMBED_SCRIPT, dbPath], { env: nodeEnv() });
    const j = jobs.get(bookId);
    if (j) j.child = child;
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/进度\s+(\d+)\/(\d+)/);
      if (m) emit(bookId, { stage: "vector", detail: `向量 ${m[1]}/${m[2]} 块` }, g);
      if (buf.length > 4000) buf = buf.slice(-1000);
    });
    child.stderr.on("data", (d) => { buf += d.toString(); });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

// txt → docx（复用 txt2docx.js CLI）。输出名带内容 hash：同源重跑幂等覆盖无害，
// 换源重跑不碰撞（C33/C3 坐实：稳定路径下同 base 换源会覆盖旧转换结果，重灌保护
// 误判成「另一本书」）。stderr 拼进错误——txt2docx 的人话提示（如「UTF-16 请
// 另存为 UTF-8」）被吞掉只剩「转换失败」，用户等于没得到可执行的修复指引（D-09）
async function txtToDocx(txtPath, bookId) {
  // 流式 hash（16 hex=64bit）：不整读大文件、不阻塞事件循环（评审对抗官 O2）；
  // 16 hex 让跨书同 base 碰撞可忽略（毛 O1：32bit 在千本级库约 1e-4）
  const hash = await new Promise((resolve, reject) => {
    const h = crypto.createHash("sha1");
    fs.createReadStream(txtPath)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex").slice(0, 16)))
      .on("error", reject);
  });
  const out = path.join(os.tmpdir(), "bsp-import", `${path.basename(txtPath).replace(/\.txt$/, "")}.${hash}.docx`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TXT2DOCX_SCRIPT, txtPath, out], { env: nodeEnv() });
    // 挂到 jobs 条目上：cancelImport 靠 j.child.kill() 杀子进程（C22/C6 坐实）。
    // plain() 会把 child 剥掉再出海。流式 hash 的 await 让取消有机会插入——条目
    // 已删（=已取消）时不许留 orphan 子进程跑完落盘（毛 F3 窄缝）：杀掉并短路
    const cur = jobs.get(bookId);
    if (!cur) {
      try { child.kill(); } catch { /* 已退出 */ }
      reject(new UserError("已取消"));
      return;
    }
    cur.child = child;
    const clearChild = () => { const j = jobs.get(bookId); if (j && j.child === child) delete j.child; };
    let err = "";
    child.stderr.on("data", d => err += d);
    child.on("close", (code) => {
      clearChild();
      code === 0 ? resolve() : reject(new UserError(`txt 转 docx 失败：${err.trim().split("\n")[0].slice(0, 150) || `退出码 ${code}`}`));
    });
    child.on("error", (e) => { clearChild(); reject(e); });
  });
  return out;
}

function cancelResult(bookId, g) {
  // 代际校验（评审对抗官 F6-F1 删除路径）：旧代收尾不许删掉新代条目——「取消 →
  // 立刻重导入 → 旧管线走到检查点」会把用户的新任务凭空删掉。
  // 墓碑不清（毛 F2）：留作该 id 的「取消态」标记，只在 startImport/startProcessing
  // 入口清——cancelResult 清墓碑会让之后落地的迟到 emit 复活幽灵
  if (g === undefined || g === curGen(bookId)) jobs.delete(bookId);
  return { bookId, stage: "cancelled" };
}
