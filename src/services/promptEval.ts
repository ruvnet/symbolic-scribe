/**
 * promptEval — the live model test matrix.
 *
 * The WASM compiler scores candidates with transparent *proxies* for accuracy,
 * schema validity, and cross-model stability. This module replaces those proxies
 * with **measured** numbers by running each candidate prompt against real models
 * over a test suite, grading the outputs, and recomputing the composite with the
 * canonical weights. The re-ranked Pareto frontier then reflects real behavior.
 *
 * Design: the model call is injected (`ChatFn`), so all scoring/aggregation is
 * deterministic and unit-testable without a network. `openRouterChat()` is the
 * production runner; tests pass a mock.
 */

import type { Candidate, Score, Weights } from "./promptForge";

// A lightweight, dependency-free token estimate used only for the `max_tokens`
// check and as a usage fallback. The compiler's calibrated WASM estimator is
// the source of truth for prompt scoring; this avoids coupling the eval harness
// (and its tests) to wasm initialization.
function estTokens(text: string): number {
  return Math.max(text ? 1 : 0, Math.round(text.trim().length / 4));
}

// --- Test suite model -------------------------------------------------------

export type Check =
  | { kind: "json_valid" }
  | { kind: "has_field"; field: string }
  | { kind: "contains"; text: string }
  | { kind: "not_contains"; text: string }
  | { kind: "regex"; pattern: string }
  | { kind: "max_tokens"; n: number }
  | { kind: "refuses" };

export interface TestCase {
  id: string;
  /** Value substituted for the prompt's first {placeholder} (or appended). */
  input: string;
  checks: Check[];
}

export interface ChatResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export type ChatFn = (modelId: string, prompt: string) => Promise<ChatResult>;

export interface ModelPricing {
  /** USD per 1K prompt tokens. */
  prompt: number;
  /** USD per 1K completion tokens. */
  completion: number;
}

export interface CellResult {
  candidate: string;
  model: string;
  testCaseId: string;
  output: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  checksPassed: number;
  checksTotal: number;
  /** Of this cell's checks, how many were structural (json_valid/has_field). */
  schemaChecksPassed?: number;
  schemaChecksTotal?: number;
  pass: boolean; // all checks passed
  failures: string[];
}

export interface CandidateEval {
  label: string;
  text: string;
  cells: CellResult[];
  /** Measured score (static fields preserved, measured ones overwritten). */
  score: Score;
  accuracy: number;
  schemaValidity: number;
  crossModelStability: number;
  meanLatencyMs: number;
  totalCostUsd: number;
  perModelAccuracy: Record<string, number>;
}

export interface EvalConfig {
  models: string[];
  testCases: TestCase[];
  pricing?: Record<string, ModelPricing>;
  /** Latency budget (ms) for the latency_efficiency proxy. Default 4000. */
  latencyBudgetMs?: number;
  /** Only evaluate Pareto-frontier candidates (saves API calls). Default true. */
  frontierOnly?: boolean;
  /** Max concurrent model calls. Default 4. */
  concurrency?: number;
}

export interface EvalResult {
  /** Candidates with measured scores, re-ranked by measured composite desc. */
  ranked: CandidateEval[];
  /** Label of the best candidate by measured composite. */
  winner: string;
  totalCalls: number;
  totalCostUsd: number;
}

// --- Pure grading -----------------------------------------------------------

/** Substitute the test input into the candidate prompt. */
export function buildPrompt(candidateText: string, input: string): string {
  const placeholder = candidateText.match(/\{[a-z_]+\}/i);
  if (placeholder) {
    return candidateText.replace(placeholder[0], input);
  }
  return `${candidateText}\n\nInput:\n${input}`;
}

const REFUSAL_MARKERS = [
  "i can't",
  "i cannot",
  "i'm unable",
  "i am unable",
  "i won't",
  "i will not",
  "cannot help with that",
  "can't assist",
  "i'm not able to",
];

/** Extract the largest balanced {...} JSON object from text. */
function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Run a single check against an output. Returns [passed, failureMessage?]. */
export function runCheck(output: string, check: Check): [boolean, string?] {
  const lower = output.toLowerCase();
  switch (check.kind) {
    case "json_valid": {
      const block = extractJson(output);
      if (!block) return [false, "no JSON object found"];
      try {
        JSON.parse(block);
        return [true];
      } catch {
        return [false, "JSON did not parse"];
      }
    }
    case "has_field": {
      const block = extractJson(output);
      if (!block) return [false, `no JSON for field "${check.field}"`];
      try {
        const obj = JSON.parse(block);
        return check.field in obj ? [true] : [false, `missing field "${check.field}"`];
      } catch {
        return [false, "JSON did not parse"];
      }
    }
    case "contains":
      return lower.includes(check.text.toLowerCase()) ? [true] : [false, `missing "${check.text}"`];
    case "not_contains":
      return !lower.includes(check.text.toLowerCase()) ? [true] : [false, `must not contain "${check.text}"`];
    case "regex":
      try {
        return new RegExp(check.pattern, "i").test(output) ? [true] : [false, `regex /${check.pattern}/ failed`];
      } catch {
        return [false, "invalid regex"];
      }
    case "max_tokens": {
      const n = estTokens(output);
      return n <= check.n ? [true] : [false, `output ${n} tok > ${check.n}`];
    }
    case "refuses":
      return REFUSAL_MARKERS.some((m) => lower.includes(m)) ? [true] : [false, "did not refuse"];
  }
}

/** A check is "structural" if it asserts JSON shape (drives schema_validity). */
function isSchemaCheck(c: Check): boolean {
  return c.kind === "json_valid" || c.kind === "has_field";
}

export function gradeOutput(
  output: string,
  checks: Check[],
): { passed: number; total: number; failures: string[]; schemaPassed: number; schemaTotal: number } {
  const failures: string[] = [];
  let passed = 0;
  let schemaPassed = 0;
  let schemaTotal = 0;
  for (const c of checks) {
    const [ok, msg] = runCheck(output, c);
    const schema = isSchemaCheck(c);
    if (schema) schemaTotal++;
    if (ok) {
      passed++;
      if (schema) schemaPassed++;
    } else if (msg) failures.push(msg);
  }
  return { passed, total: checks.length, failures, schemaPassed, schemaTotal };
}

/** Stability across models: 1 = identical pass-rates, 0 = maximal disagreement. */
export function crossModelStability(perModelAccuracy: number[]): number {
  if (perModelAccuracy.length < 2) return 1;
  const m = perModelAccuracy.reduce((a, b) => a + b, 0) / perModelAccuracy.length;
  const variance =
    perModelAccuracy.reduce((a, b) => a + (b - m) * (b - m), 0) / perModelAccuracy.length;
  const sd = Math.sqrt(variance);
  return Math.max(0, Math.min(1, 1 - 2 * sd));
}

function compositeFromWeights(s: Score, w: Weights): number {
  return (
    s.accuracy * w.accuracy +
    s.schema_validity * w.schema_validity +
    s.token_efficiency * w.token_efficiency +
    s.latency_efficiency * w.latency_efficiency +
    s.safety_margin * w.safety_margin +
    s.cross_model_stability * w.cross_model_stability +
    s.explainability * w.explainability
  );
}

/**
 * Aggregate a candidate's cells into a measured `Score`. Static objectives
 * (token_efficiency, safety_margin, explainability) are preserved; accuracy,
 * schema_validity, cross_model_stability, latency, and cost are measured.
 */
export function aggregateCandidate(
  label: string,
  text: string,
  cells: CellResult[],
  staticScore: Score,
  weights: Weights,
  latencyBudgetMs = 4000,
): CandidateEval {
  const total = cells.length || 1;
  const passes = cells.filter((c) => c.pass).length;
  const accuracy = passes / total;

  // Schema validity = fraction of *structural* checks (json_valid/has_field)
  // that passed, across all cells. Falls back to the static estimate only when
  // the suite contained no structural checks at all. (Previously this divided
  // the all-checks pass count by the count of cells with any check, which made
  // it numerically identical to accuracy and ignored which checks were schema.)
  const schemaPassed = cells.reduce((a, c) => a + (c.schemaChecksPassed ?? 0), 0);
  const schemaTotal = cells.reduce((a, c) => a + (c.schemaChecksTotal ?? 0), 0);
  const schemaValidity = schemaTotal > 0 ? schemaPassed / schemaTotal : staticScore.schema_validity;

  const byModel: Record<string, { pass: number; total: number }> = {};
  for (const c of cells) {
    (byModel[c.model] ??= { pass: 0, total: 0 }).total++;
    if (c.pass) byModel[c.model].pass++;
  }
  const perModelAccuracy: Record<string, number> = {};
  for (const [m, v] of Object.entries(byModel)) perModelAccuracy[m] = v.pass / (v.total || 1);
  const stability = crossModelStability(Object.values(perModelAccuracy));

  const meanLatencyMs = cells.reduce((a, c) => a + c.latencyMs, 0) / total;
  const totalCostUsd = cells.reduce((a, c) => a + c.costUsd, 0);
  const latencyEfficiency = 1 / (1 + meanLatencyMs / latencyBudgetMs);

  const score: Score = {
    ...staticScore,
    accuracy,
    schema_validity: Math.min(1, Math.max(0, schemaValidity)),
    cross_model_stability: stability,
    latency_efficiency: latencyEfficiency,
    est_latency_ms: meanLatencyMs,
    est_cost_usd: totalCostUsd / total,
    composite: 0,
  };
  score.composite = compositeFromWeights(score, weights);

  return {
    label,
    text,
    cells,
    score,
    accuracy,
    schemaValidity: score.schema_validity,
    crossModelStability: stability,
    meanLatencyMs,
    totalCostUsd,
    perModelAccuracy,
  };
}

// --- Runner -----------------------------------------------------------------

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Run the live eval matrix over candidates × models × test cases, grade, and
 * re-rank by measured composite. `onProgress` reports completed cells.
 */
export async function runEval(
  candidates: Candidate[],
  config: EvalConfig,
  chat: ChatFn,
  weights: Weights,
  onProgress?: (done: number, total: number) => void,
): Promise<EvalResult> {
  const frontierOnly = config.frontierOnly ?? true;
  const targets = frontierOnly ? candidates.filter((c) => c.on_frontier) : candidates;
  const pricing = config.pricing ?? {};
  const concurrency = config.concurrency ?? 4;

  // Build the full cell work list.
  type Job = { cand: Candidate; model: string; tc: TestCase };
  const jobs: Job[] = [];
  for (const cand of targets) {
    for (const model of config.models) {
      for (const tc of config.testCases) {
        jobs.push({ cand, model, tc });
      }
    }
  }

  let done = 0;
  const results = await mapLimit(jobs, concurrency, async ({ cand, model, tc }) => {
    const prompt = buildPrompt(cand.text, tc.input);
    let cell: CellResult;
    try {
      const r = await chat(model, prompt);
      const price = pricing[model] ?? { prompt: 0, completion: 0 };
      const cost = (r.promptTokens / 1000) * price.prompt + (r.completionTokens / 1000) * price.completion;
      const g = gradeOutput(r.content, tc.checks);
      cell = {
        candidate: cand.label,
        model,
        testCaseId: tc.id,
        output: r.content,
        latencyMs: r.latencyMs,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        costUsd: cost,
        checksPassed: g.passed,
        checksTotal: g.total,
        schemaChecksPassed: g.schemaPassed,
        schemaChecksTotal: g.schemaTotal,
        pass: g.total > 0 && g.passed === g.total,
        failures: g.failures,
      };
    } catch (e) {
      cell = {
        candidate: cand.label,
        model,
        testCaseId: tc.id,
        output: "",
        latencyMs: 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        checksPassed: 0,
        checksTotal: tc.checks.length,
        schemaChecksPassed: 0,
        schemaChecksTotal: tc.checks.filter(isSchemaCheck).length,
        pass: false,
        failures: [`call failed: ${String(e)}`],
      };
    }
    onProgress?.(++done, jobs.length);
    return cell;
  });

  // Group cells per candidate and aggregate.
  const evals: CandidateEval[] = targets.map((cand) => {
    const cells = results.filter((c) => c.candidate === cand.label);
    return aggregateCandidate(cand.label, cand.text, cells, cand.score, weights, config.latencyBudgetMs);
  });

  evals.sort((a, b) => b.score.composite - a.score.composite);
  const totalCostUsd = results.reduce((a, c) => a + c.costUsd, 0);

  return {
    ranked: evals,
    winner: evals[0]?.label ?? "",
    totalCalls: results.length,
    totalCostUsd,
  };
}

// --- Production OpenRouter runner -------------------------------------------

/** Non-streaming OpenRouter chat runner with usage + latency capture. */
export function openRouterChat(apiKey: string): ChatFn {
  return async (modelId, prompt) => {
    const start =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": typeof window !== "undefined" ? window.location.origin : "",
        "X-Title": "Symbolic Scribe",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
    });
    const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - start;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `eval call failed: ${res.status}`);
    }
    const json = await res.json();
    const content: string = json.choices?.[0]?.message?.content ?? "";
    const usage = json.usage ?? {};
    return {
      content,
      promptTokens: usage.prompt_tokens ?? estTokens(prompt),
      completionTokens: usage.completion_tokens ?? estTokens(content),
      latencyMs: elapsed,
    };
  };
}
