---
name: book-intake
title: 新书验收
description: 新书入库验收流程技能：fetch-wikisource 下载与 EOCD 校验、txt2docx 加工、建库管线位次（build→clean→inline-clean→embed→enrich）、BSP_SEMANTIC=1 语义分块铁律、newbook-check 七关体检、eval 双门验收与四本账同步。不用于：读书/查原文（用 kb-research 或对应领域技能）、技能编写规范（那是 W2 校验器的地盘）、日常检索调参
metadata:
  version: 1.0.0
  category: ops
  updated: 2026-10-21
allowed-tools: [list_books, query_book, query_library, cite_check, list_skills, read_skill, check_skills]
sources: {}
---

# 新书验收

新书进书架要走七关——**每一关都是被真实事故喂出来的**。本技能是流程账：管线位次、铁律、验收动作、实录案例。

## 触发边界（先对表再动手）

**应触发**：
- 「我想把一本新书加进书架」
- 「新书入库要走什么流程」
- 「建库后 chunk 数不对/检索质量差，怎么排查」
- 「清洗/编目/评测这些步骤的顺序是什么」

**不触发（明说边界）**：
- 读书/查原文——kb-research 及领域技能
- 修检索算法/调参——那是引擎波次的活，不是验收流程
- 编写技能包——W2 结构校验器的地盘

## 参考文件索引

| 文件 | 内容 |
|---|---|
| references/ch01-pipeline.md | 建库管线：位次铁律 + BSP_SEMANTIC + 清洗护栏（实录教训） |
| references/ch02-acceptance.md | 验收七关：newbook-check + eval 双门 + 四本账（实录） |
| cheatsheet.md | 流程速查：命令 → 位次 → 检查点 |

## 使用约定

- 本技能教的是**操作规程**，无书中引文——所有数据声称（块数/分数）以 `list_books` 与 eval 实时返回为准，文档中的数字是历史实录快照
- 临时脚本一律归 `books/_work/`，不入正式目录
- 桌面管线（jobs）与 CLI 双通道：桌面自动跑（jobs.mjs 管线模式），CLI 手动跑（`node src/<step>.mjs`）
- **书库增删后必跑技能体检**：`node src/check-skills.mjs`（MCP 侧 `check_skills`）——旧技能包的引文/覆盖声称会随书库变动悄悄失效，红包装修（read_skill → 改 → save_skill 整包重交）后再用（ch02 有实录）
