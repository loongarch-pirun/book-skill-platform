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
    return d && typeof d === "object" ? d : {};
  } catch { return {}; }
}

function decodeKey(raw) {
  const enc = raw?.apiKeyEnc;
  if (typeof enc !== "string" || !enc) return null;
  try {
    if (enc.startsWith("enc:")) return _env.decrypt(Buffer.from(enc.slice(4), "base64"));
    if (enc.startsWith("plain:")) return Buffer.from(enc.slice(6), "base64").toString("utf8");
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
  return {
    baseUrl: String(raw.baseUrl || ""),
    model: String(raw.model || ""),
    hasKey: !!key,
    keyTail: key ? "…" + key.slice(-4) : null,
    encryption: _env.available ? "safeStorage" : "plain",
    warning: _env.available ? null : "系统加密不可用，key 以本机可读形式保存（不推荐）",
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
  const raw = readRaw();
  const next = {
    baseUrl: baseUrl !== undefined ? String(baseUrl).trim() : String(raw.baseUrl || ""),
    model: model !== undefined ? String(model).trim() : String(raw.model || ""),
  };
  const keyToSet = typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : null;
  const haveKey = !!keyToSet || !!decodeKey(raw);

  if (!/^https?:\/\//i.test(next.baseUrl)) return { ok: false, error: "接口地址要以 http(s):// 开头（例如 https://api.deepseek.com/v1）" };
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
