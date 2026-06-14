/**
 * ruvectorBackend — a real RuVector-backed `SimilarityBackend`.
 *
 * Swaps the prompt-memory store from the default local brute-force cosine onto
 * `ruvector-wasm`'s `VectorDB`. Enabled behind a feature flag (default OFF) so
 * the deterministic local path stays the baseline.
 *
 * ## Notes from validating ruvector-wasm@2.1.0 against the live package
 *
 * - `VectorDB(dims, "cosine", true)` — the WASM build currently falls back to a
 *   *flat* index ("HNSW requested but not available (WASM build)"), so search is
 *   O(n) today; it becomes O(log n) automatically once their WASM HNSW lands.
 * - `JsSearchResult.score` is a cosine **distance** (lower = better), despite the
 *   d.ts comment — we convert to similarity via `1 - score`.
 * - Object metadata does not round-trip through `search`, so we keep a sidecar
 *   `Map<id, MemoryEntry>` (also our source for `all()` and persistence).
 *
 * IndexedDB persistence (`saveToIndexedDB`/`loadFromIndexedDB`) is available; we
 * persist the sidecar to the same localStorage key the local backend uses, so
 * toggling the flag preserves history either way.
 */

import {
  setBackend,
  loadStoredEntries,
  persistEntries,
  EMBED_DIM,
  type SimilarityBackend,
  type MemoryEntry,
  type Recall,
} from "./promptMemory";

const FLAG_KEY = "symbolic-scribe-memory-backend"; // "ruvector" | "local"

// Minimal shape of the bits of ruvector-wasm we use (avoids a hard type dep).
interface RuVectorModule {
  default: (input?: unknown) => Promise<unknown>;
  VectorDB: new (dimensions: number, metric?: string | null, useHnsw?: boolean | null) => RuVectorDB;
  version?: () => string;
}
interface RuVectorDB {
  insert(vector: Float32Array, id?: string | null, metadata?: unknown): string;
  delete(id: string): boolean;
  search(query: Float32Array, k: number, filter?: unknown): { id: string; score: number }[];
  len(): number;
}

class RuVectorBackend implements SimilarityBackend {
  private db: RuVectorDB;
  /** Sidecar metadata — ruvector-wasm search doesn't round-trip objects. */
  private meta = new Map<string, MemoryEntry>();

  private constructor(mod: RuVectorModule) {
    this.db = new mod.VectorDB(EMBED_DIM, "cosine", true);
  }

  /** Lazily load the wasm package, build the index from existing history. */
  static async create(): Promise<RuVectorBackend> {
    // Normal dynamic import → Vite emits a lazy chunk only fetched when enabled.
    const mod = (await import("ruvector-wasm")) as unknown as RuVectorModule;
    await mod.default();
    const backend = new RuVectorBackend(mod);
    // Rehydrate from shared storage so switching backends keeps prior cases.
    for (const e of loadStoredEntries()) {
      backend.meta.set(e.id, e);
      backend.db.insert(Float32Array.from(e.vector), e.id);
    }
    return backend;
  }

  upsert(id: string, vector: number[], meta: MemoryEntry): void {
    if (this.meta.has(id)) this.db.delete(id);
    this.db.insert(Float32Array.from(vector), id);
    this.meta.set(id, meta);
    persistEntries([...this.meta.values()]);
  }

  query(vector: number[], k: number): Recall[] {
    const hits = this.db.search(Float32Array.from(vector), k);
    return hits
      .map((h) => {
        const entry = this.meta.get(h.id);
        // score is a cosine distance → convert to similarity.
        return entry ? { entry, similarity: clamp01(1 - h.score) } : null;
      })
      .filter((r): r is Recall => r !== null)
      .sort((a, b) => b.similarity - a.similarity);
  }

  all(): MemoryEntry[] {
    return [...this.meta.values()];
  }

  clear(): void {
    for (const id of this.meta.keys()) this.db.delete(id);
    this.meta.clear();
    persistEntries([]);
  }
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Whether the RuVector backend is the persisted preference. */
export function ruvectorPreferred(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === "ruvector";
  } catch {
    return false;
  }
}

let active = false;
export function ruvectorActive(): boolean {
  return active;
}

/**
 * Enable the RuVector backend. Returns true on success; on any failure
 * (package missing, wasm init error) it leaves the local backend in place and
 * returns false — callers never break.
 */
export async function enableRuVector(): Promise<boolean> {
  try {
    const backend = await RuVectorBackend.create();
    setBackend(backend);
    active = true;
    try {
      localStorage.setItem(FLAG_KEY, "ruvector");
    } catch {
      /* ignore */
    }
    return true;
  } catch (err) {
    console.warn("RuVector backend unavailable, staying on local backend:", err);
    active = false;
    return false;
  }
}

/** Revert to the default local backend (requires a reload to fully reset). */
export function disableRuVector(): void {
  try {
    localStorage.setItem(FLAG_KEY, "local");
  } catch {
    /* ignore */
  }
  active = false;
}

/** Call once on app start: honor the persisted preference. */
export async function initMemoryBackend(): Promise<void> {
  if (ruvectorPreferred()) {
    await enableRuVector();
  }
}
