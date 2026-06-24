#!/usr/bin/env bash
# seed-cache.sh — ONE-TIME, idempotent. Warm a shared CPM source cache + resolve the
# fetched tracktion_engine SOURCE dir in the MAIN worktree, then record both in the
# machine-local $AL_HOME/auto-loop.env so every parallel worktree build is
# INCREMENTAL (no re-fetch of JUCE / tracktion) instead of a cold ~full build.
#
# Established pattern (see memory + run-mosh.sh): worktree builds reuse the main
# checkout's `.cpm-cache` via -DCPM_SOURCE_CACHE and its already-fetched tracktion
# source via -DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE. We deliberately DO NOT share
# FETCHCONTENT_BASE_DIR (the juceaide cross-dir CMakeCache error) — only the SOURCE.
#
# Usage: scripts/auto-loop/seed-cache.sh [--force]
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib.sh"

FORCE="${1:-}"
MAIN="$(al_main_worktree)"; [ -n "$MAIN" ] || al_die "could not resolve the main worktree"
CACHE="$MAIN/.cpm-cache"
mkdir -p "$AL_HOME"

# Already seeded and valid? (cache dir + a tracktion source dir both present.)
if [ "$FORCE" != "--force" ] && [ -f "$AL_ENV" ]; then
  al_load_cache_env
  if [ -d "${AL_CPM_CACHE:-/nonexistent}" ] && [ -d "${AL_TRACTION_SRC:-/nonexistent}" ]; then
    al_log "cache already seeded: CPM=$AL_CPM_CACHE TRK=$AL_TRACTION_SRC (use --force to re-seed)"
    exit 0
  fi
fi

al_log "seeding dep cache in MAIN worktree: $MAIN (first run downloads JUCE+tracktion — long)…"
( cd "$MAIN" && cmake --preset macos-arm64-release -DCPM_SOURCE_CACHE="$CACHE" )

# Find the fetched tracktion source dir. With CPM_SOURCE_CACHE set, FetchContent's base
# is redirected INTO the cache, so the source lands at <cache>/_fc/<name>-src — NOT the
# default build-dir _deps/ location. Check both (cache first), then fall back to a search.
TRK=""
for c in \
  "$CACHE/_fc/tracktion_engine-src" \
  "$CACHE/_fc/tracktion-src" \
  "$MAIN/build-macos-arm64-release/_deps/tracktion_engine-src" \
  "$MAIN/build-macos-arm64-release/_deps/tracktion-src"; do
  [ -d "$c" ] && { TRK="$c"; break; }
done
if [ -z "$TRK" ]; then
  TRK="$( { find "$CACHE/_fc" "$MAIN/build-macos-arm64-release/_deps" -maxdepth 1 -type d -iname '*tracktion*-src' 2>/dev/null; } | head -1 || true)"
fi
[ -n "$TRK" ] && [ -d "$TRK" ] || al_die "could not locate the fetched tracktion source (looked in $CACHE/_fc and _deps/)"

cat > "$AL_ENV" <<EOF
# Written by scripts/auto-loop/seed-cache.sh on $(al_now). Machine-local; shared by
# all auto-loop worktree builds. Re-seed with: scripts/auto-loop/seed-cache.sh --force
AL_CPM_CACHE="$CACHE"
AL_TRACTION_SRC="$TRK"
EOF
al_log "seeded. CPM_SOURCE_CACHE=$CACHE"
al_log "       FETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$TRK"
al_log "       recorded → $AL_ENV"
