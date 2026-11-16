# routeCfg / 动态配额 / BSP_ROUTE=0 · 纸面定稿（M0 ④）

> 用途：**冻结后照抄即可改码**，不留设计空白。
> 采集时间：2026-11-16 00:40，口径以 `r4` 树指纹 `c1b164759f9113ac` 为准。
> 本文件只定设计，**不改一行代码**。

---

## 0. 三条铁律（先摆在这，后面所有细节都服从它）

1. **env 一律在调用时读，不在模块顶层读**。现在的 4 个 `BSP_ROUTE_*` 是模块顶层 const，改 env 必须重启进程 —— 桌面端长驻，等于假开关。`routeCfg()` 在 `routeAndSearch` 入口取一次快照，既让开关真生效，又保证**一次问答内参数不漂移**。
2. **默认值 = 旧值，逐字不变**。8 个常量的默认回退值与 `参数快照.md` 表 1 完全一致；新增的两个开关默认值也必须是「旧行为」。
3. **下行签名只改 3 个函数、4 行**。`tightPick` / `bookSignal` 的调用点全在 `routeAndSearch` 内部（`:544` 定义、`:553` 自调、`:610`、`:619`），`hybridSearch` 完全不碰 —— 这是本次改动能做到「最小侵入」的事实依据。

---

## 1. `routeCfg()` 形状（替换 `search.mjs:507-517`）

```js
// 路由参数单一常量区（原 :507-517）。改为只读快照：每次问答取一次，问答内不漂移。
// 为什么不在顶层读 env：桌面端进程长驻，顶层 const 让 BSP_ROUTE_* 变成假开关（改 env 需重启）。
const ROUTE_DEFAULTS = Object.freeze({
  minLen: 60, sigTopK: 3, books: 8, keep: 10,
  refW: 0.5, poolCap: 48, floorRatio: 0.3,
});

function routeCfg() {
  const d = ROUTE_DEFAULTS;
  const num = (v, fb, lo, hi) => {
    const x = +(v ?? fb);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fb;
  };
  const poolEnv = process.env.BSP_ROUTE_POOL;           // "auto" | 数字 | 未设
  return Object.freeze({
    enabled: process.env.BSP_ROUTE !== "0",             // 总闸：0 = 旧三段式全库扫描
    minLen: num(process.env.BSP_ROUTE_MINLEN, d.minLen, 0, 100000),
    sigTopK: d.sigTopK,                                  // 无开关，保持硬编码
    books: num(process.env.BSP_ROUTE_BOOKS, d.books, 1, 64),
    keep: num(process.env.BSP_ROUTE_K, d.keep, 2, 64),
    refW: num(process.env.BSP_ROUTE_REFW, d.refW, 0, 1),
    poolCapMode: poolEnv === "auto" ? "auto" : "fixed",
    poolCapFixed: poolEnv === "auto" ? d.poolCap : num(poolEnv, d.poolCap, 1, d.poolCap),
    poolCapHardMax: d.poolCap,                           // 48 硬上界，绝不突破
    floorRatio: d.floorRatio,                            // 0.3 默认不变
    rerankBudgetMs: num(process.env.BSP_RERANK_BUDGET_MS, 6000, 1000, 60000),
    rerankCostMs: 128,                                   // 无观测回退值（串行逐条实测）
  });
}
```

**为什么 `poolCapFixed` 上界写死在 48**：串行 rerank 线性延迟（`models.mjs:90-98` 是 `for` 逐条），扩池会推高 `quality-baseline.json` 里 `latency.avgLatencyMs=24498` 的可感知延迟，还会改池内分位 → 动 `floor`（`:685`）→ 动入选本数 → 破 `stage3-mcp-test.mjs:116` 的 `<=4` 契约。

---

## 2. 下行签名（只动 4 行）

```js
// :544
function tightPick(rows, n, cfg) {                    // 原 (rows, n)
  const out = [];
  for (const r of rows) if (r.len >= cfg.minLen) { out.push(r); if (out.length >= n) return out; }
  for (const r of rows) if (r.len <  cfg.minLen) { out.push(r); if (out.length >= n) break; }
  return out;
}

// :552
function bookSignal(rows, cfg) {                      // 原 (rows)
  const pick = tightPick(rows, cfg.sigTopK, cfg);     // 原 tightPick(rows, ROUTE_SIG_TOPK)
  ...
}
```

调用点三处：
- `:610` `const sig = bookSignal(res.rows, cfg);`
- `:619` `for (const r of tightPick(rows, cfg.keep, cfg))`
- `:618` `scanned.slice(0, cfg.books)`

`bookSignal` 只在 `:610` 被调用，`tightPick` 只有 `:553 / :619` 两处 —— 已全量 grep 确认，无遗漏调用者。

---

## 3. 动态配额公式

```
candidateBlockCount = min(scanned.length, cfg.books) × cfg.keep     // 入池前已知，零额外成本
autoCap             = clamp(round(cfg.rerankBudgetMs / cfg.rerankCostMs), floorCap, cfg.poolCapHardMax)
cap                 = cfg.poolCapMode === "auto" ? min(candidateBlockCount, autoCap) : cfg.poolCapFixed
其中 floorCap = 2 × min(scanned.length, cfg.books)                  // 每本保底 2 条
```

**截断点改法**：`:630` 的 `if (merged.length >= ROUTE_POOL_CAP) break;` → `if (merged.length >= cap) break;`

### 3.1 必须如实写明的一点（防自欺）

默认（`BSP_ROUTE_POOL` 未设 → `fixed=48`）下，`cap` 恒等于 **48**，公式**完全不生效**，行为逐字节等于旧版。

即使开到 `auto`、默认预算 6000ms/128ms，`autoCap = round(46.9) = 47`，与 48 只差 1 条 —— **在默认预算下这个公式几乎等价于 48**。

所以：**动态配额不是本轮提速来源**，它的价值只有两条：
1. 预算/耗时变了（换 reranker、换机器）时，池子自动跟着变，不用改代码；
2. 给 P3 提供一个可量化调节杆，用来验证「池子分位是否影响入选本数」。

真正的提速来自瓶颈① 的**候选书预筛**（扫描本数 N → k），以及瓶颈② 的**缓存接线**（每次免读 BLOB）。这一点在台账里必须照实写，不许把这些包装成「动态配额带来的提升」。

---

## 4. `BSP_ROUTE=0` 回滚分支

```js
const cfg = routeCfg();
const targetBooks = cfg.enabled ? selectBooks(q, books, cfg) : books;   // 关 = 全库，逐字节旧行为
```

要点：
- **关闸时 `selectBooks` 一次都不调用**，连标题分词都不做，保证「零额外开销 + 零行为差」。
- `scanned` 的循环体只有 `for (const b of targetBooks)` 这一处变化，`scanBookSem` / `skipped_books` 记账 / `considered` 形状 / 第二段 / 第三段 / 挑书 / 返回契约**全部原样**。

### 4.1 `considered` 占位（**不补就会红灯**）

`considered` 被三处测试钉成「全库清单」：

| 断言 | 位置 |
|---|---|
| `considered.length === 1` | `graphrag-fuzz.mjs:117` |
| `considered.length === 2` | `graphrag-fuzz.mjs:556` |
| 查 lunyu 时 considered 含全量 | `stage3-mcp-test.mjs:131` |

所以未扫描的书必须补同形状占位（复用 `:609` 字面结构，零 DB 成本）：

```js
const scannedTitles = new Set(targetBooks.map(b => b.title));
for (const b of books)
  if (!scannedTitles.has(b.title)) considered.push({ title: b.title, best_sim: 0, n: 0 });
```

**注意**：占位必须在 `considered.sort(...)` 之前补完，否则返回给前端的顺序会与旧版不同。

### 4.2 降级链（每一档都要能说出来）

| 情形 | 处理 | 标记 |
|---|---|---|
| 候选书 ≥ 3 本 | 正常预筛 | `route_source:"prefilter"` |
| 候选书 < 3 本 | **退回全库扫描** | `route_source:"degraded"` + 台账登记，**不当通过** |
| 无 `catalog-results` 清单 | 降级用 `meta.title + lang` 分词匹配 | `route_source:"degraded"` |
| `VAGUE_REF_RE.test(q)` 为真 | **不预筛，全库扫** | `route_source:"full"`（指代问句没有指代对象，猜必错） |
| `cfg.enabled === false` | 全库扫 | `route_source:"full"` |

新增 2 个诊断字段（纯加法，不改已有字段）：`route_source`、`route_candidates`（候选书标题数组）。
**回归红线**：这两个字段是**唯一**允许新增的返回字段，`routed_books / considered / results / skipped_books / ambiguous` 五个原有结构一个字段都不许改。

---

## 5. 候选书信号（`selectBooks` 的设计边界）

| 信号 | 来源（只读，零模型） | 约束 |
|---|---|---|
| ① 清单主题精确命中 | `catalog-results/*.json` 的 `themes[].{id,name,note}`（18 份：7 精确 / 5 需别名 / 6 上一代孤儿 / 1 无清单） | 用 `test/lib/book-alias.mjs` 的 `resolveBookPrefix` 消歧 |
| ② 书名/语言词面命中 | `listBooks` 的 `title` / `lang` + `questionKeywords`（`keywords.mjs:123`） | 中文问英文书必须靠 ② 兜（holdout 里 9 道这种题） |
| ③ 指代/裸问兜底 | `VAGUE_REF_RE` | 命中即不预筛 |

**明确不做**：
- 不用 `centroid`（死字段，且未 L2 归一化，尺子不同）；
- 不强依赖 `theme_vecs`（`catalog.mjs:575-576` 的 `catalog_model===embedKey` 闸门，13 本主库无 LLM 编目层）；
- 不调向量模型和 reranker 做粗筛（那等于把第一段扫描换个地方重跑）。

---

## 6. 静态断言（P1 必须往 `guard-test.mjs` 加，否则等于没有开关）

```
① 源码含 routeCfg / selectBooks 定义，且 selectBooks 定义位置在 routeAndSearch 之前
② 源码含 process.env.BSP_ROUTE !== "0" 判断，且该分支内不出现 selectBooks 调用
③ assertEngine 调用点数量不减少（当前 4 处：catalog.mjs:365 / search.mjs:223 / :529 / similar.mjs:49）
④ :1064-1067 的 clean 四件禁 import 清单未被破坏
⑤ :1147 的 inline-import 必须含 rebuildFts(db) + invalidateDownstream 未被破坏
⑥ ROUTE_DEFAULTS 七个默认值逐字等于参数快照表 1（minLen:60 / sigTopK:3 / books:8 / keep:10 / refW:0.5 / poolCap:48 / floorRatio:0.3）
```

第 ⑥ 条是本轮防「静默调参」的唯一硬防线 —— 没有它，谁都能把 `books` 从 8 改成 12 还不被发现。

---

## 7. 验收对照（P1 完成时必须同时成立）

| 项 | 判据 |
|---|---|
| 默认行为 | 不设任何 `BSP_*` → 全量 out JSON 与 M0 raw **逐位一致** |
| 关闸行为 | `BSP_ROUTE=0` → 与 M0 raw 五元组 + 漏题清单一致（rerank 浮点/时间戳不比） |
| 候选外全扫 | 非降级路径 `scanBookSem` 调用次数 = `targetBooks.length`（P2 加计数器后断言） |
| considered | `length` 恒等于书数（含占位） |
| clamp 契约 | `maxBooks=0 → routed=0`、`[1..8]`、99→8 全绿 |
| 既有红灯 | `stage3` / `graphrag W5` / `guard 段9-9c` / `perf` / `desktop-smoke` 零新增 FAIL |
