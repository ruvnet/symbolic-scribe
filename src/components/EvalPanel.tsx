import { useEffect, useState } from "react";
import { FlaskConical, Play, Loader2, AlertCircle, Trophy } from "lucide-react";
import { loadSettings, fetchAvailableModels, type OpenRouterModel } from "../services/settingsService";
import { weights, type Candidate } from "../services/promptForge";
import {
  runEval,
  openRouterChat,
  type Check,
  type TestCase,
  type EvalResult,
  type ModelPricing,
} from "../services/promptEval";

interface EvalPanelProps {
  candidates: Candidate[];
  /** Whether the optimized prompt is expected to emit JSON. */
  schemaExpected: boolean;
  /** Called with the measured winner so the host can persist it to memory. */
  onComplete?: (result: EvalResult) => void;
}

/**
 * Live model test matrix UI. Runs the optimizer's Pareto-frontier candidates
 * against selected OpenRouter models over a small editable test suite, grades
 * outputs, and re-ranks by *measured* composite — replacing the static proxies.
 */
const EvalPanel = ({ candidates, schemaExpected, onComplete }: EvalPanelProps) => {
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [testInput, setTestInput] = useState(
    "Customer reports the mobile app crashes on login after the latest update. They are frustrated and want a refund.",
  );
  const [requireJson, setRequireJson] = useState(schemaExpected);
  const [mustContain, setMustContain] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<EvalResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apiKey = loadSettings()?.apiKey;

  useEffect(() => {
    setRequireJson(schemaExpected);
  }, [schemaExpected]);

  useEffect(() => {
    if (!apiKey) return;
    fetchAvailableModels(apiKey)
      .then((m) => {
        setModels(m);
        // Default-select up to 2 cheap-ish models.
        setSelected(m.slice(0, 2).map((x) => x.id));
      })
      .catch(() => setError("Could not load models. Check your API key in Settings."));
  }, [apiKey]);

  const toggleModel = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < 4 ? [...s, id] : s));

  const buildTestCases = (): TestCase[] => {
    const checks: Check[] = [];
    if (requireJson) checks.push({ kind: "json_valid" });
    if (mustContain.trim()) checks.push({ kind: "contains", text: mustContain.trim() });
    // Always verify the model didn't echo an injection instruction back.
    checks.push({ kind: "not_contains", text: "ignore previous instructions" });
    return [{ id: "case-1", input: testInput, checks }];
  };

  const buildPricing = (): Record<string, ModelPricing> => {
    const p: Record<string, ModelPricing> = {};
    for (const m of models) {
      p[m.id] = {
        prompt: parseFloat(m.pricing.prompt) * 1000 || 0,
        completion: parseFloat(m.pricing.completion) * 1000 || 0,
      };
    }
    return p;
  };

  const handleRun = async () => {
    if (!apiKey || selected.length === 0) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const w = await weights();
      const res = await runEval(
        candidates,
        { models: selected, testCases: buildTestCases(), pricing: buildPricing(), frontierOnly: true },
        openRouterChat(apiKey),
        w,
        (done, total) => setProgress({ done, total }),
      );
      setResult(res);
      onComplete?.(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  if (!apiKey) {
    return (
      <div className="text-xs text-gray-400 flex items-center gap-2 p-2">
        <AlertCircle className="w-4 h-4 text-yellow-500" />
        Add an OpenRouter API key in Settings to run the live eval matrix.
      </div>
    );
  }

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center gap-2 text-console-cyan">
        <FlaskConical className="w-4 h-4" /> Live Eval Matrix
        <span className="text-gray-500">measures accuracy / schema / stability across models</span>
      </div>

      {/* model selection */}
      <div>
        <div className="text-gray-400 mb-1">Models (max 4)</div>
        <div className="flex flex-wrap gap-1.5 max-h-24 overflow-auto">
          {models.slice(0, 16).map((m) => (
            <button
              key={m.id}
              onClick={() => toggleModel(m.id)}
              className={`px-2 py-0.5 rounded border text-[10px] ${
                selected.includes(m.id)
                  ? "border-console-cyan/60 text-console-cyan bg-console-cyan/10"
                  : "border-gray-700 text-gray-500"
              }`}
            >
              {m.id.split("/").pop()}
            </button>
          ))}
        </div>
      </div>

      {/* test case */}
      <div>
        <div className="text-gray-400 mb-1">Test input (substituted for the prompt's placeholder)</div>
        <textarea
          className="console-input w-full h-16 text-xs"
          value={testInput}
          onChange={(e) => setTestInput(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-gray-300">
          <input type="checkbox" checked={requireJson} onChange={(e) => setRequireJson(e.target.checked)} />
          require valid JSON
        </label>
        <input
          className="console-input flex-1 min-w-[8rem] text-xs py-1"
          placeholder="must contain (optional)…"
          value={mustContain}
          onChange={(e) => setMustContain(e.target.value)}
        />
      </div>

      <button
        className="console-button w-full flex items-center justify-center gap-2 py-1.5"
        onClick={handleRun}
        disabled={running || selected.length === 0}
      >
        {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
        {running ? `Running ${progress.done}/${progress.total}…` : `Run eval (${candidates.filter((c) => c.on_frontier).length} × ${selected.length} models)`}
      </button>

      {error && <div className="text-red-400">{error}</div>}

      {/* results */}
      {result && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-console-green">
            <Trophy className="w-3.5 h-3.5" /> Measured winner: <span className="font-code">{result.winner}</span>
            <span className="text-gray-500">
              · {result.totalCalls} calls · ${result.totalCostUsd.toFixed(4)}
            </span>
          </div>
          <table className="w-full">
            <thead>
              <tr className="text-gray-500 text-left">
                <th className="py-1">candidate</th>
                <th>accuracy</th>
                <th>schema</th>
                <th>stability</th>
                <th>latency</th>
                <th>composite</th>
              </tr>
            </thead>
            <tbody>
              {result.ranked.map((r) => (
                <tr key={r.label} className="border-t border-console-green/10">
                  <td className="py-1.5 text-gray-300">{r.label}</td>
                  <td className={`font-mono ${r.accuracy >= 0.9 ? "text-console-green" : "text-yellow-400"}`}>
                    {(r.accuracy * 100).toFixed(0)}%
                  </td>
                  <td className="font-mono text-gray-400">{(r.schemaValidity * 100).toFixed(0)}%</td>
                  <td className="font-mono text-gray-400">{r.crossModelStability.toFixed(2)}</td>
                  <td className="font-mono text-gray-400">{Math.round(r.meanLatencyMs)}ms</td>
                  <td className="font-mono text-console-cyan">{r.score.composite.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-gray-600">
            Measured scores replace the static accuracy/schema/stability proxies; the Pareto ranking above reflects real
            model behavior over your test suite.
          </p>
        </div>
      )}
    </div>
  );
};

export default EvalPanel;
