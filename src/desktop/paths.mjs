// 桌面端数据目录解析：三层，单一来源
//   1. 环境变量层：BSP_LIB_DIR / BSP_SKILLS_DIR / BSP_MODELS_DIR（CLI 与桌面共享，M2）
//   2. 配置层：userData/config.json（仅打包态；首次启动向导写入，之后 config:set 可改）
//   3. 默认层：未打包 = 项目根（npm test 逐字节不变）；打包 = userData
// 本模块被主进程（CJS 动态 import）调用；解析结果由 engine.mjs 注入三个 lib，
// 并写回 process.env 让 spawn 的子进程（embed-book.js 等）继承同一份解析（M2）。
import fs from "node:fs";
import path from "node:path";

// 项目根：本文件位于 src/desktop/，往上两级
export const PROJECT_ROOT = path.join(import.meta.dirname, "..", "..");

// 读打包态配置；读不到/解析失败都按缺失处理（首启向导的触发条件就是"没有配置"）
function loadConfig(userData) {
  if (!userData) return {};
  try {
    return JSON.parse(fs.readFileSync(path.join(userData, "config.json"), "utf8")) || {};
  } catch { return {}; }
}

// 持久化目录配置（config:set IPC 调它）；返回合并后的完整配置
export function writeConfig(userData, patch) {
  if (!userData) throw new Error("writeConfig: 缺少 userData（未打包态没有配置层）");
  const cfg = { ...loadConfig(userData), ...patch };
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify(cfg, null, 2), "utf8");
  return cfg;
}

// hasConfig：是否已有配置（首启向导判据——打包态无配置才走向导）
export function hasConfig(userData) {
  return !!userData && fs.existsSync(path.join(userData, "config.json"));
}

// 解析三个数据目录。packaged=false 时 userData 可省略（走项目根默认层，dev/test 用）
export function resolveDirs({ packaged = false, userData = null } = {}) {
  const base = packaged && userData ? userData : PROJECT_ROOT;
  const cfg = packaged ? loadConfig(userData) : {};
  return {
    projectRoot: PROJECT_ROOT,
    packaged,
    userData: userData || null,
    libDir: process.env.BSP_LIB_DIR || cfg.libraryDir || path.join(base, "library"),
    skillsDir: process.env.BSP_SKILLS_DIR || cfg.skillsDir || path.join(base, "skills"),
    modelsDir: process.env.BSP_MODELS_DIR || cfg.modelsDir || path.join(base, ".models"),
  };
}
