#!/usr/bin/env bash
# Build the prompt-forge Rust crate to WebAssembly and emit JS bindings into
# src/wasm/pkg so Vite can import them directly.
#
# Requirements (already provisioned in CI / dev container):
#   - rustup target add wasm32-unknown-unknown
#   - cargo install wasm-bindgen-cli --version 0.2.100
#
# Usage: wasm/build.sh
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/prompt-forge" && pwd)"
REPO_ROOT="$(cd "$CRATE_DIR/../.." && pwd)"
OUT_DIR="$REPO_ROOT/src/wasm/pkg"
TARGET="wasm32-unknown-unknown"
WASM="$CRATE_DIR/target/$TARGET/release/prompt_forge.wasm"

echo "▶ Building prompt-forge ($TARGET, release)…"
( cd "$CRATE_DIR" && cargo build --release --target "$TARGET" )

echo "▶ Generating JS bindings with wasm-bindgen → $OUT_DIR"
mkdir -p "$OUT_DIR"
wasm-bindgen "$WASM" \
  --out-dir "$OUT_DIR" \
  --target web \
  --omit-default-module-path

# Report the final artifact size.
SIZE=$(wc -c < "$OUT_DIR/prompt_forge_bg.wasm")
printf "✓ Done. wasm artifact: %s (%d bytes, %d KB)\n" \
  "$OUT_DIR/prompt_forge_bg.wasm" "$SIZE" "$((SIZE / 1024))"
