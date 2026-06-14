//! Constraint extraction: pull testable requirements out of prose.
//!
//! A "constraint" is any imperative the model is expected to honor — a hard
//! rule ("must", "never"), a format demand ("return JSON"), a length bound, or
//! a soft preference ("prefer", "should"). Extracting them as structured items
//! lets the compiler hoist them into an explicit CONSTRAINTS block and lets the
//! safety/ambiguity passes reason about conflicts.

use crate::model::Constraint;

pub fn extract(raw: &str) -> Vec<Constraint> {
    let mut out = Vec::new();
    for (idx, line) in raw.lines().enumerate() {
        // Split a line into clause-like sentences.
        for clause in split_clauses(line) {
            let c = clause.trim();
            if c.len() < 3 {
                continue;
            }
            if let Some(constraint) = classify_clause(c, idx) {
                out.push(constraint);
            }
        }
    }
    dedup(out)
}

fn split_clauses(line: &str) -> Vec<String> {
    // Bullet markers and sentence terminators both delimit clauses.
    let cleaned = line
        .trim_start_matches(|c: char| c == '-' || c == '*' || c == '•' || c.is_whitespace() || c.is_ascii_digit() || c == '.' || c == ')');
    cleaned
        .split(|c| c == '.' || c == ';' || c == '\n')
        .map(|s| s.to_string())
        .collect()
}

fn classify_clause(clause: &str, line: usize) -> Option<Constraint> {
    let lower = clause.to_ascii_lowercase();

    let (polarity, strength) = if has(&lower, &["must not", "do not", "don't", "never", "avoid", "no longer", "shall not"]) {
        ("must_not", 2)
    } else if has(&lower, &["must", "always", "ensure", "require", "shall", "you have to", "need to", "make sure"]) {
        ("must", 2)
    } else if has(&lower, &["should", "prefer", "ideally", "try to", "aim to", "when possible"]) {
        ("should", 1)
    } else if has(&lower, &["return", "respond", "format", "output", "reply", "use the following", "in json", "as a"]) {
        ("format", 1)
    } else {
        return None;
    };

    let category = categorize(&lower);

    // Skip empty/degenerate imperatives like a lone "do not".
    let words = clause.split_whitespace().count();
    if words < 2 && strength < 2 {
        return None;
    }

    Some(Constraint {
        polarity: polarity.into(),
        text: normalize_text(clause),
        category,
        line,
    })
}

fn categorize(lower: &str) -> String {
    if has(lower, &["json", "format", "schema", "markdown", "bullet", "table", "object", "field", "key"]) {
        "format".into()
    } else if has(lower, &["fact", "invent", "hallucinat", "make up", "fabricat", "accurate", "cite", "source", "evidence"]) {
        "factuality".into()
    } else if has(lower, &["safe", "harm", "refus", "policy", "pii", "personal", "confidential", "illegal", "jailbreak"]) {
        "safety".into()
    } else if has(lower, &["word", "sentence", "paragraph", "character", "length", "concise", "brief", "under", "at most", "no more than", "tokens"]) {
        "length".into()
    } else if has(lower, &["tone", "style", "voice", "formal", "casual", "professional", "friendly"]) {
        "style".into()
    } else if has(lower, &["tool", "function", "call", "api", "action"]) {
        "tooling".into()
    } else {
        "general".into()
    }
}

fn normalize_text(s: &str) -> String {
    let t = s.trim();
    let mut out = String::with_capacity(t.len());
    let mut prev_space = false;
    for ch in t.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out
}

fn dedup(mut v: Vec<Constraint>) -> Vec<Constraint> {
    let mut seen = std::collections::HashSet::new();
    v.retain(|c| seen.insert(c.text.to_ascii_lowercase()));
    v
}

fn has(h: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| h.contains(n))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_negative_and_positive() {
        let p = "You must cite sources. Do not invent data.";
        let c = extract(p);
        assert!(c.iter().any(|x| x.polarity == "must"));
        assert!(c.iter().any(|x| x.polarity == "must_not"));
    }

    #[test]
    fn categorizes_format() {
        let c = extract("Always return valid JSON matching the schema.");
        assert!(c.iter().any(|x| x.category == "format"));
    }

    #[test]
    fn categorizes_factuality() {
        let c = extract("Never fabricate citations.");
        assert!(c.iter().any(|x| x.category == "factuality"));
    }

    #[test]
    fn dedups_repeats() {
        let c = extract("Must be concise.\nMust be concise.");
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn handles_bullets() {
        let p = "- Do not use markdown\n- Must respond in English";
        let c = extract(p);
        assert_eq!(c.len(), 2);
    }
}
