import {
  buildPrompt,
  runCheck,
  gradeOutput,
  crossModelStability,
  aggregateCandidate,
  runEval,
  type ChatFn,
  type CellResult,
  type TestCase,
} from "../promptEval";
import type { Candidate, Score, Weights } from "../promptForge";

// Canonical weights (mirror of the WASM `weights()` source of truth).
const W: Weights = {
  accuracy: 0.25,
  schema_validity: 0.2,
  token_efficiency: 0.15,
  latency_efficiency: 0.15,
  safety_margin: 0.1,
  cross_model_stability: 0.1,
  explainability: 0.05,
};

const baseScore = (over: Partial<Score> = {}): Score => ({
  accuracy: 0.5,
  schema_validity: 0.5,
  token_efficiency: 0.8,
  latency_efficiency: 0.7,
  safety_margin: 1,
  cross_model_stability: 0.7,
  explainability: 0.6,
  composite: 0,
  est_tokens: 50,
  est_cost_usd: 0,
  est_latency_ms: 0,
  ...over,
});

describe("promptEval — grading", () => {
  it("buildPrompt substitutes the first placeholder or appends", () => {
    expect(buildPrompt("Summarize {ticket} now.", "HELLO")).toBe("Summarize HELLO now.");
    expect(buildPrompt("Summarize the text.", "HELLO")).toContain("Input:\nHELLO");
  });

  it("runCheck handles each check kind", () => {
    expect(runCheck('{"a":1}', { kind: "json_valid" })[0]).toBe(true);
    expect(runCheck("no json here", { kind: "json_valid" })[0]).toBe(false);
    expect(runCheck('{"summary":"x"}', { kind: "has_field", field: "summary" })[0]).toBe(true);
    expect(runCheck('{"summary":"x"}', { kind: "has_field", field: "missing" })[0]).toBe(false);
    expect(runCheck("contains apple", { kind: "contains", text: "apple" })[0]).toBe(true);
    expect(runCheck("clean", { kind: "not_contains", text: "secret" })[0]).toBe(true);
    expect(runCheck("ssn 123", { kind: "not_contains", text: "ssn" })[0]).toBe(false);
    expect(runCheck("I cannot help with that.", { kind: "refuses" })[0]).toBe(true);
    expect(runCheck("Sure, here you go.", { kind: "refuses" })[0]).toBe(false);
  });

  it("gradeOutput counts passing checks", () => {
    const g = gradeOutput('{"summary":"ok"}', [
      { kind: "json_valid" },
      { kind: "has_field", field: "summary" },
      { kind: "contains", text: "nope" },
    ]);
    expect(g.passed).toBe(2);
    expect(g.total).toBe(3);
    expect(g.failures.length).toBe(1);
  });
});

describe("promptEval — aggregation", () => {
  it("crossModelStability: agreement → 1, disagreement → lower", () => {
    expect(crossModelStability([0.9, 0.9, 0.9])).toBeCloseTo(1, 5);
    expect(crossModelStability([1, 0])).toBeLessThan(0.1);
    expect(crossModelStability([0.8])).toBe(1); // single model
  });

  it("aggregateCandidate measures accuracy and recomputes composite", () => {
    const cells: CellResult[] = [
      cell("m1", "t1", true),
      cell("m1", "t2", true),
      cell("m2", "t1", true),
      cell("m2", "t2", false),
    ];
    const ev = aggregateCandidate("c", "text", cells, baseScore(), W, 4000);
    expect(ev.accuracy).toBe(0.75); // 3/4 passed
    expect(ev.perModelAccuracy.m1).toBe(1);
    expect(ev.perModelAccuracy.m2).toBe(0.5);
    // composite reflects measured accuracy (0.75), not the static 0.5
    expect(ev.score.accuracy).toBe(0.75);
    expect(ev.score.composite).toBeGreaterThan(0);
    expect(ev.score.composite).toBeLessThanOrEqual(1);
  });
});

describe("promptEval — runEval re-ranks by measured behavior", () => {
  it("a candidate that yields valid JSON beats one that doesn't", async () => {
    const candidates: Candidate[] = [
      { label: "loose", text: "Summarize {x}.", score: baseScore({ composite: 0.6 }), on_frontier: true },
      {
        label: "schema",
        text: 'Summarize {x}. Return JSON {"summary": ""}.',
        score: baseScore({ composite: 0.55 }),
        on_frontier: true,
      },
    ];

    // Mock model: returns valid JSON only when the prompt asks for JSON.
    const chat: ChatFn = async (_model, prompt) => ({
      content: prompt.includes("JSON") ? '{"summary":"a concise summary"}' : "Here is a summary in prose.",
      promptTokens: 40,
      completionTokens: 20,
      latencyMs: 500,
      // satisfy the type
    }) as any;

    const tests: TestCase[] = [
      { id: "t1", input: "ticket A", checks: [{ kind: "json_valid" }, { kind: "has_field", field: "summary" }] },
      { id: "t2", input: "ticket B", checks: [{ kind: "json_valid" }, { kind: "has_field", field: "summary" }] },
    ];

    const result = await runEval(
      candidates,
      { models: ["m1", "m2"], testCases: tests, latencyBudgetMs: 4000 },
      chat,
      W,
    );

    // 2 candidates × 2 models × 2 tests = 8 calls.
    expect(result.totalCalls).toBe(8);
    // The schema-bearing candidate must win on measured composite.
    expect(result.winner).toBe("schema");
    const schema = result.ranked.find((r) => r.label === "schema")!;
    const loose = result.ranked.find((r) => r.label === "loose")!;
    expect(schema.accuracy).toBe(1);
    expect(loose.accuracy).toBe(0);
    expect(schema.score.composite).toBeGreaterThan(loose.score.composite);
  });

  it("frontierOnly skips dominated candidates", async () => {
    const candidates: Candidate[] = [
      { label: "a", text: "do {x}", score: baseScore(), on_frontier: true },
      { label: "b", text: "do {x}", score: baseScore(), on_frontier: false },
    ];
    const chat: ChatFn = async () => ({ content: "ok", promptTokens: 1, completionTokens: 1, latencyMs: 1 });
    const r = await runEval(candidates, { models: ["m1"], testCases: [{ id: "t", input: "i", checks: [{ kind: "contains", text: "ok" }] }] }, chat, W);
    expect(r.ranked.length).toBe(1);
    expect(r.ranked[0].label).toBe("a");
  });
});

function cell(model: string, testCaseId: string, pass: boolean): CellResult {
  return {
    candidate: "c",
    model,
    testCaseId,
    output: pass ? '{"summary":"x"}' : "bad",
    latencyMs: 500,
    promptTokens: 40,
    completionTokens: 20,
    costUsd: 0.001,
    checksPassed: pass ? 1 : 0,
    checksTotal: 1,
    pass,
    failures: pass ? [] : ["fail"],
  };
}
