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

# Warm the CPM cache if absent (and, when no blessed clone was found, let FetchContent
# populate + PATCH the tracktion source into <cache>/_fc/).
if [ ! -d "$CACHE" ] || [ -z "$TRK" ]; then
  MAIN="$(al_main_worktree)"; [ -n "$MAIN" ] || al_die "could not resolve the main worktree"
  al_log "warming dep cache at $CACHE via MAIN worktree configure: $MAIN (first run downloads JUCE+tracktion — long)…"
  ( cd "$MAIN" && cmake --preset macos-arm64-release -DCPM_SOURCE_CACHE="$CACHE" \
      ${TRK:+-DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE="$TRK"} )
fi

# No blessed clone: adopt the cache-populated one. With CPM_SOURCE_CACHE set,
# FetchContent's base is redirected INTO the cache, so the source lands at
# <cache>/_fc/<name>-src — NOT the default build-dir _deps/ location.
if [ -z "$TRK" ]; then
  for c in "$CACHE/_fc/tracktion_engine-src" "$CACHE/_fc/tracktion-src"; do
    [ -d "$c" ] && { TRK="$c"; break; }
  done
  [ -n "$TRK" ] || TRK="$(find "$CACHE/_fc" -maxdepth 1 -type d -iname '*tracktion*-src' 2>/dev/null | head -1 || true)"
fi
[ -n "$TRK" ] && [ -d "$TRK" ] || al_die "could not locate a tracktion source (looked at $DEPS_TRK and $CACHE/_fc)"
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
