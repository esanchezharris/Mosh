#!/usr/bin/env bash
# program-stop-selftest.sh — prove a sibling program STOP reaches every shared
# merge-queue mutation boundary, including a finalize that is already in flight.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MERGE_ONE="$SELF_DIR/merge-one.sh"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/mosh-program-stop.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

FAKE_ROOT="$SANDBOX/repo"
PROGRAM_STOP="$FAKE_ROOT/docs/first-stranger-program/STOP"
GH_MARKER="$SANDBOX/gh-invoked"
mkdir -p "$FAKE_ROOT/docs/first-stranger-program" "$SANDBOX/bin"
git init -q "$FAKE_ROOT"
touch "$PROGRAM_STOP"

cat >"$SANDBOX/bin/gh" <<EOF
#!/usr/bin/env bash
touch "$GH_MARKER"
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

printf 'program-stop-selftest: PASS\n'
