#!/usr/bin/env bash
# program-stop-selftest.sh — prove a sibling program STOP reaches every shared
# merge-queue mutation boundary, including a finalize that is already in flight.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MERGE_ONE="$SELF_DIR/merge-one.sh"
GATE="$SELF_DIR/gate.sh"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/mosh-program-stop.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

FAKE_ROOT="$SANDBOX/repo"
FAKE_REMOTE="$SANDBOX/origin.git"
PROGRAM_STOP="$FAKE_ROOT/docs/first-stranger-program/STOP"
GH_MARKER="$SANDBOX/gh-invoked"
GH_MODE="$SANDBOX/gh-mode"
PR_HEAD="$SANDBOX/pr-head"
GIT_MODE="$SANDBOX/git-mode"
GIT_FETCH_COUNT="$SANDBOX/git-fetch-count"
GIT_MARKER="$SANDBOX/git-invoked"
REAL_GIT="$(command -v git)"
mkdir -p "$FAKE_ROOT/docs/first-stranger-program" "$SANDBOX/bin"
git init -q "$FAKE_ROOT"
git init --bare -q "$FAKE_REMOTE"
git -C "$FAKE_ROOT" config user.email "program-stop-selftest@invalid"
git -C "$FAKE_ROOT" config user.name "program-stop-selftest"
touch "$FAKE_ROOT/.seed"
git -C "$FAKE_ROOT" add .seed
git -C "$FAKE_ROOT" commit -qm seed
git -C "$FAKE_ROOT" remote add origin "$FAKE_REMOTE"
git -C "$FAKE_ROOT" push -q origin HEAD:main
touch "$PROGRAM_STOP"

cat >"$SANDBOX/bin/gh" <<EOF
#!/usr/bin/env bash
mode="\$(cat "$GH_MODE" 2>/dev/null || true)"
if [ "\${1:-} \${2:-}" = "pr view" ]; then
  cat "$PR_HEAD"
  exit 0
fi
if [ "\${1:-} \${2:-}" = "pr checks" ]; then
  [ "\$mode" = "stop-on-check" ] && touch "$PROGRAM_STOP"
  printf '[{"name":"cheap gate","state":"SUCCESS"}]\n'
  exit 0
fi
printf '%s\n' "\$*" >>"$GH_MARKER"
[ "\$mode" = "stop-on-merge" ] && [ "\${1:-} \${2:-}" = "pr merge" ] && {
  touch "$PROGRAM_STOP"
  exit 0
}
[ "\$mode" = "stop-on-mutation" ] && touch "$PROGRAM_STOP"
[ "\$mode" = "stop-on-ready" ] && [ "\${1:-} \${2:-}" = "pr ready" ] && touch "$PROGRAM_STOP"
[ "\$mode" = "post-fetch-stop" ] && exit 0
exit 97
EOF
chmod +x "$SANDBOX/bin/gh"

cat >"$SANDBOX/bin/git" <<EOF
#!/usr/bin/env bash
if [ "\$(cat "$GIT_MODE" 2>/dev/null || true)" = "post-fetch-stop" ] &&
   [ "\${1:-}" = "-C" ] && [ "\${3:-}" = "fetch" ] &&
   [ "\${4:-}" = "--quiet" ] && [ "\${5:-}" = "origin" ] &&
   [ "\${6:-}" = "main" ]; then
  n="\$(cat "$GIT_FETCH_COUNT" 2>/dev/null || printf '0')"
  n="\$((n + 1))"
  printf '%s\n' "\$n" >"$GIT_FETCH_COUNT"
  "$REAL_GIT" "\$@"
  rc=\$?
  [ "\$n" = "2" ] && touch "$PROGRAM_STOP"
  exit "\$rc"
fi
if [ "\$(cat "$GIT_MODE" 2>/dev/null || true)" = "cleanup-stop" ]; then
  printf '%s\n' "\$*" >>"$GIT_MARKER"
  if [ "\${1:-}" = "-C" ] && [ "\${3:-} \${4:-}" = "worktree remove" ]; then
    "$REAL_GIT" "\$@" || true
    touch "$PROGRAM_STOP"
    exit 1
  fi
fi
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$SANDBOX/bin/git"

expect_stopped() {
  local phase="$1"
  shift
  local out
  out="$(PATH="$SANDBOX/bin:$PATH" AL_ROOT="$FAKE_ROOT" AL_PROGRAM_STOP="$PROGRAM_STOP" \
    "$MERGE_ONE" "$@")"
  if ! printf '%s\n' "$out" | jq -e --arg phase "$phase" \
      '.phase == $phase and .stopped == true and (.reason | startswith("STOP sentinel present"))' \
      >/dev/null; then
    printf 'program-stop-selftest: FAIL (%s returned %s)\n' "$phase" "$out" >&2
    exit 1
  fi
}

expect_stopped prepare prepare lane 1 main
expect_stopped finalize finalize lane 1 deadbeef deadbeef
expect_stopped reject reject lane 1 held "program stopped"
expect_stopped route-owner route-owner lane 1 T "gate pass" "review pass" 0

if [ -e "$GH_MARKER" ]; then
  printf 'program-stop-selftest: FAIL (a stopped path invoked gh)\n' >&2
  exit 1
fi

expect_stopped_without_context() {
  local phase="$1"
  shift
  local out
  out="$(PATH="$SANDBOX/bin:$PATH" AL_ROOT="$FAKE_ROOT" "$MERGE_ONE" "$@")"
  if ! printf '%s\n' "$out" | jq -e --arg phase "$phase" \
      '.phase == $phase and .stopped == true and (.reason | startswith("STOP sentinel present"))' \
      >/dev/null; then
    printf 'program-stop-selftest: FAIL (direct %s returned %s)\n' "$phase" "$out" >&2
    exit 1
  fi
}

expect_stopped_without_context prepare prepare fs-b0 1 main
expect_stopped_without_context finalize finalize fs-b0 1 deadbeef deadbeef
expect_stopped_without_context reject reject fs-b0 1 held "program stopped"
expect_stopped_without_context route-owner route-owner fs-b0 1 T "gate pass" "review pass" 0

expect_program_gate_stopped() {
  local label="$1" worktree="$2" out
  if out="$(AL_ROOT="$FAKE_ROOT" "$GATE" cheap "$worktree" main)"; then
    printf 'program-stop-selftest: FAIL (%s gate ignored STOP)\n' "$label" >&2
    exit 1
  fi
  if ! printf '%s\n' "$out" | jq -e \
      '.pass == false and .stopped == true and (.reason | startswith("STOP sentinel present"))' \
      >/dev/null; then
    printf 'program-stop-selftest: FAIL (%s gate returned %s)\n' "$label" "$out" >&2
    exit 1
  fi
}

DIRECT_GATE_WT="$SANDBOX/mosh-fs-direct"
mkdir -p "$DIRECT_GATE_WT"
expect_program_gate_stopped "documented path" "$DIRECT_GATE_WT"

DIRECT_BRANCH_WT="$SANDBOX/manual-program-lane"
git -C "$FAKE_ROOT" worktree add --quiet -b codex/fs-direct \
  "$DIRECT_BRANCH_WT" HEAD
expect_program_gate_stopped "documented branch" "$DIRECT_BRANCH_WT"

rm -f "$PROGRAM_STOP"
printf 'stop-on-check\n' >"$GH_MODE"
BASE_SHA="$(git -C "$FAKE_ROOT" rev-parse HEAD)"
printf '%s\n' "$BASE_SHA" >"$PR_HEAD"
MIDFLIGHT_OUT="$(PATH="$SANDBOX/bin:$PATH" AL_ROOT="$FAKE_ROOT" \
  AL_PROGRAM_STOP="$PROGRAM_STOP" AL_CHECK_TIMEOUT_S=2 AL_CHECK_POLL_S=1 \
  "$MERGE_ONE" finalize lane 1 "$BASE_SHA" "$BASE_SHA")"
if ! printf '%s\n' "$MIDFLIGHT_OUT" | jq -e \
    '.phase == "finalize" and .stopped == true and (.reason | startswith("STOP sentinel present"))' \
    >/dev/null; then
  printf 'program-stop-selftest: FAIL (mid-flight finalize returned %s)\n' "$MIDFLIGHT_OUT" >&2
  exit 1
fi
if [ -e "$GH_MARKER" ]; then
  printf 'program-stop-selftest: FAIL (mid-flight STOP allowed gh mutation: %s)\n' \
    "$(tr '\n' ',' <"$GH_MARKER")" >&2
  exit 1
fi

expect_one_mutation_then_stop() {
  local phase="$1" mode="$2"
  shift 2
  rm -f "$PROGRAM_STOP" "$GH_MARKER"
  printf '%s\n' "$mode" >"$GH_MODE"
  local out
  out="$(PATH="$SANDBOX/bin:$PATH" AL_ROOT="$FAKE_ROOT" AL_PROGRAM_STOP="$PROGRAM_STOP" \
    AL_CHECK_TIMEOUT_S=2 AL_CHECK_POLL_S=1 "$MERGE_ONE" "$@")"
  if ! printf '%s\n' "$out" | jq -e --arg phase "$phase" \
      '.phase == $phase and .stopped == true and (.reason | startswith("STOP sentinel present"))' \
      >/dev/null; then
    printf 'program-stop-selftest: FAIL (%s mid-mutation returned %s)\n' "$phase" "$out" >&2
    exit 1
  fi
  if [ "$(wc -l <"$GH_MARKER" | tr -d ' ')" != "1" ]; then
    printf 'program-stop-selftest: FAIL (%s continued after STOP: %s)\n' \
      "$phase" "$(tr '\n' ',' <"$GH_MARKER")" >&2
    exit 1
  fi
}

expect_one_mutation_then_stop finalize stop-on-ready finalize lane 1 "$BASE_SHA" "$BASE_SHA"
expect_one_mutation_then_stop reject stop-on-mutation reject lane 1 held "program stopped"
expect_one_mutation_then_stop route-owner stop-on-mutation route-owner lane 1 T "gate pass" "review pass" 0

rm -f "$PROGRAM_STOP" "$GH_MARKER" "$FAKE_ROOT/docs/auto-loop/LEDGER.md"
printf 'stop-on-merge\n' >"$GH_MODE"
POST_MERGE_OUT="$(PATH="$SANDBOX/bin:$PATH" AL_ROOT="$FAKE_ROOT" \
  AL_PROGRAM_STOP="$PROGRAM_STOP" AL_CHECK_TIMEOUT_S=2 AL_CHECK_POLL_S=1 \
  "$MERGE_ONE" finalize lane 1 "$BASE_SHA" "$BASE_SHA")"
if ! printf '%s\n' "$POST_MERGE_OUT" | jq -e \
    '.phase == "finalize" and .merged == true and .stopped == true' >/dev/null; then
  printf 'program-stop-selftest: FAIL (post-merge STOP returned %s)\n' "$POST_MERGE_OUT" >&2
  exit 1
fi
[ ! -e "$FAKE_ROOT/docs/auto-loop/LEDGER.md" ] || {
  printf 'program-stop-selftest: FAIL (post-merge STOP still wrote the ledger)\n' >&2
  exit 1
}
grep -F -- "--match-head-commit $BASE_SHA" "$GH_MARKER" >/dev/null || {
  printf 'program-stop-selftest: FAIL (merge omitted atomic head guard)\n' >&2
  exit 1
}

rm -f "$PROGRAM_STOP" "$GH_MARKER" "$FAKE_ROOT/docs/auto-loop/LEDGER.md" \
  "$GIT_FETCH_COUNT"
printf 'post-fetch-stop\n' >"$GH_MODE"
printf 'post-fetch-stop\n' >"$GIT_MODE"
POST_FETCH_OUT="$(PATH="$SANDBOX/bin:$PATH" AL_ROOT="$FAKE_ROOT" \
  AL_PROGRAM_STOP="$PROGRAM_STOP" AL_CHECK_TIMEOUT_S=2 AL_CHECK_POLL_S=1 \
  "$MERGE_ONE" finalize lane 1 "$BASE_SHA" "$BASE_SHA")"
if ! printf '%s\n' "$POST_FETCH_OUT" | jq -e \
    '.phase == "finalize" and .merged == true and .stopped == true' >/dev/null; then
  printf 'program-stop-selftest: FAIL (post-fetch STOP returned %s)\n' "$POST_FETCH_OUT" >&2
  exit 1
fi
[ ! -e "$FAKE_ROOT/docs/auto-loop/LEDGER.md" ] || {
  printf 'program-stop-selftest: FAIL (post-fetch STOP still wrote the ledger)\n' >&2
  exit 1
}
rm -f "$GIT_MODE"

rm -f "$PROGRAM_STOP" "$GH_MARKER" "$GIT_MARKER"
printf 'post-fetch-stop\n' >"$GH_MODE"
printf 'cleanup-stop\n' >"$GIT_MODE"
CLEANUP_OUT="$(PATH="$SANDBOX/bin:$PATH" AL_ROOT="$FAKE_ROOT" \
  AL_PROGRAM_STOP="$PROGRAM_STOP" AL_CHECK_TIMEOUT_S=2 AL_CHECK_POLL_S=1 \
  "$MERGE_ONE" finalize lane 1 "$BASE_SHA" "$BASE_SHA")"
if ! printf '%s\n' "$CLEANUP_OUT" | jq -e \
    '.phase == "finalize" and .merged == true and .stopped == true' >/dev/null; then
  printf 'program-stop-selftest: FAIL (cleanup STOP returned %s)\n' "$CLEANUP_OUT" >&2
  exit 1
fi
if grep -Eq 'branch -D|push origin --delete' "$GIT_MARKER"; then
  printf 'program-stop-selftest: FAIL (cleanup continued after STOP: %s)\n' \
    "$(tr '\n' ',' <"$GIT_MARKER")" >&2
  exit 1
fi
rm -f "$GIT_MODE"

PREPARE_LOOP="$SANDBOX/prepare-loop"
PREPARE_WT="$FAKE_ROOT/.claude/worktrees/auto-prepare"
mkdir -p "$PREPARE_LOOP" "$(dirname "$PREPARE_WT")"
cp "$SELF_DIR/lib.sh" "$SELF_DIR/classify.sh" "$SELF_DIR/merge-one.sh" "$PREPARE_LOOP/"
cat >"$PREPARE_LOOP/gate.sh" <<EOF
#!/usr/bin/env bash
touch "$PROGRAM_STOP"
printf '%s\n' '{"class":"cheap","pass":true,"steps":[],"selftest":[]}'
EOF
chmod +x "$PREPARE_LOOP/gate.sh"

rm -f "$PROGRAM_STOP"
git -C "$FAKE_ROOT" branch claude/auto-prepare "$BASE_SHA"
git -C "$FAKE_ROOT" worktree add --quiet "$PREPARE_WT" \
  claude/auto-prepare
mkdir -p "$PREPARE_WT/docs"
printf 'prepare probe\n' >"$PREPARE_WT/docs/prepare-probe.md"
git -C "$PREPARE_WT" add docs/prepare-probe.md
git -C "$PREPARE_WT" commit -qm "prepare probe"
[ "$(git -C "$PREPARE_WT" symbolic-ref HEAD)" = \
  "refs/heads/claude/auto-prepare" ] || {
  printf 'program-stop-selftest: FAIL (fixture HEAD is not the feature ref)\n' >&2
  exit 1
}
git -C "$PREPARE_WT" push -q origin HEAD:refs/heads/claude/auto-prepare
git -C "$PREPARE_WT" fetch -q origin \
  refs/heads/claude/auto-prepare:refs/remotes/origin/claude/auto-prepare
git -C "$PREPARE_WT" branch \
  --set-upstream-to=origin/claude/auto-prepare >/dev/null
[ "$(git -C "$PREPARE_WT" rev-parse '@{upstream}')" = \
  "$(git --git-dir="$FAKE_REMOTE" rev-parse refs/heads/claude/auto-prepare)" ] || {
  printf 'program-stop-selftest: FAIL (fixture upstream does not match remote feature)\n' >&2
  exit 1
}
[ "$(git --git-dir="$FAKE_REMOTE" rev-parse refs/heads/main)" = "$BASE_SHA" ] || {
  printf 'program-stop-selftest: FAIL (fixture push moved remote main)\n' >&2
  exit 1
}

PREPARE_OUT="$(AL_ROOT="$FAKE_ROOT" AL_PROGRAM_STOP="$PROGRAM_STOP" \
  "$PREPARE_LOOP/merge-one.sh" prepare prepare 1 main)"
if ! printf '%s\n' "$PREPARE_OUT" | jq -e \
    '.phase == "prepare" and .stopped == true and (.reason | startswith("STOP sentinel present"))' \
    >/dev/null; then
  printf 'program-stop-selftest: FAIL (mid-gate prepare returned %s)\n' "$PREPARE_OUT" >&2
  exit 1
fi

printf 'program-stop-selftest: PASS\n'
