# Symbolic Scribe

A specialized prompt engineering tool that uses mathematical frameworks to generate precise, structured prompts for AI interactions.

## PromptOps Compiler (Rust → WASM)

Symbolic Scribe is also a **compiler for prompts**. The `/optimize` page takes a
loose natural-language prompt and compiles it — entirely in your browser — into a
structured, scored, compressed, risk-checked, and cryptographically signed
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
- **Drift report** proves numbers/entities/constraints survive compression.
- **Prompt firewall** classifies injection / secret-exposure / tool-abuse risk
  and returns an allow / log / approve / block decision.
- **Signed receipts** make every winning prompt auditable.

Build & test the core:

```bash
npm run build:wasm     # compile Rust → src/wasm/pkg (needs rustup + wasm-bindgen 0.2.100)
npm run test:wasm      # 75 native unit tests
npm run bench:wasm     # latency benchmark
```

The generated `src/wasm/pkg/` is committed, so `npm run build` works without a
Rust toolchain. See `wasm/prompt-forge/README.md` and
`docs/adr/ADR-001-promptops-compiler.md` for details.

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
