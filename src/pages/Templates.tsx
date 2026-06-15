import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import MainNav from "../components/MainNav";
import { BookTemplate, Trash2, Sword, Shield, Sigma, ArrowRight } from "lucide-react";
import { SavedPrompt, getSavedPrompts, deletePrompt } from "../services/storageService";
import { firewall, type Decision } from "../services/promptForge";

type Team = "red" | "blue" | "framework";

interface Template {
  filename: string;
  title: string;
  team: Team;
  tactic?: string;
  category?: string;
  overview?: string;
  body: string;
}

type GlobModule = { [key: string]: () => Promise<string> };

/** Parse `---`-delimited YAML-ish frontmatter and the markdown body. */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: m[2].trim() };
}

function titleFromFilename(filename: string): string {
  return filename
    .replace(/^(redteam|blueteam)-/, "")
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const DECISION_STYLE: Record<Decision["decision"], { label: string; cls: string }> = {
  allow: { label: "ALLOW", cls: "bg-green-900/40 text-green-300 border-green-500/40" },
  allow_with_logging: { label: "LOG", cls: "bg-cyan-900/40 text-cyan-300 border-cyan-500/40" },
  require_approval: { label: "APPROVE", cls: "bg-amber-900/40 text-amber-300 border-amber-500/40" },
  block: { label: "BLOCK", cls: "bg-red-900/40 text-red-300 border-red-500/40" },
};

export default function Templates() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [savedTemplates, setSavedTemplates] = useState<SavedPrompt[]>([]);
  const [verdicts, setVerdicts] = useState<Record<string, Decision>>({});

  useEffect(() => {
    const importTemplates = async () => {
      const modules = import.meta.glob<string>("../templates/*.md", {
        query: "?raw",
        import: "default",
      }) as GlobModule;

      const loaded: Template[] = [];
      for (const path in modules) {
        const raw = await modules[path]();
        const filename = path.split("/").pop()?.replace(".md", "") || "";
        const { meta, body } = parseFrontmatter(raw);
        const team: Team = meta.team === "red" ? "red" : meta.team === "blue" ? "blue" : "framework";
        loaded.push({
          filename,
          title: meta.title || titleFromFilename(filename),
          team,
          tactic: meta.tactic,
          category: meta.category,
          overview: meta.overview,
          body,
        });
      }
      loaded.sort((a, b) => a.title.localeCompare(b.title));
      setTemplates(loaded);
      setSavedTemplates(getSavedPrompts());

      // Run the prompt firewall over every red/blue template so the page shows,
      // live, whether the defense catches each attack (red) or passes each
      // hardening prompt clean (blue).
      const v: Record<string, Decision> = {};
      for (const t of loaded) {
        if (t.team === "framework") continue;
        try {
          v[t.filename] = await firewall(t.body);
        } catch {
          /* wasm not ready — skip the badge */
        }
      }
      setVerdicts(v);
    };
    importTemplates();
  }, []);

  useEffect(() => {
    const refresh = () => setSavedTemplates(getSavedPrompts());
    window.addEventListener("storage", refresh);
    window.addEventListener("storageChanged", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("storageChanged", refresh);
    };
  }, []);

  const openInCompiler = (body: string) => {
    try {
      sessionStorage.setItem("promptforge:compiler-prefill", body);
    } catch {
      /* ignore */
    }
    navigate("/optimize");
  };

  const red = templates.filter((t) => t.team === "red");
  const blue = templates.filter((t) => t.team === "blue");
  const frameworks = templates.filter((t) => t.team === "framework");

  /** Red wants attacks CAUGHT (not allowed); blue wants hardening to pass clean. */
  const verdictNote = (team: Team, d?: Decision): string => {
    if (!d) return "";
    const caught = d.decision !== "allow";
    if (team === "red") return caught ? "✓ caught by firewall" : "⚠ not flagged — defense gap";
    return caught ? "⚠ unexpectedly flagged" : "✓ passes clean";
  };

  const TemplateCard = ({ t, accent }: { t: Template; accent: string }) => {
    const d = verdicts[t.filename];
    const note = verdictNote(t.team, d);
    return (
      <Card className={`glass-panel ${accent} hover:shadow-lg transition-shadow bg-gray-900/50 flex flex-col`}>
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-console-cyan text-base">{t.title}</CardTitle>
            {d && (
              <span
                className={`text-[10px] font-code px-1.5 py-0.5 rounded border whitespace-nowrap ${DECISION_STYLE[d.decision].cls}`}
                title={`firewall risk ${d.risk.toFixed(2)}`}
              >
                {DECISION_STYLE[d.decision].label} · {d.risk.toFixed(2)}
              </span>
            )}
          </div>
          <CardDescription className="text-console-green">
            {t.tactic || t.category || "Template"}
            {note && (
              <span className={d && d.decision !== "allow" ? "text-amber-300" : "text-green-400"}> · {note}</span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col flex-1">
          {t.overview && <p className="text-xs text-gray-400 mb-2">{t.overview}</p>}
          <ScrollArea className="h-[160px] w-full rounded-md border border-console-cyan/20 p-3 bg-gray-900/50">
            <pre className="text-xs font-code text-console-text whitespace-pre-wrap">{t.body}</pre>
          </ScrollArea>
          <button
            onClick={() => openInCompiler(t.body)}
            className="console-button mt-3 py-1.5 px-3 text-sm flex items-center justify-center gap-1.5 hover:bg-console-cyan/10"
          >
            Open in Compiler <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </CardContent>
      </Card>
    );
  };

  const Section = ({
    icon,
    title,
    blurb,
    items,
    accent,
  }: {
    icon: ReactNode;
    title: string;
    blurb: string;
    items: Template[];
    accent: string;
  }) =>
    items.length === 0 ? null : (
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-1">
          {icon}
          <h2 className="text-xl font-code text-console-cyan">{title}</h2>
          <span className="text-xs text-gray-500">({items.length})</span>
        </div>
        <p className="text-sm text-gray-400 mb-4">{blurb}</p>
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
          {items.map((t) => (
            <TemplateCard key={t.filename} t={t} accent={accent} />
          ))}
        </div>
      </div>
    );

  return (
    <div className="min-h-screen flex flex-col">
      <MainNav title="Template Library" />

      <main className="flex-1 p-4">
        <section className="glass-panel p-6 animate-matrix-fade">
          <div className="flex items-center gap-2 mb-2">
            <BookTemplate className="w-6 h-6 text-console-cyan" />
            <h1 className="text-2xl font-code text-console-cyan">Template Library</h1>
          </div>
          <p className="text-sm text-gray-400 mb-6">
            Red-team attack probes and blue-team hardening patterns, each scored live by the
            prompt firewall, plus mathematical frameworks. Open any template in the compiler to
            analyze, optimize, and get a signed receipt.
          </p>

          <Section
            icon={<Sword className="w-5 h-5 text-red-400" />}
            title="Red Team"
            blurb="Adversarial probes for authorized testing of your firewall. A red-team prompt should be CAUGHT (not allowed) — an ALLOW badge marks a defense gap."
            items={red}
            accent="border-red-500/40"
          />

          <Section
            icon={<Shield className="w-5 h-5 text-blue-400" />}
            title="Blue Team"
            blurb="Defensive system-prompt scaffolds — guardrails, refusals, schema locks, tool allowlists. These should pass the firewall clean (ALLOW)."
            items={blue}
            accent="border-blue-500/40"
          />

          <Section
            icon={<Sigma className="w-5 h-5 text-console-cyan" />}
            title="Mathematical Frameworks"
            blurb="Structured reasoning templates built on set theory, category theory, logic, and more."
            items={frameworks}
            accent="border-console-cyan"
          />

          {savedTemplates.length > 0 && (
            <div>
              <h2 className="text-xl font-code text-console-cyan mb-4">Saved Templates</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
                {savedTemplates.map((template) => (
                  <Card key={template.id} className="glass-panel border-console-cyan hover:shadow-lg transition-shadow bg-gray-900/50">
                    <CardHeader>
                      <div className="flex justify-between items-start">
                        <div>
                          <CardTitle className="text-console-cyan">{template.title}</CardTitle>
                          <CardDescription className="text-console-green">
                            Saved Template - {new Date(template.timestamp).toLocaleDateString()}
                          </CardDescription>
                        </div>
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            if (window.confirm("Are you sure you want to delete this template?")) {
                              deletePrompt(template.id);
                            }
                          }}
                          className="console-button p-2 hover:bg-red-900/20"
                          title="Delete template"
                        >
                          <Trash2 className="w-4 h-4 text-red-400" />
                        </button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <ScrollArea className="h-[200px] w-full rounded-md border border-console-cyan/20 p-4 bg-gray-900/50">
                        <pre className="text-sm font-code text-console-text whitespace-pre-wrap">
                          {template.prompt.overview}
                          {"\n\n"}
                          {template.prompt.content}
                        </pre>
                      </ScrollArea>
                      <button
                        onClick={() => openInCompiler(`${template.prompt.overview}\n\n${template.prompt.content}`)}
                        className="console-button mt-3 py-1.5 px-3 text-sm flex items-center justify-center gap-1.5 hover:bg-console-cyan/10"
                      >
                        Open in Compiler <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
