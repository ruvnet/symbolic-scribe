/**
 * ruvectorRouter — refine the WASM compiler's `RouteHint` with a learned,
 * embedding-based router (`@ruvector/ruvllm-wasm`'s `HnswRouterWasm`).
 *
 * The Rust core produces a heuristic `RouteHint` (tier + examples) from static
 * features. Here we corroborate/override it by routing the prompt's embedding
 * against a small bank of labeled exemplars — one per capability tier. The
 * router is seeded from representative prompts and learns as you `reinforce()`
 * winning routes; its state serializes to localStorage via `toJson`.
 *
 * Validated against `@ruvector/ruvllm-wasm@2.0.2`:
 *   - `new HnswRouterWasm(dims, maxPatterns)`
 *   - `addPattern(Float32Array, name, metadataJsonString) -> bool`
 *   - `route(Float32Array, topK) -> { name, score (cosine sim, higher=better),
 *      metadata (json string) }[]`
 *   - `toJson()/fromJson()` for persistence.
 *
 * Feature-flagged and graceful: if the package can't load, `refineRoute` simply
 * returns the original hint.
 */

import { hashEmbed, EMBED_DIM } from "./promptMemory";
import type { RouteHint } from "./promptForge";

const ROUTER_KEY = "symbolic-scribe-router-state";

/** Seed exemplars: representative prompts per capability tier. */
const EXEMPLARS: { tier: string; name: string; text: string; examples: string[] }[] = [
  {
    tier: "nano",
    name: "simple-classify",
    text: "Classify the sentiment of this review as positive, negative, or neutral. Return one word.",
    examples: ["gpt-4o-mini", "claude-haiku", "gemini-flash-lite"],
  },
  {
    tier: "small",
    name: "summarize-extract",
    text: "Summarize this support ticket in three bullet points and extract the key entities as JSON.",
    examples: ["claude-haiku", "gpt-4o-mini", "llama-3.1-8b"],
  },
  {
    tier: "mid",
    name: "multi-constraint",
    text: "Write structured release notes grouped by Added, Changed, Fixed in markdown, under 200 words, citing each source line.",
    examples: ["claude-sonnet", "gpt-4o", "gemini-pro"],
  },
  {
    tier: "frontier",
    name: "reason-code",
    text: "Solve this problem step by step, prove each transformation, then implement and unit-test the function in Rust.",
    examples: ["claude-opus", "gpt-4.1", "gemini-ultra"],
  },
];

interface RouterModule {
  default: (input?: unknown) => Promise<unknown>;
  HnswRouterWasm: {
    new (dimensions: number, maxPatterns: number): HnswRouter;
    fromJson(json: string): HnswRouter;
  };
}
interface HnswRouter {
  addPattern(embedding: Float32Array, name: string, metadata: string): boolean;
  route(query: Float32Array, topK: number): { name: string; score: number; metadata: string }[];
  toJson(): string;
}

let routerPromise: Promise<HnswRouter | null> | null = null;

async function getRouter(): Promise<HnswRouter | null> {
  if (routerPromise) return routerPromise;
  routerPromise = (async () => {
    try {
      const mod = (await import("@ruvector/ruvllm-wasm")) as unknown as RouterModule;
      await mod.default();
      let router: HnswRouter;
      const saved = safeGet(ROUTER_KEY);
      if (saved) {
        try {
          router = mod.HnswRouterWasm.fromJson(saved);
        } catch {
          router = seed(mod);
        }
      } else {
        router = seed(mod);
      }
      return router;
    } catch (err) {
      console.warn("RuVector router unavailable:", err);
      return null;
    }
  })();
  return routerPromise;
}

function seed(mod: RouterModule): HnswRouter {
  const router = new mod.HnswRouterWasm(EMBED_DIM, 256);
  for (const ex of EXEMPLARS) {
    router.addPattern(
      Float32Array.from(hashEmbed(ex.text)),
      ex.name,
      JSON.stringify({ tier: ex.tier, examples: ex.examples }),
    );
  }
  return router;
}

export interface RoutePrediction {
  tier: string;
  name: string;
  similarity: number;
  examples: string[];
}

/** Route a prompt to its nearest exemplar; null if the router is unavailable. */
export async function predictRoute(prompt: string): Promise<RoutePrediction | null> {
  const router = await getRouter();
  if (!router) return null;
  const results = router.route(Float32Array.from(hashEmbed(prompt)), 1);
  if (!results.length) return null;
  const top = results[0];
  const meta = safeParse(top.metadata);
  return {
    tier: (meta.tier as string) ?? "small",
    name: top.name,
    similarity: top.score,
    examples: (meta.examples as string[]) ?? [],
  };
}

/**
 * Blend the router's prediction into the compiler's static RouteHint. The
 * router only overrides the tier when it is confident (similarity above
 * threshold); otherwise the static hint stands. Always returns a valid hint.
 */
export async function refineRoute(prompt: string, base: RouteHint): Promise<RouteHint> {
  const pred = await predictRoute(prompt);
  if (!pred || pred.similarity < 0.45) return base;
  return {
    ...base,
    tier: pred.tier,
    examples: pred.examples.length ? pred.examples : base.examples,
    rationale: `${base.rationale} · RuVector router → "${pred.name}" tier=${pred.tier} (sim ${pred.similarity.toFixed(2)}).`,
  };
}

/**
 * Reinforce a winning route: add the prompt as a new exemplar for its tier so
 * future similar prompts route there. Persists router state to localStorage.
 */
export async function reinforce(prompt: string, tier: string, examples: string[]): Promise<void> {
  const router = await getRouter();
  if (!router) return;
  router.addPattern(
    Float32Array.from(hashEmbed(prompt)),
    `learned-${tier}-${Date.now().toString(36)}`,
    JSON.stringify({ tier, examples }),
  );
  safeSet(ROUTER_KEY, router.toJson());
}

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
