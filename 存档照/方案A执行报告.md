# 方案 A 执行报告

> 2026-11-15 21:00~21:30 · 双轨二选一落地。**不提供新旧选择，直接切到新体系**；旧 eval 作为可运行的评测门禁整体移出，关键词对照器保留为新闸门的自检基准。

## 结论

旧 eval 体系已从项目目录彻底移除，`npm run eval` 与 `npm run test:gate` 收敛到同一处入口 `test/quality-gate.mjs`。当前唯一算数的口径是 80 题答案句考卷 + 三级尺子 + `quality-baseline.json`。

已验证的部分全部通过；全库 lint / 全量回归 / 闸门现跑受本机环境限制未能跑完，如实列在下面。

---

## 一、改动范围

### 移出项目（3 个，原件完整保留）

| 文件 | 原作用 | 归档位置 |
|---|---|---|
| `test/v2-eval.mjs` | 125 题关键词考卷 + 关键词判分 | `存档照/旧eval归档/v2-eval.mjs`（25048 B） |
| `test/eval-gate.mjs` | 双门回归门禁 | `存档照/旧eval归档/eval-gate.mjs`（4996 B） |
| `test/eval-baseline.json` | 10-20 基线（e5 / 125 / 93） | `存档照/旧eval归档/eval-baseline.json`（1841 B） |

### 新增（2 个）

| 文件 | 作用 |
|---|---|
| `test/lib/book-alias.mjs` | 书名 → `.db` 前缀的唯一正本（5 条映射 + `resolveBookPrefix`），消除原先两处重复定义 |
| `docs/旧eval体系归档说明.md` | 写清「哪套算数」「历史文档哪些说法作废」「什么特意保留」「怎么回滚」 |

### 修改（11 个）

`package.json`、`README.md`、`test/lib/judge.mjs`、`test/quality-gate.mjs`、`test/judge-test.mjs`、`test/golden-verify.mjs`、`test/hallucination-fuzz.mjs`、`test/graphrag-fuzz.mjs`、`test/ftsliteral-test.mjs`、`test/ipc-test.mjs`、`src/feedback-export.mjs`、`src/lib/search.mjs`（后四个只改注释/文案）。

### 特意保留（不属于旧 eval 体系）

- `keywordOnlyJudge`（兼容别名 `legacyJudge`）：闸门的接缝自测与防放水断言基准，删掉闸门 import 就报错
- `BSP_LEGACY_JUDGE=1`：闸门翻转自检开关
- `quality-baseline.json` 的 `legacyHit / legacyRate / seam.legacyHit`：字段名沿用，改名要重落基线
- `src/lib/search.mjs` 等处的 `legacy` 字样：指旧 PDF 解析回落，与 eval 无关

---

## 二、同步更新的调用点与依赖（逐条核对）

| 调用点 | 原来依赖 | 处理 | 状态 |
|---|---|---|---|
| `package.json:14` `test:slow` | `node test/eval-gate.mjs` | 摘掉 | ✓ `npm test` 不再引用 |
| `package.json:18` `eval` | `v2-eval.mjs --rerank both` | 改为 `node test/quality-gate.mjs` | ✓ 与 `test:gate` 同入口 |
| `test/eval-gate.mjs:22` | spawn `v2-eval.mjs` | 随文件整体移出 | ✓ |
| **`test/hallucination-fuzz.mjs:194`** | **读 `v2-eval.mjs` 源码、正则提 GOLDEN 字面量** | 改为读 `test/golden/*.json` 80 题，书名从文件名取 | ✓ 门3 两断言 PASS |
| `test/golden-verify.mjs:19-26` | 本地 `BOOK_ALIAS` 副本（注释指向 v2-eval） | 改 import `test/lib/book-alias.mjs` | ✓ `golden-verify` EXIT=0 |
| `test/quality-gate.mjs:79` | import `legacyJudge` | 改 import `keywordOnlyJudge` | ✓ 无 `legacyJudge(` 残留 |
| `test/quality-gate.mjs:331/473` | 调用 `legacyJudge` | 改调 `keywordOnlyJudge` | ✓ |
| `test/quality-gate.mjs:734` | `full > legacyHit` 防放水断言 | 保留字段名，文案改「关键词对照器」 | ✓ 逻辑未动 |
| `test/judge-test.mjs:16/53/65/81` | import + 3 处调用 | 同步改新名 | ✓ 全通过 EXIT=0 |
| `test/lib/judge.mjs:43/72/77` | 定义 + 2 处内部调用 | 主名改新名 + 保留兼容别名 | ✓ 两者同一函数 |
| 注释引用 6 处 | `v2-eval / eval-gate` 字样 | 改指向 `src/lib/search.mjs` 或「质量门」 | ✓ 扫描为空 |
| `.github/workflows/ci.yml` | 9 个独立测试步骤 | **未跑 eval，无需改** | ✓ |
| `src/` 功能代码 | 无一处依赖旧 eval | 只改 2 个文件的注释/文案 | ✓ 功能零影响 |

残留引用扫描（排除归档说明性文字）结果为空。

---

## 三、验证结果

| 项 | 结果 |
|---|---|
| 8 个改动文件 `node --check` | **全 OK** |
| `node test/judge-test.mjs` | **✓ 翻转测试全部通过，EXIT=0**（对照器改名后闸门自检仍有效） |
| `node test/golden-verify.mjs` | **EXIT=0**：80 题 `a` 全在书里、起点合法 80、终点合法 79（1 条记账，不作废） |
| `node test/hallucination-fuzz.mjs` 门 1~3 | **26 PASS / 0 FAIL**；门3 提取 80 题、金词回原文全验真、缺库跳过 0 题 |
| 导出自检 | `keywordOnlyJudge` / `legacyJudge` / `judge` 均为 function，别名与主名同一函数；别名表 5 条映射正确 |
| 脚本入口自检 | `eval` = `test:gate` = `node test/quality-gate.mjs`；`test:slow` 已不含 eval-gate |
| 残留引用扫描 | 代码/配置/README/CI 中为空 |
| 一致性核对 | 台账 84 条 / 17 节，覆盖 U=60 个文件，**60/60 = 100%** |

### 未能跑完的项（如实标注）

| 项 | 原因 |
|---|---|
| `npm run lint`（全库） | 进程被环境 SIGTERM（全库扫描资源/时限），退出无输出。**非本次改动引入** |
| 限定改动文件的 `npx eslint` | 跑出 **8 个存量错误**，全部位于**未改动的代码行**：`src/lib/search.mjs:145/162/182`（no-control-regex / no-useless-escape / no-unused-assignment）、`test/lib/judge.mjs:24`（`CLOSE` 未使用）、`test/quality-gate.mjs:108/112/114/256`（no-useless-escape / `HARD` 未使用）。本次改动的行号均不在错误列表内，**零新增 lint 错误**。这些存量问题不在方案 A 范围，未动 |
| `npm run test:fast` / `npm test` | 需真书库 + 本地向量模型，本机环境跑不动（同类命令已两次 SIGTERM） |
| `node test/quality-gate.mjs` 现跑 | 15~25 分钟且会覆盖 `quality-gate-run.log`、改变存档照；未跑。**闸门本身只做了语法检查 + 动态 import 的导出自检** |
| `--topN=1` 翻转判据 | 同上，依赖现跑，未跑 |
| `hallucination-fuzz` 门 4 | 加载向量模型时被 SIGTERM；门 1~3 已完整通过 |

**因此「删除后不影响现有功能」的判断依据是**：`src/` 无任何旧 eval 依赖、8 文件语法全过、新体系三套关键测试全绿、隐藏依赖两处已改并验证、脚本入口自检通过；而不是「全量回归绿了」——全量回归没跑起来。

---

## 四、存档照变化

| 项 | 改动前 | 方案 A 后 |
|---|---|---|
| 快照编号 | `r4-snapshot-20261115` | `r4-snapshot-20261115-b` |
| 树指纹 | `f654586be8aea832` | `c1b164759f9113ac`（`previousTreeSha16` 自动保留前序） |
| 纳入文件 | 252 | 251 |
| 考卷 / 引擎 / 基线 | `185ec42a62ad3845` / m3 / 0.725 五项 | **未变** |

五元组未变，故 `quality-baseline.json` 不作废，只重拍树指纹。

---

## 五、回滚

三份移出的原件完整可恢复：放回 `test/`，再把 `package.json` 的 `eval` / `test:slow` 改回原值，旧体系即可复活；新增的别名表与归档说明删掉不影响回滚。

**但要如实说明**：本次修改过的 12 个文件**没有逐份备份「改动前内容」**。`version-manifest.json` 的前序指纹 `f654586be8aea832` 只能用来确认「现在跟改动前不一样」，不能用来还原内容。要完整还原需从主仓库 git 历史取（本次按访问红线未越界），或按本报告的改动点逐处手动改回。

---

## 六、下一步（未做，按原顺序）

1. 用当前代码真跑一次闸门 + `test:fast` + `lint` + 打包三层验收，留带日期的报告
2. 处理上面 8 个存量 lint 错误（单独一轮，别混进本轮）
3. 再开会谈产品化（真机 79 项、隐私声明、1.8G 包体、性能门）
