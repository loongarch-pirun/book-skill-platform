#!/usr/bin/env node
/**
 * 冻结脚本（一次性）：holdout-DRAFT.json v1.1 → r4/test/holdout/sets/holdout-v1.json v1.2 + frozen.json
 *
 * 只做三件事：
 *   1) 状态位 DRAFT → FROZEN，写 frozenAt / reviewedBy
 *   2) 给 8 道拒答题补 absent 判分字段（题干、答案句、金词一字不动）
 *   3) 算卷子 sha256，写 frozen.json
 *
 * 跑法：node 冻结脚本.cjs
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const HERE = __dirname;
const R4 = "C:/Users/JIANG XIAO HUA/Desktop/book-skill-platform-r4";
const OUT_DIR = path.join(R4, "test", "holdout");
const SET_DIR = path.join(OUT_DIR, "sets");
const SET_PATH = path.join(SET_DIR, "holdout-v1.json");
const FROZEN_PATH = path.join(OUT_DIR, "frozen.json");

const draft = JSON.parse(fs.readFileSync(path.join(HERE, "holdout-DRAFT.json"), "utf8"));

// 8 道拒答题的「不该出现」判定词。全部已核：全库 13 本 chunks 里 0 命中。
const ABSENT = {
  H17: ["量子"],
  H18: ["Kubernetes"],
  H19: ["比特币"],
  H20: ["基站"],
  H21: ["智能手机"],
  H22: ["年终奖"],
  H23: ["Python"],
  H24: ["食堂"],
};

const now = new Date().toISOString();

const items = draft.items.map((it) => {
  const o = { ...it };
  delete o.source;
  if (it.kind === "refusal") {
    if (!ABSENT[it.id]) throw new Error(`拒答题 ${it.id} 缺 absent 判定词`);
    o.absent = ABSENT[it.id];
  }
  return o;
});

const set = {
  setId: "holdout-v1",
  status: "FROZEN",
  frozen: true,
  draftedAt: draft.draftedAt,
  selfReviewed: draft.selfReviewed,
  selfReviewedAt: draft.selfReviewedAt,
  frozenAt: now,
  reviewedBy: "爸爸（2026-11-16 01:05 指令「直接开干」= 同意冻结）",
  revision: "v1.2 冻结：仅补拒答题 absent 判分字段；30 题题干、答案句、金词一字未改",
  total: items.length,
  byKind: draft.byKind,
  byLang: draft.byLang,
  sourcePolicy: draft.sourcePolicy,
  judgePolicy: {
    route: "全部 30 题走 routeAndSearch（全库自动挑书），不预先把书喂给系统——测的是产品真实路径",
    answerable: "judge() 三级尺子；full 或 partial 记为答对，miss 记为漏题",
    refusal: "返回结果中不得出现 absent 任一词（全库 0 命中已核）；出现即算串词作答",
    ambiguous: "ambiguous===true 或 routed_books.length>=2 记为通过",
    newbook: "同 answerable，另记「挑书是否命中本尊」",
  },
  items,
};

fs.mkdirSync(SET_DIR, { recursive: true });
fs.writeFileSync(SET_PATH, JSON.stringify(set, null, 1) + "\n");

const buf = fs.readFileSync(SET_PATH);
const sha256 = crypto.createHash("sha256").update(buf).digest("hex");

const frozen = {
  setId: set.setId,
  file: "test/holdout/sets/holdout-v1.json",
  sha256,
  bytes: buf.length,
  total: set.total,
  byKind: set.byKind,
  frozenAt: now,
  reviewedBy: set.reviewedBy,
  revision: set.revision,
  rule: "此后只许看它给多少分，不许回头改题；改题必须新开 setId",
};
fs.writeFileSync(FROZEN_PATH, JSON.stringify(frozen, null, 1) + "\n");

console.log("卷子已冻结");
console.log("  路径   :", SET_PATH);
console.log("  题数   :", set.total, JSON.stringify(set.byKind));
console.log("  sha256 :", sha256);
console.log("  字节   :", buf.length);
console.log("  frozen :", FROZEN_PATH);
