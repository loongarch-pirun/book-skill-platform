// golden-verify.mjs —— P0-3 校验器
//
// 判据（规划 §四 P0-3）：「`a` 不在任何块里的题 → 校验器报红」。
// 本校验器做三件事，逐条打印，���一条不成立就 exit 1：
//   1) a 必须逐字出现在该书某个 chunk.text 里（chunk.text.includes(a)）
//   2) a 的起点必须是块首或上一句句读之后（虾虾定的 full 条件）
//   3) a 的终点必须以硬句读收尾（块内末句允许软句读收尾）
//   —— 2/3 不成立不算「作废」，但会单独列成「不完整」清单（记账用）。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { resolveBookPrefix } from "./lib/book-alias.mjs";
const require = createRequire("C:/Users/JIANG XIAO HUA/Desktop/book-skill-platform-r3/package.json");
const Database = require("better-sqlite3");

const R4 = path.resolve(import.meta.dirname, "..");
const LIB = path.join(R4, "library");
const GOLDEN_DIR = path.join(R4, "test", "golden");

// 书名 → .db 前缀的唯一正本在 test/lib/book-alias.mjs（旧 eval 体系移除后收敛）。

const HARD = ".!?。！？";
const SOFT = ";：;:";

const dbCache = new Map();
function rowsOf(book) {
  if (dbCache.has(book)) return dbCache.get(book);
  const want = resolveBookPrefix(book);
  const f = fs.readdirSync(LIB).find(x => x.startsWith(want) && x.endsWith(".db"));
  if (!f) throw new Error(`找不到库文件 ${want}*.db`);
  const db = new Database(path.join(LIB, f), { readonly: true });
  const rows = db.prepare("SELECT id, text FROM chunks ORDER BY id").all();
  db.close();
  dbCache.set(book, rows);
  return rows;
}

let total = 0, inLib = 0, startOk = 0, endOk = 0;
const bad = [], soft = [];

for (const file of fs.readdirSync(GOLDEN_DIR).filter(x => x.endsWith(".json")).sort()) {
  const book = file.replace(/\.json$/, "");
  const arr = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, file), "utf8"));
  const rows = rowsOf(book);
  for (const it of arr) {
    total++;
    const where = rows.filter(r => r.text.includes(it.a));
    if (!where.length) {
      bad.push({ book, q: it.q, why: "a 不在任何块里" });
      console.log(`✗ [${book}] 「${it.q}」—— a 不在任何块里`);
      continue;
    }
    inLib++;
    const r = where[0];
    // 起点：a 之前的位置必须是块首或句读之后
    // （a 切出时做过 trim，前导空白可能留在 a 前面，判起点时先去掉尾部空白）
    const at = r.text.indexOf(it.a);
    const before = r.text.slice(0, at).replace(/\s+$/, "");
    const sOk = before.length === 0 || HARD.includes(before[before.length - 1]) || SOFT.includes(before[before.length - 1]);
    // 终点：a 末尾是硬句读；或它是块内最后一句且以软句读收尾
    // （闭引号/右括号紧跟句读是中文排版常态，去掉后再判）
    const bare = it.a.replace(/[”"’'）】」』)\]]+$/, "");
    const last = bare[bare.length - 1];
    let eOk = HARD.includes(last);
    if (!eOk) {
      const tail = r.text.slice(at + it.a.length).replace(/^\s+/, "");
      eOk = SOFT.includes(last) && tail.length === 0;
    }
    if (sOk) startOk++;
    if (eOk) endOk++;
    if (!sOk || !eOk) {
      soft.push({ book, q: it.q, chunk: r.id, startOk: sOk, endOk: eOk, a: it.a });
    }
    console.log(`✓ [${book}] #${r.id} 含a | 起点${sOk ? "OK" : "非句首"} | 终点${eOk ? "OK" : "未以句读收尾"} | 「${it.q}」`);
  }
}

console.log(`\nGOLDEN 校验：共 ${total} 题 | a 在书里 ${inLib} | 起点合法 ${startOk} | 终点合法 ${endOk}`);
if (bad.length) {
  console.log(`\n===== 硬失败（必须报红）=====`);
  for (const b of bad) console.log(`  [${b.book}] 「${b.q}」—— ${b.why}`);
}
if (soft.length) {
  console.log(`\n===== 不完整清单（记账，不作废）=====`);
  for (const s of soft) console.log(`  [${s.book}] #${s.chunk} 「${s.q}」 起点${s.startOk ? "OK" : "非句首"} 终点${s.endOk ? "OK" : "未以句读收尾"}`);
  for (const s of soft) console.log(`     a: ${JSON.stringify(s.a)}`);
}
process.exit(bad.length ? 1 : 0);
