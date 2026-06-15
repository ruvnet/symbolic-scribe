/**
 * promptMemory — a learning memory layer for the PromptOps compiler.
 *
 * The Rust/WASM core (`promptForge`) is intentionally *stateless and
 * deterministic*: same prompt in → same artifact out. That is the right
 * property for a compiler, but it means the system never gets smarter. This
 * module adds the missing half — **memory** — without compromising the core's
 * determinism:
 *
 *   - every optimization/firewall outcome is recorded with an embedding,
 *   - a new prompt recalls its k nearest prior cases (wins AND failures),
 *   - the max similarity to prior *failures/blocks* becomes
 *     `prior_failure_similarity`, which is fed into `firewall(raw, ctx)` — so a
 *     prompt resembling a past attack scores higher risk over time.
 *
 * ## Backend
 *
 * Similarity search and embedding are behind a small interface so the backend
 * can be swapped without touching callers. The default backend is a
 * dependency-free, deterministic hashing embedder + brute-force cosine — it
 * works offline today. At scale, swap in **RuVector** (`ruvnet/RuVector`):
 *
 *   - `ruvector-wasm` — in-browser HNSW (self-learning, GNN-enhanced),
 *     ~1-2ms/query, O(log n) instead of the O(n) scan here.
 *   - `@ruvector/ruvllm-wasm` `HnswRouterWasm` — learned model routing to back
 *     `RouteHint`.
 *   - RuVector's ReasoningBank — trajectory learning over the win/failure
 *     receipts recorded here; EWC++ keeps the regression set from drifting.
 *
 * See `RuVectorBackend` below for the adapter shape; the methods used here
 * (`upsert`, `query`) map onto RuVector's HNSW index. Confirm exact method
 * names against the installed package version before enabling.
 */

const STORE_KEY = "symbolic-scribe-prompt-memory";
/** Embedding width. Exported so swappable backends build matching vectors. */
export const EMBED_DIM = 256;
const MAX_ENTRIES = 500;

export interface MemoryEntry {
  id: string;
  /** First ~160 chars of the prompt, for display. */
  preview: string;
  /** Normalized embedding vector. */
  vector: number[];
  composite: number;
  accepted: boolean;
  /** Firewall decision at record time. */
  decision: string;
  /** Failure-taxonomy codes that fired (PI/SX/...). */
  findings: string[];
  tokenReduction: number;
  /** Receipt bundle hash, for audit linking. */
  bundleHash: string;
  at: number;
}

export interface Recall {
  entry: MemoryEntry;
  similarity: number;
}

export interface PriorStats {
  /** Max cosine similarity to any prior failed/blocked prompt, 0..1. */
  priorFailureSimilarity: number;
  /** Max similarity to any prior accepted "win", 0..1. */
  priorWinSimilarity: number;
  /** Total recorded entries. */
  size: number;
  nearest: Recall[];
}

/** Adapter interface — implement this with RuVector to scale past brute force. */
export interface SimilarityBackend {
  upsert(id: string, vector: number[], meta: MemoryEntry): void;
  query(vector: number[], k: number): Recall[];
  all(): MemoryEntry[];
  clear(): void;
}

// ---------------------------------------------------------------------------
// Default backend: deterministic hashing embedder + localStorage + cosine.
// ---------------------------------------------------------------------------

/**
 * Deterministic feature-hashing embedder. Token bigrams are hashed into a
 * fixed-width vector and L2-normalized. No network, no model — gives stable
 * lexical similarity that is good enough to detect "this looks like a prompt
 * I've seen before". Upgrade to transformers.js / RuVector embeddings for
 * semantic recall (see embeddingService.ts).
 */
export function hashEmbed(text: string): number[] {
  const v = new Float64Array(EMBED_DIM);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  const grams: string[] = [...tokens];
  for (let i = 0; i < tokens.length - 1; i++) grams.push(tokens[i] + "_" + tokens[i + 1]);
  for (const g of grams) {
    const h = fnv1a(g);
    const idx = h % EMBED_DIM;
    const sign = (h >>> 31) & 1 ? -1 : 1;
    v[idx] += sign;
  }
  // L2 normalize.
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  return Array.from(v, (x) => x / norm);
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // both are L2-normalized
}

/** Load persisted entries (shared across backends so switching keeps history). */
export function loadStoredEntries(): MemoryEntry[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as MemoryEntry[]) : [];
  } catch {
    return [];
  }
}

/** Persist entries (FIFO-capped) to shared storage. */
export function persistEntries(entries: MemoryEntry[]): void {
  try {
    const capped =
      entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
    localStorage.setItem(STORE_KEY, JSON.stringify(capped));
  } catch {
    /* storage full / unavailable — degrade silently */
  }
}

class LocalBackend implements SimilarityBackend {
  private entries: MemoryEntry[] = [];

  constructor() {
    this.entries = loadStoredEntries();
  }

  private persist() {
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(this.entries.length - MAX_ENTRIES);
    }
    persistEntries(this.entries);
  }

  upsert(id: string, _vector: number[], meta: MemoryEntry) {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx >= 0) this.entries[idx] = meta;
    else this.entries.push(meta);
    this.persist();
  }

  query(vector: number[], k: number): Recall[] {
    return this.entries
      .map((entry) => ({ entry, similarity: cosine(vector, entry.vector) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
  }

  all() {
    return [...this.entries];
  }

  clear() {
    this.entries = [];
    this.persist();
  }
}

let backend: SimilarityBackend = new LocalBackend();

/** Swap in a RuVector-backed implementation (HNSW) when available. */
export function setBackend(b: SimilarityBackend) {
  backend = b;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export interface RecordInput {
  prompt: string;
  composite: number;
  accepted: boolean;
  decision: string;
  findings: string[];
  tokenReduction: number;
  bundleHash: string;
}

/** Record an optimization/firewall outcome into memory. */
export function record(input: RecordInput): void {
  const vector = hashEmbed(input.prompt);
  const entry: MemoryEntry = {
    id: input.bundleHash || `e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    preview: input.prompt.slice(0, 160),
    vector,
    composite: input.composite,
    accepted: input.accepted,
    decision: input.decision,
    findings: input.findings,
    tokenReduction: input.tokenReduction,
    bundleHash: input.bundleHash,
    at: Date.now(),
  };
  backend.upsert(entry.id, vector, entry);
}

/**
 * Recall prior cases for a prompt and derive the learning signals the firewall
 * consumes. `priorFailureSimilarity` rises as the prompt resembles past
 * blocked/flagged prompts — closing the red-team learning loop.
 */
export function recall(prompt: string, k = 5): PriorStats {
  const vector = hashEmbed(prompt);
  const nearest = backend.query(vector, k);
  let priorFailureSimilarity = 0;
  let priorWinSimilarity = 0;
  for (const r of nearest) {
    const failed = r.entry.decision !== "allow" || r.entry.findings.length > 0;
    if (failed) priorFailureSimilarity = Math.max(priorFailureSimilarity, r.similarity);
    if (r.entry.accepted) priorWinSimilarity = Math.max(priorWinSimilarity, r.similarity);
  }
  return {
    priorFailureSimilarity: clamp01(priorFailureSimilarity),
    priorWinSimilarity: clamp01(priorWinSimilarity),
    size: backend.all().length,
    nearest,
  };
}

export function memorySize(): number {
  return backend.all().length;
}

export function clearMemory(): void {
  backend.clear();
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Reference shape for a RuVector-backed implementation. Not wired by default;
 * documents how the swap works.
 *
 * ```ts
 * import init, { VectorIndex } from "ruvector-wasm";
 * class RuVectorBackend implements SimilarityBackend {
 *   private idx: VectorIndex;          // self-learning HNSW
 *   private meta = new Map<string, MemoryEntry>();
 *   async ready() { await init(); this.idx = new VectorIndex(256); }
 *   upsert(id, vector, meta) { this.idx.add(id, Float32Array.from(vector)); this.meta.set(id, meta); }
 *   query(vector, k) {
 *     return this.idx.search(Float32Array.from(vector), k)
 *       .map(({ id, score }) => ({ entry: this.meta.get(id)!, similarity: score }));
 *   }
 *   all() { return [...this.meta.values()]; }
 *   clear() { this.idx.reset(); this.meta.clear(); }
 * }
 * setBackend(new RuVectorBackend());
 * ```
 */
export type RuVectorBackend = SimilarityBackend;
