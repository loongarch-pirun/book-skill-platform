// test/judge-test.mjs —— 判分尺子翻转测试（P0-2）
//
// 判据（规划 P0-2）：「把答案句从块里切断、关键词保留 → 旧判据仍 PASS、新判据转 partial/miss」
//
// 本文件用**库里真实的接缝**做证据，不用编造的假块：
//   Dynamo   id=87 结尾 "The coordinator then sends the new version (along with"
//            id=88 开头 "the new vector clock) to the N highest-ranked reachable nodes."
//   attention id=48 结尾 "...self-attention layers are faster than recurrent layers when the sequence"
//            id=49 开头 "length n is smaller than the representation dimensionality d, ..."
// 这两处的答案句确实被切在接缝两侧，关键词却都在块里 —— 旧尺子必然判 hit。
//
// 翻转可复现：把 test/lib/judge.mjs 的 judge() 换成 legacyJudge()，本文件必红。
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { judge, legacyJudge, judgeAll, normText } from "./lib/judge.mjs";

const LIB = path.join(import.meta.dirname, "..", "library");
const file = (prefix) => {
  const f = fs.readdirSync(LIB).find(x => x.startsWith(prefix) && x.endsWith(".db"));
  if (!f) throw new Error(`找不到库文件 ${prefix}*.db`);
  return path.join(LIB, f);
};
const getChunks = (prefix, ids) => {
  const db = new Database(file(prefix), { readonly: true });
  const st = db.prepare("SELECT id, seq, page, chapter, text FROM chunks WHERE id IN (" + ids.map(() => "?").join(",") + ") ORDER BY id");
  const rows = st.all(...ids);
  db.close();
  return rows;
};

let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${extra}`); fail++; }
};

console.log("===== judge 翻转测试（P0-2）=====\n");

// ---------------------------------------------------------------- 样例 1：Dynamo 接缝
{
  console.log("[样例 1] Dynamo id=87/88 —— 答案句被切成两半");
  const [a87, a88] = getChunks("Dynamo-亚马逊高可用键值存储-2007.pdf", [87, 88]);
  const a = "Upon receiving a put() request for a key, the coordinator generates the vector clock for the new version and writes the new version locally. The coordinator then sends the new version (along with the new vector clock) to the N highest-ranked reachable nodes.";
  const golden = { q: "dynamo 接缝样例", a, g: ["vector clock", "coordinator"] };

  check("a 逐字来自原文（前半在 id=87）", normText(a87.text).includes(normText(a.slice(0, a.indexOf(" the new vector clock)")))));
  check("a 的后半在 id=88", normText(a88.text).includes("the new vector clock) to the N highest-ranked reachable nodes."));
  check("a 不完整落在 id=87", !normText(a87.text).includes(normText(a)));
  check("a 不完整落在 id=88", !normText(a88.text).includes(normText(a)));

  const both = [a87, a88];
  const oldV = legacyJudge(both, golden.g);
  const newV = judge(both, golden);
  console.log(`    旧尺子: hit=${oldV.hit} rank=${oldV.rank ?? "-"} (依据关键词 "${oldV.golden}")`);
  console.log(`    新尺子: level=${newV.level} rank=${newV.rank ?? "-"} —— ${newV.why}`);
  check("旧尺子判 hit（关键词在块里）", oldV.hit === true);
  check("新尺子判 partial（答案句被切开）", newV.level === "partial");
  check("新旧结论不同（这就是 P0-2 的翻转证据）", (oldV.hit === true) !== (newV.level === "full"));

  // 只检回第一块（topN=1 被掐掉邻块）时，新尺子仍要抓出损伤
  const onlyFirst = judge([a87], golden);
  console.log(`    只检回 id=87 时新尺子: level=${onlyFirst.level} —— ${onlyFirst.why}`);
  check("只检回一块时新尺子仍判 partial（不是 full）", onlyFirst.level === "partial");
  check("只检回一块时旧尺子仍判 hit", legacyJudge([a87], golden.g).hit === true);
  console.log();
}

// ---------------------------------------------------------------- 样例 2：attention 接缝
{
  console.log("[样例 2] attention id=48/49 —— 句子跨页被切开");
  const [a48, a49] = getChunks("attention-is-all-you-need-en.pdf", [48, 49]);
  const a = "In terms of computational complexity, self-attention layers are faster than recurrent layers when the sequence length n is smaller than the representation dimensionality d, which is most often the case with sentence representations used by state-of-the-art models in machine translations, such as word-piece [38] and byte-pair [31] representations.";
  const golden = { q: "attention 接缝样例", a, g: ["self-attention"] };

  check("a 前半在 id=48", normText(a48.text).includes("In terms of computational complexity, self-attention layers are faster than recurrent layers when the sequence"));
  check("a 后半在 id=49", normText(a49.text).includes("length n is smaller than the representation dimensionality d"));
  check("a 不完整落在任一块", !normText(a48.text).includes(normText(a)) && !normText(a49.text).includes(normText(a)));

  const both = [a48, a49];
  const oldV = legacyJudge(both, golden.g);
  const newV = judge(both, golden);
  console.log(`    旧尺子: hit=${oldV.hit} rank=${oldV.rank ?? "-"}`);
  console.log(`    新尺子: level=${newV.level} rank=${newV.rank ?? "-"} —— ${newV.why}`);
  check("旧尺子判 hit", oldV.hit === true);
  check("新尺子判 partial", newV.level === "partial");
  console.log();
}

// ---------------------------------------------------------------- 对照：完整句应判 full
{
  console.log("[对照] pride id=42 开篇句 —— 完整落在单块内，应判 full");
  const [p42] = getChunks("pride-and-prejudice-en.epub", [42]);
  const a = "IT is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife.";
  const golden = { q: "pride 开篇句", a, g: ["truth universally acknowledged"] };
  const v = judge([p42], golden);
  console.log(`    新尺子: level=${v.level} —— ${v.why}`);
  check("完整句判 full", v.level === "full");
  check("旧尺子也判 hit（完整句时两尺一致）", legacyJudge([p42], golden.g).hit === true);
  console.log();
}

// ---------------------------------------------------------------- 对照：完全没检到 → miss
{
  console.log("[对照] 完全检不到答案句 → miss");
  const golden = { q: "空检样例", a: "这是一句完全不存在的答案句。", g: ["完全不存在的关键词"] };
  const v = judge([{ id: 1, text: "some unrelated chunk text" }], golden);
  console.log(`    新尺子: level=${v.level} —— ${v.why}`);
  check("判 miss", v.level === "miss");
  check("旧尺子也 miss（这点两尺一致）", legacyJudge([{ text: "some unrelated chunk text" }], golden.g).hit === false);
  console.log();
}

// ---------------------------------------------------------------- 汇总口径自检
{
  console.log("[汇总] judgeAll 的六行指标口径");
  const s = judgeAll(
    {
      "q1": [{ id: 87, text: "Upon receiving a put() request for a key, the coordinator generates the vector clock for the new version and writes the new version locally. The coordinator then sends the new version (along with" }],
      "q2": [{ id: 42, text: "IT is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife." }],
    },
    [
      { q: "q1", a: "Upon receiving a put() request for a key, the coordinator generates the vector clock for the new version and writes the new version locally. The coordinator then sends the new version (along with the new vector clock) to the N highest-ranked reachable nodes.", g: ["vector clock"] },
      { q: "q2", a: "IT is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife.", g: ["truth universally acknowledged"] },
    ],
  );
  console.log(`    total=${s.total} full=${s.full} partial=${s.partial} miss=${s.miss} hitRate=${s.hitRate} damageRate=${s.damageRate} avgFirstRank=${s.avgFirstRank} legacyHit=${s.legacyHit}`);
  check("full 率 0.5（1/2）", s.fullRate === 0.5);
  // 切块损伤率 = partial ÷ hit（hit = full + partial = 2），这里 1 ÷ 2 = 0.5
  check("切块损伤率 partial÷hit = 0.5", s.damageRate === 0.5);
  check("旧尺子 2 题全 hit（比新尺子松）", s.legacyHit === 2);
  console.log();
}

console.log(fail ? `✗ judge 翻转测试失败：${fail} 项不通过` : "✓ judge 翻转测试全部通过");
process.exit(fail ? 1 : 0);
