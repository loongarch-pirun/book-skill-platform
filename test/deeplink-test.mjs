// T6 深链：argv 提取（second-instance 转发）+ 往返一致。main.js 用 deepLinkFromArgv。
import assert from "node:assert";
import { deepLinkFromArgv, formatDeepLink, parseDeepLink, buildAnchor } from "../src/lib/anchor.mjs";
const a = buildAnchor({ bookId: "mengzi-zh.docx", id: 5, page: 2 });
const url = formatDeepLink(a);
assert.deepStrictEqual(deepLinkFromArgv(["--foo", url]), parseDeepLink(url));
assert.strictEqual(deepLinkFromArgv(["--foo", "https://x"]), null);
assert.strictEqual(deepLinkFromArgv([]), null);
console.log("deeplink-test: PASS");