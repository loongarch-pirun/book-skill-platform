# 旧 eval 体系归档说明

> 2026-11-15 · 方案 A 执行留痕。本文件只做「哪套算数」的说明，不改写任何历史文档。

## 移除了什么

| 文件 | 原作用 | 去向 |
|---|---|---|
| `test/v2-eval.mjs` | 125 题关键词考卷 + 关键词命中判分 + `--rerank on/off/both` | `存档照/旧eval归档/v2-eval.mjs` |
| `test/eval-gate.mjs` | 与 `eval-baseline.json` 比分数、比漏题的双门回归门禁 | `存档照/旧eval归档/eval-gate.mjs` |
| `test/eval-baseline.json` | 2026-10-20 基线（e5 / 125 题 / 93 分 / rerankOff 79） | `存档照/旧eval归档/eval-baseline.json` |

三份原件完整保留在工作区 `D:\新建文件夹\2026-11-15-18-22-57\存档照\旧eval归档\`，可随时回滚。项目目录内已无这三个文件。

`package.json` 同步：`test:slow` 摘掉 `eval-gate.mjs`；`npm run eval` 与 `npm run test:gate` 现在都指向 `test/quality-gate.mjs`（同一处入口）。CI 本来就不跑 eval，无需改动。

## 现在唯一算数的口径

| 项 | 值 |
|---|---|
| 考卷 | `test/golden/*.json`，11 文件 / 80 题 / 指纹 `185ec42a62ad3845` |
| 判分尺子 | `test/lib/judge.mjs` 的 `judge()`：full / partial / miss |
| 闸门 | `test/quality-gate.mjs`，五项指标与 `quality-baseline.json` 比「不退化」 |
| 基线 | `quality-baseline.json`：0.725 / 0.725 / 3.837 / 0.45 / 0.0031，topN=4 |
| 向量引擎 | m3（bge-m3，1024 维） |

## 历史文档里的这些说法全部作废

`docs/` 下 20 余份、以及 `README.md` 里的下列表述属于旧体系，**只作历史归档，不再作为结论，也不逐份改写**：

- 88 分（46/52）、91 分（93/102）、93 分（116/125）、85 分整库重置等所有 eval 分数
- 「eval-gate 双门 ≥ 88 / ≥ 93」「漏题 ⊆ 基线」「只有净提升才允许改 eval-baseline.json」
- `docs/恢复手册.md` 的「eval ≥ 88」、`docs/结题验收单.md` 的「npm test 18 套」
- `npm run eval --rerank both` 的用法
- 任何以 e5 / 125 题为前提的分数对比

要查历史分数怎么来的，去归档原件；要查**当前**几分，只认 `quality-baseline.json` 与带日期的新跑批报告。

## 两个容易误删的地方（特意保留）

1. **`test/lib/judge.mjs` 的 `keywordOnlyJudge`**（兼容别名 `legacyJudge`）不是旧 eval 体系。它是新闸门自己的对照基准：`quality-gate.mjs` 的接缝自测要求它对切伤样本判 hit，防放水断言 `full > legacyHit` 也依赖它。删掉闸门会直接 import 报错。`quality-baseline.json` 里的 `legacyHit / legacyRate / seam.legacyHit` 是这些对照数据的字段名，同样保留原名（改名要重落基线，不划算）。
2. `BSP_LEGACY_JUDGE=1` 是闸门的翻转自检开关，不是旧体系入口，保留。

另外 `src/lib/search.mjs`、`src/feedback-export.mjs`、`test/ipc-test.mjs` 里出现的 `legacy` 指旧 PDF 解析回落，与 eval 无关，未改动。

## 顺带收敛的重复定义

书名 → `.db` 前缀的别名表原先在 `v2-eval.mjs` 与 `golden-verify.mjs` 各存一份。现统一到 `test/lib/book-alias.mjs`，由 `golden-verify.mjs` 与 `hallucination-fuzz.mjs` 共用。`hallucination-fuzz.mjs` 的门 3 也从「读 v2-eval.mjs 源码正则提 GOLDEN」改为「直接读 `test/golden/*.json`」。

## 功能影响与回滚

`src/` 里没有任何一处依赖旧 eval，桌面端、MCP、检索链路均不受影响。风险只在测试脚本入口，已逐处同步。

回滚：把归档目录里三份原件放回 `test/`，并把 `package.json` 的 `eval` / `test:slow` 改回原值即可。
