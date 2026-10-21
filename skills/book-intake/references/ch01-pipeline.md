# 建库管线：位次铁律与实录教训

## 管线位次（不可调换）

```
build → clean → inline-clean → embed → enrich
```

- **改 text/切块的步骤必须在 embed 前**——text 或切块一变，已建向量与编目全部作废
- clean（云端清洗）与 inline-clean（行级清洗）都在 embed 前；enrich（摘要/编目）在 embed 后
- CLI 手动跑：`node src/clean-book.mjs <db>` / `node src/inline-clean.mjs <db>`；桌面 jobs 管线自动按位次跑

## 铁律 1：建库必须 BSP_SEMANTIC=1（语义分块）

实录教训（2026-10-20 深夜重建九本佚书时实证）：
- d2l 无语义分块碎成 **33323 块**，开语义后 **5501 块**——差 6 倍，检索质量天壤之别
- 凤凰架构某次重建漏带该开关：3737 块 vs 旧版 1227 块——**块数一致≠内容一致**，旧编目 JSON 不可复用（hello-algo 691=691 但 samples 全错位）

## 铁律 2：清洗后必同步四本账

importClean / importClean 恢复 / importInline 都在同一事务里调 syncBookMeta（chunk_count / total_chars / total_tokens / chapter_quality）——**漏同步则 meta 记加工前的数，newbook-check 账实相符检查必红**。FTS external 表 DELETE 后必须 `INSERT INTO chunks_fts VALUES('rebuild')`。

## 铁律 3：改提示词必须 bump 版本

清洗提示词改一个字就要 bump CLEAN_VERSION（缓存 meta 行记 clean_version，无标记=stale 拒收）——「不可判即拒收」原则同样适用于管线自身的资产版本。

## 护栏（清洗安全网）

- 五护栏：实义短块保留 / 引文公式代码保留 / 判不准 keep / **净化率闸 20-40% 警、>40% 拒** / 隔离账可恢复
- 行级清洗（inline-clean）：语义是「strip 后剩余 <20 字」不是删行占比——按行数拦会误拦论坛体整块跟帖（kk 实测整块删 35% 行但剩余百字正文）
- GATE 拒收需双 flag：`--force --force-gate`（桌面侧同理）
- kk 论坛体实测：行级清洗删行 12.7%（论坛体署名行占比天然高，远低于闸线）

## 环境坑（实录）

- 下载 epub 必验 EOCD；gutenberg 直连被掐时 `curl -C -` 断点续传多试几次能成
- CLI 跑清洗的 key：llm.json 是 plain: 前缀（Node 直接 base64 解）；enc: 才要 Electron safeStorage
