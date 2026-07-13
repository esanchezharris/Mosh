#!/usr/bin/env bash

: "${CN_HOME:=$HOME/Library/Mosh/automation/first-stranger-codex}"

cn_route_path() {
  local path="$1"
  case "$path" in
    scripts/auto-loop/*|scripts/first-stranger/codex-native/*|scripts/first-stranger/codex-native-loop.sh)
      printf 'never\n'; return ;;
    .claude/workflows/stranger-loop.workflow.js|scripts/first-stranger/status.sh|scripts/first-stranger/nightly.sh|scripts/first-stranger/install-launchd.sh|scripts/first-stranger/codex-lane.sh)
      printf 'never\n'; return ;;
    AGENTS.md|CLAUDE.md|docs/0[0-6]_*.md|docs/02_MOSHOPS_CONTRACT.md|.github/*)
      printf 'never\n'; return ;;
    docs/first-stranger-program/SPEC.md|docs/first-stranger-program/README.md|docs/first-stranger-program/CODEX_HANDOFF.md|docs/first-stranger-program/CODEX_NATIVE_ASSESSMENT.md|docs/first-stranger-program/backlog.jsonl|docs/first-stranger-program/LEDGER.md|docs/first-stranger-program/STATUS.md)
      printf 'never\n'; return ;;
    cmake/Dependencies.cmake|cmake/CPM*.cmake|cmake/*patch*|patches/*)
      printf 'never\n'; return ;;
    arena/*|*SA3*LoRA*|*sa3*lora*|*FMS*|*fms*)
      printf 'never\n'; return ;;
    docs/auto-loop/STOP|docs/first-stranger-program/STOP|docs/first-stranger-program/ARMED)
      printf 'never\n'; return ;;
    docs/*|ui/*)
      printf 'safe\n'; return ;;
    service/*.py|service/**/*.py)
      printf 'safe\n'; return ;;
    *)
      printf 'owner\n'; return ;;
  esac
}

cn_route_paths() {
  local route="safe" path one
  [ "$#" -gt 0 ] || { printf 'never\n'; return; }
  for path in "$@"; do
    one="$(cn_route_path "$path")"
    if [ "$one" = "never" ]; then
      printf 'never\n'; return
    fi
    [ "$one" = "owner" ] && route="owner"
  done
  printf '%s\n' "$route"
}

cn_effective_route() {
  local route="$1" lane_json="$2" owner_merge
  case "$route" in safe|owner|never) ;; *) return 1 ;; esac
  owner_merge="$(jq -r '(.ownerMerge // false) | if type == "boolean" then . else error("ownerMerge must be boolean") end' <<<"$lane_json")" \
    || return 1
  case "$owner_merge" in true|false) ;; *) return 1 ;; esac
  if [ "$owner_merge" = true ] && [ "$route" != never ]; then
    printf 'owner\n'
  else
    printf '%s\n' "$route"
  fi
}

cn_require_armed() {
  [ -f "$CN_HOME/ARMED" ] &&
    [ ! -L "$CN_HOME/ARMED" ] &&
    [ "$(stat -f '%Lp' "$CN_HOME/ARMED" 2>/dev/null)" = 600 ]
}

cn_home_is_external() {
  local repo="$1" home
  [ -d "$CN_HOME" ] || return 1
  repo="$(cd "$repo" && pwd -P)"
  home="$(cd "$CN_HOME" && pwd -P)"
  case "$home" in "$repo"|"$repo"/*) return 1 ;; esac
  return 0
}

cn_path_present() {
  [ -e "$1" ] || [ -L "$1" ]
}

cn_real_dir() {
  [ -d "$1" ] || return 1
  (cd "$1" && pwd -P)
}

cn_default_control_repo() {
  local runner="$1" common config configured git_dir common_real git_real runner_real
  common="$(git -C "$runner" rev-parse --path-format=absolute --git-common-dir)" || return 1
  config="$common/config.worktree"
  if cn_path_present "$config"; then
    [ -r "$config" ] || return 1
    configured="$(git config --file "$config" --path --get core.worktree)" || return 1
    [ -n "$configured" ] || return 1
    case "$configured" in /*) ;; *) configured="$common/$configured" ;; esac
    cn_real_dir "$configured"
  else
    git_dir="$(git -C "$runner" rev-parse --path-format=absolute --git-dir)" || return 1
    common_real="$(cn_real_dir "$common")" || return 1
    git_real="$(cn_real_dir "$git_dir")" || return 1
    runner_real="$(cn_real_dir "$runner")" || return 1
    [ "$git_real" = "$common_real" ] || return 1
    case "$common_real" in "$runner_real/.git"|"$runner_real/.git"/*) ;; *) return 1 ;; esac
    printf '%s\n' "$runner_real"
  fi
}

cn_present_bool() {
  if cn_path_present "$1"; then printf 'true\n'; else printf 'false\n'; fi
}

cn_external_stop_bool() {
  local root="$1"
  cn_path_present "$root" || { printf 'false\n'; return; }
  [ -d "$root" ] && [ -x "$root" ] || return 2
  cn_present_bool "$root/STOP"
}

cn_repo_stop_bool() {
  local root="$1" area="$2" docs dir
  [ -d "$root" ] && [ -x "$root" ] || return 2
  docs="$root/docs"
  cn_path_present "$docs" || { printf 'false\n'; return; }
  [ -d "$docs" ] && [ -x "$docs" ] || return 2
  dir="$docs/$area"
  cn_path_present "$dir" || { printf 'false\n'; return; }
  [ -d "$dir" ] && [ -x "$dir" ] || return 2
  cn_present_bool "$dir/STOP"
}

cn_lane_stop_append() {
  local lanes="$1" tree="$2" real shared program
  cn_path_present "$tree" || { printf '%s\n' "$lanes"; return; }
  [ -d "$tree" ] && [ -x "$tree" ] || return 2
  real="$(cn_real_dir "$tree")" || return 2
  if jq -e --arg worktree "$real" 'map(.worktree) | index($worktree) != null' <<<"$lanes" >/dev/null; then
    printf '%s\n' "$lanes"
    return
  fi
  shared="$(cn_repo_stop_bool "$real" auto-loop)" || return 2
  program="$(cn_repo_stop_bool "$real" first-stranger-program)" || return 2
  jq -nc --argjson lanes "$lanes" --arg worktree "$real" \
    --argjson shared "$shared" --argjson program "$program" \
    '$lanes + [{worktree:$worktree,shared:$shared,program:$program}]'
}

cn_stop_sources_json() {
  local runner="$1" control="$2" work_root="${3:-}" extra="${4:-}"
  local external control_shared control_program runner_shared runner_program lanes tree lane_shared lane_program
  external="$(cn_external_stop_bool "$CN_HOME")" || return 2
  control_shared="$(cn_repo_stop_bool "$control" auto-loop)" || return 2
  control_program="$(cn_repo_stop_bool "$control" first-stranger-program)" || return 2
  runner_shared="$(cn_repo_stop_bool "$runner" auto-loop)" || return 2
  runner_program="$(cn_repo_stop_bool "$runner" first-stranger-program)" || return 2
  lanes='[]'
  if [ -n "$work_root" ] && cn_path_present "$work_root"; then
    [ -d "$work_root" ] && [ -r "$work_root" ] && [ -x "$work_root" ] || return 2
    for tree in "$work_root"/*; do
      lanes="$(cn_lane_stop_append "$lanes" "$tree")" || return 2
    done
  fi
  if [ -n "$extra" ] && [ "$extra" != "$runner" ] && [ "$extra" != "$control" ]; then
    lanes="$(cn_lane_stop_append "$lanes" "$extra")" || return 2
  fi
  lane_shared="$(jq -r 'map(.shared) | any' <<<"$lanes")"
  lane_program="$(jq -r 'map(.program) | any' <<<"$lanes")"
  jq -nc --argjson external "$external" --argjson control_shared "$control_shared" --argjson control_program "$control_program" \
    --argjson runner_shared "$runner_shared" --argjson runner_program "$runner_program" \
    --argjson lane_shared "$lane_shared" --argjson lane_program "$lane_program" \
    --argjson lanes "$lanes" \
    '{stop_sources:{external:$external,control_shared:$control_shared,control_program:$control_program,runner_shared:$runner_shared,runner_program:$runner_program,lane_shared:$lane_shared,lane_program:$lane_program},lane_stop_sources:$lanes}'
}

cn_stop_requested() {
  local runner="$1" control="${2:-$1}" work_root="${3:-}" extra="${4:-}" report rc
  report="$(cn_stop_sources_json "$runner" "$control" "$work_root" "$extra")" || return 2
  if jq -e '.stop_sources | [.[]] | any' <<<"$report" >/dev/null; then
    return 0
  else
    rc=$?
  fi
  [ "$rc" -eq 1 ] && return 1
  return 2
}

cn_state_write() {
  local file="$1" lane="$2" base="$3" head="$4" phase="$5" thread_id="$6" binding="${7:-null}"
  local dir tmp
  dir="$(dirname "$file")"
  mkdir -p "$dir"
  chmod 700 "$CN_HOME" "$dir" 2>/dev/null || true
  tmp="$(mktemp "$dir/.state.XXXXXX")"
  jq -nc \
    --arg lane "$lane" --arg base "$base" --arg head "$head" \
    --arg phase "$phase" --arg thread "$thread_id" --argjson binding "$binding" \
    '{lane:$lane,base_sha:$base,head_sha:$head,phase:$phase,thread_id:$thread,git_binding:$binding}' >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

cn_state_validate() {
  local file="$1" base="$2" head="$3" binding="${4:-}"
  [ -f "$file" ] || return 1
  if [ -n "$binding" ]; then
    jq -e --arg base "$base" --arg head "$head" --argjson binding "$binding" \
      '.base_sha == $base and .head_sha == $head and .git_binding == $binding' "$file" >/dev/null
  else
    jq -e --arg base "$base" --arg head "$head" \
      '.base_sha == $base and .head_sha == $head' "$file" >/dev/null
  fi
}

cn_state_field() {
  local file="$1" field="$2"
  jq -er --arg field "$field" '.[$field]' "$file"
}

cn_remote_head_matches() {
  [ "$1" = "$2" ]
}

cn_worktree_clean() {
  local status
  status="$(git -C "$1" status --porcelain=v1 --untracked-files=all)" || return 1
  [ -z "$status" ]
}

cn_git_binding() {
  local wt="$1" pointer git_dir common
  [ -f "$wt/.git" ] && [ ! -L "$wt/.git" ] || return 1
  pointer="$(LC_ALL=C sed -n '1p' "$wt/.git")" || return 1
  git_dir="$(git -C "$wt" rev-parse --path-format=absolute --git-dir)" || return 1
  common="$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir)" || return 1
  git_dir="$(cn_real_dir "$git_dir")" || return 1
  common="$(cn_real_dir "$common")" || return 1
  jq -nc --arg pointer "$pointer" --arg git_dir "$git_dir" --arg common "$common" \
    '{pointer:$pointer,git_dir:$git_dir,common:$common}'
}

cn_trusted_deps_match() {
  local wt="$1" deps="$2" want got
  [ -d "$deps" ] && [ ! -L "$deps" ] || return 1
  [ -r "$wt/ui/package-lock.json" ] && [ -r "$deps/.mosh-deps-stamp" ] || return 1
  want="$(shasum -a 256 "$wt/ui/package-lock.json" | awk '{print $1}')" || return 1
  got="$(LC_ALL=C sed -n '1p' "$deps/.mosh-deps-stamp")" || return 1
  [ -n "$want" ] && [ "$want" = "$got" ]
}

cn_no_ignored_state() {
  local status
  status="$(git -C "$1" status --porcelain=v1 --ignored=matching)" || return 1
  ! printf '%s\n' "$status" | rg -q '^!! '
}

cn_gate_candidate_paths_supported() {
  local class="$1" changed="$2" path
  [ "$class" = cheap ] || return 1
  [ -n "$changed" ] || return 1
  while IFS= read -r path; do
    case "$path" in
      docs/*|ui/*)
        case "$path" in
          ui/package.json|ui/package-lock.json|ui/npm-shrinkwrap.json) return 1 ;;
        esac
        ;;
      *) return 1 ;;
    esac
  done <<<"$changed"
  return 0
}

cn_gate_sandbox_supported() {
  [ "${CN_ENABLE_EXPERIMENTAL_SEATBELT_GATE:-0}" = 1 ] || return 1
  cn_gate_candidate_paths_supported "$@"
}

cn_validate_gate_result() {
  local file="$1" class="$2"
  jq -se --arg class "$class" '
    length == 1 and
    (.[0] | type == "object" and .pass == true and .class == $class and
      (.selftest | type == "array") and
      (.selftest_failed | type == "number") and
      (.asserts | type == "number") and
      (.steps | type == "array"))
  ' "$file" >/dev/null
}

cn_diff_has_cmake_pin() {
  local wt="$1" path
  if git -C "$wt" diff -U0 -- CMakeLists.txt ':(glob)**/CMakeLists.txt' ':(glob)cmake/**' \
      | rg '^\+[^+].*(CPMAddPackage|FetchContent_Declare|GIT_TAG|URL_HASH|DOWNLOAD_EXTRACT_TIMESTAMP)' >/dev/null; then
    return 0
  fi
  while IFS= read -r path; do
    case "$path" in
      cmake/*|CMakeLists.txt|*/CMakeLists.txt)
        if ! git -C "$wt" ls-files --error-unmatch "$path" >/dev/null 2>&1 &&
           rg '(CPMAddPackage|FetchContent_Declare|GIT_TAG|URL_HASH|DOWNLOAD_EXTRACT_TIMESTAMP)' "$wt/$path" >/dev/null 2>&1; then
          return 0
        fi
        ;;
    esac
  done < <(git -C "$wt" ls-files --modified --deleted --others --exclude-standard | LC_ALL=C sort -u)
  return 1
}

cn_validate_phase_output() {
  local phase="$1" payload="$2"
  case "$phase" in
    plan)
      jq -e '
        type == "object" and
        (.id | type == "string") and
        (.planned | type == "boolean") and
        (.gap_exists | type == "boolean") and
        (.route == "safe" or .route == "owner" or .route == "never") and
        (.summary | type == "string")
      ' >/dev/null <<<"$payload"
      ;;
    implement)
      jq -e '
        type == "object" and
        (.id | type == "string") and
        (.ready_for_gate | type == "boolean") and
        (.summary | type == "string") and
        (.tests_run | type == "array") and
        (.blockers | type == "array")
      ' >/dev/null <<<"$payload"
      ;;
    review)
      jq -e '
        type == "object" and
        (.verdict == "APPROVE" or .verdict == "REJECT") and
        (.blockers | type == "number" and floor == .) and
        (.reasons | type == "array")
      ' >/dev/null <<<"$payload"
      ;;
    *) return 1 ;;
  esac
}
