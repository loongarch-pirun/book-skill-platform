// W1 用量治理测试：usage-policy 三级暴露闸机（开关 / 定时 / 预算三组）
// 覆盖：lib 单元（load/save/schedule/serviceStatus/budget/usage-log）+ MCP 集成（mock server 过 reg 闸机）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg + (cond || extra === undefined ? "" : ` | ${extra}`)); cond ? pass++ : fail++; };

const up = await import("../src/lib/usage-policy.mjs");
const { configureSearch, currentLibDir } = await import("../src/lib/search.mjs");
const { registerServerTools, TOOL_TIERS } = await import("../src/lib/register-tools.mjs");

// ---------- 夹具：tmp 空库目录（闸机读的是 libDir/usage-policy.json） ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-usage-"));
configureSearch({ libDir: tmp });
ok(currentLibDir() === tmp, "夹具: configureSearch 指向 tmp 空库目录");

// ---------- 1) 配置层：默认值 / 读写 / 深合并 ----------
{
  const dflt = up.loadUsagePolicy(tmp);
  ok(dflt.enabled === true && dflt.budget.perSessionChars === 200000
    && dflt.schedule.workdays[0] === "09:00-18:30", "默认策略：开 + 预算 20 万字符 + 工作日 9:00-18:30");
  up.saveUsagePolicy(tmp, { enabled: false });
  ok(up.loadUsagePolicy(tmp).enabled === false, "saveUsagePolicy 写 enabled=false 落盘可读回");
  up.saveUsagePolicy(tmp, { enabled: true, budget: { perSessionQueries: 5 } });
  const p = up.loadUsagePolicy(tmp);
  ok(p.budget.perSessionQueries === 5 && p.budget.perSessionChars === 200000,
    "深合并：只改的字段覆盖，未改的回退默认（半截配置不伤）");
  fs.rmSync(path.join(tmp, "usage-policy.json"), { force: true });
}

// ---------- 2) 定时窗口：inScheduleWindow（注入日期，确定性） ----------
{
  const p = up.loadUsagePolicy(tmp);  // 全默认
  const wed = (h, m) => new Date(2026, 9, 21, h, m);   // 2026-10-21 周三
  const sat = (h, m) => new Date(2026, 9, 24, h, m);   // 周六
  ok(up.inScheduleWindow(p, wed(9, 0)) === true, "周三 9:00 整在窗口内");
  ok(up.inScheduleWindow(p, wed(8, 59)) === false, "周三 8:59 在窗口外");
  ok(up.inScheduleWindow(p, wed(18, 29)) === true, "周三 18:29 在窗口内（右开区间尾）");
  ok(up.inScheduleWindow(p, wed(18, 30)) === false, "周三 18:30 整出窗口（右开）");
  ok(up.inScheduleWindow(p, sat(10, 0)) === false, "周六默认关（weekend=false）");
  const p2 = { ...p, schedule: { ...p.schedule, weekend: true } };
  ok(up.inScheduleWindow(p2, sat(10, 0)) === true, "weekend=true 时周六也开");
  const st = up.serviceStatus({ ...p, enabled: false }, wed(10, 0));
  ok(st.open === false && st.reason === "manual-off" && /手动关闭/.test(st.hint), "手动关：reason=manual-off 且 hint 说人话");
  const st2 = up.serviceStatus(p, sat(10, 0));
  ok(st2.open === false && st2.reason === "schedule-off" && /时间窗口/.test(st2.hint), "窗口外：reason=schedule-off 且 hint 说人话");
  const st3 = up.serviceStatus(p, wed(10, 0));
  ok(st3.open === true, "窗口内 + 开着 = 开放");
}

// ---------- 3) 预算：checkBudget / chargeUsage / 会话重置 ----------
// 注意 checkBudget 的检查次序：次数 → 总字符 → 单次字符。分开三组测，避免一个调用同时撞两道闸
{
  // 3a 总字符预算（perSessionChars）
  up.resetSessionUsage();
  up.saveUsagePolicy(tmp, { budget: { perSessionQueries: 10, perSessionChars: 1000, deepReadChars: 800 } });
  const pa = up.loadUsagePolicy(tmp);
  up.resetSessionUsage();
  ok(up.checkBudget(pa, "search").ok === true, "预算充足：search 放行");
  up.chargeUsage("search", 100);
  up.chargeUsage("deepRead", 400);
  up.chargeUsage("deepRead", 400);
  let r = up.checkBudget(pa, "deepRead", 300);
  ok(r.ok === false && r.reason === "chars-exhausted", "字符预算尽：deepRead 拒（800+300>1000）");
  r = up.checkBudget(pa, "deepRead", 100);
  ok(r.ok === true, "字符仍有头：800+100=900≤1000 放行");
  ok(up.sessionUsage().calls === 3, "sessionUsage 记账准确（3 次）");

  // 3b 单次字符上限（deepReadChars）——总预算放宽到 10 万，单独暴露单次闸
  up.saveUsagePolicy(tmp, { budget: { perSessionQueries: 10, perSessionChars: 100000, deepReadChars: 800 } });
  const pb = up.loadUsagePolicy(tmp);
  up.resetSessionUsage();
  r = up.checkBudget(pb, "deepRead", 5000);
  ok(r.ok === false && r.reason === "single-call-too-big", "单次超限：deepReadChars=800 拦 5000");
  r = up.checkBudget(pb, "deepRead", 700);
  ok(r.ok === true, "单次在限内：700≤800 放行");

  // 3c 次数预算（perSessionQueries）
  up.saveUsagePolicy(tmp, { budget: { perSessionQueries: 3 } });
  const pc = up.loadUsagePolicy(tmp);
  up.resetSessionUsage();
  up.chargeUsage("search", 0); up.chargeUsage("search", 0); up.chargeUsage("search", 0);
  r = up.checkBudget(pc, "search");
  ok(r.ok === false && r.reason === "queries-exhausted", "次数预算尽：第 4 次 search 拒（perSessionQueries=3）");

  up.resetSessionUsage();
  ok(up.sessionUsage().calls === 0 && up.sessionUsage().chars === 0, "resetSessionUsage 清零");
  fs.rmSync(path.join(tmp, "usage-policy.json"), { force: true });
}

// ---------- 4) 审计日志：recordUsage / todayUsage ----------
{
  fs.rmSync(path.join(tmp, "usage-log.jsonl"), { force: true });
  up.recordUsage(tmp, { tool: "query_book", tier: "search", chars: 1200, ok: true });
  up.recordUsage(tmp, { tool: "read_full_book", tier: "deepRead", chars: 30000, ok: true });
  up.recordUsage(tmp, { tool: "get_chapter", tier: "deepRead", chars: 0, ok: false, reason: "manual-off" });
  const t = up.todayUsage(tmp);
  ok(t.calls === 3 && t.chars === 31200 && t.rejected === 1
    && t.byTool.query_book === 1 && t.byTool.get_chapter === 1,
    "todayUsage 聚合：3 次 / 31200 字符 / 1 次拒收 / 按工具分布");
  const lines = fs.readFileSync(path.join(tmp, "usage-log.jsonl"), "utf8").trim().split("\n");
  ok(lines.length === 3 && JSON.parse(lines[0]).tool === "query_book" && !!JSON.parse(lines[0]).ts,
    "usage-log.jsonl 逐行 JSON 带 ts（追加写，旁路不阻断）");
}

// ---------- 5) MCP 集成：mock server 过闸机，三级行为 ----------
{
  const handlers = new Map();
  const mockServer = { registerTool: (name, spec, fn) => handlers.set(name, fn) };
  registerServerTools(mockServer);
  ok(handlers.size === 17, `17 工具全注册（闸机包装后数量不变，实际 ${handlers.size}）`);
  ok(TOOL_TIERS.list_books === "metadata" && TOOL_TIERS.query_book === "search"
    && TOOL_TIERS.read_full_book === "deepRead" && TOOL_TIERS.cite_check === "metadata",
    "TOOL_TIERS 分级：元数据/检索/深读三档映射正确（cite_check 恒开=安全工具不被预算拦）");

  up.resetSessionUsage();
  up.saveUsagePolicy(tmp, { enabled: false });
  const gated = JSON.parse((await handlers.get("query_book")({ book: "x", question: "q" })).content[0].text);
  ok(gated.error === "知识库对外服务未开放" && gated.reason === "manual-off" && !!gated.hint,
    "关闭态：search 拒收且带 hint（reason=manual-off）");
  const budgeted = JSON.parse((await handlers.get("read_full_book")({ book: "x" })).content[0].text);
  ok(budgeted.error === "知识库对外服务未开放" && budgeted.reason === "manual-off",
    "关闭态：deepRead 拒收");
  const meta = JSON.parse((await handlers.get("list_books")({})).content[0].text);
  ok(!meta.error && Array.isArray(meta), "关闭态：metadata 仍常开（list_books 不受影响）");
  const cc = JSON.parse((await handlers.get("cite_check")({ book: "x", quote: "q" })).content[0].text);
  ok(!cc.error || cc.error !== "知识库对外服务未开放", "关闭态：cite_check 恒开（防幻觉自检不被拦）");

  // 定时态：开着但不在窗口 → schedule-off 拒收（窗口置为空数组+周末关=任何时刻都窗外，确定性；
  // 2026-10-21 19:12 实测：只置 enabled:true 会被默认 9:00-18:30 窗口挡，断言假红）
  up.saveUsagePolicy(tmp, { enabled: true, schedule: { workdays: [], weekend: false } });
  const sched = JSON.parse((await handlers.get("query_book")({ book: "x", question: "q" })).content[0].text);
  ok(sched.error === "知识库对外服务未开放" && sched.reason === "schedule-off" && /usage-policy\.json/.test(sched.hint || ""),
    "定时态：窗口外拒收（reason=schedule-off，hint 指路改 schedule）");

  // 开启态：窗口全放开（0-24 全天+周末也开）后 search 放行——空库下走到业务层错误，不是闸机错误
  up.saveUsagePolicy(tmp, { enabled: true, schedule: { workdays: ["00:00-23:59"], weekend: true } });
  const opened = JSON.parse((await handlers.get("query_book")({ book: "x", question: "q" })).content[0].text);
  ok(opened.error !== "知识库对外服务未开放", "开启态：search 放行（空库下走到业务层错误，不是闸机错误）");
  const meta2 = await handlers.get("list_books")({});
  ok(!meta2.error, "开启态：metadata 正常返回");

  // 拒收也落审计
  up.saveUsagePolicy(tmp, { enabled: false });
  await handlers.get("query_library")({ question: "q" });
  const logLines = fs.readFileSync(path.join(tmp, "usage-log.jsonl"), "utf8").trim().split("\n")
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const rejects = logLines.filter(e => e.ok === false && e.reason === "manual-off");
  ok(rejects.length >= 3, `拒收落审计：manual-off 拒收记录 ≥3 条（实际 ${rejects.length}）`);

  fs.rmSync(path.join(tmp, "usage-policy.json"), { force: true });
  fs.rmSync(path.join(tmp, "usage-log.jsonl"), { force: true });
}

// ---------- 6) 桌面 engine 层：usagePolicyGet/Set（tmp 目录，不碰真库） ----------
{
  const engine = await import("../src/desktop/engine.mjs");
  const got = engine.usagePolicyGet();
  ok(got.policy && typeof got.policy.enabled === "boolean" && got.usage && got.session
    && typeof got.open === "boolean",
    "engine.usagePolicyGet：策略 + 当日用量 + 会话记账 + open 判定");
  const before = engine.usagePolicyGet().policy.enabled;
  engine.usagePolicySet({ enabled: !before });
  ok(engine.usagePolicyGet().policy.enabled === !before, "engine.usagePolicySet：写 enabled 生效（读回一致）");
  engine.usagePolicySet({ budget: { perSessionQueries: 7 } });
  const p = engine.usagePolicyGet().policy;
  ok(p.budget.perSessionQueries === 7 && p.budget.perSessionChars === 200000,
    "engine.usagePolicySet 深合并：改的覆盖、未改的回退默认");
  engine.usagePolicySet({ enabled: before });
}

// ---------- 清理 ----------
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmp 残留无害 */ }

console.log(`\n===== usage-gate-test：${pass} PASS / ${fail} FAIL =====`);
if (fail) process.exitCode = 1;
