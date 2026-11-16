#!/usr/bin/env node
/**
 * 从冻结的 v2 卷导出人可读试卷（Markdown）
 * 保证试卷与冻结卷一致：只读 sets/holdout-v2.json + frozen-v2.json，不手写题目
 * 跑法：node 导出试卷v2.cjs
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const R4 = "C:/Users/JIANG XIAO HUA/Desktop/book-skill-platform-r4";
const HOLD = path.join(R4, "test", "holdout");
const frozen = JSON.parse(fs.readFileSync(path.join(HOLD, "frozen-v2.json"), "utf8"));
const set = JSON.parse(fs.readFileSync(path.join(R4, frozen.file), "utf8"));

const KIND_CN = { answerable: "有答案", newbook: "新书题", refusal: "拒答", ambiguous: "歧义" };
const LANG_CN = { zh: "中文问中文书", en: "英文问英文书", cross: "中文问英文书（跨语言）" };

const rows = set.items;
const ans = rows.filter((r) => r.kind === "answerable" || r.kind === "newbook");
const ref = rows.filter((r) => r.kind === "refusal");
const amb = rows.filter((r) => r.kind === "ambiguous");

const L = [];
L.push("# 留出集 v2 · 独立试卷（30 题）");
L.push("");
L.push("> 冻结凭证：`test/holdout/frozen-v2.json`，sha256 `" + frozen.sha256 + "`");
L.push("> 冻结时间：" + frozen.frozenAt + "　题数：" + set.total + "　构成：" + JSON.stringify(set.byKind));
L.push("> 语言分布：" + JSON.stringify(set.byLang) + "（中文问中文书 / 英文问英文书 / 中文问英文书）");
L.push("> 本文件由脚本从冻结卷导出，**不是手抄**；题目与答案与卷子逐字一致。");
L.push("");
L.push("---");
L.push("");
L.push("## 一、有答案题（18 题：16 有答案 + 2 新书）");
L.push("");
L.push("答案句 = 原文逐字切片。判分不认「意思对」，只认**这一句有没有被检索到**。");
L.push("");
for (const it of ans) {
  L.push("### " + it.id + "　[" + KIND_CN[it.kind] + " · " + LANG_CN[it.lang] + "]");
  L.push("");
  L.push("**题目**：" + it.q);
  L.push("");
  L.push("**出处**：`" + it.book + "` 第 " + it.chunk_id + " 块");
  L.push("");
  L.push("**标准答案（" + it.a.length + " 字）**：");
  L.push("");
  L.push("> " + it.a.replace(/\n/g, " "));
  L.push("");
  L.push("**判分金词**：`" + (it.g || []).join("` / `") + "`");
  L.push("");
}
L.push("---");
L.push("");
L.push("## 二、拒答题（8 题）");
L.push("");
L.push("**判据**：系统返回的块里**不得出现**下列判定词（该词在 13 本书里 0 命中，出现即等于编造/串书）。");
L.push("");
L.push("| 题号 | 提问 | 目标书 | 判定词 |");
L.push("|---|---|---|---|");
for (const it of ref) L.push(`| ${it.id} | ${it.q} | ${it.book} | \`${it.absent[0]}\` |`);
L.push("");
L.push("---");
L.push("");
L.push("## 三、歧义题（4 题）");
L.push("");
L.push("**判据**：`ambiguous === true` 或 `routed_books.length >= 2`（即系统要承认「多本书都可能」）。");
L.push("");
L.push("| 题号 | 提问 | 为什么算歧义 |");
L.push("|---|---|---|");
const why = {
  V27: "「那段话」没有指代对象，任何排序器都只能猜",
  V28: "「道」在道德经/孟子/论语里都讲，5 本书有命中",
  V29: "「这本书」没有指代对象",
  V30: "「那个实验」在 5 本书里都有实验描述",
};
for (const it of amb) L.push(`| ${it.id} | ${it.q} | ${why[it.id] || "多书可答"} |`);
L.push("");
L.push("---");
L.push("");
L.push("## 四、评分标准");
L.push("");
L.push("### 4.1 每题 1 分，满分 30 分");
L.push("");
L.push("| 题型 | 题数 | 得分条件 |");
L.push("|---|---|---|");
L.push("| 有答案 | 16 | `judge()` 判为 `full` 或 `partial` 得 1 分；`miss` 得 0 分 |");
L.push("| 新书题 | 2 | 同上；另单独记录「挑书是否命中本尊」 |");
L.push("| 拒答 | 8 | 返回块中不出现判定词得 1 分；出现任一判定词得 0 分 |");
L.push("| 歧义 | 4 | `ambiguous===true` 或 `routed>=2` 得 1 分 |");
L.push("");
L.push("### 4.2 judge() 三级判据（有答案题）");
L.push("");
L.push("| 级别 | 定义 | 计分 |");
L.push("|---|---|---|");
L.push("| `full` | 标准答案句**完整落在某一个命中块里** | 1 |");
L.push("| `partial` | 答案句被切成两半、两块钱拼起来才完整；或命中块里只有答案句前半截（≥一半且≥4 字） | 1 |");
L.push("| `miss` | 命中结果里找不到答案句 | 0 |");
L.push("");
L.push("> `partial` 也算对，但它单独统计为「切块损伤」——损伤率高说明切片策略有问题，不是检索问题。");
L.push("");
L.push("### 4.3 检索口径");
L.push("");
L.push("- 30 题**全部走 `routeAndSearch`**（全库自动挑书），不预先指定书；");
L.push("- `topN=5`、`maxBooks=4`；");
L.push("- 只看返回的前 5 条结果，不看第 6 条以后。");
L.push("");
L.push("### 4.4 判定线（本卷已实测，作对照基准）");
L.push("");
L.push("| 组 | 总通过 | 有答案 | 新书 | 拒答 | 歧义 | 挑书本尊 | 单题耗时 |");
L.push("|---|---|---|---|---|---|---|---|");
L.push("| 现行代码（P1+P2） | **26/30 = 86.7%** | 14/16 | 1/2 | 8/8 | 3/4 | 18/18 | 7921 ms |");
L.push("| 对照组（`BSP_ROUTE=0`，改造前行为） | 26/30 = 86.7% | 14/16 | 1/2 | 8/8 | 3/4 | 18/18 | 12528 ms |");
L.push("");
L.push("**两者同分同题**——改造只改「扫哪几本」，不改「怎么打分」。差异只在耗时（−36.8%）。");
L.push("");
L.push("### 4.5 四道未过题（已定位，属检索难度，不是判据问题）");
L.push("");
L.push("| 题号 | 现象 | 性质 |");
L.push("|---|---|---|");
L.push("| V11 | 孟子「解诗」答案句未被召回 | 书内排名不足 |");
L.push("| V12 | 简爱「bolted my door」答案句未被召回 | 书内排名不足 |");
L.push("| V18 | 论语 pdf「慎終追遠→民德歸厚」未被召回 | 新书、块极短（181 字），排名不足 |");
L.push("| V28 | 「道」只挑了 1 本书，未体现多书可答 | 挑书门槛（floor 0.3）把其余书挡掉 |");
L.push("");
L.push("---");
L.push("");
L.push("## 五、与 v1 的关系");
L.push("");
L.push("| 项 | v1 | v2 |");
L.push("|---|---|---|");
L.push("| 题数 / 构成 | 30（16+2+8+4） | 30（16+2+8+4） |");
L.push("| 覆盖 | 13 本全覆盖 | 13 本全覆盖 |");
L.push("| 原文块复用 | — | **0**（与 v1 零交集） |");
L.push("| 题干最高相似度 | — | **0.387**（3-gram Jaccard，V23~H22） |");
L.push("| 得分 | 27/30 = 90.0% | 26/30 = 86.7% |");
L.push("");
L.push("v2 比 v1 低 3.3 个点，符合预期：v1 出题时对题库还不熟，v2 刻意挑了更靠后的块与更难的跨语言问法（cross 12 道 vs v1 9 道）。**这 3.3 个点不是退化，是两卷难度不同，不能直接相减。**");
L.push("");
L.push("**方法学限制（必须写明）**：v2 起草时我已知道 v1 的三道漏题在哪。虽然保证了「不复用同一块原文、不复用同一句题干」，但无法保证「出题时不受已知缺陷影响」。因此 v2 的分数适合当**独立参照**，不宜当作「与 v1 严格同难度的平行卷」。");

const out = path.join(__dirname, "..", "试卷-v2-2026-11-16.md");
fs.writeFileSync(out, L.join("\n") + "\n");
console.log("试卷已导出：", path.resolve(out));
console.log("行数：", L.length, "| 题数：", rows.length);
