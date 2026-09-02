#!/usr/bin/env bash
# watchdog.sh — liveness + memory-housekeeping loop for ONE Mosh app pid (the
# process launch-app.sh started). Runs alongside overnight.sh's produce batch,
# sampling RSS and the companion /health + mosh-log.jsonl growth every
# --interval seconds, and reacting to two DISTINCT problems:
#
#   1. STUCK — mosh-log.jsonl hasn't grown in --stuck-log-s (default 240s), OR
#      /health has been unreachable for --stuck-health-s (default 60s).
#      Recovery: SIGTERM, wait up to 20s, SIGKILL if still alive, then (unless
#      --no-relaunch) call launch-app.sh to bring a fresh instance up. Appends
#      an `aborted-watchdog` event so overnight.sh marks the in-flight run
#      accordingly instead of silently losing it.
#
#   2. RSS creep — Vital instances accumulate roughly once per run (freed by
#      new_project, but not always cleanly under memory pressure). RSS over
#      --rss-abort-mb (default 12288, 12GiB): an `rss-abort` advisory event —
#      overnight.sh's run driver owns the actual abort (its own hard
#      timeout/signal), this just flags it early. RSS over --rss-restart-mb
#      (default 16384, 16GiB): an `rss-restart` advisory — overnight.sh should
#      restart the app before the NEXT run rather than let it keep growing.
#
# NEVER touches com.emilio.* LaunchAgents, mlx servers, or Codex/ChatGPT
# processes — it only ever signals the ONE --pid it was given. NEVER kill -9
# except as the last step of the SIGTERM -> wait -> SIGKILL stuck-recovery
# ladder (never for the RSS advisories — those are just events).
#
# Usage:
#   scripts/produce-lane/watchdog.sh --pid <PID> [--port 47873] [--interval 30]
#     [--stuck-log-s 240] [--stuck-health-s 60] [--rss-abort-mb 12288]
#     [--rss-restart-mb 16384] [--log-path <mosh-log.jsonl>] [--events <path>]
#     [--state <path>] [--no-relaunch] [--once]
#
# `--once` runs exactly ONE check-and-react cycle and exits:
#   0 healthy   1 rss-abort advisory   2 rss-restart advisory   3 stuck (recovered)
# Without `--once`, loops every --interval seconds until the pid exits or a
# STOP file appears next to --state (`<state>.STOP`). Appends one JSON line
# per cycle to --events and a human line to stdout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PID=""
PORT=47873
INTERVAL=30
STUCK_LOG_S=240
STUCK_HEALTH_S=60
RSS_ABORT_MB=12288
RSS_RESTART_MB=16384
LOG_PATH="$HOME/Library/Mosh/session/mosh-log.jsonl"
PRODUCE_AB_DIR="${MOSH_PRODUCE_AB_DIR:-$HOME/Library/Mosh/produce-ab/$(date +%Y-%m-%d)}"
EVENTS_PATH="$PRODUCE_AB_DIR/runs/watchdog-events.jsonl"
STATE_PATH="$PRODUCE_AB_DIR/runs/watchdog-state.txt"
NO_RELAUNCH=0
ONCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --pid) PID="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --stuck-log-s) STUCK_LOG_S="$2"; shift 2 ;;
    --stuck-health-s) STUCK_HEALTH_S="$2"; shift 2 ;;
    --rss-abort-mb) RSS_ABORT_MB="$2"; shift 2 ;;
    --rss-restart-mb) RSS_RESTART_MB="$2"; shift 2 ;;
    --log-path) LOG_PATH="$2"; shift 2 ;;
    --events) EVENTS_PATH="$2"; shift 2 ;;
    --state) STATE_PATH="$2"; shift 2 ;;
    --no-relaunch) NO_RELAUNCH=1; shift ;;
    --once) ONCE=1; shift ;;
    *) echo "watchdog.sh: unknown arg $1" >&2; exit 2 ;;
  esac
done

if [ -z "$PID" ]; then echo "watchdog.sh: --pid is required" >&2; exit 2; fi

mkdir -p "$(dirname "$EVENTS_PATH")" "$(dirname "$STATE_PATH")"
STOP_FILE="${STATE_PATH}.STOP"

emit_event() {
  local kind="$1" detail="$2"
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"ts":"%s","pid":%s,"kind":"%s","detail":%s}\n' "$ts" "$PID" "$kind" "$detail" >> "$EVENTS_PATH"
}

json_escape() {
  # Minimal JSON string escaping (backslash + double-quote + control chars) —
  # good enough for the short human-readable `detail` strings this script emits.
  printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null \
    || printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

# ── state (persists across cycles: last log size/growth ts, unhealthy-since) ─
last_log_size=0
last_log_growth_ts=0
unhealthy_since_ts=0
now_ts() { date -u +%s; }

load_state() {
  if [ -f "$STATE_PATH" ]; then
    # shellcheck disable=SC1090
    . "$STATE_PATH"
  fi
}
save_state() {
  {
    printf 'last_log_size=%s\n' "$last_log_size"
    printf 'last_log_growth_ts=%s\n' "$last_log_growth_ts"
    printf 'unhealthy_since_ts=%s\n' "$unhealthy_since_ts"
  } > "$STATE_PATH"
}

rss_mb_of() {
  local pid="$1"
  local kb
  kb="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')"
  if [ -z "$kb" ]; then echo ""; return; fi
  echo $((kb / 1024))
}

recover_stuck() {
  local reason="$1"
  echo "[watchdog] STUCK ($reason) — pid=$PID SIGTERM"
  emit_event "aborted-watchdog" "$(json_escape "stuck: $reason")"
  kill -TERM "$PID" 2>/dev/null || true
  local waited=0
  while [ "$waited" -lt 20 ]; do
    if ! kill -0 "$PID" 2>/dev/null; then break; fi
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$PID" 2>/dev/null; then
    echo "[watchdog] pid=$PID still alive after 20s SIGTERM wait — SIGKILL (last resort)"
    kill -KILL "$PID" 2>/dev/null || true
    sleep 1
  fi
  if [ "$NO_RELAUNCH" -eq 1 ]; then
    echo "[watchdog] --no-relaunch set — NOT bringing up a replacement instance"
    return
  fi
  echo "[watchdog] relaunching via launch-app.sh"
  if out="$("$SCRIPT_DIR/launch-app.sh" 2>&1)"; then
    echo "[watchdog] relaunch ok: $out"
    emit_event "relaunched" "$(json_escape "$out")"
  else
    echo "[watchdog] relaunch FAILED: $out" >&2
    emit_event "relaunch-failed" "$(json_escape "$out")"
  fi
}

# One check-and-react cycle. Returns (via $?) 0 healthy / 1 rss-abort /
# 2 rss-restart / 3 stuck-recovered. Mutates + persists the small state file.
check_once() {
  load_state
  local t
  t="$(now_ts)"

  if ! kill -0 "$PID" 2>/dev/null; then
    echo "[watchdog] pid=$PID is gone — nothing to watch, exiting"
    emit_event "pid-gone" '"the watched process is no longer running"'
    exit 0
  fi

  local healthy=0
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"running":true'; then
    healthy=1
  fi
  if [ "$healthy" -eq 1 ]; then
    unhealthy_since_ts=0
  else
    if [ "$unhealthy_since_ts" -eq 0 ]; then unhealthy_since_ts="$t"; fi
  fi

  local log_size=0
  if [ -f "$LOG_PATH" ]; then log_size="$(stat -f%z "$LOG_PATH" 2>/dev/null || echo 0)"; fi
  if [ "$log_size" -gt "$last_log_size" ] || [ "$last_log_growth_ts" -eq 0 ]; then
    last_log_growth_ts="$t"
  fi
  last_log_size="$log_size"

  local health_stuck_for=0 log_stuck_for=0
  if [ "$unhealthy_since_ts" -gt 0 ]; then health_stuck_for=$((t - unhealthy_since_ts)); fi
  if [ "$last_log_growth_ts" -gt 0 ]; then log_stuck_for=$((t - last_log_growth_ts)); fi

  local rss_mb
  rss_mb="$(rss_mb_of "$PID")"

  save_state

  if [ "$health_stuck_for" -ge "$STUCK_HEALTH_S" ]; then
    recover_stuck "no healthy /health response for ${health_stuck_for}s (>= ${STUCK_HEALTH_S}s)"
    return 3
  fi
  if [ "$log_stuck_for" -ge "$STUCK_LOG_S" ]; then
    recover_stuck "mosh-log.jsonl has not grown in ${log_stuck_for}s (>= ${STUCK_LOG_S}s)"
    return 3
  fi

  if [ -n "$rss_mb" ] && [ "$rss_mb" -ge "$RSS_RESTART_MB" ]; then
    echo "[watchdog] rss=${rss_mb}MiB >= restart floor ${RSS_RESTART_MB}MiB — advisory only, restart before the next run"
    emit_event "rss-restart" "$(json_escape "rss ${rss_mb}MiB >= ${RSS_RESTART_MB}MiB")"
    return 2
  fi
  if [ -n "$rss_mb" ] && [ "$rss_mb" -ge "$RSS_ABORT_MB" ]; then
    echo "[watchdog] rss=${rss_mb}MiB >= abort floor ${RSS_ABORT_MB}MiB — advisory only, the run driver owns its own abort"
    emit_event "rss-abort" "$(json_escape "rss ${rss_mb}MiB >= ${RSS_ABORT_MB}MiB")"
    return 1
  fi

  echo "[watchdog] ok pid=$PID rss=${rss_mb:-unknown}MiB healthy=$healthy log_stuck_for=${log_stuck_for}s"
  emit_event "ok" "$(json_escape "rss=${rss_mb:-unknown}MiB healthy=$healthy")"
  return 0
}

if [ "$ONCE" -eq 1 ]; then
  set +e
  check_once
  code=$?
  set -e
  exit "$code"
fi

echo "[watchdog] watching pid=$PID port=$PORT interval=${INTERVAL}s (stop file: $STOP_FILE)"
while true; do
  if [ -f "$STOP_FILE" ]; then
    echo "[watchdog] stop file present ($STOP_FILE) — exiting"
    rm -f "$STOP_FILE"
    exit 0
  fi
  set +e
  check_once
  set -e
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "[watchdog] pid=$PID no longer running — exiting"
    exit 0
  fi
  sleep "$INTERVAL"
done
