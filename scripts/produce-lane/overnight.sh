#!/usr/bin/env bash
# overnight.sh — the produce-lane batch driver: preflight -> launch -> N runs
# -> package -> restore the owner's project -> quit. Orchestrates guard.sh,
# launch-app.sh, watchdog.sh, ui/scripts/produceLiveRun.mts, ui/scripts/
# produceReplay.mts and build-package.py; see README.md for the full picture
# and the exact commands to run for a smoke vs a real overnight batch.
#
# Usage:
#   scripts/produce-lane/overnight.sh --ask "produce a dark jerk trap beat at 148 in D minor" \
#     [--max-runs 8] [--stop-at 07:30] [--sonnet-runs 5] \
#     [--openrouter-cap-usd 15] [--max-brain-stalls 3] [--max-disk-mb 500] \
#     [--per-run-timeout-s 720] [--lab-manifest <path>] [--mock-brain] \
#     [--bin <Mosh binary>] [--no-swap] [--no-fixture] [--dry-run]
#
# `--dry-run` prints the resolved plan (run count, model split, paths) and
# exits 0 WITHOUT launching the app, running guard.sh's live measurement, or
# writing anything under the session — safe on any machine, app or no app.
#
# Exit code: 0 if at least one run completed with outcome "done"/"budget" and
# the batch ended normally (including an EARLY stop from --stop-at or the
# guard — that is a successful, honest batch, not a failure); 1 if it stopped
# early from --max-brain-stalls or a guard "stop" condition (something the
# morning report should call out); the app is ALWAYS relaunched-to-quit and
# the owner's project ALWAYS restored on the way out, whichever exit path.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
UI_DIR="$ROOT/ui"
VITE_NODE="$UI_DIR/node_modules/.bin/vite-node"

ASK=""
MAX_RUNS=8
STOP_AT="07:30"
SONNET_RUNS=5
OPENROUTER_CAP_USD=15
MAX_BRAIN_STALLS=3
MAX_DISK_MB=500
PER_RUN_TIMEOUT_S=720
LAB_MANIFEST="$HOME/Library/Mosh/lab-manifests/15drtt-jerk-r0.json"
MOCK_BRAIN=0
BIN_OVERRIDE=""
DO_SWAP=1
DO_FIXTURE=1
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ask) ASK="$2"; shift 2 ;;
    --max-runs) MAX_RUNS="$2"; shift 2 ;;
    --stop-at) STOP_AT="$2"; shift 2 ;;
    --sonnet-runs) SONNET_RUNS="$2"; shift 2 ;;
    --openrouter-cap-usd) OPENROUTER_CAP_USD="$2"; shift 2 ;;
    --max-brain-stalls) MAX_BRAIN_STALLS="$2"; shift 2 ;;
    --max-disk-mb) MAX_DISK_MB="$2"; shift 2 ;;
    --per-run-timeout-s) PER_RUN_TIMEOUT_S="$2"; shift 2 ;;
    --lab-manifest) LAB_MANIFEST="$2"; shift 2 ;;
    --mock-brain) MOCK_BRAIN=1; shift ;;
    --bin) BIN_OVERRIDE="$2"; shift 2 ;;
    --no-swap) DO_SWAP=0; shift ;;
    --no-fixture) DO_FIXTURE=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "overnight.sh: unknown arg $1" >&2; exit 2 ;;
  esac
done

DATE_DIR="$(date +%Y-%m-%d)"
PRODUCE_AB_DIR="${MOSH_PRODUCE_AB_DIR:-$HOME/Library/Mosh/produce-ab/$DATE_DIR}"
RUNS_DIR="$PRODUCE_AB_DIR/runs"
LEDGER="$PRODUCE_AB_DIR/ledger.jsonl"
export MOSH_PRODUCE_AB_DIR="$PRODUCE_AB_DIR"

model_for_run() {
  local n="$1"
  if [ "$n" -le "$SONNET_RUNS" ]; then echo "sonnet"; else echo "opus"; fi
}

if [ "$DRY_RUN" -eq 1 ]; then
  cat <<PLAN
{
  "dryRun": true,
  "ask": $(printf '%s' "${ASK:-null}" | python3 -c 'import json,sys; s=sys.stdin.read(); print(json.dumps(s) if s and s!="null" else "null")'),
  "maxRuns": $MAX_RUNS,
  "stopAt": "$STOP_AT",
  "sonnetRuns": $SONNET_RUNS,
  "openrouterCapUsd": $OPENROUTER_CAP_USD,
  "maxBrainStalls": $MAX_BRAIN_STALLS,
  "maxDiskMb": $MAX_DISK_MB,
  "perRunTimeoutS": $PER_RUN_TIMEOUT_S,
  "labManifest": "$LAB_MANIFEST",
  "mockBrain": $([ "$MOCK_BRAIN" -eq 1 ] && echo true || echo false),
  "produceAbDir": "$PRODUCE_AB_DIR",
  "doSwap": $([ "$DO_SWAP" -eq 1 ] && echo true || echo false),
  "doFixture": $([ "$DO_FIXTURE" -eq 1 ] && echo true || echo false)
}
PLAN
  exit 0
fi

if [ -z "$ASK" ]; then echo "overnight.sh: --ask is required (or --dry-run)" >&2; exit 2; fi
if [ ! -x "$VITE_NODE" ]; then echo "overnight.sh: $VITE_NODE not found — run npm ci under ui/ first" >&2; exit 2; fi

mkdir -p "$RUNS_DIR"
touch "$LEDGER"

ledger_line() {
  # $1 = compact single-line JSON (caller's responsibility to keep it valid).
  printf '%s\n' "$1" >> "$LEDGER"
}

log() { printf '[overnight] %s\n' "$1"; }

# ── stop-at deadline (today's HH:MM; if that's already past, tomorrow's) ────
stop_at_epoch() {
  local hhmm="$1"
  local today_ts tomorrow_ts now_ts
  today_ts="$(date -j -f '%Y-%m-%d %H:%M' "$(date +%Y-%m-%d) $hhmm" +%s 2>/dev/null || echo 0)"
  now_ts="$(date +%s)"
  if [ "$today_ts" -gt "$now_ts" ]; then echo "$today_ts"; return; fi
  tomorrow_ts="$(date -j -v+1d -f '%Y-%m-%d %H:%M' "$(date +%Y-%m-%d) $hhmm" +%s 2>/dev/null || echo 0)"
  echo "$tomorrow_ts"
}
STOP_AT_TS="$(stop_at_epoch "$STOP_AT")"
log "stop-at deadline: $STOP_AT ($(date -r "$STOP_AT_TS" 2>/dev/null || echo "$STOP_AT_TS"))"

disk_used_mb() {
  du -sk "$PRODUCE_AB_DIR" 2>/dev/null | awk '{printf "%d", $1/1024}'
}

openrouter_cost_so_far() {
  # Sum costUsd across every run.json written so far — python3 is already a
  # hard dependency of this repo's tooling (build-package.py itself).
  python3 - "$RUNS_DIR" <<'PY'
import glob, json, os, sys
total = 0.0
for path in glob.glob(os.path.join(sys.argv[1], "*", "run.json")):
    try:
        with open(path) as f:
            total += float(json.load(f).get("costUsd", 0) or 0)
    except Exception:
        pass
print(f"{total:.4f}")
PY
}

# ── owner-project restore + clean quit (always, on every exit path) ────────
APP_PID=""
WATCHDOG_PID=""
cleanup_done=0
cleanup() {
  if [ "$cleanup_done" -eq 1 ]; then return; fi
  cleanup_done=1
  if [ -n "$WATCHDOG_PID" ] && kill -0 "$WATCHDOG_PID" 2>/dev/null; then
    log "stopping watchdog (pid $WATCHDOG_PID)"
    touch "${PRODUCE_AB_DIR}/runs/watchdog-state.txt.STOP" 2>/dev/null || true
    kill -TERM "$WATCHDOG_PID" 2>/dev/null || true
  fi
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
    restore_owner_project_and_quit
  fi
}
trap cleanup EXIT INT TERM

restore_owner_project_and_quit() {
  local last_project token
  token="$(cat "$PRODUCE_AB_DIR/.lab-token" 2>/dev/null || echo "")"
  last_project="$(python3 -c '
import json, sys
try:
    with open(sys.argv[1]) as f:
        print(json.load(f).get("last", ""))
except Exception:
    print("")
' "$HOME/Library/Mosh/session/last-project.json" 2>/dev/null || echo "")"
  if [ -n "$last_project" ] && [ -n "$token" ]; then
    log "restoring owner project: $last_project"
    curl -fsS --max-time 30 -X POST "http://127.0.0.1:47873/command" \
      -H 'content-type: application/json' \
      -d "$(python3 -c 'import json,sys; print(json.dumps({"token": sys.argv[1], "command": {"command": "open_project", "args": {"file": sys.argv[2]}}, "timeoutMs": 20000}))' "$token" "$last_project")" \
      >/dev/null 2>&1 || log "WARNING: open_project restore call failed (non-fatal — the app still quits)"
  else
    log "WARNING: no last-project.json / token — cannot restore the owner's project before quitting"
  fi
  log "quitting app (pid $APP_PID) — SIGTERM"
  kill -TERM "$APP_PID" 2>/dev/null || true
  local waited=0
  while [ "$waited" -lt 20 ]; do
    kill -0 "$APP_PID" 2>/dev/null || break
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$APP_PID" 2>/dev/null; then
    log "pid $APP_PID still alive after 20s SIGTERM — SIGKILL (last resort)"
    kill -KILL "$APP_PID" 2>/dev/null || true
  fi
}

# ── preflight guard ──────────────────────────────────────────────────────────
log "preflight guard check"
guard_status=0
"$SCRIPT_DIR/guard.sh" || guard_status=$?
if [ "$guard_status" -eq 2 ]; then
  log "guard: STOP before ever launching — see the guard line above"
  exit 1
fi
if [ "$guard_status" -eq 1 ]; then
  log "guard: WAIT before launch — retrying up to 10x at 60s"
  ok=0
  for _ in $(seq 1 10); do
    sleep 60
    s=0
    "$SCRIPT_DIR/guard.sh" || s=$?
    if [ "$s" -eq 0 ]; then ok=1; break; fi
    if [ "$s" -eq 2 ]; then log "guard: STOP while waiting to launch"; exit 1; fi
  done
  if [ "$ok" -ne 1 ]; then log "guard: still not healthy after 10 waits — stopping before launch"; exit 1; fi
fi

# ── launch ───────────────────────────────────────────────────────────────────
log "launching app"
launch_args=()
[ -n "$BIN_OVERRIDE" ] && launch_args+=(--bin "$BIN_OVERRIDE")
launch_out="$("$SCRIPT_DIR/launch-app.sh" "${launch_args[@]}")"
log "launch-app.sh: $launch_out"
APP_PID="$(printf '%s\n' "$launch_out" | sed -n 's/.*pid=\([0-9]*\).*/\1/p')"
PORT="$(printf '%s\n' "$launch_out" | sed -n 's/.*port=\([0-9]*\).*/\1/p')"
TOKEN_FILE="$(printf '%s\n' "$launch_out" | sed -n 's/.*token_file=\([^ ]*\).*/\1/p')"
if [ -z "$APP_PID" ] || [ -z "$TOKEN_FILE" ]; then
  log "could not parse launch-app.sh output — aborting"
  exit 1
fi

"$SCRIPT_DIR/watchdog.sh" --pid "$APP_PID" --port "${PORT:-47873}" >>"$RUNS_DIR/watchdog.log" 2>&1 &
WATCHDOG_PID=$!
disown "$WATCHDOG_PID" 2>/dev/null || true
log "watchdog started (pid $WATCHDOG_PID)"

# ── the run loop ─────────────────────────────────────────────────────────────
consecutive_waits=0
consecutive_brain_stalls=0
completed=0
stop_reason=""

run_index=1
while [ "$run_index" -le "$MAX_RUNS" ]; do
  now="$(date +%s)"
  if [ "$now" -ge "$STOP_AT_TS" ]; then
    stop_reason="stop-at deadline reached ($STOP_AT)"
    break
  fi

  guard_status=0
  "$SCRIPT_DIR/guard.sh" || guard_status=$?
  if [ "$guard_status" -eq 2 ]; then
    stop_reason="guard stop before run $run_index"
    break
  fi
  if [ "$guard_status" -eq 1 ]; then
    consecutive_waits=$((consecutive_waits + 1))
    log "guard WAIT before run $run_index (consecutive=$consecutive_waits)"
    if [ "$consecutive_waits" -ge 3 ]; then
      stop_reason="3 consecutive guard waits before run $run_index"
      break
    fi
    sleep 60
    continue
  fi
  consecutive_waits=0

  disk_mb="$(disk_used_mb)"
  if [ -n "$disk_mb" ] && [ "$disk_mb" -ge "$MAX_DISK_MB" ]; then
    stop_reason="disk usage ${disk_mb}MB >= --max-disk-mb ${MAX_DISK_MB}MB"
    break
  fi

  cost_so_far="$(openrouter_cost_so_far)"
  cost_over="$(python3 -c "print(1 if float(\"$cost_so_far\") >= float(\"$OPENROUTER_CAP_USD\") else 0)")"
  if [ "$cost_over" -eq 1 ]; then
    stop_reason="OpenRouter cost \$${cost_so_far} >= --openrouter-cap-usd \$${OPENROUTER_CAP_USD}"
    break
  fi

  model="$(model_for_run "$run_index")"
  run_id="r$(printf '%02d' "$run_index")"
  out_dir="$RUNS_DIR/$run_id"
  mkdir -p "$out_dir"
  log "run $run_id: model=$model seed=$run_index"

  live_args=(--url "http://127.0.0.1:${PORT:-47873}" --token-file "$TOKEN_FILE"
    --ask "$ASK" --run-id "$run_id" --out-dir "$out_dir" --model "$model"
    --hard-timeout-ms "$((PER_RUN_TIMEOUT_S * 1000))")
  [ "$MOCK_BRAIN" -eq 1 ] && live_args+=(--mock-brain)

  run_status=0
  "$VITE_NODE" --mode development "$UI_DIR/scripts/produceLiveRun.mts" "${live_args[@]}" \
    >"$out_dir/stdout.log" 2>"$out_dir/stderr.log" || run_status=$?

  outcome="unknown"
  brain_both_failed=0
  if [ -f "$out_dir/run.json" ]; then
    outcome="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("outcome","unknown"))' "$out_dir/run.json" 2>/dev/null || echo unknown)"
    brain_both_failed="$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
errs = d.get("brainErrors") or []
print(1 if d.get("outcome") == "error" and any("both brain providers failed" in str(e) for e in errs) else 0)
' "$out_dir/run.json" 2>/dev/null || echo 0)"
  fi

  ledger_line "$(python3 -c '
import json, sys
print(json.dumps({"ts": sys.argv[1], "runId": sys.argv[2], "model": sys.argv[3], "exitStatus": int(sys.argv[4]), "outcome": sys.argv[5]}))
' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$run_id" "$model" "$run_status" "$outcome")"

  if [ "$brain_both_failed" -eq 1 ]; then
    consecutive_brain_stalls=$((consecutive_brain_stalls + 1))
    log "run $run_id: both brain providers failed (consecutive stalls=$consecutive_brain_stalls)"
    if [ "$consecutive_brain_stalls" -ge "$MAX_BRAIN_STALLS" ]; then
      stop_reason="$MAX_BRAIN_STALLS consecutive brain stalls (shim + OpenRouter both failing)"
      run_index=$((run_index + 1))
      break
    fi
  else
    consecutive_brain_stalls=0
  fi

  completed=$((completed + 1))

  # ── replay legs (best-effort — exit 2 = "not landed/available tonight",
  #    logged and skipped, never a batch-stopping failure) ───────────────────
  if [ "$DO_SWAP" -eq 1 ] && [ -f "$out_dir/program.jsonl" ] && [ -f "$LAB_MANIFEST" ]; then
    swap_out="$out_dir/swap"
    mkdir -p "$swap_out"
    swap_status=0
    "$VITE_NODE" --mode development "$UI_DIR/scripts/produceReplay.mts" \
      --program "$out_dir/program.jsonl" --out-dir "$swap_out" --run-id "${run_id}-swap" \
      --swap "lab=$LAB_MANIFEST" >"$swap_out/stdout.log" 2>"$swap_out/stderr.log" || swap_status=$?
    if [ "$swap_status" -eq 2 ]; then
      log "run $run_id: --swap leg unavailable tonight (see $swap_out/stderr.log)"
    elif [ "$swap_status" -ne 0 ]; then
      log "run $run_id: --swap leg FAILED (status $swap_status, see $swap_out/stderr.log)"
    else
      log "run $run_id: --swap leg ok"
    fi
  fi

  if [ "$DO_FIXTURE" -eq 1 ] && [ "$run_index" -eq 1 ]; then
    fixture_out="$RUNS_DIR/fixture-replay"
    mkdir -p "$fixture_out"
    fixture_status=0
    "$VITE_NODE" --mode development "$UI_DIR/scripts/produceReplay.mts" \
      --out-dir "$fixture_out" --run-id "fixture" --fixture \
      >"$fixture_out/stdout.log" 2>"$fixture_out/stderr.log" || fixture_status=$?
    if [ "$fixture_status" -eq 2 ]; then
      log "fixture replay unavailable tonight (see $fixture_out/stderr.log)"
    elif [ "$fixture_status" -ne 0 ]; then
      log "fixture replay FAILED (status $fixture_status, see $fixture_out/stderr.log)"
    else
      log "fixture replay ok"
    fi
  fi

  run_index=$((run_index + 1))
done

if [ -z "$stop_reason" ]; then stop_reason="ran out runs ($MAX_RUNS)"; fi
log "batch done: completed=$completed reason=\"$stop_reason\""
ledger_line "$(python3 -c '
import json, sys
print(json.dumps({"ts": sys.argv[1], "kind": "batch-end", "completed": int(sys.argv[2]), "reason": sys.argv[3]}))
' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$completed" "$stop_reason")"

# ── package ──────────────────────────────────────────────────────────────────
log "building the morning package"
python3 "$SCRIPT_DIR/build-package.py" --produce-ab-dir "$PRODUCE_AB_DIR" || log "WARNING: build-package.py failed — runs/ledger are still on disk, package the leftovers by hand"

# cleanup() (the EXIT trap) restores the owner project and quits the app.
if [ "$consecutive_brain_stalls" -ge "$MAX_BRAIN_STALLS" ]; then
  exit 1
fi
exit 0
