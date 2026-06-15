#!/usr/bin/env node
/**
 * bench-fusion — live OpenRouter benchmark that closes the optimizer loop.
 *
 * Drives the *real* Rust→WASM prompt compiler (src/wasm/pkg) from Node to
 * generate Pareto candidates, then measures each candidate against a live model
 * (default: `openrouter/fusion`, a multi-model deliberation meta-model) over a
 * small JSON-task corpus. Outputs measured accuracy / schema-validity / latency
 * / cost and re-ranks by the canonical composite — the same methodology the
 * browser EvalPanel uses, run headless in CI.
 *
 * Auth: reads OPENROUTER_API_KEY from the environment. The wrapper script
 * `scripts/bench-fusion.sh` sources it from GCP Secret Manager so the key never
 * lands in a file or the shell history.
 *
 *   OPENROUTER_API_KEY=sk-or-... node scripts/bench-fusion.mjs
 *   node scripts/bench-fusion.mjs --model openrouter/fusion --max-tokens 400
 *
 * The matrix is intentionally tiny (2 candidates × 1 model × 3 cases) because
 * fusion fans out to a panel of models per call — keep the cost bounded.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// --- args -------------------------------------------------------------------
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const MODEL = arg("model", "openrouter/fusion");
const MAX_TOKENS = parseInt(arg("max-tokens", "500"), 10);
const CONCURRENCY = parseInt(arg("concurrency", "2"), 10);
const OUT = arg("out", resolve(ROOT, "bench/fusion-proof.json"));

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) {
  console.error("OPENROUTER_API_KEY not set. Use scripts/bench-fusion.sh to source it from GCP Secret Manager.");
  process.exit(2);
}

// --- load the real WASM compiler in Node (no fetch; compile bytes directly) --
async function loadForge() {
  const pkg = await import(pathToFileURL(resolve(ROOT, "src/wasm/pkg/prompt_forge.js")).href);
  const bytes = await readFile(resolve(ROOT, "src/wasm/pkg/prompt_forge_bg.wasm"));
  const module = new WebAssembly.Module(bytes);
  await pkg.default({ module_or_path: module });
  return pkg;
}

// --- canonical scoring (mirrors src/services/promptEval.ts grading) ----------
function estTokens(t) {
  return Math.max(t ? 1 : 0, Math.round(t.trim().length / 4));
}
function extractJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}
const isSchemaCheck = (c) => c.kind === "json_valid" || c.kind === "has_field";
function runCheck(output, check) {
  const lower = output.toLowerCase();
  switch (check.kind) {
    case "json_valid": { const b = extractJson(output); if (!b) return false; try { JSON.parse(b); return true; } catch { return false; } }
    case "has_field": { const b = extractJson(output); if (!b) return false; try { return check.field in JSON.parse(b); } catch { return false; } }
    case "contains": return lower.includes(check.text.toLowerCase());
    case "not_contains": return !lower.includes(check.text.toLowerCase());
    case "max_tokens": return estTokens(output) <= check.n;
    default: return false;
  }
}
function grade(output, checks) {
  let passed = 0, schemaPassed = 0, schemaTotal = 0;
  for (const c of checks) {
    const ok = runCheck(output, c);
    const s = isSchemaCheck(c);
    if (s) schemaTotal++;
    if (ok) { passed++; if (s) schemaPassed++; }
  }
  return { passed, total: checks.length, schemaPassed, schemaTotal };
}

// --- the corpus: JSON-extraction tasks with structural checks ----------------
const CORPUS = [
  {
    id: "incident",
    input: "On 2026-03-02 an attacker used a phishing email to steal 3 admin credentials, then exfiltrated 12GB over DNS.",
    checks: [
      { kind: "json_valid" },
      { kind: "has_field", field: "summary" },
      { kind: "has_field", field: "severity" },
      { kind: "not_contains", text: "as an ai" },
    ],
  },
  {
    id: "invoice",
    input: "Invoice #4471 from Acme Corp, dated 2026-01-15, total $1,250.00, due in 30 days.",
    checks: [
      { kind: "json_valid" },
      { kind: "has_field", field: "total" },
      { kind: "contains", text: "4471" },
    ],
  },
  {
    id: "ticket",
    input: "Customer reports the export button is greyed out on Safari but works on Chrome. P2.",
    checks: [
      { kind: "json_valid" },
      { kind: "has_field", field: "priority" },
      { kind: "not_contains", text: "i cannot" },
    ],
  },
];

const BASELINE =
  "You are a senior analyst. Please carefully read the following input and " +
  "extract the key structured information. Make sure to be concise and do not " +
  "invent any data that is not present. Always return a single valid JSON object " +
  "with the relevant fields. Input:\n{input}";

function buildPrompt(text, input) {
  const m = text.match(/\{[a-z_]+\}/i);
  return m ? text.replace(m[0], input) : `${text}\n\nInput:\n${input}`;
}

// --- live OpenRouter call ----------------------------------------------------
async function chat(model, prompt) {
  const start = performance.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "X-Title": "Symbolic Scribe Bench",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: MAX_TOKENS,
      stream: false,
    }),
  });
  const latencyMs = performance.now() - start;
  if (!res.ok) {
    const e = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${e.slice(0, 200)}`);
  }
  const j = await res.json();
  const content = j.choices?.[0]?.message?.content ?? "";
  const usage = j.usage ?? {};
  const cost = usage.cost ?? 0; // OpenRouter returns actual USD cost for fusion
  return {
    content,
    promptTokens: usage.prompt_tokens ?? estTokens(prompt),
    completionTokens: usage.completion_tokens ?? estTokens(content),
    costUsd: cost,
    latencyMs,
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
    }),
  );
  return out;
}

// --- main -------------------------------------------------------------------
async function main() {
  console.log(`bench-fusion · model=${MODEL} · max_tokens=${MAX_TOKENS}\n`);
  const forge = await loadForge();
  console.log(`prompt-forge v${forge.version()} loaded (native WASM)`);

  const W = JSON.parse(forge.weights());
  const composite = (s) =>
    s.accuracy * W.accuracy +
    s.schema_validity * W.schema_validity +
    s.token_efficiency * W.token_efficiency +
    s.latency_efficiency * W.latency_efficiency +
    s.safety_margin * W.safety_margin +
    s.cross_model_stability * W.cross_model_stability +
    s.explainability * W.explainability;

  // Run the REAL optimizer on the baseline to get its best candidate.
  const opt = JSON.parse(forge.optimize(BASELINE, JSON.stringify({ token_budget: 400, witness_key: "bench", issued_at: "2026-06-14T00:00:00Z" })));
  console.log(`optimizer: ${(opt.token_reduction * 100).toFixed(0)}% token reduction, ${opt.objectives_improved}/7 objectives up, accepted=${opt.accepted}`);

  const candidates = [
    { label: "baseline", text: BASELINE, score: opt.original.score },
    { label: "optimized", text: opt.optimized.text, score: opt.optimized.score },
  ];

  // Build the cell matrix: candidates × corpus, all against the one model.
  const jobs = [];
  for (const cand of candidates) for (const tc of CORPUS) jobs.push({ cand, tc });

  let done = 0;
  const cells = await mapLimit(jobs, CONCURRENCY, async ({ cand, tc }) => {
    const prompt = buildPrompt(cand.text, tc.input);
    try {
      const r = await chat(MODEL, prompt);
      const g = grade(r.content, tc.checks);
      const cell = {
        candidate: cand.label, testCaseId: tc.id, pass: g.passed === g.total,
        schemaPassed: g.schemaPassed, schemaTotal: g.schemaTotal,
        latencyMs: r.latencyMs, costUsd: r.costUsd,
        promptTokens: r.promptTokens, completionTokens: r.completionTokens,
      };
      console.log(`  [${++done}/${jobs.length}] ${cand.label}/${tc.id}: ${cell.pass ? "PASS" : "fail"} ${r.latencyMs.toFixed(0)}ms $${r.costUsd.toFixed(4)}`);
      return cell;
    } catch (e) {
      console.log(`  [${++done}/${jobs.length}] ${cand.label}/${tc.id}: ERROR ${e.message}`);
      return { candidate: cand.label, testCaseId: tc.id, pass: false, schemaPassed: 0, schemaTotal: tc.checks.filter(isSchemaCheck).length, latencyMs: 0, costUsd: 0, promptTokens: 0, completionTokens: 0, error: e.message };
    }
  });

  // Aggregate per candidate (mirrors aggregateCandidate).
  const ranked = candidates.map((cand) => {
    const cs = cells.filter((c) => c.candidate === cand.label);
    const accuracy = cs.filter((c) => c.pass).length / (cs.length || 1);
    const sp = cs.reduce((a, c) => a + c.schemaPassed, 0);
    const st = cs.reduce((a, c) => a + c.schemaTotal, 0);
    const schema_validity = st > 0 ? sp / st : cand.score.schema_validity;
    const meanLatencyMs = cs.reduce((a, c) => a + c.latencyMs, 0) / (cs.length || 1);
    const totalCostUsd = cs.reduce((a, c) => a + c.costUsd, 0);
    const score = {
      ...cand.score,
      accuracy,
      schema_validity,
      cross_model_stability: 1, // single model
      latency_efficiency: 1 / (1 + meanLatencyMs / 4000),
      est_latency_ms: meanLatencyMs,
    };
    score.composite = composite(score);
    return { label: cand.label, accuracy, schema_validity, meanLatencyMs, totalCostUsd, composite: score.composite };
  }).sort((a, b) => b.composite - a.composite);

  const proof = {
    model: MODEL,
    weights: W,
    optimizer: { token_reduction: opt.token_reduction, objectives_improved: opt.objectives_improved, accepted: opt.accepted, bundle_hash: opt.receipt.bundle_hash },
    matrix: { candidates: candidates.length, cases: CORPUS.length, calls: cells.length },
    totalCostUsd: cells.reduce((a, c) => a + c.costUsd, 0),
    winner: ranked[0]?.label,
    ranked,
    cells,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(proof, null, 2));

  console.log("\n=== measured ranking (by composite) ===");
  for (const r of ranked) {
    console.log(`  ${r.label.padEnd(10)} composite=${r.composite.toFixed(3)} acc=${r.accuracy.toFixed(2)} schema=${r.schema_validity.toFixed(2)} lat=${r.meanLatencyMs.toFixed(0)}ms $${r.totalCostUsd.toFixed(4)}`);
  }
  console.log(`\nwinner: ${proof.winner} · total cost $${proof.totalCostUsd.toFixed(4)} · proof → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
