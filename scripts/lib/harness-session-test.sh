#!/usr/bin/env bash
set -euo pipefail

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
export MOSH_APP_DATA_DIR="$ROOT/Mosh"
HARNESS="$MOSH_APP_DATA_DIR/_harness"
MARKER='Mosh isolated harness session v1'
mkdir -p "$HARNESS/owned/exports" "$HARNESS/unowned" "$HARNESS/.mosh-reset.KEEP" "$ROOT/outside"
printf '%s' "$MARKER" > "$HARNESS/owned/.mosh-harness-owned-v1"
printf '%s' 'stale' > "$HARNESS/owned/stale.txt"
printf '%s' 'take' > "$HARNESS/owned/exports/take.wav"
printf '%s' 'owner data' > "$HARNESS/unowned/keep.txt"
printf '%s' 'outside data' > "$ROOT/outside/keep.txt"
ln -s "$ROOT/outside" "$HARNESS/owned/linked-dir"
ln -s "$ROOT/outside/keep.txt" "$HARNESS/owned/linked-file"

source "$(cd "$(dirname "$0")" && pwd)/harness-session.sh"

# The reset frees the path and reclaims only the quarantine it created.
mosh_reset_owned_harness_session "_harness/owned"
test ! -e "$HARNESS/owned"
test -d "$HARNESS/.mosh-reset.KEEP"
test "$(find "$HARNESS" -mindepth 1 -maxdepth 1 -name '.mosh-reset*' | wc -l | tr -d ' ')" = 1
test "$(cat "$ROOT/outside/keep.txt")" = "outside data"

# A session holding model or adapter files keeps its quarantine.
mkdir -p "$HARNESS/style-train/training/adapters"
printf '%s' "$MARKER" > "$HARNESS/style-train/.mosh-harness-owned-v1"
printf '%s' 'weights' > "$HARNESS/style-train/training/adapters/style.safetensors"
mosh_reset_owned_harness_session "_harness/style-train"
test ! -e "$HARNESS/style-train"
recovery="$(find "$HARNESS" -mindepth 1 -maxdepth 1 -name '.mosh-reset.*' ! -name '.mosh-reset.KEEP' -print -quit)"
test -n "$recovery"
test "$(cat "$recovery/session/training/adapters/style.safetensors")" = "weights"

if mosh_reset_owned_harness_session "_harness/unowned"; then
  echo "unowned harness reset unexpectedly succeeded" >&2
  exit 1
fi
test "$(cat "$HARNESS/unowned/keep.txt")" = "owner data"
if mosh_reset_owned_harness_session "../outside"; then
  echo "traversal reset unexpectedly succeeded" >&2
  exit 1
fi

echo "harness-session shell tests passed"
