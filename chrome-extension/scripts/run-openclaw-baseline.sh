#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
URL="${1:-https://chatgpt.com/}"
PROFILE_DIR="${OPENCLAW_PROFILE_DIR:-$HOME/.aichat-notes-perf-profile}"
OUTPUT_DIR="${OPENCLAW_OUTPUT_DIR:-$ROOT_DIR/../output/playwright/perf}"

echo "[baseline] url=$URL"
echo "[baseline] profile=$PROFILE_DIR"
echo "[baseline] output=$OUTPUT_DIR"

for RUN_ID in 1 2 3; do
  echo "[baseline] OFF run $RUN_ID"
  node "$ROOT_DIR/scripts/openclaw-baseline.mjs" \
    --mode off \
    --run-id "$RUN_ID" \
    --url "$URL" \
    --profile-dir "$PROFILE_DIR" \
    --output-dir "$OUTPUT_DIR"
done

for RUN_ID in 4 5 6; do
  echo "[baseline] ON run $RUN_ID"
  node "$ROOT_DIR/scripts/openclaw-baseline.mjs" \
    --mode on \
    --run-id "$RUN_ID" \
    --url "$URL" \
    --profile-dir "$PROFILE_DIR" \
    --output-dir "$OUTPUT_DIR"
done

echo "[baseline] complete"
