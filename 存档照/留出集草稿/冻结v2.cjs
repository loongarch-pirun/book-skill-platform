#!/usr/bin/env node
/**
 * 冻结 v2 卷：holdout-v2-DRAFT.json → r4/test/holdout/sets/holdout-v2.json + frozen-v2.json
 * 跑法：node 冻结v2.cjs
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const R4 = "C:/Users/JIANG XIAO HUA/Desktop/book-skill-platform-r4";
const OUT_DIR = path.join(R4, "test", "holdout");
const SET_DIR = path.join(OUT_DIR, "sets");
const SET_PATH = path.join(SET_DIR, "holdout-v2.json");
const FROZEN_PATH = path.join(OUT_DIR, "frozen-v2.json");

const draft = JSON.parse(fs.readFileSync(path.join(__dirname, "holdout-v2-DRAFT.json"), "utf8"));
const now = new Date().toISOString();

const set = {
  ...draft,
  status: "FROZEN",
  frozen: true,
  selfReviewed: true,
  selfReviewedAt: now,
  frozenAt: now,
  reviewedBy: "富江（出题+验真自核；v1 已由爸爸盖章，本卷按同一流程自动核）",
  revision: "v2.1 冻结：30 题，块复用 0、题干最高相似度 0.387、absent 词全库 0 命中",
  judgePolicy: {
    route: "全部 30 题走 routeAndSearch（全库自动挑书），与 v1 同一判分口径",
    answerable: "judge() 三级尺子；full 或 partial 记为答对",
    refusal: "返回结果中不得出现 absent 任一词（全库 0 命中已核）",
    ambiguous: "ambiguous===true 或 routed_books.length>=2 记为通过",
    newbook: "同 answerable，另记「挑书是否命中本尊」",
  },
};

fs.mkdirSync(SET_DIR, { recursive: true });
const body = JSON.stringify(set, null, 1) + "\n";
fs.writeFileSync(SET_PATH, body);
const buf = fs.readFileSync(SET_PATH);
const sha256 = crypto.createHash("sha256").update(buf).digest("hex");

const frozen = {
  setId: set.setId,
  file: "test/holdout/sets/holdout-v2.json",
  sha256,
  bytes: buf.length,
  total: set.total,
  byKind: set.byKind,
  byLang: set.byLang,
  frozenAt: now,
  reviewedBy: set.reviewedBy,
  revision: set.revision,
  rule: "此后只许看它给多少分，不许回头改题；改题必须新开 setId",
};
fs.writeFileSync(FROZEN_PATH, JSON.stringify(frozen, null, 1) + "\n");

console.log("v2 卷已冻结");
console.log("  路径   :", SET_PATH);
console.log("  题数   :", set.total, JSON.stringify(set.byKind), JSON.stringify(set.byLang));
console.log("  sha256 :", sha256);
console.log("  字节   :", buf.length);
console.log("  凭证   :", FROZEN_PATH);
