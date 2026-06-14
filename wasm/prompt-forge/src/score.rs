//! Multi-objective scoring & Pareto ranking (`eval.receipt.json`, `cost.latency.json`).
//!
//! Without live model calls we cannot *measure* accuracy, so static scores are
//! explicit, transparent **proxies** computed from structure: constraint
//! coverage, schema validity, ambiguity, token cost, and portability signals.
//! The live model test matrix (run in JS via OpenRouter) overwrites the
//! `accuracy` / `cross_model_stability` fields when real results exist; the
//! composite and Pareto logic stay identical, so offline and online share code.

use crate::ambiguity;
use crate::model::{Candidate, Constraint, Intent, Issue, SchemaInfo, Score};
use crate::safety;
use crate::schema;
use crate::token::count_tokens;

/// Default model price (USD per 1K prompt tokens) and per-token latency used for
/// the cost/latency estimates. Mid-tier defaults; the UI can override.
pub const DEFAULT_USD_PER_1K: f64 = 0.0030;
pub const DEFAULT_MS_PER_TOKEN: f64 = 4.0; // time-to-first-token dominated proxy
pub const DEFAULT_BUDGET: usize = 800;

pub struct ScoreInputs<'a> {
    pub text: &'a str,
    pub intent: &'a Intent,
    pub constraints: &'a [Constraint],
    pub schema: &'a SchemaInfo,
    pub ambiguities: &'a [Issue],
    pub safety: &'a [Issue],
    pub token_budget: usize,
    pub usd_per_1k: f64,
    pub ms_per_token: f64,
}

pub fn score(inp: &ScoreInputs) -> Score {
    let tokens = count_tokens(inp.text);
    let words = inp.text.split_whitespace().count();

    let schema_validity = schema::validity(inp.schema);
    let safety_margin = safety::safety_margin(inp.safety);
    let clarity = ambiguity::clarity(inp.ambiguities, words);

    // token_efficiency: smooth decay vs budget — at budget you score ~0.5.
    let ratio = tokens as f64 / inp.token_budget.max(1) as f64;
    let token_efficiency = (1.0 / (1.0 + ratio)).clamp(0.0, 1.0);

    // latency_efficiency: dominated by length, penalized further by ambiguity
    // (ambiguous prompts cause retries/longer completions).
    let latency_efficiency = (token_efficiency * 0.7 + clarity * 0.3).clamp(0.0, 1.0);

    // accuracy proxy: rewards a clear contract — constraint coverage, schema,
    // low ambiguity, an explicit task. Replaced by measured pass-rate when live.
    let has_constraints = !inp.constraints.is_empty();
    let coverage = constraint_coverage(inp.constraints);
    let accuracy = (0.35 * clarity
        + 0.25 * schema_validity
        + 0.20 * coverage
        + 0.10 * inp.intent.confidence
        + 0.10 * if has_constraints { 1.0 } else { 0.0 })
    .clamp(0.0, 1.0);

    // cross_model_stability: portability proxy — penalize rare/long tokens,
    // reward explicit structure & schema that survive a model swap.
    let cross_model_stability = portability(inp.text, schema_validity, clarity);

    // explainability: how legible/auditable is the prompt structure?
    let explainability = (0.5 * clarity + 0.5 * coverage).clamp(0.0, 1.0);

    let est_cost_usd = tokens as f64 / 1000.0 * inp.usd_per_1k;
    let est_latency_ms = tokens as f64 * inp.ms_per_token;

    let mut s = Score {
        accuracy,
        schema_validity,
        token_efficiency,
        latency_efficiency,
        safety_margin,
        cross_model_stability,
        explainability,
        composite: 0.0,
        est_tokens: tokens,
        est_cost_usd,
        est_latency_ms,
    };
    s.composite = s.composite();
    s
}

fn constraint_coverage(c: &[Constraint]) -> f64 {
    if c.is_empty() {
        return 0.0;
    }
    // Reward breadth across categories (format/factuality/safety/length/...).
    let mut cats = std::collections::HashSet::new();
    for x in c {
        cats.insert(x.category.as_str());
    }
    let breadth = (cats.len() as f64 / 4.0).min(1.0);
    let depth = (c.len() as f64 / 5.0).min(1.0);
    0.6 * breadth + 0.4 * depth
}

fn portability(text: &str, schema_validity: f64, clarity: f64) -> f64 {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return schema_validity * 0.5 + 0.25;
    }
    // Long words / heavy jargon tokenize differently across models → less stable.
    let long = words.iter().filter(|w| w.len() > 12).count() as f64;
    let long_penalty = (long / words.len() as f64).min(0.3);
    (0.5 * clarity + 0.4 * schema_validity + 0.1 - long_penalty).clamp(0.0, 1.0)
}

/// Mark the Pareto-optimal set: a candidate is on the frontier if no other
/// candidate is >= on every objective and strictly > on at least one.
pub fn mark_pareto_frontier(cands: &mut [Candidate]) {
    let vecs: Vec<[f64; 7]> = cands.iter().map(|c| objective_vec(&c.score)).collect();
    for i in 0..cands.len() {
        let mut dominated = false;
        for j in 0..cands.len() {
            if i == j {
                continue;
            }
            if dominates(&vecs[j], &vecs[i]) {
                dominated = true;
                break;
            }
        }
        cands[i].on_frontier = !dominated;
    }
}

fn objective_vec(s: &Score) -> [f64; 7] {
    [
        s.accuracy,
        s.schema_validity,
        s.token_efficiency,
        s.latency_efficiency,
        s.safety_margin,
        s.cross_model_stability,
        s.explainability,
    ]
}

fn dominates(a: &[f64; 7], b: &[f64; 7]) -> bool {
    let mut strictly_better = false;
    for k in 0..7 {
        if a[k] < b[k] - 1e-9 {
            return false;
        }
        if a[k] > b[k] + 1e-9 {
            strictly_better = true;
        }
    }
    strictly_better
}

/// The spec's hard acceptance rule: an optimized prompt is only "improved" if it
/// beats the baseline composite **without lowering accuracy, safety, or schema
/// validity**.
pub fn accepted(baseline: &Score, candidate: &Score) -> bool {
    candidate.composite > baseline.composite + 1e-6
        && candidate.accuracy >= baseline.accuracy - 1e-9
        && candidate.safety_margin >= baseline.safety_margin - 1e-9
        && candidate.schema_validity >= baseline.schema_validity - 1e-9
}

/// Count how many of the seven objectives improved (for reporting).
pub fn improved_count(baseline: &Score, candidate: &Score) -> usize {
    objective_vec(candidate)
        .iter()
        .zip(objective_vec(baseline).iter())
        .filter(|(c, b)| **c > **b + 1e-9)
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ambiguity, ast, constraints, intent, safety, schema};

    fn score_of(p: &str) -> Score {
        let sections = ast::parse(p);
        let intent = intent::parse(p);
        let cons = constraints::extract(p);
        let schema = schema::analyze(p);
        let amb = ambiguity::check(p, &cons);
        let safe = safety::lint(p, &sections);
        score(&ScoreInputs {
            text: p,
            intent: &intent,
            constraints: &cons,
            schema: &schema,
            ambiguities: &amb,
            safety: &safe,
            token_budget: DEFAULT_BUDGET,
            usd_per_1k: DEFAULT_USD_PER_1K,
            ms_per_token: DEFAULT_MS_PER_TOKEN,
        })
    }

    #[test]
    fn composite_in_range() {
        let s = score_of("Summarize the report. Must cite sources. Return JSON {\"x\": 1}.");
        assert!(s.composite >= 0.0 && s.composite <= 1.0);
    }

    #[test]
    fn structured_beats_vague() {
        let good = score_of("Summarize the article in 3 bullets. Must cite sources. Do not invent data. Return JSON {\"bullets\": [\"a\"]}.");
        let bad = score_of("make it good and appropriate and nice somehow");
        assert!(good.composite > bad.composite, "{} !> {}", good.composite, bad.composite);
    }

    #[test]
    fn shorter_is_more_token_efficient() {
        let short = score_of("Summarize this.");
        let long = score_of(&"Summarize this. ".repeat(200));
        assert!(short.token_efficiency > long.token_efficiency);
    }

    #[test]
    fn acceptance_requires_no_regression() {
        let base = Score { composite: 0.5, accuracy: 0.8, safety_margin: 1.0, schema_validity: 1.0, ..Default::default() };
        let better = Score { composite: 0.6, accuracy: 0.85, safety_margin: 1.0, schema_validity: 1.0, ..Default::default() };
        let cheaper_but_worse = Score { composite: 0.6, accuracy: 0.7, safety_margin: 1.0, schema_validity: 1.0, ..Default::default() };
        assert!(accepted(&base, &better));
        assert!(!accepted(&base, &cheaper_but_worse));
    }

    #[test]
    fn pareto_marks_nondominated() {
        let mk = |acc: f64, tok: f64| Candidate {
            label: String::new(),
            text: String::new(),
            score: Score { accuracy: acc, token_efficiency: tok, ..Default::default() },
            on_frontier: false,
        };
        // c0 dominated by c1 (worse on both); c1 and c2 trade off.
        let mut cands = vec![mk(0.5, 0.5), mk(0.9, 0.6), mk(0.6, 0.95)];
        mark_pareto_frontier(&mut cands);
        assert!(!cands[0].on_frontier);
        assert!(cands[1].on_frontier);
        assert!(cands[2].on_frontier);
    }
}
