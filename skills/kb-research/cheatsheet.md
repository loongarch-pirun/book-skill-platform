# 场景 → 动线速查

| 场景 | 动线 |
|---|---|
| 「根据库里内容定个架构方案」 | list_books → 每本相关书 get_outline → get_chapter 读关键章 → cite_check 验引文 → 明说没覆盖的部分 |
| 「这本书讲了什么」 | ≤10K read_full_book；>10K get_outline + 挑 2-3 章 get_chapter |
| 「X 在书里哪里提到过」 | query_book 定位 → get_chapter/read_range 取上下文 |
| 「引用一句原文佐证」 | 检索/翻章拿到原文 → 原样引用 + cite_check 自检 |
| 「PDF/EPUB 里翻某一页」 | read_range 按块号（PDF 无章节；EPUB 章名 messy） |
| 「人物关系类问题」 | list_catalog 看关系网 → get_person/expand 摸到原文块 → query_book 取全文 |
| 「库里没有的问题」 | 明说无依据 + 建议外部来源，不编造 |
| 「同类工作以前做过吗」 | list_skills 看有没有现成技能 → read_skill 按需加载章节 |