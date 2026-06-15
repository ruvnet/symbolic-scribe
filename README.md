# Symbolic Scribe

A specialized prompt engineering tool that uses mathematical frameworks to generate precise, structured prompts for AI interactions.

## PromptOps Compiler (Rust → WASM)

Symbolic Scribe is also a **compiler for prompts**. The `/optimize` page takes a
loose natural-language prompt and compiles it — entirely in your browser — into a
structured, scored, compressed, risk-checked, and witness-checksummed
artifact. The deterministic core is a Rust crate compiled to WebAssembly
(`wasm/prompt-forge`, exposed via `src/services/promptForge.ts`):

```
raw prompt → AST + intent + constraints → SynthLang compression
           → safety / ambiguity / schema lint → symbolic-form compile
           → 7-objective score + Pareto frontier → risk firewall
           → SHA-256 + HMAC witness receipt
```

- **Sub-millisecond, deterministic, offline** — runs on every keystroke, no
  prompt text leaves the browser for the core analysis.
- **Multi-objective optimization** with a hard rule: a prompt is only "improved"
  if it beats baseline **without lowering accuracy, safety, or schema validity**.
- **Live eval matrix** (`src/services/promptEval.ts`) closes the loop: it runs the
  optimizer's Pareto-frontier candidates against real OpenRouter models over an
  editable test suite, grades outputs (schema validity, assertions, refusals,
  length), and **replaces the static accuracy/schema/cross-model-stability
  proxies with measured numbers** — then re-ranks with the same weights. The
  model call is injectable, so grading/aggregation is unit-tested offline.
- **Drift report** proves numbers/entities/constraints survive compression.
- **Prompt firewall** classifies injection / secret-exposure / tool-abuse risk
  and returns an allow / log / approve / block decision.
- **Witness receipts** make every winning prompt auditable: each carries a
  content-addressed SHA-256 bundle hash plus an HMAC witness. Because the HMAC
  key ships in the client bundle, this is a **tamper-evident integrity
  checksum**, not an authenticity signature (a server-side / asymmetric witness
  chain is future work).
- **Learning memory** (`src/services/promptMemory.ts`) records every outcome and
  recalls similar prior cases, feeding `prior_failure_similarity` back into the
  firewall — so prompts resembling past attacks score higher risk over time. The
  similarity backend is swappable: a deterministic local embedder + cosine works
  offline by default, and [`ruvnet/RuVector`](https://github.com/ruvnet/RuVector)
  is **wired behind a feature flag** — `ruvector-wasm` (`VectorDB`) for recall and
  `@ruvector/ruvllm-wasm` (`HnswRouterWasm`) to back the model `RouteHint`. Toggle
  "RuVector: on" on `/optimize`. See [`docs/ruvector-integration.md`](docs/ruvector-integration.md).

Build & test the core:

```bash
npm run build:wasm     # compile Rust → src/wasm/pkg (needs rustup + wasm-bindgen 0.2.100)
npm run test:wasm      # 79 native unit tests
npm run bench:wasm     # latency benchmark
```

The generated `src/wasm/pkg/` is committed, so `npm run build` works without a
Rust toolchain. See `wasm/prompt-forge/README.md` and
`docs/adr/ADR-001-promptops-compiler.md` for details.

### Performance

The compiler is built to run on every keystroke. Native `--release` latency
(`npm run bench:wasm`) on the hot paths:

| Operation | Latency | Throughput |
|-----------|--------:|-----------:|
| `count_tokens` (medium) | ~230 ns | ~4.3 M/s |
| `analyze` (medium) | ~36 µs | ~28 K/s |
| `compress` (medium) | ~50 µs | ~20 K/s |
| `optimize` (medium) | ~397 µs | ~2.5 K/s |
| `optimize` (large, ~2K tok) | ~5.7 ms | ~174/s |

The `compress`/`optimize` paths were tuned to lowercase each line once per pass
instead of once per filler phrase — a **5.4× `compress`** and **2.1×
`optimize(large)`** speedup. The UI debounces `analyze()` to ~120 ms, leaving
ample headroom.

### Live benchmark against OpenRouter `fusion`

`npm run bench:fusion` is a headless harness that loads the **real** WASM
optimizer under Node, runs its baseline vs. optimized candidates against a live
model (default `openrouter/fusion`) over a JSON-extraction corpus, grades with
the same checks as the in-app eval matrix, and writes `bench/fusion-proof.json`:

```bash
OPENROUTER_API_KEY=sk-or-... npm run bench:fusion
# or source the key from GCP Secret Manager:
scripts/bench-fusion.sh
```

See `docs/adr/ADR-002-live-fusion-benchmark.md`.

### Agent harness

A repo-aware agent harness (maintainer / benchmarker / release / security agents,
plus `doctor` / `repo-triage` / `release-check` commands) is published to npm and
lives in [`harness/`](harness):

```bash
npx symbolic-scribe-harness doctor
```

## Key Features & Benefits

### Mathematical Framework Integration
- **Set Theory Templates**: Model complex relationships and hierarchies
- **Category Theory**: Define abstract transformations and mappings
- **Abstract Algebra**: Structure group operations and symmetries
- **Topology**: Explore continuous transformations and invariants
- **Complex Analysis**: Handle multi-dimensional relationships

### Practical Applications
- **Information Security**: Model threat vectors and attack surfaces
- **Ethical Analysis**: Structure moral frameworks and constraints
- **AI Safety**: Define system boundaries and safety properties
- **Domain Adaptation**: Apply mathematical rigor to any field

### User Experience
- **Interactive Console**: Terminal-style interface with modern aesthetics
- **Real-time Preview**: Test prompts with multiple AI models
- **Template Library**: Pre-built frameworks for common use cases
- **Mobile Responsive**: Full functionality on all device sizes
- **Local Storage**: Secure saving of prompts and preferences

## Security Features

### API Key Management
- Encrypted local storage of API keys
- Optional environment variable configuration
- No server-side key storage
- Automatic key validation

### Data Privacy
- Client-side only processing
- No external data transmission except to OpenRouter API
- No tracking or analytics
- Configurable model selection

## Quick Start

1. **Installation**
```bash
git clone https://github.com/yourusername/symbolic-scribe.git
cd symbolic-scribe
npm install
```

2. **Configuration**
```bash
cp .env.sample .env
# Edit .env with your OpenRouter API key
```

3. **Development**
```bash
npm run dev
```

4. **Production Build**
```bash
npm run build
npm run preview
```

## Usage Guide

### Basic Prompt Generation
1. Select a mathematical framework template
2. Choose your target domain
3. Define your variables and relationships
4. Generate structured prompts

### Template Customization
1. Navigate to Templates page
2. Select a base template
3. Modify variables and relationships
4. Save for future use

### Testing & Iteration
1. Use the Preview function to test prompts
2. Select different models for comparison
3. Refine based on responses
4. Export final versions

## InfoSec Overview

### Threat Model
- Client-side only architecture
- No persistent server storage
- Encrypted API key storage
- Input sanitization

### Best Practices
- Regular API key rotation
- Use environment variables in production
- Monitor API usage
- Review generated prompts for sensitive data

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Setup
1. Fork the repository
2. Create a feature branch
3. Install dependencies
4. Make your changes
5. Run tests
6. Submit a PR

## Support

- Documentation: `/docs` page in app
- Issues: GitHub issue tracker
- Community: Discord server (coming soon)

## License

MIT License - see LICENSE file for details

## Acknowledgments

- OpenRouter for AI model access
- shadcn/ui for component library
- Tailwind CSS for styling
- Vite for build tooling
