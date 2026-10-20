/** 纯函数：BM25 检索（用于全文问答时挑相关段落）。零依赖，支持中英混排。 */

export interface Chunk {
  id: string;
  pageIndex: number;
  sectionTitle: string;
  text: string;
}

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}

export interface Bm25Index {
  chunks: Chunk[];
  docTokens: string[][];
  df: Map<string, number>;
  avgLen: number;
  idf: Map<string, number>;
}

const K1 = 1.5;
const B = 0.75;

/** 英文按词切，中文按二元组切（无需分词器即可获得可用的召回） */
export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  const tokens: string[] = [];
  const latin = lowered.match(/[a-z0-9][a-z0-9+.#\-_/]*/g) ?? [];
  tokens.push(...latin);
  const cjkRuns = lowered.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

export function buildIndex(chunks: Chunk[]): Bm25Index {
  const docTokens = chunks.map((c) => tokenize(`${c.sectionTitle} ${c.text}`));
  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const total = Math.max(1, docTokens.length);
  const idf = new Map<string, number>();
  for (const [term, freq] of df) {
    idf.set(term, Math.log(1 + (total - freq + 0.5) / (freq + 0.5)));
  }
  const avgLen = docTokens.reduce((sum, t) => sum + t.length, 0) / total;
  return { chunks, docTokens, df, avgLen, idf };
}

export function search(index: Bm25Index, query: string, k = 6): ScoredChunk[] {
  const queryTerms = Array.from(new Set(tokenize(query)));
  if (queryTerms.length === 0) return [];
  const scored = index.chunks.map((chunk, i) => {
    const tokens = index.docTokens[i];
    const len = tokens.length || 1;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const f = tf.get(term);
      if (!f) continue;
      const idf = index.idf.get(term) ?? 0;
      score += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * len) / index.avgLen));
    }
    return { chunk, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
