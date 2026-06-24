#!/usr/bin/env bash
# classify.sh — decide the change-class of a branch's diff and whether it touches
# the hard-exclusion list, fail-closed.
#
# Usage:  scripts/auto-loop/classify.sh [base-ref] [worktree]
#   base-ref  default origin/main
#   worktree  default $PWD (must be a git work tree on the branch under test)
#
# Output (stdout, JSON):
#   {"class":"cheap|native", "excluded":bool, "excluded_paths":[...],
#    "paths":[...], "diff_empty":bool}
#
# Rules (in order, fail-closed → unknown becomes native):
#   - EXCLUDED if any path matches the never-auto-merge set (still classified, but
#     the merge step refuses to auto-merge it).
#   - NATIVE if any path is compiled / build / fingerprint / model-fed-service.
#   - CHEAP only if EVERY path is ui/ , docs/ , *.py service|relay, or scripts/auto-loop/.
#   - otherwise NATIVE.
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"

BASE="${1:-origin/main}"
TREE="${2:-$PWD}"

cd "$TREE"
# three-dot: changes on HEAD since the merge-base with BASE (ignores BASE-only commits).
# Portable read loop (no mapfile — macOS ships bash 3.2).
PATHS=()
while IFS= read -r _line; do [ -n "$_line" ] && PATHS+=("$_line"); done < <(
  git diff --name-only "$BASE...HEAD" 2>/dev/null || git diff --name-only "$BASE" 2>/dev/null || true
)

# ── pattern sets ─────────────────────────────────────────────────────────────────
# EXCLUSION — always human-gated (the loop must never auto-merge these).
is_excluded() {
  case "$1" in
    cmake/Dependencies.cmake|cmake/CPM*.cmake|cmake/*patch*|patches/*) return 0;;
    CMakeLists.txt|CMakePresets.json|*/CMakeLists.txt)               return 0;;
    run-mosh.sh|run-mosh.ps1|scripts/*deploy*|scripts/package-for-sharing.sh) return 0;;
    relay/server.py|relay/room.py|supabase/migrations/*|supabase/functions/*) return 0;;
    src/plugins/hosting/*)                                            return 0;;
    src/engine/MoshEngine.cpp|src/engine/MoshEngine.h|src/state/*)    return 0;;
    CLAUDE.md|docs/0[0-6]_*.md|docs/02_MOSHOPS_CONTRACT.md)           return 0;;
    .github/*)                                                        return 0;;
    *.pt|*.pth|*.onnx|*.safetensors|*.ckpt|*.mlmodel|*.gguf|*.bin)    return 0;;
    *auth*|*token*|*secret*|*signed*|*credential*)                    return 0;;
  esac
  return 1
}

# NATIVE trigger — needs the compiled binary to verify.
is_native() {
  case "$1" in
    src/*|cmake/*|CMakeLists.txt|CMakePresets.json|*/CMakeLists.txt|patches/*|resources/*) return 0;;
    service/adapters/*|service/colors/*|service/sa3/*) return 0;;
  esac
  return 1
}

# CHEAP-eligible — verifiable without a native build.
is_cheap_path() {
  case "$1" in
    ui/*|docs/*|scripts/auto-loop/*) return 0;;
    service/*.py|service/**/*.py|relay/*.py|relay/**/*.py) return 0;;
  esac
  return 1
}

EXCLUDED=false; EXCLUDED_PATHS=(); CLASS="cheap"; ANY_NATIVE=false; ALL_CHEAP=true

for p in "${PATHS[@]:-}"; do
  [ -z "$p" ] && continue
  if is_excluded "$p"; then EXCLUDED=true; EXCLUDED_PATHS+=("$p"); fi
  if is_native "$p"; then ANY_NATIVE=true; fi
  if ! is_cheap_path "$p"; then ALL_CHEAP=false; fi
done

if [ "$ANY_NATIVE" = true ]; then
  CLASS="native"
elif [ "$ALL_CHEAP" = true ] && [ "${#PATHS[@]}" -gt 0 ]; then
  CLASS="cheap"
else
  CLASS="native"   # fail-closed: empty diff or anything unrecognized → native
fi

DIFF_EMPTY=false; [ "${#PATHS[@]}" -eq 0 ] && DIFF_EMPTY=true

# Build JSON arrays from the bash arrays (newline-delimited → jq -R -s 'split').
paths_json()  { printf '%s\n' "${PATHS[@]:-}"          | jq -R . | jq -sc 'map(select(length>0))'; }
excl_json()   { printf '%s\n' "${EXCLUDED_PATHS[@]:-}" | jq -R . | jq -sc 'map(select(length>0))'; }

jq -nc \
  --arg class "$CLASS" \
  --argjson excluded "$EXCLUDED" \
  --argjson diff_empty "$DIFF_EMPTY" \
  --argjson excluded_paths "$(excl_json)" \
  --argjson paths "$(paths_json)" \
  '{class:$class, excluded:$excluded, diff_empty:$diff_empty,
    excluded_paths:$excluded_paths, paths:$paths}'
