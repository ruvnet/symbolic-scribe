//! Prompt → AST. Splits a raw prompt into typed [`Section`]s.
//!
//! Real prompts are semi-structured: a mix of headed blocks ("ROLE:", "## Task",
//! "Output format:"), bare imperative paragraphs, fenced code, and bullet lists.
//! We classify each block by its heading (if any) or, failing that, by content
//! signal, into a small canonical taxonomy that downstream passes rely on.

use crate::model::Section;
use crate::token::count_tokens;

/// Parse `raw` into sections. Blocks are delimited by headings or blank lines.
pub fn parse(raw: &str) -> Vec<Section> {
    let lines: Vec<&str> = raw.lines().collect();
    let mut sections: Vec<Section> = Vec::new();

    let mut cur_kind: Option<String> = None;
    let mut cur_title = String::new();
    let mut cur_lines: Vec<String> = Vec::new();
    let mut cur_start = 0usize;
    let mut in_fence = false;

    let flush =
        |sections: &mut Vec<Section>, kind: &Option<String>, title: &str, body: &[String], start: usize, end: usize| {
            let content = body.join("\n");
            if content.trim().is_empty() && kind.is_none() {
                return;
            }
            let resolved = kind
                .clone()
                .unwrap_or_else(|| classify_by_content(&content));
            sections.push(Section {
                kind: resolved,
                title: title.to_string(),
                content: content.trim_end().to_string(),
                tokens: count_tokens(&content),
                start_line: start,
                end_line: end,
            });
        };

    for (i, &line) in lines.iter().enumerate() {
        let trimmed = line.trim();

        // Track fenced code so headings inside code aren't mis-parsed.
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            cur_lines.push(line.to_string());
            continue;
        }

        if !in_fence {
            if let Some((kind, title)) = detect_heading(line) {
                // A heading closes the previous block and opens a new one.
                if cur_kind.is_some() || !cur_lines.is_empty() {
                    flush(&mut sections, &cur_kind, &cur_title, &cur_lines, cur_start, i.saturating_sub(1));
                }
                cur_kind = Some(kind);
                cur_title = title;
                cur_lines = Vec::new();
                cur_start = i;
                continue;
            }
        }

        if cur_lines.is_empty() && trimmed.is_empty() {
            // Skip leading blank lines of a block.
            cur_start = i + 1;
            continue;
        }
        cur_lines.push(line.to_string());
    }
    flush(
        &mut sections,
        &cur_kind,
        &cur_title,
        &cur_lines,
        cur_start,
        lines.len().saturating_sub(1),
    );

    sections
}

/// Detect a heading line like `ROLE:`, `## Task`, `**Output**`, `Constraints -`.
/// Returns `(canonical_kind, original_title)`.
fn detect_heading(line: &str) -> Option<(String, String)> {
    let raw = line.trim();
    if raw.is_empty() {
        return None;
    }

    // Strip markdown / emphasis decoration.
    let mut t = raw.trim_start_matches('#').trim();
    t = t.trim_start_matches("- ").trim();
    let t = t.trim_matches(|c| c == '*' || c == '_' || c == '`');

    // A heading is either markdown (`# ...`) or a short `Label:` line.
    let is_markdown_heading = raw.starts_with('#');
    let colon_label = t.find(':').map(|p| (&t[..p], p)).filter(|(label, p)| {
        *p <= 24 && !label.is_empty() && label.split_whitespace().count() <= 3
    });

    let (label, title) = if is_markdown_heading {
        (t.trim_end_matches(':').to_string(), t.to_string())
    } else if let Some((label, _)) = colon_label {
        (label.to_string(), raw.to_string())
    } else {
        return None;
    };

    let kind = canonical_kind(&label)?;
    Some((kind, title))
}

/// Map a free-text heading label to a canonical section kind.
fn canonical_kind(label: &str) -> Option<String> {
    let l = label.to_ascii_lowercase();
    let l = l.trim();
    let kind = match l {
        _ if has_any(l, &["role", "persona", "you are", "system", "act as"]) => "Role",
        _ if has_any(l, &["task", "goal", "objective", "instruction", "request", "job"]) => "Task",
        _ if has_any(l, &["input", "source", "document", "article", "given", "material"]) => "Inputs",
        _ if has_any(l, &["context", "background"]) => "Context",
        _ if has_any(l, &["constraint", "requirement", "rule", "guideline", "must"]) => "Constraints",
        _ if has_any(l, &["example", "few-shot", "fewshot", "demonstration", "sample"]) => "Examples",
        _ if has_any(l, &["output", "format", "response", "schema", "return", "answer"]) => "Output",
        _ if has_any(l, &["policy", "safety", "refus", "moderation", "compliance"]) => "Policy",
        _ if has_any(l, &["data", "knowledge", "reference", "facts"]) => "Data",
        _ if has_any(l, &["tool", "function", "api", "action"]) => "Tools",
        _ if has_any(l, &["quality", "bar", "acceptance", "eval"]) => "Constraints",
        _ => return None,
    };
    Some(kind.to_string())
}

/// Classify an unheaded block by its content.
fn classify_by_content(content: &str) -> String {
    let lower = content.to_ascii_lowercase();
    let trimmed = content.trim();

    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        return "Output".to_string();
    }
    if lower.starts_with("you are ") || lower.contains("act as a") || lower.contains("you're a ") {
        return "Role".to_string();
    }
    if has_any(&lower, &["return json", "respond in", "output format", "format your", "in the following format"]) {
        return "Output".to_string();
    }
    if has_any(&lower, &["do not", "must not", "never", "always", "ensure that", "you must"]) {
        return "Constraints".to_string();
    }
    if has_any(&lower, &["for example", "e.g.", "input:", "example:"]) {
        return "Examples".to_string();
    }
    // Imperative opener → most likely the task.
    let first = lower.split_whitespace().next().unwrap_or("");
    if is_imperative_verb(first) {
        return "Task".to_string();
    }
    "Unknown".to_string()
}

fn has_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| haystack.contains(n))
}

/// A compact list of common task-opening imperative verbs.
pub fn is_imperative_verb(w: &str) -> bool {
    matches!(
        w,
        "summarize"
            | "summarise"
            | "write"
            | "generate"
            | "create"
            | "extract"
            | "classify"
            | "translate"
            | "rewrite"
            | "explain"
            | "describe"
            | "analyze"
            | "analyse"
            | "list"
            | "produce"
            | "compose"
            | "convert"
            | "build"
            | "design"
            | "compare"
            | "evaluate"
            | "identify"
            | "draft"
            | "answer"
            | "compute"
            | "calculate"
            | "find"
            | "determine"
            | "implement"
            | "refactor"
            | "review"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_colon_headings() {
        let p = "ROLE:\nYou are an expert.\nTASK:\nSummarize the text.";
        let s = parse(p);
        let kinds: Vec<&str> = s.iter().map(|x| x.kind.as_str()).collect();
        assert!(kinds.contains(&"Role"));
        assert!(kinds.contains(&"Task"));
    }

    #[test]
    fn splits_markdown_headings() {
        let p = "## Output\nReturn JSON.\n\n## Constraints\nDo not invent data.";
        let s = parse(p);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].kind, "Output");
        assert_eq!(s[1].kind, "Constraints");
    }

    #[test]
    fn classifies_unheaded_role() {
        let s = parse("You are a senior security analyst.");
        assert_eq!(s[0].kind, "Role");
    }

    #[test]
    fn classifies_unheaded_task() {
        let s = parse("Summarize the following incident report.");
        assert_eq!(s[0].kind, "Task");
    }

    #[test]
    fn does_not_break_on_code_fence() {
        let p = "Task: do it\n```\n# not a heading\nrole: nope\n```\n";
        let s = parse(p);
        // The fenced block stays inside the Task section.
        assert!(s.iter().any(|x| x.kind == "Task"));
        assert!(!s.iter().any(|x| x.content.starts_with("role: nope")));
    }
}
