# RuVector integration

Symbolic Scribe's PromptOps compiler can use [`ruvnet/RuVector`](https://github.com/ruvnet/RuVector)
for its **memory recall** and **model routing**, behind a feature flag. The
deterministic local path is the default; RuVector is opt-in (the "RuVector:
on/off" toggle on the `/optimize` page, persisted in localStorage).

## What's wired

| Concern | Package | Adapter | What it does |
|---|---|---|---|
| Prompt memory recall | `ruvector-wasm` (`VectorDB`) | `src/services/ruvectorBackend.ts` | Backs the `SimilarityBackend` so `recall()` / `prior_failure_similarity` run on RuVector instead of brute-force cosine. |
| Model routing | `@ruvector/ruvllm-wasm` (`HnswRouterWasm`) | `src/services/ruvectorRouter.ts` | Refines the Rust `RouteHint` by routing the prompt embedding against per-tier exemplars; `reinforce()` teaches it winning routes. |

Both are loaded via dynamic `import()`, so they compile to **separate lazy
chunks** (~255 KB + ~394 KB wasm) that are only fetched when the flag is enabled
— the main bundle is unaffected. Every entry point degrades gracefully: if a
package fails to load, the local backend / static hint stays in place.

## Findings from validating the live packages (do not assume — these were tested)

Tested against `ruvector-wasm@2.1.0` and `@ruvector/ruvllm-wasm@2.0.2` in Node:

1. **HNSW is not active in the current WASM build.** `new VectorDB(dim,
   "cosine", true)` logs `HNSW requested but not available (WASM build), using
   flat index`, so recall is O(n) today — same complexity as the local backend.
   It becomes O(log n) automatically when their WASM HNSW ships; no code change
   needed here.
2. **`VectorDB` `JsSearchResult.score` is a cosine *distance*** (lower = better),
   despite the d.ts comment. The adapter converts to similarity via
   `1 - score`. (The router's `RouteResultWasm.score` *is* a similarity,
   0–1, higher better — used as-is.)
3. **Object metadata does not round-trip through `VectorDB.search`.** The
   adapter keeps a sidecar `Map<id, MemoryEntry>` (also the source for `all()`
   and persistence). The router's metadata *does* round-trip as a JSON string.

## Why use it

- **Performance (latent):** O(log n) recall and ~1–2 ms routing once WASM HNSW
  lands; today it's a correctness-equivalent swap.
- **Learning:** RuVector's ReasoningBank/EWC++ can consume the win/failure
  receipts recorded by `promptMemory`, and `HnswRouterWasm.toJson()` persists a
  routing policy that improves with `reinforce()`.
- **Persistence:** `VectorDB.saveToIndexedDB()` / `loadFromIndexedDB()` are
  available for larger stores (we currently share the local-backend
  localStorage so toggling preserves history).

## Enabling

```bash
npm install            # ruvector-wasm + @ruvector/ruvllm-wasm are dependencies
npm run dev            # then toggle "RuVector: on" on /optimize
```

Determinism note: enabling RuVector only affects the *advisory* memory/routing
signals. The Rust compiler core (`optimize()` / `analyze()`) stays byte-for-byte
deterministic and reproducible regardless of the flag.
