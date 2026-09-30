#!/usr/bin/env bash
set -euo pipefail

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
export MOSH_APP_DATA_DIR="$ROOT/Mosh"
HARNESS="$MOSH_APP_DATA_DIR/_harness"
MARKER='Mosh isolated harness session v1'
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

# ── removal: what a passing gate does with the sessions it generated ─────────────
make_owned() { mkdir -p "$HARNESS/$1"; printf '%s' "$MARKER" > "$HARNESS/$1/.mosh-harness-owned-v1"; }
quarantines() { find "$HARNESS" -mindepth 1 -maxdepth 1 -name '.mosh-reset*' | wc -l | tr -d ' '; }
removal_rc() { local rc=0; mosh_remove_owned_harness_session "$1" 2>/dev/null || rc=$?; printf '%s' "$rc"; }
expect_refused() {
  local rc; rc="$(removal_rc "$1")"
  [ "$rc" = 2 ] || { echo "$2: expected a refusal (2), got $rc" >&2; exit 1; }
}
mkdir -p "$ROOT/outside"
printf '%s' 'outside data' > "$ROOT/outside/keep.txt"

# A selftest-shaped session goes entirely, and no quarantine is left in its place. The
# empty training/adapters dir every selftest creates is not evidence; a symlink inside
# the session is removed without touching what it points at.
make_owned gate-r1
mkdir -p "$HARNESS/gate-r1/training/adapters" "$HARNESS/gate-r1/session-mp-commit-identity/exports"
printf '%s' 'take' > "$HARNESS/gate-r1/session-mp-commit-identity/exports/take.wav"
ln -s "$ROOT/outside" "$HARNESS/gate-r1/linked-dir"
ln -s "$ROOT/outside/keep.txt" "$HARNESS/gate-r1/linked-file"
before="$(quarantines)"
mosh_remove_owned_harness_session "_harness/gate-r1"
test ! -e "$HARNESS/gate-r1"
test "$(quarantines)" = "$before"
test "$(cat "$ROOT/outside/keep.txt")" = "outside data"

# A session that is already gone is not an error.
test "$(removal_rc "_harness/never-created")" = 0

# Model, adapter, checkpoint or evaluation evidence keeps the session where it is.
make_owned style-train
mkdir -p "$HARNESS/style-train/training/adapters"
printf '%s' 'weights' > "$HARNESS/style-train/training/adapters/style.safetensors"
test "$(removal_rc "_harness/style-train")" = 1
test "$(cat "$HARNESS/style-train/training/adapters/style.safetensors")" = "weights"
make_owned eval-r1
test "$(removal_rc "_harness/eval-r1")" = 1
test -f "$HARNESS/eval-r1/.mosh-harness-owned-v1"
test "$(quarantines)" = "$before"

# Refusals leave everything in place.
expect_refused "_harness/unowned" "an unmarked session"
test "$(cat "$HARNESS/unowned/keep.txt")" = "owner data"
make_owned newline-marker
printf '%s\n' "$MARKER" > "$HARNESS/newline-marker/.mosh-harness-owned-v1"
expect_refused "_harness/newline-marker" "a marker with extra bytes"
test -d "$HARNESS/newline-marker"
mkdir -p "$HARNESS/linked-marker"
printf '%s' "$MARKER" > "$ROOT/outside/marker"
ln -s "$ROOT/outside/marker" "$HARNESS/linked-marker/.mosh-harness-owned-v1"
expect_refused "_harness/linked-marker" "a symlinked marker"
test -d "$HARNESS/linked-marker"
mkdir -p "$ROOT/outside-owned"
printf '%s' "$MARKER" > "$ROOT/outside-owned/.mosh-harness-owned-v1"
ln -s "$ROOT/outside-owned" "$HARNESS/linked-session"
expect_refused "_harness/linked-session" "a symlinked session"
test -f "$ROOT/outside-owned/.mosh-harness-owned-v1"
test -L "$HARNESS/linked-session"
printf '%s' 'file' > "$HARNESS/plain-file"
expect_refused "_harness/plain-file" "a regular file"
test -f "$HARNESS/plain-file"
make_owned parent/child
expect_refused "_harness/parent/child" "a session below the _harness top level"
test -f "$HARNESS/parent/child/.mosh-harness-owned-v1"
expect_refused "_harness/.mosh-reset.KEEP" "a hidden quarantine"
test -d "$HARNESS/.mosh-reset.KEEP"
make_owned .hidden-owned
expect_refused "_harness/.hidden-owned" "a hidden session, even an owned one"
test -f "$HARNESS/.hidden-owned/.mosh-harness-owned-v1"
expect_refused "_harness/../outside" "a traversal"
expect_refused "_harness/" "the _harness root"
expect_refused "outside" "a path outside _harness"
test "$(cat "$ROOT/outside/keep.txt")" = "outside data"

# A symlinked _harness root is refused even when the session behind it is owned.
LINKED_APP="$ROOT/linked-app"
mkdir -p "$LINKED_APP" "$ROOT/real-harness/gate-r1"
printf '%s' "$MARKER" > "$ROOT/real-harness/gate-r1/.mosh-harness-owned-v1"
ln -s "$ROOT/real-harness" "$LINKED_APP/_harness"
rc=0; MOSH_APP_DATA_DIR="$LINKED_APP" mosh_remove_owned_harness_session "_harness/gate-r1" 2>/dev/null || rc=$?
test "$rc" = 2
test -f "$ROOT/real-harness/gate-r1/.mosh-harness-owned-v1"

# ── the run-level policy both gates apply ─────────────────────────────────────────
# A run that did not pass keeps every session it generated: they are its diagnostics.
make_owned failed-r1
make_owned failed-r2
out="$(mosh_reclaim_harness_sessions false "_harness/failed-r1" "_harness/failed-r2")"
test -d "$HARNESS/failed-r1" && test -d "$HARNESS/failed-r2"
test "$(printf '%s\n' "$out" | grep -c '^kept _harness/failed-r[12]: ')" = 2

# A passing run removes exactly the sessions it names and reports each one.
make_owned passed-r1
make_owned passed-r2
make_owned sibling-r1
out="$(mosh_reclaim_harness_sessions true "_harness/passed-r1" "_harness/passed-r2" \
  "_harness/style-train" "_harness/unowned" "_harness/never-created")"
test ! -e "$HARNESS/passed-r1" && test ! -e "$HARNESS/passed-r2"
test -d "$HARNESS/sibling-r1"
test "$(cat "$HARNESS/style-train/training/adapters/style.safetensors")" = "weights"
test "$(cat "$HARNESS/unowned/keep.txt")" = "owner data"
printf '%s\n' "$out" | grep -qx 'removed _harness/passed-r1'
printf '%s\n' "$out" | grep -qx 'removed _harness/passed-r2'
printf '%s\n' "$out" | grep -q '^kept _harness/style-train: '
printf '%s\n' "$out" | grep -q '^kept _harness/unowned: '
printf '%s\n' "$out" | grep -qx 'absent _harness/never-created'
test "$(quarantines)" = "$before"

echo "harness-session shell tests passed"
