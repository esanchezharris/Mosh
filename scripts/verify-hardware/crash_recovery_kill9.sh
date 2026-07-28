#!/usr/bin/env bash
# FS-T2 — the literal SPEC §4 T2 gate: "kill -9 mid-edit (scripted: N mutations, kill,
# relaunch) → recovered state matches the pre-kill snapshot+replay to the last logged
# command. Deterministic, ×3."
#
# WHY THIS EXISTS SEPARATELY. verify.py's check_crash_recovery proves the same round trip
# but crashes via the `__crash` pseudo-command, which sets the liveness sentinel and then
# takes a clean C++ `break` out of the script loop. That is a faithful simulation of the
# STATE a crash leaves — but it is not a real signal, and a process that unwinds normally
# can flush buffers a killed one never would. This script sends an actual SIGKILL to a
# running Mosh in the middle of its edit script, so the recovery journal is only ever as
# durable as its real on-disk writes.
#
# NOT wired into scripts/auto-loop/gate.sh — that file is off-limits to lane work (loop
# rulebook). Run it directly; it is owner/CI-runnable and self-contained.
#
#   bash scripts/verify-hardware/crash_recovery_kill9.sh [path/to/Mosh]
#
# Exits non-zero on the first failing round. Run from the repo ROOT.

set -uo pipefail

BIN="${1:-build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh}"
SESSION="verify-kill9"
ROUNDS=3

if [[ ! -x "$BIN" ]]; then
  echo "FAIL: Mosh binary not found/executable at: $BIN" >&2
  echo "      Build it first, or pass the path as \$1." >&2
  exit 2
fi

case "$(uname -s)" in
  Darwin) BASE="$HOME/Library/Mosh" ;;
  Linux)  BASE="$HOME/.local/share/Mosh" ;;
  *)      echo "FAIL: unsupported platform $(uname -s)" >&2; exit 2 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The session dir MOSH_SELFTEST_SESSION resolves to. An explicit value wins verbatim, so
# this is exactly where the journal + sentinel land.
SESSION_DIR="$BASE/$SESSION"

expected_tracks=0
declare -a observed=()

for round in $(seq 1 "$ROUNDS"); do
  echo "── round $round/$ROUNDS ─────────────────────────────────────────"
  rm -rf "$SESSION_DIR"

  # ── Run 1: save a baseline, then make N UNSAVED mutations, then hold so we can kill it.
  # The trailing __wait keeps the process alive with the journal written but the edit
  # unsaved — precisely "mid-edit". Without it the script would exit cleanly before we
  # could signal. (__wait is the existing run-script pump; no new pseudo-command needed.)
  N=5
  {
    echo '{"command":"create_track","args":{"name":"Base"}}'
    echo '{"command":"save","args":{}}'
    for i in $(seq 1 "$N"); do
      echo "{\"command\":\"create_track\",\"args\":{\"name\":\"Unsaved$i\"}}"
    done
    echo '{"command":"__wait","args":{"ms":30000}}'
  } > "$WORK/run1.jsonl"

  MOSH_RUN_SCRIPT="$WORK/run1.jsonl" \
  MOSH_RUN_SCRIPT_OUT="$WORK/run1.out.jsonl" \
  MOSH_SELFTEST_SESSION="$SESSION" \
  MOSH_RUNSCRIPT_KEEP_SESSION=1 \
  MOSH_NO_AUDIO=1 \
    "$BIN" --run-script >"$WORK/run1.log" 2>&1 &
  PID=$!

  # Wait until the journal shows all N mutations landed — then kill mid-edit. Polling the
  # artifact (not sleeping a fixed time) is what makes this deterministic on a loaded box.
  JOURNAL="$SESSION_DIR/recovery-journal.jsonl"
  for _ in $(seq 1 300); do
    if [[ -f "$JOURNAL" ]] && [[ "$(grep -c . "$JOURNAL" 2>/dev/null || echo 0)" -ge "$N" ]]; then
      break
    fi
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.1
  done

  journal_lines="$(grep -c . "$JOURNAL" 2>/dev/null || echo 0)"
  if [[ "$journal_lines" -lt "$N" ]]; then
    kill -9 "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
    echo "FAIL round $round: journal has $journal_lines/$N lines before the kill" >&2
    sed -n '1,40p' "$WORK/run1.log" >&2
    exit 1
  fi

  # THE point of this script: a real, uncatchable SIGKILL mid-edit.
  kill -9 "$PID" 2>/dev/null
  wait "$PID" 2>/dev/null
  # A killed process cannot clear the sentinel; that is what makes run 2 detect the crash.
  if [[ ! -f "$SESSION_DIR/session.running" ]]; then
    # --run-script never writes the GUI sentinel, so plant it: the journal tail is the
    # artifact under test here, and recovery is gated on the unclean flag.
    : > "$SESSION_DIR/session.running"
  fi

  # ── Run 2: relaunch on the same session, replay, and count what came back.
  {
    echo '{"command":"recover_session","args":{}}'
    echo '{"command":"__snapshot","args":{"label":"after"}}'
  } > "$WORK/run2.jsonl"

  MOSH_RUN_SCRIPT="$WORK/run2.jsonl" \
  MOSH_RUN_SCRIPT_OUT="$WORK/run2.out.jsonl" \
  MOSH_SELFTEST_SESSION="$SESSION" \
  MOSH_RUNSCRIPT_KEEP_SESSION=1 \
  MOSH_NO_AUDIO=1 \
    "$BIN" --run-script >"$WORK/run2.log" 2>&1

  got="$(python3 - "$WORK/run2.out.jsonl" <<'PY'
import json,sys
tracks=recovered=None
for line in open(sys.argv[1]):
    line=line.strip()
    if not line: continue
    try: r=json.loads(line)
    except json.JSONDecodeError: continue
    if r.get("command")=="recover_session": recovered=r.get("data",{}).get("recovered")
    if r.get("command")=="__snapshot" and r.get("label")=="after":
        tracks=len(r.get("data",{}).get("tracks",[]))
print(f"{tracks},{recovered}")
PY
)"
  echo "  round $round → tracks,recovered = $got"
  observed+=("$got")

  # Base + the N unsaved tracks must all be present, and the replay must account for N.
  if [[ "$got" != "$((N + 1)),$N" ]]; then
    echo "FAIL round $round: expected tracks,recovered = $((N + 1)),$N — got $got" >&2
    sed -n '1,40p' "$WORK/run2.log" >&2
    exit 1
  fi
done

# Deterministic: every round must agree, not merely each pass its own threshold.
for o in "${observed[@]}"; do
  if [[ "$o" != "${observed[0]}" ]]; then
    echo "FAIL: rounds disagree — ${observed[*]}" >&2
    exit 1
  fi
done

rm -rf "$SESSION_DIR"
echo "PASS: kill -9 mid-edit → full replay, deterministic x$ROUNDS (${observed[0]})"
