#!/bin/zsh
# LaunchAgent entrypoint (com.mosh.r4-watchdog) — auto-resume the Cycle-3 run on boot.
# Idempotent + race-free: does NOTHING if the run is complete (and self-removes the
# login-item), or if a watchdog / training proc is already alive. Otherwise relaunches
# the watchdog, which resumes from the last checkpoint via the .done counter.
set -uo pipefail
SFT_DIR=/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/intelligent-banach-25ad5f/service/sft
WPID_FILE="$SFT_DIR/.adapters/a3b-r4.watchdog.pid"
DONE_FILE="$SFT_DIR/.adapters/a3b-r4.done"
TOTAL=12889
LABEL=com.mosh.r4-watchdog
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

done=$(cat "$DONE_FILE" 2>/dev/null || echo 0)

# Run complete → remove the login-item so it doesn't linger, and exit.
if [ "$done" -ge "$TOTAL" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  rm -f "$PLIST"
  exit 0
fi

# Already-running guards (prevents duplicate GPU jobs).
if [ -f "$WPID_FILE" ] && kill -0 "$(cat "$WPID_FILE" 2>/dev/null)" 2>/dev/null; then exit 0; fi
if pgrep -f "mlx_lm lora" >/dev/null 2>&1; then exit 0; fi

# Otherwise: resume.
cd "$SFT_DIR" || exit 1
nohup ./watchdog-r4.sh >> /tmp/watchdog-r4-boot.log 2>&1 &
disown
exit 0
