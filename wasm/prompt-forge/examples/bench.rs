//! Latency benchmark for the prompt compiler hot paths.
//!
//! Run: `cargo run --release --example bench`
//!
//! Reports nanoseconds/op and ops/sec for `count_tokens`, `analyze`, and
//! `optimize` on representative prompts. These are the operations the UI calls
//! on every keystroke (debounced), so they must stay in the microsecond range.

use std::time::Instant;

// Pull the crate's public API in via the rlib.
use prompt_forge::{analyze, compress, count_tokens, optimize};

const SMALL: &str = "Summarize the article in three bullets. Return JSON.";

const MEDIUM: &str = "You are a senior security analyst. I would like you to please \
analyze the following incident report and summarize the key attack vectors. \
Please make sure to be concise. You must cite all sources. Do not invent data. \
Return a valid JSON object with fields summary, vectors, and severity.";

fn large() -> String {
    let para = "The system must process the input carefully and produce a detailed \
yet appropriately concise analysis. Make sure to consider all relevant factors. \
Do not fabricate citations. Always return well-formed JSON matching the schema. ";
    para.repeat(40)
}

fn bench<F: Fn()>(name: &str, iters: u32, f: F) {
    // Warmup.
    for _ in 0..(iters / 10).max(1) {
        f();
    }
    let start = Instant::now();
    for _ in 0..iters {
        f();
    }
    let elapsed = start.elapsed();
    let per_op = elapsed.as_nanos() as f64 / iters as f64;
    let ops_per_sec = 1e9 / per_op;
    println!(
        "{name:<28} {per_op:>12.1} ns/op   {ops_per_sec:>14.0} ops/sec",
    );
}

fn main() {
    let large = large();
    println!("prompt-forge latency benchmark (native, --release)\n");
    println!(
        "{:<28} {:>12} bytes  {:>6} tokens(est)",
        "input", "size", "n"
    );
    for (name, text) in [("small", SMALL), ("medium", MEDIUM), ("large", large.as_str())] {
        println!("{name:<28} {:>12} {:>13}", text.len(), count_tokens(text));
    }
    println!();

    let opts = r#"{"witness_key":"bench","issued_at":"2026-06-14T00:00:00Z"}"#;

    bench("count_tokens(medium)", 200_000, || {
        std::hint::black_box(count_tokens(MEDIUM));
    });
    bench("count_tokens(large)", 50_000, || {
        std::hint::black_box(count_tokens(&large));
    });
    bench("analyze(medium)", 50_000, || {
        std::hint::black_box(analyze(MEDIUM, opts));
    });
    bench("analyze(large)", 10_000, || {
        std::hint::black_box(analyze(&large, opts));
    });
    bench("compress(medium)", 50_000, || {
        std::hint::black_box(compress(MEDIUM));
    });
    bench("optimize(medium)", 20_000, || {
        std::hint::black_box(optimize(MEDIUM, opts));
    });
    bench("optimize(large)", 5_000, || {
        std::hint::black_box(optimize(&large, opts));
    });

    println!("\nDone. (UI debounces analyze() to ~120ms; sub-ms latency leaves ample headroom.)");
}
