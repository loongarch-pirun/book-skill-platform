// B4/CP3 并发测试 worker：被 chat-archive-test.mjs fork。
// 每个 worker 向同一 libDir 追加 PER_WORKER 条，目录同时超 MAX_ENTRIES=500 触发
// 「多进程并发 append+prune」路径——旧实现 append 在锁外，A 进程修剪用 N 行旧快照
// renameSync 覆盖时会吞掉 B 进程刚追加的第 N+1 行；新实现 append+prune 同锁后不丢。
import { appendArchive } from "../../src/desktop/chat-archive.mjs";

const spec = JSON.parse(process.argv[2]); // { libDir, from, count, worker }
for (let i = 0; i < spec.count; i++) {
  appendArchive(spec.libDir, {
    question: `w${spec.worker}-${spec.from + i}`,
    answer: "并发",
    mode: "library", book: null, model: "test", segments: 0, dropped: 0, usage: null, citations: [],
  });
}
process.exit(0);
