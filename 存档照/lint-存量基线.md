# lint 存量基线 · 选择二登记

**登记时间**：2026-11-15 23:1x
**拍板**：爸爸选「选择二 —— 先登记、不修」
**判定**：8 条全部 **不阻塞**，本轮不修、不改 `eslint.config.mjs`、不跑 `--fix`。
**r4 状态**：零写入。

---

## 1. 8 条明细

复跑命令（限定本轮改动文件，口径固定）：

```
node node_modules/eslint/bin/eslint.js test/lib/judge.mjs test/lib/book-alias.mjs \
  test/quality-gate.mjs test/judge-test.mjs test/golden-verify.mjs \
  test/hallucination-fuzz.mjs test/graphrag-fuzz.mjs test/ftsliteral-test.mjs \
  src/feedback-export.mjs src/lib/search.mjs test/ipc-test.mjs
```

结果：`✖ 8 problems (8 errors, 0 warnings)`。原始输出见 `M0-改造前留档/lint-8-明细.txt`。

| # | 文件 | 行:列 | 规则 | 内容 | 性质 | 判定 |
|---|---|---|---|---|---|---|
| 1 | `src/lib/search.mjs` | 145:7 | `no-control-regex` | 正则里出现控制字符 `\x00` | 可能是**有意为之**的空字符匹配 | 不阻塞，**先查用途再动** |
| 2 | `src/lib/search.mjs` | 162:30 | `no-useless-escape` | 多写了 `\-` | 冗余符号 | 不阻塞 |
| 3 | `src/lib/search.mjs` | 182:9 | `no-useless-assignment` | 变量 `n` 赋值后未使用 | 冗余赋值 | 不阻塞 |
| 4 | `test/lib/judge.mjs` | 24:7 | `no-unused-vars` | `CLOSE` 定义未使用 | 冗余常量 | 不阻塞 |
| 5 | `test/quality-gate.mjs` | 108:106 | `no-useless-escape` | 多写了 `\|` | 冗余符号 | 不阻塞 |
| 6 | `test/quality-gate.mjs` | 112:43 | `no-useless-escape` | 多写了 `\^` | 冗余符号 | 不阻塞 |
| 7 | `test/quality-gate.mjs` | 114:42 | `no-useless-escape` | 多写了 `\.` | 冗余符号 | 不阻塞 |
| 8 | `test/quality-gate.mjs` | 256:7 | `no-unused-vars` | `HARD` 定义未使用 | 冗余常量 | 不阻塞 |

7 条是「写了没用上 / 多写了个符号」，1 条（#1）是正则里藏了个看不见的控制字符。程序照跑不误，不会卡住；但 #1 不能随手删 —— 得先确认它是不是故意用来匹配空字符的，删错了会真改行为。

**为什么这 8 条算存量**：方案 A 执行报告已记录「限定文件 lint 8 错，均不在本轮改动行内」；本次复跑条数、规则、文件完全一致，未见新增。

---

## 2. 和「全库 21852 个错」分开

| 口径 | 数量 | 来源 | 归属 |
|---|---|---|---|
| 全库 `eslint .` | **21852 errors / 23 warnings** | `runtime/mineru-python/Lib/site-packages/**` 第三方前端 JS，`eslint.config.mjs:8-19` 的 `ignores` 漏了 `runtime/**` | 配置噪声，与项目源码无关；Phase 5 加一行 ignores |
| 限定本轮 11 个改动文件 | **8 errors** | 上表 | 本文件登记的存量老账 |

**两个数字不许混着说**，否则又会误判「本轮改坏了两万行」。

---

## 3. 本轮判据（写死）

> **改动文件 0 新增错误。**

- 每次改完，用上面同一条命令复跑；
- 结果 ≤ 8 条且条目与上表一致 → 绿；
- 多出任何一条、或规则变了 → 红，算本轮引入，必须修；
- 全库 lint 只在 Phase 5 加完 `runtime/**` ignores 之后看，本轮**不作为判据**；
- 方案 Phase 5 的完成判据已按此修订，不再写「`lint 0`」。

---

## 4. 以后怎么还这笔老账

不阻塞 ≠ 永远不修。单独立一轮，条件满足再做：

1. 先查 `search.mjs:145` 的 `\x00` 用途，确认是不是有意匹配；
2. 其余 7 条一次性清掉（删冗余符号与未用常量）；
3. 加 `eslint.config.mjs` 的 `runtime/**` ignores；
4. 单独登记一轮台账、单独重拍存档照，**不混进长期改造这一轮**。

比喻：灯去年就坏了，今天贴张纸条写清楚「去年就坏的」，周末单独来修，不写进今天的大扫除日记。

---

## 5. 完成判据自检

- 8 条逐条可查（文件 / 行号 / 规则 / 内容）：✓
- 每条有「不阻塞」判定：✓
- 判据写明、复跑命令固定：✓
- r4 零写入、树指纹仍 `c1b164759f9113ac`：✓
