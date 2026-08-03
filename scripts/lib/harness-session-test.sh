#!/usr/bin/env bash
set -euo pipefail

ROOT="$(mktemp -d)"
export MOSH_APP_DATA_DIR="$ROOT/Mosh"
mkdir -p "$MOSH_APP_DATA_DIR/_harness/owned" "$MOSH_APP_DATA_DIR/_harness/unowned"
mkdir -p "$MOSH_APP_DATA_DIR/_harness/.mosh-reset.KEEP"
printf '%s' 'Mosh isolated harness session v1' > "$MOSH_APP_DATA_DIR/_harness/owned/.mosh-harness-owned-v1"
printf '%s' 'stale' > "$MOSH_APP_DATA_DIR/_harness/owned/stale.txt"
printf '%s' 'owner data' > "$MOSH_APP_DATA_DIR/_harness/unowned/keep.txt"

source "$(cd "$(dirname "$0")" && pwd)/harness-session.sh"

mosh_reset_owned_harness_session "_harness/owned"
test ! -e "$MOSH_APP_DATA_DIR/_harness/owned"
test -d "$MOSH_APP_DATA_DIR/_harness/.mosh-reset.KEEP"
recovery="$(find "$MOSH_APP_DATA_DIR/_harness" -maxdepth 1 -type d -name '.mosh-reset.*' ! -name '.mosh-reset.KEEP' -print -quit)"
test -n "$recovery"
test "$(cat "$recovery/session/stale.txt")" = "stale"
if mosh_reset_owned_harness_session "_harness/unowned"; then
  echo "unowned harness reset unexpectedly succeeded" >&2
  exit 1
fi
test "$(cat "$MOSH_APP_DATA_DIR/_harness/unowned/keep.txt")" = "owner data"
if mosh_reset_owned_harness_session "../outside"; then
  echo "traversal reset unexpectedly succeeded" >&2
  exit 1
fi

echo "harness-session shell tests passed"
