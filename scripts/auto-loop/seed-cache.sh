#!/usr/bin/env bash
# seed-cache.sh — ONE-TIME, idempotent. Record a shared CPM source cache + a resolved
# tracktion_engine SOURCE dir in the machine-local $AL_HOME/auto-loop.env so every
# parallel worktree build is INCREMENTAL (no re-fetch of JUCE / tracktion) instead of
# a cold ~full build.
#
# Established pattern (see memory + run-mosh.sh): worktree builds reuse a shared CPM
# cache via -DCPM_SOURCE_CACHE and an already-fetched tracktion source via
# -DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE. We deliberately DO NOT share
# FETCHCONTENT_BASE_DIR (the juceaide cross-dir CMakeCache error) — only the SOURCE.
#
# LOCATION MATTERS (2026-07-10): the cache + tracktion clone MUST live outside every
# iCloud-synced path (~/Documents!). iCloud evicts file content — "dataless" files that
# stat at full size but READ as 0 bytes — and an evicted JUCEModuleSupport.cmake made
# every fresh worktree configure die with 'Unknown CMake command "juce_add_modules"'.
# Default home is ~/Library/Mosh/work (what the 2026-07-09 consolidation gate builds
# used). Full diagnosis: docs/2026-07-10-cpm-cache-icloud-eviction.md.
#
# NB: FETCHCONTENT_SOURCE_DIR_* bypasses PATCH_COMMAND — the recorded tracktion clone
# must already carry patches/0001..0003 in its WORKING TREE. The blessed clone at
# $MOSH_WORK_DIR/deps/tracktion_engine-src does; a cache-populated _fc clone gets them
# applied by FetchContent at populate time.
#
# Usage: scripts/auto-loop/seed-cache.sh [--force]
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib.sh"

FORCE="${1:-}"
WORK="${MOSH_WORK_DIR:-$HOME/Library/Mosh/work}"
CACHE="$WORK/cpm-cache"
DEPS_TRK="$WORK/deps/tracktion_engine-src"
mkdir -p "$AL_HOME"

# iCloud syncs ~/Documents and ~/Library/Mobile Documents; file content there can be
# evicted out from under CMake. Never trust or record such a path.
al_is_icloud_path() {
  case "$1" in
    "$HOME/Documents/"*|*"/Mobile Documents/"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Content-eviction probe: an iCloud-evicted file stats at full size but reads empty.
# Probe the exact file the 2026-07-10 failure hinged on — it must exist AND read back
# every byte stat reports.
al_trk_healthy() {
  local f="$1/modules/juce/extras/Build/CMake/JUCEModuleSupport.cmake"
  [ -f "$f" ] || return 1
  local statsz readsz
  statsz="$(stat -f%z "$f" 2>/dev/null || echo -1)"
  readsz="$(cat "$f" 2>/dev/null | wc -c | tr -d ' ')"
  [ "$statsz" -gt 0 ] && [ "$readsz" = "$statsz" ]
}

# Already seeded and valid? (both dirs present, not on iCloud, tracktion not evicted.)
if [ "$FORCE" != "--force" ] && [ -f "$AL_ENV" ]; then
  al_load_cache_env
  if [ -d "${AL_CPM_CACHE:-/nonexistent}" ] && [ -d "${AL_TRACTION_SRC:-/nonexistent}" ] \
     && ! al_is_icloud_path "$AL_CPM_CACHE" && ! al_is_icloud_path "$AL_TRACTION_SRC" \
     && al_trk_healthy "$AL_TRACTION_SRC"; then
    al_log "cache already seeded: CPM=$AL_CPM_CACHE TRK=$AL_TRACTION_SRC (use --force to re-seed)"
    exit 0
  fi
  al_warn "recorded cache config is stale or unhealthy (iCloud path / evicted content / missing dir) — re-seeding"
fi

# Prefer the blessed patched clone: it carries patches/0001..0003 in its working tree,
# which the SOURCE_DIR override requires (PATCH_COMMAND is bypassed).
TRK=""
if [ -d "$DEPS_TRK" ] && al_trk_healthy "$DEPS_TRK"; then
  TRK="$DEPS_TRK"
  if [ -z "$(git -C "$TRK" status --short 2>/dev/null)" ]; then
    al_warn "$TRK working tree is CLEAN — expected patches/0001..0003 applied; builds would use the UNPATCHED engine"
  fi
fi

# Next best: a clone FetchContent already populated (+ PATCHed, at populate time) for
# some earlier configure. Candidates: a prior run of this script ($CACHE/_fc — see the
# pinned warm below) or a per-checkout fc dir from CMakeLists.txt's dev-Mac default
# ($WORK/fc/<srcdir-basename>-<sha1[0:12]>). Never adopt an in-tree .cpm-cache/_fc —
# that's the iCloud-evictable location this script exists to escape.
if [ -z "$TRK" ]; then
  for c in "$CACHE/_fc/tracktion_engine-src" "$WORK"/fc/*/tracktion_engine-src; do
    [ -d "$c" ] && al_trk_healthy "$c" && { TRK="$c"; break; }
  done
fi

# Warm the CPM cache if absent (and, when no clone was found anywhere, have FetchContent
# populate + PATCH the tracktion source). The tracktion landing spot is governed by
# FETCHCONTENT_BASE_DIR, NOT CPM_SOURCE_CACHE — tracktion is fetched via raw
# FetchContent (cmake/Dependencies.cmake), and CMakeLists.txt's FETCHCONTENT_BASE_DIR
# default has moved (in-tree .cpm-cache/_fc historically; $WORK/fc/<key> on dev Macs
# since 5c1fe8dd) — so PIN it to $CACHE/_fc explicitly (-D wins over both defaults);
# the adoption below then matches by construction. Only pinned when we still need the
# clone: with TRK resolved the warm just fills the CPM cache, and MAIN's fc base is
# left alone (a shared FETCHCONTENT_BASE_DIR across checkout builds is the juceaide
# cross-dir CMakeCache error — one warm configure owning $CACHE/_fc is fine, and later
# seeds adopt the populated clone above instead of re-warming).
if [ ! -d "$CACHE" ] || [ -z "$TRK" ]; then
  MAIN="$(al_main_worktree)"; [ -n "$MAIN" ] || al_die "could not resolve the main worktree"
  cfgextra=()
  if [ -n "$TRK" ]; then cfgextra+=("-DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$TRK")
  else cfgextra+=("-DFETCHCONTENT_BASE_DIR=$CACHE/_fc"); fi
  al_log "warming dep cache at $CACHE via MAIN worktree configure: $MAIN (first run downloads JUCE+tracktion — long)…"
  ( cd "$MAIN" && cmake --preset macos-arm64-release -DCPM_SOURCE_CACHE="$CACHE" "${cfgextra[@]}" )
fi

# Still no clone before the warm: adopt the one the pinned warm just populated.
if [ -z "$TRK" ]; then
  for c in "$CACHE/_fc/tracktion_engine-src" "$CACHE/_fc/tracktion-src"; do
    [ -d "$c" ] && { TRK="$c"; break; }
  done
  [ -n "$TRK" ] || TRK="$(find "$CACHE/_fc" -maxdepth 1 -type d -iname '*tracktion*-src' 2>/dev/null | head -1 || true)"
fi
[ -n "$TRK" ] && [ -d "$TRK" ] || al_die "could not locate a tracktion source (looked at $DEPS_TRK, $WORK/fc/*/ and $CACHE/_fc)"
al_trk_healthy "$TRK" || al_die "tracktion source at $TRK fails the eviction probe (JUCEModuleSupport.cmake unreadable)"

cat > "$AL_ENV" <<EOF
# Written by scripts/auto-loop/seed-cache.sh on $(al_now). Machine-local; shared by
# all auto-loop worktree builds. Re-seed with: scripts/auto-loop/seed-cache.sh --force
# MUST stay outside iCloud paths (~/Documents) — an evicted cache breaks every worktree
# configure. See docs/2026-07-10-cpm-cache-icloud-eviction.md.
AL_CPM_CACHE="$CACHE"
AL_TRACTION_SRC="$TRK"
EOF
al_log "seeded. CPM_SOURCE_CACHE=$CACHE"
al_log "       FETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$TRK"
al_log "       recorded → $AL_ENV"
