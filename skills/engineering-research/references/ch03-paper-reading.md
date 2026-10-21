# 论文精读：小论文全文直读，大论文翻章

## 动线

1. list_books / list_books 记账：论文类书都在 10K token 附近或以下（attention 51 块 ≈9.6K；Dynamo、MapReduce、Lamport 更小）
2. **≤10K 走 read_full_book 全文直读**——论文不需要检索，全文进上下文零检索误差；检索排序误差在论文这种紧凑文本里反而有害
3. >10K 的长文档才走 get_outline → get_chapter/read_range
4. 英文论文**英文问**、英文引用

## 实测案例（2026-10-21 探针第一手数据）

### 案例 1：Dynamo 论文——英文问双优

**输入**：「how does consistent hashing and replication work in Dynamo」

**输出**：路由 Dynamo(0.906)，块级 0.946/0.938/0.933 三连高分：

> Thus, each node becomes responsible for the region in the ring between it and its predecessor node on the ring.〔Dynamo·6〕

论文原文是英文，块级命中带原文回传——精读路线里这些句子可直接引用（cite_check 回验后）。

### 案例 2：attention 论文——贴线直读

attention 论文 51 块 ≈9.6K token，贴着 10K 闸线，走 read_full_book 一口气全文直读（不检索）。摘要首句即锚点：

> The dominant sequence transduction models are based on complex recurrent or convolutional neural networks〔attention·1〕

**为什么不检索**：检索是「在书里找一段」，而精读是「读整篇」——读整篇时检索只会引入排序误差和截断损失。9.6K < 10K，全文直读是最优解。

## 结论

论文类资产（attention / Dynamo / MapReduce / Lamport）都在全文直读射程内。**先查 total_tokens，别默认检索**。
