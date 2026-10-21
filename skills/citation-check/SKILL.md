---
name: citation-check
title: 引文核查
description: 引文核查元技能：写完答案逐条 cite_check 自检、验证外部材料声称的「书中原句」、分辨引文造假的四种形态（凭空编造/改词换字/跨块拼接/出处标错）并各自正确应对。不用于：检索找原文（用 kb-research 动线）、kk 帖声部辨析（用 opinion-archaeology ch01）、给引文打分排序
metadata:
  version: 1.0.0
  category: universal
  updated: 2026-10-21
allowed-tools: [list_books, query_book, query_library, lookup, read_full_book, get_chapter, read_range, cite_check]
sources:
  凤凰架构: fenix-architecture
  Hello算法: hello-algo-zh
  论语: lunyu-xueer-zh
---

# 引文核查

库的红线只有一条：**引的每句话都能在库里逐字找到**。本技能管这句话的执行——写完答案的自检、外来引文的核查、造假形态的辨认。

## 触发边界（先对表再动手）

**应触发**：
- 「答案写完了，帮我验一下引用是不是都是原文」
- 「有人引用了书中一句话，帮我核实真假」
- 「cite_check 报未命中，我该怎么办」
- 「这段『原文』读着不对劲，帮我查」
- 任何要落笔引用的时刻（逐条自检）

**不触发（明说边界）**：
- 「帮我找讲 X 的段落」——那是检索，走 kb-research 动线
- kk 帖「这句话到底是谁说的」——声部辨析是 opinion-archaeology 的地盘
- 「这句引文写得好不好」——本技能验真伪，不评优劣

## 参考文件索引

| 文件 | 内容 |
|---|---|
| references/ch01-verify-flow.md | 核查动线：自检路（逐条过闸）与他查路（外来引文验真） |
| references/ch02-forgery-patterns.md | 造假四形态与未命中的正确应对（含 2026-10-21 实测） |

## 原文锚点（引用必带出处，可回源验证）

> 本章中所说的分布式事务（Distributed Transaction）特指多个服务同时访问多个数据源的事务处理机制〔凤凰架构·分布式事务〕
> 快速排序的整体流程如下图所示。 首先，对原数组执行一次"哨兵划分"，得到未排序的左子数组和右子数组。〔Hello算法·算法流程〕
> 學而時習之，不亦說乎？有朋自遠方來，不亦樂乎？〔论语·第1章〕

**使用约定**：cite_check 是判定器不是评分器——命中才采用，未命中不要采用，没有「部分可信」；繁体照抄（勿自行简转繁），标点与空格按工具返回原样。
