#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="${1:-$ROOT/build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh}"
if [[ ! -x "$APP" ]]; then
  printf 'Mosh executable is not available: %s\n' "$APP" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
FIRST_PID=""
SECOND_PID=""
cleanup() {
  [[ -z "$SECOND_PID" ]] || kill "$SECOND_PID" 2>/dev/null || true
  [[ -z "$FIRST_PID" ]] || kill "$FIRST_PID" 2>/dev/null || true
  [[ -z "$SECOND_PID" ]] || wait "$SECOND_PID" 2>/dev/null || true
  [[ -z "$FIRST_PID" ]] || wait "$FIRST_PID" 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

MOSH_NO_AUDIO=1 MOSH_SELFTEST_SESSION="singleton-primary-$$" \
  "$APP" -ApplePersistenceIgnoreState YES > "$TMP_DIR/primary.log" 2>&1 &
FIRST_PID=$!
sleep 3
if ! kill -0 "$FIRST_PID" 2>/dev/null; then
  printf 'Primary Mosh exited before the singleton probe\n' >&2
  exit 1
fi

MOSH_NO_AUDIO=1 MOSH_SELFTEST_SESSION="singleton-harness-$$" \
  "$APP" --selftest-undo -ApplePersistenceIgnoreState YES > "$TMP_DIR/harness.log" 2>&1
/usr/bin/grep -q '18/18 focused undo checks passed, 0 failed' "$TMP_DIR/harness.log"

MOSH_NO_AUDIO=1 MOSH_SELFTEST_SESSION="singleton-secondary-$$" \
  "$APP" -ApplePersistenceIgnoreState YES > "$TMP_DIR/secondary.log" 2>&1 &
SECOND_PID=$!
for _ in {1..20}; do
  kill -0 "$SECOND_PID" 2>/dev/null || break
  sleep 0.25
done
if kill -0 "$SECOND_PID" 2>/dev/null; then
  printf 'A second interactive Mosh process remained alive\n' >&2
  exit 1
fi
wait "$SECOND_PID"
SECOND_PID=""
if ! kill -0 "$FIRST_PID" 2>/dev/null; then
  printf 'Primary Mosh did not survive the duplicate-launch probe\n' >&2
  exit 1
fi

printf 'interactive singleton: PASS\n'
