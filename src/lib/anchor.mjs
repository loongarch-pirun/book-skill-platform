// 引用锚点单一契约（T1）：客户端翻页/高亮、MCP 回传、OS deep-link 共用，避免三处各自猜字段。
// 页定义：PDF=物理页、PPT=幻灯片号；流式格式 page=null 用 chapter/loc 逻辑定位。

// 页码归一（P2）：脏输入（"abc"/""/Infinity/对象）一律降级为 null。
// 不能只写 Number(x)——"abc" 得 NaN，而 JSON.stringify 会把 NaN 显示成 null，
// 看着像正常、实际把 NaN 带进 anchor→深链 p=NaN，排查时极容易误判成"没问题"。
function toPage(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function buildAnchor({ bookId, id, page = null, chapter = null, loc = null, text = "" }) {
  return { bookId: String(bookId || ""), chunkId: Number(id), page: toPage(page), loc: loc || null, chapter: chapter || null, quote: String(text || "") };
}
export function formatDeepLink(a) {
  const q = new URLSearchParams({ b: a.bookId, c: String(a.chunkId), p: a.page == null ? "" : String(a.page) });
  return `bookskill://open?${q.toString()}`;
}
export function parseDeepLink(url) {
  let u; try { u = new URL(String(url || "")); } catch { return null; }
  if (u.protocol !== "bookskill:" || u.hostname !== "open") return null;
  const b = u.searchParams.get("b"), c = u.searchParams.get("c");
  if (!b || c == null || c === "" || !Number.isInteger(Number(c))) return null;
  return { bookId: b, chunkId: Number(c), page: toPage(u.searchParams.get("p")), loc: null, chapter: null, quote: "" };
}
// second-instance / argv 里捞第一条 bookskill:// 深链（Windows 单实例转发用）
export function deepLinkFromArgv(argv) {
  for (const a of Array.isArray(argv) ? argv : []) {
    if (typeof a === "string" && a.startsWith("bookskill://")) return parseDeepLink(a);
  }
  return null;
}