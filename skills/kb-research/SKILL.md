---
name: kb-research
title: 知识库论证动线
description: 智能体 × 知识库联动操作规程：五步动线（看书架→按体量分流→翻章读原文→引文回验→无依据明说），让模型定方案/答问题时总能找到库里对应板块并引用原文论证
sources:
  论语: lunyu-xueer-zh
  凤凰架构: fenix-architecture
  孟子: mengzi-zh
  attention: attention-is-all-you-need-en
---

# 知识库论证动线

工作需要一个依据时，按这五步走——目标只有一个：**引的每句话都能在库里逐字找到，找不到就明说。**

1. **list_books** —— 先看书架：有哪些书、每本多少块、≈多少 token（total_tokens）、章节质量（reliable / messy / none）。
2. **按体量分流** —— ≤10K token 用 read_full_book 全书直读；>10K 用 get_outline 看全书地图。
3. **定位板块读原文** —— get_chapter 按章名整章通读 / read_range 按块号区间读；查具体问题用 query_book 检索兜底。
4. **cite_check 自检** —— 引文贴回去验：命中才采用，未命中不要采用。
5. **没有就明说** —— 库里没有依据的，明确报告「书中没有」，不许编造。

## 章节索引（按问取用，不读不占上下文）

| 文件 | 内容 |
|---|---|
| chapters/ch01-dongxian.md | 五步动线详解：每步调什么、返回字段怎么读 |
| chapters/ch02-fenliu.md | 分流体例：体量账 + 章节质量三态应对 |
| chapters/ch03-fangzhi-huanjue.md | 防幻觉铁律与真实案例 |
| glossary.md | 工具速查：全部工具一句话 |
| cheatsheet.md | 场景 → 动线速查表 |

## 原文锚点（引用必带出处，可回源验证）

> 學而時習之，不亦說乎？有朋自遠方來，不亦樂乎？〔论语·第1章〕
> 本章中所说的分布式事务（Distributed Transaction）特指多个服务同时访问多个数据源的事务处理机制〔凤凰架构·分布式事务〕
> The dominant sequence transduction models are based on complex recurrent or convolutional neural networks〔attention·1〕
> 孟子見梁惠王。王曰：「叟！不遠千里而來，亦將有以利吾國乎？」〔孟子·梁惠王上·1〕

**使用约定**：动线不是可选项是默认路径；引文照抄工具返回的原文（繁体照抄，勿自行简转繁）；回答带出处〔书名·章节〕；本技能只教方法，不代理查证——每次用时现场调工具。