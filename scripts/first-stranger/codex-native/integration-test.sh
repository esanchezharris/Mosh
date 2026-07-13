#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENTRY="$ROOT/scripts/first-stranger/codex-native-loop.sh"
TMP="$(mktemp -d)"
OUTSIDE_FIXTURE=""
GATE_ESCAPE_MARKER="/tmp/codex-native-gate-escape-test"
rm -f "$GATE_ESCAPE_MARKER"
trap 'rm -rf "$TMP" "${OUTSIDE_FIXTURE:-}"; rm -f "$GATE_ESCAPE_MARKER"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'ok %d - %s\n' "$pass" "$1"; }
not_ok() { fail=$((fail + 1)); printf 'not ok %d - %s\n' "$((pass + fail))" "$1" >&2; }
assert_eq() { local n="$1" w="$2" g="$3"; [ "$w" = "$g" ] && ok "$n" || not_ok "$n (want=$w got=$g)"; }
assert_match() { local n="$1" p="$2" f="$3"; rg -q -- "$p" "$f" && ok "$n" || not_ok "$n"; }
assert_no_match() { local n="$1" p="$2" f="$3"; if rg -q -- "$p" "$f"; then not_ok "$n"; else ok "$n"; fi; }

REMOTE="$TMP/remote.git"
REPO="$TMP/repo"
HOME_DIR="$TMP/automation"
WORK_ROOT="$TMP/worktrees"
STUB_STATE="$TMP/stub-state"
mkdir -p "$STUB_STATE" "$HOME_DIR"
mkdir -p "$TMP/codex-home"
export CODEX_HOME="$TMP/codex-home"
git init --bare -q "$REMOTE"
git init -q "$REPO"
git -C "$REPO" checkout -q -b main
git -C "$REPO" config user.name "Codex Native Test"
git -C "$REPO" config user.email "codex-native@test.invalid"

mkdir -p "$REPO/docs/first-stranger-program/lanes" "$REPO/scripts/auto-loop" "$REPO/ui"
printf '# fixture\n' >"$REPO/AGENTS.md"
printf 'ui/node_modules/\n' >"$REPO/.gitignore"
printf 'node_modules\n' >"$REPO/ui/.gitignore"
printf '# fixture spec\n' >"$REPO/docs/first-stranger-program/SPEC.md"
printf '# FS-Z1 fixture plan\n' >"$REPO/docs/first-stranger-program/lanes/fs-z1.md"
printf '# FS-Z2 closed-gap fixture plan\n' >"$REPO/docs/first-stranger-program/lanes/fs-z2.md"
printf '# FS-Z3 unplanned fixture plan\n' >"$REPO/docs/first-stranger-program/lanes/fs-z3.md"
printf '# FS-Z4 publication-race fixture plan\n' >"$REPO/docs/first-stranger-program/lanes/fs-z4.md"
printf '# FS-Z5 base-race fixture plan\n' >"$REPO/docs/first-stranger-program/lanes/fs-z5.md"
printf '# FS-Z6 existing-PR fixture plan\n' >"$REPO/docs/first-stranger-program/lanes/fs-z6.md"
printf '%s\n' '{"name":"fixture-ui","private":true,"scripts":{}}' >"$REPO/ui/package.json"
printf '%s\n' '{"name":"fixture-ui","lockfileVersion":3,"requires":true,"packages":{}}' >"$REPO/ui/package-lock.json"
printf '%s\n' '{"id":"FS-Z1","lane":"Z","title":"Hermetic lane","class":"cheap","status":"ready","order":1,"files":["docs/"],"acceptance":"fixture"}' >"$REPO/docs/first-stranger-program/backlog.jsonl"
printf '%s\n' \
  '{"id":"FS-Z2","lane":"Z","title":"Closed gap","class":"cheap","status":"ready","order":2,"files":["docs/"],"acceptance":"fixture"}' \
  '{"id":"FS-Z3","lane":"Z","title":"Unplanned lane","class":"cheap","status":"ready","order":3,"files":["docs/"],"acceptance":"fixture"}' \
  '{"id":"FS-Z4","lane":"Z","title":"Publication race","class":"cheap","status":"ready","order":4,"files":["docs/"],"acceptance":"fixture"}' \
  '{"id":"FS-Z5","lane":"Z","title":"Base race","class":"cheap","status":"ready","order":5,"files":["docs/"],"acceptance":"fixture"}' \
  '{"id":"FS-Z6","lane":"Z","title":"Existing PR mismatch","class":"cheap","status":"ready","order":6,"files":["docs/"],"acceptance":"fixture"}' \
  >>"$REPO/docs/first-stranger-program/backlog.jsonl"

cat >"$REPO/scripts/auto-loop/classify.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
jq -nc '{class:"cheap",excluded:false,excluded_paths:[],paths:["docs/generated.md"],diff_empty:false}'
EOF
cat >"$REPO/scripts/auto-loop/gate.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
pass=true
[ -z "${GH_TOKEN:-}${OPENAI_API_KEY:-}" ] || pass=false
[ "${CI:-}" = 1 ] || pass=false
[ ! -e "$2/ui/node_modules/.bin/forged-gate-tool" ] || pass=false
touch /tmp/codex-native-gate-escape-test 2>/dev/null || true
printf 'tampered\n' 2>/dev/null >"$2/.git" || true
if [ -e "$2/tamper-gate" ]; then
  printf 'gate mutation\n' >>"$2/AGENTS.md" 2>/dev/null || pass=false
fi
jq -nc --argjson pass "$pass" '{pass:$pass,class:"cheap",selftest:[],selftest_failed:0,asserts:0,steps:[{name:"fixture",ok:$pass}]}'
[ "$pass" = true ]
EOF
chmod +x "$REPO/scripts/auto-loop/classify.sh" "$REPO/scripts/auto-loop/gate.sh"
git -C "$REPO" add .
git -C "$REPO" commit -qm "fixture"
git -C "$REPO" remote add origin "$REMOTE"
git -C "$REPO" push -q -u origin main

mkdir -p "$REPO/ui/node_modules/playwright-core"
shasum -a 256 "$REPO/ui/package-lock.json" | awk '{print $1}' >"$REPO/ui/node_modules/.mosh-deps-stamp"
printf '%s\n' \
  '{"browsers":[{"name":"chromium","revision":"1228"},{"name":"chromium-headless-shell","revision":"1228"},{"name":"ffmpeg","revision":"1011"}]}' \
  >"$REPO/ui/node_modules/playwright-core/browsers.json"
export CN_TRUSTED_UI_DEPS="$REPO/ui/node_modules"
export CN_ENABLE_EXPERIMENTAL_SEATBELT_GATE=1

GATE_PROFILE="$ROOT/scripts/first-stranger/codex-native/gate.sb"
SANDBOX_TMP="$HOME_DIR/sandbox-tmp"
SANDBOX_BROWSER="$HOME_DIR/browser-cache"
mkdir -p "$SANDBOX_TMP" "$SANDBOX_BROWSER"
SANDBOX_ARGS=(
  -D "WORKTREE=$(cd "$REPO" && pwd -P)"
  -D "GATE_HOME=$(cd "$HOME_DIR" && pwd -P)"
  -D "TEMP_ROOT=$(cd "$SANDBOX_TMP" && pwd -P)"
  -D "GIT_POINTER=$REPO/.git"
  -D "DEPS_ROOT=$(cd "$REPO/ui/node_modules" && pwd -P)"
  -D "LANE_DEPS=$REPO/ui/node_modules"
  -D "LANE_UI=$REPO/ui"
  -D "PLAYWRIGHT_CACHE=$(cd "$SANDBOX_BROWSER" && pwd -P)"
  -D "BREW_BIN=$(cd /opt/homebrew/bin && pwd -P)"
  -D "BREW_CELLAR=$(cd /opt/homebrew/Cellar && pwd -P)"
  -D "BREW_OPT=$(cd /opt/homebrew/opt && pwd -P)"
  -D "BREW_NODE_MODULES=$(cd /opt/homebrew/lib/node_modules && pwd -P)"
  -D "BREW_OPENSSL_CONFIG=$(cd /opt/homebrew/etc/openssl@3 && pwd -P)"
  -D "TOOLS_ROOT=$ROOT/scripts/first-stranger/codex-native/agent-bin"
)
if ( cd "$REPO" && /usr/bin/sandbox-exec "${SANDBOX_ARGS[@]}" -f "$GATE_PROFILE" \
    /bin/bash -c '/usr/bin/nc -l 5173 >/dev/null & server=$!; sleep 0.1; printf x | /usr/bin/nc -w 1 127.0.0.1 5173; wait "$server"' ); then
  ok "gate sandbox permits Playwright loopback traffic"
else
  not_ok "gate sandbox permits Playwright loopback traffic"
fi
if ( cd "$REPO" && /usr/bin/sandbox-exec "${SANDBOX_ARGS[@]}" -f "$GATE_PROFILE" \
    /bin/bash -c '! printf x | /usr/bin/nc -w 1 192.0.2.1 9' ); then
  ok "gate sandbox rejects non-loopback network"
else
  not_ok "gate sandbox rejects non-loopback network"
fi
GATE_SECRET_CANARY="$TMP/owner-secret-canary"
printf 'must-not-cross-gate-read-boundary\n' >"$GATE_SECRET_CANARY"
if ( cd "$REPO" && /usr/bin/sandbox-exec "${SANDBOX_ARGS[@]}" -f "$GATE_PROFILE" \
    /bin/bash -c 'secret="$(cat "$1")" || exit; printf "%s\n" "$secret" >"$2/ui/.env.local"' \
    gate-probe "$GATE_SECRET_CANARY" "$REPO" 2>/dev/null ); then
  not_ok "gate sandbox denies owner-secret reads"
else
  ok "gate sandbox denies owner-secret reads"
fi
assert_eq "denied gate read creates no ignored secret bridge" false "$([ -e "$REPO/ui/.env.local" ] && printf true || printf false)"
rm -f "$REPO/ui/node_modules/forged-by-gate"
if ( cd "$REPO" && /usr/bin/sandbox-exec "${SANDBOX_ARGS[@]}" -f "$GATE_PROFILE" \
    /usr/bin/touch "$REPO/ui/node_modules/forged-by-gate" 2>/dev/null ); then
  not_ok "gate sandbox denies dependency overlay writes"
else
  ok "gate sandbox denies dependency overlay writes"
fi
rm -f "$REPO/ui/node_modules/forged-by-gate"

MALFORMED_REPO="$TMP/"$'malformed\001runner'
git clone -q -b main "$REMOTE" "$MALFORMED_REPO"
mkdir -p "$MALFORMED_REPO/ui/node_modules"
shasum -a 256 "$MALFORMED_REPO/ui/package-lock.json" | awk '{print $1}' >"$MALFORMED_REPO/ui/node_modules/.mosh-deps-stamp"
if env CN_REPO="$MALFORMED_REPO" CN_CONTROL_REPO="$MALFORMED_REPO" \
    CN_TRUSTED_UI_DEPS="$MALFORMED_REPO/ui/node_modules" CN_HOME="$HOME_DIR" \
    CN_WORK_ROOT="$WORK_ROOT" CN_BASE_REF=origin/main CN_PR_BASE=main \
    CN_CODEX_BIN=/usr/bin/true CN_GH_BIN=/usr/bin/true CN_GH_REPO=fixture/repo \
    "$ENTRY" check >"$TMP/malformed-path-check.json"; then
  not_ok "control characters in agent-profile roots fail closed"
else
  ok "control characters in agent-profile roots fail closed"
fi
assert_eq "malformed profile root reports unhealthy" false \
  "$(jq -r '.checks.agent_toolchain_profile' "$TMP/malformed-path-check.json")"

CODEX_STUB="$TMP/codex"
cat >"$CODEX_STUB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
CN_STUB_STATE="${CN_STUB_STATE:-$(cd "$(dirname "$0")" && pwd)/stub-state}"
if [ -n "${CN_AGENT_ENV_CANARY:-}" ]; then
  touch "$CN_STUB_STATE/agent-env-leak"
  exit 98
fi
printf '%s\n' "$*" >>"$CN_STUB_STATE/codex.log"
schema=""; out=""; wt=""
args=("$@")
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  arg="${args[$i]}"
  case "$arg" in
    --output-schema) i=$((i + 1)); schema="${args[$i]}" ;;
    -o|--output-last-message) i=$((i + 1)); out="${args[$i]}" ;;
    -C|--cd) i=$((i + 1)); wt="${args[$i]}" ;;
  esac
  i=$((i + 1))
done
phase="$(basename "$schema" .json)"
if [ -n "$wt" ]; then printf '%s\n' "$wt" >"$CN_STUB_STATE/worktree"; else wt="$(cat "$CN_STUB_STATE/worktree")"; fi
lane="$(basename "$wt" | tr '[:lower:]' '[:upper:]')"
lane="${lane#CODEX/STRANGER-}"
case "$phase" in
  plan)
    plan_mode="$(cat "$CN_STUB_STATE/plan-mode" 2>/dev/null || printf proceed)"
    case "$plan_mode" in
      gap-closed) planned=true; gap=false ;;
      unplanned) planned=false; gap=true ;;
      *) planned=true; gap=true ;;
    esac
    jq -nc --arg id "$lane" --argjson planned "$planned" --argjson gap "$gap" \
      '{id:$id,planned:$planned,gap_exists:$gap,route:"safe",summary:"fixture plan"}' >"$out"
    ;;
  implement)
    printf '# generated by fixture\n' >"$wt/docs/generated.md"
    rm -rf "$wt/ui/node_modules"
    mkdir -p "$wt/ui/node_modules/.bin"
    printf '#!/usr/bin/env bash\nexit 0\n' >"$wt/ui/node_modules/.bin/forged-gate-tool"
    chmod +x "$wt/ui/node_modules/.bin/forged-gate-tool"
    printf 'forged-stamp\n' >"$wt/ui/node_modules/.mosh-deps-stamp"
    jq -nc --arg id "$lane" '{id:$id,ready_for_gate:true,summary:"implemented",tests_run:["fixture"],blockers:[]}' >"$out"
    ;;
  review)
    printf '%s\n' '{"verdict":"APPROVE","blockers":0,"reasons":[]}' >"$out"
    ;;
  *) exit 91 ;;
esac
printf '%s\n' '{"type":"thread.started","thread_id":"019f0000-0000-7000-8000-000000000001"}'
EOF
chmod +x "$CODEX_STUB"

GH_STUB="$TMP/gh"
cat >"$GH_STUB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$CN_STUB_STATE/gh.log"
if [ "${1:-}" = pr ] && [ "${2:-}" = create ]; then
  if [ -e "$CN_STUB_STATE/advance-after-create" ]; then
    branch=""
    args=("$@")
    for ((i = 0; i < ${#args[@]}; i++)); do
      if [ "${args[$i]}" = --head ]; then branch="${args[$((i + 1))]}"; fi
    done
    base="$(git --git-dir="$CN_TEST_REMOTE" rev-parse refs/heads/main)"
    git --git-dir="$CN_TEST_REMOTE" update-ref "refs/heads/$branch" "$base"
  fi
  printf 'https://example.invalid/draft/1\n'
fi
if [ "${1:-}" = label ] && [ "${2:-}" = list ] && [ -e "$CN_STUB_STATE/advance-base-on-label" ]; then
  head="$(git --git-dir="$CN_TEST_REMOTE" for-each-ref --format='%(objectname)' 'refs/heads/codex/stranger-*' | head -1)"
  git --git-dir="$CN_TEST_REMOTE" update-ref refs/heads/main "$head"
  rm -f "$CN_STUB_STATE/advance-base-on-label"
fi
if [ "${1:-}" = pr ] && [ "${2:-}" = list ] && [ -e "$CN_STUB_STATE/existing-pr-mismatch" ] \
    && [[ " $* " = *" --json url "* ]]; then
  printf 'https://example.invalid/draft/existing\n'
fi
if [ "${1:-}" = pr ] && [ "${2:-}" = view ]; then
  head_ref="$(git --git-dir="$CN_TEST_REMOTE" for-each-ref --format='%(refname:short)' 'refs/heads/codex/stranger-*' | head -1)"
  head="$(git --git-dir="$CN_TEST_REMOTE" rev-parse "refs/heads/$head_ref")"
  base="$(git --git-dir="$CN_TEST_REMOTE" rev-parse refs/heads/main)"
  is_draft=true
  if [ -e "$CN_STUB_STATE/existing-pr-mismatch" ]; then is_draft=false; fi
  jq -nc --arg head "$head" --arg base "$base" --arg head_ref "$head_ref" --argjson is_draft "$is_draft" \
    '{isDraft:$is_draft,state:"OPEN",baseRefName:"main",baseRefOid:$base,headRefName:$head_ref,headRefOid:$head,url:"https://example.invalid/draft/1"}'
fi
EOF
chmod +x "$GH_STUB"
export CN_HERMETIC_FIXTURE=1

OUTSIDE_FIXTURE="$(mktemp -d)"
mkdir -p "$OUTSIDE_FIXTURE/home"
touch "$OUTSIDE_FIXTURE/home/ARMED"
chmod 700 "$OUTSIDE_FIXTURE/home"
chmod 600 "$OUTSIDE_FIXTURE/home/ARMED"
rm -f "$STUB_STATE/codex.log" "$STUB_STATE/gh.log"
if env CN_REPO="$REPO" CN_HOME="$OUTSIDE_FIXTURE/home" CN_WORK_ROOT="$WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" CN_GH_BIN="$GH_STUB" \
    CN_CLASSIFY="$REPO/scripts/auto-loop/classify.sh" CN_GATE="$REPO/scripts/auto-loop/gate.sh" \
    CN_TEST_REMOTE="$REMOTE" CN_STUB_STATE="$STUB_STATE" CN_GH_REPO=fixture/repo \
    "$ENTRY" run --lane FS-Z1 >"$TMP/outside-fixture.out" 2>"$TMP/outside-fixture.err"; then
  not_ok "fixture mode rejects mutable roots outside its repository fixture"
else
  ok "fixture mode rejects mutable roots outside its repository fixture"
fi
assert_match "outside-fixture refusal names the secret boundary" 'agent secret boundary is unavailable' "$TMP/outside-fixture.err"
assert_eq "outside-fixture refusal creates no lock" false "$([ -e "$OUTSIDE_FIXTURE/home/run.lock" ] && printf true || printf false)"
assert_eq "outside-fixture refusal never reaches Codex" false "$([ -e "$STUB_STATE/codex.log" ] && printf true || printf false)"
assert_eq "outside-fixture refusal never reaches GitHub" false "$([ -e "$STUB_STATE/gh.log" ] && printf true || printf false)"

CONTROL_REPO="$TMP/control-repo"
STOP_RUNNER="$TMP/stopped-runner"
STOP_HOME="$TMP/stopped-automation"
STOP_WORK_ROOT="$TMP/stopped-worktrees"
STOP_STUB_STATE="$TMP/stopped-stub-state"
git clone -q -b main "$REMOTE" "$CONTROL_REPO"
git -C "$CONTROL_REPO" worktree add -q -b stopped-runner "$STOP_RUNNER" main
printf '[core]\n\tworktree = %s\n' "$CONTROL_REPO" >"$CONTROL_REPO/.git/config.worktree"
CONTROL_REAL="$(cd "$CONTROL_REPO" && pwd -P)"
mkdir -p "$STOP_RUNNER/ui/node_modules"
shasum -a 256 "$STOP_RUNNER/ui/package-lock.json" | awk '{print $1}' >"$STOP_RUNNER/ui/node_modules/.mosh-deps-stamp"
export CN_TRUSTED_UI_DEPS="$STOP_RUNNER/ui/node_modules"
mkdir -p "$CONTROL_REPO/docs/auto-loop" "$STOP_HOME" "$STOP_STUB_STATE"
touch "$CONTROL_REPO/docs/auto-loop/STOP" "$STOP_HOME/ARMED"
chmod 700 "$STOP_HOME"
chmod 600 "$STOP_HOME/ARMED"

mv "$CONTROL_REPO/.git/config.worktree" "$CONTROL_REPO/.git/config.worktree.saved"
if env CN_REPO="$STOP_RUNNER" CN_HOME="$STOP_HOME" CN_WORK_ROOT="$STOP_WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$STOP_RUNNER/scripts/auto-loop/classify.sh" \
    CN_GATE="$STOP_RUNNER/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STOP_STUB_STATE" \
    "$ENTRY" check >"$TMP/missing-control.out" 2>"$TMP/missing-control.err"; then
  not_ok "linked runner without canonical config fails closed"
else
  ok "linked runner without canonical config fails closed"
fi
assert_match "missing canonical config is explicit" 'could not resolve canonical control checkout' "$TMP/missing-control.err"
assert_eq "missing canonical config creates no work root" false "$([ -e "$STOP_WORK_ROOT" ] && printf true || printf false)"
assert_eq "missing canonical config creates no state" false "$([ -e "$STOP_HOME/state" ] && printf true || printf false)"
mv "$CONTROL_REPO/.git/config.worktree.saved" "$CONTROL_REPO/.git/config.worktree"

ESCAPED_DEPS="$TMP/escaped-runner-deps"
mkdir -p "$ESCAPED_DEPS"
cp "$STOP_RUNNER/ui/node_modules/.mosh-deps-stamp" "$ESCAPED_DEPS/.mosh-deps-stamp"
rm -rf "$STOP_RUNNER/ui/node_modules"
ln -s "$ESCAPED_DEPS" "$STOP_RUNNER/ui/node_modules"
if env CN_REPO="$STOP_RUNNER" CN_HOME="$STOP_HOME" CN_WORK_ROOT="$STOP_WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$STOP_RUNNER/scripts/auto-loop/classify.sh" \
    CN_GATE="$STOP_RUNNER/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STOP_STUB_STATE" \
    "$ENTRY" check >"$TMP/escaped-deps.out"; then
  not_ok "runner dependency-root symlink substitution fails closed"
else
  ok "runner dependency-root symlink substitution fails closed"
fi
assert_eq "dependency-root symlink reports an unhealthy agent profile" false \
  "$(jq -r '.checks.agent_toolchain_profile' "$TMP/escaped-deps.out")"
rm "$STOP_RUNNER/ui/node_modules"
mkdir -p "$STOP_RUNNER/ui/node_modules"
cp "$ESCAPED_DEPS/.mosh-deps-stamp" "$STOP_RUNNER/ui/node_modules/.mosh-deps-stamp"

ESCAPED_UI="$TMP/escaped-runner-ui"
SAVED_UI="$TMP/stopped-runner-ui"
mkdir -p "$ESCAPED_UI/node_modules"
cp "$STOP_RUNNER/ui/package-lock.json" "$ESCAPED_UI/package-lock.json"
cp "$STOP_RUNNER/ui/node_modules/.mosh-deps-stamp" "$ESCAPED_UI/node_modules/.mosh-deps-stamp"
mv "$STOP_RUNNER/ui" "$SAVED_UI"
ln -s "$ESCAPED_UI" "$STOP_RUNNER/ui"
if env CN_REPO="$STOP_RUNNER" CN_HOME="$STOP_HOME" CN_WORK_ROOT="$STOP_WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$STOP_RUNNER/scripts/auto-loop/classify.sh" \
    CN_GATE="$STOP_RUNNER/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STOP_STUB_STATE" \
    "$ENTRY" check >"$TMP/escaped-ui.out"; then
  not_ok "runner UI ancestor symlink substitution fails closed"
else
  ok "runner UI ancestor symlink substitution fails closed"
fi
assert_eq "UI ancestor symlink reports an unhealthy agent profile" false \
  "$(jq -r '.checks.agent_toolchain_profile' "$TMP/escaped-ui.out")"
rm "$STOP_RUNNER/ui"
mv "$SAVED_UI" "$STOP_RUNNER/ui"

stopped_check="$(env CN_REPO="$STOP_RUNNER" CN_HOME="$STOP_HOME" CN_WORK_ROOT="$STOP_WORK_ROOT" \
  CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
  CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$STOP_RUNNER/scripts/auto-loop/classify.sh" \
  CN_GATE="$STOP_RUNNER/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STOP_STUB_STATE" \
  "$ENTRY" check || true)"
assert_eq "check discovers canonical control checkout" "$CONTROL_REAL" "$(jq -r .control_repo <<<"$stopped_check")"
assert_eq "check exposes canonical-control STOP" true "$(jq -r .stop_sources.control_shared <<<"$stopped_check")"
assert_eq "check reports execution stopped" true "$(jq -r .stopped <<<"$stopped_check")"

stopped_status="$(env CN_REPO="$STOP_RUNNER" CN_HOME="$STOP_HOME" CN_WORK_ROOT="$STOP_WORK_ROOT" \
  CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
  CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$STOP_RUNNER/scripts/auto-loop/classify.sh" \
  CN_GATE="$STOP_RUNNER/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STOP_STUB_STATE" \
  "$ENTRY" status)"
assert_eq "status exposes canonical-control STOP" true "$(jq -r .stop_sources.control_shared <<<"$stopped_status")"
assert_eq "status reports execution stopped" true "$(jq -r .stopped <<<"$stopped_status")"

stop_before_worktrees="$(git -C "$STOP_RUNNER" worktree list --porcelain)"
stop_before_branches="$(git -C "$STOP_RUNNER" branch --format='%(refname)')"
stop_before_remote="$(git -C "$STOP_RUNNER" ls-remote --refs origin)"
if env CN_REPO="$STOP_RUNNER" CN_HOME="$STOP_HOME" CN_WORK_ROOT="$STOP_WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$STOP_RUNNER/scripts/auto-loop/classify.sh" \
    CN_GATE="$STOP_RUNNER/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STOP_STUB_STATE" \
    "$ENTRY" run --lane FS-Z1 >"$TMP/stopped-run.out" 2>"$TMP/stopped-run.err"; then
  not_ok "canonical-control STOP blocks run"
else
  ok "canonical-control STOP blocks run"
fi
assert_match "stopped run names STOP refusal" 'STOP is present' "$TMP/stopped-run.err"
assert_eq "stopped run creates no worktree" "$stop_before_worktrees" "$(git -C "$STOP_RUNNER" worktree list --porcelain)"
assert_eq "stopped run creates no branch" "$stop_before_branches" "$(git -C "$STOP_RUNNER" branch --format='%(refname)')"
assert_eq "stopped run creates no remote ref" "$stop_before_remote" "$(git -C "$STOP_RUNNER" ls-remote --refs origin)"
assert_eq "stopped run creates no work root" false "$([ -e "$STOP_WORK_ROOT" ] && printf true || printf false)"
assert_eq "stopped run creates no state directory" false "$([ -e "$STOP_HOME/state" ] && printf true || printf false)"
assert_eq "stopped run never reaches Codex" false "$([ -e "$STOP_STUB_STATE/codex.log" ] && printf true || printf false)"
assert_eq "stopped run never reaches GitHub" false "$([ -e "$STOP_STUB_STATE/gh.log" ] && printf true || printf false)"

rm "$CONTROL_REPO/docs/auto-loop/STOP"
mkdir -p "$CONTROL_REPO/docs/first-stranger-program"
touch "$CONTROL_REPO/docs/first-stranger-program/STOP"
program_status="$(env CN_REPO="$STOP_RUNNER" CN_HOME="$STOP_HOME" CN_WORK_ROOT="$STOP_WORK_ROOT" \
  CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
  CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$STOP_RUNNER/scripts/auto-loop/classify.sh" \
  CN_GATE="$STOP_RUNNER/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STOP_STUB_STATE" \
  "$ENTRY" status)"
assert_eq "status exposes canonical program STOP" true "$(jq -r .stop_sources.control_program <<<"$program_status")"
if env CN_REPO="$STOP_RUNNER" CN_HOME="$STOP_HOME" CN_WORK_ROOT="$STOP_WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$STOP_RUNNER/scripts/auto-loop/classify.sh" \
    CN_GATE="$STOP_RUNNER/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STOP_STUB_STATE" \
    "$ENTRY" run --lane FS-Z1 >"$TMP/program-stop.out" 2>"$TMP/program-stop.err"; then
  not_ok "canonical program STOP blocks run"
else
  ok "canonical program STOP blocks run"
fi
assert_eq "program-stopped run creates no work root" false "$([ -e "$STOP_WORK_ROOT" ] && printf true || printf false)"
assert_eq "program-stopped run never reaches Codex" false "$([ -e "$STOP_STUB_STATE/codex.log" ] && printf true || printf false)"
assert_eq "program-stopped run never reaches GitHub" false "$([ -e "$STOP_STUB_STATE/gh.log" ] && printf true || printf false)"
rm "$CONTROL_REPO/docs/first-stranger-program/STOP"

LOCAL_HOME="$CONTROL_REPO/.cn-home"
LOCAL_WORK_ROOT="$TMP/local-home-work"
mkdir -p "$LOCAL_HOME"
touch "$LOCAL_HOME/ARMED"
chmod 700 "$LOCAL_HOME"
chmod 600 "$LOCAL_HOME/ARMED"
local_before="$(git -C "$CONTROL_REPO" status --porcelain=v1 --untracked-files=all)"
if env CN_REPO="$STOP_RUNNER" CN_HOME="$LOCAL_HOME" CN_WORK_ROOT="$LOCAL_WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$STOP_RUNNER/scripts/auto-loop/classify.sh" \
    CN_GATE="$STOP_RUNNER/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STOP_STUB_STATE" \
    "$ENTRY" run --lane FS-NOPE >"$TMP/local-home.out" 2>"$TMP/local-home.err"; then
  not_ok "control-local automation home is refused"
else
  ok "control-local automation home is refused"
fi
assert_match "control-local refusal names external-home rule" 'CN_HOME must resolve outside.*control' "$TMP/local-home.err"
assert_eq "control-local refusal leaves checkout unchanged" "$local_before" "$(git -C "$CONTROL_REPO" status --porcelain=v1 --untracked-files=all)"
assert_eq "control-local refusal creates no state" false "$([ -e "$LOCAL_HOME/state" ] && printf true || printf false)"
assert_eq "control-local refusal creates no logs" false "$([ -e "$LOCAL_HOME/logs" ] && printf true || printf false)"
assert_eq "control-local refusal creates no work root" false "$([ -e "$LOCAL_WORK_ROOT" ] && printf true || printf false)"
assert_eq "control-local refusal never reaches Codex" false "$([ -e "$STOP_STUB_STATE/codex.log" ] && printf true || printf false)"
assert_eq "control-local refusal never reaches GitHub" false "$([ -e "$STOP_STUB_STATE/gh.log" ] && printf true || printf false)"

JQ_HOME="$TMP/jq-home"
JQ_WORK_ROOT="$TMP/jq-work"
JQ_BIN="$TMP/jq-bin"
mkdir -p "$JQ_HOME" "$JQ_BIN"
touch "$JQ_HOME/ARMED" "$JQ_HOME/STOP"
chmod 755 "$JQ_HOME"
chmod 600 "$JQ_HOME/ARMED"
printf '#!/usr/bin/env bash\nexit 127\n' >"$JQ_BIN/jq"
chmod +x "$JQ_BIN/jq"
if env PATH="$JQ_BIN:$PATH" CN_REPO="$STOP_RUNNER" CN_HOME="$JQ_HOME" CN_WORK_ROOT="$JQ_WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$STOP_RUNNER/scripts/auto-loop/classify.sh" \
    CN_GATE="$STOP_RUNNER/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STOP_STUB_STATE" \
    "$ENTRY" run --lane FS-Z1 >"$TMP/jq-stop.out" 2>"$TMP/jq-stop.err"; then
  not_ok "STOP evaluation error fails closed"
else
  ok "STOP evaluation error fails closed"
fi
assert_match "STOP evaluation error is explicit" 'could not evaluate STOP sources' "$TMP/jq-stop.err"
assert_eq "STOP evaluation error preserves home mode" 755 "$(stat -f '%Lp' "$JQ_HOME")"
assert_eq "STOP evaluation error creates no state" false "$([ -e "$JQ_HOME/state" ] && printf true || printf false)"
assert_eq "STOP evaluation error creates no work root" false "$([ -e "$JQ_WORK_ROOT" ] && printf true || printf false)"
assert_eq "STOP evaluation error never reaches Codex" false "$([ -e "$STOP_STUB_STATE/codex.log" ] && printf true || printf false)"
assert_eq "STOP evaluation error never reaches GitHub" false "$([ -e "$STOP_STUB_STATE/gh.log" ] && printf true || printf false)"

UNREADABLE_HOME="$TMP/unreadable-home"
UNREADABLE_WORK_ROOT="$TMP/unreadable-work"
UNREADABLE_LANE="$UNREADABLE_WORK_ROOT/existing-lane"
mkdir -p "$UNREADABLE_HOME" "$UNREADABLE_LANE/docs/auto-loop"
touch "$UNREADABLE_HOME/ARMED" "$UNREADABLE_LANE/docs/auto-loop/STOP"
chmod 700 "$UNREADABLE_HOME"
chmod 600 "$UNREADABLE_HOME/ARMED"
chmod 000 "$UNREADABLE_LANE"
if env CN_REPO="$STOP_RUNNER" CN_HOME="$UNREADABLE_HOME" CN_WORK_ROOT="$UNREADABLE_WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$STOP_RUNNER/scripts/auto-loop/classify.sh" \
    CN_GATE="$STOP_RUNNER/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STOP_STUB_STATE" \
    "$ENTRY" run --lane FS-NOPE >"$TMP/unreadable-stop.out" 2>"$TMP/unreadable-stop.err"; then
  not_ok "unreadable lane STOP source fails closed"
else
  ok "unreadable lane STOP source fails closed"
fi
chmod 700 "$UNREADABLE_LANE"
assert_match "unreadable lane refusal is explicit" 'could not evaluate STOP sources' "$TMP/unreadable-stop.err"
assert_eq "unreadable lane refusal creates no state" false "$([ -e "$UNREADABLE_HOME/state" ] && printf true || printf false)"
assert_eq "unreadable lane refusal creates no logs" false "$([ -e "$UNREADABLE_HOME/logs" ] && printf true || printf false)"
assert_eq "unreadable lane refusal never reaches Codex" false "$([ -e "$STOP_STUB_STATE/codex.log" ] && printf true || printf false)"
assert_eq "unreadable lane refusal never reaches GitHub" false "$([ -e "$STOP_STUB_STATE/gh.log" ] && printf true || printf false)"

UNLISTABLE_HOME="$TMP/unlistable-home"
UNLISTABLE_WORK_ROOT="$TMP/unlistable-work"
mkdir -p "$UNLISTABLE_HOME" "$UNLISTABLE_WORK_ROOT/existing-lane/docs/auto-loop"
touch "$UNLISTABLE_HOME/ARMED" "$UNLISTABLE_WORK_ROOT/existing-lane/docs/auto-loop/STOP"
chmod 700 "$UNLISTABLE_HOME"
chmod 600 "$UNLISTABLE_HOME/ARMED"
chmod 111 "$UNLISTABLE_WORK_ROOT"
if env CN_REPO="$STOP_RUNNER" CN_HOME="$UNLISTABLE_HOME" CN_WORK_ROOT="$UNLISTABLE_WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$STOP_RUNNER/scripts/auto-loop/classify.sh" \
    CN_GATE="$STOP_RUNNER/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STOP_STUB_STATE" \
    "$ENTRY" run --lane FS-NOPE >"$TMP/unlistable-stop.out" 2>"$TMP/unlistable-stop.err"; then
  not_ok "unlistable work root fails closed"
else
  ok "unlistable work root fails closed"
fi
chmod 700 "$UNLISTABLE_WORK_ROOT"
assert_match "unlistable work root refusal is explicit" 'could not evaluate STOP sources' "$TMP/unlistable-stop.err"
assert_eq "unlistable work root creates no state" false "$([ -e "$UNLISTABLE_HOME/state" ] && printf true || printf false)"
assert_eq "unlistable work root creates no logs" false "$([ -e "$UNLISTABLE_HOME/logs" ] && printf true || printf false)"
assert_eq "unlistable work root never reaches Codex" false "$([ -e "$STOP_STUB_STATE/codex.log" ] && printf true || printf false)"
assert_eq "unlistable work root never reaches GitHub" false "$([ -e "$STOP_STUB_STATE/gh.log" ] && printf true || printf false)"

HIDDEN_HOME="$TMP/hidden-home"
HIDDEN_WORK_ROOT="$TMP/hidden-work"
HIDDEN_STOP_DIR="$HIDDEN_WORK_ROOT/existing-lane/docs/auto-loop"
mkdir -p "$HIDDEN_HOME" "$HIDDEN_STOP_DIR"
touch "$HIDDEN_HOME/ARMED" "$HIDDEN_STOP_DIR/STOP"
chmod 700 "$HIDDEN_HOME"
chmod 600 "$HIDDEN_HOME/ARMED"
chmod 000 "$HIDDEN_STOP_DIR"
if env CN_REPO="$STOP_RUNNER" CN_HOME="$HIDDEN_HOME" CN_WORK_ROOT="$HIDDEN_WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$STOP_RUNNER/scripts/auto-loop/classify.sh" \
    CN_GATE="$STOP_RUNNER/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STOP_STUB_STATE" \
    "$ENTRY" run --lane FS-NOPE >"$TMP/hidden-stop.out" 2>"$TMP/hidden-stop.err"; then
  not_ok "unreadable sentinel parent fails closed"
else
  ok "unreadable sentinel parent fails closed"
fi
chmod 700 "$HIDDEN_STOP_DIR"
assert_match "unreadable sentinel refusal is explicit" 'could not evaluate STOP sources' "$TMP/hidden-stop.err"
assert_eq "unreadable sentinel refusal creates no state" false "$([ -e "$HIDDEN_HOME/state" ] && printf true || printf false)"
assert_eq "unreadable sentinel refusal creates no logs" false "$([ -e "$HIDDEN_HOME/logs" ] && printf true || printf false)"
assert_eq "unreadable sentinel refusal never reaches Codex" false "$([ -e "$STOP_STUB_STATE/codex.log" ] && printf true || printf false)"
assert_eq "unreadable sentinel refusal never reaches GitHub" false "$([ -e "$STOP_STUB_STATE/gh.log" ] && printf true || printf false)"

export CN_TRUSTED_UI_DEPS="$REPO/ui/node_modules"
NEG_HOME="$TMP/negative-plan-home"
NEG_WORK_ROOT="$TMP/negative-plan-worktrees"
mkdir -p "$NEG_HOME"
touch "$NEG_HOME/ARMED"
chmod 700 "$NEG_HOME"
chmod 600 "$NEG_HOME/ARMED"
printf 'gap-closed\n' >"$STUB_STATE/plan-mode"
rm -f "$STUB_STATE/codex.log" "$STUB_STATE/gh.log"
if env CN_REPO="$REPO" CN_HOME="$NEG_HOME" CN_WORK_ROOT="$NEG_WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$REPO/scripts/auto-loop/classify.sh" \
    CN_GATE="$REPO/scripts/auto-loop/gate.sh" CN_TEST_REMOTE="$REMOTE" CN_STUB_STATE="$STUB_STATE" \
    CN_GH_REPO=fixture/repo \
    "$ENTRY" run --lane FS-Z2 >"$TMP/gap-closed.out" 2>"$TMP/gap-closed.err"; then
  not_ok "closed gap stops before implementation"
else
  ok "closed gap stops before implementation"
fi
assert_eq "closed gap becomes needs-human" needs-human "$(jq -r .phase "$NEG_HOME/state/fs-z2.json")"
assert_eq "closed gap creates no implementation diff" false \
  "$([ -e "$NEG_WORK_ROOT/fs-z2/docs/generated.md" ] && printf true || printf false)"
assert_no_match "closed gap never resumes into implementation" 'exec resume' "$STUB_STATE/codex.log"
assert_no_match "closed gap never opens a PR" 'pr create' "$STUB_STATE/gh.log"

printf 'unplanned\n' >"$STUB_STATE/plan-mode"
rm -f "$STUB_STATE/codex.log" "$STUB_STATE/gh.log"
if env CN_REPO="$REPO" CN_HOME="$NEG_HOME" CN_WORK_ROOT="$NEG_WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$REPO/scripts/auto-loop/classify.sh" \
    CN_GATE="$REPO/scripts/auto-loop/gate.sh" CN_TEST_REMOTE="$REMOTE" CN_STUB_STATE="$STUB_STATE" \
    CN_GH_REPO=fixture/repo \
    "$ENTRY" run --lane FS-Z3 >"$TMP/unplanned.out" 2>"$TMP/unplanned.err"; then
  not_ok "planned false stops before implementation"
else
  ok "planned false stops before implementation"
fi
assert_eq "planned false becomes needs-human" needs-human "$(jq -r .phase "$NEG_HOME/state/fs-z3.json")"
assert_eq "planned false creates no implementation diff" false \
  "$([ -e "$NEG_WORK_ROOT/fs-z3/docs/generated.md" ] && printf true || printf false)"
assert_no_match "planned false never resumes into implementation" 'exec resume' "$STUB_STATE/codex.log"
assert_no_match "planned false never opens a PR" 'pr create' "$STUB_STATE/gh.log"

RACE_HOME="$TMP/race-home"
RACE_WORK_ROOT="$TMP/race-worktrees"
mkdir -p "$RACE_HOME"
touch "$RACE_HOME/ARMED" "$STUB_STATE/advance-after-create"
chmod 700 "$RACE_HOME"
chmod 600 "$RACE_HOME/ARMED"
rm -f "$STUB_STATE/plan-mode" "$STUB_STATE/codex.log" "$STUB_STATE/gh.log"
race_before="$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)"
if env CN_REPO="$REPO" CN_HOME="$RACE_HOME" CN_WORK_ROOT="$RACE_WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$REPO/scripts/auto-loop/classify.sh" \
    CN_GATE="$REPO/scripts/auto-loop/gate.sh" CN_TEST_REMOTE="$REMOTE" CN_STUB_STATE="$STUB_STATE" \
    CN_GH_REPO=fixture/repo CN_ENABLE_EXPERIMENTAL_SEATBELT_GATE=1 \
    "$ENTRY" run --lane FS-Z4 >"$TMP/race.out" 2>"$TMP/race.err"; then
  not_ok "publication head race fails closed"
else
  ok "publication head race fails closed"
fi
assert_eq "publication race becomes needs-human" needs-human "$(jq -r .phase "$RACE_HOME/state/fs-z4.json")"
assert_match "publication race created only a draft" 'pr create --draft' "$STUB_STATE/gh.log"
assert_match "mismatched draft is closed" 'pr close https://example.invalid/draft/1' "$STUB_STATE/gh.log"
assert_eq "publication race preserves the primary checkout" "$race_before" \
  "$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)"
git -C "$REPO" push -q origin :refs/heads/codex/stranger-fs-z4
rm -f "$STUB_STATE/advance-after-create" "$STUB_STATE/codex.log" "$STUB_STATE/gh.log"

FIXTURE_BASE="$(git -C "$REPO" rev-parse origin/main)"
BASE_RACE_HOME="$TMP/base-race-home"
BASE_RACE_WORK_ROOT="$TMP/base-race-worktrees"
mkdir -p "$BASE_RACE_HOME"
touch "$BASE_RACE_HOME/ARMED" "$STUB_STATE/advance-base-on-label"
chmod 700 "$BASE_RACE_HOME"
chmod 600 "$BASE_RACE_HOME/ARMED"
if env CN_REPO="$REPO" CN_HOME="$BASE_RACE_HOME" CN_WORK_ROOT="$BASE_RACE_WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$REPO/scripts/auto-loop/classify.sh" \
    CN_GATE="$REPO/scripts/auto-loop/gate.sh" CN_TEST_REMOTE="$REMOTE" CN_STUB_STATE="$STUB_STATE" \
    CN_GH_REPO=fixture/repo CN_ENABLE_EXPERIMENTAL_SEATBELT_GATE=1 \
    "$ENTRY" run --lane FS-Z5 >"$TMP/base-race.out" 2>"$TMP/base-race.err"; then
  not_ok "remote base advancement stops publication"
else
  ok "remote base advancement stops publication"
fi
assert_eq "base advancement becomes needs-human" needs-human "$(jq -r .phase "$BASE_RACE_HOME/state/fs-z5.json")"
assert_no_match "base advancement never opens a PR" 'pr create' "$STUB_STATE/gh.log"
assert_match "base advancement refusal is explicit" 'remote PR base advanced' "$TMP/base-race.err"
git --git-dir="$REMOTE" update-ref refs/heads/main "$FIXTURE_BASE"
git -C "$REPO" push -q origin :refs/heads/codex/stranger-fs-z5
rm -f "$STUB_STATE/codex.log" "$STUB_STATE/gh.log"

EXISTING_HOME="$TMP/existing-pr-home"
EXISTING_WORK_ROOT="$TMP/existing-pr-worktrees"
mkdir -p "$EXISTING_HOME"
touch "$EXISTING_HOME/ARMED" "$STUB_STATE/existing-pr-mismatch"
chmod 700 "$EXISTING_HOME"
chmod 600 "$EXISTING_HOME/ARMED"
if env CN_REPO="$REPO" CN_HOME="$EXISTING_HOME" CN_WORK_ROOT="$EXISTING_WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$REPO/scripts/auto-loop/classify.sh" \
    CN_GATE="$REPO/scripts/auto-loop/gate.sh" CN_TEST_REMOTE="$REMOTE" CN_STUB_STATE="$STUB_STATE" \
    CN_GH_REPO=fixture/repo CN_ENABLE_EXPERIMENTAL_SEATBELT_GATE=1 \
    "$ENTRY" run --lane FS-Z6 >"$TMP/existing-pr.out" 2>"$TMP/existing-pr.err"; then
  not_ok "mismatched existing draft stops publication"
else
  ok "mismatched existing draft stops publication"
fi
assert_eq "existing draft mismatch becomes needs-human" needs-human "$(jq -r .phase "$EXISTING_HOME/state/fs-z6.json")"
assert_no_match "existing draft mismatch never creates another PR" 'pr create' "$STUB_STATE/gh.log"
assert_match "existing draft mismatch refusal is explicit" 'existing draft PR does not match' "$TMP/existing-pr.err"
rm -f "$STUB_STATE/existing-pr-mismatch"
git -C "$REPO" push -q origin :refs/heads/codex/stranger-fs-z6
rm -f "$STUB_STATE/codex.log" "$STUB_STATE/gh.log"

touch "$HOME_DIR/ARMED"
chmod 600 "$HOME_DIR/ARMED"
before="$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)"
env CN_REPO="$REPO" CN_HOME="$HOME_DIR" CN_WORK_ROOT="$WORK_ROOT" \
  CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
  CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$REPO/scripts/auto-loop/classify.sh" \
  CN_GATE="$REPO/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STUB_STATE" CN_TEST_REMOTE="$REMOTE" \
  CN_GH_REPO=fixture/repo \
  CN_AGENT_ENV_CANARY=must-not-reach-agent \
  GH_TOKEN=fixture-secret OPENAI_API_KEY=fixture-secret \
  "$ENTRY" run --lane FS-Z1 >"$TMP/run.out"
after="$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)"

STATE="$HOME_DIR/state/fs-z1.json"
assert_eq "fixture reaches draft-PR phase" pr-opened "$(jq -r .phase "$STATE")"
assert_eq "fixture preserves the primary checkout" "$before" "$after"
assert_eq "agent-created ignored gate tools are purged before verification" false "$([ -e "$WORK_ROOT/fs-z1/ui/node_modules/.bin/forged-gate-tool" ] && printf true || printf false)"
assert_eq "gate-created ignored state is purged before review" false "$([ -e "$WORK_ROOT/fs-z1/ui/node_modules" ] && printf true || printf false)"
assert_eq "gate cannot write outside lane worktree" false "$([ -e "$GATE_ESCAPE_MARKER" ] && printf true || printf false)"
assert_match "implementation resumed the planning thread" 'exec resume .*019f0000' "$STUB_STATE/codex.log"
assert_match "agent sessions ignore user config" '--ignore-user-config' "$STUB_STATE/codex.log"
assert_match "agent sessions use restricted permission profiles" 'default_permissions="cn_lane"' "$STUB_STATE/codex.log"
assert_match "agent permission profile denies network" 'permissions\.cn_lane\.network\.enabled=false' "$STUB_STATE/codex.log"
assert_match "agent permission profile can traverse the trusted dependency target" "$(cd "$REPO/ui/node_modules" && pwd -P)" "$STUB_STATE/codex.log"
assert_match "agent permission profile can execute pinned command guards" "$ROOT/scripts/first-stranger/codex-native/agent-bin" "$STUB_STATE/codex.log"
assert_match "agent permission profile can read only the pinned Playwright cache root" "/Users/$(/usr/bin/id -un)/Library/Caches/ms-playwright" "$STUB_STATE/codex.log"
assert_match "agent permission profile can read the Homebrew binary root" "$(cd /opt/homebrew/bin && pwd -P)" "$STUB_STATE/codex.log"
assert_match "agent permission profile can read Homebrew Cellar dylibs" "$(cd /opt/homebrew/Cellar && pwd -P)" "$STUB_STATE/codex.log"
assert_match "agent permission profile can read Homebrew opt links" "$(cd /opt/homebrew/opt && pwd -P)" "$STUB_STATE/codex.log"
assert_match "agent permission profile can read global Node modules" "$(cd /opt/homebrew/lib/node_modules && pwd -P)" "$STUB_STATE/codex.log"
assert_match "agent permission profile can read OpenSSL configuration" "$(cd /opt/homebrew/etc/openssl@3 && pwd -P)" "$STUB_STATE/codex.log"
common_dir="$(git -C "$WORK_ROOT/fs-z1" rev-parse --path-format=absolute --git-common-dir)"
assert_match "agent permission profile keeps shared Git metadata read-only" "\"$common_dir\"=\"read\"" "$STUB_STATE/codex.log"
assert_match "agent shell environment inheritance is pinned" 'shell_environment_policy\.inherit="core"' "$STUB_STATE/codex.log"
assert_eq "agent process receives no supervisor secret environment" false "$([ -e "$STUB_STATE/agent-env-leak" ] && printf true || printf false)"
assert_no_match "agent sessions do not use legacy full-read sandbox modes" 'sandbox_mode=| -s (read-only|workspace-write)' "$STUB_STATE/codex.log"
assert_match "hostile review worktree is read-only" 'permissions\.cn_lane\.filesystem=.*="read"' "$STUB_STATE/codex.log"
assert_match "supervisor opens a draft PR" 'pr create --draft' "$STUB_STATE/gh.log"
if rg -v -- '--repo ' "$STUB_STATE/gh.log" >/dev/null; then
  not_ok "every GitHub call is pinned to the repository"
else
  ok "every GitHub call is pinned to the repository"
fi
assert_match "supervisor verifies draft PR metadata" 'pr view .*headRefOid' "$STUB_STATE/gh.log"
assert_match "supervisor verifies the draft PR base object" 'pr view .*baseRefOid' "$STUB_STATE/gh.log"
assert_no_match "no GitHub merge command is reachable" '(^| )merge( |$)' "$STUB_STATE/gh.log"
assert_no_match "PR body omits raw hostile-review reasons" 'reasons' "$HOME_DIR/logs/fs-z1/pr-body.md"
local_head="$(jq -r .head_sha "$STATE")"
remote_head="$(git -C "$REPO" ls-remote origin refs/heads/codex/stranger-fs-z1 | awk '{print $1}')"
assert_eq "remote head equals exact gated head" "$local_head" "$remote_head"
assert_eq "state remains private" 600 "$(stat -f '%Lp' "$STATE")"

git -C "$REPO" push -q origin :refs/heads/codex/stranger-fs-z1
NEVER_PATH="$WORK_ROOT/fs-z1/docs/first-stranger-program/README.md"
printf '# policy drift fixture\n' >"$NEVER_PATH"
git -C "$WORK_ROOT/fs-z1" add docs/first-stranger-program/README.md
git -C "$WORK_ROOT/fs-z1" commit -qm "fixture: now-never reviewed path"
never_head="$(git -C "$WORK_ROOT/fs-z1" rev-parse HEAD)"
jq --arg head "$never_head" '.head_sha = $head | .phase = "reviewed"' "$STATE" >"$STATE.tmp"
mv "$STATE.tmp" "$STATE"
chmod 600 "$STATE"
rm -f "$STUB_STATE/gh.log"
if env CN_REPO="$REPO" CN_HOME="$HOME_DIR" CN_WORK_ROOT="$WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$REPO/scripts/auto-loop/classify.sh" \
    CN_GATE="$REPO/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STUB_STATE" CN_TEST_REMOTE="$REMOTE" \
    CN_GH_REPO=fixture/repo "$ENTRY" resume FS-Z1 >"$TMP/never-resume.out" 2>"$TMP/never-resume.err"; then
  not_ok "reviewed resume rejects a newly never route"
else
  ok "reviewed resume rejects a newly never route"
fi
assert_eq "never-route resume never pushes a lane ref" "" "$(git -C "$REPO" ls-remote origin refs/heads/codex/stranger-fs-z1 | awk '{print $1}')"
assert_eq "never-route resume never reaches GitHub" false "$([ -e "$STUB_STATE/gh.log" ] && printf true || printf false)"

git -C "$WORK_ROOT/fs-z1" rm -q docs/first-stranger-program/README.md
git -C "$WORK_ROOT/fs-z1" commit -qm "fixture: restore safe reviewed path"
safe_reviewed_head="$(git -C "$WORK_ROOT/fs-z1" rev-parse HEAD)"
jq --arg head "$safe_reviewed_head" '.head_sha = $head | .phase = "reviewed"' "$STATE" >"$STATE.tmp"
mv "$STATE.tmp" "$STATE"
chmod 600 "$STATE"
rm -f "$STUB_STATE/gh.log"
if env -u CN_ENABLE_EXPERIMENTAL_SEATBELT_GATE CN_REPO="$REPO" CN_HOME="$HOME_DIR" CN_WORK_ROOT="$WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$REPO/scripts/auto-loop/classify.sh" \
    CN_GATE="$REPO/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STUB_STATE" CN_TEST_REMOTE="$REMOTE" \
    CN_GH_REPO=fixture/repo "$ENTRY" resume FS-Z1 >"$TMP/disabled-resume.out" 2>"$TMP/disabled-resume.err"; then
  not_ok "reviewed resume rechecks production gate enablement"
else
  ok "reviewed resume rechecks production gate enablement"
fi
assert_eq "disabled gate resume never pushes a lane ref" "" "$(git -C "$REPO" ls-remote origin refs/heads/codex/stranger-fs-z1 | awk '{print $1}')"
assert_eq "disabled gate resume never reaches GitHub" false "$([ -e "$STUB_STATE/gh.log" ] && printf true || printf false)"

rm -f "$HOME_DIR/logs/fs-z1/gate.json" "$HOME_DIR/logs/fs-z1/review.result.json" "$STUB_STATE/gh.log"
if env CN_REPO="$REPO" CN_HOME="$HOME_DIR" CN_WORK_ROOT="$WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$REPO/scripts/auto-loop/classify.sh" \
    CN_GATE="$REPO/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STUB_STATE" CN_TEST_REMOTE="$REMOTE" \
    CN_GH_REPO=fixture/repo "$ENTRY" resume FS-Z1 >"$TMP/missing-evidence.out" 2>"$TMP/missing-evidence.err"; then
  not_ok "reviewed resume rejects missing gate and review evidence"
else
  ok "reviewed resume rejects missing gate and review evidence"
fi
assert_eq "missing evidence never pushes a lane ref" "" "$(git -C "$REPO" ls-remote origin refs/heads/codex/stranger-fs-z1 | awk '{print $1}')"
assert_eq "missing evidence never reaches GitHub" false "$([ -e "$STUB_STATE/gh.log" ] && printf true || printf false)"

git -C "$REPO" worktree remove --force "$WORK_ROOT/fs-z1"
git -C "$REPO" branch -D codex/stranger-fs-z1 >/dev/null
git -C "$REPO" push -q origin :refs/heads/codex/stranger-fs-z1
rm -rf "$HOME_DIR/state" "$HOME_DIR/logs" "$HOME_DIR/gate-home" "$HOME_DIR/agent-runtime"
rm -f "$STUB_STATE/codex.log" "$STUB_STATE/gh.log" "$STUB_STATE/worktree"
printf 'trigger tracked gate mutation\n' >"$REPO/tamper-gate"
git -C "$REPO" add tamper-gate
git -C "$REPO" commit -qm "fixture: enable gate mutation"
git -C "$REPO" push -q origin main
tamper_before="$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)"
if env CN_REPO="$REPO" CN_HOME="$HOME_DIR" CN_WORK_ROOT="$WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$REPO/scripts/auto-loop/classify.sh" \
    CN_GATE="$REPO/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STUB_STATE" CN_TEST_REMOTE="$REMOTE" \
    CN_GH_REPO=fixture/repo CN_AGENT_ENV_CANARY=must-not-reach-agent \
    "$ENTRY" run --lane FS-Z1 >"$TMP/tamper-run.out" 2>"$TMP/tamper-run.err"; then
  not_ok "gate-induced worktree mutation is rejected"
else
  ok "gate-induced worktree mutation is rejected"
fi
assert_match "gate mutation refusal is explicit" 'authoritative gate exited nonzero' "$TMP/tamper-run.err"
assert_eq "gate mutation leaves lane at needs-human" needs-human "$(jq -r .phase "$STATE")"
assert_no_match "gate mutation never opens a PR" 'pr create' "$STUB_STATE/gh.log"
tamper_remote="$(git -C "$REPO" ls-remote origin refs/heads/codex/stranger-fs-z1 | awk '{print $1}')"
assert_eq "gate mutation never pushes a lane ref" "" "$tamper_remote"
assert_eq "gate mutation preserves the primary checkout" "$tamper_before" "$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)"
jq '.phase = "committed"' "$STATE" >"$STATE.tmp"
mv "$STATE.tmp" "$STATE"
chmod 600 "$STATE"

OUTSIDE_RUNTIME_ANCESTOR="$TMP/outside-runtime-ancestor"
rm -rf "$HOME_DIR/agent-runtime/fs-z1"
mkdir -p "$OUTSIDE_RUNTIME_ANCESTOR"
ln -s "$OUTSIDE_RUNTIME_ANCESTOR" "$HOME_DIR/agent-runtime/fs-z1"
if env CN_REPO="$REPO" CN_HOME="$HOME_DIR" CN_WORK_ROOT="$WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$REPO/scripts/auto-loop/classify.sh" \
    CN_GATE="$REPO/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STUB_STATE" CN_TEST_REMOTE="$REMOTE" \
    CN_GH_REPO=fixture/repo "$ENTRY" resume FS-Z1 >"$TMP/runtime-ancestor-link.out" 2>"$TMP/runtime-ancestor-link.err"; then
  not_ok "worker runtime ancestor symlink substitution is rejected"
else
  ok "worker runtime ancestor symlink substitution is rejected"
fi
assert_eq "runtime ancestor refusal creates nothing outside" false "$([ -e "$OUTSIDE_RUNTIME_ANCESTOR/worker" ] && printf true || printf false)"
rm "$HOME_DIR/agent-runtime/fs-z1"
mkdir -p "$HOME_DIR/agent-runtime/fs-z1/worker"

OUTSIDE_RUNTIME_TARGET="$TMP/outside-runtime-target"
mkdir -p "$OUTSIDE_RUNTIME_TARGET"
chmod 755 "$OUTSIDE_RUNTIME_TARGET"
rm -rf "$HOME_DIR/agent-runtime/fs-z1/worker/home"
ln -s "$OUTSIDE_RUNTIME_TARGET" "$HOME_DIR/agent-runtime/fs-z1/worker/home"
outside_mode_before="$(stat -f '%Lp' "$OUTSIDE_RUNTIME_TARGET")"
if env CN_REPO="$REPO" CN_HOME="$HOME_DIR" CN_WORK_ROOT="$WORK_ROOT" \
    CN_BASE_REF=origin/main CN_PR_BASE=main CN_CODEX_BIN="$CODEX_STUB" \
    CN_GH_BIN="$GH_STUB" CN_CLASSIFY="$REPO/scripts/auto-loop/classify.sh" \
    CN_GATE="$REPO/scripts/auto-loop/gate.sh" CN_STUB_STATE="$STUB_STATE" CN_TEST_REMOTE="$REMOTE" \
    CN_GH_REPO=fixture/repo "$ENTRY" resume FS-Z1 >"$TMP/runtime-link.out" 2>"$TMP/runtime-link.err"; then
  not_ok "worker runtime symlink substitution is rejected"
else
  ok "worker runtime symlink substitution is rejected"
fi
assert_match "runtime symlink refusal is explicit" 'agent runtime (root or ancestor|home).*not a real' "$TMP/runtime-link.err"
assert_eq "runtime symlink refusal does not chmod its target" "$outside_mode_before" "$(stat -f '%Lp' "$OUTSIDE_RUNTIME_TARGET")"

if [ "$fail" -ne 0 ]; then
  printf '%d integration test(s) failed; %d passed\n' "$fail" "$pass" >&2
  exit 1
fi
printf '%d integration tests passed\n' "$pass"
