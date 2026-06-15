/**
 * embeddingService — OPTIONAL semantic layer via transformers.js.
 *
 * The Rust/WASM core gives us deterministic, lexical signals (token counts,
 * number/entity/constraint retention, Jaccard drift). For *semantic* questions
 * — "is this optimized prompt meaning-equivalent?", "which prior winning prompt
 * is most similar to this one?", "cluster these failures" — we want embeddings.
 *
 * transformers.js runs sentence-embedding models (e.g. all-MiniLM-L6-v2, 384-d)
 * fully in-browser on the WASM/WebGPU backend, so this stays client-side and
 * private, consistent with the app's threat model.
 *
 * It is loaded lazily and treated as a progressive enhancement: if the package
 * isn't installed (it is heavy and pulls a model download), every function
 * degrades gracefully and the deterministic WASM metrics remain the source of
 * truth. To enable: `npm i @huggingface/transformers` (or `@xenova/transformers`).
 */

export interface SemanticDrift {
  /** Cosine similarity of the two prompts' embeddings, 0..1. */
  similarity: number;
  /** 1 - similarity. Low = meaning preserved. */
  semantic_drift: number;
  /** Whether the embedding backend was actually available. */
  available: boolean;
}

type FeatureExtractor = (
  text: string | string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array }>;

let extractorPromise: Promise<FeatureExtractor | null> | null = null;

/** Lazily load the embedding pipeline; returns null if unavailable. */
async function getExtractor(): Promise<FeatureExtractor | null> {
  if (extractorPromise) return extractorPromise;
  extractorPromise = (async () => {
    try {
      // @vite-ignore keeps Vite from trying to bundle/resolve an optional dep.
      const mod: any = await import(
        /* @vite-ignore */ "@huggingface/transformers"
      ).catch(() =>
        import(/* @vite-ignore */ "@xenova/transformers"),
      );
      const pipeline = mod.pipeline;
      const extractor = await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
      );
      return extractor as FeatureExtractor;
    } catch {
      return null;
    }
  })();
  return extractorPromise;
}

/** True if the embedding backend can be loaded in this environment. */
export async function embeddingsAvailable(): Promise<boolean> {
  return (await getExtractor()) !== null;
}

/** Embed a single text → normalized vector, or null if unavailable. */
export async function embed(text: string): Promise<Float32Array | null> {
  const extractor = await getExtractor();
  if (!extractor) return null;
  const out = await extractor(text, { pooling: "mean", normalize: true });
  return out.data;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  // Vectors are already L2-normalized, so the dot product is the cosine.
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Semantic drift between an original and a transformed prompt. Complements the
 * WASM lexical/factual drift report with a meaning-level check. Falls back to
 * `available: false` (and similarity 1) when embeddings can't be loaded.
 */
export async function semanticDrift(
  original: string,
  transformed: string,
): Promise<SemanticDrift> {
  const [a, b] = await Promise.all([embed(original), embed(transformed)]);
  if (!a || !b) {
    return { similarity: 1, semantic_drift: 0, available: false };
  }
  const similarity = Math.max(0, Math.min(1, cosine(a, b)));
  return { similarity, semantic_drift: 1 - similarity, available: true };
}

/**
 * Rank a corpus of prior prompts by semantic similarity to a query prompt —
 * the in-browser core of a "find similar prior wins/failures" memory (the seam
 * where a vector store like ruVector would take over at scale).
 */
export async function mostSimilar(
  query: string,
  corpus: { id: string; text: string }[],
  topK = 5,
): Promise<{ id: string; similarity: number }[] | null> {
  const q = await embed(query);
  if (!q) return null;
  const scored: { id: string; similarity: number }[] = [];
  for (const item of corpus) {
    const v = await embed(item.text);
    if (v) scored.push({ id: item.id, similarity: cosine(q, v) });
  }
  return scored.sort((x, y) => y.similarity - x.similarity).slice(0, topK);
}
