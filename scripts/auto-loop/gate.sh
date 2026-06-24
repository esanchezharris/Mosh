#!/usr/bin/env bash
# gate.sh — THE verification gate. Runs the class-correct suite for a worktree and
# emits a machine-readable verdict. This is the ONLY thing that authorizes a merge,
# so it is conservative: any step failing → pass:false.
#
# Usage:  scripts/auto-loop/gate.sh <cheap|native> <worktree> [base-ref]
# Env:    MOSH_SELFTEST_BASELINE  (int) — native selftest check-count floor (N must be ≥);
#                                 if unset, the regression check is skipped (warned).
#         AL_HOME                 — machine-local cache home (default ~/.mosh-auto-loop)
# Output: JSON on stdout. Exit 0 iff pass:true.
#
# Bash 3.2 compatible (macOS). No mapfile / associative arrays.
set -uo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib.sh"
# lib.sh enables `set -e`; the gate INTENTIONALLY runs steps that may fail and records
# them, so turn errexit back OFF (keep nounset + pipefail).
set +e -uo pipefail

CLASS="${1:?usage: gate.sh <cheap|native> <worktree> [base]}"
WT="${2:?worktree required}"
BASE="${3:-origin/main}"
WT="$(cd "$WT" && pwd)"

al_load_cache_env
SESS_BASE="$(unique_session "gate")"
PORT="$(unique_port)"

# Always clean up stray services on exit (the port-8770 orphan trap).
cleanup() { kill_stray_services "$PORT"; rm -f "$STEPS_FILE" 2>/dev/null || true; }
STEPS_FILE="$(mktemp)"
trap cleanup EXIT
kill_stray_services "$PORT"

OVERALL=true
# Tail a log file as a SINGLE LINE of printable text: newlines/tabs → spaces, all
# other control bytes (ANSI/backspace) and partial multibyte chars dropped. Single-
# line + printable-only means jq --arg can never see an unescaped control char.
safe_tail() {
  LC_ALL=C tail -c "${2:-1200}" "$1" 2>/dev/null \
    | LC_ALL=C tr '\n\t' '  ' \
    | LC_ALL=C tr -cd '[:print:] ' || true
}

# Append one step record. $1 name, $2 ok(true/false), $3 detail-json (default {}).
emit_step() {
  local name="$1" ok="$2" detail="${3:-{\}}"
  jq -nc --arg name "$name" --argjson ok "$ok" --argjson detail "$detail" \
    '{name:$name, ok:$ok, detail:$detail}' >> "$STEPS_FILE"
  [ "$ok" = true ] || OVERALL=false
}
# Run a shell command as a step; capture tail of output into detail.log.
run_step() {
  local name="$1"; shift
  local log; log="$(mktemp)"
  local ok=true
  ( cd "$WT" && "$@" ) >"$log" 2>&1 || ok=false
  emit_step "$name" "$ok" "$(jq -nc --arg log "$(safe_tail "$log" 1200)" '{log:$log}')"
  rm -f "$log"
  [ "$ok" = true ]
}

# ── selftest ×3 (native only) ────────────────────────────────────────────────────
SELFTEST_NS="[]"; SELFTEST_FMAX=0; SELFTEST_AMAX=0
run_selftest_x3() {
  local bin="$1" i rc n f a det=true
  local ns="" deterministic=true baseline_ok=true
  local first_n=""
  for i in 1 2 3; do
    local sess="${SESS_BASE}-r$i" log; log="$(mktemp)"
    kill_stray_services "$PORT"
    MOSH_SELFTEST_SESSION="$sess" MOSH_SERVICE_PORT="$PORT" "$bin" --selftest >"$log" 2>&1
    rc=$?
    read n f < <(parse_selftest_tally "$log")
    a="$(count_juce_asserts "$log")"
    ns="$ns $n"
    [ "$rc" -ne 0 ] && det=false
    [ "$f" != "0" ] && det=false
    [ "$a" != "0" ] && det=false
    [ "$n" = "-1" ] && det=false
    if [ -z "$first_n" ]; then first_n="$n"; elif [ "$n" != "$first_n" ]; then deterministic=false; fi
    [ "$f" -gt "$SELFTEST_FMAX" ] 2>/dev/null && SELFTEST_FMAX="$f"
    [ "$a" -gt "$SELFTEST_AMAX" ] 2>/dev/null && SELFTEST_AMAX="$a"
    rm -f "$log"
  done
  # build JSON array of the three N's
  SELFTEST_NS="$(printf '%s\n' $ns | jq -R 'tonumber' | jq -sc .)"
  # baseline regression check
  if [ -n "${MOSH_SELFTEST_BASELINE:-}" ] && [ "$first_n" != "-1" ]; then
    [ "$first_n" -ge "$MOSH_SELFTEST_BASELINE" ] || baseline_ok=false
  fi
  local ok=true
  [ "$det" = true ] || ok=false
  [ "$deterministic" = true ] || ok=false
  [ "$baseline_ok" = true ] || ok=false
  emit_step "selftest_x3" "$ok" "$(jq -nc \
      --argjson ns "$SELFTEST_NS" --argjson fmax "$SELFTEST_FMAX" --argjson amax "$SELFTEST_AMAX" \
      --argjson deterministic "$deterministic" --argjson baseline_ok "$baseline_ok" \
      --arg baseline "${MOSH_SELFTEST_BASELINE:-unset}" \
      '{checks:$ns, failed_max:$fmax, asserts_max:$amax, deterministic:$deterministic, baseline:$baseline, baseline_ok:$baseline_ok}')"
  [ "$ok" = true ]
}

# ── npm helpers ──────────────────────────────────────────────────────────────────
ensure_node_modules() {
  if [ ! -e "$WT/ui/node_modules" ]; then
    run_step "npm_ci" bash -c 'cd ui && (npm ci || npm install)'
  fi
}

run_py_tests() {
  # Run any test_*.py / *_test.py under dirs that this branch touched (relay/, service/).
  local changed; changed="$( ( cd "$WT" && git diff --name-only "$BASE...HEAD" 2>/dev/null ) || true )"
  echo "$changed" | grep -qE '^(relay|service)/' || { emit_step "py_tests" true '{"detail":"no py changes"}'; return 0; }
  local found=0 ok=true log; log="$(mktemp)"
  local t
  for t in $( cd "$WT" && git ls-files 'relay/*test*.py' 'relay/test_*.py' 'service/**/*_test.py' 'service/scripts/*test*.py' 2>/dev/null | sort -u ); do
    found=1
    ( cd "$WT" && python3 "$t" ) >>"$log" 2>&1 || ok=false
  done
  if [ "$found" = 0 ]; then emit_step "py_tests" true '{"detail":"no py tests found for touched dirs"}'
  else emit_step "py_tests" "$ok" "$(jq -nc --arg log "$(safe_tail "$log" 800)" '{log:$log}')"; fi
  rm -f "$log"
}

# ── cheap lane ───────────────────────────────────────────────────────────────────
gate_cheap() {
  ensure_node_modules
  run_step "typecheck" bash -c 'cd ui && npm run typecheck'
  run_step "vitest"    bash -c 'cd ui && npm test'
  run_step "e2e"       bash -c 'cd ui && npm run test:e2e'
  run_py_tests
  # Swappability is guaranteed BY CLASSIFICATION for a cheap PR: classify.sh only
  # returns "cheap" when ZERO compiled/CMake paths are touched, so the C++ binary
  # cannot change. Record that as the proof (the sha256 script needs a built bundle
  # and would force a native build — defeating the cheap lane).
  emit_step "swappability" true '{"proof":"by-classification: no compiled paths touched"}'
}

# ── native lane ──────────────────────────────────────────────────────────────────
gate_native() {
  local cfgflags=()
  [ -n "${AL_CPM_CACHE:-}" ]   && cfgflags+=("-DCPM_SOURCE_CACHE=$AL_CPM_CACHE")
  [ -n "${AL_TRACTION_SRC:-}" ] && cfgflags+=("-DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$AL_TRACTION_SRC")

  # ${arr[@]+...} avoids the bash-3.2 empty-array-under-set-u expanding to "".
  run_step "cmake_configure" cmake --preset macos-arm64-release ${cfgflags[@]+"${cfgflags[@]}"} || return
  run_step "build_app"       cmake --build --preset macos-arm64-release-app   || return
  run_step "build_tests"     cmake --build --preset macos-arm64-release-tests || true

  # Catch2: prefer ctest; fall back to running the MoshTests binary directly.
  local catch_ok=true clog; clog="$(mktemp)"
  if ! ( cd "$WT" && ctest --test-dir build-macos-arm64-release --output-on-failure ) >"$clog" 2>&1; then
    if grep -q "No tests were found" "$clog"; then
      local tb; tb="$( find "$WT/build-macos-arm64-release" -name MoshTests -type f -perm +111 2>/dev/null | head -1 )"
      if [ -n "$tb" ]; then ( "$tb" ) >"$clog" 2>&1 || catch_ok=false; else catch_ok=false; fi
    else catch_ok=false; fi
  fi
  emit_step "catch2" "$catch_ok" "$(jq -nc --arg log "$(safe_tail "$clog" 800)" '{log:$log}')"
  rm -f "$clog"

  local bin; bin="$(resolve_selftest_bin "$WT" release)"
  if [ -z "$bin" ]; then emit_step "selftest_x3" false '{"error":"Mosh binary not found after build"}'; return; fi
  run_selftest_x3 "$bin"

  # verify.py — offline render-to-WAV proof. Needs numpy; a missing env is a gate
  # infra failure → fail-closed (a human installs it) rather than a silent skip.
  run_step "verify_py" bash -c "python3 scripts/verify-hardware/verify.py --bin '$bin'"

  # vitest too (a native PR may also move ui/).
  ensure_node_modules
  run_step "vitest" bash -c 'cd ui && npm test'
}

finish() {
  local steps; steps="$(jq -sc . "$STEPS_FILE")"
  jq -nc \
    --argjson pass "$OVERALL" --arg class "$CLASS" \
    --argjson steps "$steps" --argjson selftest "$SELFTEST_NS" \
    --argjson selftest_failed "$SELFTEST_FMAX" --argjson asserts "$SELFTEST_AMAX" \
    --arg session "$SESS_BASE" --arg port "$PORT" \
    '{pass:$pass, class:$class, session:$session, port:$port,
      selftest:$selftest, selftest_failed:$selftest_failed, asserts:$asserts,
      steps:$steps}'
}

case "$CLASS" in
  cheap)  gate_cheap ;;
  native) gate_native ;;
  *) al_die "unknown class: $CLASS (cheap|native)";;
esac

finish
[ "$OVERALL" = true ]
