#!/usr/bin/env bash
# Dev launcher for claude_cli_shim.py — the local OpenAI-compatible shim in
# front of `claude -p` (W1.3, produce-lane overnight plan). Foreground process
# by design: run it as `bash service/brain_shim/run-shim.sh &` (or under a
# supervisor) rather than have this script self-daemonize.
#
# Writes its own PID to $MOSH_CLAUDE_SHIM_PIDFILE *before* exec'ing python3, so
# the recorded PID is the live shim process (exec replaces the image, keeps the
# PID) — a caller can `kill "$(cat ~/Library/Mosh/brain-shim/shim.pid)"` to stop
# it, or check `kill -0` to confirm it is still alive.
set -euo pipefail
cd "$(dirname "$0")"

export MOSH_CLAUDE_SHIM_PORT="${MOSH_CLAUDE_SHIM_PORT:-8788}"
LOG="${MOSH_CLAUDE_SHIM_LOG:-$HOME/Library/Mosh/logs/brain-shim.log}"
PIDFILE="${MOSH_CLAUDE_SHIM_PIDFILE:-$HOME/Library/Mosh/brain-shim/shim.pid}"

mkdir -p "$(dirname "$LOG")" "$(dirname "$PIDFILE")"
echo "$$" > "$PIDFILE"

exec >>"$LOG" 2>&1
printf '[run-shim.sh] %s starting claude_cli_shim on port %s (pid %s, claude_bin=%s)\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MOSH_CLAUDE_SHIM_PORT" "$$" "${MOSH_CLAUDE_BIN:-<default>}"

exec python3 ./claude_cli_shim.py
