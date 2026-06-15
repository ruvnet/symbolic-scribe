# ADR-002: Live OpenRouter-fusion benchmark harness

- **Status:** Accepted
- **Date:** 2026-06-14

## Context

ADR-001 ships a deterministic offline compiler whose 7-objective score uses
*proxies* for the model-dependent objectives (accuracy, schema validity,
cross-model stability). `src/services/promptEval.ts` already defines the seam to
replace those proxies with **measured** numbers via an injectable `ChatFn`, and
the browser `EvalPanel` exercises it interactively. What was missing:

1. A **headless** way to run the same eval methodology in CI / from the terminal,
   so optimizer changes can be regression-gated against real model behaviour.
2. A concrete answer to "does the optimizer's chosen candidate actually win
   against a strong model?" — measured, not asserted.
3. Secret hygiene: the OpenRouter key must never land in the repo, a build, or
   shell history.

## Decision

Add a Node benchmark runner, `scripts/bench-fusion.mjs` (`npm run bench:fusion`),
that:

- Loads the **real** committed Rust→WASM compiler (`src/wasm/pkg`) under Node by
  compiling the `.wasm` bytes directly into a `WebAssembly.Module` and passing it
  to the wasm-bindgen `init({module_or_path})` entry — no browser, no `fetch`, no
  rebuild. The optimizer that runs in CI is byte-identical to the one in the app.
- Runs the optimizer's actual baseline vs. Pareto-`optimized` candidate against a
  live model — default **`openrouter/fusion`**, OpenRouter's multi-model
  deliberation meta-model — over a small JSON-extraction corpus.
- Grades outputs with the **same check semantics** as `promptEval.ts`
  (`json_valid` / `has_field` / `contains` / `not_contains`), aggregates with the
  canonical `weights()` from the WASM core, re-ranks by composite, and writes a
  `bench/fusion-proof.json` receipt (matrix size, per-candidate measured score,
  winner, total USD).

Secret sourcing is a thin wrapper, `scripts/bench-fusion.sh`, which pulls
`OPENROUTER_API_KEY` from **GCP Secret Manager**
(`gcloud secrets versions access latest --secret=OPENROUTER_API_KEY`) into the
process environment only. The `.mjs` reads the key from `process.env` and never
persists it.

The matrix is deliberately tiny (2 candidates × 1 model × 3 cases). `fusion` fans
out to a panel of models per call, so cost and latency are dominated by the model,
not the matrix — small keeps it bounded while still being a real signal.

## Review fixes shipped alongside

A review of the PR surfaced defects that this change also fixes, because an
honest benchmark depends on honest scoring:

- **schema_validity aggregation (correctness).** `aggregateCandidate` divided the
  all-checks pass count by the count of cells with *any* check, making
  schema_validity numerically identical to accuracy. It now tracks structural
  (`json_valid`/`has_field`) checks explicitly via
  `schemaChecksPassed`/`schemaChecksTotal` and reports the fraction of those that
  passed. The Node bench mirrors the corrected logic.
- **UTF-8 redaction panic (safety).** `risk::redact_token` byte-sliced a token and
  panicked when byte 4 split a multi-byte char; it now slices by `chars()`.
- **NaN sort panics (robustness).** Host-supplied `Score`/`RiskContext` JSON could
  feed `NaN` into `partial_cmp().unwrap()`; both sites use
  `unwrap_or(Ordering::Equal)` and the risk context is `is_finite`-guarded.
- **Dead firewall-learning loop.** The optimize handler recorded a stale/empty
  debounced `decision`; it now computes the firewall verdict synchronously for the
  exact optimized prompt before recording, so `prior_failure_similarity` can grow.
- **Witness framing.** Because the HMAC key ships in the client bundle, the UI no
  longer claims the receipt is a "cryptographically signed / verifiable" witness;
  it is described as a tamper-evident **integrity checksum**. A real asymmetric
  witness chain remains future work (per ADR-001).

## Alternatives considered

- **Mint a separate harness product** (via `ruvnet/agent-harness-generator`) and
  run its DRACO bench. We *did* mint a repo-maintainer harness (`harness/`) for
  agent orchestration, but its DRACO bench is coupled to `@ruflo/kernel` and
  targets deep-research, not prompt-candidate scoring. Reusing the PR's own
  `promptEval` methodology gives a benchmark that directly validates *this*
  optimizer.
- **Re-implement grading in the bench.** Rejected as the long-term shape — the
  current `.mjs` inlines a minimal grader to stay dependency-free; the intent is
  to converge it onto the TS module once a Node-friendly build of `promptEval` is
  extracted.

## Consequences

- CI can gate the optimizer on measured behaviour with one secret
  (`OPENROUTER_API_KEY`) and no browser.
- The proof JSON is the artifact of record; numbers vary per run because `fusion`
  is non-deterministic and dynamically priced, so the bench reports the measured
  ranking + cost rather than pinning a fixed score.
- Anyone without GCP access can still run it by exporting `OPENROUTER_API_KEY`
  directly; the GCP wrapper is a convenience, not a hard dependency.
