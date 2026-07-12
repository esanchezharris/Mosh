#!/usr/bin/env bash
# nightly.sh — unattended nightly driver for the First-Stranger "stranger-loop".
#
# Fired by launchd (see install-launchd.sh) or run by hand. Two-state safety interlock:
#   • NOT ARMED (default)  → planOnly rehearsal: per-lane plans + gap-verify + dashboard.
#                            No worktrees, no PRs, no merges. Zero risk. Runs every night.
#   • ARMED (touch docs/first-stranger-program/ARMED) → live loop: implement → gate →
#                            AUTO-MERGE only SAFE (docs/ui/service-py) diffs; every
#                            high-stakes lane (engine/auth/packaging/relay/state) becomes
#                            an owner-merge PR. It can NEVER auto-merge high-stakes work.
#
# Halts immediately if docs/auto-loop/STOP or docs/first-stranger-program/STOP exists.
# Flags: --check (validate guards + print the command, do NOT invoke claude),
#        --live (force the armed/live posture), --plan (force planOnly), --no-ac (ignore
#        battery guard).  Bash 3.2 compatible.
set -uo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SELF/../.." && (git rev-parse --show-toplevel 2>/dev/null || pwd))"
PROG="$REPO/docs/first-stranger-program"
STOP1="$REPO/docs/auto-loop/STOP"; STOP2="$PROG/STOP"; ARMED="$PROG/ARMED"
LOGDIR="${MOSH_STRANGER_LOGDIR:-$HOME/Library/Mosh/logs/stranger-loop}"
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
mkdir -p "$LOGDIR"
STAMP="$(date '+%Y%m%d-%H%M%S')"
LOG="$LOGDIR/nightly-$STAMP.log"

MODE="run"; REQUIRE_AC=1; FORCE=""
for a in "$@"; do case "$a" in
  --check) MODE="check";;
  --live)  FORCE="live";;
  --plan)  FORCE="plan";;
  --no-ac) REQUIRE_AC=0;;
  --once)  ;;   # accepted (run now); default when invoked directly
esac; done

log(){ printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG"; }
log "stranger-loop nightly start (repo=$REPO, stamp=$STAMP)"

# ── guard: kill switch ──────────────────────────────────────────────────────────
if [ -e "$STOP1" ] || [ -e "$STOP2" ]; then log "STOP sentinel present — not running."; exit 0; fi

# ── guard: AC power (don't drain a laptop) ──────────────────────────────────────
if [ "$REQUIRE_AC" = 1 ] && command -v pmset >/dev/null 2>&1; then
  if pmset -g batt 2>/dev/null | grep -q "Battery Power"; then
    log "on battery power — skipping (use --no-ac to override)."; exit 0
  fi
fi

# ── posture: ARMED (or --live) gates the real auto-merge run ────────────────────
if [ "$FORCE" = "live" ] || { [ "$FORCE" != "plan" ] && [ -e "$ARMED" ]; }; then
  CFG="{\"dryRun\": false, \"planOnly\": false, \"maxItems\": 2, \"maxNativeInFlight\": 1, \"maxMerges\": 2, \"maxCycles\": 3, \"ts\": \"$STAMP\"}"
  log "LIVE posture (armed) → implement + gate; auto-merge SAFE only, high-stakes → owner PR."
else
  CFG="{\"planOnly\": true, \"maxItems\": 4, \"maxCycles\": 1, \"ts\": \"$STAMP\"}"
  log "PLAN-ONLY posture (not armed) → refresh lane plans + gap-verify + dashboard. touch $ARMED to arm."
fi

PROMPT="Run the Workflow named 'stranger-loop' (script at .claude/workflows/stranger-loop.workflow.js — if the name is not found, invoke it by that scriptPath) with args ${CFG}. This is a pre-authorized unattended nightly run of the First-Stranger Program loop: it auto-merges ONLY safe (docs/ui/service-py) diffs and routes every high-stakes lane (engine/auth/packaging/relay/state) to an owner-merge PR — it can never merge those. Proceed without asking for confirmation. When the workflow returns, print one line: planned / merged(safe) / routed(owner) / rejected / halts."

if [ "$MODE" = "check" ]; then
  log "CHECK mode — would invoke (not executing claude):"
  log "  cd $REPO && $CLAUDE_BIN -p <prompt> --dangerously-skip-permissions"
  log "  config: $CFG"
  [ -x "$CLAUDE_BIN" ] && log "claude binary OK: $CLAUDE_BIN" || log "WARN: claude binary missing at $CLAUDE_BIN"
  bash "$REPO/scripts/first-stranger/status.sh" >>"$LOG" 2>&1 && log "dashboard refreshed." || log "WARN: status.sh failed."
  log "CHECK ok."; exit 0
fi

[ -x "$CLAUDE_BIN" ] || { log "claude binary not found at $CLAUDE_BIN — aborting."; exit 1; }

cd "$REPO"
log "invoking claude (headless, --dangerously-skip-permissions) …"
"$CLAUDE_BIN" -p "$PROMPT" --dangerously-skip-permissions >>"$LOG" 2>&1
rc=$?
log "claude exited rc=$rc"
bash "$REPO/scripts/first-stranger/status.sh" >>"$LOG" 2>&1 || true   # belt: refresh dashboard
log "nightly done (rc=$rc). log: $LOG"
exit $rc
