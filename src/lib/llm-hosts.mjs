// V08 出网端点校验唯一正本（叶子模块：零依赖，lib 与 desktop 两侧共用）。
//
// 背景：normalizeLlmConfig（src/lib/llm.mjs）与 saveLlmConfig（src/desktop/llm-config.mjs）
// 原先各存一份 `/^https?:\/\//` 前缀正则（双拷贝，F2 漂移探测器常驻盯一致）。本轮把两处
// 收敛到这一个函数，从「两处同步改」升级为「只有一个正本，天然零漂移」。
//
// 策略（fail-closed 默认）：
//   - 非环回地址必须 https://（http 明文下 Bearer token 与书库内容可被链路窃听）；
//   - http:// 仅本机环回放行：127.0.0.0/8 / localhost / ::1——环回流量不出本机，
//     且 test:ci 里的 node:http 假 API 全部落在 127.0.0.1；
//   - 默认按内置主机白名单精确匹配 URL.hostname（防 api.deepseek.com.evil.com 之类绕过）；
//   - allowedHosts 可经 policy 注入扩展/收紧（自建 OpenAI 兼容端点场景一行开启）。

// 取自 src/probe-llm.mjs:17-20 既有候选端点，与代码现状同源，不引新依赖。
export const DEFAULT_ALLOWED_HOSTS = ["api.deepseek.com", "open.bigmodel.cn"];

function isLoopback(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && [m[1], m[2], m[3]].every((n) => Number(n) <= 255);
}

export function validateBaseUrl(base, policy = {}) {
  const raw = String(base || "").trim().replace(/\/+$/, "");
  const allowedHosts = Array.isArray(policy.allowedHosts) ? policy.allowedHosts : DEFAULT_ALLOWED_HOSTS;
  const legacy = "接口地址要以 http(s):// 开头（例如 https://api.deepseek.com/v1）";
  const fail = (error) => ({ ok: false, error, scheme: null, host: null, loopback: false, allowedHosts: [...allowedHosts] });
  // V2-D18：含空白的地址 fetch 时会抛 TypeError 被误报成 NETWORK，明确拒收。
  if (!raw || /\s/.test(raw)) return fail(legacy);
  // 复刻原双拷贝正则的第一半：只认 http(s):// 前缀。"https:"（尾斜杠被剥掉后）、
  // "ftp://x"、"https://" 一律走 legacy 拒收，避开 new URL 对畸形串的解析分歧。
  if (!/^https?:\/\//i.test(raw)) return fail(legacy);
  let u;
  try { u = new URL(raw); } catch { return fail(legacy); }
  const scheme = u.protocol;
  if (scheme !== "https:" && scheme !== "http:") return fail(legacy);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = isLoopback(host);
  if (scheme === "http:" && !loopback) {
    return fail("接口地址必须使用 https://（明文 http 只允许本机环回地址）");
  }
  // 环回为本地假 API/本地模型端点，流量不出本机，不受外部主机白名单约束。
  if (!loopback && !allowedHosts.includes(host)) {
    return { ...fail(`接口地址主机不在允许列表内（允许：${allowedHosts.join("、")}）`), scheme, host };
  }
  // 带 userinfo 的地址（https://user:pass@host）易被误判归属，一律拒收。
  if (u.username || u.password) return fail(legacy);
  return { ok: true, error: null, scheme, host, loopback, allowedHosts: [...allowedHosts] };
}
