#!/usr/bin/env bash
# codex-lane.sh — hand ONE First-Stranger lane to Codex. The sequential Codex analog of the
# Claude stranger-loop: Codex implements the lane in its own worktree, runs the gate, opens a
# PR. It NEVER merges — the owner merges. No parallelism, no auto-merge.
#
#   codex-lane.sh FS-T2           print the ready-to-paste prompt for that lane
#   codex-lane.sh --next          pick the next `ready` lane and print its prompt
#   codex-lane.sh FS-T2 --exec    run it via `codex exec` (full-auto: builds, pushes, PRs) — owner-armed
#
# Bash 3.2 compatible.
set -euo pipefail

REPO="$(git rev-parse --show-toplevel)"
PROG="$REPO/docs/first-stranger-program"
BL="$PROG/backlog.jsonl"
CODEX_BIN="${CODEX_BIN:-codex}"

LANE=""; EXEC=0
for a in "$@"; do case "$a" in
  --exec) EXEC=1 ;;
  --next) LANE="$(AL_BACKLOG_JSONL="$BL" "$REPO/scripts/auto-loop/discover.sh" ready | jq -r '.[0].id // empty')" ;;
  FS-*|fs-*) LANE="$(printf '%s' "$a" | tr '[:lower:]' '[:upper:]')" ;;
  *) echo "unknown arg: $a" >&2 ;;
esac; done

[ -n "$LANE" ] || { echo "usage: codex-lane.sh <FS-ID | --next> [--exec]" >&2; exit 1; }
SLUG="$(printf '%s' "$LANE" | tr '[:upper:]' '[:lower:]')"
PLAN="$PROG/lanes/$SLUG.md"
[ -f "$PLAN" ] || { echo "no lane plan at $PLAN — generate it first (scripts/first-stranger/nightly.sh --plan) or write it." >&2; exit 1; }

TITLE="$(AL_BACKLOG_JSONL="$BL" "$REPO/scripts/auto-loop/discover.sh" get "$LANE" 2>/dev/null | jq -r '.title // "the lane"')"

# read -d '' (not $(cat <<EOF)) — macOS bash 3.2 mis-parses a heredoc nested in $() when the
# body has apostrophes. read returns non-zero at EOF, hence `|| true` under `set -e`.
IFS= read -r -d '' PROMPT <<EOF || true
You are implementing First-Stranger Program lane $LANE ("$TITLE") for the Mosh repo.

READ FIRST: docs/first-stranger-program/lanes/$SLUG.md (the gate-registered plan),
docs/first-stranger-program/SPEC.md §0 + this lane's section, docs/first-stranger-program/CODEX_HANDOFF.md,
and AGENTS.md. If the plan says gapExists = false, the lane is already done — STOP and report that.

WORK IN ITS OWN GIT WORKTREE (one lane per worktree):
  git worktree add ../mosh-$SLUG -b codex/$SLUG origin/main

OBEY SPEC §0 (non-negotiable): MoshOps is the ONLY mutation seam (validate → undo txn → events →
JSONL → result); nothing a build reads may live under \$HOME/Documents (caches/artifacts under
\$HOME/Library/Mosh/); keep the Info.plist TCC keys intact; do NOT touch parked threads (arena/,
SA3-LoRA, FMS spikes) or the loop rulebook (scripts/auto-loop/*.sh, CLAUDE.md, specs 00-06,
cmake/Dependencies.cmake + pins, .github/). Build recipe:
  cmake --preset macos-arm64-release -DCPM_SOURCE_CACHE=\$HOME/Library/Mosh/work/cpm-cache -DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=\$HOME/Library/Mosh/work/deps/tracktion_engine-src

TDD: write the FAILING gate/test first (a Mosh --selftest check / Catch2 for src/, vitest for ui/,
a python unit for service|relay), confirm RED, implement to GREEN, keep it minimal + in-lane.

GATE (the merge gate):
  scripts/auto-loop/seed-cache.sh
  scripts/auto-loop/gate.sh native ../mosh-$SLUG origin/main
Must be green with --selftest ×3 deterministic (identical check-count ≥ the spec floor ≈1254–1260,
0 failed, 0 JUCE assertions). Use 'gate.sh cheap' instead for a ui/+service-py-only lane.

THEN open a PR and STOP — do NOT merge (the owner merges):
  git -C ../mosh-$SLUG push -u origin codex/$SLUG
  gh pr create --draft --base main --head codex/$SLUG --title "codex($LANE): $TITLE" --body "Lane $LANE. Gate: <paste ×3 tallies>. Blocked-on-owner: <O# or none>."
Report the gate verdict + the PR number.
EOF

if [ "$EXEC" = 1 ]; then
  command -v "$CODEX_BIN" >/dev/null 2>&1 || { echo "codex not found (set CODEX_BIN)" >&2; exit 1; }
  echo "running codex exec (full-auto, PR-only) for $LANE — the owner merges." >&2
  exec "$CODEX_BIN" exec --cd "$REPO" --dangerously-bypass-approvals-and-sandbox "$PROMPT"
else
  echo "# Paste into an interactive codex session (or re-run with --exec to run it non-interactively):"
  echo "# ---------------------------------------------------------------------------------------------"
  printf '%s\n' "$PROMPT"
fi
