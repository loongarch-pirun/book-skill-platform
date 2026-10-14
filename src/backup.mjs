// 一键备份：library 真身 + git 历史 bundle + 产物清单
// 用法：node src/backup.mjs [--keep 3]   或   npm run backup
// 备什么：library/*.db（知识库唯一真身，git 之外）+ repo.bundle（全部代码与 git 历史）
// 不备什么：node_modules（npm install 可重建）、.models（按配置自动从 hf-mirror 重下）、release（打包产物）
// 安全白名单：只删 backup/ 下名字严格匹配 bsp-backup-YYYYMMDD-HHmmss 的目录，绝不碰别处
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const ROOT = path.join(import.meta.dirname, "..");
// H4：书库目录可被环境变量改指（桌面端迁库后 BSP_LIB_DIR 指向 userData），
// 不再焊死项目根——否则迁库用户会拿到只有代码的"假备份"
const LIB = process.env.BSP_LIB_DIR || path.join(ROOT, "library");
const BACKUP_DIR = path.join(ROOT, "backup");
const NAME_RE = /^bsp-backup-(\d{8})-(\d{6})$/;

// ---------- 参数：保留份数（默认 3） ----------
function parseKeep() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--keep");
  if (i >= 0 && argv[i + 1] && Number(argv[i + 1]) >= 1) return Number(argv[i + 1]);
  if (process.env.BSP_BACKUP_KEEP && Number(process.env.BSP_BACKUP_KEEP) >= 1)
    return Number(process.env.BSP_BACKUP_KEEP);
  return 3;
}
const KEEP = parseKeep();

// ---------- 工具 ----------
const pad = (n) => String(n).padStart(2, "0");
const stamp = (d = new Date()) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const kb = (n) => (n / 1024).toFixed(1) + " KB";
const mb = (n) => (n / 1024 / 1024).toFixed(1) + " MB";
const fmtSize = (n) => (n >= 1024 * 1024 ? mb(n) : kb(n));

function dirSize(p) {
  let total = 0;
  for (const f of fs.readdirSync(p, { withFileTypes: true })) {
    const fp = path.join(p, f.name);
    total += f.isDirectory() ? dirSize(fp) : fs.statSync(fp).size;
  }
  return total;
}

const warnings = [];

// ---------- 1. 对每个库做 WAL checkpoint（尽力而为，被占用就带着 wal 一起拷） ----------
function checkpointLibraries() {
  if (!fs.existsSync(LIB)) {
    // 不再静默返回空数组——那等于打"✅ 备份完成"却没备到一本书（H4 实锤的假备份）
    warnings.push(`书库目录不存在：${LIB} ——如果迁过书库，设 BSP_LIB_DIR 指向新目录后重跑；否则这次备份只有代码没有书`);
    return [];
  }
  return fs.readdirSync(LIB).filter((f) => f.endsWith(".db")).sort().map((f) => {
    const dbPath = path.join(LIB, f);
    try {
      const db = new Database(dbPath);
      try {
        db.pragma("wal_checkpoint(TRUNCATE)");
      } finally {
        db.close();
      }
    } catch (e) {
      warnings.push(`checkpoint 失败（库可能被 MCP 占用，将连同 -wal 一起拷贝）：${f} — ${e.message || e}`);
    }
    return dbPath;
  });
}

// ---------- 2. 建本次备份目录并拷贝 ----------
const ts = stamp();
const dest = path.join(BACKUP_DIR, "bsp-backup-" + ts);
fs.mkdirSync(dest, { recursive: true });
const copied = [];

function copyIfExists(src, rel) {
  if (!fs.existsSync(src)) return;
  const st = fs.statSync(src);
  if (st.size === 0) return; // checkpoint 后的 0 字节 wal 不拷
  fs.copyFileSync(src, path.join(dest, rel));
  copied.push({ rel, size: st.size });
}

for (const dbPath of checkpointLibraries()) {
  const base = path.basename(dbPath);
  copyIfExists(dbPath, base);
  copyIfExists(dbPath + "-wal", base + "-wal");
}

// P4：云端回答存档跟书库一起备（<libDir>/chat-archive/archive.jsonl，小文件）——
// 答案丢了能重问，但"当初引用了哪段原文"的快照补不回来，值得进备份
{
  const archSrc = path.join(LIB, "chat-archive", "archive.jsonl");
  if (fs.existsSync(archSrc)) {
    fs.mkdirSync(path.join(dest, "chat-archive"), { recursive: true });
    copyIfExists(archSrc, "chat-archive/archive.jsonl");
  }
}

// ---------- 3. git bundle（全部代码 + 历史，单文件可 clone） ----------
let bundleNote = "（未生成：不是 git 仓库或 git 不可用）";
try {
  execFileSync("git", ["bundle", "create", path.join(dest, "repo.bundle"), "--all", "HEAD"], {
    cwd: ROOT, stdio: "pipe",
  });
  const st = fs.statSync(path.join(dest, "repo.bundle"));
  copied.push({ rel: "repo.bundle", size: st.size });
  bundleNote = `git bundle --all HEAD，恢复：git clone repo.bundle 项目名`;
} catch (e) {
  warnings.push("git bundle 生成失败：" + String(e.message || e).split("\n")[0]);
}

// ---------- 4. MANIFEST ----------
const total = dirSize(dest);
const manifest = [
  `book-skill-platform 备份`,
  `时间：${new Date().toLocaleString("zh-CN")}   总体积：${fmtSize(total)}`,
  ``,
  `包含文件：`,
  ...copied.map((c) => `  ${c.rel}  (${fmtSize(c.size)})`),
  ``,
  `git bundle：${bundleNote}`,
  `.models/ 未备份（可重下）；node_modules/ 未备份（npm install 重建）。`,
  ``,
  `恢复三步（详见 docs/恢复手册.md）：`,
  `  1. git clone repo.bundle 项目名   ← 从 repo.bundle 克隆全部代码`,
  `  2. cd 项目名 && npm install`,
  `  3. 把本目录的 *.db 拷进 项目名/library/（目录不存在就新建），跑 npm test 验收`,
  `     （迁过书库的用户：书库在自定义目录，用 BSP_LIB_DIR 指过去，别拷进项目 library/）`,
  `     （有 chat-archive/ 的话一并拷进书库目录——云端回答存档，P4；丢了大不了重问，`,
  `      但"当初引用了哪段原文"的快照补不回来）`,
  ``,
  `提醒：这份备份躺在项目目录里，等于没离开这台电脑。`,
  `请把整个 bsp-backup-* 文件夹拷到 U 盘 / 网盘，才算真备份。`,
  ``,
].join("\r\n");
fs.writeFileSync(path.join(dest, "MANIFEST.txt"), manifest, "utf8");

// ---------- 5. 清理旧备份（严格白名单，只删 backup/ 下匹配命名的目录） ----------
const old = fs.readdirSync(BACKUP_DIR)
  .filter((f) => NAME_RE.test(f) && f !== "bsp-backup-" + ts)
  .sort()
  .reverse();
const removed = [];
for (const name of old.slice(Math.max(0, KEEP - 1))) {
  const p = path.join(BACKUP_DIR, name);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    fs.rmSync(p, { recursive: true, force: true });
    removed.push(name);
  }
}

// ---------- 6. 汇总 ----------
const dbCount = copied.filter(c => /\.db(-wal)?$/.test(c.rel)).length;
if (dbCount === 0) {
  // 一个库文件都没有——代码 bundle 再全也是假备份，必须喊醒用户
  console.log(`⚠️ 备份完成，但没有任何书库文件！（书库目录：${LIB}）`);
  console.log(`   迁过书库就设 BSP_LIB_DIR 指向新目录重跑；否则这份备份只含代码与 git 历史。`);
} else {
  console.log(`✅ 备份完成：${path.relative(ROOT, dest)}`);
}
console.log(`   体积 ${fmtSize(total)} · ${copied.length} 个文件（含 ${dbCount} 个书库文件） · 保留 ${KEEP} 份${removed.length ? `（清理旧份：${removed.join("、")}）` : ""}`);
if (warnings.length) {
  console.log(`⚠️ 警告 ${warnings.length} 条：`);
  for (const w of warnings) console.log(`   - ${w}`);
}
console.log(`   下一步：把该文件夹拷到项目外（U 盘 / 网盘），才算真备份。`);
