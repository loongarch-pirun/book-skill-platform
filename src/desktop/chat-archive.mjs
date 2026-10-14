// V2 P4 云端回答存档：每次云端回答落一份快照（问题 + 引用片段原文 + 回答），可翻历史；
// 删书联动：删书时连引用了这本书的存档一起清——不给"删除残留"添新尾巴。
//
// 存放：<libDir>/chat-archive/archive.jsonl（跟书库走：换库目录天然隔离；
// 备份脚本对 libDir 直接拷贝，见 backup.mjs）。一行一条 JSON，追加写。
// 零依赖（node:fs / node:path）；libDir 由调用方显式传入（chat.mjs 传 dirs().libDir，测试传 tmp）。
import fs from "node:fs";
import path from "node:path";

// 上限防无界增长：超出砍最旧（个人规模 500 条够用；读全量重写，n≤500 成本可忽略）
const MAX_ENTRIES = 500;

function archivePath(libDir) { return path.join(libDir, "chat-archive", "archive.jsonl"); }

// 读全量行；没有存档文件（首次使用/还没答过）= 空列表——读失败也按空处理，不挡调用方
function readLines(libDir) {
  try {
    return fs.readFileSync(archivePath(libDir), "utf8").split("\n").filter((l) => l.trim());
  } catch { return []; }
}

function writeLines(libDir, lines) {
  fs.mkdirSync(path.join(libDir, "chat-archive"), { recursive: true });
  fs.writeFileSync(archivePath(libDir), lines.join("\n") + "\n", "utf8");
}

// 追加一条快照（entry 由调用方备料：question/answer/mode/book/model/segments/dropped/usage/citations）；
// 超上限自动砍最旧。写失败会抛——调用方（chat.mjs）必须 try 兜底：存档失败绝不能炸掉回答。
export function appendArchive(libDir, entry) {
  const lines = readLines(libDir);
  lines.push(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
  writeLines(libDir, lines.slice(-MAX_ENTRIES));
}

// 列表：新 → 旧，limit 封顶（UI 翻历史用）。坏行跳过不挡好数据。
export function listArchive(libDir, { limit = 100 } = {}) {
  const lines = readLines(libDir);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try { out.push(JSON.parse(lines[i])); } catch { /* 坏行跳过 */ }
  }
  return out;
}

// 删书联动：清掉 citations 引用了这本书的全部条目，返回清了几条（0 = 没动文件）。
// 坏行保守保留（解析不了的不敢删，防误杀）；一条都不匹配时不重写文件。
export function purgeBook(libDir, bookId) {
  const lines = readLines(libDir);
  const kept = lines.filter((l) => {
    try {
      const e = JSON.parse(l);
      return !(e.citations || []).some((c) => c && c.bookId === bookId);
    } catch { return true; }
  });
  const removed = lines.length - kept.length;
  if (removed > 0) writeLines(libDir, kept);
  return removed;
}

// 清空全部存档（UI「清空存档」用）；本来就没有也算成功。
export function clearArchive(libDir) {
  try { fs.rmSync(archivePath(libDir), { force: true }); } catch { /* 没有存档文件 */ }
}
