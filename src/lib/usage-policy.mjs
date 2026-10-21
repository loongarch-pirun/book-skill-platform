// 知识库对外服务用量治理：存 <libDir>/usage-policy.json（H3 决策——与 skill-state.json
// 同目录同模式：MCP 纯 Node 进程不经过 Electron，读不到 userData）
// 三级暴露：metadata 常开 / search 受开关+定时门控（计次）/ deepRead 门控+按字符扣预算
// 铁律对齐 lib 层：失败 return {ok:false, error, hint}，不许 throw 穿层
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_POLICY = {
  enabled: true,
  schedule: { workdays: ["09:00-18:30"], weekend: false, timezone: "Asia/Shanghai" },
  budget: { perSessionChars: 200000, perSessionQueries: 30, deepReadChars: 80000 },
};

export function usagePolicyPath(libDir) {
  return path.join(libDir, "usage-policy.json");
}

// 读整份策略：磁盘文件覆盖默认值（深合并，缺字段回退默认——旧文件/半截文件不伤）
export function loadUsagePolicy(libDir) {
  let disk = {};
  try {
    disk = JSON.parse(fs.readFileSync(usagePolicyPath(libDir), "utf8"));
    if (!disk || typeof disk !== "object") disk = {};
  } catch { /* 无文件/坏 JSON：全默认 */ }
  return {
    enabled: typeof disk.enabled === "boolean" ? disk.enabled : DEFAULT_POLICY.enabled,
    schedule: { ...DEFAULT_POLICY.schedule, ...(disk.schedule || {}) },
    budget: { ...DEFAULT_POLICY.budget, ...(disk.budget || {}) },
  };
}

// 写整份策略（桌面开关与配置修改都走这里）；返回落盘的整份
export function saveUsagePolicy(libDir, patch = {}) {
  const cur = loadUsagePolicy(libDir);
  const next = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled,
    schedule: { ...cur.schedule, ...(patch.schedule || {}) },
    budget: { ...cur.budget, ...(patch.budget || {}) },
  };
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(usagePolicyPath(libDir), JSON.stringify(next, null, 2), "utf8");
  return next;
}

// 「HH:MM」→ 分钟数；非法返回 null
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// 判断 now（默认本机时间）是否落在允许窗口内：
// 周末看 weekend 布尔；工作日看 workdays 区间数组，任一区间命中即开
export function inScheduleWindow(policy, now = new Date()) {
  const sch = policy?.schedule || {};
  const day = now.getDay();  // 0=周日 6=周六
  const isWeekend = day === 0 || day === 6;
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (isWeekend) return sch.weekend === true;
  const ranges = Array.isArray(sch.workdays) ? sch.workdays : [];
  return ranges.some(r => {
    const [a, b] = String(r).split("-");
    const s = toMinutes(a), e = toMinutes(b);
    if (s === null || e === null) return false;
    return minutes >= s && minutes < e;  // 18:30 窗口 = 到 18:29:59 止
  });
}

// 服务当前是否对检索/深读开放：{open, reason}
// reason 供 hint 用：关闭态说清是手动关还是不在窗口
export function serviceStatus(policy, now = new Date()) {
  if (!policy.enabled)
    return { open: false, reason: "manual-off", hint: "知识库对外服务当前是手动关闭状态。需要时请在桌面端书架页打开「知识库对外服务」开关，或修改 usage-policy.json 的 enabled。" };
  if (!inScheduleWindow(policy, now))
    return { open: false, reason: "schedule-off", hint: "知识库对外服务当前不在允许的时间窗口内（默认工作日 9:00-18:30，周末关闭）。急用可联系主人修改 library/usage-policy.json 的 schedule 字段放宽时间窗。" };
  return { open: true };
}

// ---------- 会话预算（进程内记账；MCP server 进程寿命 = 一个智能体会话） ----------
// 桌面长进程同一份计数器——重启清零，属预期（会话语义）
const session = { calls: 0, chars: 0 };

export function sessionUsage() {
  return { ...session };
}

export function resetSessionUsage() {
  session.calls = 0;
  session.chars = 0;
}

// 调用前检查：tier=search 计次；tier=deepRead 计次+预估字符。
// 返回 {ok:true} 或 {ok:false, error, hint, reason}
export function checkBudget(policy, tier, estChars = 0) {
  const b = policy?.budget || {};
  if (session.calls + 1 > (b.perSessionQueries ?? 30))
    return { ok: false, reason: "queries-exhausted", error: `本会话检索/深读调用次数已用尽（上限 ${b.perSessionQueries} 次）`, hint: "这是防 token 失控的会话配额。新开一个智能体会话即可重置；或调大 usage-policy.json 的 budget.perSessionQueries。" };
  if (tier === "deepRead" && session.chars + estChars > (b.perSessionChars ?? 200000))
    return { ok: false, reason: "chars-exhausted", error: `本会话深读字符预算即将超限（已用 ${session.chars}，上限 ${b.perSessionChars}）`, hint: "深读是 token 大头，已达会话预算上限。请改用检索类工具定位小范围内容，或新开会话。" };
  if (tier === "deepRead" && estChars > (b.deepReadChars ?? 80000))
    return { ok: false, reason: "single-call-too-big", error: `单次深读预估 ${estChars} 字符，超过单次上限 ${b.deepReadChars}`, hint: "请缩小读取范围（换更小的章节或用 read_range 按块号区间读），或调大 budget.deepReadChars。" };
  return { ok: true };
}

// 调用后记账
export function chargeUsage(tier, chars) {
  session.calls += 1;
  if (tier === "deepRead") session.chars += chars;
}

// ---------- 审计日志（usage-log.jsonl，追加写；与 feedback-export 并列的导出位） ----------
export function usageLogPath(libDir) {
  return path.join(libDir, "usage-log.jsonl");
}

// 落一行：{ts, tool, tier, chars, ok, reason?}
export function recordUsage(libDir, entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  try {
    fs.mkdirSync(libDir, { recursive: true });
    fs.appendFileSync(usageLogPath(libDir), line, "utf8");
  } catch { /* 日志写失败不阻断调用（审计是旁路，不是门禁） */ }
}

// 当日用量汇总（桌面用量条数据源）：按本机日期聚合 usage-log
export function todayUsage(libDir, now = new Date()) {
  const dayStr = now.toISOString().slice(0, 10);
  const out = { date: dayStr, calls: 0, chars: 0, rejected: 0, byTool: {} };
  try {
    const lines = fs.readFileSync(usageLogPath(libDir), "utf8").split("\n");
    for (const ln of lines) {
      if (!ln) continue;
      let e; try { e = JSON.parse(ln); } catch { continue; }
      if (!e.ts || e.ts.slice(0, 10) !== dayStr) continue;
      out.calls += 1;
      out.chars += e.chars || 0;
      if (e.ok === false) out.rejected += 1;
      out.byTool[e.tool] = (out.byTool[e.tool] || 0) + 1;
    }
  } catch { /* 无日志文件：全 0 */ }
  return out;
}
