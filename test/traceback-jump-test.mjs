// T5 翻页呈现决策矩阵：有原件且可应用内→原件页/章呈现；无原件/需系统打开→退块视图+人话理由。
// pdf canvas 渲染留 T7 真机/CDP 验；本测试钉决策逻辑（可回归部分）。
import assert from "node:assert";
import { chooseOrigTarget } from "../src/renderer/orig-view.js";
const loc = { chapter: "梁惠王上", page: 3, text: "孟子見梁惠王。", loc: "梁惠王上" };
const meta = (render, ok = true) => ({ ok, data: { render, url: "book://asset/x" } });
assert.deepStrictEqual(chooseOrigTarget(meta("pdf"), loc), { mode: "original-pdf", page: 3, quote: "孟子見梁惠王。" });
assert.strictEqual(chooseOrigTarget(meta("pdf"), { ...loc, page: null }).page, 1, "pdf 无页码兜底第1页");
const h = chooseOrigTarget(meta("html"), loc);
assert.strictEqual(h.mode, "original-html"); assert.strictEqual(h.url, "book://asset/x");
assert.strictEqual(chooseOrigTarget(meta("text"), loc).mode, "original-html");
const noAsset = chooseOrigTarget({ ok: false }, loc);
assert.strictEqual(noAsset.mode, "block"); assert.ok(noAsset.reason.includes("原件"));
const ext = chooseOrigTarget(meta("external"), loc);
assert.strictEqual(ext.mode, "block"); assert.ok(ext.reason.length > 0);
console.log("traceback-jump-test: PASS");