// 模型注册表 + 单例加载器
// 向量引擎（embedding）与复试官（reranker）的唯一入口
// 被 search.mjs（ESM 直接 import）和 embed-book.js（CJS 动态 import）共用
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..", "..");

export const EMBED_MODELS = {
  // simThreshold: similar 边的余弦门槛（各模型分数尺度不同，分开调）
  // routeFloor: 挑书路由的绝对下限（低于它的书不入选）
  m3: { id: "Xenova/bge-m3", dtype: "int8", pooling: "cls", dim: 1024, queryPrefix: "", passagePrefix: "", simThreshold: 0.5, routeFloor: 0.3 },
  e5: { id: "Xenova/multilingual-e5-small", dtype: "int8", pooling: "mean", dim: 384, queryPrefix: "query: ", passagePrefix: "passage: ", simThreshold: 0.72, routeFloor: 0.7 },
  "zh-small": { id: "Xenova/bge-small-zh-v1.5", dtype: "q8", pooling: "cls", dim: 512, queryPrefix: "", passagePrefix: "", simThreshold: 0.5, routeFloor: 0.3 },
};
export const DEFAULT_EMBED = process.env.BSP_EMBED_MODEL || "e5";

let _tf = null, _pipe = null, _pipeKey = null, _rerank = null;

async function getTf() {
  if (!_tf) {
    _tf = await import("@huggingface/transformers");
    _tf.env.remoteHost = process.env.HF_ENDPOINT || "https://hf-mirror.com";
    _tf.env.cacheDir = path.join(ROOT, ".models");
    _tf.env.allowLocalModels = true;
  }
  return _tf;
}

// 向量引擎：embedQueries 查询用 / embedPassages 建库用（e5 系要加前缀，分开处理）
export async function getEmbedder(modelKey = DEFAULT_EMBED) {
  const cfg = EMBED_MODELS[modelKey];
  if (!cfg) throw new Error(`未知向量模型: ${modelKey}（可选: ${Object.keys(EMBED_MODELS).join("/")}`);
  if (!_pipe || _pipeKey !== modelKey) {
    const tf = await getTf();
    _pipe = await tf.pipeline("feature-extraction", cfg.id, { dtype: cfg.dtype });
    _pipeKey = modelKey;
  }
  const pipe = _pipe;
  const embed = async (texts, prefix) => Promise.all(texts.map(async t => {
    const r = await pipe(prefix + t, { pooling: cfg.pooling, normalize: true });
    return new Float32Array(r.data);
  }));
  return {
    key: modelKey, dim: cfg.dim, id: cfg.id,
    simThreshold: cfg.simThreshold, routeFloor: cfg.routeFloor,
    embedQueries: (texts) => embed(texts, cfg.queryPrefix),
    embedPassages: (texts) => embed(texts, cfg.passagePrefix),
  };
}

// 复试官：对（问题, 块）逐对打分，返回 0~1 相关度
// 用 BSP_RERANK=0 关闭（比如调试或机器太慢时）
export async function getReranker() {
  if (process.env.BSP_RERANK === "0") return null;
  if (_rerank) return _rerank;
  const tf = await getTf();
  // 默认复试官：bge-reranker-v2-m3（568M，100+ 语言）——跨语言对（中文问题×英文原文）打分正常，
  // 替换只懂中英的 bge-reranker-base（它给跨语言对打 0.0001 分，压死 4 道漏题）。
  // 对照/回滚：BSP_RERANK_MODEL=Xenova/bge-reranker-base
  const ID = process.env.BSP_RERANK_MODEL || "onnx-community/bge-reranker-v2-m3-ONNX";
  const tok = await tf.AutoTokenizer.from_pretrained(ID);
  const model = await tf.AutoModelForSequenceClassification.from_pretrained(ID, { dtype: "int8" });
  _rerank = async (query, passages) => {
    const scores = [];
    for (const p of passages) {
      const inputs = tok(query, { text_pair: p, padding: true, truncation: true, max_length: 512 });
      const { logits } = await model(inputs);
      scores.push(1 / (1 + Math.exp(-logits.data[0])));
    }
    return scores;
  };
  return _rerank;
}

export const cosine = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };

// ---------- 引擎一致性卫兵 ----------
// 库文件和查询端必须用同一个向量引擎（不同模型的向量空间不同，余弦分全是垃圾）。
// 两道检查：
//   1. meta.model 标记：库是用哪个引擎灌的，必须等于当前查询引擎（v2 起的库都有标记）
//   2. 维度兜底：v1 时代的旧库没有标记，退而求其次验块向量长度 == 注册表的 dim
// 抛错信息里直接给出修复路径（重灌 or 切引擎），不让下一个接班的人猜。
export function assertEngine(db, embedKey) {
  const cfg = EMBED_MODELS[embedKey];
  if (!cfg) throw new Error(`assertEngine: 未知向量模型 ${embedKey}`);
  const marked = db.prepare("SELECT value FROM meta WHERE key='model'").get()?.value || null;
  if (marked && marked !== embedKey)
    throw new Error(`引擎不一致：库是用 ${marked} 灌的，当前查询用 ${embedKey}，余弦分会是垃圾。修复：跑 embed-book.js 重灌（编目数据自动保留），或设 BSP_EMBED_MODEL=${marked} 切回原引擎。`);
  const row = db.prepare("SELECT emb FROM chunks WHERE emb IS NOT NULL LIMIT 1").get();
  if (row && row.emb.byteLength / 4 !== cfg.dim)
    throw new Error(`维度不一致：库里向量 ${row.emb.byteLength / 4} 维，当前引擎 ${embedKey} 应为 ${cfg.dim} 维。重灌库或换引擎。`);
}
