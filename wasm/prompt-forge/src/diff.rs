//! Line-level diff (`prompt.diff.md`) via a classic LCS.
//!
//! Small inputs (prompts, not source trees) make an O(n·m) LCS perfectly fine
//! and it yields the cleanest minimal edit script for human review.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct DiffOp {
    /// "eq" | "del" | "ins"
    pub op: String,
    pub text: String,
}

pub fn diff_lines(a: &str, b: &str) -> Vec<DiffOp> {
    let a: Vec<&str> = a.lines().collect();
    let b: Vec<&str> = b.lines().collect();
    let n = a.len();
    let m = b.len();

    // LCS length table.
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if a[i] == b[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }

    // Backtrack into an edit script.
    let mut ops = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if a[i] == b[j] {
            ops.push(op("eq", a[i]));
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            ops.push(op("del", a[i]));
            i += 1;
        } else {
            ops.push(op("ins", b[j]));
            j += 1;
        }
    }
    while i < n {
        ops.push(op("del", a[i]));
        i += 1;
    }
    while j < m {
        ops.push(op("ins", b[j]));
        j += 1;
    }
    ops
}

/// Render a diff as a unified-ish Markdown block.
pub fn to_markdown(ops: &[DiffOp]) -> String {
    let mut s = String::from("```diff\n");
    for o in ops {
        let prefix = match o.op.as_str() {
            "ins" => "+ ",
            "del" => "- ",
            _ => "  ",
        };
        s.push_str(prefix);
        s.push_str(&o.text);
        s.push('\n');
    }
    s.push_str("```\n");
    s
}

fn op(kind: &str, text: &str) -> DiffOp {
    DiffOp {
        op: kind.to_string(),
        text: text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_is_all_eq() {
        let ops = diff_lines("a\nb", "a\nb");
        assert!(ops.iter().all(|o| o.op == "eq"));
    }

    #[test]
    fn detects_insert_and_delete() {
        let ops = diff_lines("a\nb\nc", "a\nx\nc");
        assert!(ops.iter().any(|o| o.op == "del" && o.text == "b"));
        assert!(ops.iter().any(|o| o.op == "ins" && o.text == "x"));
        assert_eq!(ops.iter().filter(|o| o.op == "eq").count(), 2);
    }

    #[test]
    fn markdown_renders() {
        let md = to_markdown(&diff_lines("old", "new"));
        assert!(md.contains("- old"));
        assert!(md.contains("+ new"));
    }
}
