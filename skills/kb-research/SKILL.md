---
name: kb-research
title: 知识库论证动线
description: 智能体 × 知识库联动操作规程：五步动线（看书架→按体量分流→翻章读原文→引文回验→无依据明说），定方案/答问题时找到库内依据并引用原文论证。不用于：纯编码执行、实时信息查询、书库未收录主题的立论——库里没有就明说，不借本库装点门面
metadata:
  version: 2.0.0
  category: universal
  updated: 2026-10-21
allowed-tools: [list_books, list_catalog, list_skills, read_skill, get_person, get_theme, lookup, read_full_book, get_outline, get_chapter, read_range, query_book, query_library, similar_chunks, cite_check]
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

## 触发边界（先对表再动手）

**应触发**：
- 「根据库里内容设计一个 XX 方案 / 架构」
- 「这本书讲了什么」「帮我读一下 XX」
- 「X 在书里哪里提到过」「找一下讲 Y 的段落」
- 「引用一句原文佐证这个观点」
- 「书里 XX 和 YY 是什么关系」（人物/概念）

**不触发（明说边界，别硬翻）**：
- 「帮我写一段代码 / 实现 XX」——纯编码执行，库只当参考书不当生成器
- 「今天 XX 的价格/新闻」——实时信息，库里全是静态文本
- 库里没有的书/主题（先 list_books 核对，没有就直说无依据）
- 「把这本书导入书架」——入库是建库管线的活，不是本技能
- kk 帖的观点考据——那是 opinion-archaeology 的地盘（独立技能）

## 参考文件索引（按问取用，不读不占上下文）

| 文件 | 内容 |
|---|---|
| references/ch01-dongxian.md | 五步动线详解：每步调什么、返回字段怎么读、2 个完整实测案例 |
| references/ch02-fenliu.md | 分流体例：体量账 + 章节质量三态应对 + 实测分流案例 |
| references/ch03-fangzhi-huanjue.md | 防幻觉铁律 + 3 个真实翻车/避险案例 |
| glossary.md | 工具速查：全部工具一句话 |
| cheatsheet.md | 场景 → 动线速查表 |

## 原文锚点（引用必带出处，可回源验证）

> 學而時習之，不亦說乎？有朋自遠方來，不亦樂乎？〔论语·第1章〕
> 本章中所说的分布式事务（Distributed Transaction）特指多个服务同时访问多个数据源的事务处理机制〔凤凰架构·分布式事务〕
> The dominant sequence transduction models are based on complex recurrent or convolutional neural networks〔attention·1〕
> 孟子見梁惠王。王曰：「叟！不遠千里而來，亦將有以利吾國乎？」〔孟子·梁惠王上·1〕

**使用约定**：动线不是可选项是默认路径；引文照抄工具返回的原文（繁体照抄，勿自行简转繁）；回答带出处〔书名·章节〕；本技能只教方法，不代理查证——每次用时现场调工具。
