// V2 云端问答配置存储（P1）：存 <userData>/llm.json。
//
// 设计约束（见规划 4.2）：
//   - key 加密由**注入的加密器**完成——main.js 把 Electron safeStorage 传进来
//     （主进程是唯一能碰 safeStorage 的地方）；本模块零 Electron 依赖，测试可注入假加密器；
//   - key 永不回显：UI 侧只拿到 hasKey / keyTail（尾 4 位）；
//   - 加密不可用时降级 plain:（base64 存 + UI 警告），文件里永远不出现裸 key。
import fs from "node:fs";
import path from "node:path";

let _env = null; // { userData, available, encrypt, decrypt }

export function configureLlmConfig(env) { _env = env; }
export function llmConfigReady() { return !!_env?.userData; }

function cfgPath() { return path.join(_env.userData, "llm.json"); }

function readRaw() {
  try {
    const d = JSON.parse(fs.readFileSync(cfgPath(), "utf8"));
    // V2-D07（暴力测试 P1 修）：顶层非对象（数组/null/标量）也按损坏处理——老逻辑
    // typeof [] === "object" 漏网，静默按空配置走，用户反复重填永远不知道是文件坏了。
    // 解析失败同理：返回 __broken 标记，与"从未配置"区分（loadLlmConfig 透出 warning）。
    if (!d || typeof d !== "object" || Array.isArray(d)) return { __broken: true };
    return d;
  } catch { return { __broken: true }; }
}

function decodeKey(raw) {
  const enc = raw?.apiKeyEnc;
  if (typeof enc !== "string" || !enc) return null;
  try {
    if (enc.startsWith("enc:")) return _env.decrypt(Buffer.from(enc.slice(4), "base64"));
    if (enc.startsWith("plain:")) {
      const s = Buffer.from(enc.slice(6), "base64").toString("utf8");
      // V2-D09（暴力测试 P1 修）：Buffer.from 对坏 base64 宽容解析成垃圾串——老逻辑
      // hasKey:true 但 key 无效，用户每次调用都 401 却查不到原因。往返校验：
      // 重新编码必须与原文一致，否则按无 key 处理。
      return Buffer.from(s, "utf8").toString("base64") === enc.slice(6) ? s : null;
    }
  } catch { /* 加密器/数据异常按无 key 处理 */ }
  return null;
}

function encodeKey(key) {
  const plain = String(key || "");
  if (_env.available) {
    try { return "enc:" + _env.encrypt(plain).toString("base64"); }
    catch { /* 加密失败降级明文（本机，带警告） */ }
  }
  return "plain:" + Buffer.from(plain, "utf8").toString("base64");
}

// 给 UI 的形态：不含明文 key
export function loadLlmConfig() {
  if (!llmConfigReady()) return { baseUrl: "", model: "", hasKey: false, keyTail: null, encryption: "unknown", warning: null };
  const raw = readRaw();
  const key = decodeKey(raw);
  const broken = !!raw.__broken; // V2-D07：配置损坏态透出（不再是静默的「没配置」）
  return {
    baseUrl: String(raw.baseUrl || ""),
    model: String(raw.model || ""),
    hasKey: !!key,
    keyTail: key ? "…" + key.slice(-4) : null,
    encryption: _env.available ? "safeStorage" : "plain",
    warning: broken
      ? "配置文件已损坏，已按未配置处理——重新填写并保存即可修复"
      : (_env.available ? null : "系统加密不可用，key 以本机可读形式保存（不推荐）"),
  };
}

// 内部用：解出明文 key（无则 null）。调用方（chat.mjs）绝不把它透出到 UI。
export function readLlmKey() {
  if (!llmConfigReady()) return null;
  return decodeKey(readRaw());
}

// 保存：baseUrl / model 传了就更新；apiKey 非空才更新 key（空 = 不改，防误清）。
// 合并后做完整性校验，不完整直接拒收（不落盘半成品）。
export function saveLlmConfig({ baseUrl, model, apiKey } = {}) {
  if (!llmConfigReady()) return { ok: false, error: "未配置存储目录" };
  // V2-D08（暴力测试 P1 修）：apiKey 传了但非字符串（如数字 123）——老逻辑 typeof
  // 检查不过被静默忽略，返回 ok:true 但 key 没存，调用方以为存成功了。现显式拒收。
  if (apiKey !== undefined && typeof apiKey !== "string") return { ok: false, error: "API key 格式不对（应是文本）" };
  const raw = readRaw();
  const next = {
    // 与 llm.mjs normalizeLlmConfig 对齐：trim + 去尾斜杠在**校验前**完成——
    // V2-D18 连带修：老代码校验用未去斜杠的原值，"https://" 能过正则而 normalize 侧被拒（双拷贝漂移）
    baseUrl: baseUrl !== undefined ? String(baseUrl).trim().replace(/\/+$/, "") : String(raw.baseUrl || ""),
    model: model !== undefined ? String(model).trim() : String(raw.model || ""),
  };
  const keyToSet = typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : null;
  const haveKey = !!keyToSet || !!decodeKey(raw);

  // 与 llm.mjs normalizeLlmConfig 同款校验（双拷贝，F2 漂移探测器常驻盯一致）——
  // V2-D18 修：含空白主机的地址拒收（否则 fetch 抛 TypeError 误报 NETWORK）
  if (!/^https?:\/\//i.test(next.baseUrl) || /\s/.test(next.baseUrl)) return { ok: false, error: "接口地址要以 http(s):// 开头（例如 https://api.deepseek.com/v1）" };
  if (!next.model) return { ok: false, error: "请填模型名（例如 deepseek-chat）" };
  if (!haveKey) return { ok: false, error: "请填 API key" };

  const out = { baseUrl: next.baseUrl.replace(/\/+$/, ""), model: next.model };
  out.apiKeyEnc = keyToSet ? encodeKey(keyToSet) : raw.apiKeyEnc;
  try {
    fs.mkdirSync(_env.userData, { recursive: true });
    fs.writeFileSync(cfgPath(), JSON.stringify(out, null, 2), "utf8");
  } catch (e) {
    return { ok: false, error: `保存配置失败：${e.message}` };
  }
  return { ok: true, config: loadLlmConfig() };
}
