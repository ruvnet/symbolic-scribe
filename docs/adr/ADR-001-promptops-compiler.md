# ADR-001: A Rust→WASM PromptOps compiler core

- **Status:** Accepted
- **Date:** 2026-06-14

## Context

Symbolic Scribe authors structured prompts. The next step is to make it a
*compiler* for prompts: take a loose natural-language prompt and emit a
structured, compressed, scored, risk-checked, and signed artifact — a
"PromptOps" pipeline. We want this to be:

1. **Fast** enough to run on every keystroke (live analysis).
2. **Deterministic**, so optimization results and signed receipts are
   reproducible and auditable.
3. **Private / offline** for the core analysis — no prompt text leaves the
   browser unless the user explicitly runs a live model test.
4. **Honest** — never claim a prompt is "improved" unless it provably beats the
   baseline without regressing the things that matter (accuracy, safety,
   schema).

A pure-TypeScript implementation struggles with (1) and (2): an accurate
tokenizer needs a large merge table, and floating-point scoring across a
candidate search is easy to make non-deterministic.

## Decision

Implement the deterministic core as a small Rust crate (`wasm/prompt-forge`)
compiled to WebAssembly via `wasm-bindgen`, and consume it from the React app
through a typed wrapper (`src/services/promptForge.ts`).

The crate owns the whole offline pipeline:

```
parse (AST + intent + constraints + schema)
  → SynthLang compression (meaning-preserving)
  → safety / ambiguity / schema lint
  → symbolic-form compile
  → 7-objective score + Pareto frontier
  → risk firewall (allow/log/approve/block)
  → SHA-256 + HMAC witness receipt
```

Live concerns (calling models, embeddings, persistence) stay in the host and
plug into clean seams: the score struct's `accuracy`/`cross_model_stability`
fields are overwritten by a live eval; the firewall accepts a
`prior_failure_similarity` from an external vector store; `RouteHint` feeds a
model router.

### Key design rules

- **Token estimator, not tokenizer.** A calibrated GPT-style heuristic lands
  within ~10–15% of `cl100k_base` with no merge table and ~450 ns/op. The exact
  count is the live provider's job; the estimate is for guidance.
- **Meaning-preserving transforms floor the semantic objectives.** Compression
  and compilation cannot lower true accuracy/safety/schema, so derived
  candidates inherit the baseline as a lower bound on those three. This prevents
  proxy artifacts (e.g. filler removal stripping a constraint keyword) from
  blocking real token savings, while keeping the strict no-regression rule.
- **Drift is checked explicitly.** Every optimization emits a drift report
  proving numbers, entities, and constraints survived; the UI surfaces it.
- **Everything is signed.** Each result carries a content-addressed SHA-256
  bundle hash and an HMAC witness, verifiable with `verify_receipt`. The HMAC
  is a seam for a real asymmetric witness chain later.

## Alternatives considered

- **Pure TypeScript** — rejected for tokenizer accuracy/size and determinism.
- **`tiktoken` WASM** — accurate but multi-MB and overkill for guidance; we only
  need fast estimates client-side.
- **Server-side compiler** — rejected; violates the client-side/offline threat
  model and adds latency + cost.
- **`serde-wasm-bindgen` structured returns** — chose JSON strings instead to
  keep the ABI trivial and dependency-light; parsing cost is negligible.

## Consequences

- The repo now needs a Rust + `wasm-bindgen` toolchain to *rebuild* the wasm,
  but the generated `src/wasm/pkg/` is committed so `npm run build` works
  without Rust. CI builds the wasm via `npm run build:wasm`.
- 75 native unit tests cover the pipeline; a determinism test guarantees stable
  receipts; a benchmark guards latency.
- The wasm artifact is ~240 KB (gzip ~100 KB) — acceptable for the value, and
  lazy-initialized so it never blocks first paint.

## Status of the broader vision

This ADR scopes the **Symbolic Scribe + SynthLang** compiler layer only. The
red-team/blue-team security range, the vector-memory layer, the eval harness,
and enterprise packaging are out of scope here but are explicitly anticipated by
the seams described above.
