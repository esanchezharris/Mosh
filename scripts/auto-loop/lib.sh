#!/usr/bin/env bash
# lib.sh — shared helpers for the Mosh autonomous deferred-work loop.
#
# Sourced by every scripts/auto-loop/*.sh. Provides repo-root resolution, the
# selftest binary resolver, service port RESERVATION + owned-only teardown (see the
# ownership section — a gate run may only kill services it owns, because several
# worktrees gate concurrently on one machine), unique session allocation, and ledger
# append. Unit-tested by port-ownership-selftest.sh and deps-freshness-selftest.sh.
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
# AL_LEDGER + AL_BACKLOG_JSONL accept an environment override so a SIBLING loop (the
# First-Stranger "stranger-loop") can keep its own audit trail + backlog while sharing
# the same scripts, STOP switch, and merge-queue lock. Unset ⇒ the classic auto-loop
# paths, byte-identical to before.
AL_LEDGER="${AL_LEDGER:-$AL_DOCS_DIR/LEDGER.md}"
AL_BACKLOG="$AL_DOCS_DIR/BACKLOG.md"                 # human-readable companion (classic)
AL_BACKLOG_JSONL="${AL_BACKLOG_JSONL:-$AL_DOCS_DIR/backlog.jsonl}"   # machine source of truth
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

# ── service port + process OWNERSHIP ─────────────────────────────────────────────
# Several agent worktrees gate concurrently on this machine, so a gate run may only ever
# kill a service it OWNS. Ownership has exactly one definition here: a port this run holds
# a reservation for, occupied by a process that identifies as a Mosh service. Two rules
# that used to be violated, both of which cost real gate runs:
#
#   NOT ownership — a command-line pattern. kill_stray_services() used to open with three
#   machine-wide `pkill -f` calls (service/server.py, service/run.sh, relay/server.py).
#   Two of them matched NOTHING: service/run.sh does `cd "$(dirname "$0")"` then
#   `exec "$PY" server.py`, so the live argv is "<python> server.py" with no path in it —
#   verified against a service spawned exactly as GenerativeJobManager.cpp spawns one.
#   So the intended self-cleanup never happened (orphaned services accumulate for days),
#   while the one pattern that DID match — relay/server.py — could only ever hit someone
#   else's, since a gate never starts a relay.
#
#   NOT ownership — "nothing is listening there yet". unique_port() used to return the
#   first port in the band with no LISTENER. The generative service does not bind until
#   the selftest reaches its first generative check, so the window between choosing a port
#   and occupying it is seconds to minutes, and two concurrent worktrees both saw it free
#   (observed: three sequential runs in one worktree all chose 8800). The teardown's
#   `lsof -ti tcp:$port | kill -9` then killed the other worktree's live service mid-run —
#   which surfaces as a burst of failed checks confined to the generative sections of an
#   otherwise-passing selftest. `lsof -ti tcp:P` without -sTCP:LISTEN also matches CLIENTS
#   connected to that port, so it could even kill the Mosh binary under test.
#
# A reservation is an atomically-created lock dir stamped with the owning shell's pid.
# `$$` is the shell's pid even inside `$( )` (bash does not change it in a command
# substitution), so `PORT="$(unique_port)"` records the CALLER as owner and the filesystem
# stays the single source of truth — no shell state to lose across a subshell.
AL_PORT_DIR="$AL_HOME/ports"
# Blocks, not single ports: service/server.py's _bind_with_fallback() walks up to 10 ports
# when its requested one is taken, so a drifting service must stay inside ports we own or
# it lands on a rival's — and our teardown would then miss it (orphan) or hit them (bug).
AL_PORT_SPAN="${AL_PORT_SPAN:-10}"
AL_PORT_LO="${AL_PORT_LO:-8800}"     # away from 8770 (GUI default) and 8900+ (installed-app-gate)
AL_PORT_HI="${AL_PORT_HI:-8899}"

# Is `pid` a live process that identifies as a Mosh generative/relay service? Mirrors the
# native reaper's identity check (GenerativeJobManager.cpp's isLiveMoshService), so we
# never -9 an unrelated process that merely holds a port in our band.
al_is_mosh_service() {
  [ -n "${1:-}" ] || return 1
  ps -p "$1" -o command= 2>/dev/null | grep -q 'server\.py'
}

# Do we hold the reservation for this port?
al_owns_port() {
  [ "$(cat "$AL_PORT_DIR/${1}.lock/owner" 2>/dev/null || true)" = "$$" ]
}

# Claim one port. Atomic via mkdir. A lock whose owner process is gone is stale (a crashed
# gate) and is reclaimed, so a dead run can never burn a block out of the band forever.
al_claim_port() {
  local p="$1" d="$AL_PORT_DIR/${p}.lock" owner
  mkdir -p "$AL_PORT_DIR" 2>/dev/null || true
  if mkdir "$d" 2>/dev/null; then printf '%s\n' "$$" > "$d/owner" 2>/dev/null; return 0; fi
  owner="$(cat "$d/owner" 2>/dev/null || true)"
  # A LIVE owner: hands off, this block belongs to another run.
  [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null && return 1
  # Stale. Two reclaimers can race here; both write, then both re-read, so at most one
  # sees its own pid and wins. The loser just tries the next block.
  printf '%s\n' "$$" > "$d/owner" 2>/dev/null || return 1
  al_owns_port "$p"
}

# Kill the LISTENER on a port we own, if it is one of ours. -sTCP:LISTEN matters: without
# it lsof also returns every client connected to that port.
al_kill_owned_listener() {
  local p="$1" pid
  al_owns_port "$p" || return 0
  for pid in $(lsof -ti tcp:"$p" -sTCP:LISTEN 2>/dev/null || true); do
    if al_is_mosh_service "$pid"; then kill -9 "$pid" 2>/dev/null || true
    else al_warn "port $p: listener pid $pid is not a Mosh service — left alone"; fi
  done
}

# Release the block based at $1 (killing any of our services still on it).
al_release_port() {
  local base="${1:-}" p
  [ -n "$base" ] || return 0
  for p in $(seq "$base" $((base + AL_PORT_SPAN - 1))); do
    al_owns_port "$p" || continue
    al_kill_owned_listener "$p"
    rm -rf "$AL_PORT_DIR/${p}.lock" 2>/dev/null || true
  done
}

# Release EVERY port this shell holds. For the gate's EXIT trap: whatever the run leaves
# behind is ours by definition, and nothing else is touched.
al_release_all_ports() {
  local d p
  [ -d "$AL_PORT_DIR" ] || return 0
  for d in "$AL_PORT_DIR"/*.lock; do
    [ -d "$d" ] || continue
    p="$(basename "$d" .lock)"
    al_owns_port "$p" || continue
    al_kill_owned_listener "$p"
    rm -rf "$d" 2>/dev/null || true
  done
}

# Kill only the services THIS run owns. With a port: the block based there (so a service
# that drifted under _bind_with_fallback is still covered). Without: everything we hold.
# A port we do not own is left strictly alone — that is the whole point.
kill_stray_services() {
  local port="${1:-}" p
  if [ -z "$port" ]; then
    [ -d "$AL_PORT_DIR" ] || return 0
    for p in "$AL_PORT_DIR"/*.lock; do
      [ -d "$p" ] || continue
      al_kill_owned_listener "$(basename "$p" .lock)"
    done
    return 0
  fi
  if ! al_owns_port "$port"; then
    al_warn "kill_stray_services: port $port is not reserved by this run — refusing to touch it"
    return 0
  fi
  for p in $(seq "$port" $((port + AL_PORT_SPAN - 1))); do al_kill_owned_listener "$p"; done
}

# ── unique session / port allocation ────────────────────────────────────────────
# A unique, filesystem-safe session leaf for MOSH_SELFTEST_SESSION so parallel
# worktrees never clobber ~/Library/Mosh/session-selftest (the PR #66 fix).
#
# NESTED under _harness/ on purpose. These leaves are never reaped: the 2026-07-26
# consolidation found ~4,525 of the 4,592 top-level entries in ~/Library/Mosh were
# harness sessions, still accumulating at ~35/day, with the real app data (session/,
# loras/, venvs/, the git object store) buried among them. That made every cleanup a
# hazard — `session*` also matches the owner's hand-made session-backup-* dirs, and
# `lora*` also matches the real 10 GB adapter rack.
#
# The engine accepts explicit sessions only below `_harness`. It can create and mark
# an absent leaf; an existing leaf is accepted only when it already has the exact
# marker. Reset atomically relocates marker-owned data into a recoverable quarantine.
# Reserved, traversal, symlinked, empty-unowned, and populated-unowned requests fail
# over to a unique safety session without touching owner data.
unique_session() {
  local slug="${1:-al}"
  slug="$(printf '%s' "$slug" | tr -c 'A-Za-z0-9._-' '-')"
  printf '_harness/session-autoloop-%s-%s\n' "$slug" "$$"
}

# RESERVE a block of TCP ports and echo its base — the port to hand the selftest as
# MOSH_SERVICE_PORT. The reservation is held until al_release_port / al_release_all_ports,
# so a concurrent gate cannot pick the same port during the long gap before the service
# actually binds. See the ownership notes above for why probing was not enough.
#
# Callers MUST treat empty output as fatal: al_die exits the `$( )` subshell, not the
# caller, so an exhausted band otherwise silently yields MOSH_SERVICE_PORT="" (which
# crashes server.py's int() and fails every generative check).
unique_port() {
  local lo="${1:-$AL_PORT_LO}" hi="${2:-$AL_PORT_HI}" base p pid claimed usable
  mkdir -p "$AL_PORT_DIR" 2>/dev/null || true
  base="$lo"
  while [ $((base + AL_PORT_SPAN - 1)) -le "$hi" ]; do
    claimed=true
    for p in $(seq "$base" $((base + AL_PORT_SPAN - 1))); do
      al_claim_port "$p" || { claimed=false; break; }
    done
    if [ "$claimed" = true ]; then
      # We hold the locks, so anything still LISTENING here is either an orphan of a dead
      # run (ours to reap — this is the only sweep that is actually ours to do) or a
      # foreign process, in which case the block is unusable and we hand it straight back.
      # One ranged lsof for the whole block: ~10x cheaper than a call per port, and which
      # port a pid sits on does not change the decision.
      usable=true
      for pid in $(lsof -ti tcp:"$base"-$((base + AL_PORT_SPAN - 1)) -sTCP:LISTEN 2>/dev/null || true); do
        if al_is_mosh_service "$pid"; then kill -9 "$pid" 2>/dev/null || true
        else usable=false; fi
      done
      [ "$usable" = true ] && { printf '%s\n' "$base"; return 0; }
    fi
    al_release_port "$base"      # give back a partial/unusable claim so no rival is blocked
    base=$((base + AL_PORT_SPAN))
  done
  al_die "no free ${AL_PORT_SPAN}-port block in $lo-$hi (concurrent gate runs? stale locks in $AL_PORT_DIR?)"
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

# ── ui dependency freshness (the shared-node_modules drift trap) ──────────────────
# new-worktree.sh SYMLINKS each worktree's ui/node_modules to a SHARED cache when the
# lockfile matches at creation time. A later merged PR can then change ui/package-lock.json
# out from under that shared dir, but a bare `[ -e node_modules ]` check still sees the
# symlink as present → the gate skipped `npm ci` and ran against stale deps (a real false
# gate-red: PR #157 added @storybook/react-vite, the shared cache went stale, and tsc failed
# on the unrelated clean PR #168). Detect drift by hashing package-lock.json against a stamp
# written after each successful install; the stamp lives INSIDE node_modules (gitignored, so
# it never pollutes `git status`) and resolves through the symlink, so it is shared exactly
# when node_modules is. `npm ci` clears node_modules, but we always re-stamp right after a
# successful install, so the stamp is present whenever the deps are.
DEPS_STAMP_NAME=".mosh-deps-stamp"

# deps_lock_hash <file> — sha256 hex of a file, portable across macOS (shasum) and Linux
# (sha256sum). Echoes the digest, or nothing if the file is missing / no hasher exists.
deps_lock_hash() {
  local f="$1"
  [ -f "$f" ] || return 0
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$f" 2>/dev/null | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$f" 2>/dev/null | awk '{print $1}'
  else cksum "$f" 2>/dev/null | awk '{print $1"-"$2}'; fi
}

# deps_need_install <ui-dir> — exit 0 (true) if `npm ci` should run for this ui dir, 1
# (false) if the installed deps already satisfy ui/package-lock.json. Cheap: a hash compare,
# no install. Works whether ui/node_modules is a real dir OR a symlink into the shared cache
# (the stamp + lockfile both resolve through the symlink). With no lockfile it falls back to
# the legacy "install only if node_modules is absent" behaviour.
deps_need_install() {
  local ui="$1"
  local nm="$ui/node_modules" want
  want="$(deps_lock_hash "$ui/package-lock.json")"
  if [ -z "$want" ]; then
    [ -e "$nm" ] && return 1 || return 0   # no lockfile: legacy absent-only check
  fi
  [ -e "$nm" ] || return 0                  # node_modules absent or a dangling symlink
  [ "$(cat "$nm/$DEPS_STAMP_NAME" 2>/dev/null || true)" = "$want" ] && return 1 || return 0
}

# deps_write_stamp <ui-dir> — record the current lockfile hash so the next gate run can
# detect drift. Call ONLY after a successful install. No-op if node_modules / the lockfile
# is gone. Through a symlinked node_modules this stamps the SHARED cache for every worktree.
deps_write_stamp() {
  local ui="$1" nm="$1/node_modules" want
  want="$(deps_lock_hash "$ui/package-lock.json")"
  [ -n "$want" ] && [ -d "$nm" ] && printf '%s\n' "$want" > "$nm/$DEPS_STAMP_NAME" 2>/dev/null || true
}

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
