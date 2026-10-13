// llm 单元测试（V2 P1）：配置校验 / 提示词组装 / 假 API 全链路 / 宽容解析 / 引用校验 / 配置存储。
// 假 API：node:http 本地服务（127.0.0.1 随机端口）——CI 不碰真网络。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLlmConfig, buildMessages, chat, parseAnswer, verifyAnswer, askCloud } from "../src/lib/llm.mjs";
import { configureLlmConfig, loadLlmConfig, readLlmKey, saveLlmConfig } from "../src/desktop/llm-config.mjs";

let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log(`PASS - ${name}`); }
  else { fail++; console.log(`FAIL - ${name} ${extra}`); }
};

// ========== 0) 假 API 服务器 ==========
// 场景变量控制响应；请求头/请求体记录下来供断言。
let scenario = "normal";
let lastAuth = null, lastBody = null;
const REPLIES = {
  // 片段1 的原文：「為學日益，為道日損。損之又損，以至於無為。」
  normal: { answer: "真正的升级是往外丢东西[1]。", citations: [{ n: 1, quote: "為學日益，為道日損。" }] },
  partialFake: { answer: "答案[1][2]。", citations: [{ n: 1, quote: "為學日益，為道日損。" }, { n: 2, quote: "天行健，君子以自強不息。" }] },
  allFake: { answer: "答案[1]。", citations: [{ n: 1, quote: "道可道，非常道。" }] },
  badIndex: { answer: "答案[9]。", citations: [{ n: 9, quote: "為學日益，為道日損。" }] },
};
const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    lastAuth = req.headers.authorization || null;
    try { lastBody = JSON.parse(body); } catch { lastBody = null; }
    if (scenario === "err401") { res.writeHead(401, { "Content-Type": "application/json" }); res.end('{"error":{"message":"bad key"}}'); return; }
    if (scenario === "hang") return; // 不响应 → 客户端超时
    const content = scenario === "badjson"
      ? "抱歉，我无法按格式回答。"
      : JSON.stringify(REPLIES[scenario] || REPLIES.normal);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: 42 } }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const CFG = { baseUrl: BASE, apiKey: "sk-test-1234", model: "test-chat" };

const RESULTS = [
  { book: "道德经", bookId: "daodejing-zh.docx", id: 7, loc: "第48章·第3块", text: "為學日益，為道日損。損之又損，以至於無為。" },
  { book: "道德经", bookId: "daodejing-zh.docx", id: 9, loc: "第8章·第1块", text: "上善若水，水善利萬物而不爭。" },
];

// ========== 1) 配置校验 ==========
{
  ok(normalizeLlmConfig({}).error, "配置校验: 全缺 → 拒收");
  ok(normalizeLlmConfig({ baseUrl: "ftp://x", apiKey: "k", model: "m" }).error, "配置校验: 非 http(s) → 拒收");
  ok(normalizeLlmConfig({ baseUrl: BASE + "/", apiKey: "k", model: "m" }).baseUrl === BASE, "配置校验: 尾部斜杠自动去掉");
}

// ========== 2) 提示词组装 ==========
{
  const msgs = buildMessages({
    question: "什么是真正的升级？",
    results: RESULTS,
    skillChapters: [{ title: "无为", content: "為道日損……" }],
    history: [{ role: "user", content: "上一问" }, { role: "assistant", content: "上一答" }],
  });
  ok(msgs[0].role === "system" && msgs[0].content.includes("逐字抄"), "提示词: system 在首位且含铁律");
  ok(msgs.length === 4 && msgs[1].content === "上一问" && msgs[2].role === "assistant", "提示词: 历史居中（system+历史2条+问题=4条）");
  const last = msgs[msgs.length - 1];
  ok(last.role === "user" && last.content.includes("[1] 《道德经》") && last.content.includes("上善若水"), "提示词: 片段带编号+书名+原文");
  ok(last.content.includes("技能包参考章节") && last.content.includes("什么是真正的升级？"), "提示词: 技能包与问题都在");
}

// ========== 3) 假 API 全链路 ==========
{
  scenario = "normal";
  const r = await askCloud({ config: CFG, question: "什么是真正的升级？", results: RESULTS });
  ok(r.ok === true && r.answer.includes("往外丢东西"), "全链路: 正常返回 answer");
  ok(r.citations.length === 1 && r.citations[0].n === 1 && r.citations[0].book === "道德经" && r.citations[0].id === 7, "全链路: 引用补齐 book/loc/id");
  ok(r.dropped === 0 && r.usage?.total_tokens === 42, "全链路: dropped=0 且透传 usage");
  ok(lastAuth === "Bearer sk-test-1234", "全链路: 请求带 Bearer 头");
  ok(lastBody?.model === "test-chat" && Array.isArray(lastBody?.messages), "全链路: 请求体带模型名与 messages");
}

// ========== 4) 引用校验（防幻觉延伸） ==========
{
  scenario = "partialFake";
  const r = await askCloud({ config: CFG, question: "q", results: RESULTS });
  ok(r.ok === true && r.citations.length === 1 && r.dropped === 1, "校验: 部分捏造 → 剔 1 条留 1 条");

  scenario = "allFake";
  const r2 = await askCloud({ config: CFG, question: "q", results: RESULTS });
  ok(r2.ok === false && r2.code === "QUOTE_FAIL", "校验: 引用全捏造 → 整条降级（QUOTE_FAIL）");

  scenario = "badIndex";
  const r3 = await askCloud({ config: CFG, question: "q", results: RESULTS });
  ok(r3.ok === false && r3.code === "QUOTE_FAIL", "校验: 引用不存在的编号 → 降级");

  // 直接测 verifyAnswer 的两个细节：空引用是合法、校注剥离对称
  const vEmpty = verifyAnswer({ answer: "书中没有相关内容", citations: [] }, RESULTS);
  ok(vEmpty.citations.length === 0 && vEmpty.dropped.length === 0, "校验: citations 为空 = 合法（不算降级）");
  const vAnno = verifyAnswer({ answer: "a", citations: [{ n: 1, quote: "下首一作「某」。務令下首常在下。" }] }, [
    { book: "x", text: "下首一作「某」。務令下首常在下。" },
  ]);
  ok(vAnno.citations.length === 1, "校验: 引文含「一作」校注双侧剥离后命中");
}

// ========== 5) 宽容解析 ==========
{
  const fenced = parseAnswer('```json\n{"answer":"好","citations":[]}\n```');
  ok(fenced?.answer === "好", "解析: ```json 围栏");
  const wrapped = parseAnswer('好的，这是结果：{"answer":"好","citations":[]} 完毕');
  ok(wrapped?.answer === "好", "解析: 前后夹带文字");
  ok(parseAnswer("完全不是 JSON") === null, "解析: 非 JSON → null");
  ok(parseAnswer('{"citations":[]}') === null, "解析: 缺 answer → null");
}

// ========== 6) 错误路径（人话化） ==========
{
  scenario = "err401";
  const r = await chat({ ...CFG, messages: [{ role: "user", content: "hi" }] });
  ok(r.ok === false && r.code === "AUTH" && r.message.includes("key"), "错误: 401 → AUTH 人话");

  scenario = "hang";
  const t0 = Date.now();
  const r2 = await chat({ ...CFG, messages: [{ role: "user", content: "hi" }], timeoutMs: 300 });
  ok(r2.ok === false && r2.code === "TIMEOUT" && Date.now() - t0 < 3000, "错误: 挂起 → TIMEOUT");

  scenario = "badjson";
  const r3 = await askCloud({ config: CFG, question: "q", results: RESULTS });
  ok(r3.ok === false && r3.code === "BADRESP", "错误: 非 JSON 回复 → BADRESP 降级");

  const r4 = await chat({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m", messages: [], timeoutMs: 1000 });
  ok(r4.ok === false && (r4.code === "NETWORK" || r4.code === "TIMEOUT"), "错误: 打不通的地址 → NETWORK");
}

// ========== 7) 配置存储（假加密器注入） ==========
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-llm-"));
  const fakeEnc = {
    available: true,
    encrypt: (s) => Buffer.from("ENC:" + s, "utf8"),
    decrypt: (b) => { const t = b.toString("utf8"); return t.startsWith("ENC:") ? t.slice(4) : null; },
  };
  configureLlmConfig({ userData: tmp, ...fakeEnc });

  ok(saveLlmConfig({ baseUrl: BASE, model: "deepseek-chat" }).ok === false, "存储: 缺 key → 拒收（不落半成品）");
  const save = saveLlmConfig({ baseUrl: "https://api.deepseek.com/v1/", model: "deepseek-chat", apiKey: "sk-abc12345" });
  ok(save.ok === true && save.config.hasKey === true && save.config.keyTail === "…2345", "存储: 保存成功 + keyTail 尾4位");
  ok(readLlmKey() === "sk-abc12345", "存储: 解密往返正确");

  const disk = fs.readFileSync(path.join(tmp, "llm.json"), "utf8");
  ok(disk.includes("enc:") && !disk.includes("sk-abc12345"), "存储: 文件里加密、无明文 key");

  const save2 = saveLlmConfig({ model: "deepseek-reasoner" });
  ok(save2.ok === true && save2.config.model === "deepseek-reasoner" && readLlmKey() === "sk-abc12345", "存储: 只改模型不动 key");
  ok(save2.config.baseUrl === "https://api.deepseek.com/v1", "存储: baseUrl 尾部斜杠已归一");

  // 加密不可用 → 降级 plain: + 警告（仍不出现裸 key）
  configureLlmConfig({ userData: tmp, available: false, encrypt: fakeEnc.encrypt, decrypt: fakeEnc.decrypt });
  saveLlmConfig({ apiKey: "sk-xyz9999" });
  const disk2 = fs.readFileSync(path.join(tmp, "llm.json"), "utf8");
  ok(disk2.includes("plain:") && !disk2.includes("sk-xyz9999"), "存储: 无加密器时降级 plain:（仍无裸 key）");
  ok(loadLlmConfig().warning !== null, "存储: 降级时 UI 拿得到警告");
}

server.closeAllConnections?.();
server.close();

console.log();
console.log(`=== llm-test: ${pass} pass / ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
