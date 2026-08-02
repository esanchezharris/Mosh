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

case "$SLUG" in
  [Ff][Ss]-*)
    AL_PROGRAM_ACTIVE=1
    AL_PROGRAM_STOP="${AL_PROGRAM_STOP:-$MAIN/docs/first-stranger-program/STOP}"
    ;;
esac

if al_stop_requested; then
  al_die "STOP sentinel present — worktree not created"
fi
git -C "$MAIN" fetch --quiet origin || al_warn "git fetch origin failed (offline?)"
if al_stop_requested; then
  al_die "STOP sentinel present — worktree not created"
fi

if [ -d "$WT" ]; then
  al_log "worktree exists, reusing: $WT"
else
  if al_stop_requested; then
    al_die "STOP sentinel present — worktree not created"
  fi
  # Fresh branch off BASE_REF. If the branch already exists, reuse it. Redirect git's
  # output to stderr — `git worktree add -b` off a REMOTE ref prints "branch '…' set up to
  # track …" to STDOUT, which would pollute the worktree path this script echoes.
  if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$BR"; then
    git -C "$MAIN" worktree add "$WT" "$BR" 1>&2
  else
    git -C "$MAIN" worktree add -b "$BR" "$WT" "$BASE_REF" 1>&2
  fi
fi

if al_stop_requested; then
  al_die "STOP sentinel present — worktree created, no dependency link or implementation authorized"
fi

# Speed up the cheap (TS) lane: reuse the main checkout's node_modules + Playwright
# browser cache by symlink when the lockfile matches, so npm ci isn't needed per item.
# NOTE: this symlink can go STALE — the shared cache reflects main's lockfile AT LINK TIME,
# but a later merged PR may change ui/package-lock.json. gate.sh::ensure_node_modules detects
# that drift (it hashes the lockfile against deps_write_stamp's stamp, which resolves through
# this symlink) and reinstalls; we deliberately do NOT stamp here, because main's shared cache
# is not guaranteed to actually match main's own lockfile — only the gate, after a real
# `npm ci`, may declare the deps in-sync. See lib.sh deps_need_install / deps_write_stamp.
if [ -d "$MAIN/ui/node_modules" ] && [ ! -e "$WT/ui/node_modules" ]; then
  if diff -q "$MAIN/ui/package-lock.json" "$WT/ui/package-lock.json" >/dev/null 2>&1; then
    if al_stop_requested; then
      al_die "STOP sentinel present — dependency link not created"
    fi
    ln -s "$MAIN/ui/node_modules" "$WT/ui/node_modules"
    al_log "linked ui/node_modules from main (lockfile matches)"
  fi
fi

printf '%s\n' "$WT"
