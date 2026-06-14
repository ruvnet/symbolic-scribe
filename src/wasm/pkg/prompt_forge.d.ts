/* tslint:disable */
/* eslint-disable */
/**
 * Drift report between two prompts → `DriftReport` JSON. Confirms that a
 * transformed prompt preserves numbers, entities, and constraints.
 */
export function drift_report(original: string, transformed: string): string;
/**
 * Fast token estimate for `text`.
 */
export function count_tokens(text: string): number;
/**
 * Crate version string.
 */
export function version(): string;
/**
 * Prompt firewall: classify a prompt/context for injection, secret-exposure,
 * and tool-abuse risk and return an allow/log/approve/block decision
 * (`decision.receipt.json`). Defensive, static, deterministic.
 */
export function firewall(raw: string, ctx_json: string): string;
/**
 * Verify a witness receipt (JSON) against a key. Returns `"true"`/`"false"`.
 */
export function verify_receipt(receipt_json: string, witness_key: string): string;
/**
 * Full optimization pass → `OptimizeResult` JSON (compiled form, candidates,
 * Pareto frontier, diff, and a signed receipt).
 */
export function optimize(raw: string, opts_json: string): string;
/**
 * Redact detected secrets/canaries from text before it reaches a model.
 * Returns `{ "text": <scrubbed>, "redactions": <n> }`.
 */
export function scrub_secrets(raw: string): string;
/**
 * Re-rank a host-supplied set of scored candidates by Pareto dominance.
 * Input: JSON array of `Candidate`. Output: same array with `on_frontier` set,
 * sorted by composite score descending.
 */
export function rank_pareto(candidates_json: string): string;
/**
 * Full static analysis → `Analysis` JSON (`prompt.ast.json`).
 */
export function analyze(raw: string, opts_json: string): string;
/**
 * Compress only → returns the SynthLang-style `.synth` text + pass log.
 */
export function compress(raw: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly analyze: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly compress: (a: number, b: number, c: number) => void;
  readonly count_tokens: (a: number, b: number) => number;
  readonly drift_report: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly firewall: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly optimize: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly rank_pareto: (a: number, b: number, c: number) => void;
  readonly scrub_secrets: (a: number, b: number, c: number) => void;
  readonly verify_receipt: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly version: (a: number) => void;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_export_0: (a: number, b: number) => number;
  readonly __wbindgen_export_1: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_export_2: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
