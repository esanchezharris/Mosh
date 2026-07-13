#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NATIVE="$ROOT/scripts/first-stranger/codex-native"
ENTRY="$ROOT/scripts/first-stranger/codex-native-loop.sh"

pass=0
fail=0

ok() {
  pass=$((pass + 1))
  printf 'ok %d - %s\n' "$pass" "$1"
}

not_ok() {
  fail=$((fail + 1))
  printf 'not ok %d - %s\n' "$((pass + fail))" "$1" >&2
}

assert_eq() {
  local name="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then ok "$name"; else
    not_ok "$name (want=$want got=$got)"
  fi
}

assert_success() {
  local name="$1"; shift
  if "$@"; then ok "$name"; else not_ok "$name"; fi
}

assert_failure() {
  local name="$1"; shift
  if "$@"; then not_ok "$name (unexpected success)"; else ok "$name"; fi
}

if [ ! -f "$NATIVE/policy.sh" ]; then
  printf 'not ok 1 - policy.sh does not exist yet\n' >&2
  exit 1
fi

# shellcheck source=policy.sh
. "$NATIVE/policy.sh"

assert_eq "docs are safe" safe "$(cn_route_path docs/notes.md)"
assert_eq "ui is safe" safe "$(cn_route_path ui/src/App.tsx)"
assert_eq "service Python is safe" safe "$(cn_route_path service/skills/catalog.py)"
assert_eq "service non-Python is owner" owner "$(cn_route_path service/skills/catalog.json)"
assert_eq "all relay paths are owner" owner "$(cn_route_path relay/helpers.py)"
assert_eq "engine is owner" owner "$(cn_route_path src/engine/MoshEngine.cpp)"
assert_eq "unknown product paths fail to owner" owner "$(cn_route_path scripts/release-helper.sh)"
assert_eq "auto-loop rulebook is never" never "$(cn_route_path scripts/auto-loop/gate.sh)"
assert_eq "native-loop rulebook is never" never "$(cn_route_path scripts/first-stranger/codex-native/policy.sh)"
assert_eq "Claude Workflow rulebook is never" never "$(cn_route_path .claude/workflows/stranger-loop.workflow.js)"
assert_eq "classic First-Stranger drivers are never" never "$(cn_route_path scripts/first-stranger/nightly.sh)"
assert_eq "Claude rules are never" never "$(cn_route_path CLAUDE.md)"
assert_eq "repository agent rules are never" never "$(cn_route_path AGENTS.md)"
assert_eq "numbered specs are never" never "$(cn_route_path docs/02_MOSHOPS_CONTRACT.md)"
assert_eq "program SPEC is never" never "$(cn_route_path docs/first-stranger-program/SPEC.md)"
assert_eq "program backlog is never" never "$(cn_route_path docs/first-stranger-program/backlog.jsonl)"
assert_eq "CMake pin files are never" never "$(cn_route_path cmake/Dependencies.cmake)"
assert_eq "non-pin CMake product files route to owner" owner "$(cn_route_path cmake/AudioFeature.cmake)"
assert_eq "GitHub config is never" never "$(cn_route_path .github/workflows/ci.yml)"
assert_eq "parked arena is never" never "$(cn_route_path arena/round-42.md)"
assert_eq "parked FMS spike is never" never "$(cn_route_path scripts/fms-killshot/score.py)"
assert_eq "control sentinels are never" never "$(cn_route_path docs/first-stranger-program/ARMED)"
assert_eq "never wins aggregate routing" never "$(cn_route_paths docs/a.md relay/x.py .github/workflows/ci.yml)"
assert_eq "owner wins aggregate routing" owner "$(cn_route_paths docs/a.md relay/x.py)"
assert_eq "all-safe aggregate routing" safe "$(cn_route_paths docs/a.md ui/a.ts service/a.py)"
assert_eq "empty diff is never" never "$(cn_route_paths)"
assert_eq "lane ownerMerge forces owner routing" owner "$(cn_effective_route safe '{"ownerMerge":true}')"
assert_eq "lane without ownerMerge preserves safe routing" safe "$(cn_effective_route safe '{"ownerMerge":false}')"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export CN_HOME="$TMP/home"
mkdir -p "$CN_HOME" "$TMP/repo/docs/auto-loop" "$TMP/repo/docs/first-stranger-program"

assert_failure "run is unarmed by default" cn_require_armed
touch "$CN_HOME/ARMED"
chmod 600 "$CN_HOME/ARMED"
assert_success "machine-local sentinel arms run" cn_require_armed
rm "$CN_HOME/ARMED"
touch "$TMP/repo/docs/first-stranger-program/ARMED"
ln -s "$TMP/repo/docs/first-stranger-program/ARMED" "$CN_HOME/ARMED"
assert_failure "symlink sentinel cannot arm run" cn_require_armed
rm "$CN_HOME/ARMED"
rm "$TMP/repo/docs/first-stranger-program/ARMED"

mkdir -p "$TMP/repo/local-automation"
old_home="$CN_HOME"
CN_HOME="$TMP/repo/local-automation"
assert_failure "repository-local automation home is rejected" cn_home_is_external "$TMP/repo"
CN_HOME="$old_home"

assert_failure "no stop sentinel by default" cn_stop_requested "$TMP/repo"
touch "$CN_HOME/STOP"
assert_success "external STOP is honored" cn_stop_requested "$TMP/repo"
rm "$CN_HOME/STOP"
touch "$TMP/repo/docs/auto-loop/STOP"
assert_success "shared STOP is honored" cn_stop_requested "$TMP/repo"
rm "$TMP/repo/docs/auto-loop/STOP"
touch "$TMP/repo/docs/first-stranger-program/STOP"
assert_success "program STOP is honored" cn_stop_requested "$TMP/repo"
rm "$TMP/repo/docs/first-stranger-program/STOP"

CONTROL="$TMP/control"
WORK_ROOT="$TMP/work-root"
LANE_TREE="$WORK_ROOT/fs-b1"
mkdir -p "$CONTROL/docs/auto-loop" "$CONTROL/docs/first-stranger-program" \
  "$LANE_TREE/docs/auto-loop" "$LANE_TREE/docs/first-stranger-program"
touch "$CN_HOME/STOP" "$CONTROL/docs/auto-loop/STOP" "$CONTROL/docs/first-stranger-program/STOP" \
  "$TMP/repo/docs/auto-loop/STOP" "$TMP/repo/docs/first-stranger-program/STOP" \
  "$LANE_TREE/docs/auto-loop/STOP" "$LANE_TREE/docs/first-stranger-program/STOP"
stop_report="$(cn_stop_sources_json "$TMP/repo" "$CONTROL" "$WORK_ROOT")"
assert_eq "STOP report exposes external source" true "$(jq -r .stop_sources.external <<<"$stop_report")"
assert_eq "STOP report exposes control source" true "$(jq -r .stop_sources.control_shared <<<"$stop_report")"
assert_eq "STOP report exposes control program source" true "$(jq -r .stop_sources.control_program <<<"$stop_report")"
assert_eq "STOP report exposes runner shared source" true "$(jq -r .stop_sources.runner_shared <<<"$stop_report")"
assert_eq "STOP report exposes runner program source" true "$(jq -r .stop_sources.runner_program <<<"$stop_report")"
assert_eq "STOP report exposes lane shared source" true "$(jq -r .stop_sources.lane_shared <<<"$stop_report")"
assert_eq "STOP report exposes lane program source" true "$(jq -r .stop_sources.lane_program <<<"$stop_report")"
assert_eq "STOP report identifies the lane worktree" "$(cd "$LANE_TREE" && pwd -P)" "$(jq -r '.lane_stop_sources[0].worktree' <<<"$stop_report")"
rm "$CN_HOME/STOP" "$CONTROL/docs/auto-loop/STOP" "$CONTROL/docs/first-stranger-program/STOP" \
  "$TMP/repo/docs/auto-loop/STOP" "$TMP/repo/docs/first-stranger-program/STOP" \
  "$LANE_TREE/docs/auto-loop/STOP" "$LANE_TREE/docs/first-stranger-program/STOP"

PIN_REPO="$TMP/pin-repo"
git init -q "$PIN_REPO"
git -C "$PIN_REPO" config user.name test
git -C "$PIN_REPO" config user.email test@example.invalid
mkdir -p "$PIN_REPO/cmake"
printf '# product integration\n' >"$PIN_REPO/cmake/Sentry.cmake"
git -C "$PIN_REPO" add .
git -C "$PIN_REPO" commit -qm base
assert_success "clean worktree invariant accepts committed state" cn_worktree_clean "$PIN_REPO"
assert_failure "clean worktree invariant fails closed when Git status errors" cn_worktree_clean "$TMP/missing-worktree"
mkdir -p "$PIN_REPO/ui/node_modules"
printf 'ui/node_modules/\n' >"$PIN_REPO/.gitignore"
printf '%s\n' '{"lockfileVersion":3}' >"$PIN_REPO/ui/package-lock.json"
git -C "$PIN_REPO" add .gitignore ui/package-lock.json
git -C "$PIN_REPO" commit -qm deps
shasum -a 256 "$PIN_REPO/ui/package-lock.json" | awk '{print $1}' >"$PIN_REPO/ui/node_modules/.mosh-deps-stamp"
assert_success "owner-trusted dependencies must match the lane lockfile" cn_trusted_deps_match "$PIN_REPO" "$PIN_REPO/ui/node_modules"
printf 'wrong\n' >"$PIN_REPO/ui/node_modules/.mosh-deps-stamp"
assert_failure "mismatched trusted dependency stamp fails closed" cn_trusted_deps_match "$PIN_REPO" "$PIN_REPO/ui/node_modules"
assert_failure "ignored dependency state is observable" cn_no_ignored_state "$PIN_REPO"
rm -rf "$PIN_REPO/ui/node_modules"
assert_success "purged worktree has no ignored state" cn_no_ignored_state "$PIN_REPO"
BIND_WT="$TMP/binding-worktree"
git -C "$PIN_REPO" worktree add -q -b binding-test "$BIND_WT"
binding_token="$(cn_git_binding "$BIND_WT")"
assert_success "linked worktree Git binding is captured" jq -e '.pointer and .git_dir and .common' <<<"$binding_token" >/dev/null
binding_pointer="$(sed -n '1p' "$BIND_WT/.git")"
printf 'gitdir: /invalid/agent-owned-metadata\n' >"$BIND_WT/.git"
assert_failure "redirected linked-worktree Git metadata fails closed" cn_git_binding "$BIND_WT"
printf '%s\n' "$binding_pointer" >"$BIND_WT/.git"
git -C "$PIN_REPO" worktree remove --force "$BIND_WT"
git -C "$PIN_REPO" branch -D binding-test >/dev/null
printf 'CPMAddPackage(NAME sentry-native GIT_TAG 1.2.3)\n' >>"$PIN_REPO/cmake/Sentry.cmake"
assert_failure "clean worktree invariant rejects tracked mutation" cn_worktree_clean "$PIN_REPO"
assert_success "semantic guard catches a relocated CMake pin" cn_diff_has_cmake_pin "$PIN_REPO"

STATE="$CN_HOME/state/fs-b1.json"
STATE_BINDING='{"pointer":"gitdir: /tmp/example","git_dir":"/tmp/git/worktrees/example","common":"/tmp/git"}'
assert_success "state writes atomically" cn_state_write "$STATE" FS-B1 base123 head456 planned thread-1 "$STATE_BINDING"
assert_eq "state file mode is 600" 600 "$(stat -f '%Lp' "$STATE")"
assert_success "matching state resumes" cn_state_validate "$STATE" base123 head456 "$STATE_BINDING"
assert_failure "stale base is rejected" cn_state_validate "$STATE" other head456 "$STATE_BINDING"
assert_failure "stale head is rejected" cn_state_validate "$STATE" base123 other "$STATE_BINDING"
assert_failure "stale Git binding is rejected" cn_state_validate "$STATE" base123 head456 '{"pointer":"other","git_dir":"other","common":"other"}'
assert_eq "thread id is recoverable" thread-1 "$(cn_state_field "$STATE" thread_id)"

assert_success "matching gated and remote heads pass" cn_remote_head_matches deadbeef deadbeef
assert_failure "different remote head is rejected" cn_remote_head_matches deadbeef cafebabe
assert_failure "on-host gate execution is disabled by default" cn_gate_sandbox_supported cheap $'docs/a.md\nui/a.ts'
assert_success "experimental gate accepts only docs and UI" env CN_ENABLE_EXPERIMENTAL_SEATBELT_GATE=1 bash -c ". '$NATIVE/policy.sh'; cn_gate_sandbox_supported cheap \$'docs/a.md\\nui/a.ts'"
assert_failure "native gate candidate fails closed without stronger isolation" cn_gate_candidate_paths_supported native 'src/Main.cpp'
assert_failure "service test gate candidate fails closed without dynamic-port isolation" cn_gate_candidate_paths_supported cheap 'service/skills/catalog.py'
assert_failure "relay Python gate candidate fails closed outside docs/UI allowlist" cn_gate_candidate_paths_supported cheap 'relay/helpers.py'
assert_failure "mixed docs and owner paths fail closed outside docs/UI allowlist" cn_gate_candidate_paths_supported cheap $'docs/a.md\nrelay/helpers.py'
assert_failure "dependency manifest changes require human gating" cn_gate_candidate_paths_supported cheap 'ui/package-lock.json'

GATE_JSON="$TMP/gate.json"
printf '%s\n' '{"pass":true,"class":"cheap","selftest":[],"selftest_failed":0,"asserts":0,"steps":[]}' >"$GATE_JSON"
assert_success "single typed gate verdict is accepted" cn_validate_gate_result "$GATE_JSON" cheap
printf '%s\n%s\n' '{"pass":false,"class":"cheap","selftest":[],"selftest_failed":0,"asserts":0,"steps":[]}' \
  '{"pass":true,"class":"cheap","selftest":[],"selftest_failed":0,"asserts":0,"steps":[]}' >"$GATE_JSON"
assert_failure "multiple gate documents are rejected" cn_validate_gate_result "$GATE_JSON" cheap
printf '%s\n' '{"pass":true,"class":"cheap"}' >"$GATE_JSON"
assert_failure "incomplete gate verdict is rejected" cn_validate_gate_result "$GATE_JSON" cheap

VALID_PLAN='{"id":"FS-B1","planned":true,"gap_exists":true,"route":"safe","summary":"ok"}'
INVALID_PLAN='{"id":"FS-B1","planned":true,"gap_exists":true,"route":"unsafe","summary":"ok"}'
assert_success "valid plan output is accepted" cn_validate_phase_output plan "$VALID_PLAN"
assert_failure "invalid plan enum is rejected" cn_validate_phase_output plan "$INVALID_PLAN"
assert_failure "missing required plan field is rejected" cn_validate_phase_output plan '{"id":"FS-B1"}'
assert_eq "planned lane with an open gap may proceed" proceed "$(cn_plan_outcome true true)"
assert_eq "closed gap stops before implementation" gap-closed "$(cn_plan_outcome true false)"
assert_eq "unplanned lane routes to human review" needs-human "$(cn_plan_outcome false true)"
assert_failure "malformed plan outcome fails closed" cn_plan_outcome unknown true
assert_success "valid implementation output is accepted" cn_validate_phase_output implement '{"id":"FS-B1","ready_for_gate":true,"summary":"ok","tests_run":[],"blockers":[]}'
assert_success "valid review output is accepted" cn_validate_phase_output review '{"verdict":"APPROVE","blockers":0,"reasons":[]}'
assert_failure "review blockers must be numeric" cn_validate_phase_output review '{"verdict":"APPROVE","blockers":"0","reasons":[]}'
assert_success "worker receipt schema requires a controller-produced receipt" \
  jq -e '.required | index("producer") != null' "$NATIVE/schemas/gate-worker-receipt.json" >/dev/null
assert_success "worker receipt schema fixes the exported artifact set" \
  jq -e '.properties.artifacts | .minItems == 3 and .maxItems == 3 and (.prefixItems | length == 3) and .items == false' \
    "$NATIVE/schemas/gate-worker-receipt.json" >/dev/null
assert_success "passed worker receipts bind exit, gate, and clean status" \
  jq -e '.allOf[0].then.properties | .gate.properties.exit_status.const == 0 and .gate.properties.result.properties.pass.const == true and .repository.properties.tracked_clean.const == true' \
    "$NATIVE/schemas/gate-worker-receipt.json" >/dev/null
assert_success "worker jobs bind nonce, offline image manifests, and resource limits" \
  jq -e '(.required | index("nonce") != null and index("limits") != null) and (.properties.worker.required | index("image_sha256") != null and index("toolchain_manifest_sha256") != null and index("dependency_manifest_sha256") != null)' \
    "$NATIVE/schemas/gate-worker-job.json" >/dev/null
assert_success "worker receipts require controller-observed resource limits" \
  jq -e '(.required | index("limits") != null) and (.properties.limits.allOf[1].properties.timeout_triggered.type == "boolean") and (.allOf[0].then.properties.limits.properties.timeout_triggered.const == false)' \
    "$NATIVE/schemas/gate-worker-receipt.json" >/dev/null

assert_success "entrypoint has shell syntax" bash -n "$ENTRY"
assert_success "agent git guard permits status" env CN_REAL_GIT="$(command -v git)" PATH="$NATIVE/agent-bin:$PATH" git -C "$ROOT" status --short >/dev/null
assert_failure "agent git guard blocks commits" env CN_REAL_GIT="$(command -v git)" PATH="$NATIVE/agent-bin:$PATH" git commit --allow-empty -m forbidden
assert_failure "agent GitHub guard blocks PR actions" env PATH="$NATIVE/agent-bin:$PATH" gh pr create --draft
NPM_REAL_STUB="$TMP/npm-real"
NPM_CAPTURE="$TMP/npm-args"
NPM_ENV_CAPTURE="$TMP/npm-env"
cat >"$NPM_REAL_STUB" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >"$NPM_CAPTURE"
printf '%s\n' \
  "script_shell=${NPM_CONFIG_SCRIPT_SHELL:-}" \
  "update_notifier=${NPM_CONFIG_UPDATE_NOTIFIER:-}" \
  "ci=${CI:-}" \
  "cache=${NPM_CONFIG_CACHE:-}" >"$NPM_ENV_CAPTURE"
EOF
chmod +x "$NPM_REAL_STUB"
export NPM_CAPTURE NPM_ENV_CAPTURE
WRAPPER_HOME="$TMP/npm-home"
mkdir -p "$WRAPPER_HOME"
HOME="$WRAPPER_HOME" CN_REAL_NPM="$NPM_REAL_STUB" "$NATIVE/agent-bin/npm" run dev -- --host 127.0.0.1
assert_success "gate npm guard forces Vite strictPort" rg -q -- '--strictPort' "$NPM_CAPTURE"
assert_success "npm guard pins the lifecycle shell" rg -qx 'script_shell=/bin/sh' "$NPM_ENV_CAPTURE"
assert_success "npm guard disables update notifications" rg -qx 'update_notifier=false' "$NPM_ENV_CAPTURE"
assert_success "npm guard forces CI mode" rg -qx 'ci=1' "$NPM_ENV_CAPTURE"
assert_success "npm guard confines cache to private HOME" rg -qx "cache=$WRAPPER_HOME/.npm" "$NPM_ENV_CAPTURE"
HOME="$WRAPPER_HOME" CN_REAL_NPM="$NPM_REAL_STUB" "$NATIVE/agent-bin/npm" test
assert_success "npm guard disables Vitest cache without an existing separator" rg -qx 'test -- --no-cache' "$NPM_CAPTURE"
HOME="$WRAPPER_HOME" CN_REAL_NPM="$NPM_REAL_STUB" "$NATIVE/agent-bin/npm" run test -- src/agent/skillHarness.test.ts
assert_success "npm guard disables Vitest cache with an existing separator" rg -qx 'run test -- src/agent/skillHarness.test.ts --no-cache' "$NPM_CAPTURE"
HOME="$WRAPPER_HOME" CN_REAL_NPM="$NPM_REAL_STUB" "$NATIVE/agent-bin/npm" run --silent test
assert_success "npm guard cannot be bypassed by run options before the Vitest script" rg -qx 'run --silent test -- --no-cache' "$NPM_CAPTURE"
HOME="$WRAPPER_HOME" CN_REAL_NPM="$NPM_REAL_STUB" "$NATIVE/agent-bin/npm" --silent test --no-cache
assert_success "npm guard appends a pass-through cache flag when npm consumed an earlier flag" \
  rg -qx -- '--silent test --no-cache -- --no-cache' "$NPM_CAPTURE"
HOME="$WRAPPER_HOME" CN_REAL_NPM="$NPM_REAL_STUB" "$NATIVE/agent-bin/npm" run --silent dev
assert_success "Vite strictPort cannot be bypassed by run options" rg -q -- '--strictPort' "$NPM_CAPTURE"
HOME="$WRAPPER_HOME" CN_REAL_NPM="$NPM_REAL_STUB" "$NATIVE/agent-bin/npm" -- test
assert_success "npm command separator cannot bypass the Vitest guard" rg -qx -- '-- test -- --no-cache' "$NPM_CAPTURE"
HOME="$WRAPPER_HOME" CN_REAL_NPM="$NPM_REAL_STUB" "$NATIVE/agent-bin/npm" run -- test
assert_success "npm script separator cannot bypass the Vitest guard" rg -qx 'run -- test -- --no-cache' "$NPM_CAPTURE"
HOME="$WRAPPER_HOME" CN_REAL_NPM="$NPM_REAL_STUB" "$NATIVE/agent-bin/npm" -- run dev
assert_success "npm command separator cannot bypass strictPort" rg -qx -- '-- run dev -- --strictPort' "$NPM_CAPTURE"
HOME="$WRAPPER_HOME" CN_REAL_NPM="$NPM_REAL_STUB" "$NATIVE/agent-bin/npm" run -- dev
assert_success "npm script separator cannot bypass strictPort" rg -qx 'run -- dev -- --strictPort' "$NPM_CAPTURE"
HOME="$WRAPPER_HOME" CN_REAL_NPM="$NPM_REAL_STUB" "$NATIVE/agent-bin/npm" view test
assert_eq "npm guard does not rewrite a non-Vitest view command" 'view test' "$(cat "$NPM_CAPTURE")"
HOME="$WRAPPER_HOME" CN_REAL_NPM="$NPM_REAL_STUB" "$NATIVE/agent-bin/npm" exec test
assert_eq "npm guard does not rewrite a non-Vitest exec command" 'exec test' "$(cat "$NPM_CAPTURE")"
HOME="$WRAPPER_HOME" CN_REAL_NPM="$NPM_REAL_STUB" "$NATIVE/agent-bin/npm" --workspace test run build
assert_eq "npm guard does not confuse an option value with the Vitest script" '--workspace test run build' "$(cat "$NPM_CAPTURE")"
assert_failure "npm guard rejects ambiguous options before a guarded script" \
  env HOME="$WRAPPER_HOME" CN_REAL_NPM="$NPM_REAL_STUB" "$NATIVE/agent-bin/npm" --unknown test
for test_alias in t tst tes; do
  HOME="$WRAPPER_HOME" CN_REAL_NPM="$NPM_REAL_STUB" "$NATIVE/agent-bin/npm" "$test_alias"
  assert_success "npm guard covers the $test_alias alias for Vitest" rg -qx "$test_alias -- --no-cache" "$NPM_CAPTURE"
done
for run_alias in rum urn; do
  HOME="$WRAPPER_HOME" CN_REAL_NPM="$NPM_REAL_STUB" "$NATIVE/agent-bin/npm" "$run_alias" test
  assert_success "npm guard covers the $run_alias alias for npm run test" \
    rg -qx "$run_alias test -- --no-cache" "$NPM_CAPTURE"
done
HOME="$WRAPPER_HOME" CN_REAL_NPM="$NPM_REAL_STUB" "$NATIVE/agent-bin/npm" run test:e2e
assert_failure "gate npm guard does not rewrite non-server scripts" rg -q -- '--strictPort' "$NPM_CAPTURE"
assert_failure "gate npm guard does not rewrite Playwright scripts" rg -q -- '--no-cache' "$NPM_CAPTURE"
MKTEMP_HOME="$TMP/mktemp-home"
mkdir -p "$MKTEMP_HOME"
guarded_tmp="$(TMPDIR="$MKTEMP_HOME" "$NATIVE/agent-bin/mktemp")"
assert_eq "gate mktemp guard confines implicit temporary files" "$MKTEMP_HOME" "$(dirname "$guarded_tmp")"
rm -f "$guarded_tmp"
if rg -n 'gh[[:space:]]+pr[[:space:]]+merge|merge-one\.sh[[:space:]]+finalize' "$ENTRY" "$NATIVE" --glob '!test.sh' >/dev/null; then
  not_ok "v1 contains no merge operation"
else
  ok "v1 contains no merge operation"
fi
if rg -n '"\$CN_GATE".*\|\| true' "$NATIVE/orchestrator.sh" >/dev/null; then
  not_ok "gate exit status is authoritative"
else
  ok "gate exit status is authoritative"
fi
if rg -n '\[ -z "\$\(git -C "\$CN_REPO" status' "$NATIVE/orchestrator.sh" >/dev/null; then
  not_ok "runner cleanliness checks do not suppress Git failures"
else
  ok "runner cleanliness checks do not suppress Git failures"
fi

# The public surface must remain inert unless explicitly armed. These checks use
# stubs that would leave unmistakable markers if Codex or GitHub were reached.
STUB_BIN="$TMP/bin"
mkdir -p "$STUB_BIN"
for tool in codex gh; do
  stub="$STUB_BIN/$tool"
  apply_marker="$TMP/${tool}.called"
  printf '#!/usr/bin/env bash\ntouch %q\nexit 97\n' "$apply_marker" >"$stub"
  chmod +x "$stub"
done

before_status="$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)"
before_worktrees="$(git -C "$ROOT" worktree list --porcelain)"
before_branches="$(git -C "$ROOT" branch --format='%(refname)')"
if check_json="$(env CN_HOME="$TMP/check-home" CN_CODEX_BIN="$STUB_BIN/codex" CN_GH_BIN="$STUB_BIN/gh" "$ENTRY" check)"; then
  not_ok "check fails closed while the production agent secret boundary is unavailable"
else
  ok "check fails closed while the production agent secret boundary is unavailable"
fi
assert_eq "check reports a healthy agent toolchain profile" true "$(jq -r '.checks.agent_toolchain_profile' <<<"$check_json")"
assert_eq "check reports the unavailable agent secret boundary independently" false \
  "$(jq -r '.checks.agent_secret_boundary' <<<"$check_json")"
after_status="$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)"
assert_eq "check leaves the checkout unchanged" "$before_status" "$after_status"
BROKEN_GATE_PROFILE="$TMP/broken-gate.sb"
printf '(version 1)\n(deny default\n' >"$BROKEN_GATE_PROFILE"
if env CN_HOME="$TMP/check-home" CN_CODEX_BIN="$STUB_BIN/codex" CN_GH_BIN="$STUB_BIN/gh" \
    CN_GATE_PROFILE="$BROKEN_GATE_PROFILE" "$ENTRY" check >"$TMP/broken-check.json"; then
  not_ok "check rejects an invalid gate profile"
else
  ok "check rejects an invalid gate profile"
fi
assert_eq "check reports invalid gate profile" false "$(jq -r '.checks.gate_profile' "$TMP/broken-check.json")"
FOREIGN_DEPS="$TMP/foreign-deps"
mkdir -p "$FOREIGN_DEPS"
cp "$ROOT/ui/node_modules/.mosh-deps-stamp" "$FOREIGN_DEPS/.mosh-deps-stamp"
if env CN_HOME="$TMP/check-home" CN_CODEX_BIN="$STUB_BIN/codex" CN_GH_BIN="$STUB_BIN/gh" \
    CN_TRUSTED_UI_DEPS="$FOREIGN_DEPS" "$ENTRY" check >"$TMP/foreign-deps-check.json"; then
  not_ok "check rejects a lock-matched dependency root outside the runner"
else
  ok "check rejects a lock-matched dependency root outside the runner"
fi
assert_eq "foreign dependency root reports an unhealthy agent profile" false \
  "$(jq -r '.checks.agent_toolchain_profile' "$TMP/foreign-deps-check.json")"
FAKE_BREW="$TMP/fake-homebrew"
mkdir -p "$FAKE_BREW/bin" "$FAKE_BREW/Cellar" "$FAKE_BREW/opt" \
  "$FAKE_BREW/lib/node_modules" "$FAKE_BREW/etc/openssl@3"
touch "$FAKE_BREW/bin/node" "$FAKE_BREW/bin/npm"
chmod +x "$FAKE_BREW/bin/node" "$FAKE_BREW/bin/npm"
if env CN_HOME="$TMP/check-home" CN_CODEX_BIN="$STUB_BIN/codex" CN_GH_BIN="$STUB_BIN/gh" \
    CN_BREW_ROOT="$FAKE_BREW" "$ENTRY" check >"$TMP/foreign-brew-check.json"; then
  not_ok "check rejects an unexpected Homebrew root even when its shape is plausible"
else
  ok "check rejects an unexpected Homebrew root even when its shape is plausible"
fi
assert_eq "unexpected Homebrew root reports an unhealthy agent profile" false \
  "$(jq -r '.checks.agent_toolchain_profile' "$TMP/foreign-brew-check.json")"
if env CN_HOME="$TMP/check-home" CN_CODEX_BIN="$STUB_BIN/codex" CN_GH_BIN="$STUB_BIN/gh" \
    CN_BREW_ROOT="$TMP/missing-homebrew" "$ENTRY" check >"$TMP/missing-brew-check.json"; then
  not_ok "check rejects a missing Homebrew root"
else
  ok "check rejects a missing Homebrew root"
fi
assert_eq "missing Homebrew root reports an unhealthy agent profile" false \
  "$(jq -r '.checks.agent_toolchain_profile' "$TMP/missing-brew-check.json")"
if env CN_HOME="$TMP/check-home" CN_CODEX_BIN="$STUB_BIN/codex" CN_GH_BIN="$STUB_BIN/gh" \
    CN_REAL_NPM=/bin/true "$ENTRY" check >"$TMP/unpinned-npm-check.json"; then
  not_ok "check rejects an unpinned npm executable"
else
  ok "check rejects an unpinned npm executable"
fi
assert_eq "unpinned npm reports an unhealthy agent profile" false \
  "$(jq -r '.checks.agent_toolchain_profile' "$TMP/unpinned-npm-check.json")"
if env CN_HOME="$TMP/check-home" CN_CODEX_BIN="$STUB_BIN/codex" CN_GH_BIN="$STUB_BIN/gh" \
    CN_AGENT_PATH=/usr/bin:/bin "$ENTRY" check >"$TMP/unpinned-path-check.json"; then
  not_ok "check rejects an unpinned agent PATH"
else
  ok "check rejects an unpinned agent PATH"
fi
assert_eq "unpinned PATH reports an unhealthy agent profile" false \
  "$(jq -r '.checks.agent_toolchain_profile' "$TMP/unpinned-path-check.json")"
assert_failure "unarmed run refuses before orchestration" env CN_HOME="$TMP/unarmed-home" CN_CODEX_BIN="$STUB_BIN/codex" CN_GH_BIN="$STUB_BIN/gh" "$ENTRY" run --lane FS-B1
assert_failure "unarmed run never reaches Codex" test -e "$TMP/codex.called"
assert_failure "unarmed run never reaches GitHub" test -e "$TMP/gh.called"
assert_eq "unarmed run creates no worktree" "$before_worktrees" "$(git -C "$ROOT" worktree list --porcelain)"
assert_eq "unarmed run creates no branch" "$before_branches" "$(git -C "$ROOT" branch --format='%(refname)')"

mkdir -p "$TMP/boundary-home"
touch "$TMP/boundary-home/ARMED"
chmod 700 "$TMP/boundary-home"
chmod 600 "$TMP/boundary-home/ARMED"
if env CN_HOME="$TMP/boundary-home" CN_CODEX_BIN="$STUB_BIN/codex" CN_GH_BIN="$STUB_BIN/gh" \
    CN_HERMETIC_FIXTURE=1 CN_GH_REPO=fixture/repo CN_TEST_REMOTE="$TMP/remote.git" \
    "$ENTRY" run --lane FS-B1 >"$TMP/boundary-run.out" 2>"$TMP/boundary-run.err"; then
  not_ok "armed production run fails closed before orchestration without a secret boundary"
else
  ok "armed production run fails closed before orchestration without a secret boundary"
fi
assert_success "secret-boundary refusal is explicit" rg -q 'agent secret boundary is unavailable' "$TMP/boundary-run.err"
assert_failure "secret-boundary refusal never reaches Codex" test -e "$TMP/codex.called"
assert_failure "secret-boundary refusal never reaches GitHub" test -e "$TMP/gh.called"
assert_eq "secret-boundary refusal creates no worktree" "$before_worktrees" "$(git -C "$ROOT" worktree list --porcelain)"
assert_eq "secret-boundary refusal creates no branch" "$before_branches" "$(git -C "$ROOT" branch --format='%(refname)')"
assert_failure "secret-boundary refusal creates no lock" test -e "$TMP/boundary-home/run.lock"

status_json="$(env CN_HOME="$TMP/status-home" CN_CONTROL_REPO="$ROOT" CN_WORK_ROOT="$TMP/status-work" "$ENTRY" status)"
assert_success "status is valid JSON" jq -e . <<<"$status_json"
assert_eq "status exposes agent toolchain profile health" true "$(jq -r '.checks.agent_toolchain_profile' <<<"$status_json")"
assert_eq "status exposes the unavailable agent secret boundary" false \
  "$(jq -r '.checks.agent_secret_boundary' <<<"$status_json")"
assert_eq "status reports unarmed" false "$(jq -r '.armed' <<<"$status_json")"
assert_eq "status reports no lane states" 0 "$(jq '.lanes | length' <<<"$status_json")"
assert_eq "status exposes external STOP independently" false "$(jq -r '.stop_sources.external' <<<"$status_json")"
assert_eq "status exposes control shared STOP independently" false "$(jq -r '.stop_sources.control_shared' <<<"$status_json")"
assert_eq "status exposes control program STOP independently" false "$(jq -r '.stop_sources.control_program' <<<"$status_json")"
assert_eq "status exposes runner shared STOP independently" false "$(jq -r '.stop_sources.runner_shared' <<<"$status_json")"
assert_eq "status exposes runner program STOP independently" false "$(jq -r '.stop_sources.runner_program' <<<"$status_json")"
assert_eq "status exposes lane shared STOP independently" false "$(jq -r '.stop_sources.lane_shared' <<<"$status_json")"
assert_eq "status exposes lane program STOP independently" false "$(jq -r '.stop_sources.lane_program' <<<"$status_json")"

if [ "$fail" -ne 0 ]; then
  printf '%d test(s) failed; %d passed\n' "$fail" "$pass" >&2
  exit 1
fi
printf '%d tests passed\n' "$pass"
