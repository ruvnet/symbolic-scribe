import { useState, useEffect, useCallback, useRef } from "react";
import {
  Cpu,
  Zap,
  ShieldAlert,
  GitCompare,
  Activity,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Download,
  Gauge,
  Lock,
  Sparkles,
} from "lucide-react";
import MainNav from "../components/MainNav";
import EvalPanel from "../components/EvalPanel";
import { useToast } from "../components/ui/use-toast";
import {
  initForge,
  countTokens,
  analyze,
  optimize,
  firewall,
  downloadArtifact,
  version,
  type Analysis,
  type OptimizeResult,
  type Decision,
  type Score,
  type RouteHint,
} from "../services/promptForge";
import { recall, record, clearMemory, type PriorStats } from "../services/promptMemory";
import {
  initMemoryBackend,
  enableRuVector,
  disableRuVector,
  ruvectorActive,
} from "../services/ruvectorBackend";
import { refineRoute, reinforce } from "../services/ruvectorRouter";

const SAMPLE_PROMPT = `Hey so I basically need you to kind of help me out here. I would like you to please please take a look at the customer support ticket below and just simply summarize what the main issue is. Please make sure to be really concise. Also please make sure to be concise. It is important that you do not make up any details that are not actually in the ticket. In order to be helpful, try to identify the sentiment too. Make it good.

The ticket is delimited by triple backticks: \`\`\`{ticket}\`\`\``;

const SCORE_FIELDS: { key: keyof Score; label: string; weight: string }[] = [
  { key: "accuracy", label: "Accuracy", weight: "0.25" },
  { key: "schema_validity", label: "Schema validity", weight: "0.20" },
  { key: "token_efficiency", label: "Token efficiency", weight: "0.15" },
  { key: "latency_efficiency", label: "Latency efficiency", weight: "0.15" },
  { key: "safety_margin", label: "Safety margin", weight: "0.10" },
  { key: "cross_model_stability", label: "Cross-model stability", weight: "0.10" },
  { key: "explainability", label: "Explainability", weight: "0.05" },
];

const barColor = (v: number) =>
  v >= 0.75 ? "bg-console-green" : v >= 0.5 ? "bg-console-cyan" : v >= 0.3 ? "bg-yellow-500" : "bg-red-500";

const ScoreBars = ({ score, compare }: { score: Score; compare?: Score }) => (
  <div className="space-y-2">
    {SCORE_FIELDS.map(({ key, label, weight }) => {
      const v = score[key] as number;
      const prev = compare ? (compare[key] as number) : undefined;
      const delta = prev !== undefined ? v - prev : 0;
      return (
        <div key={key} className="text-xs">
          <div className="flex justify-between mb-1">
            <span className="text-gray-300">
              {label} <span className="text-gray-600">·{weight}</span>
            </span>
            <span className="font-mono text-gray-400">
              {v.toFixed(2)}
              {prev !== undefined && Math.abs(delta) > 0.005 && (
                <span className={delta > 0 ? "text-console-green ml-1" : "text-red-400 ml-1"}>
                  {delta > 0 ? "▲" : "▼"}
                  {Math.abs(delta).toFixed(2)}
                </span>
              )}
            </span>
          </div>
          <div className="h-1.5 bg-console-dark/80 rounded overflow-hidden">
            <div className={`h-full ${barColor(v)} transition-all`} style={{ width: `${v * 100}%` }} />
          </div>
        </div>
      );
    })}
  </div>
);

const IssueList = ({ title, issues }: { title: string; issues: { severity: string; code: string; message: string }[] }) => {
  if (!issues.length) return null;
  const icon = (s: string) =>
    s === "error" ? <XCircle className="w-3.5 h-3.5 text-red-400" /> : s === "warn" ? <AlertTriangle className="w-3.5 h-3.5 text-yellow-400" /> : <Activity className="w-3.5 h-3.5 text-console-cyan" />;
  return (
    <div>
      <h4 className="text-console-cyan text-sm mb-2">{title}</h4>
      <ul className="space-y-1.5">
        {issues.map((i, idx) => (
          <li key={idx} className="flex items-start gap-2 text-xs text-gray-300">
            {icon(i.severity)}
            <span>
              <span className="text-gray-500 font-mono">[{i.code}]</span> {i.message}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

const Stat = ({ label, value, accent }: { label: string; value: string; accent?: string }) => (
  <div className="glass-panel p-3 text-center">
    <div className={`text-lg font-code ${accent ?? "text-console-green"}`}>{value}</div>
    <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
  </div>
);

const decisionStyle: Record<string, { color: string; icon: JSX.Element; label: string }> = {
  allow: { color: "text-console-green", icon: <CheckCircle2 className="w-4 h-4" />, label: "ALLOW" },
  allow_with_logging: { color: "text-console-cyan", icon: <Activity className="w-4 h-4" />, label: "ALLOW + LOG" },
  require_approval: { color: "text-yellow-400", icon: <AlertTriangle className="w-4 h-4" />, label: "REQUIRE APPROVAL" },
  block: { color: "text-red-400", icon: <XCircle className="w-4 h-4" />, label: "BLOCK" },
};

const Optimizer = () => {
  const [raw, setRaw] = useState(SAMPLE_PROMPT);
  const [liveTokens, setLiveTokens] = useState(0);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [priors, setPriors] = useState<PriorStats | null>(null);
  const [routeHint, setRouteHint] = useState<RouteHint | null>(null);
  const [ruvectorOn, setRuvectorOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [forgeVersion, setForgeVersion] = useState("");
  const [tab, setTab] = useState<"compiled" | "diff" | "candidates" | "drift" | "receipt" | "eval">("compiled");
  const { toast } = useToast();
  const debounceRef = useRef<number>();

  // Initialize wasm once, and honor any persisted RuVector preference.
  useEffect(() => {
    initForge()
      .then(() => setForgeVersion(version()))
      .catch(() =>
        toast({ title: "WASM load failed", description: "Run `npm run build:wasm` first.", duration: 5000 }),
      );
    initMemoryBackend().then(() => setRuvectorOn(ruvectorActive()));
  }, [toast]);

  const toggleRuvector = async () => {
    if (ruvectorOn) {
      disableRuVector();
      setRuvectorOn(false);
      toast({ title: "RuVector disabled", description: "Reverted to the local memory backend.", duration: 3000 });
    } else {
      const ok = await enableRuVector();
      setRuvectorOn(ok);
      toast({
        title: ok ? "RuVector enabled" : "RuVector unavailable",
        description: ok
          ? "Memory recall + routing now use ruvector-wasm (HNSW/flat)."
          : "Package not installed or failed to init — staying on local backend.",
        duration: 4000,
      });
    }
  };

  // Live analysis (debounced) — runs on every edit, in <1ms via wasm.
  const runLive = useCallback(async (text: string) => {
    if (!text.trim()) {
      setAnalysis(null);
      setLiveTokens(0);
      return;
    }
    try {
      setLiveTokens(countTokens(text));
      // Memory recall feeds the learning signal into the firewall: a prompt that
      // resembles past failures/attacks scores higher risk over time.
      const prior = recall(text);
      setPriors(prior);
      const [a, d] = await Promise.all([
        analyze(text),
        firewall(text, { prior_failure_similarity: prior.priorFailureSimilarity }),
      ]);
      setAnalysis(a);
      setDecision(d);
      // Refine the static route hint with the RuVector router (no-op if off).
      setRouteHint(ruvectorActive() ? await refineRoute(text, a.route) : a.route);
    } catch {
      /* wasm not ready yet */
    }
  }, []);

  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => runLive(raw), 120);
    return () => window.clearTimeout(debounceRef.current);
  }, [raw, runLive]);

  const handleOptimize = async () => {
    if (!raw.trim()) return;
    setBusy(true);
    try {
      const r = await optimize(raw, { witness_key: "symbolic-scribe-demo", token_budget: 600 });
      setResult(r);
      setTab("compiled");
      // Learn from this outcome: record it so future similar prompts recall it.
      // Compute the firewall decision *synchronously for this exact prompt* — the
      // debounced `decision` state can be stale or empty, which would record every
      // outcome as allow/[] and silently flatten the firewall's feedback loop.
      const prior = recall(raw);
      const fw = await firewall(raw, { prior_failure_similarity: prior.priorFailureSimilarity });
      setDecision(fw);
      record({
        prompt: raw,
        composite: r.optimized.score.composite,
        accepted: r.accepted,
        decision: fw.decision,
        findings: fw.findings.map((f) => f.code),
        tokenReduction: r.token_reduction,
        bundleHash: r.receipt.bundle_hash,
      });
      setPriors(recall(raw));
      // Reinforce the chosen route so the router learns this prompt→tier mapping.
      if (r.accepted && routeHint) {
        void reinforce(raw, routeHint.tier, routeHint.examples);
      }
      toast({
        title: r.accepted ? "Prompt improved ✓" : "No improvement accepted",
        description: r.accepted
          ? `${(r.token_reduction * 100).toFixed(0)}% fewer tokens · ${r.objectives_improved}/7 objectives up · winner: ${r.optimized.label}`
          : "Original already on the Pareto frontier; no variant beat it without regressing accuracy/safety/schema.",
        duration: 5000,
      });
    } catch (e) {
      toast({ title: "Optimization failed", description: String(e), duration: 4000 });
    } finally {
      setBusy(false);
    }
  };

  const applyOptimized = () => {
    if (result) {
      setRaw(result.optimized.text);
      setResult(null);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <MainNav title="PromptOps Compiler" />

      <div className="px-4 -mt-2 mb-2 flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-gray-500 flex items-center gap-2">
          <Cpu className="w-3.5 h-3.5 text-console-purple" />
          Rust→WASM prompt compiler {forgeVersion && <span className="text-console-purple">v{forgeVersion}</span>} ·
          deterministic · sub-millisecond · runs entirely in your browser
        </p>
        <button
          className={`console-button py-1 px-2 text-xs ${ruvectorOn ? "text-console-purple border-console-purple/40" : ""}`}
          onClick={toggleRuvector}
          title="Swap prompt-memory + routing onto ruvector-wasm (HNSW/ReasoningBank). Default off keeps the deterministic local path."
        >
          RuVector: {ruvectorOn ? "on" : "off"}
        </button>
      </div>

      <main className="flex-1 flex flex-col lg:flex-row gap-4 p-4 pt-0">
        {/* LEFT: editor + live analysis */}
        <section className="lg:w-1/2 space-y-4">
          <div className="glass-panel p-4">
            <div className="flex items-center justify-between mb-2">
              <label className="text-console-cyan flex items-center gap-2">
                <Sparkles className="w-4 h-4" /> Raw Prompt
              </label>
              <div className="flex items-center gap-3 text-xs">
                <span className="font-mono text-gray-400">{liveTokens} tok</span>
                <button className="console-button py-1 px-2" onClick={() => setRaw(SAMPLE_PROMPT)}>
                  Sample
                </button>
                <button className="console-button py-1 px-2" onClick={() => setRaw("")}>
                  Clear
                </button>
              </div>
            </div>
            <textarea
              className="console-input w-full h-64 font-mono text-sm"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="Paste a messy prompt and compile it into a scored, structured, signed artifact…"
            />
            <div className="flex gap-3 mt-3">
              <button className="console-button flex-1 flex items-center justify-center gap-2" onClick={handleOptimize} disabled={busy || !raw.trim()}>
                <Zap className="w-4 h-4" /> {busy ? "Compiling…" : "Compile & Optimize"}
              </button>
            </div>
          </div>

          {/* Live analysis */}
          {analysis && (
            <div className="glass-panel p-4 space-y-4 animate-matrix-fade">
              <div className="grid grid-cols-4 gap-2">
                <Stat label="Composite" value={analysis.score.composite.toFixed(2)} accent="text-console-cyan" />
                <Stat label="Tokens" value={String(analysis.tokens)} />
                <Stat label="Est. cost" value={`$${analysis.score.est_cost_usd.toFixed(4)}`} />
                <Stat label="Est. latency" value={`${Math.round(analysis.score.est_latency_ms)}ms`} />
              </div>

              <div className="flex flex-wrap gap-2 text-xs">
                <span className="console-button py-1 px-2">{analysis.intent.task_type}</span>
                <span className="console-button py-1 px-2">→ {analysis.intent.output_type}</span>
                <span className="console-button py-1 px-2">audience: {analysis.intent.audience}</span>
                <span className="console-button py-1 px-2 flex items-center gap-1" title={(routeHint ?? analysis.route).rationale}>
                  <Gauge className="w-3 h-3" /> route: {(routeHint ?? analysis.route).tier}
                  {ruvectorOn && <span className="text-console-purple">·rv</span>}
                </span>
              </div>

              <ScoreBars score={analysis.score} />

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <h4 className="text-console-cyan text-sm mb-2">Structure</h4>
                  <div className="flex flex-wrap gap-1.5">
                    {analysis.sections.map((s, i) => (
                      <span key={i} className="text-[10px] px-2 py-0.5 rounded bg-console-purple/10 text-console-purple border border-console-purple/20">
                        {s.kind} · {s.tokens}t
                      </span>
                    ))}
                  </div>
                  <div className="mt-2 text-xs text-gray-400">
                    schema: {analysis.schema.present ? (analysis.schema.valid ? "✓ valid" : "✗ malformed") : "—"}
                    {" · "}constraints: {analysis.constraints.length}
                  </div>
                </div>
                <div className="space-y-3">
                  <IssueList title="Ambiguity" issues={analysis.ambiguities} />
                  <IssueList title="Safety" issues={analysis.safety} />
                </div>
              </div>
            </div>
          )}

          {/* Firewall */}
          {decision && (
            <div className="glass-panel p-4 space-y-3 animate-matrix-fade">
              <div className="flex items-center justify-between">
                <h3 className="text-console-cyan flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4" /> Prompt Firewall
                </h3>
                <span className={`flex items-center gap-1.5 font-code text-sm ${decisionStyle[decision.decision]?.color}`}>
                  {decisionStyle[decision.decision]?.icon}
                  {decisionStyle[decision.decision]?.label} · risk {decision.risk.toFixed(2)}
                </span>
              </div>
              {decision.findings.length > 0 ? (
                <ul className="space-y-1 text-xs">
                  {decision.findings.map((f, i) => (
                    <li key={i} className="flex items-start gap-2 text-gray-300">
                      <span className="font-mono text-red-400">{f.code}</span>
                      <span>{f.message}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-gray-500">No threat findings. {decision.rationale}</p>
              )}
              {decision.create_incident && (
                <div className="text-xs text-red-400 border border-red-500/30 rounded p-2 bg-red-500/5">
                  ⚠ Incident created — risk above block threshold. Quarantine before model execution.
                </div>
              )}
            </div>
          )}

          {/* Learning memory (RuVector-ready) */}
          {priors && (
            <div className="glass-panel p-4 space-y-3 animate-matrix-fade">
              <div className="flex items-center justify-between">
                <h3 className="text-console-cyan flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-console-purple" /> Prompt Memory
                  <span className="text-[10px] text-gray-500">{priors.size} recorded</span>
                </h3>
                {priors.size > 0 && (
                  <button
                    className="console-button py-0.5 px-2 text-xs"
                    onClick={() => {
                      clearMemory();
                      setPriors(recall(raw));
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-gray-400">prior_failure_similarity</span>
                  <span className={`font-mono ${priors.priorFailureSimilarity > 0.6 ? "text-red-400" : "text-gray-400"}`}>
                    {priors.priorFailureSimilarity.toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">prior_win_similarity</span>
                  <span className="font-mono text-console-green">{priors.priorWinSimilarity.toFixed(2)}</span>
                </div>
              </div>
              {priors.nearest.length > 0 ? (
                <ul className="space-y-1 text-xs">
                  {priors.nearest.slice(0, 3).map((r, i) => (
                    <li key={i} className="flex items-center gap-2 text-gray-400">
                      <span className="font-mono text-console-purple w-10">{r.similarity.toFixed(2)}</span>
                      <span className={`font-mono w-12 ${r.entry.decision === "allow" ? "text-console-green" : "text-red-400"}`}>
                        {r.entry.accepted ? "win" : r.entry.decision === "allow" ? "—" : "risk"}
                      </span>
                      <span className="truncate flex-1">{r.entry.preview}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-gray-600">
                  No prior cases yet. Compile prompts to build memory — similar future prompts will recall these
                  outcomes and adjust risk. Swap the backend to RuVector for HNSW recall + ReasoningBank learning at scale.
                </p>
              )}
            </div>
          )}
        </section>

        {/* RIGHT: optimization result */}
        <section className="lg:w-1/2">
          {!result ? (
            <div className="glass-panel p-8 h-full flex flex-col items-center justify-center text-center text-gray-500">
              <Cpu className="w-10 h-10 text-console-purple/40 mb-3" />
              <p className="max-w-sm text-sm">
                Compile a prompt to see the optimized symbolic form, the Pareto candidate frontier, a meaning-preservation
                drift report, and a tamper-evident witness checksum.
              </p>
            </div>
          ) : (
            <div className="glass-panel p-4 space-y-4 animate-matrix-fade">
              {/* verdict */}
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h3 className="text-console-cyan flex items-center gap-2">
                  <Activity className="w-4 h-4" /> Optimization Result
                </h3>
                {result.accepted ? (
                  <span className="flex items-center gap-1.5 text-console-green text-sm font-code">
                    <CheckCircle2 className="w-4 h-4" /> ACCEPTED · {result.optimized.label}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-yellow-400 text-sm font-code">
                    <AlertTriangle className="w-4 h-4" /> ORIGINAL KEPT
                  </span>
                )}
              </div>

              <div className="grid grid-cols-4 gap-2">
                <Stat
                  label="Token Δ"
                  value={`${result.token_reduction >= 0 ? "−" : "+"}${Math.abs(result.token_reduction * 100).toFixed(0)}%`}
                  accent={result.token_reduction > 0 ? "text-console-green" : "text-gray-400"}
                />
                <Stat label="Objectives ↑" value={`${result.objectives_improved}/7`} />
                <Stat label="Composite" value={result.optimized.score.composite.toFixed(2)} accent="text-console-cyan" />
                <Stat
                  label="Drift"
                  value={result.drift.drift.toFixed(2)}
                  accent={result.drift.within_tolerance ? "text-console-green" : "text-yellow-400"}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-gray-500 mb-1">Baseline</div>
                  <ScoreBars score={result.original.score} />
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">Optimized (Δ vs baseline)</div>
                  <ScoreBars score={result.optimized.score} compare={result.original.score} />
                </div>
              </div>

              {/* tabs */}
              <div className="flex gap-1 border-b border-console-green/10 text-xs">
                {(["compiled", "diff", "candidates", "drift", "receipt", "eval"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`px-3 py-1.5 capitalize ${tab === t ? "text-console-cyan border-b-2 border-console-cyan" : "text-gray-500 hover:text-gray-300"}`}
                  >
                    {t}
                  </button>
                ))}
              </div>

              {tab === "compiled" && (
                <pre className="text-xs font-mono text-console-green bg-console-dark/60 rounded p-3 overflow-auto max-h-80 whitespace-pre-wrap">
                  {result.optimized.text}
                </pre>
              )}

              {tab === "diff" && (
                <pre className="text-xs font-mono bg-console-dark/60 rounded p-3 overflow-auto max-h-80">
                  {result.diff.map((d, i) => (
                    <div
                      key={i}
                      className={d.op === "ins" ? "text-console-green" : d.op === "del" ? "text-red-400" : "text-gray-500"}
                    >
                      {d.op === "ins" ? "+ " : d.op === "del" ? "- " : "  "}
                      {d.text}
                    </div>
                  ))}
                </pre>
              )}

              {tab === "candidates" && (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 text-left">
                      <th className="py-1">Variant</th>
                      <th>Tokens</th>
                      <th>Composite</th>
                      <th>Pareto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.candidates.map((c, i) => (
                      <tr key={i} className="border-t border-console-green/10">
                        <td className="py-1.5 text-gray-300">{c.label}</td>
                        <td className="font-mono text-gray-400">{c.score.est_tokens}</td>
                        <td className="font-mono text-console-cyan">{c.score.composite.toFixed(3)}</td>
                        <td>{c.on_frontier ? <span className="text-console-green">frontier ★</span> : <span className="text-gray-600">dominated</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {tab === "drift" && (
                <div className="text-xs space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      ["Number retention", result.drift.number_retention],
                      ["Constraint retention", result.drift.constraint_retention],
                      ["Entity retention", result.drift.entity_retention],
                      ["Lexical similarity", result.drift.lexical_similarity],
                    ].map(([label, v]) => (
                      <div key={label as string} className="flex justify-between">
                        <span className="text-gray-400">{label}</span>
                        <span className="font-mono text-console-green">{(v as number).toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                  <div className={result.drift.within_tolerance ? "text-console-green" : "text-yellow-400"}>
                    {result.drift.within_tolerance
                      ? "✓ Meaning preserved — all facts & constraints within tolerance."
                      : "⚠ Review: some constraint/number content changed."}
                  </div>
                  {result.drift.lost_numbers.length > 0 && (
                    <div className="text-red-400">Lost numbers: {result.drift.lost_numbers.join(", ")}</div>
                  )}
                </div>
              )}

              {tab === "receipt" && (
                <div className="text-xs font-mono space-y-1.5 text-gray-300">
                  <div className="flex items-center gap-2 text-console-green">
                    <Lock className="w-3.5 h-3.5" /> HMAC-SHA-256 witness · integrity checksum
                  </div>
                  {[
                    ["source", result.receipt.source_hash],
                    ["artifact", result.receipt.artifact_hash],
                    ["bundle", result.receipt.bundle_hash],
                    ["witness", result.receipt.witness],
                  ].map(([k, v]) => (
                    <div key={k as string} className="flex gap-2">
                      <span className="text-gray-500 w-16">{k}</span>
                      <span className="text-console-cyan truncate">{v as string}</span>
                    </div>
                  ))}
                  <div className="text-gray-500">issued {result.receipt.issued_at}</div>
                </div>
              )}

              {tab === "eval" && (
                <EvalPanel
                  candidates={result.candidates}
                  schemaExpected={Boolean(analysis?.schema.present || analysis?.intent.output_type === "json")}
                  onComplete={(ev) => {
                    const w = ev.ranked.find((r) => r.label === ev.winner);
                    if (w) {
                      record({
                        prompt: w.text,
                        composite: w.score.composite,
                        accepted: w.accuracy >= 0.9,
                        decision: decision?.decision ?? "allow",
                        findings: decision?.findings.map((f) => f.code) ?? [],
                        tokenReduction: result.token_reduction,
                        bundleHash: result.receipt.bundle_hash,
                      });
                      setPriors(recall(raw));
                      toast({
                        title: "Eval complete",
                        description: `Measured winner: ${ev.winner} · ${(w.accuracy * 100).toFixed(0)}% accuracy · recorded to memory.`,
                        duration: 5000,
                      });
                    }
                  }}
                />
              )}

              {/* actions */}
              <div className="flex flex-wrap gap-2 pt-2 border-t border-console-green/10">
                <button className="console-button py-1.5 px-3 text-xs flex items-center gap-1.5" onClick={applyOptimized} disabled={!result.accepted}>
                  <GitCompare className="w-3.5 h-3.5" /> Apply optimized
                </button>
                <button
                  className="console-button py-1.5 px-3 text-xs flex items-center gap-1.5"
                  onClick={() => downloadArtifact("prompt.ast.json", analysis)}
                >
                  <Download className="w-3.5 h-3.5" /> prompt.ast.json
                </button>
                <button
                  className="console-button py-1.5 px-3 text-xs flex items-center gap-1.5"
                  onClick={() => downloadArtifact("eval.receipt.json", result.receipt)}
                >
                  <Download className="w-3.5 h-3.5" /> eval.receipt.json
                </button>
                <button
                  className="console-button py-1.5 px-3 text-xs flex items-center gap-1.5"
                  onClick={() => downloadArtifact("prompt.diff.md", result.diff_markdown)}
                >
                  <Download className="w-3.5 h-3.5" /> prompt.diff.md
                </button>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
};

export default Optimizer;
