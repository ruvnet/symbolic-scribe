# prompt-forge

A low-latency **prompt compiler & multi-objective optimizer** written in Rust and
compiled to WebAssembly. It is the deterministic, offline core of Symbolic
Scribe's "PromptOps" pipeline — it turns a loose natural-language prompt into a
structured, scored, compressed, risk-classified, and cryptographically signed
prompt artifact, entirely client-side.

```
raw prompt
  → parse        (AST + intent + constraints + schema)
  → compress     (SynthLang-style, meaning-preserving)
  → lint         (safety / ambiguity / schema)
  → compile      (canonical ROLE/TASK/CONSTRAINTS/OUTPUT/QUALITY-BAR form)
  → score        (7-objective composite + Pareto frontier)
  → firewall     (risk model → allow/log/approve/block)
  → receipt      (SHA-256 content address + HMAC witness)
```

Live model testing (OpenRouter) and optional semantic embeddings
(transformers.js) live in the host app; everything here is fast, deterministic,
and dependency-light so it can run on every keystroke.

## Why WASM

A full BPE tokenizer + scorer in JS is either slow or pulls megabytes of merge
tables. Doing it in Rust gives us:

- **Sub-millisecond latency** — see benchmarks below; `analyze()` is ~35 µs.
- **Determinism** — identical input → byte-identical output → reproducible
  signed receipts (enforced by `optimize_is_deterministic` test).
- **No network / no model download** for the core analysis.
- **Portability** — the same crate powers native `cargo test` and the browser.

## Public API (wasm-bindgen)

All functions take strings and return JSON strings (see `promptForge.ts` for
typed wrappers).

| Function | Purpose | Artifact |
|---|---|---|
| `count_tokens(text)` | fast token estimate | — |
| `analyze(raw, opts)` | full static analysis | `prompt.ast.json` |
| `optimize(raw, opts)` | compile + compress + score + rank + sign | `eval.receipt.json` |
| `compress(raw)` | SynthLang compression only | `prompt.synth` |
| `firewall(raw, ctx)` | risk classification + decision | `decision.receipt.json` |
| `scrub_secrets(raw)` | redact secrets/canaries | `scrub.report.json` |
| `drift_report(a, b)` | meaning-preservation check | — |
| `rank_pareto(cands)` | re-rank host-scored candidates | — |
| `verify_receipt(r, key)` | verify a witness signature | — |

## Scoring model

```
composite = 0.25·accuracy + 0.20·schema_validity + 0.15·token_efficiency
          + 0.15·latency_efficiency + 0.10·safety_margin
          + 0.10·cross_model_stability + 0.05·explainability
```

Static scores are transparent **proxies** (the live model test matrix overwrites
`accuracy`/`cross_model_stability` when real results exist). The hard
acceptance rule is enforced in `score::accepted`: a variant is only "improved"
if it beats baseline composite **without lowering accuracy, safety, or schema
validity**. Compression/compilation are meaning-preserving by construction, so
those three objectives are floored at the baseline for derived candidates.

## Risk model (firewall)

```
risk = 0.25·data_sensitivity + 0.20·tool_power + 0.20·instruction_conflict
     + 0.15·external_destination + 0.10·model_uncertainty
     + 0.10·prior_failure_similarity
```

Decision: `<0.30 allow`, `<0.60 allow_with_logging`, `<0.80 require_approval`,
`≥0.80 block` (+ incident). Critical finding combinations (secret + external
sink, or secret + logging) escalate regardless of the smooth average. Findings
use a fixed taxonomy: `PI JB SX TA PC RD MR AC LG EX`.

## Build

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.100   # must match the crate pin
bash ../build.sh          # or: npm run build:wasm   (from repo root)
```

Output lands in `src/wasm/pkg/` and is imported by Vite via
`new URL('…/prompt_forge_bg.wasm', import.meta.url)` — no extra Vite plugin
needed. The generated `pkg/` **is** committed so the app builds without a Rust
toolchain.

## Test & benchmark

```bash
cargo test                              # 75 unit tests
cargo run --release --example bench     # latency benchmark
```

Representative latencies (native `--release`, x86-64; WASM is ~2-4× slower but
still far under the UI's 120 ms debounce):

| op | input | ns/op |
|---|---|---|
| `count_tokens` | 62 tok | ~450 ns |
| `analyze` | 62 tok | ~35 µs |
| `optimize` | 62 tok | ~0.7 ms |
| `optimize` | 1960 tok | ~8 ms |

Artifact size: ~240 KB wasm (`opt-level="z"`, LTO, stripped).

## How this maps to the larger stack

This crate is the **Symbolic Scribe + SynthLang** layer (prompt authoring,
compression, scoring, receipts). It exposes clean seams for the rest of a
PromptOps platform without depending on it:

- `cross_model_stability` / `accuracy` → overwritten by a live **eval harness**.
- `prior_failure_similarity` (firewall ctx) → fed by a **vector store** of past
  incidents (e.g. embeddings via transformers.js / ruVector).
- `RouteHint` → consumed by a **model router**.
- witness receipts → chained by an external **signing / audit** service.
