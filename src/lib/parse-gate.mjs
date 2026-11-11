// 解析入口闸（判定表 R1/R2 + R13 台账）：把一个文件「是不是书」判死，判据全部来自文件本身。
// 铁律：任一输入唯一落一个结果，不出现「看情况」；判定只看字节与扩展名，不看文件名语义。
//
// R1 扩展名白名单：不在白名单 → code="unsupported"，拒收并记账。
// R2 魔数 ≠ 扩展名：.pdf 其实是 zip / .epub 其实是纯文本 / .md 其实是二进制 → code="fake_ext"。
//   判据来源（实测）：
//     %PDF-   PDF 规范文件头；实测 pdfjs 6.x 对前 1024 字节内出现即接受（部分生成器前面垫空行）
//     PK\x03\x04  zip local file header（epub 与 docx 都是 zip 容器）
//     NUL 字节  文本文件里出现 \x00 = 二进制（.md/.txt/.markdown 的反向判据）
// R13 台账：被拒的文件追加一行 JSON 到 rejectLog，供后续按 reason 重试/排查——不入检索。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 白名单与设计稿 01:80 一致（pdf/epub/docx/txt/md）；.markdown 是现有 build-book 已支持的别名，
// 一并收进白名单——否则「白名单放行、分派报错」会自相矛盾。
export const EXT_WHITELIST = [".pdf", ".epub", ".docx", ".txt", ".md", ".markdown"];
const ZIP_EXTS = [".epub", ".docx"];
const TEXT_EXTS = [".txt", ".md", ".markdown"];
const PK_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PDF_SIG = Buffer.from("%PDF-", "latin1");

// 读文件头 1024 字节做魔数判定。文件打不开（权限/被占用）抛错由调用方接。
export function sniffMagic(file, size = 1024) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size);
    const n = fs.readSync(fd, buf, 0, size, 0);
    const head = buf.subarray(0, n);
    return {
      head,
      size: fs.fstatSync(fd).size,
      isPdf: head.indexOf(PDF_SIG) >= 0,
      isZip: head.length >= 4 && head.subarray(0, 4).equals(PK_SIG),
      hasNul: head.includes(0),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function describeMagic(s) {
  if (s.isZip) return "zip 容器（PK\\x03\\x04）";
  if (s.hasNul) return "二进制（含 NUL 字节）";
  const ascii = s.head.subarray(0, 8).toString("latin1").replace(/[^\x20-\x7e]/g, ".");
  return `前 8 字节 "${ascii}"`;
}

// 入口判定：返回 {ok:true, ext, magic} 或 {ok:false, code, ext, reason}。
// code 只有两种：unsupported（R1）/ fake_ext（R2）——上层按 code 决定提示文案与是否重试。
export function gateFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (!EXT_WHITELIST.includes(ext)) {
    return {
      ok: false, code: "unsupported", ext,
      reason: `扩展名「${ext || "(无扩展名)"}」不在白名单（${EXT_WHITELIST.join(" / ")}），拒收`,
    };
  }
  const s = sniffMagic(file);
  if (s.size === 0) {
    return { ok: false, code: "unsupported", ext, reason: "空文件（0 字节），拒收" };
  }
  if (ext === ".pdf" && !s.isPdf) {
    return { ok: false, code: "fake_ext", ext, reason: `伪装扩展名：名为 .pdf 但文件头没有 %PDF-，实际是${describeMagic(s)}` };
  }
  if (ZIP_EXTS.includes(ext) && !s.isZip) {
    return { ok: false, code: "fake_ext", ext, reason: `伪装扩展名：名为 ${ext} 但文件头不是 zip，实际是${describeMagic(s)}` };
  }
  if (TEXT_EXTS.includes(ext) && s.hasNul) {
    return { ok: false, code: "fake_ext", ext, reason: `伪装扩展名：名为 ${ext} 但内容是${describeMagic(s)}，不是文本` };
  }
  return { ok: true, ext, magic: { isPdf: s.isPdf, isZip: s.isZip } };
}

// ---------- R13 台账：被拒/解析失败的文件记账（不建库、不入检索，可事后按 reason 排查） ----------
// 默认落在仓库根 library/_rejected.jsonl（与 build-book 默认输出目录同源，src/../library）；
// BSP_REJECT_LOG 可覆盖。只追加一个账文件，绝不碰任何 .db。
export function rejectLogPath() {
  const env = process.env.BSP_REJECT_LOG;
  if (env) return path.resolve(env);
  return path.join(__dirname, "..", "..", "library", "_rejected.jsonl");
}

// rec: {file, ext, stage, code, reason, extra}；stage 记「在哪一道被拦」：gate / parse
export function appendReject(rec, logPath = rejectLogPath()) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    host: os.hostname(),
    ...rec,
    file: rec.file ? path.resolve(rec.file) : null,
  });
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line + "\n", "utf8");
    return { ok: true, path: logPath };
  } catch (e) {
    // 记账失败不能把「拒收」这个正确结果变成崩溃：返回错误由调用方打印一行警告
    return { ok: false, path: logPath, error: e.message };
  }
}
