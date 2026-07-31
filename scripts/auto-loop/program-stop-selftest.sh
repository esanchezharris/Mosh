#!/usr/bin/env bash
# program-stop-selftest.sh — prove a sibling program STOP reaches every shared
# merge-queue mutation boundary, including a finalize that is already in flight.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MERGE_ONE="$SELF_DIR/merge-one.sh"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/mosh-program-stop.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

FAKE_ROOT="$SANDBOX/repo"
FAKE_REMOTE="$SANDBOX/origin.git"
PROGRAM_STOP="$FAKE_ROOT/docs/first-stranger-program/STOP"
GH_MARKER="$SANDBOX/gh-invoked"
GH_MODE="$SANDBOX/gh-mode"
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
exit 97
EOF
chmod +x "$SANDBOX/bin/gh"

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
expect_stopped finalize finalize lane 1 deadbeef
expect_stopped reject reject lane 1 held "program stopped"
expect_stopped route-owner route-owner lane 1 T "gate pass" "review pass" 0

if [ -e "$GH_MARKER" ]; then
  printf 'program-stop-selftest: FAIL (a stopped path invoked gh)\n' >&2
  exit 1
fi

rm -f "$PROGRAM_STOP"
printf 'stop-on-check\n' >"$GH_MODE"
BASE_SHA="$(git -C "$FAKE_ROOT" rev-parse HEAD)"
MIDFLIGHT_OUT="$(PATH="$SANDBOX/bin:$PATH" AL_ROOT="$FAKE_ROOT" \
  AL_PROGRAM_STOP="$PROGRAM_STOP" AL_CHECK_TIMEOUT_S=2 AL_CHECK_POLL_S=1 \
  "$MERGE_ONE" finalize lane 1 "$BASE_SHA")"
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

expect_one_mutation_then_stop finalize stop-on-ready finalize lane 1 "$BASE_SHA"
expect_one_mutation_then_stop reject stop-on-mutation reject lane 1 held "program stopped"
expect_one_mutation_then_stop route-owner stop-on-mutation route-owner lane 1 T "gate pass" "review pass" 0

rm -f "$PROGRAM_STOP" "$GH_MARKER" "$FAKE_ROOT/docs/auto-loop/LEDGER.md"
printf 'stop-on-merge\n' >"$GH_MODE"
POST_MERGE_OUT="$(PATH="$SANDBOX/bin:$PATH" AL_ROOT="$FAKE_ROOT" \
  AL_PROGRAM_STOP="$PROGRAM_STOP" AL_CHECK_TIMEOUT_S=2 AL_CHECK_POLL_S=1 \
  "$MERGE_ONE" finalize lane 1 "$BASE_SHA")"
if ! printf '%s\n' "$POST_MERGE_OUT" | jq -e \
    '.phase == "finalize" and .merged == true and .stopped == true' >/dev/null; then
  printf 'program-stop-selftest: FAIL (post-merge STOP returned %s)\n' "$POST_MERGE_OUT" >&2
  exit 1
fi
[ ! -e "$FAKE_ROOT/docs/auto-loop/LEDGER.md" ] || {
  printf 'program-stop-selftest: FAIL (post-merge STOP still wrote the ledger)\n' >&2
  exit 1
}

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
git -C "$FAKE_ROOT" worktree add -qb claude/auto-prepare "$PREPARE_WT" main
mkdir -p "$PREPARE_WT/docs"
printf 'prepare probe\n' >"$PREPARE_WT/docs/prepare-probe.md"
git -C "$PREPARE_WT" add docs/prepare-probe.md
git -C "$PREPARE_WT" commit -qm "prepare probe"
git -C "$PREPARE_WT" push -qu origin HEAD

PREPARE_OUT="$(AL_ROOT="$FAKE_ROOT" AL_PROGRAM_STOP="$PROGRAM_STOP" \
  "$PREPARE_LOOP/merge-one.sh" prepare prepare 1 main)"
if ! printf '%s\n' "$PREPARE_OUT" | jq -e \
    '.phase == "prepare" and .stopped == true and (.reason | startswith("STOP sentinel present"))' \
    >/dev/null; then
  printf 'program-stop-selftest: FAIL (mid-gate prepare returned %s)\n' "$PREPARE_OUT" >&2
  exit 1
fi

CONTROL_ROOT="$SANDBOX/control-root"
mkdir -p "$CONTROL_ROOT/scripts/first-stranger" "$CONTROL_ROOT/docs/first-stranger-program"
git init -q "$CONTROL_ROOT"
cp "$SELF_DIR/../first-stranger/codex-lane.sh" "$CONTROL_ROOT/scripts/first-stranger/"
cp "$SELF_DIR/../first-stranger/status.sh" "$CONTROL_ROOT/scripts/first-stranger/"
cp "$SELF_DIR/../first-stranger/nightly.sh" "$CONTROL_ROOT/scripts/first-stranger/"
cp "$SELF_DIR/../first-stranger/install-launchd.sh" "$CONTROL_ROOT/scripts/first-stranger/"
touch "$CONTROL_ROOT/docs/first-stranger-program/STOP"
printf 'preserved status\n' >"$CONTROL_ROOT/docs/first-stranger-program/STATUS.md"

if CONTROL_OUT="$(cd "$CONTROL_ROOT" && bash scripts/first-stranger/codex-lane.sh --next 2>&1)"; then
  printf 'program-stop-selftest: FAIL (codex-lane ran while stopped)\n' >&2
  exit 1
fi
printf '%s\n' "$CONTROL_OUT" | grep -q 'STOP sentinel present' || {
  printf 'program-stop-selftest: FAIL (codex-lane did not report STOP: %s)\n' "$CONTROL_OUT" >&2
  exit 1
}

STATUS_BEFORE="$(shasum -a 256 "$CONTROL_ROOT/docs/first-stranger-program/STATUS.md" | awk '{print $1}')"
STATUS_OUT="$(cd "$CONTROL_ROOT" && bash scripts/first-stranger/status.sh)"
STATUS_AFTER="$(shasum -a 256 "$CONTROL_ROOT/docs/first-stranger-program/STATUS.md" | awk '{print $1}')"
[ "$STATUS_BEFORE" = "$STATUS_AFTER" ] || {
  printf 'program-stop-selftest: FAIL (status dashboard changed while stopped)\n' >&2
  exit 1
}
printf '%s\n' "$STATUS_OUT" | grep -q 'STOP sentinel present' || {
  printf 'program-stop-selftest: FAIL (status did not report STOP: %s)\n' "$STATUS_OUT" >&2
  exit 1
}

mkdir -p "$CONTROL_ROOT/bin" "$CONTROL_ROOT/fake-home"
cat >"$CONTROL_ROOT/bin/launchctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$CONTROL_ROOT/bin/launchctl"
if INSTALL_OUT="$(cd "$CONTROL_ROOT" && HOME="$CONTROL_ROOT/fake-home" \
    PATH="$CONTROL_ROOT/bin:$PATH" bash scripts/first-stranger/install-launchd.sh 2>&1)"; then
  printf 'program-stop-selftest: FAIL (launchd installer ran while stopped)\n' >&2
  exit 1
fi
printf '%s\n' "$INSTALL_OUT" | grep -q 'STOP sentinel present' || {
  printf 'program-stop-selftest: FAIL (launchd installer did not report STOP: %s)\n' "$INSTALL_OUT" >&2
  exit 1
}
[ ! -e "$CONTROL_ROOT/fake-home/Library/LaunchAgents/com.mosh.stranger-loop.plist" ] || {
  printf 'program-stop-selftest: FAIL (launchd installer wrote a plist while stopped)\n' >&2
  exit 1
}

printf 'program-stop-selftest: PASS\n'
