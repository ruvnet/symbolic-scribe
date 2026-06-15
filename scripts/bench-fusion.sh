#!/usr/bin/env bash
# Run the live fusion benchmark with the OpenRouter key sourced from GCP Secret
# Manager — the key is never written to disk or shell history.
#
#   scripts/bench-fusion.sh [-- <extra args forwarded to bench-fusion.mjs>]
#
# Requires: gcloud auth with access to the OPENROUTER_API_KEY secret.
set -euo pipefail

SECRET="${OPENROUTER_SECRET_NAME:-OPENROUTER_API_KEY}"
echo "Fetching ${SECRET} from GCP Secret Manager..."
OPENROUTER_API_KEY="$(gcloud secrets versions access latest --secret="${SECRET}")"
export OPENROUTER_API_KEY

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "${DIR}/scripts/bench-fusion.mjs" "$@"
