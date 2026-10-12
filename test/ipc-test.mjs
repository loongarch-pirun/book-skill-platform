// IPC 通道层测试：假 ipcMain 捕获 handler，验证 15 条通道注册与行为
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

const engine = await registerIpc({ ipcMain, app, dialog, getWin: () => null });
engine.init({ packaged: false });

const EXPECTED = ["config:get", "config:set", "config:pickLibDir", "books:list", "books:catalog", "books:delete",
  "ask:query", "reader:chapters", "reader:block", "reader:locate", "skills:list", "skills:read", "skills:toggle",
  "engine:status", "engine:warmup"];
ok(EXPECTED.every((ch) => handlers.has(ch)), `15 条通道全部注册（实际 ${handlers.size}）`);

const invoke = async (ch, ...args) => handlers.get(ch)({}, ...args);

// ---------- 轻量通道 ----------
const cfg = await invoke("config:get");
ok(cfg.ok && cfg.data.dirs.libDir.endsWith("library") && cfg.data.firstRun === false, "config:get 返回目录与 firstRun");

const books = await invoke("books:list");
ok(books.ok && books.data.length === 6 && !!books.data[0].catalog, "books:list 六本带编目摘要");
const id = books.data[0].id;

const cat = await invoke("books:catalog", id);
ok(cat.ok && !!cat.data.book, "books:catalog 单本编目");

const ch = await invoke("reader:chapters", id);
ok(ch.ok && ch.data.chapters.length >= 1, "reader:chapters 有目录");

const blk = await invoke("reader:block", id, ch.data.chapters[0].name);
ok(blk.ok && blk.data.blocks.length >= 1, "reader:block 有原文块");

const loc = await invoke("reader:locate", id, blk.data.blocks[0].id);
ok(loc.ok && loc.data.chapter === ch.data.chapters[0].name, "reader:locate 反查章节");

const skills = await invoke("skills:list");
ok(skills.ok && skills.data.some((s) => s.slug === "daodejing"), "skills:list 含道德经包");

const skillMd = await invoke("skills:read", "daodejing");
ok(skillMd.ok && /道德经/.test(skillMd.data.skill_md || ""), "skills:read 读到 SKILL.md");

const st = await invoke("engine:status");
ok(st.ok && !!st.data.dirs && typeof st.data.rerank === "boolean", "engine:status");

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
ok(back.data.length === 6, "状态复位后六本回来（finally 保护生效）");

console.log(`===== ipc-test: ${pass} PASS / ${fail} FAIL =====`);
process.exit(fail ? 1 : 0);
