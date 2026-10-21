---
name: engineering-research
title: 工程研究技能
description: 工程向研究技能：架构调研、代码学习、论文精读、概念跨书对照、云选型参考五场景，查库内工程书（凤凰架构/系统设计入门/Hello算法/Dynamo/og-aws/attention/d2l）的原文依据并逐字引用。不用于：人文经典阅读（用 humanities-reading）、kk 观点考据（用 opinion-archaeology）、纯编码执行、实时信息查询
metadata:
  version: 1.0.0
  category: engineering
  updated: 2026-10-21
allowed-tools: [list_books, list_catalog, list_skills, read_skill, get_person, get_theme, lookup, read_full_book, get_outline, get_chapter, read_range, query_book, query_library, similar_chunks, cite_check]
sources:
  凤凰架构: fenix-architecture
  系统设计入门: system-design-primer-en
  Hello算法: hello-algo-zh
  Dynamo: dynamo-2007-en
  og-aws: og-aws-en
  attention: attention-is-all-you-need-en.pdf
  d2l: d2l-zh
---

# 工程研究技能

工程问题要依据时走这条线：**路由到工程书 → 拿到块级原文 → 引文回验 → 引用带出处**。五个场景（架构调研 / 代码学习 / 论文精读 / 概念对照 / 云选型）各有动线与真实案例，先对场景表再动手。

## 触发边界（先对表再动手）

**应触发**：
- 「XX 架构怎么设计 / 这个方案有什么坑」
- 「XX 算法/数据结构怎么实现的，书里怎么讲」
- 「这篇论文说了什么 / 帮我读一下 XX 论文」
- 「一致性哈希/幂等/分片这些概念，几本书里分别怎么讲」
- 「AWS 上 XX 该怎么选 / S3 和 EBS 的区别」

**不触发（明说边界，别硬翻）**：
- 人文经典（《论语》《孟子》、小说文本细读）—— humanities-reading 的地盘
- kk 帖观点考据（房价年代断代、当年谁说过什么）—— opinion-archaeology 的地盘
- 「帮我写一段代码」——本技能给依据不给生成物
- 库里没有的工程书主题（先 list_books 核对，没有就明说）
- 今天的服务状态/价格——库里全是静态文本

## 参考文件索引（按场景取用，不读不占上下文）

| 文件 | 内容 |
|---|---|
| references/ch01-arch-research.md | 架构调研：抽象软问题的问法陷阱与解法（实测案例） |
| references/ch02-code-study.md | 代码学习：问法决定块级命中——快排正反对照（实测） |
| references/ch03-paper-reading.md | 论文精读：小论文全文直读、大论文翻章（attention/Dynamo 实测） |
| references/ch04-concept-compare.md | 概念跨书对照：一致性哈希三书讲法（实测） |
| references/ch05-cloud-selection.md | 云选型参考：中文问不到 og-aws 的教训（实测） |
| cheatsheet.md | 五场景 → 动线速查表 |

## 原文锚点（引用必带出处，可回源验证）

> 快速排序的整体流程如下图所示。 首先，对原数组执行一次"哨兵划分"，得到未排序的左子数组和右子数组。〔Hello算法·算法流程〕
> 根据请求中某一些数据（可以是 MAC、IP 地址，也可以是更上层协议中的某些参数信息）作为特征值来计算需要落在的节点上，算法一般会保证同一个特征值每次都一定落在相同的服务器上。〔凤凰架构·均衡策略与实现〕
> Thus, each node becomes responsible for the region in the ring between it and its predecessor node on the ring.〔Dynamo·6〕
> The dominant sequence transduction models are based on complex recurrent or convolutional neural networks〔attention·1〕

**使用约定**：工程书检索题，中文书中文问、**英文书必须英文问**（跨语言 embedding 双杀，见 ch05 实测）；引文照抄工具返回（英文书照抄英文），行尾带出处；动线细节（分流/token 闸/防幻觉红线）沿用 kb-research 技能，不在此重复。
