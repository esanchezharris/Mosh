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

PIN_REPO="$TMP/pin-repo"
git init -q "$PIN_REPO"
git -C "$PIN_REPO" config user.name test
git -C "$PIN_REPO" config user.email test@example.invalid
mkdir -p "$PIN_REPO/cmake"
printf '# product integration\n' >"$PIN_REPO/cmake/Sentry.cmake"
git -C "$PIN_REPO" add .
git -C "$PIN_REPO" commit -qm base
printf 'CPMAddPackage(NAME sentry-native GIT_TAG 1.2.3)\n' >>"$PIN_REPO/cmake/Sentry.cmake"
assert_success "semantic guard catches a relocated CMake pin" cn_diff_has_cmake_pin "$PIN_REPO"

STATE="$CN_HOME/state/fs-b1.json"
assert_success "state writes atomically" cn_state_write "$STATE" FS-B1 base123 head456 planned thread-1
assert_eq "state file mode is 600" 600 "$(stat -f '%Lp' "$STATE")"
assert_success "matching state resumes" cn_state_validate "$STATE" base123 head456
assert_failure "stale base is rejected" cn_state_validate "$STATE" other head456
assert_failure "stale head is rejected" cn_state_validate "$STATE" base123 other
assert_eq "thread id is recoverable" thread-1 "$(cn_state_field "$STATE" thread_id)"

assert_success "matching gated and remote heads pass" cn_remote_head_matches deadbeef deadbeef
assert_failure "different remote head is rejected" cn_remote_head_matches deadbeef cafebabe

VALID_PLAN='{"id":"FS-B1","planned":true,"gap_exists":true,"route":"safe","summary":"ok"}'
INVALID_PLAN='{"id":"FS-B1","planned":true,"gap_exists":true,"route":"unsafe","summary":"ok"}'
assert_success "valid plan output is accepted" cn_validate_phase_output plan "$VALID_PLAN"
assert_failure "invalid plan enum is rejected" cn_validate_phase_output plan "$INVALID_PLAN"
assert_failure "missing required plan field is rejected" cn_validate_phase_output plan '{"id":"FS-B1"}'
assert_success "valid implementation output is accepted" cn_validate_phase_output implement '{"id":"FS-B1","ready_for_gate":true,"summary":"ok","tests_run":[],"blockers":[]}'
assert_success "valid review output is accepted" cn_validate_phase_output review '{"verdict":"APPROVE","blockers":0,"reasons":[]}'
assert_failure "review blockers must be numeric" cn_validate_phase_output review '{"verdict":"APPROVE","blockers":"0","reasons":[]}'

assert_success "entrypoint has shell syntax" bash -n "$ENTRY"
assert_success "agent git guard permits status" env CN_REAL_GIT="$(command -v git)" PATH="$NATIVE/agent-bin:$PATH" git -C "$ROOT" status --short >/dev/null
assert_failure "agent git guard blocks commits" env CN_REAL_GIT="$(command -v git)" PATH="$NATIVE/agent-bin:$PATH" git commit --allow-empty -m forbidden
assert_failure "agent GitHub guard blocks PR actions" env PATH="$NATIVE/agent-bin:$PATH" gh pr create --draft
if rg -n 'gh[[:space:]]+pr[[:space:]]+merge|merge-one\.sh[[:space:]]+finalize' "$ENTRY" "$NATIVE" --glob '!test.sh' >/dev/null; then
  not_ok "v1 contains no merge operation"
else
  ok "v1 contains no merge operation"
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
assert_success "check succeeds without mutation" env CN_HOME="$TMP/check-home" CN_CODEX_BIN="$STUB_BIN/codex" CN_GH_BIN="$STUB_BIN/gh" "$ENTRY" check >/dev/null
after_status="$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)"
assert_eq "check leaves the checkout unchanged" "$before_status" "$after_status"
assert_failure "unarmed run refuses before orchestration" env CN_HOME="$TMP/unarmed-home" CN_CODEX_BIN="$STUB_BIN/codex" CN_GH_BIN="$STUB_BIN/gh" "$ENTRY" run --lane FS-B1
assert_failure "unarmed run never reaches Codex" test -e "$TMP/codex.called"
assert_failure "unarmed run never reaches GitHub" test -e "$TMP/gh.called"
assert_eq "unarmed run creates no worktree" "$before_worktrees" "$(git -C "$ROOT" worktree list --porcelain)"
assert_eq "unarmed run creates no branch" "$before_branches" "$(git -C "$ROOT" branch --format='%(refname)')"

status_json="$(env CN_HOME="$TMP/status-home" "$ENTRY" status)"
assert_success "status is valid JSON" jq -e . <<<"$status_json"
assert_eq "status reports unarmed" false "$(jq -r '.armed' <<<"$status_json")"
assert_eq "status reports no lane states" 0 "$(jq '.lanes | length' <<<"$status_json")"

if [ "$fail" -ne 0 ]; then
  printf '%d test(s) failed; %d passed\n' "$fail" "$pass" >&2
  exit 1
fi
printf '%d tests passed\n' "$pass"
