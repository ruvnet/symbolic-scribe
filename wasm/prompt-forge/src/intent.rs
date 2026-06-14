//! Intent parsing: infer task type, output type, and audience from the prompt.

use crate::model::Intent;

pub fn parse(raw: &str) -> Intent {
    let lower = raw.to_ascii_lowercase();

    let (task_type, mut conf) = classify_task(&lower);
    let output_type = classify_output(&lower);
    let audience = detect_audience(&lower);

    // Confidence bonus if the output is explicitly specified.
    if output_type != "unknown" {
        conf += 0.1;
    }
    if audience != "general" {
        conf += 0.05;
    }

    Intent {
        task_type,
        output_type,
        audience,
        confidence: conf.clamp(0.0, 1.0),
    }
}

fn classify_task(lower: &str) -> (String, f64) {
    // Ordered, weighted keyword voting — first strong hit wins, but we keep a
    // confidence proportional to signal strength.
    let table: &[(&str, &[&str])] = &[
        ("summarize", &["summarize", "summarise", "tl;dr", "condense", "brief overview"]),
        ("extract", &["extract", "pull out", "identify all", "find all", "parse the"]),
        ("classify", &["classify", "categorize", "categorise", "label each", "sentiment", "is this"]),
        ("translate", &["translate", "into french", "into spanish", "to english", "localize"]),
        ("rewrite", &["rewrite", "rephrase", "paraphrase", "improve the", "edit the", "proofread"]),
        ("code", &["write code", "function", "implement", "refactor", "debug", "unit test", "in python", "in rust", "typescript"]),
        ("reason", &["reason", "prove", "derive", "step by step", "chain of thought", "solve the", "calculate", "deduce"]),
        ("generate", &["generate", "write a", "create a", "compose", "draft", "produce a", "design a"]),
        ("converse", &["chat", "conversation", "respond to the user", "as a chatbot", "dialogue"]),
    ];

    let mut best = ("generate".to_string(), 0usize);
    for (name, kws) in table {
        let hits = kws.iter().filter(|k| lower.contains(**k)).count();
        if hits > best.1 {
            best = (name.to_string(), hits);
        }
    }
    let conf = match best.1 {
        0 => 0.4,
        1 => 0.7,
        _ => 0.85,
    };
    (best.0, conf)
}

fn classify_output(lower: &str) -> String {
    if has(lower, &["json", "schema", "{", "valid object", "key-value"]) {
        "json".into()
    } else if has(lower, &["markdown", "## ", "bullet", "table", "headings"]) {
        "markdown".into()
    } else if has(lower, &["code block", "```", "function", "snippet"]) {
        "code".into()
    } else if has(lower, &["list", "enumerate", "bullet points", "numbered"]) {
        "list".into()
    } else if has(lower, &["a number", "single integer", "score from", "percentage", "probability"]) {
        "number".into()
    } else if has(lower, &["paragraph", "prose", "essay", "explain", "describe"]) {
        "prose".into()
    } else {
        "unknown".into()
    }
}

fn detect_audience(lower: &str) -> String {
    let table: &[(&str, &[&str])] = &[
        ("developers", &["developer", "engineer", "programmer", "technical team"]),
        ("executives", &["executive", "ceo", "stakeholder", "leadership", "board"]),
        ("children", &["child", "kid", "five year old", "5 year old", "eli5", "elementary"]),
        ("experts", &["expert", "researcher", "phd", "specialist", "domain expert"]),
        ("customers", &["customer", "end user", "client", "support"]),
        ("students", &["student", "learner", "beginner", "novice"]),
    ];
    for (name, kws) in table {
        if has(lower, kws) {
            return (*name).into();
        }
    }
    "general".into()
}

fn has(h: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| h.contains(n))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_summarize_json() {
        let i = parse("Summarize the article and return JSON with key points.");
        assert_eq!(i.task_type, "summarize");
        assert_eq!(i.output_type, "json");
        assert!(i.confidence > 0.6);
    }

    #[test]
    fn detects_code_task() {
        let i = parse("Implement a function in Rust that parses CSV.");
        assert_eq!(i.task_type, "code");
    }

    #[test]
    fn detects_audience() {
        let i = parse("Explain recursion to a five year old.");
        assert_eq!(i.audience, "children");
    }

    #[test]
    fn defaults_gracefully() {
        let i = parse("Tell me about dogs.");
        assert!(!i.task_type.is_empty());
        assert!(i.confidence > 0.0);
    }
}
