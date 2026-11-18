// 问题2（正文防幻觉）：verifyAnswer 过去只校引文、正文原样放行——
// 模型正文瞎编 + 挂一条抄对的引用就能过关。本测试钉住：正文也要回源体检，
// 未回源句子必须被标出（grounding.unsupported），逐字抽取的正文则全过。
import assert from "node:assert";
import { verifyAnswer, proseGrounding } from "../src/lib/llm.mjs";

const SRC = "填然鼓之，兵刃既接，弃甲曳兵而走。或百步而后止，或五十步而后止。以五十步笑百步，则何如？";
const results = [{ book: "孟子", bookId: "mengzi", id: 1, text: SRC }];
const goodCite = [{ n: 1, quote: "或五十步而后止" }];

// 1) 瞎编正文 + 一条正确引用：旧逻辑放行；新逻辑必须标出未回源句
{
  const parsed = { answer: "孟子主张性恶论，与荀子观点一致。", citations: goodCite };
  const v = verifyAnswer(parsed, results);
  assert.ok(v.citations.length === 1, "正确引用仍应通过");
  assert.ok(v.grounding, "verifyAnswer 必须返回 grounding 体检报告");
  assert.ok(v.grounding.unsupported.length >= 1, "瞎编正文句必须被标为未回源");
  assert.ok(v.grounding.groundedRate < 1, "含瞎编句时回源率必须 <1");
}

// 2) 逐字抽取正文 + 正确引用：应全过（unsupported 空、回源率 1）
{
  const parsed = { answer: "或百步而后止，或五十步而后止。", citations: goodCite };
  const v = verifyAnswer(parsed, results);
  assert.ok(v.grounding.unsupported.length === 0, "逐字抽取正文不应被误标");
  assert.ok(v.grounding.groundedRate === 1, "逐字抽取回源率应为 1");
}

// 3) proseGrounding 直接调用：无源时所有句未回源；空回答回源率 1（无正文可查）
{
  const g = proseGrounding("孟子主张性恶论。", []);
  assert.ok(g.unsupported.length === 1, "无源时正文句应未回源");
  const e = proseGrounding("", [SRC]);
  assert.ok(e.groundedRate === 1 && e.checked === 0, "空回答不查、回源率 1");
}

console.log("prose-grounding-test: PASS");