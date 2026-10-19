# 工具速查

| 工具 | 一句话 |
|---|---|
| list_books | 书架清单：每本带 token 账与章节质量 |
| get_outline | 全书地图：章名/块数/token/起始块号（翻书第一跳） |
| read_full_book | ≤10K token 小书全文直读（超限返回 too-big） |
| get_chapter | 按章名整章通读（8K token 闸 + 续读游标） |
| read_range | 按块号区间连续读（messy/none 章节的首选） |
| query_book | 单书检索（查「哪段讲了 X」） |
| query_library | 全库检索自动挑书（不知道查哪本时用） |
| similar_chunks | 以块找块（「还有哪里讲过类似的」） |
| lookup | 章节直达（错误码/条款号/步骤标题的精确寻址） |
| list_catalog | 编目浏览：主题分区 + 人物表 + 关系网 |
| get_person / get_theme / expand | 人物/主题深查与关系网邻域 |
| cite_check | 引文回验（命中给定位，未命中拒采用） |
| list_skills / read_skill | 技能清单与按需加载（先看有没有现成手册） |
| save_skill | 技能落盘（三道质检，含引用回源） |