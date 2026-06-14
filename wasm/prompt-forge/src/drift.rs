//! Prompt drift analysis.
//!
//! When we transform a prompt (compress / compile) we must prove we didn't
//! *drift* away from its meaning. Surface form is allowed to change a lot
//! (restructuring is the point); what must be preserved is the load-bearing
//! content: numbers, named entities, and constraints. This module quantifies
//! both — lexical change (expected, not penalized) and semantic retention
//! (must stay ~1.0) — and flags any lost facts.

use crate::constraints;
use serde::Serialize;
use std::collections::HashSet;

#[derive(Serialize, Clone, Debug)]
pub struct DriftReport {
    /// Jaccard similarity of content-word sets (0=fully reworded, 1=identical).
    /// Reported for transparency; low values are fine for restructuring.
    pub lexical_similarity: f64,
    /// Fraction of distinct numeric literals in the original still present.
    pub number_retention: f64,
    /// Fraction of capitalized multi-letter tokens (proper nouns / acronyms)
    /// still present.
    pub entity_retention: f64,
    /// Fraction of extracted constraints whose content survives.
    pub constraint_retention: f64,
    /// Overall semantic drift in 0..=1 (0 = nothing lost). Weighted toward the
    /// objectively checkable signals (numbers, constraints).
    pub drift: f64,
    pub lost_numbers: Vec<String>,
    pub lost_entities: Vec<String>,
    /// True when no facts/constraints were dropped beyond tolerance.
    pub within_tolerance: bool,
}

pub fn analyze(original: &str, transformed: &str) -> DriftReport {
    let orig_words = content_words(original);
    let new_words = content_words(transformed);
    let lexical_similarity = jaccard(&orig_words, &new_words);

    let (number_retention, lost_numbers) = retention(numbers(original), &numbers_set(transformed));
    let (entity_retention, lost_entities) = retention(entities(original), &entities_set(transformed));

    let constraint_retention = constraint_retention(original, transformed);

    // Drift weights the checkable, high-stakes signals most heavily.
    let retention = 0.45 * number_retention + 0.35 * constraint_retention + 0.20 * entity_retention;
    let drift = (1.0 - retention).clamp(0.0, 1.0);

    let within_tolerance = number_retention >= 0.999 && constraint_retention >= 0.9;

    DriftReport {
        lexical_similarity,
        number_retention,
        entity_retention,
        constraint_retention,
        drift,
        lost_numbers,
        lost_entities,
        within_tolerance,
    }
}

fn retention(original: Vec<String>, transformed: &HashSet<String>) -> (f64, Vec<String>) {
    if original.is_empty() {
        return (1.0, vec![]);
    }
    let distinct: HashSet<String> = original.into_iter().collect();
    let mut lost = Vec::new();
    let mut kept = 0;
    for item in &distinct {
        if transformed.contains(item) {
            kept += 1;
        } else {
            lost.push(item.clone());
        }
    }
    lost.sort();
    (kept as f64 / distinct.len() as f64, lost)
}

fn constraint_retention(original: &str, transformed: &str) -> f64 {
    let oc = constraints::extract(original);
    if oc.is_empty() {
        return 1.0;
    }
    let tlower = transformed.to_ascii_lowercase();
    // A constraint "survives" if its content words still co-occur in the output.
    let kept = oc
        .iter()
        .filter(|c| {
            let key_words: Vec<String> = content_words_of(&c.text)
                .into_iter()
                .filter(|w| w.len() > 3)
                .collect();
            if key_words.is_empty() {
                return true;
            }
            let present = key_words.iter().filter(|w| tlower.contains(*w)).count();
            // Majority of the constraint's content words present → preserved.
            present * 2 >= key_words.len()
        })
        .count();
    kept as f64 / oc.len() as f64
}

/// Lowercased content words (drops short stopwords) as a set.
fn content_words(s: &str) -> HashSet<String> {
    content_words_of(s).into_iter().collect()
}

fn content_words_of(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() > 2 && !is_stopword(w))
        .map(|w| w.to_ascii_lowercase())
        .collect()
}

fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let inter = a.intersection(b).count() as f64;
    let union = a.union(b).count() as f64;
    if union == 0.0 {
        1.0
    } else {
        inter / union
    }
}

/// Distinct numeric literals (e.g. "0.92", "1500", "3").
fn numbers(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in s.chars() {
        if ch.is_ascii_digit() || (ch == '.' && !cur.is_empty()) || (ch == '%' && !cur.is_empty()) {
            cur.push(ch);
        } else {
            push_number(&mut out, &mut cur);
        }
    }
    push_number(&mut out, &mut cur);
    out
}

fn push_number(out: &mut Vec<String>, cur: &mut String) {
    let trimmed = cur.trim_end_matches('.');
    if !trimmed.is_empty() && trimmed.chars().any(|c| c.is_ascii_digit()) {
        out.push(trimmed.to_string());
    }
    cur.clear();
}

fn numbers_set(s: &str) -> HashSet<String> {
    numbers(s).into_iter().collect()
}

/// Capitalized multi-letter tokens (proper nouns / acronyms), excluding
/// sentence-initial common words is approximated by length>=2 + has-uppercase.
fn entities(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|w| {
            w.len() >= 2
                && w.chars().next().map_or(false, |c| c.is_ascii_uppercase())
                && !is_stopword(&w.to_ascii_lowercase())
        })
        .map(|w| w.to_string())
        .collect()
}

fn entities_set(s: &str) -> HashSet<String> {
    entities(s).into_iter().collect()
}

fn is_stopword(w: &str) -> bool {
    matches!(
        w.to_ascii_lowercase().as_str(),
        "the" | "and" | "for" | "you" | "are" | "with" | "this" | "that" | "your"
            | "from" | "into" | "must" | "not" | "all" | "any" | "use" | "make"
            | "please" | "should" | "will" | "can" | "may" | "out" | "but" | "now"
            | "role" | "task" | "output" | "input" | "inputs" | "constraints"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_numbers_zero_drift() {
        let a = "Set the threshold to 0.92 and budget to 1500 tokens.";
        let b = "Threshold: 0.92. Budget: 1500 tokens.";
        let d = analyze(a, b);
        assert_eq!(d.number_retention, 1.0);
        assert!(d.within_tolerance);
        assert!(d.lost_numbers.is_empty());
    }

    #[test]
    fn detects_lost_number() {
        let a = "Keep under 250 words and cite 3 sources.";
        let b = "Keep it short and cite sources.";
        let d = analyze(a, b);
        assert!(d.number_retention < 1.0);
        assert!(!d.within_tolerance);
        assert!(d.lost_numbers.contains(&"250".to_string()));
    }

    #[test]
    fn restructuring_keeps_semantics_despite_lexical_change() {
        let a = "Please please summarize the Acme incident. Do not invent data. Cite sources.";
        let b = "ROLE:\nYou are a summarization agent.\nTASK:\nSummarize the Acme incident.\nCONSTRAINTS:\n1. Cite sources\n2. Do not invent data";
        let d = analyze(a, b);
        assert!(d.entity_retention >= 0.99, "Acme should survive");
        assert!(d.constraint_retention >= 0.9, "constraints should survive: {}", d.constraint_retention);
        assert!(d.drift < 0.1, "semantic drift should be low: {}", d.drift);
    }

    #[test]
    fn identical_has_zero_drift() {
        let s = "Summarize the report in 3 bullets.";
        let d = analyze(s, s);
        assert_eq!(d.drift, 0.0);
        assert_eq!(d.lexical_similarity, 1.0);
    }
}
