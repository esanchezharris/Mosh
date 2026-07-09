#!/bin/zsh
set -euo pipefail

SFT_DIR=${MOSH_R4_SFT_DIR:-/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/intelligent-banach-25ad5f/service/sft}
TOTAL=12889
DONE_FILE="$SFT_DIR/.adapters/a3b-r4.done"
TRAIN_LOG="$SFT_DIR/.adapters/a3b-r4.train.log"
WATCHDOG_PID_FILE="$SFT_DIR/.adapters/a3b-r4.watchdog.pid"
GATE_STATUS_FILE="$SFT_DIR/.adapters/a3b-r4.gate.status"
BOOT_LOG=/tmp/watchdog-r4-boot.log
FALLBACK_WATCHDOG_LOG=/tmp/watchdog-r4.log
AGENT_PLIST="$HOME/Library/LaunchAgents/com.mosh.r4-watchdog.plist"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

usage() {
  cat <<'EOF'
Usage: ./monitor-r4.sh [status|gate|--no-gate|--help]

Commands:
  status      Print the live a3b-r4 monitor snapshot (default). If the run is complete,
              auto-start the gate read unless gate work is already running or done.
  gate        Run the a3b-r4 gate read immediately.

Options:
  --no-gate   Suppress the auto-gate handoff when completion is detected.
  --help      Show this help text.
EOF
}

command=status
auto_gate=1
while [ $# -gt 0 ]; do
  case "$1" in
    status) command=status ;;
    gate) command=gate ;;
    --no-gate) auto_gate=0 ;;
    --help|-h) usage; exit 0 ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if [ "$command" = gate ]; then
  exec "$SCRIPT_DIR/run-gate-r4.sh"
fi

read_kv() {
  local file=$1 key=$2
  [ -f "$file" ] || return 0
  awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1); exit }' "$file"
}

find_proc() {
  local pattern=$1
  ps -axo pid=,command= | grep -E "$pattern" | head -1 || true
}

latest_watchdog_line() {
  local line=""
  if [ -f "$BOOT_LOG" ]; then
    line=$(grep -aE 'WATCHDOG:' "$BOOT_LOG" | tail -1 || true)
  fi
  if [ -z "$line" ] && [ -f "$FALLBACK_WATCHDOG_LOG" ]; then
    line=$(grep -aE 'WATCHDOG:' "$FALLBACK_WATCHDOG_LOG" | tail -1 || true)
  fi
  printf '%s' "$line"
}

done_count=$(cat "$DONE_FILE" 2>/dev/null || echo 0)
percent=$(awk -v done="$done_count" -v total="$TOTAL" 'BEGIN { printf "%.2f", (done/total)*100 }')
train_line=$(tr -d '\r' < "$TRAIN_LOG" 2>/dev/null | grep -aE '^(Iter [0-9]+: (Val loss|Train loss)|Saved adapter to )' | tail -1 || true)
watchdog_line=$(latest_watchdog_line)
watchdog_pid=$(cat "$WATCHDOG_PID_FILE" 2>/dev/null || true)
gate_state=$(read_kv "$GATE_STATUS_FILE" state)
gate_updated_at=$(read_kv "$GATE_STATUS_FILE" updated_at)
gate_log=$(read_kv "$GATE_STATUS_FILE" log)
gate_fused_dir=$(read_kv "$GATE_STATUS_FILE" fused_dir)

training_alive=no
training_proc=$(find_proc '[m]lx_lm lora')
[ -n "$training_proc" ] && training_alive=yes

server_alive=no
server_proc=$(find_proc '[m]lx_lm\.server')
[ -n "$server_proc" ] && server_alive=yes

watchdog_alive=no
if [ -n "$watchdog_pid" ] && kill -0 "$watchdog_pid" 2>/dev/null; then
  watchdog_alive=yes
fi

action_required=none
if [ "${gate_state:-}" = running ]; then
  action_required="wait-for-gate-read"
elif [ "$done_count" -ge "$TOTAL" ]; then
  if [ "$training_alive" = yes ]; then
    action_required="wait-for-training-exit-before-gate"
  elif [ "${gate_state:-}" = complete ]; then
    action_required="none"
  elif [ "${gate_state:-}" = failed ]; then
    action_required="inspect-gate-log"
  else
    action_required="run-gate-read"
  fi
elif [ "$training_alive" = yes ] && [ "$watchdog_alive" = yes ]; then
  action_required="none"
elif [ "$training_alive" = yes ] && [ "$watchdog_alive" = no ]; then
  action_required="watchdog-down-training-still-alive-do-not-relaunch"
elif [ "$training_alive" = no ] && [ "$watchdog_alive" = yes ]; then
  action_required="watchdog-should-resume-check-logs-before-manual-intervention"
elif printf '%s' "$watchdog_line" | grep -q '30 crashes'; then
  action_required="watchdog-gave-up-after-repeated-crashes"
elif printf '%s' "$watchdog_line" | grep -q 'crash #[0-9]'; then
  action_required="repeated-crash-recovery-check-gpu-contention"
elif [ -f "$AGENT_PLIST" ]; then
  action_required="watchdog-down-launchagent-installed-check-boot-log-before-manual-restart"
else
  action_required="watchdog-down-no-launchagent-inspect-before-manual-restart"
fi

echo "r4 progress: $done_count/$TOTAL (${percent}%)"
echo "runtime: $SFT_DIR"
echo "training: $training_alive${training_proc:+ :: $training_proc}"
echo "watchdog: $watchdog_alive${watchdog_pid:+ :: pid $watchdog_pid}"
echo "gate: ${gate_state:-pending}${gate_updated_at:+ :: updated $gate_updated_at}"
echo "latest: ${train_line:-no-train-lines-yet}"
if [ -n "$watchdog_line" ]; then
  echo "watchdog-log: $watchdog_line"
fi
if [ -n "$gate_log" ]; then
  echo "gate-log: $gate_log"
fi
if [ -n "$gate_fused_dir" ]; then
  echo "gate-fused: $gate_fused_dir"
fi
echo "action: $action_required"

if [ "$server_alive" = yes ]; then
  echo "server: yes :: $server_proc"
fi

if [ "$auto_gate" -eq 1 ] && [ "$action_required" = run-gate-read ]; then
  echo "completion detected: starting run-gate-r4.sh"
  exec "$SCRIPT_DIR/run-gate-r4.sh"
fi
