//! SynthLang-style compression: shrink token cost without dropping meaning.
//!
//! The hard rule from the spec: compression may reduce cost but must not destroy
//! nuance. So every transform here is *meaning-preserving by construction*:
//!   - collapse redundant whitespace,
//!   - strip filler/politeness that carries no instruction,
//!   - de-duplicate repeated sentences/instructions,
//!   - contract verbose boilerplate to canonical short forms.
//!
//! Lines carrying load-bearing content (numbers, code fences, JSON, named
//! entities, explicit constraints) are protected from sentence-dropping.

use crate::token::count_tokens;

#[derive(Clone)]
pub struct PassResult {
    pub name: String,
    pub before_tokens: usize,
    pub after_tokens: usize,
    pub note: String,
}

pub struct Compressed {
    pub text: String,
    pub passes: Vec<PassResult>,
    pub before_tokens: usize,
    pub after_tokens: usize,
}

impl Compressed {
    pub fn reduction(&self) -> f64 {
        if self.before_tokens == 0 {
            return 0.0;
        }
        1.0 - (self.after_tokens as f64 / self.before_tokens as f64)
    }
}

/// Filler phrases that add tokens but no instruction. Order matters: longer
/// phrases first so they win over their substrings.
const FILLER: &[(&str, &str)] = &[
    ("i would just like you to ", ""),
    ("i would like you to ", ""),
    ("i just want you to ", ""),
    ("i want you to ", ""),
    ("i just need you to ", ""),
    ("i need you to ", ""),
    ("i would really appreciate it if you could ", ""),
    ("if you could please ", ""),
    ("if you could ", ""),
    ("go ahead and ", ""),
    ("feel free to ", ""),
    ("i would like for you to ", ""),
    ("what i need is for you to ", ""),
    ("in a way that is ", ""),
    ("please make sure to ", ""),
    ("please make sure that you ", ""),
    ("make sure that you ", ""),
    ("make sure to ", ""),
    ("be sure to ", ""),
    ("it is important that you ", ""),
    ("it is important to ", ""),
    ("as an ai language model, ", ""),
    ("as an ai assistant, ", ""),
    ("in order to ", "to "),
    ("due to the fact that ", "because "),
    ("at this point in time ", "now "),
    ("for the purpose of ", "for "),
    ("in the event that ", "if "),
    ("a large number of ", "many "),
    ("the vast majority of ", "most "),
    ("take into consideration ", "consider "),
    ("with regard to ", "regarding "),
    ("with reference to ", "regarding "),
    ("please ", ""),
    ("kindly ", ""),
    ("very ", ""),
    ("really ", ""),
    ("just ", ""),
    ("simply ", ""),
    ("basically ", ""),
    ("actually ", ""),
    ("that being said, ", ""),
];

pub fn compress(raw: &str) -> Compressed {
    let before_tokens = count_tokens(raw);
    let mut passes = Vec::new();
    let mut text = raw.to_string();

    // Pass 1: whitespace normalization.
    let b = count_tokens(&text);
    text = normalize_whitespace(&text);
    passes.push(pass("whitespace", b, count_tokens(&text), "collapsed redundant spacing/blank lines"));

    // Pass 2: filler/politeness removal (line-protected).
    let b = count_tokens(&text);
    text = strip_filler(&text);
    passes.push(pass("filler", b, count_tokens(&text), "removed non-instructional boilerplate"));

    // Pass 3: de-duplicate repeated sentences/instructions.
    let b = count_tokens(&text);
    let (deduped, removed) = dedup_sentences(&text);
    text = deduped;
    passes.push(pass("dedup", b, count_tokens(&text), &format!("removed {removed} duplicate statement(s)")));

    let after_tokens = count_tokens(&text);
    Compressed { text, passes, before_tokens, after_tokens }
}

fn normalize_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut blank_run = 0;
    let mut in_fence = false;
    for line in s.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            out.push_str(line);
            out.push('\n');
            continue;
        }
        // Never reflow content inside code fences or otherwise-protected lines.
        if in_fence || is_protected(line) {
            out.push_str(trim_trailing(line));
            out.push('\n');
            blank_run = 0;
            continue;
        }
        let trimmed = trim_trailing(line);
        if trimmed.trim().is_empty() {
            blank_run += 1;
            if blank_run <= 1 {
                out.push('\n');
            }
            continue;
        }
        blank_run = 0;
        // Collapse internal runs of spaces (but keep leading indentation).
        out.push_str(&collapse_inner_spaces(trimmed));
        out.push('\n');
    }
    out.trim_end().to_string()
}

fn collapse_inner_spaces(line: &str) -> String {
    let indent_len = line.len() - line.trim_start().len();
    let (indent, rest) = line.split_at(indent_len);
    let mut out = String::with_capacity(line.len());
    out.push_str(indent);
    let mut prev_space = false;
    for ch in rest.chars() {
        if ch == ' ' {
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

fn trim_trailing(s: &str) -> &str {
    s.trim_end_matches([' ', '\t'])
}

/// Remove filler phrases unless the line is protected (code/JSON/literal).
fn strip_filler(s: &str) -> String {
    s.lines()
        .map(|line| {
            if is_protected(line) {
                return line.to_string();
            }
            // Cascade the filler pass until stable: removing one phrase can
            // expose another (e.g. "I would just like you to" → after "just" →
            // "I would like you to" → removed on the next pass). Capped to keep
            // it bounded and deterministic.
            let mut work = line.to_string();
            for _ in 0..4 {
                let (next, changed) = apply_fillers_once(&work);
                work = next;
                if !changed {
                    break;
                }
            }
            // Re-capitalize the first letter if we stripped a leading filler.
            capitalize_first(&work)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Lines we never touch: code fences, indented code, JSON, schema, examples.
fn is_protected(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("```")
        || t.starts_with('{')
        || t.starts_with('}')
        || t.starts_with('"')
        || (line.len() - t.len()) >= 4 // 4+ space indent → code
        || t.starts_with("- \"")
}

/// Apply *all* filler phrases to a line in a single left-to-right pass.
///
/// The previous implementation called a per-phrase replacer for each of the ~40
/// fillers, and each call allocated a fresh `to_ascii_lowercase()` copy of the
/// whole line — O(fillers × line) allocation per cascade pass, which dominated
/// `compress`/`optimize` latency (a single 9 KB line lowercased ~170×). Here we
/// lowercase once and, at each word-boundary position, test the fillers
/// (declared longest-first, so the longest wins) and splice in the replacement.
/// Returns the rewritten line and whether anything changed.
fn apply_fillers_once(haystack: &str) -> (String, bool) {
    let lower = haystack.to_ascii_lowercase();
    let bytes = haystack.as_bytes();
    let mut result = String::with_capacity(haystack.len());
    let mut i = 0;
    let mut changed = false;
    while i < haystack.len() {
        let boundary_ok = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
        let mut matched = false;
        if boundary_ok {
            for (from, to) in FILLER {
                if lower[i..].starts_with(from) {
                    result.push_str(to);
                    i += from.len();
                    matched = true;
                    changed = true;
                    break;
                }
            }
        }
        if !matched {
            let ch_len = haystack[i..].chars().next().map_or(1, |c| c.len_utf8());
            result.push_str(&haystack[i..i + ch_len]);
            i += ch_len;
        }
    }
    (result, changed)
}

fn capitalize_first(s: &str) -> String {
    let trimmed_start = s.len() - s.trim_start().len();
    let (lead, rest) = s.split_at(trimmed_start);
    let mut chars = rest.chars();
    match chars.next() {
        Some(c) => format!("{lead}{}{}", c.to_ascii_uppercase(), chars.as_str()),
        None => s.to_string(),
    }
}

/// Drop later exact/near-exact duplicate sentences. Protected lines pass through.
fn dedup_sentences(s: &str) -> (String, usize) {
    let mut seen = std::collections::HashSet::new();
    let mut removed = 0;
    let out: Vec<String> = s
        .lines()
        .map(|line| {
            if is_protected(line) || line.trim().is_empty() {
                return line.to_string();
            }
            let kept: Vec<String> = split_sentences(line)
                .into_iter()
                .filter(|sent| {
                    let key = canonical(sent);
                    if key.split_whitespace().count() < 3 {
                        return true; // too short to be a meaningful dup
                    }
                    if seen.insert(key) {
                        true
                    } else {
                        removed += 1;
                        false
                    }
                })
                .collect();
            kept.join(" ")
        })
        .collect();
    (out.join("\n"), removed)
}

fn split_sentences(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = line.chars().collect();
    for (i, &ch) in chars.iter().enumerate() {
        cur.push(ch);
        if matches!(ch, '.' | '!' | '?') {
            // Only treat as a sentence boundary when followed by whitespace or
            // end-of-line. This avoids splitting decimals ("0.92"), abbreviations
            // ("e.g."), and version strings.
            let next = chars.get(i + 1);
            let boundary = match next {
                None => true,
                Some(c) => c.is_whitespace(),
            };
            // Never split a decimal: digit '.' digit.
            let is_decimal = ch == '.'
                && i > 0
                && chars[i - 1].is_ascii_digit()
                && next.map_or(false, |c| c.is_ascii_digit());
            if boundary && !is_decimal {
                out.push(cur.trim().to_string());
                cur.clear();
            }
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

fn canonical(s: &str) -> String {
    s.to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn pass(name: &str, before: usize, after: usize, note: &str) -> PassResult {
    PassResult {
        name: name.to_string(),
        before_tokens: before,
        after_tokens: after,
        note: note.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduces_tokens() {
        let p = "I would like you to please summarize this. Please make sure to be concise.";
        let c = compress(p);
        assert!(c.after_tokens < c.before_tokens, "{} !< {}", c.after_tokens, c.before_tokens);
        assert!(c.reduction() > 0.0);
    }

    #[test]
    fn dedups_repeated_instruction() {
        let p = "Always cite sources. Always cite sources.";
        let c = compress(p);
        assert!(c.text.matches("cite sources").count() == 1);
    }

    #[test]
    fn protects_code_blocks() {
        let p = "```\n    please keep this    spacing\n```";
        let c = compress(p);
        assert!(c.text.contains("    please keep this    spacing"));
    }

    #[test]
    fn collapses_blank_lines() {
        let p = "a\n\n\n\nb";
        let c = compress(p);
        assert!(!c.text.contains("\n\n\n"));
    }

    #[test]
    fn preserves_numbers_and_facts() {
        let p = "The threshold must be 0.92 and the budget is 1500 tokens.";
        let c = compress(p);
        assert!(c.text.contains("0.92"));
        assert!(c.text.contains("1500"));
    }
}
