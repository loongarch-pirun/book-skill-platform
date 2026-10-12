// skill 开关状态：存 <libDir>/skill-state.json（H3 决策——与 MCP 纯 Node 共享同一份，
// 而不是 userData/config.json：MCP 进程不经过 Electron，读不到 userData）
// 无文件 = 全部开启：stage3 的六本断言、CLI 用户都不受伤
import fs from "node:fs";
import path from "node:path";

export function skillStatePath(libDir) {
  return path.join(libDir, "skill-state.json");
}

// 读整份状态：{ [bookId]: false }——只记"关"的，缺省和 true 都算开
export function loadSkillState(libDir) {
  try {
    const st = JSON.parse(fs.readFileSync(skillStatePath(libDir), "utf8"));
    return st && typeof st === "object" ? st : {};
  } catch { return {}; }
}

// 单本书是否开启（无状态文件/无记录都算开）
export function isSkillEnabled(libDir, bookId) {
  return loadSkillState(libDir)[bookId] !== false;
}

// 设开关：enabled=true 删记录（保持文件精简），false 记 false；返回整份状态
export function setSkillEnabled(libDir, bookId, enabled) {
  const st = loadSkillState(libDir);
  if (enabled) delete st[bookId]; else st[bookId] = false;
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(skillStatePath(libDir), JSON.stringify(st, null, 2), "utf8");
  return st;
}
