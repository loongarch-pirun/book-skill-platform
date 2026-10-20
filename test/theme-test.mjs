// 主题系统测试：变量完整性 / 强调色覆盖 / 字色亮度自适应 / 持久化 / 自动模式 / 非法值回退。
// 纯逻辑测试——mock documentElement.style 与 localStorage，不依赖真浏览器。
import fs from "node:fs";
import path from "node:path";

let failed = 0;
const assert = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (!cond) failed++; };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), msg + (JSON.stringify(a) === JSON.stringify(b) ? "" : `（got ${JSON.stringify(a)} want ${JSON.stringify(b)}）`));

// ---- mock 浏览器三件套（必须在 import theme.js 之前就位：模块顶层不碰 DOM，但保险） ----
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const vars = new Map();
globalThis.document = { documentElement: { style: { setProperty: (k, v) => vars.set(k, v) }, dataset: {} } };
let lightMatches = false;
globalThis.matchMedia = () => ({ matches: lightMatches, addEventListener() {} });

const {
  STORE_KEY, DEFAULT_THEME, themeList, accentList, applyTheme, initTheme,
  setTheme, setAccent, setAuto, resetTheme, currentTheme, resolveAuto,
} = await import("../src/renderer/theme.js");

// ---------- 1. 清单完整性 ----------
const themes = themeList();
const accents = accentList();
eq(themes.length, 5, "五套预设主题（深蓝灰/暖炭灰/墨绿/纯黑/浅色奶白）");
eq(accents.length, 7, "强调色 7 项（auto + 6 色）");
assert(themes.every((t) => t.id && t.name && t.bg && t.card && t.ink && t.accent), "每套主题带 id/名称/预览色");
assert(themes.filter((t) => t.dark).length === 4 && themes.filter((t) => !t.dark).length === 1, "四深一浅（dark 标记正确）");

// ---------- 2. 变量完整性：10 个基础变量 + 强调三件套，每套都不缺 ----------
const NEED = ["--bg", "--bg-card", "--bg-hover", "--bg-input", "--line", "--line-soft", "--line-hi", "--ink", "--ink-2", "--ink-3"];
for (const t of themes) {
  vars.clear();
  applyTheme(t.id, "auto");
  const missing = NEED.filter((k) => !vars.has(k));
  assert(missing.length === 0, `主题 ${t.id} 十变量齐（缺：${missing.join(",") || "无"}）`);
  assert(vars.get("--accent") && vars.get("--accent-bg") && vars.get("--accent-ink"), `主题 ${t.id} 强调三件套齐`);
  assert(globalThis.document.documentElement.dataset.theme === t.id, `主题 ${t.id} dataset.theme 落位`);
}

// ---------- 3. 强调色覆盖 ----------
vars.clear();
applyTheme("deep-blue", "purple");
eq(vars.get("--accent"), "#A78BFA", "强调色覆盖为紫罗兰");
eq(vars.get("--accent-ink"), "#0A1116", "浅底强调色配深字（亮度自适应）");
vars.clear();
applyTheme("paper-light", "auto");
eq(vars.get("--accent"), "#2563EB", "auto 跟随主题（浅色主题的深蓝）");
eq(vars.get("--accent-ink"), "#FFFFFF", "深底强调色配白字（亮度自适应）");

// ---------- 4. 持久化：写存档 → 重新 init 读回 ----------
store.clear();
setTheme("ink-green");
setAccent("amber");
const saved = JSON.parse(store.get(STORE_KEY));
eq(saved.theme, "ink-green", "存档写入主题");
eq(saved.accent, "amber", "存档写入强调色");
store.set(STORE_KEY, JSON.stringify({ theme: "warm-coal", accent: "teal", auto: false }));
initTheme();
eq(currentTheme(), { theme: "warm-coal", accent: "teal", auto: false }, "重启后从存档恢复（暖炭 + 青绿）");

// ---------- 5. 自动模式：跟随系统深浅 ----------
lightMatches = false;
store.set(STORE_KEY, JSON.stringify({ theme: "deep-blue", accent: "auto", auto: true }));
initTheme();
eq(currentTheme().theme, "deep-blue", "自动模式 · 系统深色 → 深蓝灰");
lightMatches = true;
eq(resolveAuto(), "paper-light", "自动模式 · 系统浅色 → 浅色奶白");
initTheme();
eq(currentTheme().theme, "paper-light", "自动模式 · 系统浅色时 init 落浅色奶白");
lightMatches = false;

// ---------- 5b. 自动模式开关（面板勾选走 setAuto 这个真实入口） ----------
store.clear();
setTheme("deep-blue");
lightMatches = true;
setAuto(true);
eq(currentTheme().auto, true, "setAuto(true) 打开跟随系统");
eq(currentTheme().theme, "paper-light", "setAuto(true) 且系统浅色 → 立即切浅色奶白");
eq(JSON.parse(store.get(STORE_KEY)).auto, true, "自动开关写入存档");
setAuto(false);
eq(currentTheme().auto, false, "setAuto(false) 关掉跟随系统");
lightMatches = false;

// ---------- 6. 非法值回退 + 恢复默认 ----------
setTheme("不存在的主题");
eq(currentTheme().theme, DEFAULT_THEME, "非法主题 id 回退默认");
setAccent("不存在的颜色");
eq(currentTheme().accent, "auto", "非法强调色回退 auto");
store.set(STORE_KEY, "{坏 JSON");
initTheme();
eq(currentTheme().theme, DEFAULT_THEME, "存档损坏回退默认（不崩）");
setTheme("pure-black");
resetTheme();
eq(currentTheme().theme, DEFAULT_THEME, "恢复默认");
assert(!store.has(STORE_KEY), "恢复默认清掉存档");

// ---------- 7. 无 localStorage / 无 style 时静默降级（隐私模式/测试桩） ----------
delete globalThis.localStorage;
delete globalThis.document;
let boom = null;
try { initTheme(); setTheme("ink-green"); } catch (e) { boom = e; }
assert(!boom, "无 localStorage/document 时不抛错（静默降级）");

// ---------- 8. app.css 契约 ----------
const css = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "renderer", "app.css"), "utf8");
assert(css.includes("--accent-ink"), "app.css 定义 --accent-ink（强调色底上的字色）");
// #06121C 只允许出现在 :root 的 --accent-ink 定义里；#182029（旧 hover 硬编码）必须清零
const oldInkHits = (css.match(/#06121C/g) || []).length;
assert(oldInkHits === 1 && !css.includes("#182029"),
  "app.css 无残留硬编码主题色（#06121C 仅变量定义 1 处、旧 hover 色已清零）");
assert(!/box-shadow/.test(css), "app.css 零 box-shadow（深色/浅色都不靠阴影）");

console.log(`\n===== theme-test: ${failed === 0 ? "全部通过" : failed + " 项 FAIL"} =====`);
process.exit(failed ? 1 : 0);
