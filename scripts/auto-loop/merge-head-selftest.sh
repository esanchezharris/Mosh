#!/usr/bin/env bash
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/mosh-merge-head.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

ROOT="$SANDBOX/repo"
REMOTE="$SANDBOX/origin.git"
BIN="$SANDBOX/bin"
PR_HEAD="$SANDBOX/pr-head"
GH_MODE="$SANDBOX/gh-mode"
GH_MARKER="$SANDBOX/gh-mutations"
GIT_MODE="$SANDBOX/git-mode"
GATE_MARKER="$SANDBOX/gate-invoked"
HOLD_MARKER="$SANDBOX/finalize-holding"
REAL_GIT="$(command -v git)"
NO_FLOCK_BIN="$SANDBOX/no-flock-bin"

mkdir -p "$ROOT/docs/auto-loop" "$BIN" "$NO_FLOCK_BIN"
ln -s "$(command -v jq)" "$NO_FLOCK_BIN/jq"
NO_FLOCK_PATH="$BIN:$NO_FLOCK_BIN:/usr/bin:/bin:/usr/sbin:/sbin"
cp "$SELF_DIR/../../.gitignore" "$ROOT/.gitignore"
git init -q "$ROOT"
git init --bare -q "$REMOTE"
git -C "$ROOT" config user.email "merge-head-selftest@invalid"
git -C "$ROOT" config user.name "merge-head-selftest"
touch "$ROOT/.seed"
git -C "$ROOT" add .seed
git -C "$ROOT" commit -qm seed
git -C "$ROOT" remote add origin "$REMOTE"
git -C "$ROOT" push -q origin HEAD:main
BASE_SHA="$(git -C "$ROOT" rev-parse HEAD)"

SECONDARY="$ROOT/.claude/worktrees/secondary"
mkdir -p "$(dirname "$SECONDARY")"
git -C "$ROOT" worktree add -qb secondary "$SECONDARY" main

cat >"$BIN/gh" <<EOF
#!/usr/bin/env bash
mode="\$(cat "$GH_MODE" 2>/dev/null || true)"
if [ "\${1:-} \${2:-}" = "pr view" ]; then
  if [ "\$mode" = "hold-first" ] && [ ! -e "$HOLD_MARKER" ]; then
    touch "$HOLD_MARKER"
    sleep 3
  fi
  cat "$PR_HEAD"
  exit 0
fi
if [ "\${1:-} \${2:-}" = "pr checks" ]; then
  [ "\$mode" = "move-on-check" ] && printf '%s\n' moved-head >"$PR_HEAD"
  printf '[{"name":"cheap gate","state":"SUCCESS"}]\n'
  exit 0
fi
printf '%s\n' "\$*" >>"$GH_MARKER"
exit 97
EOF
chmod +x "$BIN/gh"

cat >"$BIN/git" <<EOF
#!/usr/bin/env bash
if [ "\$(cat "$GIT_MODE" 2>/dev/null || true)" = "push-fail" ] &&
   [ "\${1:-}" = "-C" ] && [ "\${3:-}" = "push" ] &&
   [ "\${4:-}" = "--force-with-lease" ]; then
  exit 1
fi
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$BIN/git"

expect_head_rejected() {
  local mode="$1" initial_head="$2" out
  rm -f "$GH_MARKER"
  printf '%s\n' "$mode" >"$GH_MODE"
  printf '%s\n' "$initial_head" >"$PR_HEAD"
  out="$(PATH="$NO_FLOCK_PATH" AL_ROOT="$ROOT" AL_CHECK_TIMEOUT_S=2 \
    AL_CHECK_POLL_S=1 "$SELF_DIR/merge-one.sh" finalize lane 1 \
    "$BASE_SHA" "$BASE_SHA")"
  if ! printf '%s\n' "$out" | jq -e \
      '.phase == "finalize" and .merged == false and (.reason | contains("PR head"))' \
      >/dev/null; then
    printf 'merge-head-selftest: FAIL (head mismatch returned %s)\n' "$out" >&2
    exit 1
  fi
  [ ! -e "$GH_MARKER" ] || {
    printf 'merge-head-selftest: FAIL (head mismatch allowed mutation)\n' >&2
    exit 1
  }
}

expect_head_rejected "" moved-head
expect_head_rejected move-on-check "$BASE_SHA"

rm -f "$GH_MARKER" "$HOLD_MARKER"
printf '%s\n' hold-first >"$GH_MODE"
printf '%s\n' moved-head >"$PR_HEAD"
FIRST_OUT="$SANDBOX/first-finalize.out"
PATH="$NO_FLOCK_PATH" AL_ROOT="$ROOT" AL_CHECK_TIMEOUT_S=2 \
  AL_CHECK_POLL_S=1 "$SELF_DIR/merge-one.sh" finalize lane 1 \
  "$BASE_SHA" "$BASE_SHA" >"$FIRST_OUT" &
FIRST_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  [ -e "$HOLD_MARKER" ] && break
  sleep 0.1
done
if [ ! -e "$HOLD_MARKER" ]; then
  wait "$FIRST_PID" || true
  printf 'merge-head-selftest: FAIL (portable finalize never acquired lock: %s)\n' \
    "$(cat "$FIRST_OUT")" >&2
  exit 1
fi
SECOND_OUT="$(PATH="$NO_FLOCK_PATH" AL_ROOT="$SECONDARY" \
  "$SELF_DIR/merge-one.sh" finalize lane 2 "$BASE_SHA" "$BASE_SHA")"
if ! printf '%s\n' "$SECOND_OUT" | jq -e \
    '.phase == "finalize" and .merged == false and (.reason | contains("another finalize"))' \
    >/dev/null; then
  printf 'merge-head-selftest: FAIL (concurrent finalize returned %s)\n' "$SECOND_OUT" >&2
  kill "$FIRST_PID" 2>/dev/null || true
  wait "$FIRST_PID" 2>/dev/null || true
  exit 1
fi
wait "$FIRST_PID"
if ! jq -e \
    '.phase == "finalize" and .merged == false and (.reason | contains("PR head"))' \
    "$FIRST_OUT" >/dev/null; then
  printf 'merge-head-selftest: FAIL (first finalize returned %s)\n' \
    "$(cat "$FIRST_OUT")" >&2
  exit 1
fi
[ ! -e "$ROOT/docs/auto-loop/.merge-queue.lock" ] || {
  printf 'merge-head-selftest: FAIL (portable lock was not released)\n' >&2
  exit 1
}

git -C "$ROOT" check-ignore -q docs/auto-loop/.merge-queue.lock || {
  printf 'merge-head-selftest: FAIL (portable lock is not machine-local)\n' >&2
  exit 1
}
git -C "$ROOT" check-ignore -q docs/auto-loop/shlock12345 || {
  printf 'merge-head-selftest: FAIL (shlock scratch is not machine-local)\n' >&2
  exit 1
}
git -C "$ROOT" check-ignore -q docs/auto-loop/shlock12345-2 || {
  printf 'merge-head-selftest: FAIL (shlock stale scratch is not machine-local)\n' >&2
  exit 1
}
(exit 0) &
STALE_PID=$!
wait "$STALE_PID"
printf '%s\n' "$STALE_PID" >"$ROOT/docs/auto-loop/.merge-queue.lock"
expect_head_rejected "" moved-head
[ ! -e "$ROOT/docs/auto-loop/.merge-queue.lock" ] || {
  printf 'merge-head-selftest: FAIL (stale lock was not reclaimed)\n' >&2
  exit 1
}

LOOP="$SANDBOX/loop"
WT="$ROOT/.claude/worktrees/auto-prepare"
mkdir -p "$LOOP" "$(dirname "$WT")"
cp "$SELF_DIR/lib.sh" "$SELF_DIR/classify.sh" "$SELF_DIR/merge-one.sh" "$LOOP/"
cat >"$LOOP/gate.sh" <<EOF
#!/usr/bin/env bash
touch "$GATE_MARKER"
printf '%s\n' '{"class":"cheap","pass":true,"steps":[],"selftest":[]}'
EOF
chmod +x "$LOOP/gate.sh"

git -C "$ROOT" worktree add -qb claude/auto-prepare "$WT" main
mkdir -p "$WT/docs"
printf 'prepare probe\n' >"$WT/docs/prepare-probe.md"
git -C "$WT" add docs/prepare-probe.md
git -C "$WT" commit -qm "prepare probe"
git -C "$WT" push -qu origin HEAD:refs/heads/claude/auto-prepare
[ "$(git --git-dir="$REMOTE" rev-parse refs/heads/main)" = "$BASE_SHA" ] || {
  printf 'merge-head-selftest: FAIL (fixture push moved remote main)\n' >&2
  exit 1
}

printf 'push-fail\n' >"$GIT_MODE"
PUSH_OUT="$(PATH="$BIN:$PATH" AL_ROOT="$ROOT" \
  "$LOOP/merge-one.sh" prepare prepare 1 main)"
if ! printf '%s\n' "$PUSH_OUT" | jq -e \
    '.phase == "prepare" and .ready == false and (.reason | contains("push --force-with-lease failed"))' \
    >/dev/null; then
  printf 'merge-head-selftest: FAIL (failed push returned %s)\n' "$PUSH_OUT" >&2
  exit 1
fi
[ ! -e "$GATE_MARKER" ] || {
  printf 'merge-head-selftest: FAIL (failed push still ran the gate)\n' >&2
  exit 1
}

printf 'merge-head-selftest: PASS\n'
