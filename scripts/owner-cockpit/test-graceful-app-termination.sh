#!/usr/bin/env bash
set -euo pipefail

APP="${1:-}"
[[ -x "$APP" ]] || {
  echo "usage: $0 /absolute/path/to/Mosh.app/Contents/MacOS/Mosh" >&2
  exit 2
}

SESSION_LEAF="session-selftest-auto-graceful-term-$$-$(date +%s)"
SESSION_DIR="$HOME/Library/Mosh/$SESSION_LEAF"
LOG_PATH="$HOME/Library/Mosh/$SESSION_LEAF.log"
APP_PID=""

cleanup() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM "$APP_PID" 2>/dev/null || true
    for _ in {1..50}; do
      kill -0 "$APP_PID" 2>/dev/null || return
      sleep 0.1
    done
    kill -KILL "$APP_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

MOSH_NO_AUDIO=1 MOSH_SELFTEST_SESSION="$SESSION_LEAF" \
  "$APP" >"$LOG_PATH" 2>&1 &
APP_PID=$!

for _ in {1..300}; do
  [[ -e "$SESSION_DIR/session.running" ]] && break
  kill -0 "$APP_PID" 2>/dev/null || {
    echo "graceful termination smoke: FAIL (app exited before becoming ready)" >&2
    exit 1
  }
  sleep 0.1
done
[[ -e "$SESSION_DIR/session.running" ]] || {
  echo "graceful termination smoke: FAIL (session sentinel not created)" >&2
  exit 1
}

kill -TERM "$APP_PID"
for _ in {1..300}; do
  kill -0 "$APP_PID" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$APP_PID" 2>/dev/null; then
  echo "graceful termination smoke: FAIL (app did not exit)" >&2
  exit 1
fi
APP_PID=""

[[ ! -e "$SESSION_DIR/session.running" ]] || {
  echo "graceful termination smoke: FAIL (unclean-session sentinel remained)" >&2
  exit 1
}

echo "graceful termination smoke: PASS"
echo "session=$SESSION_DIR"
echo "log=$LOG_PATH"
