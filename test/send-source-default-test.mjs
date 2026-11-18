// 问题1落实（2026-11-18 用户拍板：准确优先·同意发片段）：
// 没选过（null/undefined）时缺省=发原文片段（换逐字答案）；用户明确拒绝(false)仍尊重=不发；
// 调用方显式 true/false 最高优先级。同意门 UI（首次 confirm/随时开关/横幅）保留不动。
import assert from "node:assert";
import { resolveSendSource } from "../src/lib/llm.mjs";

assert.strictEqual(resolveSendSource(undefined, null), true, "没选过缺省应发（准确优先）");
assert.strictEqual(resolveSendSource(undefined, undefined), true, "配置缺失缺省应发");
assert.strictEqual(resolveSendSource(undefined, true), true, "选过允许应发");
assert.strictEqual(resolveSendSource(undefined, false), false, "明确拒绝必须不发（opt-out 尊重）");
assert.strictEqual(resolveSendSource(true, false), true, "显式 true 最高优先");
assert.strictEqual(resolveSendSource(false, true), false, "显式 false 最高优先");
console.log("send-source-default-test: PASS");