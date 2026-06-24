#!/usr/bin/env bash
# lib.sh — shared helpers for the Mosh autonomous deferred-work loop.
#
# Sourced by every scripts/auto-loop/*.sh. Provides repo-root resolution, the
# selftest binary resolver, stray-service / port cleanup (the documented
# port-8770 orphan trap), unique session/port allocation, and ledger append.
#
# NOTHING here mutates git or the product. These are read/measure utilities; the
# only writes are to docs/auto-loop/ (the ledger/state) and to verify-artifacts/.
set -euo pipefail

# Repo root = two levels up from scripts/auto-loop/. Works in any worktree.
AL_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AL_ROOT_DEFAULT="$(cd "$AL_LIB_DIR/../.." && pwd)"
# Callers may override ROOT to point at a specific worktree.
AL_ROOT="${AL_ROOT:-$AL_ROOT_DEFAULT}"

AL_DOCS_DIR="$AL_ROOT/docs/auto-loop"
AL_LEDGER="$AL_DOCS_DIR/LEDGER.md"
AL_BACKLOG="$AL_DOCS_DIR/BACKLOG.md"
AL_STOP="$AL_DOCS_DIR/STOP"
AL_PAUSE="$AL_DOCS_DIR/PAUSE"

# Machine-local home for the shared build cache + config. Lives OUTSIDE any git
# worktree so it survives worktree churn and is shared by every parallel build.
AL_HOME="${MOSH_AUTOLOOP_HOME:-$HOME/.mosh-auto-loop}"
AL_ENV="$AL_HOME/auto-loop.env"          # written by seed-cache.sh, sourced by gate/new-worktree

# The primary (main) git worktree — where the seeded dep cache + tracktion source live.
al_main_worktree() {
  git -C "$AL_ROOT" worktree list --porcelain 2>/dev/null \
    | awk '/^worktree /{print $2; exit}'
}

# Load the seeded cache config (AL_CPM_CACHE, AL_TRACTION_SRC) if present.
al_load_cache_env() { [ -f "$AL_ENV" ] && . "$AL_ENV" || true; }

# ── logging (to stderr so stdout stays clean for JSON payloads) ──────────────────
al_log()  { printf '[auto-loop] %s\n' "$*" >&2; }
al_warn() { printf '[auto-loop][warn] %s\n' "$*" >&2; }
al_die()  { printf '[auto-loop][die] %s\n' "$*" >&2; exit 1; }

# ── kill switch ─────────────────────────────────────────────────────────────────
# Returns 0 (true) if the loop must stop. Checked at every iteration boundary AND
# immediately before any merge. A human drops the STOP file to halt instantly.
al_stop_requested() { [ -e "$AL_STOP" ]; }
al_pause_requested() { [ -e "$AL_PAUSE" ]; }

# ── binary resolution ───────────────────────────────────────────────────────────
# resolve_selftest_bin <worktree-or-root> [release|debug]
# Echoes the path to the built Mosh binary for that tree, or empty if not built.
# Mirrors verify.py's known artefact paths (Release default for the gate).
resolve_selftest_bin() {
  local tree="${1:-$AL_ROOT}" flavor="${2:-release}" p
  if [ "$flavor" = "release" ]; then
    p="$tree/build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh"
  else
    p="$tree/build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh"
  fi
  [ -x "$p" ] && printf '%s\n' "$p"
}

# resolve_app_bundle <worktree> [release|debug] → the .app dir (for swappability gate)
resolve_app_bundle() {
  local tree="${1:-$AL_ROOT}" flavor="${2:-release}"
  local bin; bin="$(resolve_selftest_bin "$tree" "$flavor")" || true
  [ -n "$bin" ] && printf '%s\n' "$(cd "$(dirname "$bin")/../.." && pwd)"
}

# ── service / port cleanup (the orphaned-port-8770 trap) ─────────────────────────
# Kill any stray Mosh generative service / relay so a gate run never collides with
# an orphan from a prior aborted run. Safe: only targets THIS repo's processes by
# command-line signature. Optionally also frees a specific port's listener.
kill_stray_services() {
  local port="${1:-}"
  pkill -f 'service/server\.py'      2>/dev/null || true
  pkill -f 'service/run\.sh'         2>/dev/null || true
  pkill -f 'relay/server\.py'        2>/dev/null || true
  if [ -n "$port" ]; then
    local pids; pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  fi
}

# ── unique session / port allocation ────────────────────────────────────────────
# A unique, filesystem-safe session leaf for MOSH_SELFTEST_SESSION so parallel
# worktrees never clobber ~/Library/Mosh/session-selftest (the PR #66 fix).
unique_session() {
  local slug="${1:-al}"
  slug="$(printf '%s' "$slug" | tr -c 'A-Za-z0-9._-' '-')"
  printf 'session-autoloop-%s-%s\n' "$slug" "$$"
}

# A free TCP port in the 8800–8899 band (away from the default 8770 the GUI uses).
unique_port() {
  local lo="${1:-8800}" hi="${2:-8899}" p
  for p in $(seq "$lo" "$hi"); do
    if ! lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then printf '%s\n' "$p"; return 0; fi
  done
  al_die "no free port in $lo-$hi"
}

# ── selftest summary parsing ─────────────────────────────────────────────────────
# Parse "<N> checks passed, <F> failed" (SelfTest.cpp). Echoes "N F" or "-1 -1".
parse_selftest_tally() {
  local logfile="$1" line
  line="$(grep -Eo '[0-9]+ checks passed, [0-9]+ failed' "$logfile" | tail -1 || true)"
  if [ -z "$line" ]; then printf -- '-1 -1\n'; return; fi
  printf '%s %s\n' "$(printf '%s' "$line" | grep -Eo '^[0-9]+')" \
                   "$(printf '%s' "$line" | grep -Eo '[0-9]+ failed' | grep -Eo '^[0-9]+')"
}

# `grep -c` prints "0" but EXITS 1 on zero matches; a `|| echo 0` would then append a
# SECOND "0" → "0\n0", which breaks numeric comparisons downstream. Capture the count
# (already "0" on no match) and ignore the exit code instead.
count_juce_asserts() { local c; c="$(grep -c 'JUCE Assertion' "$1" 2>/dev/null)"; printf '%s\n' "${c:-0}"; }

# ── ledger ───────────────────────────────────────────────────────────────────────
# Append a raw markdown block to the ledger (creates the dir if needed). The caller
# composes the block; we only append so the ledger is strictly append-only.
ledger_append() {
  mkdir -p "$AL_DOCS_DIR"
  printf '%s\n' "$1" >> "$AL_LEDGER"
}

# A timestamp for ledger entries. Date.now() is banned inside Workflow scripts but
# this is a plain shell util, so `date` is fine here.
al_now() { date '+%Y-%m-%d %H:%M:%S %Z'; }
