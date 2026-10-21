# book-skill-platform（我的书房）

> 🚧 **状态：实验性 alpha / 进行中**——核心功能可用，但仍有打磨中的部分，请勿当作成品使用。

一个**本地优先**的桌面知识库应用：把你关心的书变成可语义检索、可问答、可提炼成"技能包"的本地知识库。
所有 AI 模型都在你自己的电脑上运行，**不上传任何内容到云端**（书、提问、答案均不出本机）。

---

## 它能做什么

- **问一问**：对单本书或全库提问，返回带原文引用的答案（可点引用跳到书中对应位置）。
- **翻书**：按「主题分区 / 人物表 / 问这段」三种方式浏览一本书的结构与关系网。
- **技能包（Skill）**：把书中可复用的方法、观点蒸馏成带「引用回源」的技能文件，知识写进文件即免费存取。
- **导入自己的书**：支持 txt / epub / pdf / docx / md，自动切片、向量化、编目（主题 / 人物 / 关系）。
- **MCP 接口**：同时暴露 18 个工具（`query_book` / `query_library` / `list_catalog` / `get_person` / `expand` / `lookup` / `get_chapter` / `read_range` / `similar_chunks` / `save_skill` 等），可供 AI 智能体直接调取。`expand` 拉人物关系邻居网，`lookup` 按章节标题/编号精确直达（工作资料寻址），`get_chapter`/`read_range` 供智能体通读原文。

### 内置书目（18 个书库条目）

| 作品 | 语言 | 来源性质 |
|---|---|---|
| 《道德经》 | 中文 | 古籍（公版） |
| 《论语》 | 中文 | 古籍（公版，docx / pdf 两版） |
| 《孟子》 | 中文 | 古籍（公版，维基文库冷接入） |
| 《傲慢与偏见》 | 英文 | 公版名著（1813） |
| 《弗兰肯斯坦》 | 英文 | 公版名著（1818） |
| 《简·爱》 | 英文 | 公版名著（1847） |
| 《福尔摩斯冒险史》 | 英文 | 公版名著（1892） |
| 《Attention Is All You Need》 | 英文 | 论文（arXiv） |
| 《Dynamo》 | 英文 | 论文（2007） |
| 《Time, Clocks, and the Ordering of Events》 | 英文 | 论文（Lamport 1978） |
| 《MapReduce》 | 英文 | 论文（2004） |

> 另有技术书与语料库（均只进本地书库、不进仓库，许可证核对中）：凤凰架构、动手学深度学习、Hello 算法、System Design Primer、og-aws，及一部中文论坛经济读物（kkndme）。安装包内置的就是这全部 18 个条目。

---

## 技术架构

- **桌面端**：Electron（主进程 + 渲染进程），SQLite + FTS5 做全文检索。
- **语义检索**：`multilingual-e5-small` 向量模型（本地）做语义匹配；`bge-reranker-v2-m3` 做答案重排。
- **编目层**：LLM 产出主题 / 人物 / 关系，经五重校验入库，跨"重灌向量"存活。
- **技能层**：`save_skill` 带引用回源验证（子句命中率 ≥ 60%）与覆盖声称一致性检查，防幻觉。
- **模型来源**：HuggingFace 镜像（hf-mirror）下载，缓存在本地 `.models/`。

---

## 快速开始

```bash
npm install        # 安装依赖（仅需一次）
npm start          # 启动桌面端（开发模式）
```

> **模型去哪了**：安装包版已内置全部模型（约 700MB，含 e5 向量模型 + bge 重排模型），开箱即用不下载；
> 开发模式（`npm start`）首次运行会下载约 700MB 模型到项目内 `.models/`，只需一次，之后离线可用。
> 若你本地已有 `.models/`，开发模式直接复用。下载走 HuggingFace 镜像，国内网络通常可达。

启动后（开发模式直接用项目里的 `library/` 书库）：书架出现内置书目 → 选一本书「问一问」或「翻书」。

### 打包为独立应用（Windows 安装包）

```bash
npm run dist       # 生成 Windows 安装包（需联网下载打包组件）
```

安装包约 700MB（实测 701MB），**自带完整书库**：18 个书库条目（含编目/洗数据成果）、7 个技能包、6 本书的原版文件、
三个本地模型。首次启动出现向导，三种开始方式：

- **使用内置书库（推荐）**：把安装包里的书库/技能/原件拷进你的用户目录（`%APPDATA%` 下），马上能问；
- **选择现有书库**：指向一个已有 `.db` 文件的文件夹（比如旧版项目的 `library/`）；
- **从空白开始**：以后往书架里拖书就行。

模型不拷贝——安装目录里的 `resources/models` 只读使用，省 700MB 磁盘。升级安装不会覆盖你已有的书库
（旧用户的用户目录里有配置，向导不再出现）；想换回内置书库，删掉用户目录里的 `config.json` 重走向导即可。

> 装机/交接看 [docs/交接文档-2026-10-21.md](docs/交接文档-2026-10-21.md)：是什么/怎么用/数据在哪/MCP 两种连接码/技能清单/FAQ。

---

## 导入你自己的书

1. 把书的 `txt / epub / pdf / docx / md`（或 md 目录）放进 `books/`。
2. 跑建库流水线：
   ```bash
   npm run ingest        # 切片 + 向量化，生成 library/*.db
   ```
   md 语料可开 `BSP_SEMANTIC=1` 做语义分块（相邻小块先并后切，块长更均匀）。
3. （可选）编目：用 `src/catalog-export.mjs` 产出任务书 → 智能体产出 JSON → `src/catalog-import.mjs` 入库。
4. （可选，V3 洗数据）给每块原文生成「前置/标签/假设问题/摘要」：`src/enrich-book.mjs <书库.db>` 带 key 跑批（或 `--export` 出任务书交给外部智能体）→ `src/enrich-import.mjs <书库.db>` 入库；`--audit` 可随时复查回源率与覆盖率。
5. 维基文库书籍可用 `src/fetch-wikisource.mjs` 抓取干净纯文本。

---

## 目录结构

```
src/            应用与引擎源码（Electron 主/渲染进程、检索、编目、技能、MCP）
test/           测试（test:fast 轻量 / test:slow 重型含模型；npm test 全跑）
docs/           设计文档与验收报告
books/          内置书目源文件（公版内容）
skills/         已落盘的技能包（如《道德经》）
catalog-tasks/  编目任务书（中间产物）
catalog-results/ 编目结果（中间产物）
enrich-tasks/   洗数据任务书（中间产物）
enrich-results/ 洗数据结果（中间产物，入库后可由库侧复查再生）
```

> 以下目录**默认不入库**（见 `.gitignore`）：`.models/`（模型缓存）、`library/`（书库数据库）、
> `node_modules/`、`release/`、`release-new/`（打包产物）、`backup/`、
> `books/_work/`（语料暂存区）、`enrich-tasks/`、`enrich-results/`（洗数据中间产物，含书库内容派生数据）。

---

## 测试

```bash
npm run lint        # 代码规范检查
npm run test:fast   # 轻量测试（需要已建好的 library/*.db）
npm run test:slow   # 重型测试，需要本地模型（首次会自动下载 ~700MB）
npm run test:ci     # CI 专用子集：无需书库、无需模型
npm test            # 全部（fast + slow）
```

**自动测试（CI）**：每次推送或 PR，GitHub Actions（`.github/workflows/ci.yml`）会自动跑
`npm run lint` + `npm run test:ci`（先造一本样例书，再跑检查）。

`test:ci` 只含**不依赖本地书库与模型**的检查：格式保真、渲染层图、解析 fuzz、路径守卫、技能包质检、
云端问答配置与提示词、生成层防幻觉 fuzz、云端回答存档、存档/配置爆破 fuzz。
依赖真书库向量/编目数据的测试（`guard` / `ftsliteral` / `catalog` / `catalog-fuzz` / `ipc`）与全部 `test:slow`
（含 `similar-fuzz` 相似块查询、`chat-fuzz` 云端编排端到端、`eval-gate` 检索金标准门）
只在本地跑——它们需要 `library/*.db`（未入库）并会下载约 700MB 模型。
`stage1`（切片抽查）也需要完整真书库（含 PDF 流水线、固定切片数），同样只在本地跑。

---

## 许可证

[Apache-2.0](./LICENSE) © 2026 江晓华

---

## 免责声明

- 本项目处于**进行中**状态，部分功能仍在打磨，不保证稳定性。
- 内置英文书目为已超过版权期的公版作品；中文古籍为公有领域；论文仅作演示用途。
- 模型完全本地运行，书籍内容不会上传任何第三方服务器。
