// 考卷书名 → 书架上 .db 文件前缀的唯一正本。
//
// 背景：旧 eval 体系（test/v2-eval.mjs / eval-gate.mjs / eval-baseline.json）已于
// 2026-11-15 移除，原本散落在 v2-eval.mjs 与 golden-verify.mjs 里的两份别名表副本
// 收敛到这里，避免「改一处漏一处」。
//
// 这不是评测体系，只是「考卷里写的书名」到「实际库文件名」的寻址表。
// 新体系（test/golden/*.json + test/quality-gate.mjs）与校验器共用它。
export const BOOK_ALIAS = {
  "jane-eyre-en.epub": "pg1260-简爱.epub",
  "sherlock-holmes-adventures-en.epub": "pg1661-福尔摩斯冒险史.epub",
  "dynamo-2007-en.pdf": "Dynamo-亚马逊高可用键值存储-2007.pdf",
  "lamport-1978-en.pdf": "Lamport-时间时钟与分布式系统排序-1978.pdf",
  "mapreduce-2004-en.pdf": "MapReduce-谷歌大规模分布式处理-2004.pdf",
};

/** 返回该书在 library/ 里的 .db 文件名前缀；未登记的书返回原名。 */
export function resolveBookPrefix(book) {
  return BOOK_ALIAS[book] || book;
}
