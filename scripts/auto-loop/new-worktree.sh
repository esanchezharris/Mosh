#!/usr/bin/env bash
# new-worktree.sh — create an isolated worktree for one backlog item, off origin/main,
# wired to the shared dep cache so its native build is incremental. Echoes the
# worktree path on stdout (last line) for the caller to capture.
#
# Usage: scripts/auto-loop/new-worktree.sh <slug> [base-ref]
#   → worktree at .claude/worktrees/auto-<slug> on branch claude/auto-<slug>, created
#     off [base-ref] (default origin/main). For the AL-000 warm-up, pass the existing
#     deployed branch as base so the new branch carries its commits.
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib.sh"

SLUG="${1:?usage: new-worktree.sh <slug> [base-ref]}"
SLUG="$(printf '%s' "$SLUG" | tr -c 'A-Za-z0-9._-' '-')"
BASE_REF="${2:-origin/main}"
MAIN="$(al_main_worktree)"; [ -n "$MAIN" ] || al_die "no main worktree"
WT="$MAIN/.claude/worktrees/auto-$SLUG"
BR="claude/auto-$SLUG"

git -C "$MAIN" fetch --quiet origin || al_warn "git fetch origin failed (offline?)"

if [ -d "$WT" ]; then
  al_log "worktree exists, reusing: $WT"
else
  # Fresh branch off BASE_REF. If the branch already exists, reuse it.
  if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$BR"; then
    git -C "$MAIN" worktree add "$WT" "$BR"
  else
    git -C "$MAIN" worktree add -b "$BR" "$WT" "$BASE_REF"
  fi
fi

# Speed up the cheap (TS) lane: reuse the main checkout's node_modules + Playwright
# browser cache by symlink when the lockfile matches, so npm ci isn't needed per item.
if [ -d "$MAIN/ui/node_modules" ] && [ ! -e "$WT/ui/node_modules" ]; then
  if diff -q "$MAIN/ui/package-lock.json" "$WT/ui/package-lock.json" >/dev/null 2>&1; then
    ln -s "$MAIN/ui/node_modules" "$WT/ui/node_modules"
    al_log "linked ui/node_modules from main (lockfile matches)"
  fi
fi

printf '%s\n' "$WT"
