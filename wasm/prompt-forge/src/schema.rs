//! Output-schema detection & validation.
//!
//! If the prompt asks for JSON, is a concrete schema/example actually given,
//! and is it well-formed? A present-and-valid schema is the single biggest
//! lever on structured-output reliability, so it carries heavy scoring weight.

use crate::model::SchemaInfo;

pub fn analyze(raw: &str) -> SchemaInfo {
    let lower = raw.to_ascii_lowercase();
    let asks_json = lower.contains("json")
        || lower.contains("valid object")
        || lower.contains("schema");

    // Find the most schema-like JSON object in the text (the largest balanced
    // `{...}` block).
    let candidate = largest_json_block(raw);

    match candidate {
        Some(block) => {
            let (valid, errors) = validate_json(&block);
            SchemaInfo {
                present: true,
                valid,
                kind: "json".into(),
                errors,
            }
        }
        None => SchemaInfo {
            present: false,
            valid: false,
            kind: if asks_json { "json".into() } else { "none".into() },
            errors: if asks_json {
                vec!["Prompt requests JSON but provides no schema/example to anchor the structure.".into()]
            } else {
                vec![]
            },
        },
    }
}

/// 0..=1 schema validity score.
pub fn validity(info: &SchemaInfo) -> f64 {
    if info.present && info.valid {
        1.0
    } else if info.present {
        0.4 // present but malformed → partial credit
    } else if info.kind == "json" {
        0.0 // asked for JSON, gave nothing → worst case
    } else {
        // No structured output requested: treat as N/A but not free — a contract
        // is generally better than none, so cap at a neutral 0.6.
        0.6
    }
}

/// Extract the largest balanced `{...}` substring, ignoring braces in strings.
fn largest_json_block(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut best: Option<(usize, usize)> = None;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end) = match_balanced(bytes, i) {
                let len = end - i;
                if best.map_or(true, |(s, e)| (e - s) < len) {
                    best = Some((i, end));
                }
                i = end;
                continue;
            }
        }
        i += 1;
    }
    best.map(|(s, e)| raw[s..e].to_string())
}

fn match_balanced(bytes: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    let mut i = start;
    while i < bytes.len() {
        let b = bytes[i];
        if in_str {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_str = false;
            }
        } else {
            match b {
                b'"' => in_str = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i + 1);
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    None
}

/// Validate a JSON snippet, tolerating schema placeholders.
///
/// Real prompts contain pseudo-JSON like `{ "score": <number>, "tags": [...] }`.
/// We accept common placeholder tokens (`<...>`, `...`, bare type names) so the
/// schema isn't penalized for being a *template* rather than a literal value.
fn validate_json(block: &str) -> (bool, Vec<String>) {
    let normalized = normalize_placeholders(block);
    match serde_json::from_str::<serde_json::Value>(&normalized) {
        Ok(_) => (true, vec![]),
        Err(e) => (false, vec![format!("Malformed JSON schema: {e}")]),
    }
}

fn normalize_placeholders(block: &str) -> String {
    let mut out = String::with_capacity(block.len());
    let bytes = block.as_bytes();
    let mut i = 0;
    let mut in_str = false;
    let mut escaped = false;
    while i < bytes.len() {
        let b = bytes[i];
        if in_str {
            out.push(b as char);
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        match b {
            b'"' => {
                in_str = true;
                out.push('"');
                i += 1;
            }
            b'<' => {
                // `<number>`, `<string>` placeholder → emit a literal null.
                if let Some(close) = block[i..].find('>') {
                    out.push_str("null");
                    i += close + 1;
                } else {
                    out.push('<');
                    i += 1;
                }
            }
            b'.' if block[i..].starts_with("...") => {
                out.push_str("null");
                i += 3;
            }
            _ => {
                out.push(b as char);
                i += 1;
            }
        }
    }
    // Replace bare type identifiers used as values (": string," → ": null,").
    replace_bare_types(&out)
}

fn replace_bare_types(s: &str) -> String {
    let mut result = s.to_string();
    for t in ["string", "number", "boolean", "integer", "float", "any", "object"] {
        for pat in [
            (format!(": {t},"), ": null,".to_string()),
            (format!(": {t}}}"), ": null}".to_string()),
            (format!(": {t} "), ": null ".to_string()),
            (format!(": {t}\n"), ": null\n".to_string()),
        ] {
            result = result.replace(&pat.0, &pat.1);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_valid_literal_schema() {
        let info = analyze("Return JSON: {\"name\": \"x\", \"score\": 1}");
        assert!(info.present && info.valid);
        assert_eq!(validity(&info), 1.0);
    }

    #[test]
    fn accepts_placeholder_template() {
        let info = analyze("Respond with {\"summary\": <string>, \"score\": <number>, \"tags\": [...]}");
        assert!(info.present, "should detect the block");
        assert!(info.valid, "placeholders should validate: {:?}", info.errors);
    }

    #[test]
    fn accepts_bare_type_template() {
        let info = analyze("Output {\"ok\": boolean, \"count\": number}");
        assert!(info.valid, "bare types should validate: {:?}", info.errors);
    }

    #[test]
    fn json_requested_but_missing() {
        let info = analyze("Please return the result as JSON.");
        assert!(!info.present);
        assert_eq!(info.kind, "json");
        assert_eq!(validity(&info), 0.0);
    }

    #[test]
    fn malformed_gets_partial() {
        let info = analyze("Return {\"a\": 1, \"b\": }");
        assert!(info.present && !info.valid);
        assert_eq!(validity(&info), 0.4);
    }
}
