// paths/skill-state 单元测试：三层目录解析（打包态=userData）+ skill 开关过滤（H3）
// 为什么单测：paths.mjs 与 skill-state 是桌面端地基，listBooks 过滤是回归高发区
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDirs, writeConfig, PROJECT_ROOT } from "../src/desktop/paths.mjs";
import { listBooks, currentLibDir, configureSearch } from "../src/lib/search.mjs";
import { setSkillEnabled, loadSkillState } from "../src/lib/skill-state.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} - ${msg}`);
  cond ? pass++ : fail++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-paths-"));

// 1) 未打包 = 项目根（npm test 逐字节不变的地基）
const dev = resolveDirs({ packaged: false });
ok(dev.libDir === path.join(PROJECT_ROOT, "library"), "未打包: libDir=项目根/library");
ok(dev.skillsDir === path.join(PROJECT_ROOT, "skills"), "未打包: skillsDir=项目根/skills");
ok(dev.modelsDir === path.join(PROJECT_ROOT, ".models"), "未打包: modelsDir=项目根/.models");

// 2) 打包态 = userData 默认
const pkg = resolveDirs({ packaged: true, userData: tmp });
ok(pkg.libDir === path.join(tmp, "library"), "打包态: libDir=userData/library");
ok(pkg.skillsDir === path.join(tmp, "skills"), "打包态: skillsDir=userData/skills");
ok(pkg.modelsDir === path.join(tmp, ".models"), "打包态: modelsDir=userData/.models");

// 3) 配置层覆盖默认（writeConfig 往返）
writeConfig(tmp, { libraryDir: path.join(tmp, "mylib"), skillsDir: path.join(tmp, "myskills") });
const pkg2 = resolveDirs({ packaged: true, userData: tmp });
ok(pkg2.libDir === path.join(tmp, "mylib"), "配置层: libraryDir 覆盖默认");
ok(pkg2.skillsDir === path.join(tmp, "myskills"), "配置层: skillsDir 覆盖默认");
ok(pkg2.modelsDir === path.join(tmp, ".models"), "配置层: 未配的 modelsDir 仍走默认");

// 4) 环境变量压过配置层（M2 的优先级）
const OLD = process.env.BSP_LIB_DIR;
process.env.BSP_LIB_DIR = path.join(tmp, "envlib");
ok(resolveDirs({ packaged: true, userData: tmp }).libDir === path.join(tmp, "envlib"), "环境变量层: BSP_LIB_DIR 压过配置层");
if (OLD === undefined) delete process.env.BSP_LIB_DIR; else process.env.BSP_LIB_DIR = OLD;

// 5) skill-state 过滤（H3）：无文件不过滤 / 关掉过滤 / 豁免 / 重开恢复
const libDir = path.join(tmp, "statelib");
fs.mkdirSync(libDir, { recursive: true });
fs.copyFileSync(path.join(PROJECT_ROOT, "library", "daodejing-zh.docx.db"), path.join(libDir, "daodejing-zh.docx.db"));
ok(listBooks(libDir).length === 1, "skill-state: 无状态文件时全返回（stage3 六本断言不受伤）");
setSkillEnabled(libDir, "daodejing-zh.docx", false);
ok(listBooks(libDir).length === 0, "skill-state: 关掉的书被 listBooks 过滤（H3 桌面/MCP 路径）");
ok(listBooks(libDir, { includeDisabled: true }).length === 1, "skill-state: includeDisabled:true 豁免（引用回源验证路径）");
setSkillEnabled(libDir, "daodejing-zh.docx", true);
ok(listBooks(libDir).length === 1 && Object.keys(loadSkillState(libDir)).length === 0, "skill-state: 重开=删记录，文件精简");

// 6) configureSearch 注入 + currentLibDir 读取
configureSearch({ libDir });
ok(currentLibDir() === libDir, "configureSearch: 注入后 currentLibDir 生效");
configureSearch({}); // 空注入不改变现状（防呆）
ok(currentLibDir() === libDir, "configureSearch: 空注入不清空（防呆）");

// 7) 未打包态无配置层：writeConfig 缺 userData 应报错
let threw = false;
try { writeConfig(null, { libraryDir: "/x" }); } catch { threw = true; }
ok(threw, "writeConfig: 缺 userData 抛错（未打包态没有配置层）");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`===== paths-test: ${pass} PASS / ${fail} FAIL =====`);
process.exit(fail ? 1 : 0);
