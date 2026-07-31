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
  local ns="" deterministic=true baseline_ok=true rc_nonzero=""
  local first_n=""
  for i in 1 2 3; do
    local sess="${SESS_BASE}-r$i" log; log="$(mktemp)"
    # A FRESH service port per run: reusing one port across the 3 runs raced on service
    # teardown and intermittently produced a non-zero exit even with 0 failed checks
    # (a false gate-red). unique_port skips any still-alive prior service.
    local sport; sport="$(unique_port)"
    kill_stray_services "$sport"
    # -ApplePersistenceIgnoreState YES: a headless selftest must NEVER inherit AppKit's
    # window-restoration / "reopen after crash" modal. After repeated crashes macOS shows
    # NSPersistentUIRestorer's runModal during launch, which blocks a headless run forever
    # (cost a 2h hang once). NSUserDefaults reads the flag from argv, suppressing it.
    MOSH_SELFTEST_SESSION="$sess" MOSH_SERVICE_PORT="$sport" "$bin" --selftest -ApplePersistenceIgnoreState YES >"$log" 2>&1
    rc=$?
    kill_stray_services "$sport"; sleep 1   # let this run's service die before the next
    read n f < <(parse_selftest_tally "$log")
    a="$(count_juce_asserts "$log")"
    ns="$ns $n"
    # Strict, fail-closed: a run is bad on any of a non-zero exit, a failing check (f>0), a
    # JUCE assertion (a>0), or a missing summary (n=-1, i.e. it crashed before printing).
    # rc is also recorded for diagnostics. (The native-gate false-reject was NOT rc — it
    # was count_juce_asserts doubling "0" on zero matches; fixed in lib.sh.)
    [ "$rc" -ne 0 ] && { rc_nonzero="$rc_nonzero r$i:rc=$rc"; det=false; }
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
      --arg baseline "${MOSH_SELFTEST_BASELINE:-unset}" --arg rcnz "$rc_nonzero" \
      '{checks:$ns, failed_max:$fmax, asserts_max:$amax, deterministic:$deterministic, baseline:$baseline, baseline_ok:$baseline_ok, nonzero_exit:($rcnz|if .=="" then "none" else .|ltrimstr(" ") end)}')"
  [ "$ok" = true ]
}

# ── npm helpers ──────────────────────────────────────────────────────────────────
# Install ui deps if they're absent OR have drifted from ui/package-lock.json. The drift
# check (deps_need_install, lib.sh) is the fix for the shared-node_modules trap: worktrees
# symlink ui/node_modules to a shared cache, so a bare `[ -e node_modules ]` check can't tell
# that a merged PR changed the lockfile out from under it — and the gate would run `tsc`/tests
# against stale deps. The check is a cheap hash compare on the common no-change path.
ensure_node_modules() {
  deps_need_install "$WT/ui" || return 0
  # Drift (or absent). If node_modules is a symlink into the shared cache, unlink it FIRST so
  # the reinstall builds a fresh LOCAL node_modules for this worktree rather than mutating the
  # cache other live worktrees still share (avoids cross-worktree reinstall thrash). This only
  # removes our own symlink — the shared cache dir is untouched.
  if [ -L "$WT/ui/node_modules" ]; then
    al_log "ui/node_modules symlink is stale vs package-lock.json — unlinking for a local install"
    rm -f "$WT/ui/node_modules"
  fi
  if run_step "npm_ci" bash -c 'cd ui && (npm ci || npm install)'; then
    deps_write_stamp "$WT/ui"
  fi
}

run_py_tests() {
  # Run any test_*.py / *_test.py under dirs that this branch touched (relay/, service/).
  local changed; changed="$( ( cd "$WT" && git diff --name-only "$BASE...HEAD" 2>/dev/null ) || true )"
  echo "$changed" | grep -qE '^(relay|service)/' || { emit_step "py_tests" true '{"detail":"no py changes"}'; return 0; }
  local found=0 ok=true failed_tests="" log; log="$(mktemp)"
  local t
  for t in $( cd "$WT" && git ls-files 'relay/*test*.py' 'relay/test_*.py' 'service/**/*_test.py' 'service/scripts/*test*.py' 2>/dev/null | sort -u ); do
    found=1
    printf '\n=== PYTEST_FILE %s ===\n' "$t" >>"$log"
    if ( cd "$WT" && python3 "$t" ) >>"$log" 2>&1; then
      printf '=== PYTEST_PASS %s ===\n' "$t" >>"$log"
    else
      ok=false
      failed_tests="$failed_tests $t"
      printf '=== PYTEST_FAIL %s ===\n' "$t" >>"$log"
    fi
  done
  if [ "$found" = 0 ]; then emit_step "py_tests" true '{"detail":"no py tests found for touched dirs"}'
  else
    [ "$ok" = true ] || printf '\nFAILED_TESTS%s\n' "$failed_tests" >>"$log"
    emit_step "py_tests" "$ok" "$(jq -nc --arg log "$(safe_tail "$log" 1000)" --arg failed "$failed_tests" \
      '{log:$log, failed_tests:($failed|split(" ")|map(select(length>0)))}')"
  fi
  rm -f "$log"
}

# ── DAW-parity honesty checks (P1) ───────────────────────────────────────────────
# Pure static text analysis — no binary, no build, <5s total — so they run in BOTH
# lanes. Each fails on its own: an untested dispatch command (coverage ledger), an
# unmapped eval scenario / a gap pointing at a done backlog item (model lint), or a
# stale docs/FEATURE_AUDIT.md (scoreboard --check).
run_parity_checks() {
  run_step "parity_model_lint" bash -c 'python3 scripts/daw-conformance/model_lint.py'
  run_step "parity_coverage"   bash -c 'python3 scripts/daw-conformance/coverage_check.py'
  run_step "parity_scoreboard" bash -c 'python3 scripts/daw-conformance/scoreboard.py --check'
}

run_loop_control_checks() {
  run_step "program_stop" bash scripts/auto-loop/program-stop-selftest.sh
  run_step "stranger_loop_stop" node scripts/auto-loop/stranger-loop-stop-selftest.mjs
}

# ── cheap lane ───────────────────────────────────────────────────────────────────
gate_cheap() {
  ensure_node_modules
  run_parity_checks
  run_loop_control_checks
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

# Advisory (never gates): when a change touches paths only the OWNER's hands-on lane can
# verify, name the affected rows of the parity runbook (docs/VERIFICATION.md §"Parity
# hands-on checklist") so the by-ear re-pass isn't forgotten. Pure notice — always ok:true.
runbook_advisory() {
  local changed rows=""
  changed="$(cd "$WT" && git diff --name-only "$BASE"...HEAD 2>/dev/null)" || return 0
  echo "$changed" | grep -qE "Record|Take|InputDevice|input_monitor|arm_track|count_in" && rows="$rows REC-mic,REC-latency,REC-monitor"
  echo "$changed" | grep -qE "fade|crossfade|Crossfade|Fade" && rows="$rows EAR-fades"
  echo "$changed" | grep -qiE "warp|stretch|autoTempo" && rows="$rows EAR-warp"
  echo "$changed" | grep -qE "export_stems|Stem|Renderer|export_audio" && rows="$rows EAR-stems"
  echo "$changed" | grep -qE "midi_input|MidiInput" && rows="$rows MIDI-in"
  echo "$changed" | grep -qE "^relay/|multiplayer|LockManager" && rows="$rows MP-two-mac"
  if [ -n "$rows" ]; then
    emit_step "runbook_advisory" true "{\"note\":\"owner hands-on rows affected:$rows — docs/VERIFICATION.md parity checklist\"}"
  fi
  return 0
}

# ── native lane ──────────────────────────────────────────────────────────────────
gate_native() {
  run_parity_checks
  run_loop_control_checks
  runbook_advisory

  # The native build runs `npm install` INSIDE CMake (the phone-companion bundle step), and
  # it only survives a REAL, COMPLETE local ui/node_modules. Two ways it isn't one:
  #   - a symlink (new-worktree.sh's cheap-lane speedup): npm reifies the link away into a
  #     partial install and ninja dies on a missing vite/esbuild — PRs #489, #490, #503;
  #   - absent entirely: new-worktree.sh skips the symlink when the main seat's
  #     ui/package-lock.json differs from the worktree's, which happens whenever the seat is
  #     behind origin/main — and a stale seat is the NORMAL state, since merge-one.sh only
  #     fetches it. Then CMake's npm install builds the partial tree itself — PR #512.
  # So: de-symlink if needed, then install whenever the deps aren't demonstrably in sync.
  # (The first version of this guard only handled the symlink case and #512 walked straight
  # through the hole. The cheap lane keeps the symlink — its npm use is read-only.)
  if [ -L "$WT/ui/node_modules" ]; then
    al_log "native lane: ui/node_modules is a symlink — replacing with a real local install"
    rm -f "$WT/ui/node_modules"
  fi
  if [ ! -d "$WT/ui/node_modules" ] || deps_need_install "$WT/ui"; then
    al_log "native lane: ui/node_modules absent or drifted — installing before the build"
    run_step "npm_ci_native" bash -c 'cd ui && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund)' || return
    deps_write_stamp "$WT/ui"
  fi

  local cfgflags=()
  [ -n "${AL_CPM_CACHE:-}" ]   && cfgflags+=("-DCPM_SOURCE_CACHE=$AL_CPM_CACHE")
  [ -n "${AL_TRACTION_SRC:-}" ] && cfgflags+=("-DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$AL_TRACTION_SRC")

  # ${arr[@]+...} avoids the bash-3.2 empty-array-under-set-u expanding to "".
  run_step "cmake_configure" cmake --preset macos-arm64-release ${cfgflags[@]+"${cfgflags[@]}"} || return
  run_step "build_app"       cmake --build --preset macos-arm64-release-app   || return
  run_step "build_tests"     cmake --build --preset macos-arm64-release-tests || true

  # Fail-closed: the built app bundle MUST carry NSSpeechRecognitionUsageDescription, or
  # macOS TCC hard-crashes (SIGABRT) the instant the always-on voice calls SFSpeechRecognizer
  # — a crash that has masqueraded as a plugin-host crash. The build injects it via the
  # always-run MoshFixInfoPlist target; assert it independently so a future preset/target
  # change can't silently re-ship a crashing bundle.
  local _app_plist; _app_plist="$( find "$WT/build-macos-arm64-release" -path '*Mosh.app/Contents/Info.plist' 2>/dev/null | head -1 )"
  if [ -n "$_app_plist" ] && /usr/bin/plutil -extract NSSpeechRecognitionUsageDescription raw "$_app_plist" >/dev/null 2>&1; then
    emit_step "info_plist_tcc_keys" true "$(jq -nc --arg p "${_app_plist#$WT/}" '{plist:$p,key:"NSSpeechRecognitionUsageDescription present"}')"
  else
    emit_step "info_plist_tcc_keys" false "$(jq -nc --arg p "${_app_plist:-<not found>}" '{plist:$p,error:"NSSpeechRecognitionUsageDescription MISSING — bundle would TCC-crash on voice"}')"
  fi

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

  # verify.py — offline render-to-WAV proof + golden-audio checksum gate (--gate). Needs
  # numpy; a missing env is a gate infra failure → fail-closed (a human installs it) rather
  # than a silent skip. A golden checksum miss reds the merge (intentional DSP/adapter
  # changes regenerate the baseline with --update-golden).
  run_step "verify_py" bash -c "python3 scripts/verify-hardware/verify.py --gate --bin '$bin'"

  # DAW-conformance — the gathered reality-pack eval suite (docs/reality-pack/) replayed
  # through the real command surface. Fails on an in-scope regression (known gaps are
  # tracked, not failed) AND on any drift from the committed verdicts.json — a behavior
  # change must land its verdict flip (conformance.py --write-verdicts + scoreboard.py)
  # in the same PR. Reuses the run-script + WAV harness, so it needs the same
  # freshly-built binary + numpy.
  run_step "daw_conformance" bash -c "python3 scripts/daw-conformance/conformance.py --bin '$bin'"

  # …and assert the committed SCOREBOARD still matches that run. conformance.py only
  # writes report.json; regenerating docs/FEATURE_AUDIT.md was a MANUAL step nobody did,
  # so the headline number went stale for ~3 weeks and ~18 PRs — it advertised "134/152,
  # 17 gap" while the real figure was 150/152 with ZERO gaps (every Export row it listed
  # as missing had shipped). A stale scoreboard is worse than none: it makes the product
  # look less finished than it is, and it hides real regressions in the same table.
  #
  # scoreboard.py is deterministic for a given report.json (verified: byte-identical
  # across runs, no embedded timestamp), so a plain diff is a safe gate. This does NOT
  # regenerate-and-commit — it fails and tells you to, keeping generated files honest
  # without the gate mutating tracked state.
  run_step "daw_scoreboard_current" bash -c '
    cp docs/FEATURE_AUDIT.md /tmp/_fa_committed.md
    python3 scripts/daw-conformance/scoreboard.py >/dev/null
    if ! diff -q /tmp/_fa_committed.md docs/FEATURE_AUDIT.md >/dev/null; then
      echo "docs/FEATURE_AUDIT.md is STALE vs this conformance run. Regenerate and commit:"
      echo "  python3 scripts/daw-conformance/scoreboard.py"
      diff /tmp/_fa_committed.md docs/FEATURE_AUDIT.md | head -40
      cp /tmp/_fa_committed.md docs/FEATURE_AUDIT.md   # leave the tree as we found it
      exit 1
    fi'

  # vitest too (a native PR may also move ui/).
  ensure_node_modules
  run_step "vitest" bash -c 'cd ui && npm test'

  # DAW-parity P5 replay lane (ADVISORY for its first stable week — the `|| true` makes a
  # replay failure visible in the step log without failing the gate; promote to blocking
  # by dropping the `|| true`): replay the e2e-captured UI command traces through the
  # freshly-built binary. No traces captured -> clean no-op.
  run_step "replay_e2e" bash -c "python3 scripts/daw-conformance/replay_e2e_log.py '$bin' || true"
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
