# 流程速查：命令 → 位次 → 检查点

| 步骤 | 命令/动作 | 检查点 |
|---|---|---|
| ① 下载/加工 | fetch-wikisource / txt2docx | epub 验 EOCD；改 txt 必重跑 txt2docx |
| ② build | 桌面管线或 `node src/build-book.js` | BSP_SEMANTIC=1（块数异常=没开，ch01 铁律 1） |
| ③ clean | `node src/clean-book.mjs <db> --dry-run` 先看 | 净化率闸 20-40%；GATE 需 `--force --force-gate` 双 flag |
| ④ inline-clean | `node src/inline-clean.mjs <db> --dry-run` | 幂等跳过；语义=剩余<20 字（ch01） |
| ⑤ embed | `node src/embed-book.js <db>` | 必在 ③④ 之后；模型唯一入口 models.mjs |
| ⑥ enrich | `node src/enrich-book.mjs <db>` | 编目人名 instr 预验；声称以 list_catalog 实时为准 |
| ⑦ 验收 | newbook-check 七关 + eval 双门 + list_books 对账 | ≥基线且漏题⊆基线；四本账一致才进书架 |

通用：临时脚本归 books/_work/；全量 lint 收尾；桌面 jobs 管线自动按位次跑（失败必落 failed 态）。
