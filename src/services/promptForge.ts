/**
 * promptForge — typed, lazy-loaded bridge to the Rust→WASM prompt compiler.
 *
 * The heavy lifting (tokenizing, parsing, compression, scoring, Pareto ranking,
 * risk classification, signed receipts) runs in WebAssembly for deterministic,
 * sub-millisecond latency entirely client-side. This module:
 *   - initializes the wasm module exactly once (idempotent), and
 *   - wraps the string-in/JSON-out wasm ABI in strongly-typed functions.
 *
 * Live model testing (OpenRouter) and optional semantic embeddings
 * (transformers.js) live elsewhere; this is the offline deterministic core.
 */

import init, {
  analyze as wasmAnalyze,
  optimize as wasmOptimize,
  compress as wasmCompress,
  count_tokens as wasmCountTokens,
  firewall as wasmFirewall,
  scrub_secrets as wasmScrub,
  drift_report as wasmDrift,
  rank_pareto as wasmRankPareto,
  verify_receipt as wasmVerifyReceipt,
  version as wasmVersion,
} from "../wasm/pkg/prompt_forge.js";

// ---------------------------------------------------------------------------
// Types — mirror the Rust serde model (snake_case preserved across the ABI).
// ---------------------------------------------------------------------------

export interface Section {
  kind: string;
  title: string;
  content: string;
  tokens: number;
  start_line: number;
  end_line: number;
}

export interface Intent {
  task_type: string;
  output_type: string;
  audience: string;
  confidence: number;
}

export interface Constraint {
  polarity: string;
  text: string;
  category: string;
  line: number;
}

export interface Issue {
  severity: "info" | "warn" | "error";
  code: string;
  message: string;
  snippet: string;
  line: number;
}

export interface SchemaInfo {
  present: boolean;
  valid: boolean;
  kind: string;
  errors: string[];
}

export interface Score {
  accuracy: number;
  schema_validity: number;
  token_efficiency: number;
  latency_efficiency: number;
  safety_margin: number;
  cross_model_stability: number;
  explainability: number;
  composite: number;
  est_tokens: number;
  est_cost_usd: number;
  est_latency_ms: number;
}

export interface RouteHint {
  tier: string;
  complexity: number;
  needs_reasoning: boolean;
  rationale: string;
  examples: string[];
}

export interface Analysis {
  tokens: number;
  chars: number;
  words: number;
  intent: Intent;
  sections: Section[];
  constraints: Constraint[];
  ambiguities: Issue[];
  safety: Issue[];
  schema: SchemaInfo;
  score: Score;
  route: RouteHint;
}

export interface Candidate {
  label: string;
  text: string;
  score: Score;
  on_frontier: boolean;
}

export interface DiffOp {
  op: "eq" | "del" | "ins";
  text: string;
}

export interface DriftReport {
  lexical_similarity: number;
  number_retention: number;
  entity_retention: number;
  constraint_retention: number;
  drift: number;
  lost_numbers: string[];
  lost_entities: string[];
  within_tolerance: boolean;
}

export interface Receipt {
  version: string;
  source_hash: string;
  artifact_hash: string;
  bundle_hash: string;
  witness: string;
  baseline_score: Score;
  optimized_score: Score;
  token_reduction: number;
  objectives_improved: number;
  accepted: boolean;
  issued_at: string;
}

export interface PassView {
  name: string;
  before_tokens: number;
  after_tokens: number;
  note: string;
}

export interface OptimizeResult {
  original: { label: string; text: string; score: Score };
  optimized: { label: string; text: string; score: Score };
  compiled: string;
  compressed: string;
  token_reduction: number;
  passes: PassView[];
  candidates: Candidate[];
  diff: DiffOp[];
  diff_markdown: string;
  drift: DriftReport;
  objectives_improved: number;
  accepted: boolean;
  receipt: Receipt;
}

export interface CompressResult {
  text: string;
  before_tokens: number;
  after_tokens: number;
  reduction: number;
  passes: PassView[];
}

export interface RiskComponents {
  data_sensitivity: number;
  tool_power: number;
  instruction_conflict: number;
  external_destination: number;
  model_uncertainty: number;
  prior_failure_similarity: number;
}

export interface Finding {
  code: string;
  severity: string;
  message: string;
  snippet: string;
}

export interface Decision {
  risk: number;
  components: RiskComponents;
  decision: "allow" | "allow_with_logging" | "require_approval" | "block";
  create_incident: boolean;
  findings: Finding[];
  rationale: string;
}

export interface OptimizeOptions {
  token_budget?: number;
  usd_per_1k?: number;
  ms_per_token?: number;
  witness_key?: string;
  issued_at?: string;
}

export interface RiskContextInput {
  data_sensitivity?: number;
  tool_power?: number;
  external_destination?: number;
  model_uncertainty?: number;
  prior_failure_similarity?: number;
}

// ---------------------------------------------------------------------------
// One-time initialization. Concurrent callers share a single init promise.
// ---------------------------------------------------------------------------

let ready: Promise<void> | null = null;

export function initForge(): Promise<void> {
  if (!ready) {
    // Vite rewrites this URL to the hashed asset path at build time, and serves
    // the wasm directly in dev — no extra plugin required.
    const wasmUrl = new URL("../wasm/pkg/prompt_forge_bg.wasm", import.meta.url);
    ready = init({ module_or_path: wasmUrl }).then(() => undefined);
  }
  return ready;
}

/** Returns true once the wasm module has finished initializing. */
let initialized = false;
initForge()
  .then(() => {
    initialized = true;
  })
  .catch(() => {
    /* surfaced by callers via initForge() */
  });

function ensureSync(): void {
  if (!initialized) {
    throw new Error("prompt-forge wasm not initialized yet — await initForge()");
  }
}

// ---------------------------------------------------------------------------
// Typed wrappers.
// ---------------------------------------------------------------------------

/** Fast token estimate. Safe to call on every keystroke. Requires init. */
export function countTokens(text: string): number {
  ensureSync();
  return wasmCountTokens(text);
}

export function version(): string {
  ensureSync();
  return wasmVersion();
}

export async function analyze(raw: string, opts: OptimizeOptions = {}): Promise<Analysis> {
  await initForge();
  return JSON.parse(wasmAnalyze(raw, JSON.stringify(opts))) as Analysis;
}

export async function optimize(raw: string, opts: OptimizeOptions = {}): Promise<OptimizeResult> {
  await initForge();
  const merged: OptimizeOptions = { issued_at: new Date().toISOString(), ...opts };
  return JSON.parse(wasmOptimize(raw, JSON.stringify(merged))) as OptimizeResult;
}

export async function compress(raw: string): Promise<CompressResult> {
  await initForge();
  return JSON.parse(wasmCompress(raw)) as CompressResult;
}

export async function firewall(raw: string, ctx: RiskContextInput = {}): Promise<Decision> {
  await initForge();
  return JSON.parse(wasmFirewall(raw, JSON.stringify(ctx))) as Decision;
}

export async function scrubSecrets(raw: string): Promise<{ text: string; redactions: number }> {
  await initForge();
  return JSON.parse(wasmScrub(raw)) as { text: string; redactions: number };
}

export async function driftReport(original: string, transformed: string): Promise<DriftReport> {
  await initForge();
  return JSON.parse(wasmDrift(original, transformed)) as DriftReport;
}

export async function rankPareto(candidates: Candidate[]): Promise<Candidate[]> {
  await initForge();
  return JSON.parse(wasmRankPareto(JSON.stringify(candidates))) as Candidate[];
}

export async function verifyReceipt(receipt: Receipt, witnessKey: string): Promise<boolean> {
  await initForge();
  return wasmVerifyReceipt(JSON.stringify(receipt), witnessKey) === "true";
}

/** Convenience: download any artifact object as a pretty-printed JSON file. */
export function downloadArtifact(name: string, data: unknown): void {
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const blob = new Blob([body], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
