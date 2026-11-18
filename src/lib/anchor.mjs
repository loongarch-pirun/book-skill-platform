// 引用锚点单一契约（T1）：客户端翻页/高亮、MCP 回传、OS deep-link 共用，避免三处各自猜字段。
// 页定义：PDF=物理页、PPT=幻灯片号；流式格式 page=null 用 chapter/loc 逻辑定位。
export function buildAnchor({ bookId, id, page = null, chapter = null, loc = null, text = "" }) {
  return { bookId: String(bookId || ""), chunkId: Number(id), page: page ?? null, loc: loc || null, chapter: chapter || null, quote: String(text || "") };
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
  const p = u.searchParams.get("p");
  return { bookId: b, chunkId: Number(c), page: p === "" || p == null ? null : Number(p), loc: null, chapter: null, quote: "" };
}