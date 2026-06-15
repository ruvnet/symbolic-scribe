//! Model routing hints (`model.route.json`).
//!
//! Pick the cheapest capability tier likely to satisfy the task, and flag when
//! extended/test-time reasoning is worth the spend. This is the seam where a
//! real router (ruvLLM) plugs in; here we provide a fast, vendor-neutral
//! heuristic so the UI can recommend a tier offline.

use crate::model::{Constraint, Intent, RouteHint};

pub fn route(intent: &Intent, constraints: &[Constraint], tokens: usize, ambiguity_issues: usize) -> RouteHint {
    let mut complexity = 0.0f64;

    // Reasoning-heavy task types push complexity up.
    complexity += match intent.task_type.as_str() {
        "reason" | "code" => 0.45,
        "extract" | "classify" => 0.15,
        "summarize" | "rewrite" | "translate" => 0.20,
        _ => 0.30,
    };

    // Long context & many constraints increase difficulty.
    complexity += (tokens as f64 / 2000.0).min(0.25);
    complexity += (constraints.len() as f64 / 12.0).min(0.15);

    // Strict structured output raises the bar for small models.
    if intent.output_type == "json" {
        complexity += 0.10;
    }
    // Ambiguity makes small models unreliable.
    complexity += (ambiguity_issues as f64 / 10.0).min(0.10);

    complexity = complexity.clamp(0.0, 1.0);

    let needs_reasoning = matches!(intent.task_type.as_str(), "reason" | "code") || complexity > 0.7;

    let (tier, examples, rationale) = if complexity < 0.25 {
        (
            "nano",
            vec!["gpt-4o-mini", "claude-haiku", "gemini-flash-lite"],
            "Simple, well-specified task — a nano model maximizes cost/latency efficiency.",
        )
    } else if complexity < 0.5 {
        (
            "small",
            vec!["claude-haiku", "gpt-4o-mini", "llama-3.1-8b"],
            "Moderate task with a clear contract — a small model is the cost-optimal choice.",
        )
    } else if complexity < 0.75 {
        (
            "mid",
            vec!["claude-sonnet", "gpt-4o", "gemini-pro"],
            "Multi-constraint or longer-context task — a mid-tier model balances quality and cost.",
        )
    } else {
        (
            "frontier",
            vec!["claude-opus", "gpt-4.1", "gemini-ultra"],
            "Reasoning-heavy or high-stakes task — a frontier model (optionally with extended thinking) is warranted.",
        )
    };

    RouteHint {
        tier: tier.to_string(),
        complexity,
        needs_reasoning,
        rationale: rationale.to_string(),
        examples: examples.into_iter().map(String::from).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Intent;

    fn intent(task: &str, output: &str) -> Intent {
        Intent {
            task_type: task.into(),
            output_type: output.into(),
            audience: "general".into(),
            confidence: 0.8,
        }
    }

    #[test]
    fn simple_task_routes_cheap() {
        let r = route(&intent("classify", "number"), &[], 50, 0);
        assert!(matches!(r.tier.as_str(), "nano" | "small"));
        assert!(!r.needs_reasoning);
    }

    #[test]
    fn reasoning_task_routes_high_and_flags_reasoning() {
        let r = route(&intent("reason", "prose"), &[], 1500, 2);
        assert!(matches!(r.tier.as_str(), "mid" | "frontier"));
        assert!(r.needs_reasoning);
    }

    #[test]
    fn complexity_bounded() {
        let r = route(&intent("code", "json"), &[], 100000, 100);
        assert!(r.complexity <= 1.0 && r.complexity >= 0.0);
    }
}
