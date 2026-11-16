// test/route-quota-test.mjs —— 结果层每书配额 + route 邻块扩展（2026-11-16）
//
// 为什么单独一支：这两招只在**多书**场景生效，而日常单书问答永远走不到；
// 靠整卷覆盖太慢（30 题 × 5 秒），靠静态断言又验不出行为。
//
// 覆盖的判据（都是本轮改造的关键不变式）：
//   1. 单书退化：picked<=1 时开关开/关结果必须逐字节一致
//   2. 多书配额：关 = book-major（首名书可占 >1 席）；开 = 每本入选书至少 1 席
//   3. 配额不改条数：开/关的种子席位数都等于 topN
//   4. 邻块默认关：results 里没有 nbr 字段
//   5. 邻块开：只附加不挤位（种子席位不变）、总量 ≤ cap、nbrOf 指向同书
//   6. 总闸优先：BSP_ROUTE=0 时配额与邻块都不生效
//
// 跑法: node test/route-quota-test.mjs
import { routeAndSearch } from "../src/lib/search.mjs";

let failed = 0;
const assert = (cond, msg, extra = "") => {
  console.log((cond ? "PASS" : "FAIL") + " - " + msg + (cond ? "" : ` ${extra}`));
  if (!cond) failed++;
};

const setEnv = (kv) => {
  for (const [k, v] of Object.entries(kv)) {
    if (v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
};
const OFF = { BSP_ROUTE_QUOTA: "0", BSP_ROUTE_NBR: "0", BSP_ROUTE_K: null, BSP_ROUTE: null };
// 默认值口径（2026-11-16 翻默认后）：配额与邻块默认开、keep 默认 18。
// 注意：删除环境变量 ≠ 关——测试里要关必须显式写 "0"。
const DEFAULT = { BSP_ROUTE_QUOTA: null, BSP_ROUTE_NBR: null, BSP_ROUTE_K: null, BSP_ROUTE: null };
// 只数「种子席」：邻块是附加证据，不占 topN 名额
const seeds = (rs) => rs.filter((r) => !r.nbr);
const seatsByBook = (rs) => {
  const m = {};
  for (const r of seeds(rs)) m[r.book] = (m[r.book] || 0) + 1;
  return m;
};
const idsOf = (rs) => rs.map((r) => `${r.book}#${r.id}`).join(",");

// 单书题（点书名 → picked=1）与多书题（不点书名 → 实测 3 本入选）
const Q_ONE = "《道德经》第十五章开头用哪两个词形容古之善為士者？";
const Q_MANY = "At which church was the wedding to take place?";

// ---------- 0) 默认值口径：不带 env 应与全开逐字节一致 ----------
{
  setEnv(DEFAULT);
  const def = await routeAndSearch(Q_MANY, { topN: 5, maxBooks: 4 });
  setEnv({ BSP_ROUTE_QUOTA: "1", BSP_ROUTE_NBR: "1", BSP_ROUTE_K: "18" });
  const all = await routeAndSearch(Q_MANY, { topN: 5, maxBooks: 4 });
  setEnv(DEFAULT);
  assert(idsOf(def.results) === idsOf(all.results),
    `默认值 = 全开：不设 env 与 Q=1/N=1/K=18 结果逐字节一致`);
  assert(def.results.some((r) => r.nbr), `默认值：邻块默认已开（${def.results.filter((r) => r.nbr).length} 条）`);
}

// ---------- 1) 单书退化：开关开/关结果必须逐字节一致 ----------
{
  setEnv(OFF);
  const base = await routeAndSearch(Q_ONE, { topN: 5, maxBooks: 4 });
  setEnv({ BSP_ROUTE_QUOTA: 1, BSP_ROUTE_NBR: 1 });
  const on = await routeAndSearch(Q_ONE, { topN: 5, maxBooks: 4 });
  setEnv(OFF);
  assert(base.routed_books.length === 1,
    `单书题只入选 1 本（实际 ${base.routed_books.length} 本）`);
  assert(idsOf(base.results) === idsOf(on.results),
    `单书退化：配额/邻块开与关结果逐字节一致（${idsOf(base.results)} vs ${idsOf(on.results)}）`);
}

// ---------- 2) 多书：关 = book-major，首名书吞满席位 ----------
{
  setEnv(OFF);
  const base = await routeAndSearch(Q_MANY, { topN: 5, maxBooks: 4 });
  const by = seatsByBook(base.results);
  // 入选书数得看 routed_books，不是 results：book-major 下结果里只剩首名书，
  // 但 routed_books（「翻了哪几本」）依旧是 3 本——两者不是同一个东西。
  assert(base.routed_books.length >= 2,
    `多书题入选 ≥2 本（实际 ${base.routed_books.length} 本：${base.routed_books.map((b) => b.title).join("/")}）`);
  assert(Object.keys(by).length === 1,
    `配额关：book-major 下结果被首名书独占（${JSON.stringify(by)}）`);
  assert(Math.max(...Object.values(by)) === 5,
    `配额关：首名书吞满全部 5 席（${JSON.stringify(by)}）`);
  assert(seeds(base.results).length === 5,
    `配额关：种子席位数 = topN（实际 ${seeds(base.results).length}）`);

  // ---------- 3) 多书：开 = 每本入选书至少 1 席 ----------
  setEnv({ BSP_ROUTE_QUOTA: 1 });
  const q = await routeAndSearch(Q_MANY, { topN: 5, maxBooks: 4 });
  setEnv(OFF);
  const byQ = seatsByBook(q.results);
  assert(Object.values(byQ).every((n) => n >= 1),
    `配额开：每本入选书至少 1 席（${JSON.stringify(byQ)}）`);
  assert(Object.keys(byQ).length === base.routed_books.length,
    `配额开：结果里的书与 routed_books 一致（${Object.keys(byQ).length} vs ${base.routed_books.length}）`);
  assert(seeds(q.results).length === 5,
    `配额开：种子席位数仍 = topN（实际 ${seeds(q.results).length}）`);
}

// ---------- 4) 邻块：默认关时 results 里没有 nbr ----------
{
  setEnv(OFF);
  const base = await routeAndSearch(Q_MANY, { topN: 5, maxBooks: 4 });
  assert(base.results.every((r) => r.nbr === undefined),
    `邻块关时（BSP_ROUTE_NBR=0）：results 无 nbr 字段（${base.results.filter((r) => r.nbr).length} 条带 nbr）`);
}

// ---------- 5) 邻块开：只附加不挤位 + 总量/同书校验 ----------
{
  setEnv({ BSP_ROUTE_NBR: 1 });
  const on = await routeAndSearch(Q_MANY, { topN: 5, maxBooks: 4 });
  setEnv(OFF);
  const base = await routeAndSearch(Q_MANY, { topN: 5, maxBooks: 4 });
  const nb = on.results.filter((r) => r.nbr);
  assert(nb.length > 0, `邻块开：确实追加了邻块（${nb.length} 条）`);
  assert(nb.length <= 16, `邻块开：总量 ≤ cap 16（实际 ${nb.length}）`);
  assert(seeds(on.results).length === seeds(base.results).length,
    `邻块开：种子席位不被挤占（${seeds(on.results).length} vs ${seeds(base.results).length}）`);
  assert(nb.every((r) => r.nbrOf != null && typeof r.nbr === "number"),
    `邻块开：每条都带 nbrOf 与 nbr 距离`);
  // 邻块的参照块不一定在 topN 里（种子取自 merged 前 3 条，可能排在第 6 名开外），
  // 所以只能验「id 与 nbrOf 的距离等于 nbr」，不能验「nbrOf 在结果里」。
  assert(nb.every((r) => Math.abs(r.id - r.nbrOf) === r.nbr),
    `邻块开：id 与 nbrOf 的距离恰等于 nbr（±1/±2）`);
  assert(on.results.length === seeds(on.results).length + nb.length,
    `邻块开：结果 = 种子 + 邻块（${on.results.length} = ${seeds(on.results).length} + ${nb.length}）`);
}

// ---------- 6) 总闸优先：BSP_ROUTE=0 时配额与邻块都不生效 ----------
{
  setEnv(OFF);
  const base = await routeAndSearch(Q_MANY, { topN: 5, maxBooks: 4 });
  // 配额与邻块保持默认（开）——只关总闸，看新招会不会绕过它
  setEnv({ BSP_ROUTE_QUOTA: null, BSP_ROUTE_NBR: null, BSP_ROUTE: 0 });
  const off = await routeAndSearch(Q_MANY, { topN: 5, maxBooks: 4 });
  setEnv(DEFAULT);
  assert(off.results.every((r) => r.nbr === undefined),
    `总闸优先：BSP_ROUTE=0 时邻块不生效（${off.results.filter((r) => r.nbr).length} 条带 nbr）`);
  assert(JSON.stringify(seatsByBook(off.results)) === JSON.stringify(seatsByBook(base.results)),
    `总闸优先：BSP_ROUTE=0 时座位分布与全关一致（${JSON.stringify(seatsByBook(off.results))}）`);
}

console.log(failed ? `\n${failed} 项 FAIL` : "\n全部 PASS");
process.exit(failed ? 1 : 0);
