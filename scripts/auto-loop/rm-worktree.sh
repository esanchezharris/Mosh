#!/usr/bin/env bash
# rm-worktree.sh — remove an auto-loop worktree after its branch is merged (or with
# --abandon for an unmerged one). Never silently discards unmerged work.
#
# Usage: scripts/auto-loop/rm-worktree.sh <slug> [--abandon]
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib.sh"

SLUG="${1:?usage: rm-worktree.sh <slug> [--abandon]}"
SLUG="$(printf '%s' "$SLUG" | tr -c 'A-Za-z0-9._-' '-')"
ABANDON="${2:-}"
MAIN="$(al_main_worktree)"; [ -n "$MAIN" ] || al_die "no main worktree"
WT="$MAIN/.claude/worktrees/auto-$SLUG"
BR="claude/auto-$SLUG"

[ -d "$WT" ] || { al_log "no such worktree: $WT"; exit 0; }

# Is the branch merged into origin/main?
MERGED=false
if git -C "$MAIN" merge-base --is-ancestor "$BR" origin/main 2>/dev/null; then MERGED=true; fi

if [ "$MERGED" = false ] && [ "$ABANDON" != "--abandon" ]; then
  al_die "branch $BR is NOT merged into origin/main; refusing to remove (pass --abandon to force)"
fi

git -C "$MAIN" worktree remove --force "$WT"
if [ "$MERGED" = true ]; then
  git -C "$MAIN" branch -D "$BR" 2>/dev/null || true
  al_log "removed merged worktree + branch: auto-$SLUG"
else
  al_warn "removed worktree but KEPT branch $BR (abandoned, unmerged — inspect/delete manually)"
fi
