#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="${MOSH_INSTALLED_APP:-/Applications/Mosh.app}"
BIN="$APP/Contents/MacOS/Mosh"
CLASS="full"
DRY_RUN=false
SKIP_DEPLOY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      ;;
    --no-deploy)
      SKIP_DEPLOY=true
      ;;
    full|audio|ui)
      CLASS="$1"
      ;;
    *)
      printf 'usage: %s [--dry-run] [--no-deploy] [full|audio|ui]\n' "$0" >&2
      exit 64
      ;;
  esac
  shift
done

steps_json() {
  jq -nc --arg app "$APP" '[
    {name:"deploy", command:"./run-mosh.sh deploy"},
    {name:"codesign", command:"codesign --verify --deep --strict \($app)"},
    {name:"installed_selftest_x3", command:"MOSH_NO_AUDIO=1 \($app)/Contents/MacOS/Mosh --selftest (3 isolated runs)"},
    {name:"installed_selftest_undo", command:"MOSH_NO_AUDIO=1 \($app)/Contents/MacOS/Mosh --selftest-undo"},
    {name:"macos_ui_automation", command:"MOSH_APP_BUNDLE=\($app) python3 scripts/macos-ui-automation-gate.py"},
    {name:"hardware_verify", command:"python3 scripts/verify-hardware/verify.py --bin \($app)/Contents/MacOS/Mosh"}
  ]'
}

safe_tail() {
  LC_ALL=C tail -c "${2:-1200}" "$1" 2>/dev/null | LC_ALL=C tr '\n\t' '  ' | LC_ALL=C tr -cd '[:print:] ' || true
}

step_result() {
  local name="$1" ok="$2" log="${3:-}"
  if [[ -n "$log" ]]; then
    jq -nc --arg name "$name" --argjson ok "$ok" --arg log "$(safe_tail "$log" 1600)" \
      '{name:$name, ok:$ok, detail:{log:$log}}'
  else
    jq -nc --arg name "$name" --argjson ok "$ok" '{name:$name, ok:$ok, detail:{}}'
  fi
}

run_logged() {
  local name="$1"; shift
  local log ok=true
  log="$(mktemp)"
  (cd "$ROOT" && "$@") >"$log" 2>&1 || ok=false
  step_result "$name" "$ok" "$log"
  rm -f "$log"
  [[ "$ok" == true ]]
}

run_selftest_x3() {
  local all_ok=true rows=() i log ok n failed asserts session port
  for i in 1 2 3; do
    log="$(mktemp)"
    session="installed-app-gate-$i-$$"
    port="$((8900 + i + ($$ % 50)))"
    ok=true
    MOSH_NO_AUDIO=1 MOSH_SELFTEST_SESSION="$session" MOSH_SERVICE_PORT="$port" "$BIN" --selftest >"$log" 2>&1 || ok=false
    n="$(grep -Eo '[0-9]+ checks passed, [0-9]+ failed' "$log" | tail -1 | grep -Eo '^[0-9]+' || printf -- '-1')"
    failed="$(grep -Eo '[0-9]+ checks passed, [0-9]+ failed' "$log" | tail -1 | grep -Eo '[0-9]+ failed' | grep -Eo '^[0-9]+' || printf -- '-1')"
    asserts="$(grep -c 'JUCE Assertion' "$log" 2>/dev/null || true)"
    [[ "$ok" == true && "$failed" == "0" && "$asserts" == "0" && "$n" != "-1" ]] || all_ok=false
    rows+=("$(jq -nc --argjson run "$i" --argjson ok "$ok" --argjson checks "$n" --argjson failed "$failed" --argjson asserts "${asserts:-0}" --arg log "$(safe_tail "$log" 900)" '{run:$run, ok:$ok, checks:$checks, failed:$failed, asserts:$asserts, log:$log}')")
    rm -f "$log"
  done
  local detail
  detail="$(printf '%s\n' "${rows[@]}" | jq -sc '{runs:.}')"
  jq -nc --argjson ok "$all_ok" --argjson detail "$detail" '{name:"installed_selftest_x3", ok:$ok, detail:$detail}'
  [[ "$all_ok" == true ]]
}

if [[ "$DRY_RUN" == true ]]; then
  jq -nc --arg app "$APP" --argjson skipDeploy "$SKIP_DEPLOY" --argjson steps "$(steps_json)" \
    '{pass:true, dryRun:true, app:$app, skipDeploy:$skipDeploy, steps:$steps}'
  exit 0
fi

results=()
overall=true

capture_step() {
  local out rc
  set +e
  out="$("$@" 2>/dev/null)"
  rc=$?
  set -e
  results+=("$out")
  [[ "$rc" -eq 0 ]] || overall=false
}

if [[ "$SKIP_DEPLOY" == true ]]; then
  results+=("$(jq -nc '{name:"deploy", ok:true, detail:{skipped:"--no-deploy verifies the already installed app"}}')")
else
  capture_step run_logged deploy ./run-mosh.sh deploy
fi
capture_step run_logged codesign codesign --verify --deep --strict "$APP"

if [[ -x "$BIN" ]]; then
  capture_step run_selftest_x3
  capture_step run_logged installed_selftest_undo env MOSH_NO_AUDIO=1 "$BIN" --selftest-undo
  capture_step run_logged macos_ui_automation env MOSH_APP_BUNDLE="$APP" python3 scripts/macos-ui-automation-gate.py
  if [[ "$CLASS" == "audio" || "$CLASS" == "full" ]]; then
    capture_step run_logged hardware_verify python3 scripts/verify-hardware/verify.py --bin "$BIN"
  else
    results+=("$(jq -nc '{name:"hardware_verify", ok:true, detail:{skipped:"class does not require audio gate"}}')")
  fi
else
  overall=false
  results+=("$(jq -nc --arg bin "$BIN" '{name:"installed_binary", ok:false, detail:{error:"missing executable", bin:$bin}}')")
fi

jq -nc --arg app "$APP" --argjson pass "$overall" --argjson skipDeploy "$SKIP_DEPLOY" --argjson steps "$(printf '%s\n' "${results[@]}" | jq -sc '.')" \
  '{pass:$pass, dryRun:false, app:$app, skipDeploy:$skipDeploy, steps:$steps}'

[[ "$overall" == true ]]
