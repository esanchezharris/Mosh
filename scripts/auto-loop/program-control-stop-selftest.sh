#!/usr/bin/env bash
# program-control-stop-selftest.sh — prove paused First-Stranger entrypoints
# preserve their historical state without requiring caller-provided STOP wiring.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/mosh-program-control-stop.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

ROOT="$SANDBOX/repo"
SECONDARY="$SANDBOX/secondary"
mkdir -p "$ROOT/scripts/first-stranger" "$ROOT/scripts/auto-loop" \
  "$ROOT/docs/first-stranger-program" "$ROOT/docs/auto-loop"
git init -q "$ROOT"
git -C "$ROOT" config user.email "program-control-stop-selftest@invalid"
git -C "$ROOT" config user.name "program-control-stop-selftest"
cp "$SELF_DIR/../first-stranger/codex-lane.sh" "$ROOT/scripts/first-stranger/"
cp "$SELF_DIR/../first-stranger/status.sh" "$ROOT/scripts/first-stranger/"
cp "$SELF_DIR/../first-stranger/nightly.sh" "$ROOT/scripts/first-stranger/"
cp "$SELF_DIR/../first-stranger/install-launchd.sh" "$ROOT/scripts/first-stranger/"
cp "$SELF_DIR/lib.sh" "$SELF_DIR/discover.sh" "$SELF_DIR/new-worktree.sh" \
  "$ROOT/scripts/auto-loop/"
printf 'preserved status\n' >"$ROOT/docs/first-stranger-program/STATUS.md"
printf '%s\n' \
  '{"id":"FS-B0","title":"preserved","class":"cheap","status":"ready","order":1}' \
  >"$ROOT/docs/first-stranger-program/backlog.jsonl"
printf '%s\n' \
  '{"id":"AL-000","title":"classic","class":"cheap","status":"ready","order":1}' \
  >"$ROOT/docs/auto-loop/backlog.jsonl"
git -C "$ROOT" add .
git -C "$ROOT" commit -qm seed
git -C "$ROOT" worktree add -qb secondary "$SECONDARY" HEAD

REAL_GIT="$(command -v git)"
FAKE_GIT_BIN="$SANDBOX/fake-git-bin"
SPACED_PRIMARY="$SANDBOX/primary with spaces"
mkdir -p "$FAKE_GIT_BIN"
mkdir -p "$SPACED_PRIMARY"
cat >"$FAKE_GIT_BIN/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "-C" ] && [ "${3:-}" = "worktree" ] &&
    [ "${4:-}" = "list" ] && [ "${5:-}" = "--porcelain" ]; then
  printf 'worktree %s\nHEAD 0000000000000000000000000000000000000000\n\n' \
    "$PROGRAM_CONTROL_PRIMARY_ROOT"
  for i in $(seq 1 20000); do
    printf 'worktree /synthetic/%05d\nHEAD 0000000000000000000000000000000000000000\n\n' "$i"
  done
  exit 0
fi
exec "$PROGRAM_CONTROL_REAL_GIT" "$@"
EOF
chmod +x "$FAKE_GIT_BIN/git"
if ! PRIMARY_OUT="$(PATH="$FAKE_GIT_BIN:$PATH" \
    PROGRAM_CONTROL_PRIMARY_ROOT="$SPACED_PRIMARY" PROGRAM_CONTROL_REAL_GIT="$REAL_GIT" \
    AL_ROOT="$ROOT" bash -c 'set -o pipefail; . "$1"; al_main_worktree' \
    program-control-stop-selftest "$SELF_DIR/lib.sh")"; then
  printf 'program-control-stop-selftest: FAIL (primary discovery raised SIGPIPE)\n' >&2
  exit 1
fi
[ "$PRIMARY_OUT" = "$SPACED_PRIMARY" ] || {
  printf 'program-control-stop-selftest: FAIL (wrong primary worktree: %s)\n' "$PRIMARY_OUT" >&2
  exit 1
}

RELOCATED_ROOT="$SANDBOX/relocated primary"
RELOCATED_STORE="$SANDBOX/relocated.git"
git init -q --separate-git-dir="$RELOCATED_STORE" "$RELOCATED_ROOT"
git --git-dir="$RELOCATED_STORE" config extensions.worktreeConfig true
git --git-dir="$RELOCATED_STORE" config --worktree core.worktree "../relocated primary"
RELOCATED_EXPECTED="$(cd "$RELOCATED_ROOT" && pwd -P)"
if ! RELOCATED_OUT="$(AL_ROOT="$RELOCATED_ROOT" bash -c \
    '. "$1"; al_main_worktree' program-control-stop-selftest "$SELF_DIR/lib.sh")"; then
  printf 'program-control-stop-selftest: FAIL (relocated primary discovery failed)\n' >&2
  exit 1
fi
[ "$RELOCATED_OUT" = "$RELOCATED_EXPECTED" ] || {
  printf 'program-control-stop-selftest: FAIL (wrong relocated primary: %s)\n' \
    "$RELOCATED_OUT" >&2
  exit 1
}

touch "$ROOT/docs/first-stranger-program/STOP"

BACKLOG_BEFORE="$(shasum -a 256 "$ROOT/docs/first-stranger-program/backlog.jsonl" | awk '{print $1}')"
if DISCOVER_OUT="$(cd "$ROOT" && \
    AL_BACKLOG_JSONL="$ROOT/docs/first-stranger-program/backlog.jsonl" \
    bash scripts/auto-loop/discover.sh set-status FS-B0 done 2>&1)"; then
  printf 'program-control-stop-selftest: FAIL (discover set-status ran while stopped)\n' >&2
  exit 1
fi
BACKLOG_AFTER="$(shasum -a 256 "$ROOT/docs/first-stranger-program/backlog.jsonl" | awk '{print $1}')"
[ "$BACKLOG_BEFORE" = "$BACKLOG_AFTER" ] || {
  printf 'program-control-stop-selftest: FAIL (discover changed the backlog while stopped)\n' >&2
  exit 1
}
printf '%s\n' "$DISCOVER_OUT" | grep -q 'STOP sentinel present' || {
  printf 'program-control-stop-selftest: FAIL (discover did not report STOP: %s)\n' "$DISCOVER_OUT" >&2
  exit 1
}

if DISCOVER_ADD_OUT="$(cd "$ROOT" && \
    AL_BACKLOG_JSONL="$ROOT/docs/first-stranger-program/backlog.jsonl" \
    bash scripts/auto-loop/discover.sh add '{"id":"FS-NEW","title":"new"}' 2>&1)"; then
  printf 'program-control-stop-selftest: FAIL (discover add ran while stopped)\n' >&2
  exit 1
fi
[ "$BACKLOG_BEFORE" = "$(shasum -a 256 "$ROOT/docs/first-stranger-program/backlog.jsonl" | awk '{print $1}')" ] || {
  printf 'program-control-stop-selftest: FAIL (discover add changed the backlog while stopped)\n' >&2
  exit 1
}
printf '%s\n' "$DISCOVER_ADD_OUT" | grep -q 'STOP sentinel present' || {
  printf 'program-control-stop-selftest: FAIL (discover add did not report STOP: %s)\n' "$DISCOVER_ADD_OUT" >&2
  exit 1
}

if WORKTREE_OUT="$(cd "$ROOT" && \
    bash scripts/auto-loop/new-worktree.sh fs-b0 2>&1)"; then
  printf 'program-control-stop-selftest: FAIL (new-worktree ran while stopped)\n' >&2
  exit 1
fi
printf '%s\n' "$WORKTREE_OUT" | grep -q 'STOP sentinel present' || {
  printf 'program-control-stop-selftest: FAIL (new-worktree did not report STOP: %s)\n' "$WORKTREE_OUT" >&2
  exit 1
}
[ ! -d "$ROOT/.claude/worktrees/auto-fs-b0" ] || {
  printf 'program-control-stop-selftest: FAIL (new-worktree created a worktree while stopped)\n' >&2
  exit 1
}

SECONDARY_PROGRAM_BACKLOG="$SECONDARY/docs/first-stranger-program/backlog.jsonl"
SECONDARY_PROGRAM_BEFORE="$(shasum -a 256 "$SECONDARY_PROGRAM_BACKLOG" | awk '{print $1}')"
if SECONDARY_PROGRAM_OUT="$(cd "$SECONDARY" && \
    AL_ROOT="$SECONDARY" AL_BACKLOG_JSONL="$SECONDARY_PROGRAM_BACKLOG" \
    bash scripts/auto-loop/discover.sh set-status FS-B0 done 2>&1)"; then
  printf 'program-control-stop-selftest: FAIL (secondary worktree missed program STOP)\n' >&2
  exit 1
fi
[ "$SECONDARY_PROGRAM_BEFORE" = "$(shasum -a 256 "$SECONDARY_PROGRAM_BACKLOG" | awk '{print $1}')" ] || {
  printf 'program-control-stop-selftest: FAIL (secondary worktree changed program backlog)\n' >&2
  exit 1
}
printf '%s\n' "$SECONDARY_PROGRAM_OUT" | grep -q 'STOP sentinel present' || {
  printf 'program-control-stop-selftest: FAIL (secondary program STOP not reported: %s)\n' \
    "$SECONDARY_PROGRAM_OUT" >&2
  exit 1
}

if OVERRIDE_OUT="$(cd "$SECONDARY" && \
    AL_ROOT="$SECONDARY" AL_STOP="$SANDBOX/missing-shared-stop" \
    AL_PROGRAM_STOP="$SANDBOX/missing-program-stop" \
    AL_BACKLOG_JSONL="$SECONDARY_PROGRAM_BACKLOG" \
    bash scripts/auto-loop/discover.sh set-status FS-B0 done 2>&1)"; then
  printf 'program-control-stop-selftest: FAIL (STOP overrides bypassed canonical sentinel)\n' >&2
  exit 1
fi
printf '%s\n' "$OVERRIDE_OUT" | grep -q 'STOP sentinel present' || {
  printf 'program-control-stop-selftest: FAIL (override bypass did not report STOP: %s)\n' \
    "$OVERRIDE_OUT" >&2
  exit 1
}
[ "$SECONDARY_PROGRAM_BEFORE" = "$(shasum -a 256 "$SECONDARY_PROGRAM_BACKLOG" | awk '{print $1}')" ] || {
  printf 'program-control-stop-selftest: FAIL (override bypass changed program backlog)\n' >&2
  exit 1
}

SECONDARY_CLASSIC_BACKLOG="$SECONDARY/docs/auto-loop/backlog.jsonl"
if ! (cd "$SECONDARY" && AL_ROOT="$SECONDARY" \
    bash scripts/auto-loop/discover.sh set-status AL-000 done >/dev/null); then
  printf 'program-control-stop-selftest: FAIL (program STOP leaked into classic loop)\n' >&2
  exit 1
fi
touch "$ROOT/docs/auto-loop/STOP"
SECONDARY_CLASSIC_BEFORE="$(shasum -a 256 "$SECONDARY_CLASSIC_BACKLOG" | awk '{print $1}')"
if SECONDARY_CLASSIC_OUT="$(cd "$SECONDARY" && AL_ROOT="$SECONDARY" \
    bash scripts/auto-loop/discover.sh set-status AL-000 ready 2>&1)"; then
  printf 'program-control-stop-selftest: FAIL (secondary worktree missed shared STOP)\n' >&2
  exit 1
fi
[ "$SECONDARY_CLASSIC_BEFORE" = "$(shasum -a 256 "$SECONDARY_CLASSIC_BACKLOG" | awk '{print $1}')" ] || {
  printf 'program-control-stop-selftest: FAIL (secondary worktree changed classic backlog)\n' >&2
  exit 1
}
printf '%s\n' "$SECONDARY_CLASSIC_OUT" | grep -q 'STOP sentinel present' || {
  printf 'program-control-stop-selftest: FAIL (secondary shared STOP not reported: %s)\n' \
    "$SECONDARY_CLASSIC_OUT" >&2
  exit 1
}

if CONTROL_OUT="$(cd "$SECONDARY" && bash scripts/first-stranger/codex-lane.sh --next 2>&1)"; then
  printf 'program-control-stop-selftest: FAIL (codex-lane ran while stopped)\n' >&2
  exit 1
fi
printf '%s\n' "$CONTROL_OUT" | grep -q 'STOP sentinel present' || {
  printf 'program-control-stop-selftest: FAIL (codex-lane did not report STOP: %s)\n' "$CONTROL_OUT" >&2
  exit 1
}

STATUS_BEFORE="$(shasum -a 256 "$ROOT/docs/first-stranger-program/STATUS.md" | awk '{print $1}')"
STATUS_OUT="$(cd "$SECONDARY" && bash scripts/first-stranger/status.sh)"
STATUS_AFTER="$(shasum -a 256 "$ROOT/docs/first-stranger-program/STATUS.md" | awk '{print $1}')"
[ "$STATUS_BEFORE" = "$STATUS_AFTER" ] || {
  printf 'program-control-stop-selftest: FAIL (status dashboard changed while stopped)\n' >&2
  exit 1
}
printf '%s\n' "$STATUS_OUT" | grep -q 'STOP sentinel present' || {
  printf 'program-control-stop-selftest: FAIL (status did not report STOP: %s)\n' "$STATUS_OUT" >&2
  exit 1
}

mkdir -p "$ROOT/bin" "$ROOT/fake-home"
cat >"$ROOT/bin/launchctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$ROOT/bin/launchctl"
cat >"$ROOT/bin/claude" <<EOF
#!/usr/bin/env bash
touch "$SANDBOX/claude-invoked"
EOF
chmod +x "$ROOT/bin/claude"
NIGHTLY_OUT="$(cd "$SECONDARY" && HOME="$ROOT/fake-home" \
  MOSH_STRANGER_LOGDIR="$SANDBOX/nightly-logs" CLAUDE_BIN="$ROOT/bin/claude" \
  bash scripts/first-stranger/nightly.sh --once 2>&1)"
printf '%s\n' "$NIGHTLY_OUT" | grep -q 'STOP sentinel present' || {
  printf 'program-control-stop-selftest: FAIL (nightly did not report primary STOP: %s)\n' \
    "$NIGHTLY_OUT" >&2
  exit 1
}
[ ! -e "$SANDBOX/claude-invoked" ] || {
  printf 'program-control-stop-selftest: FAIL (nightly invoked Claude while stopped)\n' >&2
  exit 1
}
if INSTALL_OUT="$(cd "$SECONDARY" && HOME="$ROOT/fake-home" \
    PATH="$ROOT/bin:$PATH" bash scripts/first-stranger/install-launchd.sh 2>&1)"; then
  printf 'program-control-stop-selftest: FAIL (launchd installer ran while stopped)\n' >&2
  exit 1
fi
printf '%s\n' "$INSTALL_OUT" | grep -q 'STOP sentinel present' || {
  printf 'program-control-stop-selftest: FAIL (launchd installer did not report STOP: %s)\n' "$INSTALL_OUT" >&2
  exit 1
}
[ ! -e "$ROOT/fake-home/Library/LaunchAgents/com.mosh.stranger-loop.plist" ] || {
  printf 'program-control-stop-selftest: FAIL (launchd installer wrote a plist while stopped)\n' >&2
  exit 1
}

rm -f "$ROOT/docs/first-stranger-program/STOP" "$ROOT/docs/auto-loop/STOP" \
  "$SANDBOX/claude-invoked"
REMOVED_WORKFLOW_OUT="$(cd "$SECONDARY" && HOME="$ROOT/fake-home" \
  MOSH_STRANGER_LOGDIR="$SANDBOX/nightly-logs" CLAUDE_BIN="$ROOT/bin/claude" \
  bash scripts/first-stranger/nightly.sh --once 2>&1)"
printf '%s\n' "$REMOVED_WORKFLOW_OUT" | grep -q 'workflow removed' || {
  printf 'program-control-stop-selftest: FAIL (missing workflow did not fail closed: %s)\n' \
    "$REMOVED_WORKFLOW_OUT" >&2
  exit 1
}
[ ! -e "$SANDBOX/claude-invoked" ] || {
  printf 'program-control-stop-selftest: FAIL (missing workflow delegated by name)\n' >&2
  exit 1
}

printf 'program-control-stop-selftest: PASS\n'
