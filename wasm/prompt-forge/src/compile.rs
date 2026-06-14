//! Compile the analysis into a canonical *symbolic prompt form*.
//!
//! This is the deterministic "expanded" artifact (`prompt.expanded.md`): a
//! normalized ROLE / TASK / INPUTS / CONSTRAINTS / OUTPUT / QUALITY BAR layout
//! assembled from the parsed sections, intent, constraints, and schema. A fixed
//! skeleton makes prompts diffable, testable, and portable across models.

use crate::model::{Constraint, Intent, SchemaInfo, Section};

pub fn compile(
    sections: &[Section],
    intent: &Intent,
    constraints: &[Constraint],
    schema: &SchemaInfo,
    token_budget: usize,
) -> String {
    let mut out = String::new();

    // ROLE
    let role = section_text(sections, "Role").unwrap_or_else(|| {
        format!("You are a domain-specific {} agent.", task_noun(&intent.task_type))
    });
    out.push_str("ROLE:\n");
    out.push_str(role.trim());
    out.push_str("\n\n");

    // TASK
    let task = section_text(sections, "Task")
        .or_else(|| section_text(sections, "Unknown"))
        .unwrap_or_else(|| format!("Produce {} output.", intent.output_type));
    out.push_str("TASK:\n");
    out.push_str(task.trim());
    if intent.audience != "general" {
        out.push_str(&format!("\nAudience: {}.", intent.audience));
    }
    out.push_str("\n\n");

    // INPUTS
    if let Some(inputs) = section_text(sections, "Inputs").or_else(|| section_text(sections, "Data")) {
        out.push_str("INPUTS:\n");
        out.push_str(inputs.trim());
        out.push_str("\n\n");
    } else {
        out.push_str("INPUTS:\n{source_material}\n\n");
    }

    // CONSTRAINTS — hoist every extracted requirement into an explicit, numbered
    // list. Negative rules last so they read as guardrails.
    out.push_str("CONSTRAINTS:\n");
    let mut n = 1;
    let (positives, negatives): (Vec<_>, Vec<_>) =
        constraints.iter().partition(|c| c.polarity != "must_not");
    for c in positives.iter().chain(negatives.iter()) {
        out.push_str(&format!("{n}. {}\n", clean_constraint(&c.text)));
        n += 1;
    }
    if n == 1 {
        // No explicit constraints found → inject sane defaults for reliability.
        out.push_str("1. Preserve all factual claims; cite uncertain ones.\n");
        out.push_str("2. Do not invent missing data.\n");
    }
    out.push('\n');

    // OUTPUT
    out.push_str("OUTPUT:\n");
    if schema.present {
        out.push_str("Return output matching this schema exactly:\n");
        if let Some(o) = section_text(sections, "Output") {
            out.push_str(o.trim());
        }
    } else if intent.output_type != "unknown" {
        out.push_str(&format!("Return {}.", describe_output(&intent.output_type)));
    } else {
        out.push_str("{schema}");
    }
    out.push_str("\n\n");

    // QUALITY BAR — the acceptance contract the eval loop enforces.
    out.push_str("QUALITY BAR:\n");
    out.push_str("- accuracy >= 0.90\n");
    out.push_str(if schema.present || intent.output_type == "json" {
        "- schema_validity = 1.00\n"
    } else {
        "- output contract honored\n"
    });
    out.push_str(&format!("- tokens <= {token_budget}\n"));
    out.push_str("- no safety violations\n");

    out
}

fn section_text(sections: &[Section], kind: &str) -> Option<String> {
    let joined: Vec<&str> = sections
        .iter()
        .filter(|s| s.kind == kind && !s.content.trim().is_empty())
        .map(|s| s.content.as_str())
        .collect();
    if joined.is_empty() {
        None
    } else {
        Some(joined.join("\n"))
    }
}

fn clean_constraint(s: &str) -> String {
    let t = s.trim().trim_end_matches(['.', ';', ',']);
    capitalize(t)
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => format!("{}{}", f.to_ascii_uppercase(), c.as_str()),
        None => String::new(),
    }
}

fn task_noun(task: &str) -> &'static str {
    match task {
        "summarize" => "summarization",
        "extract" => "information-extraction",
        "classify" => "classification",
        "translate" => "translation",
        "rewrite" => "editing",
        "code" => "software-engineering",
        "reason" => "reasoning",
        "converse" => "conversational",
        _ => "generation",
    }
}

fn describe_output(o: &str) -> &'static str {
    match o {
        "json" => "a single valid JSON object",
        "markdown" => "well-formed Markdown",
        "code" => "a single fenced code block",
        "list" => "a list of items",
        "number" => "a single numeric value",
        "prose" => "concise prose",
        _ => "the requested output",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ast, constraints, intent, schema};

    fn pipeline(p: &str) -> String {
        let sections = ast::parse(p);
        let intent = intent::parse(p);
        let cons = constraints::extract(p);
        let schema = schema::analyze(p);
        compile(&sections, &intent, &cons, &schema, 800)
    }

    #[test]
    fn always_has_canonical_skeleton() {
        let out = pipeline("Summarize the report. Do not invent data.");
        for marker in ["ROLE:", "TASK:", "CONSTRAINTS:", "OUTPUT:", "QUALITY BAR:"] {
            assert!(out.contains(marker), "missing {marker} in:\n{out}");
        }
    }

    #[test]
    fn hoists_constraints() {
        let out = pipeline("Write a summary. Must cite sources. Do not fabricate.");
        assert!(out.to_lowercase().contains("cite sources"));
        assert!(out.to_lowercase().contains("fabricate"));
    }

    #[test]
    fn injects_defaults_when_no_constraints() {
        let out = pipeline("Summarize this.");
        assert!(out.contains("Preserve all factual claims"));
    }

    #[test]
    fn includes_token_budget() {
        let out = pipeline("Summarize this.");
        assert!(out.contains("tokens <= 800"));
    }
}
