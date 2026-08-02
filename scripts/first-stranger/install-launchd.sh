#!/usr/bin/env bash
# install-launchd.sh — OWNER RUNS THIS ONCE to schedule the nightly stranger-loop.
#
# Generates ~/Library/LaunchAgents/com.mosh.stranger-loop.plist (fires nightly at 02:00),
# pointing at THIS checkout's scripts/first-stranger/nightly.sh, then loads it. Idempotent.
#
#   Install / update:   scripts/first-stranger/install-launchd.sh
#   Remove:             scripts/first-stranger/install-launchd.sh --uninstall
#   Run once now:       scripts/first-stranger/nightly.sh --once        (bypasses launchd)
#
# The nightly job is a PLAN-ONLY rehearsal until you `touch docs/first-stranger-program/ARMED`.
set -euo pipefail

CALLER_REPO="$(cd "$(dirname "$0")/../.." && git rev-parse --show-toplevel)"
AL_ROOT="$CALLER_REPO"
AL_PROGRAM_STOP="$CALLER_REPO/docs/first-stranger-program/STOP"
. "$CALLER_REPO/scripts/auto-loop/lib.sh"
REPO="$(al_main_worktree)"
LABEL="com.mosh.stranger-loop"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NIGHTLY="$REPO/scripts/first-stranger/nightly.sh"
LOGDIR="$HOME/Library/Mosh/logs/stranger-loop"
HOUR="${STRANGER_HOUR:-2}"; MIN="${STRANGER_MIN:-0}"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "uninstalled $LABEL (removed $PLIST)."
  exit 0
fi

if al_stop_requested; then
  echo "install-launchd.sh: STOP sentinel present — First-Stranger is paused." >&2
  exit 1
fi

[ -f "$NIGHTLY" ] || { echo "nightly.sh not found at $NIGHTLY" >&2; exit 1; }
chmod +x "$NIGHTLY" "$REPO/scripts/first-stranger/status.sh" 2>/dev/null || true
mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"

# A PATH that finds git/gh/npm/cmake/claude under launchd's minimal environment.
LAUNCH_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$NIGHTLY</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MIN</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$LOGDIR/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/launchd.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$LAUNCH_PATH</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "installed + loaded $LABEL → nightly at $(printf '%02d:%02d' "$HOUR" "$MIN")."
echo "  posture: PLAN-ONLY until you: touch $REPO/docs/first-stranger-program/ARMED"
echo "  halt:    touch $REPO/docs/auto-loop/STOP"
echo "  logs:    $LOGDIR/"
echo "  remove:  $0 --uninstall"
