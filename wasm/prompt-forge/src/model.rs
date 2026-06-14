//! Shared, serializable data model for the prompt compiler.
//!
//! Every struct here is part of the public artifact surface (`prompt.ast.json`,
//! `eval.receipt.json`, `witness.json`, ...) so field names are stable and
//! snake_cased for cross-language consumers.

use serde::{Deserialize, Serialize};

/// A structurally distinct region of a prompt.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Section {
    /// Role | Task | Inputs | Constraints | Output | Examples | Policy | Data |
    /// Tools | Context | Unknown
    pub kind: String,
    pub title: String,
    pub content: String,
    pub tokens: usize,
    pub start_line: usize,
    pub end_line: usize,
}

/// Parsed intent of the prompt.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Intent {
    /// generate | summarize | extract | classify | rewrite | translate |
    /// reason | code | converse
    pub task_type: String,
    /// json | markdown | code | list | number | prose | unknown
    pub output_type: String,
    pub audience: String,
    pub confidence: f64,
}

/// A single extracted instruction / requirement.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Constraint {
    /// must | must_not | should | format
    pub polarity: String,
    pub text: String,
    /// format | factuality | safety | length | style | tooling | general
    pub category: String,
    pub line: usize,
}

/// A lint finding (ambiguity, safety, schema, structure).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Issue {
    /// info | warn | error
    pub severity: String,
    pub code: String,
    pub message: String,
    pub snippet: String,
    pub line: usize,
}

/// Output-schema detection result.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct SchemaInfo {
    pub present: bool,
    pub valid: bool,
    /// json | none
    pub kind: String,
    pub errors: Vec<String>,
}

/// Multi-objective score. All component fields are normalized to `0.0..=1.0`
/// where higher is always better; `composite` is the weighted sum.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Score {
    pub accuracy: f64,
    pub schema_validity: f64,
    pub token_efficiency: f64,
    pub latency_efficiency: f64,
    pub safety_margin: f64,
    pub cross_model_stability: f64,
    pub explainability: f64,
    pub composite: f64,
    // Raw, human-meaningful estimates backing the normalized scores.
    pub est_tokens: usize,
    pub est_cost_usd: f64,
    pub est_latency_ms: f64,
}

impl Score {
    /// Weights from the PromptOps scoring rubric. They sum to 1.0.
    pub const W_ACCURACY: f64 = 0.25;
    pub const W_SCHEMA: f64 = 0.20;
    pub const W_TOKEN: f64 = 0.15;
    pub const W_LATENCY: f64 = 0.15;
    pub const W_SAFETY: f64 = 0.10;
    pub const W_STABILITY: f64 = 0.10;
    pub const W_EXPLAIN: f64 = 0.05;

    pub fn composite(&self) -> f64 {
        self.accuracy * Self::W_ACCURACY
            + self.schema_validity * Self::W_SCHEMA
            + self.token_efficiency * Self::W_TOKEN
            + self.latency_efficiency * Self::W_LATENCY
            + self.safety_margin * Self::W_SAFETY
            + self.cross_model_stability * Self::W_STABILITY
            + self.explainability * Self::W_EXPLAIN
    }
}

/// Model-routing recommendation (`model.route.json`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RouteHint {
    /// nano | small | mid | frontier — capability tier, not a vendor lock-in.
    pub tier: String,
    /// 0..=1 estimate of task difficulty driving the tier choice.
    pub complexity: f64,
    /// Whether the task benefits from extended/test-time reasoning.
    pub needs_reasoning: bool,
    pub rationale: String,
    /// Concrete example model ids per tier (vendor-neutral suggestions).
    pub examples: Vec<String>,
}

/// A candidate prompt variant in the optimization search.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Candidate {
    pub label: String,
    pub text: String,
    pub score: Score,
    /// Indices of candidates this one dominates (Pareto bookkeeping).
    pub on_frontier: bool,
}

/// Full static analysis of one prompt (`prompt.ast.json`).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Analysis {
    pub tokens: usize,
    pub chars: usize,
    pub words: usize,
    pub intent: Intent,
    pub sections: Vec<Section>,
    pub constraints: Vec<Constraint>,
    pub ambiguities: Vec<Issue>,
    pub safety: Vec<Issue>,
    pub schema: SchemaInfo,
    pub score: Score,
    pub route: RouteHint,
}
