// 主题系统（V4）：预设配色 + 强调色自选 + 跟随系统自动深浅。
// 原理：全部颜色走 CSS 变量（app.css :root），运行时只覆盖 documentElement 的变量值——零重排。
// 持久化：localStorage（渲染进程按 file:// origin 持久，重启仍在）；读写失败静默降级到默认。
export const STORE_KEY = "bsp.theme.v1";
export const DEFAULT_THEME = "deep-blue";
export const DEFAULT_ACCENT = "auto";

// 每套主题 13 个变量：4 底 + 3 线 + 3 字 + 强调 3（accent / accent-bg / accent-ink）
const THEMES = {
  "deep-blue": {
    name: "深蓝灰", desc: "默认 · 近黑带蓝调", dark: true,
    vars: {
      "--bg": "#0F1419", "--bg-card": "#161C24", "--bg-hover": "#1E2733", "--bg-input": "#131A21",
      "--line": "#243040", "--line-soft": "#1A2330", "--line-hi": "#33445C",
      "--ink": "#E6EDF3", "--ink-2": "#9BAAB8", "--ink-3": "#7D8B99",
    },
    accent: ["#38BDF8", "rgba(56,189,248,.12)", "#06121C"],
  },
  "warm-coal": {
    name: "暖炭灰", desc: "暖调 · 夜读灯下", dark: true,
    vars: {
      "--bg": "#17161A", "--bg-card": "#1F1D24", "--bg-hover": "#2A2730", "--bg-input": "#1A181E",
      "--line": "#2E2B35", "--line-soft": "#232028", "--line-hi": "#3D3947",
      "--ink": "#EDEAF2", "--ink-2": "#9A94A6", "--ink-3": "#7E7889",
    },
    accent: ["#F0A868", "rgba(240,168,104,.14)", "#1A1208"],
  },
  "ink-green": {
    name: "墨绿", desc: "护眼 · 有性格", dark: true,
    vars: {
      "--bg": "#0D1412", "--bg-card": "#141E1A", "--bg-hover": "#1B2A24", "--bg-input": "#101917",
      "--line": "#233029", "--line-soft": "#1A2622", "--line-hi": "#2F4239",
      "--ink": "#E4F0EA", "--ink-2": "#8CA398", "--ink-3": "#718A7E",
    },
    accent: ["#4ADE80", "rgba(74,222,128,.13)", "#04140A"],
  },
  "pure-black": {
    name: "纯黑", desc: "OLED · 最省电", dark: true,
    vars: {
      "--bg": "#000000", "--bg-card": "#0A0A0A", "--bg-hover": "#151515", "--bg-input": "#060606",
      "--line": "#1F1F1F", "--line-soft": "#151515", "--line-hi": "#303030",
      "--ink": "#F0F0F0", "--ink-2": "#9A9A9A", "--ink-3": "#7A7A7A",
    },
    accent: ["#4D9FFF", "rgba(77,159,255,.14)", "#03080F"],
  },
  "paper-light": {
    name: "浅色奶白", desc: "白天 · 一点不黑", dark: false,
    vars: {
      "--bg": "#FAFAF9", "--bg-card": "#FFFFFF", "--bg-hover": "#F1EFEC", "--bg-input": "#F7F6F4",
      "--line": "#E7E5E4", "--line-soft": "#F0EEEC", "--line-hi": "#D6D3D1",
      "--ink": "#1C1917", "--ink-2": "#78716C", "--ink-3": "#A8A29E",
    },
    accent: ["#2563EB", "rgba(37,99,235,.1)", "#FFFFFF"],
  },
};

// 强调色：auto = 跟随主题自带的；其余覆盖三件套
const ACCENTS = {
  auto: { name: "跟随主题" },
  sky: { name: "天蓝", vars: ["#38BDF8", "rgba(56,189,248,.12)", "#06121C"] },
  teal: { name: "青绿", vars: ["#2DD4BF", "rgba(45,212,191,.12)", "#04140F"] },
  green: { name: "薄荷", vars: ["#4ADE80", "rgba(74,222,128,.12)", "#04140A"] },
  amber: { name: "琥珀", vars: ["#F0A868", "rgba(240,168,104,.13)", "#1A1208"] },
  purple: { name: "紫罗兰", vars: ["#A78BFA", "rgba(167,139,250,.14)", "#0B0618"] },
  pink: { name: "樱粉", vars: ["#F472B6", "rgba(244,114,182,.14)", "#180612"] },
};

// 当前生效配置（内存态，供面板渲染）
let cur = { theme: DEFAULT_THEME, accent: DEFAULT_ACCENT, auto: false };

function readStore() {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || !THEMES[v.theme]) return null;
    return { theme: v.theme, accent: ACCENTS[v.accent] ? v.accent : DEFAULT_ACCENT, auto: !!v.auto };
  } catch { return null; }
}

function writeStore(v) {
  try { globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(v)); } catch { /* 隐私模式/无 storage：内存态照用 */ }
}

// 强调色按亮度选字色（浅底强调色配深墨字、深底配白字）——避免手写表漏项
function accentInk(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.55 ? "#0A1116" : "#FFFFFF";
}

function accentVars(accentId, themeId) {
  const a = ACCENTS[accentId]?.vars;
  if (a) return a;
  return THEMES[themeId]?.accent || ACCENTS.sky.vars;
}

// 应用一套配置：只写 CSS 变量（不碰 DOM 结构，零重排）
export function applyTheme(themeId, accentId, opts = {}) {
  const t = THEMES[themeId] ? themeId : DEFAULT_THEME;
  const theme = THEMES[t];
  const accent = accentId && ACCENTS[accentId] ? accentId : DEFAULT_ACCENT;
  const root = globalThis.document?.documentElement;
  if (!root?.style) return { theme: t, accent };
  for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
  const [a1, a2] = accentVars(accent, t);
  root.style.setProperty("--accent", a1);
  root.style.setProperty("--accent-bg", a2);
  root.style.setProperty("--accent-ink", accentInk(a1));
  root.dataset.theme = t;
  root.dataset.dark = theme.dark ? "1" : "0";
  // 浅色主题下 iframe 原书背景跟白，深色主题下也保持白（原件是文档，不该被主题染色）
  if (!opts.silent) cur = { theme: t, accent, auto: !!opts.auto };
  return cur;
}

// 自动模式：跟随系统深浅（系统深→deep-blue，系统浅→paper-light）
function systemTheme() {
  try {
    return globalThis.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "paper-light" : "deep-blue";
  } catch { return DEFAULT_THEME; }
}

export function resolveAuto() {
  return systemTheme();
}

// 初始化：读存档 → 应用；开启 auto 时跟随系统并监听变化
export function initTheme() {
  const saved = readStore();
  if (saved && saved.auto) {
    cur = { theme: resolveAuto(), accent: saved.accent, auto: true };
    applyTheme(cur.theme, cur.accent, { auto: true });
  } else if (saved) {
    cur = { theme: saved.theme, accent: saved.accent, auto: false };
    applyTheme(cur.theme, cur.accent);
  } else {
    applyTheme(DEFAULT_THEME, DEFAULT_ACCENT);
  }
  try {
    const mq = globalThis.matchMedia?.("(prefers-color-scheme: light)");
    mq?.addEventListener?.("change", () => {
      if (!cur.auto) return;
      cur.theme = resolveAuto();
      applyTheme(cur.theme, cur.accent, { auto: true });
      refreshPanel();
    });
  } catch { /* 老 Electron 无 mql.addEventListener：不监听也照用当前系统态 */ }
  return cur;
}

// 用户操作入口（面板调用）：setTheme / setAccent / setAuto / reset / 全部写存档
export function setTheme(id) {
  const t = THEMES[id] ? id : DEFAULT_THEME;
  cur = { theme: t, accent: cur.accent, auto: false };
  applyTheme(t, cur.accent);
  writeStore(cur);
  refreshPanel();
  return cur;
}

export function setAccent(id) {
  const a = ACCENTS[id] ? id : DEFAULT_ACCENT;
  cur = { ...cur, accent: a };
  applyTheme(cur.theme, a, { auto: cur.auto });
  writeStore(cur);
  refreshPanel();
  return cur;
}

export function setAuto(on) {
  cur = { theme: on ? resolveAuto() : cur.theme, accent: cur.accent, auto: !!on };
  applyTheme(cur.theme, cur.accent, { auto: cur.auto });
  writeStore(cur);
  refreshPanel();
  return cur;
}

export function resetTheme() {
  cur = { theme: DEFAULT_THEME, accent: DEFAULT_ACCENT, auto: false };
  applyTheme(cur.theme, cur.accent);
  try { globalThis.localStorage?.removeItem(STORE_KEY); } catch { /* 忽略 */ }
  refreshPanel();
  return cur;
}

export function currentTheme() { return { ...cur }; }
export function themeList() { return Object.entries(THEMES).map(([id, t]) => ({ id, name: t.name, desc: t.desc, dark: t.dark, accent: t.accent[0], bg: t.vars["--bg"], card: t.vars["--bg-card"], ink: t.vars["--ink"] })); }
export function accentList() { return Object.entries(ACCENTS).map(([id, a]) => ({ id, name: a.name, color: a.vars ? a.vars[0] : null })); }

// 面板重绘（app.js 里提供渲染函数；未注册时静默跳过）
let painter = null;
export function registerPanelPainter(fn) { painter = fn; }
function refreshPanel() { try { painter?.(); } catch { /* 面板重绘失败不影响主题生效 */ } }
