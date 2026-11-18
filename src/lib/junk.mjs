// 形态脏块判据（单一尺子）：原为 test/quality-gate.mjs 内联（照抄 21-切块质量\dirty-scan.mjs:32-67），
// 2026-11-18 抽到 src/lib 供检索邻块守卫与闸门共用——避免"闸门量脏、检索却扩脏"各用各的尺子。
// JUNK 7 条 + classify 长度门槛，语义逐字保留，改这里必须同步复跑 quality-gate。
// mojibake 用 fromCharCode 构造 {U+FFFD} ∪ [U+E000..U+F8FF]，等价于 gate 的 [﻿-]。
const JUNK = [
  { name: "journal_masthead", re: /(communications|proceedings|transactions|journal|letters|magazine)\s*[|,]?.*\b(19|20)\d{2}\b|\bvolume\s+\d+|\bnumber\s+\d+|\bvol\.?\s*\d+\s*,?\s*no\.?\s*\d+/i },
  { name: "page_number", re: /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i },
  { name: "copyright_line", re: /(©|\(c\)|copyright|all rights reserved|permission to make|licensed under)/i },
  { name: "toc_line", re: /\.{3,}\s*\d{1,4}\s*$|…{3,}\s*\d{1,4}\s*$/ },
  { name: "latex_residue", re: /^(?:[\\{}_^$\s]|\\(?:mathrm|underset|overset|frac|sum|tau|nu|kappa|xi|leq|geq|lesssim|gtrsim|cdot|times|alpha|beta|gamma|delta|sigma|lambda|infty|sqrt|left|right|text|begin|end)\b|[_^]\s*\{|[a-z]\s*_\s*\{)/i },
  { name: "mojibake", re: new RegExp("[" + String.fromCharCode(0xfffd) + String.fromCharCode(0xe000) + "-" + String.fromCharCode(0xf8ff) + "]|锟斤拷|烫烫|屯屯") },
  { name: "separator", re: /^[\s\-=_*#~·•.]{1,20}$/ },
];
export function formDirtyOf(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  for (const { name, re } of JUNK) {
    if (name === "latex_residue" && s.length > 400) continue;
    if (!re.test(s)) continue;
    if (name === "journal_masthead" && s.length > 260) continue;
    if (name === "copyright_line" && s.length > 300) continue;
    return name;
  }
  return null;
}