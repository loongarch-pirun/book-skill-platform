// mineru-runtime.mjs — 随包 MinerU basic 运行时的「准备 + 就绪」编排层
//
// 为什么需要这一层：src/lib/mineru.mjs 里的 CLI 是**纯 HTTP 客户端**（client.py:446-447），
// 它自己不起服务。打包版把便携 Python + basic onnx 模型塞进 resources/runtime/ 后，
// 必须有人在主进程里做四件事，否则导入 PDF 只会得到一句 Python 栈（ServerNotRunningError）：
//   1. 在 userData 下准备干净 ACL 的 MINERU_HOME，写自包含 config.yaml
//      （随机 token、model.source=local、base_dir 指向只读 resources、固定偏门端口）
//   2. 用独立 cwd 拉起 doclib 服务（避开 .mineru-service.lock 与别处抢锁）
//   3. 强制 basic 档（干净 DB 默认 disabled/standard，standard 会去找 GGUF）
//   4. 等托管 parse-server healthy，然后把 BSP_MINERU_* 交给调用方
//
// 只在打包态启用：dev 态用户机器上有自己的 ~/.mineru 正本（standard 档），不能抢。
// 端口 18980/18580 是随包的固定偏门端口，避开正本的 15980/16580；
// 但 strict_port=False，被占时 MinerU 会漂移并把实际端口写进 doclib.endpoint.json，
// 所以这里一律靠 endpoint 发现服务，不依赖写死的值。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";

const TCP_PORT = 18980;
const MANAGED_PORT = 18580;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function runtimePaths(resourcesDir, userData) {
  return {
    python: path.join(resourcesDir, "runtime", "mineru-python", "python.exe"),
    models: path.join(resourcesDir, "runtime", "mineru-models"),
    home: path.join(userData, "mineru-home"),
    cwd: path.join(userData, "mineru-run"),
  };
}

// 随包运行时是否齐备（三件：python.exe、basic onnx 模型、manifest）。
// 缺任一件就别硬起服务——报清楚缺什么，让上层回落 legacy 解析，比抛 Python 栈有用。
export function mineruRuntimeReady(resourcesDir) {
  const p = runtimePaths(resourcesDir, "");
  const manifest = path.join(p.models, "MinerU-4_models_onnx", ".mineru_files.json");
  const missing = [];
  if (!fs.existsSync(p.python)) missing.push(p.python);
  if (!fs.existsSync(manifest)) missing.push(manifest);
  return { ready: missing.length === 0, missing };
}

function serviceBase(home) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, "doclib.endpoint.json"), "utf8"));
    const t = (j.transports || []).find((x) => x.type === "tcp" && x.base_url);
    if (t) return t.base_url.replace(/\/+$/, "");
  } catch { /* 服务还没起来或 endpoint 还没写 */ }
  return `http://127.0.0.1:${TCP_PORT}`;
}

function readToken(configPath) {
  const m = /token:\s*(\S+)/.exec(fs.readFileSync(configPath, "utf8"));
  return m ? m[1] : null;
}

// 收紧 MINERU_HOME 的 Windows DACL——不收紧则 doclib 起不来（真机实测）。
//
// 为什么必须做：MinerU 在 private_file.py 的 _protect_windows_file（约 :204-215）里读父目录
// DACL，只要有任何一条「非继承、允许、且写掩码命中 0x500D0156」的 ACE，且它的 SID 不是
// 当前用户/SYSTEM/Administrators/OWNER RIGHTS，就抛：
//   PermissionError: Credential configuration directory must not be writable by other users.
// doclib 于是当场退出（stdio 是 ignore，用户什么都看不见），endpoint.json 永不生成，
// 表现为「服务 30s 没起来」——这条链我在 2026-11-13 用组装好的 runtime 真机跑出来过。
//
// userData（%APPDATA%\book-skill-platform）默认继承 user 目录的 DACL，里面常混进**别的机器**
// 留下的孤儿 SID（本机实测 3 个，Translate 都解析不出账户名）：那些 SID 属于已不存在的账户，
// 但 ACE 还在、还带 Modify，于是永远过不了校验。
//
// 所以建完 mineru-home 立刻把继承断开，只留 当前用户 + SYSTEM + Administrators。
// 这不是「放宽」，是收紧：去掉所有陌生 SID 的写权限。失败不抛——留给后面真实的启动失败去报，
// 免得在非 Windows 或受限环境里因为 ACL 拿不到就整体不可用。
function tightenHomeAcl(home, log) {
  if (process.platform !== "win32") return;
  const user = process.env.USERNAME;
  if (!user) return;
  try {
    execFileSync("icacls", [
      home, "/inheritance:r",
      "/grant:r", `${user}:(OI)(CI)F`,
      "/grant:r", "SYSTEM:(OI)(CI)F",
      "/grant:r", "Administrators:(OI)(CI)F",
    ], { stdio: "ignore", windowsHide: true, timeout: 15000 });
  } catch (e) {
    log(`icacls 收紧 DACL 失败（${e.message}），继续尝试起服务`);
  }
}

function writeConfig(home, models, log = () => {}) {
  fs.mkdirSync(home, { recursive: true });
  // 必须在写 config.yaml 之前收紧：MinerU 是在读配置时校验目录 DACL 的
  tightenHomeAcl(home, log);
  const configPath = path.join(home, "config.yaml");
  let token = fs.existsSync(configPath) ? readToken(configPath) : null;
  let generated = false;
  if (!token) {
    // base64url = 43 字符，字符集落在 validate_doclib_token 的 [A-Za-z0-9._~+/=-]{32,}
    token = crypto.randomBytes(32).toString("base64url");
    generated = true;
    const modelsPosix = models.replace(/\\/g, "/");
    fs.writeFileSync(configPath, [
      "doclib:",
      "  auth:",
      `    token: ${token}`,
      "  tcp:",
      `    port: ${TCP_PORT}`,
      "  managed_parse_server:",
      `    port: ${MANAGED_PORT}`,
      "model:",
      "  source: local",
      `  base_dir: '${modelsPosix}'`,
      "  small_backend: onnx",
      "  onnx_device: cpu",
      "",
    ].join("\n"), "utf8");
  }
  return { configPath, token, generated };
}

// 把 stderr 日志的最后几行摘出来，附在启动失败的报错里。
// 否则「30s 没就绪」这句话对定位零帮助——真因（DACL/PermissionError/端口）全在日志里。
function tailLog(logPath, lines = 6) {
  try {
    const txt = fs.readFileSync(logPath, "utf8").trim();
    if (!txt) return "（stderr 为空）";
    const tail = txt.split(/\r?\n/).slice(-lines).join(" | ");
    return `\n  doclib stderr 尾部: ${tail}`;
  } catch {
    return "";
  }
}

async function status(home, token) {
  try {
    const r = await fetch(`${serviceBase(home)}/api/v1/server/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function putConfig(home, token, key, value) {  const r = await fetch(`${serviceBase(home)}/api/v1/configs/${key}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`PUT ${key} -> HTTP ${r.status}: ${await r.text()}`);
  return await r.json();
}

// 确保随包 MinerU basic 运行时就绪。幂等：服务已 healthy 就复用。
// 返回 { home, python, tier, configPath, endpoint, env }；env 交给 Object.assign(process.env, env)
// 后 src/lib/mineru.mjs 的 mineruConfig() 自然读到 BSP_MINERU_*，解析业务一行不用改。
export async function prepareMineru(resourcesDir, userData, { log = () => {} } = {}) {
  const p = runtimePaths(resourcesDir, userData);
  if (!fs.existsSync(p.python)) throw new Error(`缺少随包 Python: ${p.python}`);
  const manifest = path.join(p.models, "MinerU-4_models_onnx", ".mineru_files.json");
  if (!fs.existsSync(manifest)) throw new Error(`缺少随包 basic onnx 模型: ${p.models}`);

  const { configPath, token, generated } = writeConfig(p.home, p.models, log);
  log(`config ${generated ? "已生成" : "复用"} ${configPath}`);
  // 独立 cwd：doclib 与托管 parse-server 各拿各的 .mineru-service.lock，不跟别处抢
  fs.mkdirSync(p.cwd, { recursive: true });

  let s = await status(p.home, token);
  if (s && s.parse_server?.local?.healthy === true) {
    log(`复用已就绪 doclib (pid ${s.pid}, tier ${s.parse_server.local.managed_tier})`);
  } else {
    if (!s) {
      const env = { ...process.env, MINERU_HOME: p.home, PYTHONIOENCODING: "utf-8" };
      // stderr 落文件而不是 ignore：doclib 起不来时的真因（DACL 被拒、缺 VC 运行时、
      // 端口全占）只在这里能看到，丢掉它等于让用户和我们都只能看到「30s 没就绪」。
      const errLog = path.join(p.cwd, "doclib.stderr.log");
      let errFd = null;
      try { errFd = fs.openSync(errLog, "w"); } catch { /* 开不了就退回 ignore */ }
      const child = spawn(p.python, ["-m", "mineru.doclib.app"], {
        cwd: p.cwd, env, detached: true, windowsHide: true,
        stdio: ["ignore", errFd == null ? "ignore" : errFd, errFd == null ? "ignore" : errFd],
      });
      if (errFd != null) { try { fs.closeSync(errFd); } catch { /* 子进程已继承句柄 */ } }
      child.unref();
      log(`已拉起 doclib (pid ${child.pid}, cwd ${p.cwd}, stderr ${errLog})`);
    }
    for (let i = 0; i < 30 && !(s = await status(p.home, token)); i++) await sleep(1000);
    if (!s) throw new Error(`doclib 服务未在 30s 内就绪${tailLog(path.join(p.cwd, "doclib.stderr.log"))}`);
    // 顺序不能反：先 basic 再 managed，否则 mode=managed 会以默认 standard 校验、因 GGUF 缺失被拒
    const a = await putConfig(p.home, token, "parse_server.local.managed_tier", "basic");
    const b = await putConfig(p.home, token, "parse_server.local.mode", "managed");
    log(`档位已设 tier=${a.value} mode=${b.value}`);
  }

  // 等托管 parse-server healthy（basic 档预加载 onnx 小模型，冷启约 10~30s）
  for (let i = 0; i < 90; i++) {
    s = await status(p.home, token);
    if (s?.parse_server?.local?.healthy === true) break;
    await sleep(1000);
  }
  if (s?.parse_server?.local?.healthy !== true)
    throw new Error(`托管 parse-server 未 healthy: ${JSON.stringify(s?.parse_server?.local)}`);
  log(`READY tier=${s.parse_server.local.managed_tier} url=${s.parse_server.local.url}`);

  return {
    home: p.home, python: p.python, tier: "basic", configPath, token,
    endpoint: path.join(p.home, "doclib.endpoint.json"),
    env: { BSP_MINERU_PYTHON: p.python, BSP_MINERU_HOME: p.home, BSP_MINERU_TIER: "basic" },
  };
}
