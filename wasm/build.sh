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

# Post-optimize with wasm-opt (binaryen) if available — shrinks size and speeds
# execution. Optional: the build still succeeds without it.
WASM_OUT="$OUT_DIR/prompt_forge_bg.wasm"
if command -v wasm-opt >/dev/null 2>&1; then
  BEFORE=$(wc -c < "$WASM_OUT")
  echo "▶ Optimizing with wasm-opt -O3…"
  wasm-opt -O3 --enable-bulk-memory "$WASM_OUT" -o "$WASM_OUT.opt"
  mv "$WASM_OUT.opt" "$WASM_OUT"
  AFTER=$(wc -c < "$WASM_OUT")
  printf "  %d → %d bytes (%d%% smaller)\n" "$BEFORE" "$AFTER" "$(( (BEFORE - AFTER) * 100 / BEFORE ))"
else
  echo "▶ wasm-opt not found — skipping (install binaryen for a smaller artifact)."
fi

# Report the final artifact size.
SIZE=$(wc -c < "$WASM_OUT")
printf "✓ Done. wasm artifact: %s (%d bytes, %d KB)\n" \
  "$WASM_OUT" "$SIZE" "$((SIZE / 1024))"
