// IPC 通道层测试：假 ipcMain 捕获 handler，对关键通道子集逐个断言注册与行为
// 测的是生产同一份注册代码（ipc.mjs）——不需要 Electron 进程。
// ask:query 要加载模型（重），留给 desktop-smoke（真机）与 eval-gate；这里只测不碰模型的通道。
import fs from "node:fs";
import path from "node:path";
import { registerIpc } from "../src/desktop/ipc.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} - ${msg}`);
  cond ? pass++ : fail++;
};

// 假 ipcMain：记下每个通道的 handler（第二个参数才是 fn）
const handlers = new Map();
const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
const app = { isPackaged: false, getPath: () => null };
const dialog = { showOpenDialog: async () => ({ canceled: true }) };
const shell = { openPath: async () => "" }; // 假系统打开：不真启 WPS（#166 book:openExternal）

const engine = await registerIpc({ ipcMain, app, dialog, shell, getWin: () => null });
engine.init({ packaged: false });

const EXPECTED = ["config:get", "config:set", "config:pickLibDir", "books:list", "books:catalog", "books:delete",
  "books:purge",
  "ask:query", "reader:chapters", "reader:block", "reader:locate", "skills:list", "skills:read", "skills:toggle",
  "engine:status", "engine:warmup", "llm:configGet", "llm:configSet", "llm:test", "chat:summary",
  "chat:archiveList", "chat:archiveClear",
  // 洗数据一键入口（V3 第二波 #140）
  "enrich:start", "enrich:cancel", "enrich:status", "enrich:audit",
  // 导入拆两段（V3 第四波 #167）：books:import 只复制登记，jobs:start 才是加工四步
  "books:import", "jobs:start", "jobs:cancel",
  // 原书视图（V3 第四波 #166）
  "book:original", "book:openExternal"];
ok(EXPECTED.every((ch) => handlers.has(ch)), `关键通道全部注册（期望子集 ${EXPECTED.length} 条 / 实际注册 ${handlers.size} 条）`);

const invoke = async (ch, ...args) => handlers.get(ch)({}, ...args);

// ---------- 轻量通道 ----------
const cfg = await invoke("config:get");
ok(cfg.ok && cfg.data.dirs.libDir.endsWith("library") && cfg.data.firstRun === false, "config:get 返回目录与 firstRun");

const books = await invoke("books:list");
// V3 第四波 #165：书架 = library 库（processed）∪ books/ 未加工原件（raw，数量随用户文件变，不断言）。
// 锁稳定契约：processed 恒等于 library 库数、每条带编目摘要。V3 第五波起书架随用户增删动态
// （2026-10-19 删库重建后 17 本快照作废——数量改为与 library/*.db 实数对账，下限 5 防空转）。
const libDbCount = fs.readdirSync(path.join(import.meta.dirname, "..", "library"))
  .filter(f => f.endsWith(".db")).length;
const processed = books.data.filter(b => b.status === "processed");
ok(books.ok && processed.length === libDbCount && processed.length >= 5 && processed.every(b => !!b.catalog),
  `books:list 已加工书（${processed.length}）与库数（${libDbCount}）一致且全带编目摘要`);
ok(books.data.every(b => b.status === "processed" || b.status === "raw") && books.data.every(b => !!b.asset),
  "书架每条带 status/asset（raw=待加工，供渲染层分流）");
const id = books.data[0].id;

const cat = await invoke("books:catalog", id);
ok(cat.ok && !!cat.data.book, "books:catalog 单本编目");

const ch = await invoke("reader:chapters", id);
ok(ch.ok && ch.data.chapters.length >= 1, "reader:chapters 有目录");
ok(ch.ok && typeof ch.data.quality?.verdict === "string" && typeof ch.data.totalTokens === "number",
  "reader:chapters 带 get_outline 对称字段（quality.verdict 三态 + totalTokens 账）");

const blk = await invoke("reader:block", id, ch.data.chapters[0].name);
ok(blk.ok && blk.data.blocks.length >= 1, "reader:block 有原文块");

const loc = await invoke("reader:locate", id, blk.data.blocks[0].id);
ok(loc.ok && loc.data.chapter === ch.data.chapters[0].name, "reader:locate 反查章节");

const skills = await invoke("skills:list");
ok(skills.ok && skills.data.some((s) => s.slug === "kb-research"), "skills:list 含 kb-research 包");

const skillMd = await invoke("skills:read", "kb-research");
ok(skillMd.ok && /知识库/.test(skillMd.data.skill_md || ""), "skills:read 读到 SKILL.md");

const st = await invoke("engine:status");
ok(st.ok && !!st.data.dirs && typeof st.data.rerank === "boolean", "engine:status");

// ---------- 云端问答（V2 P2）：未注入 safeStorage 时安全默认 / 拒收 ----------
const lcfg = await invoke("llm:configGet");
ok(lcfg.ok && lcfg.data.hasKey === false, "llm:configGet 未注入 safeStorage 时安全默认（hasKey:false）");
const lset = await invoke("llm:configSet", { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "sk-test" });
ok(lset.ok === false, "llm:configSet 未注入时拒收（不落盘）");

// ---------- 洗数据一键入口（#140）：状态快照 / 无任务取消 / 坏书复查 ----------
const ejStatus = await invoke("enrich:status");
ok(ejStatus.ok && typeof ejStatus.data === "object", "enrich:status 返回任务快照对象");
const ejCancel = await invoke("enrich:cancel", "不存在的书");
ok(ejCancel.ok && ejCancel.data.cancelled === false, "enrich:cancel 无任务返回说明（不炸）");
const ejAudit = await invoke("enrich:audit", books.data[0].id);
ok(ejAudit.ok && typeof ejAudit.data.ready === "boolean", `enrich:audit 真书只读复查（ready=${ejAudit.data.ready}，形状不断言数值）`);
const ejAuditBad = await invoke("enrich:audit", "不存在的书xyz");
ok(ejAuditBad.ok === false && ejAuditBad.error.code === "user", "enrich:audit 坏书走错误包装（M3）");

// ---------- 原书视图（V3 #166）：元信息 / 系统打开 / 坏书名包装 ----------
{
  const orig = await invoke("book:original", "lunyu-xueer-zh.docx"); // books/ 有真原件
  ok(orig.ok && orig.data.ext === "docx" && orig.data.render === "html"
    && orig.data.url.startsWith("book://asset/"), `book:original 有原件书（render=${orig.data?.render}）`);
  const origBad = await invoke("book:original", "awesome-fenix-zh.md"); // CLI 建库无原件
  ok(origBad.ok === false && origBad.error.code === "user", "book:original 无原件 → {ok:false,user} 不崩");
  const openBad = await invoke("book:openExternal", "不存在的书xyz");
  ok(openBad.ok === false && openBad.error.code === "user", "book:openExternal 坏书名 → 错误包装（不真开）");
  const openOk = await invoke("book:openExternal", "lunyu-xueer-zh.docx");
  ok(openOk.ok && openOk.data.opened.endsWith("lunyu-xueer-zh.docx"), "book:openExternal 有原件 → shell.openPath（假件不真启）");
}

// ---------- 导入拆两段（V3 #167）：jobs:start 坏书名/无原件 → 错误包装不崩 ----------
{
  const badId = await invoke("jobs:start", "../evil.docx");
  ok(badId.ok === false && badId.error.code === "user", "jobs:start 穿越书名 → {ok:false,user}（safeBookId 闸门）");
  const noAsset = await invoke("jobs:start", "不存在的书xyz.docx");
  ok(noAsset.ok === false && noAsset.error.code === "user", "jobs:start 无原件 → 错误包装（不凭记忆找文件）");
}

// ---------- 两档删除（V3 第四波 #168）：purge 通道注册 + 坏书名错误包装 ----------
// （真删真库的书由 archive-config-fuzz P1-E 在 tmp 自建库上验；这里只锁通道契约）
const badPurge = await invoke("books:purge", "不存在的书xyz");
ok(badPurge.ok === false && badPurge.error.code === "user", "books:purge 坏书名 → {ok:false,user}（不抛）");
const evilPurge = await invoke("books:purge", "../evil.docx");
ok(evilPurge.ok === false && evilPurge.error.code === "user", "books:purge 穿越书名 → {ok:false,user}（resolveAsset safeBookId 闸门）");

// ---------- 错误包装：坏书名 → {ok:false,error} 不抛 ----------
const bad = await invoke("books:catalog", "不存在的书xyz");
ok(bad.ok === false && bad.error.code === "user", "坏书名走错误包装不崩（M3）");

// ---------- H3：开关语义（动真书库状态，前后快照保护，finally 复位） ----------
// 契约：书架（books:list）显示全部书 + skillEnabled 标记（关掉的要能开回来）；
// 过滤发生在检索层——MCP 与全库路由走 listBooks 默认过滤（paths-test 已覆盖），
// 桌面显式选书是用户自己的动作，仍可用。
const stateFile = path.join(engine.dirs().libDir, "skill-state.json");
const backup = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
try {
  const off = await invoke("skills:toggle", id, false);
  ok(off.ok && off.data[id] === false, "skills:toggle 关闭写入");
  const shelf = await invoke("books:list");
  const shown = shelf.data.find((b) => b.id === id);
  ok(!!shown && shown.skillEnabled === false, "关掉后书架仍显示该书但标记已关（关掉的书要能开回来）");
} finally {
  if (backup === null) fs.rmSync(stateFile, { force: true }); else fs.writeFileSync(stateFile, backup);
}
const back = await invoke("books:list");
ok(back.data.filter(b => b.status === "processed").length === libDbCount, `状态复位后已加工书回来（${libDbCount} 本，finally 保护生效）`);

// ---------- W1 用量治理：usage:get（只读断言） ----------
// 写路径（usage:set → usage-policy.json）不在这里真写库目录：由 usage-gate-test
// 在 tmp 目录上验（saveUsagePolicy 深合并 + MCP 闸机读同一份），这里只锁 IPC 契约
{
  const usage = await invoke("usage:get");
  ok(usage.ok && usage.data.policy && typeof usage.data.policy.enabled === "boolean"
    && usage.data.usage && typeof usage.data.usage.calls === "number" && usage.data.session,
    "usage:get 返回策略 + 当日用量 + 会话记账（IPC 契约）");
}

// ---------- P5 派生六落点：真库只读定位（一格都不删） ----------
// 真删行为由 archive-config-fuzz P1-E1/E3 在 tmp 自建库上验（走同一份真 IPC handler）。
// 这里只锁两件事：① 定位不越界（每条都落在书库上级的四个派生目录内）；
// ② dryRun 在真库上零副作用——规划 §2.4 的「真库只读验收」落进测试里。
{
  const { derivedCandidates, purgeDerived } = await import("../src/lib/derived.mjs");
  const libDir = engine.dirs().libDir;
  const root = path.resolve(path.join(libDir, ".."));
  const allowed = new Set(["catalog-tasks", "catalog-results", "enrich-tasks", "enrich-results"]);
  const processed = back.data.filter((b) => b.status === "processed");
  let six = true, inBounds = true;
  for (const b of processed) {
    const c = derivedCandidates(libDir, b.id);
    if (!c.ok || c.items.length !== 6) { six = false; continue; }
    for (const it of c.items) {
      const rel = path.relative(root, it.path).replace(/\\/g, "/");
      if (!allowed.has(rel.split("/")[0])) inBounds = false;
    }
  }
  ok(six, `P5: ${processed.length} 本 processed 每本都定位出六项候选（真库只读）`);
  ok(inBounds, "P5: 六项候选全部落在四个派生目录内（不越界、不穿到书库或更上层）");
  const dries = processed.map((b) => purgeDerived(libDir, b.id, { dryRun: true }));
  const totalWould = dries.reduce((s, r) => s + r.wouldRemove.length, 0);
  // totalWould > 0 是「路径真的拼对了」的实测证据：若后缀整体写错（.json 拼成 .JSON），
  // 全库会静默空转、上面两条断言照样全绿（陆回测 OBSERVE-3）
  ok(dries.every((r) => r.removedCount === 0 && r.failed.length === 0 && r.rejected === false)
    && totalWould > 0,
    `P5: 真库 dryRun 零删除零失败，且账上确有派生（本会删 ${totalWould} 项）`);
}

console.log(`===== ipc-test: ${pass} PASS / ${fail} FAIL =====`);
process.exit(fail ? 1 : 0);
