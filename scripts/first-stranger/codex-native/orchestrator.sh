#!/usr/bin/env bash
set -euo pipefail
umask 077

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SELF/../../.." && pwd)"
# shellcheck source=policy.sh
. "$SELF/policy.sh"
# shellcheck source=prompts.sh
. "$SELF/prompts.sh"

CN_REPO="${CN_REPO:-$(git -C "$ROOT" rev-parse --show-toplevel)}"
CN_CODEX_BIN="${CN_CODEX_BIN:-codex}"
CN_GH_BIN="${CN_GH_BIN:-gh}"
CN_MODEL="${CN_MODEL:-gpt-5.6-sol}"
CN_REASONING="${CN_REASONING:-xhigh}"
CN_WORK_ROOT="${CN_WORK_ROOT:-$HOME/Library/Mosh/work/first-stranger-codex}"
CN_BACKLOG="${CN_BACKLOG:-$CN_REPO/docs/first-stranger-program/backlog.jsonl}"
CN_CLASSIFY="${CN_CLASSIFY:-$CN_REPO/scripts/auto-loop/classify.sh}"
CN_GATE="${CN_GATE:-$CN_REPO/scripts/auto-loop/gate.sh}"
CN_SCHEMAS="$SELF/schemas"
CN_REAL_GIT="${CN_REAL_GIT:-$(command -v git)}"

cn_default_base_ref() {
  if git -C "$CN_REPO" cat-file -e 'origin/main:docs/first-stranger-program/SPEC.md' 2>/dev/null; then
    printf 'origin/main\n'
  elif git -C "$CN_REPO" show-ref --verify --quiet refs/remotes/origin/claude/dev-automation-loops-141f8d; then
    printf 'origin/claude/dev-automation-loops-141f8d\n'
  else
    printf 'origin/main\n'
  fi
}

CN_BASE_REF="${CN_BASE_REF:-$(cn_default_base_ref)}"
case "$CN_BASE_REF" in
  origin/*) CN_PR_BASE_DEFAULT="${CN_BASE_REF#origin/}" ;;
  *) CN_PR_BASE_DEFAULT="main" ;;
esac
CN_PR_BASE="${CN_PR_BASE:-$CN_PR_BASE_DEFAULT}"

cn_die() {
  printf 'codex-native-loop: %s\n' "$*" >&2
  exit 1
}

cn_slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

cn_command_exists() {
  case "$1" in
    */*) [ -x "$1" ] ;;
    *) command -v "$1" >/dev/null 2>&1 ;;
  esac
}

cn_bool() {
  if "$@"; then printf 'true\n'; else printf 'false\n'; fi
}

cn_before_mutation() {
  local tree="${1:-$CN_REPO}"
  if cn_stop_requested "$CN_REPO" || { [ "$tree" != "$CN_REPO" ] && cn_stop_requested "$tree"; }; then
    cn_die "STOP is present; refusing state-changing action"
  fi
}

cn_state_path() {
  printf '%s/state/%s.json\n' "$CN_HOME" "$(cn_slug "$1")"
}

cn_log_dir() {
  printf '%s/logs/%s\n' "$CN_HOME" "$(cn_slug "$1")"
}

cn_worktree_path() {
  printf '%s/%s\n' "$CN_WORK_ROOT" "$(cn_slug "$1")"
}

cn_branch() {
  printf 'codex/stranger-%s\n' "$(cn_slug "$1")"
}

cn_check() {
  local ok=true stopped armed base_ok backlog_ok schemas_ok=true dep
  for dep in git jq "$CN_CODEX_BIN" "$CN_GH_BIN"; do
    cn_command_exists "$dep" || ok=false
  done
  if git -C "$CN_REPO" rev-parse --verify "$CN_BASE_REF^{commit}" >/dev/null 2>&1; then base_ok=true; else base_ok=false; fi
  if [ -r "$CN_BACKLOG" ]; then backlog_ok=true; else backlog_ok=false; fi
  for schema in "$CN_SCHEMAS"/*.json; do jq -e . "$schema" >/dev/null || schemas_ok=false; done
  stopped="$(cn_bool cn_stop_requested "$CN_REPO")"
  armed="$(cn_bool cn_require_armed)"
  jq -nc --argjson ok "$ok" --argjson armed "$armed" --argjson stopped "$stopped" \
    --argjson base_ok "$base_ok" --argjson backlog_ok "$backlog_ok" \
    --argjson schemas_ok "$schemas_ok" --arg base_ref "$CN_BASE_REF" \
    --arg pr_base "$CN_PR_BASE" --arg model "$CN_MODEL" \
    '{ok:($ok and $base_ok and $backlog_ok and $schemas_ok),armed:$armed,stopped:$stopped,base_ref:$base_ref,pr_base:$pr_base,model:$model,checks:{base_ref:$base_ok,backlog:$backlog_ok,schemas:$schemas_ok}}'
  [ "$ok" = true ] && [ "$base_ok" = true ] && [ "$backlog_ok" = true ] && [ "$schemas_ok" = true ]
}

cn_status() {
  local armed stopped files="[]"
  armed="$(cn_bool cn_require_armed)"
  stopped="$(cn_bool cn_stop_requested "$CN_REPO")"
  if [ -d "$CN_HOME/state" ]; then
    files="$(for f in "$CN_HOME/state"/*.json; do [ -f "$f" ] && jq -c . "$f" 2>/dev/null || true; done | jq -sc '.')"
  fi
  jq -nc --argjson armed "$armed" --argjson stopped "$stopped" --argjson lanes "$files" \
    --arg base_ref "$CN_BASE_REF" '{armed:$armed,stopped:$stopped,base_ref:$base_ref,lanes:$lanes}'
}

cn_lane_json() {
  local lane="$1"
  jq -sc --arg id "$lane" '[.[] | select(.id == $id)] | if length == 1 then .[0] else empty end' "$CN_BACKLOG"
}

cn_next_lanes() {
  local max="$1"
  jq -src --argjson max "$max" '[.[] | select(.status == "ready")] | sort_by(.order) | .[:$max] | .[].id' "$CN_BACKLOG"
}

cn_changed_paths() {
  local wt="$1"
  git -C "$wt" ls-files --modified --deleted --others --exclude-standard | LC_ALL=C sort -u
}

cn_assert_plan_only() {
  local wt="$1" lane="$2" want path
  want="docs/first-stranger-program/lanes/$(cn_slug "$lane").md"
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    [ "$path" = "$want" ] || return 1
  done < <(cn_changed_paths "$wt")
}

cn_assert_no_agent_commit() {
  [ "$(git -C "$1" rev-parse HEAD)" = "$2" ]
}

cn_secret_scan_staged() {
  ! git -C "$1" diff --cached -U0 | rg '^\+[^+].*(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)' >/dev/null
}

cn_schema_result() {
  local phase="$1" file="$2" lane="${3:-}" payload
  payload="$(jq -c . "$file" 2>/dev/null)" || return 1
  cn_validate_phase_output "$phase" "$payload" || return 1
  if [ -n "$lane" ] && [ "$phase" != review ]; then
    [ "$(jq -r .id <<<"$payload")" = "$lane" ] || return 1
  fi
  printf '%s\n' "$payload"
}

cn_exec_start() {
  local phase="$1" sandbox="$2" wt="$3" prompt="$4" out="$5" events="$6" err="$7"
  env CN_REAL_GIT="$CN_REAL_GIT" PATH="$SELF/agent-bin:$PATH" "$CN_CODEX_BIN" exec --ignore-user-config --json --color never \
    --output-schema "$CN_SCHEMAS/$phase.json" -o "$out" \
    -m "$CN_MODEL" -c "model_reasoning_effort=\"$CN_REASONING\"" \
    -c 'approval_policy="never"' -c "sandbox_mode=\"$sandbox\"" \
    -c 'sandbox_workspace_write.network_access=false' \
    -s "$sandbox" -C "$wt" "$prompt" >"$events" 2>"$err"
}

cn_exec_resume() {
  local phase="$1" session="$2" prompt="$3" out="$4" events="$5" err="$6"
  env CN_REAL_GIT="$CN_REAL_GIT" PATH="$SELF/agent-bin:$PATH" "$CN_CODEX_BIN" exec resume --ignore-user-config --json \
    --output-schema "$CN_SCHEMAS/$phase.json" -o "$out" \
    -m "$CN_MODEL" -c "model_reasoning_effort=\"$CN_REASONING\"" \
    -c 'approval_policy="never"' -c 'sandbox_mode="workspace-write"' \
    -c 'sandbox_workspace_write.network_access=false' \
    "$session" "$prompt" >"$events" 2>"$err"
}

cn_thread_from_events() {
  jq -r 'select(.type == "thread.started") | .thread_id // .thread.id // .id // empty' "$1" | head -1
}

cn_write_state() {
  local wt="$1" file="$2" lane="$3" base="$4" head="$5" phase="$6" thread="$7"
  cn_before_mutation "$wt"
  cn_state_write "$file" "$lane" "$base" "$head" "$phase" "$thread"
}

cn_prepare_lane() {
  local lane="$1" wt="$2" branch="$3" base="$4" state="$5"
  local duplicate
  [ ! -e "$wt" ] || cn_die "$lane worktree already exists; use resume $lane"
  ! git -C "$CN_REPO" show-ref --verify --quiet "refs/heads/$branch" || cn_die "$branch already exists; use resume $lane"
  duplicate="$("$CN_GH_BIN" pr list --state open --limit 200 --json title,headRefName 2>/dev/null \
    | jq -r --arg branch "$branch" --arg lane "$lane" '.[] | select(.headRefName == $branch or (.title | contains($lane))) | .title')" \
    || cn_die "could not perform duplicate-PR check for $lane"
  [ -z "$duplicate" ] || cn_die "$lane already has an open PR: $duplicate"
  cn_before_mutation
  mkdir -p "$CN_WORK_ROOT"
  cn_before_mutation
  git -C "$CN_REPO" worktree add -b "$branch" "$wt" "$base"
  cn_write_state "$wt" "$state" "$lane" "$base" "$base" initialized ""
}

cn_plan_phase() {
  local lane="$1" lane_json="$2" wt="$3" base="$4" state="$5" logs="$6"
  local prompt out events err thread result route gap
  prompt="$(cn_plan_prompt "$lane" "$lane_json")"
  out="$logs/plan.result.json"; events="$logs/plan.events.jsonl"; err="$logs/plan.stderr.log"
  cn_before_mutation "$wt"
  cn_exec_start plan workspace-write "$wt" "$prompt" "$out" "$events" "$err" || cn_die "$lane planning session failed; see $err"
  thread="$(cn_thread_from_events "$events")"
  [ -n "$thread" ] || cn_die "$lane planning session emitted no thread.started id"
  result="$(cn_schema_result plan "$out" "$lane")" || cn_die "$lane returned invalid planning JSON"
  cn_assert_no_agent_commit "$wt" "$base" || cn_die "$lane agent created a commit during planning"
  cn_assert_plan_only "$wt" "$lane" || cn_die "$lane planning changed files outside its lane plan"
  route="$(jq -r .route <<<"$result")"
  [ "$route" != never ] || { cn_write_state "$wt" "$state" "$lane" "$base" "$base" needs-human "$thread"; cn_die "$lane plan requires a never-touch path"; }
  gap="$(jq -r .gap_exists <<<"$result")"
  cn_write_state "$wt" "$state" "$lane" "$base" "$base" planned "$thread"
  printf '%s\n' "$gap"
}

cn_implement_phase() {
  local lane="$1" lane_json="$2" wt="$3" base="$4" state="$5" logs="$6" thread="$7"
  local prompt out events err result ready blockers
  prompt="$(cn_implement_prompt "$lane" "$lane_json")"
  out="$logs/implement.result.json"; events="$logs/implement.events.jsonl"; err="$logs/implement.stderr.log"
  cn_before_mutation "$wt"
  cn_exec_resume implement "$thread" "$prompt" "$out" "$events" "$err" || cn_die "$lane implementation session failed; see $err"
  result="$(cn_schema_result implement "$out" "$lane")" || cn_die "$lane returned invalid implementation JSON"
  cn_assert_no_agent_commit "$wt" "$base" || cn_die "$lane agent created a commit during implementation"
  ready="$(jq -r .ready_for_gate <<<"$result")"
  blockers="$(jq '.blockers | length' <<<"$result")"
  if [ "$ready" != true ] || [ "$blockers" -ne 0 ]; then
    cn_write_state "$wt" "$state" "$lane" "$base" "$base" needs-human "$thread"
    cn_die "$lane implementation reported blockers"
  fi
  cn_write_state "$wt" "$state" "$lane" "$base" "$base" implemented "$thread"
}

cn_commit_phase() {
  local lane="$1" lane_json="$2" wt="$3" base="$4" state="$5" thread="$6"
  local changed route owner_merge title head path staged_paths
  changed="$(cn_changed_paths "$wt")"
  [ -n "$changed" ] || cn_die "$lane produced an empty diff"
  route="$(printf '%s\n' "$changed" | "$SELF/route-paths.sh")"
  [ "$route" != never ] || { cn_write_state "$wt" "$state" "$lane" "$base" "$base" needs-human "$thread"; cn_die "$lane touched a never path"; }
  if cn_diff_has_cmake_pin "$wt"; then
    cn_write_state "$wt" "$state" "$lane" "$base" "$base" needs-human "$thread"
    cn_die "$lane introduced or changed a CMake dependency pin"
  fi
  owner_merge="$(jq -r '.ownerMerge // false' <<<"$lane_json")"
  [ "$owner_merge" != true ] || route=owner
  cn_before_mutation "$wt"
  while IFS= read -r path; do [ -n "$path" ] && git -C "$wt" add -- "$path"; done <<<"$changed"
  staged_paths="$(git -C "$wt" diff --cached --name-only)"
  [ "$(printf '%s\n' "$staged_paths" | "$SELF/route-paths.sh")" != never ] || cn_die "$lane staged a never path"
  cn_secret_scan_staged "$wt" || cn_die "$lane staged a high-confidence secret"
  title="$(jq -r .title <<<"$lane_json")"
  cn_before_mutation "$wt"
  git -C "$wt" commit -m "feat(first-stranger): $lane $title" >/dev/null
  head="$(git -C "$wt" rev-parse HEAD)"
  cn_write_state "$wt" "$state" "$lane" "$base" "$head" committed "$thread"
  printf '%s %s\n' "$route" "$head"
}

cn_gate_phase() {
  local lane="$1" wt="$2" base="$3" state="$4" logs="$5" thread="$6" head="$7"
  local classification class gate_result
  classification="$("$CN_CLASSIFY" "$base" "$wt")" || cn_die "$lane classifier failed"
  class="$(jq -er .class <<<"$classification")" || cn_die "$lane classifier returned invalid JSON"
  if [ "$class" = native ] && [ -z "${MOSH_SELFTEST_BASELINE:-}" ]; then
    cn_die "$lane is native but MOSH_SELFTEST_BASELINE is unset"
  fi
  cn_before_mutation "$wt"
  gate_result="$logs/gate.json"
  MOSH_SELFTEST_BASELINE="${MOSH_SELFTEST_BASELINE:-}" "$CN_GATE" "$class" "$wt" "$base" >"$gate_result" || true
  jq -e '.pass == true' "$gate_result" >/dev/null || cn_die "$lane authoritative gate failed; see $gate_result"
  [ "$(git -C "$wt" rev-parse HEAD)" = "$head" ] || cn_die "$lane HEAD changed during the gate"
  cn_write_state "$wt" "$state" "$lane" "$base" "$head" gated "$thread"
}

cn_review_phase() {
  local lane="$1" wt="$2" base="$3" route="$4" state="$5" logs="$6" thread="$7" head="$8"
  local prompt out events err result
  prompt="$(cn_review_prompt "$lane" "$base" "$route")"
  out="$logs/review.result.json"; events="$logs/review.events.jsonl"; err="$logs/review.stderr.log"
  cn_before_mutation "$wt"
  cn_exec_start review read-only "$wt" "$prompt" "$out" "$events" "$err" || cn_die "$lane hostile review session failed; see $err"
  result="$(cn_schema_result review "$out")" || cn_die "$lane returned invalid review JSON"
  [ "$(git -C "$wt" rev-parse HEAD)" = "$head" ] || cn_die "$lane HEAD changed during review"
  if [ "$(jq -r .verdict <<<"$result")" != APPROVE ] || [ "$(jq -r .blockers <<<"$result")" -ne 0 ]; then
    cn_write_state "$wt" "$state" "$lane" "$base" "$head" needs-human "$thread"
    cn_die "$lane hostile review rejected the change"
  fi
  cn_write_state "$wt" "$state" "$lane" "$base" "$head" reviewed "$thread"
}

cn_ensure_label() {
  local wt="$1" name="$2" color="$3"
  if "$CN_GH_BIN" label list --limit 500 --json name \
      | jq -e --arg name "$name" 'map(.name) | index($name) != null' >/dev/null 2>&1; then
    return 0
  fi
  cn_before_mutation "$wt"
  "$CN_GH_BIN" label create "$name" --color "$color" >/dev/null
}

cn_publish_phase() {
  local lane="$1" lane_json="$2" wt="$3" base="$4" route="$5" branch="$6" state="$7" logs="$8" thread="$9" head="${10}"
  local remote body pr_url program_label existing_pr
  cn_before_mutation "$wt"
  git -C "$wt" push origin "$head:refs/heads/$branch"
  remote="$(git -C "$wt" ls-remote origin "refs/heads/$branch" | awk '{print $1}')"
  cn_remote_head_matches "$head" "$remote" || cn_die "$lane remote head differs from gated head"
  body="$logs/pr-body.md"
  cn_before_mutation "$wt"
  {
    printf '## Codex-native First-Stranger lane %s\n\n' "$lane"
    printf -- '- Route: `%s` (PR-only v1; no merge operation exists)\n' "$route"
    printf -- '- Exact gated head: `%s`\n' "$head"
    printf -- '- Base SHA: `%s`\n' "$base"
    printf -- '- Authoritative gate: `%s`\n' "$(jq -c '{pass,class,selftest,selftest_failed,asserts}' "$logs/gate.json")"
    printf -- '- Hostile review: `%s`\n\n' "$(jq -c . "$logs/review.result.json")"
    printf 'The deterministic supervisor, not the agent, committed and pushed this exact SHA. This draft requires owner action.\n'
  } >"$body"
  program_label="program:$(jq -r '.lane // "X"' <<<"$lane_json")"
  cn_ensure_label "$wt" "$program_label" 5319E7
  cn_ensure_label "$wt" "codex-route:$route" D4C5F9
  if [ "$route" = owner ]; then
    cn_ensure_label "$wt" needs-owner-merge B60205
  fi
  existing_pr="$("$CN_GH_BIN" pr list --state open --head "$branch" --base "$CN_PR_BASE" --json url --jq '.[0].url // empty')" \
    || cn_die "$lane could not check for an already-created PR"
  if [ -n "$existing_pr" ]; then
    cn_write_state "$wt" "$state" "$lane" "$base" "$head" pr-opened "$thread"
    printf '%s %s\n' "$lane" "$existing_pr"
    return 0
  fi
  cn_before_mutation "$wt"
  if [ "$route" = owner ]; then
    pr_url="$("$CN_GH_BIN" pr create --draft --base "$CN_PR_BASE" --head "$branch" --title "$lane: $(jq -r .title <<<"$lane_json")" --body-file "$body" --label "$program_label" --label "codex-route:$route" --label needs-owner-merge)"
  else
    pr_url="$("$CN_GH_BIN" pr create --draft --base "$CN_PR_BASE" --head "$branch" --title "$lane: $(jq -r .title <<<"$lane_json")" --body-file "$body" --label "$program_label" --label "codex-route:$route")"
  fi
  cn_write_state "$wt" "$state" "$lane" "$base" "$head" pr-opened "$thread"
  printf '%s %s\n' "$lane" "$pr_url"
}

cn_run_lane() {
  local lane="$1" resume_mode="${2:-false}" lane_json slug wt branch state logs base phase thread gap result route head changed_paths
  lane_json="$(cn_lane_json "$lane")"
  [ -n "$lane_json" ] || cn_die "unknown lane: $lane"
  slug="$(cn_slug "$lane")"; wt="$(cn_worktree_path "$lane")"; branch="$(cn_branch "$lane")"
  state="$(cn_state_path "$lane")"; logs="$(cn_log_dir "$lane")"
  if [ "$resume_mode" = true ]; then
    [ -f "$state" ] || cn_die "$lane has no resumable state"
    [ -d "$wt/.git" ] || [ -f "$wt/.git" ] || cn_die "$lane worktree is missing"
    base="$(cn_state_field "$state" base_sha)"; head="$(cn_state_field "$state" head_sha)"
    cn_state_validate "$state" "$base" "$(git -C "$wt" rev-parse HEAD)" || cn_die "$lane state is stale relative to its worktree"
    phase="$(cn_state_field "$state" phase)"; thread="$(cn_state_field "$state" thread_id)"
    case "$phase" in needs-human|pr-opened) cn_die "$lane is in terminal phase $phase" ;; esac
  else
    base="$(git -C "$CN_REPO" rev-parse "$CN_BASE_REF^{commit}")"; head="$base"; phase=initialized; thread=""
    cn_prepare_lane "$lane" "$wt" "$branch" "$base" "$state"
  fi
  cn_before_mutation "$wt"
  mkdir -p "$logs"
  cn_before_mutation "$wt"
  chmod 700 "$logs"

  if [ "$phase" = initialized ]; then
    gap="$(cn_plan_phase "$lane" "$lane_json" "$wt" "$base" "$state" "$logs")"
    phase=planned; thread="$(cn_state_field "$state" thread_id)"
    if [ "$gap" = false ]; then
      cn_write_state "$wt" "$state" "$lane" "$base" "$base" implemented "$thread"
      phase=implemented
    fi
  fi
  if [ "$phase" = planned ]; then
    cn_implement_phase "$lane" "$lane_json" "$wt" "$base" "$state" "$logs" "$thread"
    phase=implemented
  fi
  if [ "$phase" = implemented ]; then
    result="$(cn_commit_phase "$lane" "$lane_json" "$wt" "$base" "$state" "$thread")"
    route="${result%% *}"; head="${result#* }"; phase=committed
  else
    changed_paths="$(git -C "$wt" diff --name-only "$base...HEAD")"
    route="$(printf '%s\n' "$changed_paths" | "$SELF/route-paths.sh")"
    head="$(git -C "$wt" rev-parse HEAD)"
  fi
  if [ "$phase" = committed ]; then cn_gate_phase "$lane" "$wt" "$base" "$state" "$logs" "$thread" "$head"; phase=gated; fi
  if [ "$phase" = gated ]; then cn_review_phase "$lane" "$wt" "$base" "$route" "$state" "$logs" "$thread" "$head"; phase=reviewed; fi
  if [ "$phase" = reviewed ]; then cn_publish_phase "$lane" "$lane_json" "$wt" "$base" "$route" "$branch" "$state" "$logs" "$thread" "$head"; fi
}

cn_acquire_lock() {
  cn_before_mutation
  mkdir -p "$CN_HOME"
  cn_before_mutation
  chmod 700 "$CN_HOME"
  cn_before_mutation
  mkdir "$CN_HOME/run.lock" 2>/dev/null || cn_die "another Codex-native run holds $CN_HOME/run.lock"
  trap 'rmdir "$CN_HOME/run.lock" 2>/dev/null || true' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

cn_run() {
  local lane="" next=false max=1 arg lanes pids="" pid rc=0
  cn_require_armed || cn_die "run is inert without $CN_HOME/ARMED"
  cn_home_is_external "$CN_REPO" || cn_die "CN_HOME must resolve outside the repository"
  while [ "$#" -gt 0 ]; do
    arg="$1"; shift
    case "$arg" in
      --lane) [ "$#" -gt 0 ] || cn_die "--lane requires FS-ID"; lane="$1"; shift ;;
      --next) next=true ;;
      --max-items) [ "$#" -gt 0 ] || cn_die "--max-items requires N"; max="$1"; shift ;;
      *) cn_die "unknown run option: $arg" ;;
    esac
  done
  case "$max" in ''|*[!0-9]*|0) cn_die "--max-items must be a positive integer" ;; esac
  [ "$max" -le 8 ] || cn_die "--max-items above 8 is refused"
  { [ -n "$lane" ] && [ "$next" = false ]; } || { [ -z "$lane" ] && [ "$next" = true ]; } || cn_die "choose exactly one of --lane or --next"
  cn_acquire_lock
  [ -z "$(git -C "$CN_REPO" status --porcelain=v1 --untracked-files=all)" ] || cn_die "runner checkout is dirty; use a dedicated clean worktree"
  case "$CN_BASE_REF" in
    origin/*)
      cn_before_mutation
      git -C "$CN_REPO" fetch --no-tags origin "${CN_BASE_REF#origin/}:refs/remotes/$CN_BASE_REF"
      ;;
  esac
  cn_before_mutation
  mkdir -p "$CN_HOME/state" "$CN_HOME/logs" "$CN_WORK_ROOT"
  cn_before_mutation
  chmod 700 "$CN_HOME/state" "$CN_HOME/logs" "$CN_WORK_ROOT"
  if [ -n "$lane" ]; then lanes="$lane"; else lanes="$(cn_next_lanes "$max")"; fi
  [ -n "$lanes" ] || cn_die "no ready lanes"
  while IFS= read -r lane; do
    [ -n "$lane" ] || continue
    (cn_run_lane "$lane" false) &
    pid=$!; pids="$pids $pid"
  done <<<"$lanes"
  set +e
  for pid in $pids; do wait "$pid" || rc=1; done
  set -e
  return "$rc"
}

cn_resume() {
  local lane="${1:-}"
  [ -n "$lane" ] || cn_die "resume requires FS-ID"
  [ "$#" -eq 1 ] || cn_die "resume accepts exactly one FS-ID"
  cn_require_armed || cn_die "resume is inert without $CN_HOME/ARMED"
  cn_home_is_external "$CN_REPO" || cn_die "CN_HOME must resolve outside the repository"
  cn_acquire_lock
  [ -z "$(git -C "$CN_REPO" status --porcelain=v1 --untracked-files=all)" ] || cn_die "runner checkout is dirty; use a dedicated clean worktree"
  cn_run_lane "$lane" true
}

cn_usage() {
  cat <<'EOF'
usage:
  codex-native-loop.sh check
  codex-native-loop.sh status
  codex-native-loop.sh run [--lane FS-ID | --next] [--max-items N]
  codex-native-loop.sh resume FS-ID
EOF
}

case "${1:-check}" in
  check) shift || true; [ "$#" -eq 0 ] || cn_die "check takes no arguments"; cn_check ;;
  status) shift; [ "$#" -eq 0 ] || cn_die "status takes no arguments"; cn_status ;;
  run) shift; cn_run "$@" ;;
  resume) shift; cn_resume "$@" ;;
  -h|--help|help) cn_usage ;;
  *) cn_usage >&2; exit 2 ;;
esac
