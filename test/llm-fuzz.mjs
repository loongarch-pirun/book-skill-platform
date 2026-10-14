// 终期暴力测试 P0：生成层防幻觉爆破（V2 融合轮）。
// 攻击面：src/lib/llm.mjs——parseAnswer 宽容解析 / verifyAnswer 引用校验 /
// sanitizeHistory 边界净化 / askCloud 重试与错误分类 / normalizeLlmConfig 校验。
// 铁律：零库零模型——假 API 服务器（node:http 本地随机端口）覆盖协议层，
// 不碰真网络；FAIL 项按 V2-D0X 编号入账（严重/一般必修，轻微登记）。
// 用例编号带 P0- 前缀，便于入账回溯。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeLlmConfig, buildMessages, chat, parseAnswer, verifyAnswer, askCloud, sanitizeHistory,
} from "../src/lib/llm.mjs";
import { configureLlmConfig, loadLlmConfig, saveLlmConfig } from "../src/desktop/llm-config.mjs";

let pass = 0, fail = 0, observe = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log(`PASS - ${name}`); }
  else { fail++; console.log(`FAIL - ${name} ${extra}`); }
};
const obs = (cond, name, note = "") => {
  if (cond) { observe++; console.log(`OBSERVE - ${name}${note ? " | " + note : ""}`); }
  else { fail++; console.log(`FAIL - ${name}（OBSERVE 条件不成立）${note}`); }
};

// ========== 0) 假 API 服务器（llm-test 同款 + 请求计数/慢响应/全错误矩阵） ==========
let scenario = "normal";
let scenarioQueue = null;
let lastAuth = null, lastBody = null;
let reqCount = 0;            // 请求计数：重试/不重试防线全靠它
let delayMs = 0;             // 慢响应场景
const REPLIES = {
  normal: { answer: "真正的升级是往外丢东西[1]。", citations: [{ n: 1, quote: "為學日益，為道日損。" }] },
  allFake: { answer: "答案[1]。", citations: [{ n: 1, quote: "道可道，非常道。" }] },
};
const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    reqCount++;
    lastAuth = req.headers.authorization || null;
    try { lastBody = JSON.parse(body); } catch { lastBody = null; }
    const respond = () => {
      const sc = scenarioQueue && scenarioQueue.length ? scenarioQueue.shift() : scenario;
      if (sc === "err401") { res.writeHead(401, { "Content-Type": "application/json" }); res.end('{"error":{"message":"bad key"}}'); return; }
      if (sc === "err403") { res.writeHead(403); res.end("forbidden"); return; }
      if (sc === "err404") { res.writeHead(404); res.end("nope"); return; }
      if (sc === "err429") { res.writeHead(429); res.end("slow down"); return; }
      if (sc === "err418") { res.writeHead(418); res.end("teapot"); return; }
      if (sc === "err500") { res.writeHead(500); res.end("boom"); return; }
      if (sc === "hang") return; // 不响应 → 客户端超时（reqCount 已计）
      if (sc === "noContent") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "   " } }] })); return; }
      if (sc === "noChoices") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ usage: {} })); return; }
      if (sc === "notJson") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("完全不是 JSON"); return; }
      const content = sc === "badjson"
        ? "抱歉，我无法按格式回答。"
        : JSON.stringify(REPLIES[sc] || REPLIES.normal);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: 42 } }));
    };
    if (delayMs > 0) setTimeout(respond, delayMs); else respond();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const CFG = { baseUrl: BASE, apiKey: "sk-test-1234", model: "test-chat" };
const RESULTS = [
  { book: "道德经", bookId: "daodejing-zh.docx", id: 7, loc: "第48章·第3块", text: "為學日益，為道日損。損之又損，以至於無為。" },
  { book: "道德经", bookId: "daodejing-zh.docx", id: 9, loc: "第8章·第1块", text: "上善若水，水善利萬物而不爭。" },
];

// ========== P0-A parseAnswer 宽容解析 ==========
console.log("\n--- P0-A parseAnswer ---");
{
  // V2-D02（严重）：以 { 开头时跳过截断 → JSON.parse 遇尾部文字必败 → 无辜降级。
  // 真实模型高频输出「JSON + 一句解释」，此形态直接把好答案打死。
  ok(parseAnswer('{"answer":"x","citations":[]} 附加文字')?.answer === "x",
    "P0-A1 D02: JSON 后夹带文字 → 仍解析出 answer（对称截断）");
  ok(parseAnswer('附加文字 {"answer":"x","citations":[]}')?.answer === "x",
    "P0-A1 D02: JSON 前夹带文字 → 解析出 answer（与尾夹带对称）");
  const two = parseAnswer('{"answer":"a"}{"answer":"b"}');
  obs(two === null, "P0-A5 双 JSON 连写 → null（修后仍拒，登记：模型极少此形态，拒收安全）");
  ok(parseAnswer('```json\n{"answer":"好","citations":[]}\n```')?.answer === "好", "P0-A2: ```json 围栏");
  const multi = parseAnswer('```json\n{"answer":"第一块","citations":[]}\n```\n说明\n```json\n{"answer":"第二块","citations":[]}\n```');
  ok(multi?.answer === "第一块", "P0-A2: 两个围栏只取第一个（非贪婪）");
  obs(true, "P0-A2 登记: 首块优先是确定行为，模型若把答案放第二块会丢——实测单块为常态", "首块优先");
  ok(parseAnswer('```JSON\n{"answer":"大写围栏","citations":[]}\n```')?.answer === "大写围栏", "P0-A3: 大写 ```JSON 围栏（大小写不敏感回退 brace-slice）");
  ok(parseAnswer('```json\n抱歉，我无法按格式回答。\n```') === null, "P0-A4: 围栏内容非 JSON → null");
  ok(parseAnswer('{"answer":"  "}') === null, "P0-A6: answer 纯空白 → null");
  ok(parseAnswer('{"citations":[]}') === null, "P0-A6: 缺 answer → null");
  const cn = parseAnswer('{"answer":"有","citations":null}');
  ok(cn?.answer === "有" && Array.isArray(cn.citations) && cn.citations.length === 0, "P0-A6: citations=null → 补 [] 放行");
  ok(parseAnswer('\uFEFF{"answer":"BOM","citations":[]}')?.answer === "BOM", "P0-A7: BOM 前缀被 trim 剥掉");
  ok(parseAnswer("") === null && parseAnswer(null) === null && parseAnswer(undefined) === null, "P0-A7: 空/非字符串安全 null");
}

// ========== P0-B verifyAnswer 引用校验（防幻觉红线） ==========
console.log("\n--- P0-B verifyAnswer ---");
{
  // 60% 阈值精确卡位（子句级）：
  // B1：3 子句 2 中 = 66.7% ≥60% → 放行（该放的放）
  const v1 = verifyAnswer({ answer: "a", citations: [{ n: 1, quote: "為學日益，為道日損。損之又損。不亦君子乎。" }] }, RESULTS);
  ok(v1.citations.length === 1 && v1.dropped.length === 0, "P0-B1: 2/3=66.7% ≥60% → 放行（该放的放）");
  // B2：2 子句 1 中 = 50% <60% → 拒（该拒的拒）
  const v2 = verifyAnswer({ answer: "a", citations: [{ n: 1, quote: "為學日益，為道日損。不亦君子乎。" }] }, RESULTS);
  ok(v2.citations.length === 0 && v2.dropped[0]?.reason === "quote-not-found", "P0-B2: 1/2=50% <60% → 拒（该拒的拒）");
  // V2-D03（一般）：短引文归一化后子句全 <4 字 → total=0 → 0/0>=0.6=false → 以「幻觉」罪名误杀
  const v3 = verifyAnswer({ answer: "a", citations: [{ n: 1, quote: "你好。再见。" }] }, RESULTS);
  ok(v3.dropped[0]?.reason === "quote-too-short" && v3.dropped[0]?.hits === 0 && v3.dropped[0]?.total === 0,
    "P0-B3 D03: 子句全短 → reason=quote-too-short（与幻觉剔除语义分离，不再误报 quote-not-found）");
  const v4 = verifyAnswer({ answer: "a", citations: [{ n: 2, quote: "上善若水。" }] }, RESULTS);
  ok(v4.citations.length === 1, "P0-B4: 恰好 4 字子句保留在分母内并命中");
  // B5：n 强转矩阵
  const bad = (n) => verifyAnswer({ answer: "a", citations: [{ n, quote: "為學日益，為道日損。" }] }, RESULTS).dropped[0]?.reason;
  ok(bad("1.5") === "bad-index" && bad("abc") === "bad-index" && bad(0) === "bad-index" && bad(-1) === "bad-index" && bad(null) === "bad-index",
    "P0-B5: n='1.5'/'abc'/0/-1/null → 全部 bad-index");
  const good = (n, quote) => verifyAnswer({ answer: "a", citations: [{ n, quote }] }, RESULTS).dropped.length === 0;
  ok(good("2", "上善若水。") && good(1.0, "為學日益，為道日損。"),
    "P0-B5: n='2'（指向第2条配第2条quote）/1.0 → Number 强转合法放行");
  obs(verifyAnswer({ answer: "a", citations: [{ n: true, quote: "為學日益，為道日損。" }] }, RESULTS).citations.length === 1,
    "P0-B5 登记: n=true 被 Number 强转成 1 命中第 1 条", "布尔当真编号，模型不会输出，仅直接调用可踩");
  // B6：归一化对称——前后空白/换行分隔子句/全角半角标点差异都命中
  const v6 = verifyAnswer({ answer: "a", citations: [{ n: 1, quote: "  為學日益，為道日損  " }] }, RESULTS);
  ok(v6.citations.length === 1, "P0-B6: 引文前后空白 → 命中（归一化去空白）");
  const v6b = verifyAnswer({ answer: "a", citations: [{ n: 1, quote: "為學日益,為道日損." }] }, RESULTS);
  ok(v6b.citations.length === 1, "P0-B6: 半角逗号句号 → 命中（归一化去标点对称）");
  // V2-D16（轻微，一行防御）：citations 非可迭代直接调用会炸
  let threw = false;
  try { verifyAnswer({ answer: "a", citations: 42 }, RESULTS); } catch { threw = true; }
  ok(!threw, "P0-B7 D16: citations=42（非数组）→ 不抛 TypeError（入参防御）");
  ok(verifyAnswer(null, RESULTS).citations.length === 0 && verifyAnswer({ answer: "a", citations: [{ n: 1, quote: "x" }] }, "非数组").dropped[0]?.reason === "bad-index",
    "P0-B7: parsed=null / results 非数组 → 安全兜底不崩");
  // 空 citations = 合法（书中没有相关内容），不算降级
  const vE = verifyAnswer({ answer: "书中没有相关内容", citations: [] }, RESULTS);
  ok(vE.citations.length === 0 && vE.dropped.length === 0, "P0-B8: 空 citations = 合法放行");
  // 校注剥离对称（老算法延续）
  const vAnno = verifyAnswer({ answer: "a", citations: [{ n: 1, quote: "下首一作「某」。務令下首常在下。" }] }, [
    { book: "x", text: "下首一作「某」。務令下首常在下。" },
  ]);
  ok(vAnno.citations.length === 1, "P0-B9: 「一作」校注双侧剥离后命中");
}

// ========== P0-C sanitizeHistory 边界净化 ==========
console.log("\n--- P0-C sanitizeHistory ---");
{
  const mixed = sanitizeHistory([
    { role: "user", content: "a" }, { role: "system", content: "非法1" },
    { role: "user", content: "b" }, { role: "assistant", content: "  " },
    { role: "user", content: "c" }, "垃圾字符串",
    { role: "user", content: "d" }, { role: "assistant", content: 123 },
    { role: "user", content: "e" }, { role: "user", content: "" },
    { role: "user", content: "f" }, { role: "user", content: "   " },
  ]);
  // V2-D19（登记）：过滤先于 slice(-6)——12 条里 6 条合法，若先 slice(-6) 只能救回 3 条，
  // 先过滤则 6 条全留（尽量多保留合法上下文；总条数仍有 ≤6 上界，行为确定）。
  obs(mixed.length === 6 && mixed[0].content === "a",
    "P0-C1 D19 登记: 过滤先于 slice(-6)，合法上下文尽量保留", "行为确定有界（≤6），补注释说明");
  const long = sanitizeHistory([{ role: "user", content: "x".repeat(3000) }]);
  ok(long.length === 1 && long[0].content.length === 2000, "P0-C2: 单条截断 2000 字");
  ok(sanitizeHistory(null).length === 0 && sanitizeHistory("x").length === 0 && sanititizeUndefined(), "P0-C2: 非数组/undefined 安全空");
  function sanititizeUndefined() { return sanitizeHistory(undefined).length === 0; }
  const emoji = sanitizeHistory([{ role: "user", content: "😀".repeat(1200) + "尾" }]);
  obs(emoji[0].content.length === 2000, "P0-C3 登记: 2000 字截断可能落在 emoji 代理对中间（无害，仅上下文边缘）", "孤立代理对不影响校验");
}

// ========== P0-D buildMessages 组装 ==========
console.log("\n--- P0-D buildMessages ---");
{
  const msgs = buildMessages({
    question: "什么是真正的升级？",
    results: RESULTS,
    skillChapters: [{ title: "无为", content: "為道日損……" }],
    history: [{ role: "system", content: "注入的历史" }, { role: "user", content: "上一问" }],
  });
  ok(msgs[0].role === "system" && msgs[0].content.includes("逐字抄"), "P0-D1: system 首位含铁律");
  const roles = msgs.map((m) => m.role);
  // 历史里的 system 角色被 buildMessages 强转为 user（内容原样保留，不冒充系统指令）
  ok(roles.filter((r) => r === "system").length === 1 && msgs[1].role === "user" && msgs[1].content === "注入的历史" && msgs[2].content === "上一问",
    "P0-D1: 历史里的 system 角色被强转为 user（防御有效，不会冒充系统指令）");
  const last = msgs[msgs.length - 1];
  ok(last.role === "user" && last.content.includes("[1] 《道德经》") && last.content.includes("上善若水"), "P0-D3: 片段带编号+书名+原文");
  // V2-D20 关联（登记）：askCloud 内部不做 history 净化，责任在调用方
  const raw = buildMessages({ question: "q", results: RESULTS, history: [{ role: "user", content: "y".repeat(5000) }] });
  obs(raw[1].content.length === 5000,
    "P0-D2 D20 登记: buildMessages 不净化历史（净化在 sanitizeHistory/调用方，chat.mjs 已守）", "askCloud 红线：调用方必须先过 sanitizeHistory");
  const bare = buildMessages({ question: "", results: [] });
  ok(bare.length === 2 && bare[1].content.includes("## 原文片段"), "P0-D3: 空 results/空问题不崩");
  const noBook = buildMessages({ question: "q", results: [{ id: 1, text: "t" }] });
  ok(noBook[2 - 1].content.includes("《?》"), "P0-D3: 片段缺 book → 《?》兜底");
}

// ========== P0-E askCloud 重试与错误矩阵 ==========
console.log("\n--- P0-E askCloud ---");
{
  // E1：首次引用全假 → 自动重试一次成功
  scenarioQueue = ["allFake", "normal"];
  reqCount = 0;
  const r = await askCloud({ config: CFG, question: "q", results: RESULTS });
  ok(r.ok === true && reqCount === 2, "P0-E1: QUOTE_FAIL 自动重试一次成功（请求计数=2）");
  const lastMsg = String(lastBody?.messages?.slice(-1)[0]?.content || "");
  ok(lastMsg.includes("补充要求") && lastMsg.includes("逐字抄写"), "P0-E1: 第二次请求附带加强提醒");
  ok(lastAuth === "Bearer sk-test-1234", "P0-E1: 请求带 Bearer 头（key 走 Authorization 不进 body）");
  scenarioQueue = null;

  // E2：两次全假仍降级；开关关闭只 1 次
  scenarioQueue = ["allFake", "allFake"];
  reqCount = 0;
  const r2 = await askCloud({ config: CFG, question: "q", results: RESULTS });
  ok(r2.ok === false && r2.code === "QUOTE_FAIL" && reqCount === 2, "P0-E2: 两次全假 → 仍降级（防线强度不变）");
  scenarioQueue = null;
  scenario = "allFake";
  reqCount = 0;
  const r2b = await askCloud({ config: CFG, question: "q", results: RESULTS, retryOnQuoteFail: false });
  ok(r2b.ok === false && reqCount === 1, "P0-E2: 重试开关关闭 → 只 1 次请求");
  scenario = "normal";

  // E3：BADRESP（非 JSON 回复）也重试一次
  scenarioQueue = ["badjson", "normal"];
  reqCount = 0;
  const r3 = await askCloud({ config: CFG, question: "q", results: RESULTS });
  ok(r3.ok === true && reqCount === 2, "P0-E3: BADRESP 也自动重试一次");
  scenarioQueue = null;

  // E4：TIMEOUT / AUTH / NETWORK 不重试（无谓重试防线）
  scenario = "hang";
  reqCount = 0;
  const r4 = await askCloud({ config: CFG, question: "q", results: RESULTS, timeoutMs: 400 });
  ok(r4.ok === false && r4.code === "TIMEOUT" && reqCount === 1, "P0-E4: 超时不重试（请求计数=1）");
  scenario = "err401";
  reqCount = 0;
  const r4b = await askCloud({ config: CFG, question: "q", results: RESULTS });
  ok(r4b.code === "AUTH" && reqCount === 1, "P0-E4: 401 不重试");
  scenario = "normal";

  // E5：错误分类全矩阵
  scenario = "err403";
  ok((await chat({ ...CFG, messages: [] })).code === "AUTH", "P0-E5: 403 → AUTH");
  scenario = "err404";
  ok((await chat({ ...CFG, messages: [] })).code === "NOTFOUND", "P0-E5: 404 → NOTFOUND");
  scenario = "err429";
  ok((await chat({ ...CFG, messages: [] })).code === "RATE", "P0-E5: 429 → RATE");
  scenario = "err500";
  ok((await chat({ ...CFG, messages: [] })).code === "SERVER", "P0-E5: 500 → SERVER");
  scenario = "err418";
  ok((await chat({ ...CFG, messages: [] })).code === "HTTP", "P0-E5: 418 → HTTP");
  scenario = "noContent";
  ok((await chat({ ...CFG, messages: [] })).code === "BADRESP", "P0-E5: content 空白 → BADRESP");
  scenario = "noChoices";
  ok((await chat({ ...CFG, messages: [] })).code === "BADRESP", "P0-E5: 缺 choices → BADRESP");
  scenario = "notJson";
  ok((await chat({ ...CFG, messages: [] })).code === "BADRESP", "P0-E5: 非 JSON 响应体 → BADRESP");
  scenario = "normal";

  // E6（登记）：最坏耗时=两次完整 timeout，无总预算上限（详细实证见 P0-G）
  scenario = "hang";
  const r6 = await askCloud({ config: CFG, question: "q", results: RESULTS, timeoutMs: 400 });
  obs(r6.code === "TIMEOUT", "P0-E6 登记: 重试仅覆盖 QUOTE_FAIL/BADRESP，TIMEOUT 原样返回不重试", "无总预算问题见 P0-G");
  scenario = "normal";

  // E7：配置坏 → CONFIG 且不发请求
  reqCount = 0;
  const r7 = await askCloud({ config: { baseUrl: "ftp://x", apiKey: "k", model: "m" }, question: "q", results: RESULTS });
  ok(r7.code === "CONFIG" && reqCount === 0, "P0-E7: 配置非法 → CONFIG 且零请求");
}

// ========== P0-F normalizeLlmConfig 校验 ==========
console.log("\n--- P0-F normalizeLlmConfig ---");
{
  // V2-D18（轻微）：中间含空白的主机名（"https://a b"）也过正则——
  // fetch 时 URL 非法抛 TypeError，误报成 NETWORK「连不上模型服务」，用户会去查网络而不是改地址。
  ok(normalizeLlmConfig({ baseUrl: "https://a b", apiKey: "k", model: "m" }).error,
    "P0-F1 D18: 含空白主机的地址 → 拒收（:// 后不允许空白）");
  ok(normalizeLlmConfig({ baseUrl: "https://api.deepseek.com/v1", apiKey: "k", model: "m" }).baseUrl === "https://api.deepseek.com/v1",
    "P0-F1: 正常地址照常放行");
  ok(normalizeLlmConfig({ baseUrl: "http://127.0.0.1:8080/", apiKey: "k", model: "m" }).baseUrl === "http://127.0.0.1:8080",
    "P0-F1: 尾斜杠归一保持");
  // F2 双拷贝漂移探测器（常驻）：llm-config.mjs 内联复制了同款校验，两侧必须一致
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-llmfuzz-"));
  configureLlmConfig({ userData: tmp, available: true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() });
  const cases = [
    { baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-abc12345", model: "deepseek-chat" },
    { baseUrl: "https://", apiKey: "k", model: "m" },
    { baseUrl: "https://a b", apiKey: "k", model: "m" },
    { baseUrl: "ftp://x", apiKey: "k", model: "m" },
    { baseUrl: "  https://a.com  ", apiKey: "  k  ", model: "  m  " },
    { baseUrl: "https://a.com/", apiKey: "k", model: "" },
    { baseUrl: "", apiKey: "k", model: "m" },
    { baseUrl: "https://a.com", apiKey: "k", model: "m", extra: "忽略" },
  ];
  let drift = 0;
  for (const c of cases) {
    const a = normalizeLlmConfig(c).error ? "reject" : "accept";
    const b = saveLlmConfig(c).ok ? "accept" : "reject";
    if (a !== b) { drift++; console.log(`  · 漂移: ${JSON.stringify(c)} → normalize=${a} save=${b}`); }
  }
  ok(drift === 0, "P0-F2: 双拷贝校验零漂移（normalizeLlmConfig vs saveLlmConfig 8 组配置一致）");
  // 合并语义差异（设计使然，非漂移）：saveLlmConfig 的 apiKey:"" = 保持旧 key 不改（防误清），
  // normalizeLlmConfig 是全量校验（空 key 拒收）——两者语义不同，登记不修
  const keep = saveLlmConfig({ apiKey: "" });
  obs(keep.ok === true, "P0-F2 登记: apiKey 传空在 saveLlmConfig 是合并语义（保持旧 key），与全量校验语义不同", "设计使然");
  // keyTail 不泄超 4 位
  saveLlmConfig({ baseUrl: "https://a.com", model: "m", apiKey: "sk-0123456789abcdef" });
  const cfg = loadLlmConfig();
  ok(cfg.keyTail === "…cdef" && !JSON.stringify(cfg).includes("0123456789abcdef"),
    "P0-F2: loadLlmConfig 只回显尾 4 位，不泄露全文");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ========== P0-G 重试耗时翻倍实证（OBSERVE 登记区） ==========
console.log("\n--- P0-G 重试耗时 ---");
{
  // V2-D20（登记）：QUOTE_FAIL 重试无总预算上限——最坏情况=两次完整 timeout。
  // 构造：慢响应 300ms + 首次 allFake + 重试 → 两次请求各 300ms，总耗时翻倍。
  scenarioQueue = ["allFake", "normal"];
  delayMs = 300;
  const t0 = Date.now();
  const r = await askCloud({ config: CFG, question: "q", results: RESULTS, timeoutMs: 5000 });
  const dt = Date.now() - t0;
  obs(r.ok === true && dt >= 600,
    "P0-E6 D20 登记: 重试无总预算，最坏 2×单次耗时（本次实测翻倍）", `慢响应300ms+重试，总 ${dt}ms`);
  scenarioQueue = null;
  delayMs = 0;
  scenario = "normal";
}

server.closeAllConnections?.();
server.close();

console.log();
console.log(`=== llm-fuzz(P0): ${pass} pass / ${fail} fail / ${observe} observe ===`);
process.exit(fail > 0 ? 1 : 0);
