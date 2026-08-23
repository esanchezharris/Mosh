#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$1"
FAKE_BRIDGE="$2"
source "$SCRIPT"

STALE_ROOT="$(mktemp -d "$TEMP_BASE/mosh-dawn-stale.XXXXXX")"
DESCRIPTOR="$STALE_ROOT/remote-script.json"
printf '%s' 'foreign-state' >"$DESCRIPTOR"
chmod 600 "$DESCRIPTOR"
BINARY="$FAKE_BRIDGE"
if launch_app 2>/dev/null; then
  echo "stale descriptor incorrectly accepted" >&2
  exit 1
fi
test "$(cat "$DESCRIPTOR")" = foreign-state
test -z "$APP_PID"
unlink "$DESCRIPTOR"
rmdir "$STALE_ROOT"

PID_FILE="$(mktemp "$TEMP_BASE/mosh-dawn-pid.XXXXXX")"
FAIL_ROOT="$(mktemp -d "$TEMP_BASE/mosh-dawn-verify.XXXXXX")"
if (
  source "$SCRIPT"
  OWNED_TEMP_ROOT="$FAIL_ROOT"
  DESCRIPTOR="$FAIL_ROOT/remote-script.json"
  BINARY="$FAKE_BRIDGE"
  export MOSH_FAKE_PID_FILE="$PID_FILE"
  launch_app
  false
); then
  echo "simulated verify failure unexpectedly succeeded" >&2
  exit 1
fi
test ! -e "$FAIL_ROOT"
FAKE_PID="$(cat "$PID_FILE")"
! kill -0 "$FAKE_PID" 2>/dev/null
unlink "$PID_FILE"
