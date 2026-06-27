#!/usr/bin/env bash
# deps-freshness-selftest.sh — unit test for the ui dependency drift detector in lib.sh
# (deps_lock_hash / deps_need_install / deps_write_stamp). This is the regression guard for
# the false-gate bug where a worktree's ui/node_modules is a SYMLINK into a SHARED cache that
# a merged PR has made stale: a bare `[ -e node_modules ]` check can't see the drift, so the
# gate skipped `npm ci` and `tsc` failed on a clean PR. The detector hashes package-lock.json
# against a stamp written after each successful install, so it works through the symlink.
#
# Pure filesystem; no npm, no git, no network. Exits non-zero on the first failed assertion.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib.sh"

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

FAILED=0
ok()   { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; FAILED=1; }

# assert_need <ui-dir> <expected: yes|no> <label>
assert_need() {
  local ui="$1" expect="$2" label="$3" got
  if deps_need_install "$ui"; then got=yes; else got=no; fi
  [ "$got" = "$expect" ] && ok "$label (need=$got)" || fail "$label — expected need=$expect, got need=$got"
}

# Build a fresh ui-dir with a given lockfile body. Echoes the dir.
make_ui() {
  local dir="$1" body="${2:-v1}"
  mkdir -p "$dir"
  printf '{"name":"mosh-ui","lock":"%s"}\n' "$body" > "$dir/package-lock.json"
  printf '%s\n' "$dir"
}

# ── deps_lock_hash: stable, and changes with content ──────────────────────────────
LF="$SANDBOX/h/package-lock.json"; mkdir -p "$SANDBOX/h"; printf 'A\n' > "$LF"
H1="$(deps_lock_hash "$LF")"; H1b="$(deps_lock_hash "$LF")"
printf 'B\n' > "$LF"; H2="$(deps_lock_hash "$LF")"
[ -n "$H1" ] && ok "deps_lock_hash returns a digest" || fail "deps_lock_hash empty for a real file"
[ "$H1" = "$H1b" ] && ok "deps_lock_hash is stable" || fail "deps_lock_hash not stable across calls"
[ "$H1" != "$H2" ] && ok "deps_lock_hash changes with content" || fail "deps_lock_hash didn't change on edit"
[ -z "$(deps_lock_hash "$SANDBOX/nope/missing.json")" ] && ok "deps_lock_hash empty for missing file" \
  || fail "deps_lock_hash should be empty for a missing file"

# ── Case 1: node_modules absent → install ─────────────────────────────────────────
UI1="$(make_ui "$SANDBOX/c1")"
assert_need "$UI1" yes "absent node_modules"

# ── Case 2: node_modules present but no stamp → install (can't prove it's in sync) ─
UI2="$(make_ui "$SANDBOX/c2")"; mkdir -p "$UI2/node_modules"
assert_need "$UI2" yes "present node_modules, no stamp"

# ── Case 3: after deps_write_stamp, an UNCHANGED lockfile → in sync (cheap skip) ───
deps_write_stamp "$UI2"
assert_need "$UI2" no "stamped + unchanged lockfile"

# ── Case 4: lockfile drifts (a merged PR changed deps) → install ──────────────────
printf '{"name":"mosh-ui","lock":"v2-new-dep"}\n' > "$UI2/package-lock.json"
assert_need "$UI2" yes "drifted lockfile vs stamp"

# ── Case 5: SYMLINK to a shared cache whose stamp matches → in sync (the bug's fix) ─
SHARED="$(make_ui "$SANDBOX/shared" "v-shared")"; mkdir -p "$SHARED/node_modules"
deps_write_stamp "$SHARED"                      # shared cache stamped for v-shared
UI5="$SANDBOX/c5"; mkdir -p "$UI5"
cp "$SHARED/package-lock.json" "$UI5/package-lock.json"   # worktree lockfile == shared's
ln -s "$SHARED/node_modules" "$UI5/node_modules"          # symlink, as new-worktree.sh does
assert_need "$UI5" no "symlinked node_modules, shared stamp matches"

# ── Case 6: symlinked node_modules but the worktree lockfile drifted → install ────
printf '{"name":"mosh-ui","lock":"v-merged-pr"}\n' > "$UI5/package-lock.json"
assert_need "$UI5" yes "symlinked node_modules, lockfile drifted from shared stamp"

# ── Case 7: no lockfile → legacy absent-only behaviour ────────────────────────────
UI7="$SANDBOX/c7"; mkdir -p "$UI7"
assert_need "$UI7" yes "no lockfile, node_modules absent"
mkdir -p "$UI7/node_modules"
assert_need "$UI7" no  "no lockfile, node_modules present"

if [ "$FAILED" = 0 ]; then printf 'deps-freshness-selftest: PASS\n'; else printf 'deps-freshness-selftest: FAIL\n'; exit 1; fi
