// LLM 端点连通探针（V2 P0-b）
// 用途：验证本机网络 + Node fetch 能到达候选模型端点；填了 key 就做一次最小全链路验证。
//
// 用法：
//   node src/probe-llm.mjs                        # 测默认候选端点（DeepSeek / 智谱 GLM）连通性
//   node src/probe-llm.mjs --base https://api.deepseek.com/v1 --key sk-xxx --model deepseek-chat
//                                                 # 全链路：发一个最小 chat 请求验证 key + 模型名
//
// 判读：
//   无 key 时收到 401/403 = 连通成功（请求到达了服务器，只差钥匙）
//   fetch 报错（超时/DNS/拒绝）= 不可达（检查网络或代理）
import process from "node:process";

const TIMEOUT_MS = 10_000;

// 默认候选端点（OpenAI 兼容协议；placeholder 性质，用户可自定）
const CANDIDATES = [
  { name: "DeepSeek", base: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { name: "智谱 GLM", base: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
];

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

async function fetchWithTimeout(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

// 无 key / 有 key 通用的连通测试：GET {base}/models
async function probeReachable(cand, key) {
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(`${cand.base}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    const ms = Date.now() - t0;
    if (res.status === 401 || res.status === 403) {
      return key
        ? { ok: false, msg: `可达，但 key 无效或无权限（HTTP ${res.status}，${ms}ms）` }
        : { ok: true, msg: `✅ 网络可达（HTTP ${res.status} = 只差填 key，${ms}ms）` };
    }
    if (res.status === 200) {
      let list = "";
      try {
        const d = await res.json();
        const names = (d.data || []).slice(0, 6).map((m) => m.id).join(", ");
        if (names) list = ` | 可列出的模型: ${names}`;
      } catch { /* 非标准响应不致命 */ }
      return { ok: true, msg: `✅ 可达且 key 有效（HTTP 200，${ms}ms）${list}` };
    }
    return { ok: false, msg: `⚠️ 意外状态 HTTP ${res.status}（${ms}ms）` };
  } catch (e) {
    const why = e.name === "AbortError" ? `超时（>${TIMEOUT_MS / 1000}s）` : e.cause?.code || e.message;
    return { ok: false, msg: `❌ 不可达：${why}` };
  }
}

// 有 key：发一个最小 chat 请求（全链路验证）；失败时把 401/404 等状态打出来
async function probeChat(cand, key, model) {
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(`${cand.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "只回复两个字：收到" }],
        max_tokens: 16,
        temperature: 0,
      }),
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    if (res.status === 200) {
      let reply = "";
      try { reply = JSON.parse(text).choices?.[0]?.message?.content || ""; } catch { /* 宽容解析演示 */ }
      return `✅ chat 全链路通过（${ms}ms）：模型回复「${String(reply).trim().slice(0, 40)}」`;
    }
    return `❌ chat 失败 HTTP ${res.status}（${ms}ms）：${text.slice(0, 200)}`;
  } catch (e) {
    const why = e.name === "AbortError" ? `超时（>${TIMEOUT_MS / 1000}s）` : e.cause?.code || e.message;
    return `❌ chat 不可达：${why}`;
  }
}

const customBase = arg("--base");
const key = arg("--key");
const customModel = arg("--model");

console.log("=== LLM 端点连通探针 ===");
console.log(`超时 ${TIMEOUT_MS / 1000}s · ${key ? "带 key（全链路）" : "无 key（只测网络可达）"}\n`);

if (customBase) {
  const cand = { name: "自定义", base: customBase.replace(/\/+$/, ""), model: customModel || "(未指定)" };
  const r = await probeReachable(cand, key);
  console.log(`${cand.name} (${cand.base})`);
  console.log(`  ${r.msg}`);
  if (key && customModel) console.log(`  ${await probeChat(cand, key, customModel)}`);
  if (key && !customModel) console.log("  ⚠️ 带 key 全链路验证需要同时给 --model");
} else {
  for (const cand of CANDIDATES) {
    const r = await probeReachable(cand, key);
    console.log(`${cand.name} (${cand.base})`);
    console.log(`  ${r.msg}`);
    if (key) console.log(`  ${await probeChat(cand, key, customModel || cand.model)}`);
    console.log("");
  }
  console.log("提示：拿到 key 后跑 —— node src/probe-llm.mjs --base <地址> --key <key> --model <模型名>");
}
