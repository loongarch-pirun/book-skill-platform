#!/usr/bin/env node
/**
 * install-verify.mjs —— 安装结果对账（阶段 3 专用）。
 *
 * 为什么有它：2026-11-16 的 0.1.1 安装器在 CopyFiles 阶段整树中断，
 * 尾部 356 个文件没复制、卸载器与注册表项也没写。packaged-verify 只看
 * win-unpacked，release-check 只看 exe 字节，两套都发现不了。这道对账补的就是这个盲区。
 *
 * 8 项：
 *   ① 文件数对账：INSTDIR 必须覆盖包内基线，缺失数 = 0
 *   ② 尾部子树：安装中断时最先丢的那批目录必须存在
 *   ③ skills：7 个技能包 / 35 个文件
 *   ④ 卸载器：Uninstall*.exe 存在且 > 50KB
 *   ⑤ 注册表：HKCU 卸载项存在、版本对、指向 INSTDIR
 *   ⑥ 书库：resources/library/*.db 恰 13 个
 *   ⑦ book_summary：13/13 有值
 *   ⑧ 启动冒烟（--smoke 才跑）：起 exe 20s，doclib 无 ModuleNotFoundError
 *
 * 用法：node tools/install-verify.mjs [--smoke] [--json]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const WANT_JSON = process.argv.includes("--json");
const WANT_SMOKE = process.argv.includes("--smoke");

const INSTDIR = path.join(process.env.LOCALAPPDATA || "", "Programs", "book-skill-platform");
const UNPACKED = path.join(ROOT, "release", "win-unpacked", "resources");

// 只在 win-unpacked 有、不在 NSIS 包内的 9 个文件（gradio 视频走 customFiles；arm64 exe 被 filter 排除）
const PACK_ONLY_EXCLUDE = new Set([
  "a.mp4", "b.avi", "b.mp4", "muted_b.mp4", "world.mp4",
  "t64-arm.exe", "w64-arm.exe", "cli-arm64.exe", "gui-arm64.exe",
]);

// 安装中断时最先丢的尾部子树（2026-11-16 实测缺口）
const TAIL_DIRS = [
  "runtime/mineru-python/Lib/urllib",
  "runtime/mineru-python/Lib/zipfile",
  "runtime/mineru-python/Lib/xml",
  "runtime/mineru-python/Lib/zoneinfo",
  "runtime/mineru-python/Lib/tkinter",
  "runtime/mineru-python/Lib/site-packages/yaml",
  "runtime/mineru-python/Lib/site-packages/wcwidth",
  "runtime/mineru-python/Lib/site-packages/xlsxwriter",
  "runtime/mineru-python/Lib/site-packages/ziamath",
  "runtime/mineru-python/Lib/site-packages/ziafont",
  "runtime/mineru-python/Lib/site-packages/uvicorn",
];

const SKILL_NAMES = [
  "book-intake", "citation-check", "engineering-research", "humanities-reading",
  "kb-research", "opinion-archaeology", "skill-authoring",
];

let failed = 0;
const assert = (cond, msg, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} - ${msg}${cond ? "" : ` ${extra}`}`);
  if (!cond) failed++;
};

function walk(dir, base = dir, out = new Map()) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.set(path.relative(base, p).replace(/\\/g, "/"), fs.statSync(p).size);
  }
  return out;
}

function pickBaseline() {
  // 优先 NSIS 临时解压目录（就是安装用的那份），否则 win-unpacked 减 9 个
  const tmp = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp") : "";
  const candidates = [];
  if (tmp && fs.existsSync(tmp)) {
    for (const d of fs.readdirSync(tmp)) {
      if (!/^ns.*\.tmp$/i.test(d)) continue;
      const p = path.join(tmp, d, "7z-out", "resources");
      if (fs.existsSync(p)) candidates.push(p);
    }
  }
  const picked = candidates
    .map((p) => ({ p, n: walk(p).size }))
    .sort((a, b) => b.n - a.n)[0];
  if (picked) return { dir: picked.p, kind: "7z-out", count: picked.n };
  if (!fs.existsSync(UNPACKED)) return null;
  const all = walk(UNPACKED);
  const kept = new Map([...all].filter(([rel]) => !PACK_ONLY_EXCLUDE.has(path.basename(rel))));
  return { dir: UNPACKED, kind: "win-unpacked(-9)", count: kept.size, files: kept };
}

if (!fs.existsSync(INSTDIR)) {
  console.log(`FAIL - 找不到安装目录 ${INSTDIR}（先装 0.1.2）`);
  process.exit(1);
}

const installed = walk(INSTDIR);
const base = pickBaseline();
if (!base) {
  console.log("FAIL - 找不到对账基线（release/win-unpacked 不存在，也没有 ns*.tmp/7z-out）");
  process.exit(1);
}
const baseline = base.files || walk(base.dir);

// ① 文件数对账（允许安装目录多出运行时产物，但不许少）
const missing = [...baseline.keys()].filter((rel) => !installed.has(rel));
assert(missing.length === 0,
  `① 文件数对账：${installed.size} 装 / ${baseline.size} 基线（${base.kind}），缺失 ${missing.length}`,
  missing.length ? `\n     例：${missing.slice(0, 5).join("\n     例：")}` : "");

// ② 尾部子树
const lostDirs = TAIL_DIRS.filter((d) => !fs.existsSync(path.join(INSTDIR, "resources", d)));
assert(lostDirs.length === 0, `② 尾部子树：${TAIL_DIRS.length - lostDirs.length}/${TAIL_DIRS.length} 在位`,
  lostDirs.length ? `缺：${lostDirs.join(", ")}` : "");

// ③ skills
const skillsDir = path.join(INSTDIR, "resources", "skills");
const skillDirs = fs.existsSync(skillsDir)
  ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : [];
const skillFiles = skillsDir && fs.existsSync(skillsDir)
  ? skillDirs.reduce((n, d) => n + walk(path.join(skillsDir, d)).size, 0) : 0;
assert(SKILL_NAMES.every((n) => skillDirs.includes(n)) && skillFiles >= 35,
  `③ skills：${skillDirs.length} 目录 / ${skillFiles} 文件`,
  `期望 ${SKILL_NAMES.length} 目录 / ≥35 文件`);

// ④ 卸载器
const rootEntries = fs.readdirSync(INSTDIR);
const uninstaller = rootEntries.find((f) => /^Uninstall.*\.exe$/i.test(f));
const uninstallerSize = uninstaller ? fs.statSync(path.join(INSTDIR, uninstaller)).size : 0;
assert(!!uninstaller && uninstallerSize > 50 * 1024,
  `④ 卸载器：${uninstaller || "缺失"}（${uninstallerSize} B）`);

// ⑤ 注册表
let regOk, regVersion = "", regUninst = "";
try {
  const out = execFileSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "/s", "/f", "BookSkill"],
    { encoding: "latin1", stdio: ["ignore", "pipe", "ignore"] });
  regVersion = (out.match(/DisplayVersion\s+REG_SZ\s+(\S+)/) || [])[1] || "";
  regUninst = (out.match(/UninstallString\s+REG_SZ\s+(.+)/) || [])[1]?.trim() || "";
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  regOk = regVersion === pkg.version && regUninst.toLowerCase().includes(INSTDIR.toLowerCase());
} catch {
  regOk = false;
}
assert(regOk, `⑤ 注册表：displayVersion=${regVersion || "无"}，uninstall=${regUninst || "无"}`);

// ⑥ 书库
const libDir = path.join(INSTDIR, "resources", "library");
const dbs = fs.existsSync(libDir) ? fs.readdirSync(libDir).filter((f) => f.endsWith(".db")) : [];
assert(dbs.length === 13, `⑥ 书库：${dbs.length} 个 .db（期望 13）`);

// ⑦ book_summary
let withSummary = 0;
try {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3");
  for (const f of dbs) {
    const db = new Database(path.join(libDir, f), { readonly: true });
    const r = db.prepare("SELECT value FROM meta WHERE key=?").get("book_summary");
    if (r && r.value) withSummary++;
    db.close();
  }
} catch (e) {
  console.log(`   （book_summary 检查跳过：${e.message}）`);
}
assert(withSummary === 13, `⑦ book_summary：${withSummary}/13 有值`);

// ⑧ 启动冒烟（可选）
if (WANT_SMOKE) {
  const exe = path.join(INSTDIR, "BookSkillPlatform.exe");
  const stderrLog = path.join(process.env.APPDATA || "", "book-skill-platform", "mineru-run", "doclib.stderr.log");
  const before = fs.existsSync(stderrLog) ? fs.statSync(stderrLog).mtimeMs : 0;
  try {
    execFileSync("powershell", ["-NoProfile", "-Command",
      `$p=Start-Process '${exe.replace(/'/g, "''")}' -PassThru; Start-Sleep 20; Stop-Process -Id $p.Id -Force`],
      { stdio: "ignore", timeout: 45000 });
  } catch { /* 超时/kill 都算跑过 */ }
  const text = fs.existsSync(stderrLog) && fs.statSync(stderrLog).mtimeMs > before
    ? fs.readFileSync(stderrLog, "utf8") : "";
  const bad = /ModuleNotFoundError/.test(text);
  assert(!bad, `⑧ 启动冒烟：20s 内 ${bad ? "出现 ModuleNotFoundError" : "无模块缺失"}`, bad ? text.slice(0, 200) : "");
} else {
  console.log("SKIP - ⑧ 启动冒烟（加 --smoke 才跑）");
}

const ok = failed === 0;
if (WANT_JSON) {
  console.log(JSON.stringify({ ok, instdir: INSTDIR, baseline: base.kind, baselineCount: baseline.size, installedCount: installed.size, missing: missing.length, failed }, null, 2));
} else {
  console.log(`\n===== 安装对账：${ok ? "全部 PASS" : `${failed} 项 FAIL`} =====`);
}
process.exit(ok ? 0 : 1);
