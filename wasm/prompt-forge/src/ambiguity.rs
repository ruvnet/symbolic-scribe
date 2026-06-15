//! Adversarial ambiguity check.
//!
//! Vague language is the silent killer of prompt reliability: "summarize this
//! appropriately" gives the model no testable target. We flag weasel words,
//! undefined references, conflicting instructions, and missing success
//! criteria, and roll them into an explainability/accuracy proxy.

use crate::model::{Constraint, Issue};

/// Weasel words that defer the actual decision back to the model.
const VAGUE_TERMS: &[&str] = &[
    "appropriate", "appropriately", "reasonable", "reasonably", "good", "nice",
    "properly", "etc", "and so on", "some", "several", "a few", "various",
    "relevant", "as needed", "if necessary", "high quality", "best", "optimal",
    "clean", "robust", "user-friendly", "intuitive", "modern", "professional",
    "appropriate amount", "stuff", "things", "appropriate length",
];

pub fn check(raw: &str, constraints: &[Constraint]) -> Vec<Issue> {
    let mut issues = Vec::new();

    for (i, line) in raw.lines().enumerate() {
        let lower = line.to_ascii_lowercase();
        for term in VAGUE_TERMS {
            if contains_word(&lower, term) {
                issues.push(Issue {
                    severity: "warn".into(),
                    code: "AMB001".into(),
                    message: format!("Vague term \"{term}\" — replace with a measurable criterion."),
                    snippet: line.trim().chars().take(120).collect(),
                    line: i,
                });
                break; // one finding per line is enough signal
            }
        }
    }

    // Undefined pronoun reference at the very start ("Do it.", "Fix this.").
    let head = raw.trim_start().to_ascii_lowercase();
    if head.starts_with("do it") || head.starts_with("fix this") || head.starts_with("do that") {
        issues.push(Issue {
            severity: "warn".into(),
            code: "AMB002".into(),
            message: "Opens with an undefined reference (\"it\"/\"this\"). State the task explicitly.".into(),
            snippet: raw.trim().chars().take(80).collect(),
            line: 0,
        });
    }

    // Conflicting length constraints (e.g. "be detailed" + "be very brief").
    let lower_all = raw.to_ascii_lowercase();
    let wants_long = has(&lower_all, &["detailed", "comprehensive", "in depth", "thorough", "exhaustive"]);
    let wants_short = has(&lower_all, &["brief", "concise", "short", "one sentence", "tl;dr", "terse"]);
    if wants_long && wants_short {
        issues.push(Issue {
            severity: "warn".into(),
            code: "AMB003".into(),
            message: "Conflicting length goals (asks for both detailed and brief). Pick one and quantify it.".into(),
            snippet: String::new(),
            line: 0,
        });
    }

    // No success criterion / acceptance bar at all.
    let has_criterion = has(&lower_all, &[
        "must", "exactly", "at most", "at least", "no more than", "schema",
        "json", "format", "pass", ">= ", "<= ", "words", "characters",
    ]) || !constraints.is_empty();
    if !has_criterion && raw.split_whitespace().count() > 12 {
        issues.push(Issue {
            severity: "info".into(),
            code: "AMB004".into(),
            message: "No explicit success criterion or output contract found. Add a measurable quality bar.".into(),
            snippet: String::new(),
            line: 0,
        });
    }

    issues
}

/// Clarity in 0..=1, derived from ambiguity density. Drives the explainability
/// and (partly) the accuracy proxies.
pub fn clarity(issues: &[Issue], words: usize) -> f64 {
    let weighted: f64 = issues
        .iter()
        .map(|i| match i.severity.as_str() {
            "error" => 0.3,
            "warn" => 0.15,
            _ => 0.05,
        })
        .sum();
    // Normalize loosely by length so long prompts aren't unfairly penalized.
    let density = weighted / (1.0 + (words as f64 / 100.0));
    (1.0 - density).clamp(0.0, 1.0)
}

fn contains_word(haystack: &str, word: &str) -> bool {
    if word.contains(' ') {
        return haystack.contains(word);
    }
    // Word-boundary match to avoid "some" matching "something".
    let bytes = haystack.as_bytes();
    let wb = word.as_bytes();
    let mut i = 0;
    while let Some(pos) = haystack[i..].find(word) {
        let start = i + pos;
        let end = start + wb.len();
        let left_ok = start == 0 || !is_word_byte(bytes[start - 1]);
        let right_ok = end >= bytes.len() || !is_word_byte(bytes[end]);
        if left_ok && right_ok {
            return true;
        }
        i = start + 1;
        if i >= haystack.len() {
            break;
        }
    }
    false
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn has(h: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| h.contains(n))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_vague_terms() {
        let issues = check("Make it appropriately good and clean.", &[]);
        assert!(issues.iter().any(|i| i.code == "AMB001"));
    }

    #[test]
    fn word_boundary_avoids_false_positive() {
        // "some" should not fire inside "something".
        let issues = check("Return something useful from the dataset schema.", &[]);
        assert!(!issues.iter().any(|i| i.snippet.contains("something") && i.code == "AMB001"));
    }

    #[test]
    fn flags_conflicting_length() {
        let issues = check("Write a comprehensive but very brief overview.", &[]);
        assert!(issues.iter().any(|i| i.code == "AMB003"));
    }

    #[test]
    fn clarity_decreases_with_issues() {
        let clean = clarity(&[], 50);
        let messy = clarity(&check("Make it appropriate and reasonable and good.", &[]), 50);
        assert!(clean > messy);
    }
}
