//! Witness receipts (`witness.json`, `eval.receipt.json`).
//!
//! Every accepted optimization emits a content-addressed, integrity-signed
//! receipt: the SHA-256 of the canonical artifact bundle plus an HMAC "witness"
//! signature. This makes a winning prompt *auditable* — you can prove which
//! exact text scored what, and detect tampering. Swap the HMAC key for an
//! asymmetric RVF/witness-chain signature in production without changing shape.

use crate::model::Score;
use crate::sha256;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Receipt {
    pub version: String,
    /// SHA-256 of the original prompt text.
    pub source_hash: String,
    /// SHA-256 of the optimized prompt text.
    pub artifact_hash: String,
    /// SHA-256 over the canonical (hashes + scores + verdict) record.
    pub bundle_hash: String,
    /// HMAC-SHA-256(witness_key, bundle_hash) — the signature.
    pub witness: String,
    pub baseline_score: Score,
    pub optimized_score: Score,
    pub token_reduction: f64,
    pub objectives_improved: usize,
    pub accepted: bool,
    /// ISO-8601 timestamp supplied by the host (wasm has no clock).
    pub issued_at: String,
}

/// Build a signed receipt. `witness_key` is the signing secret; the host may
/// pass an empty key for an unsigned (hash-only) receipt.
#[allow(clippy::too_many_arguments)]
pub fn build(
    original: &str,
    optimized: &str,
    baseline: &Score,
    optimized_score: &Score,
    token_reduction: f64,
    objectives_improved: usize,
    accepted: bool,
    issued_at: &str,
    witness_key: &[u8],
) -> Receipt {
    let source_hash = sha256::hex(&sha256::digest(original.as_bytes()));
    let artifact_hash = sha256::hex(&sha256::digest(optimized.as_bytes()));

    // Canonical record string — order is fixed so the hash is reproducible.
    let canonical = format!(
        "v1|src:{source_hash}|art:{artifact_hash}|base:{:.6}|opt:{:.6}|red:{:.6}|imp:{objectives_improved}|acc:{accepted}|ts:{issued_at}",
        baseline.composite, optimized_score.composite, token_reduction,
    );
    let bundle_hash = sha256::hex(&sha256::digest(canonical.as_bytes()));

    let witness = if witness_key.is_empty() {
        String::new()
    } else {
        sha256::hmac_hex(witness_key, canonical.as_bytes())
    };

    Receipt {
        version: "1.0".into(),
        source_hash,
        artifact_hash,
        bundle_hash,
        witness,
        baseline_score: baseline.clone(),
        optimized_score: optimized_score.clone(),
        token_reduction,
        objectives_improved,
        accepted,
        issued_at: issued_at.to_string(),
    }
}

/// Verify a receipt's witness signature against the same key.
pub fn verify(receipt: &Receipt, witness_key: &[u8]) -> bool {
    if receipt.witness.is_empty() || witness_key.is_empty() {
        return false;
    }
    let canonical = format!(
        "v1|src:{}|art:{}|base:{:.6}|opt:{:.6}|red:{:.6}|imp:{}|acc:{}|ts:{}",
        receipt.source_hash,
        receipt.artifact_hash,
        receipt.baseline_score.composite,
        receipt.optimized_score.composite,
        receipt.token_reduction,
        receipt.objectives_improved,
        receipt.accepted,
        receipt.issued_at,
    );
    sha256::hmac_hex(witness_key, canonical.as_bytes()) == receipt.witness
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(c: f64) -> Score {
        Score { composite: c, ..Default::default() }
    }

    #[test]
    fn deterministic_hashes() {
        let r1 = build("a", "b", &s(0.5), &s(0.6), 0.25, 3, true, "2026-01-01T00:00:00Z", b"key");
        let r2 = build("a", "b", &s(0.5), &s(0.6), 0.25, 3, true, "2026-01-01T00:00:00Z", b"key");
        assert_eq!(r1.bundle_hash, r2.bundle_hash);
        assert_eq!(r1.witness, r2.witness);
    }

    #[test]
    fn witness_verifies_and_detects_tamper() {
        let r = build("orig", "opt", &s(0.4), &s(0.7), 0.3, 4, true, "2026-06-14T00:00:00Z", b"secret");
        assert!(verify(&r, b"secret"));
        assert!(!verify(&r, b"wrong-key"));

        let mut tampered = r.clone();
        tampered.optimized_score.composite = 0.99;
        assert!(!verify(&tampered, b"secret"));
    }

    #[test]
    fn empty_key_is_unsigned() {
        let r = build("a", "b", &s(0.5), &s(0.6), 0.1, 1, true, "t", b"");
        assert!(r.witness.is_empty());
        assert!(!verify(&r, b""));
    }
}
