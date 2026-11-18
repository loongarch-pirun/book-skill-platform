// T1 锚点契约：客户端高亮/翻页、MCP 回传、OS deep-link 共用一份字段，不各自猜。
import assert from "node:assert";
import { buildAnchor, formatDeepLink, parseDeepLink } from "../src/lib/anchor.mjs";
const a = buildAnchor({ bookId: "mengzi-zh.docx", id: 12, page: null, chapter: "梁惠王上", loc: "梁惠王上·1", text: "孟子見梁惠王。" });
assert.strictEqual(a.chunkId, 12);
assert.strictEqual(a.quote, "孟子見梁惠王。");
assert.strictEqual(a.chapter, "梁惠王上");
const url = formatDeepLink(a);
assert.ok(url.startsWith("bookskill://open?"));
const back = parseDeepLink(url);
assert.strictEqual(back.bookId, a.bookId);
assert.strictEqual(back.chunkId, 12);
assert.strictEqual(back.page, null);
const withPage = parseDeepLink(formatDeepLink({ ...a, page: 7 }));
assert.strictEqual(withPage.page, 7);
assert.strictEqual(parseDeepLink("https://x/y"), null);
assert.strictEqual(parseDeepLink("bookskill://open?b=&c="), null);
assert.strictEqual(parseDeepLink("bookskill://open?b=mengzi&c=abc"), null);
console.log("anchor-test: PASS");