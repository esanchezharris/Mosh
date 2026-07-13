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
if [ -z "${CN_GH_REPO:-}" ]; then
  CN_GH_REPO="$(git -C "$CN_REPO" remote get-url origin)" || {
    printf 'codex-native-loop: could not resolve GitHub repository\n' >&2
    exit 1
  }
  case "$CN_GH_REPO" in
    https://github.com/*) CN_GH_REPO="${CN_GH_REPO#https://github.com/}" ;;
    git@github.com:*) CN_GH_REPO="${CN_GH_REPO#git@github.com:}" ;;
    ssh://git@github.com/*) CN_GH_REPO="${CN_GH_REPO#ssh://git@github.com/}" ;;
  esac
  CN_GH_REPO="${CN_GH_REPO%.git}"
fi
CN_MODEL="${CN_MODEL:-gpt-5.6-sol}"
CN_REASONING="${CN_REASONING:-xhigh}"
CN_WORK_ROOT="${CN_WORK_ROOT:-$HOME/Library/Mosh/work/first-stranger-codex}"
CN_BACKLOG="${CN_BACKLOG:-$CN_REPO/docs/first-stranger-program/backlog.jsonl}"
CN_CLASSIFY="${CN_CLASSIFY:-$CN_REPO/scripts/auto-loop/classify.sh}"
CN_GATE="${CN_GATE:-$CN_REPO/scripts/auto-loop/gate.sh}"
CN_SCHEMAS="$SELF/schemas"
CN_GATE_PROFILE="${CN_GATE_PROFILE:-$SELF/gate.sb}"
CN_SANDBOX_BIN="${CN_SANDBOX_BIN:-/usr/bin/sandbox-exec}"
CN_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CN_PINNED_PATH="$SELF/agent-bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
CN_AGENT_PATH="${CN_AGENT_PATH:-$CN_PINNED_PATH}"
CN_GATE_PATH="${CN_GATE_PATH:-$CN_PINNED_PATH}"
CN_REAL_NPM="${CN_REAL_NPM:-/opt/homebrew/bin/npm}"
CN_BREW_ROOT="${CN_BREW_ROOT:-/opt/homebrew}"
CN_PLAYWRIGHT_CACHE="${CN_PLAYWRIGHT_CACHE:-$HOME/Library/Caches/ms-playwright}"
if [ -n "${CN_CONTROL_REPO:-}" ]; then
  CN_CONTROL_REPO="$(cn_real_dir "$CN_CONTROL_REPO")" || {
    printf 'codex-native-loop: CN_CONTROL_REPO is not a readable directory\n' >&2
    exit 1
  }
else
  CN_CONTROL_REPO="$(cn_default_control_repo "$CN_REPO")" || {
    printf 'codex-native-loop: could not resolve canonical control checkout\n' >&2
    exit 1
  }
fi
CN_TRUSTED_UI_DEPS="${CN_TRUSTED_UI_DEPS:-$CN_REPO/ui/node_modules}"

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

cn_toml_path_ok() {
  if LC_ALL=C printf '%s' "$1" | grep -q '[^ -~]'; then return 1; fi
  case "$1" in *'"'*|*'\'*) return 1 ;; esac
  return 0
}

cn_agent_toolchain_valid() {
  local repo ui expected_deps deps tools_root brew_root brew_bin brew_cellar brew_opt brew_node_modules brew_openssl_config path
  local node_root node_real npm_real cmd_list_real
  repo="$(cn_real_dir "$CN_REPO")" || return 1
  [ -d "$repo/ui" ] && [ ! -L "$repo/ui" ] || return 1
  ui="$(cn_real_dir "$repo/ui")" || return 1
  [ "$ui" = "$repo/ui" ] || return 1
  [ -d "$repo/ui/node_modules" ] && [ ! -L "$repo/ui/node_modules" ] || return 1
  [ -d "$CN_TRUSTED_UI_DEPS" ] && [ ! -L "$CN_TRUSTED_UI_DEPS" ] || return 1
  expected_deps="$(cn_real_dir "$repo/ui/node_modules")" || return 1
  deps="$(cn_real_dir "$CN_TRUSTED_UI_DEPS")" || return 1
  [ "$expected_deps" = "$ui/node_modules" ] && [ "$deps" = "$expected_deps" ] || return 1
  cn_trusted_deps_match "$repo" "$CN_TRUSTED_UI_DEPS" || return 1
  [ -d "$SELF/agent-bin" ] && [ ! -L "$SELF/agent-bin" ] || return 1
  tools_root="$(cn_real_dir "$SELF/agent-bin")" || return 1
  [ "$tools_root" = "$SELF/agent-bin" ] || return 1
  [ -x "$tools_root/npm" ] && [ -x "$tools_root/git" ] && [ -x "$tools_root/gh" ] || return 1
  [ "$CN_AGENT_PATH" = "$CN_PINNED_PATH" ] && [ "$CN_GATE_PATH" = "$CN_PINNED_PATH" ] || return 1

  [ -d "$CN_BREW_ROOT" ] && [ ! -L "$CN_BREW_ROOT" ] || return 1
  brew_root="$(cn_real_dir "$CN_BREW_ROOT")" || return 1
  [ "$brew_root" = /opt/homebrew ] || return 1
  brew_bin="$(cn_real_dir "$brew_root/bin")" || return 1
  brew_cellar="$(cn_real_dir "$brew_root/Cellar")" || return 1
  brew_opt="$(cn_real_dir "$brew_root/opt")" || return 1
  brew_node_modules="$(cn_real_dir "$brew_root/lib/node_modules")" || return 1
  brew_openssl_config="$(cn_real_dir "$brew_root/etc/openssl@3")" || return 1
  [ "$brew_bin" = "$brew_root/bin" ] || return 1
  [ "$brew_cellar" = "$brew_root/Cellar" ] || return 1
  [ "$brew_opt" = "$brew_root/opt" ] || return 1
  [ "$brew_node_modules" = "$brew_root/lib/node_modules" ] || return 1
  [ "$brew_openssl_config" = "$brew_root/etc/openssl@3" ] || return 1
  [ -x "$brew_bin/node" ] && [ -x "$brew_bin/npm" ] || return 1
  [ "$CN_REAL_NPM" = "$brew_bin/npm" ] || return 1
  node_root="$brew_cellar/node@24/24.16.0"
  node_real="$(/bin/realpath "$brew_bin/node")" || return 1
  npm_real="$(/bin/realpath "$CN_REAL_NPM")" || return 1
  cmd_list_real="$(/bin/realpath "$brew_node_modules/npm/lib/utils/cmd-list.js")" || return 1
  [ "$node_real" = "$node_root/bin/node" ] || return 1
  [ "$npm_real" = "$node_root/lib/node_modules/npm/bin/npm-cli.js" ] || return 1
  [ "$cmd_list_real" = "$node_root/lib/node_modules/npm/lib/utils/cmd-list.js" ] || return 1
  [ -x "$node_real" ] && [ -x "$npm_real" ] && [ -r "$cmd_list_real" ] || return 1

  for path in "$repo" "$deps" "$tools_root" "$brew_bin" "$brew_cellar" "$brew_opt" "$brew_node_modules" "$brew_openssl_config"; do
    cn_toml_path_ok "$path" || return 1
  done
}

cn_fixture_child_dir() {
  local fixture="$1" candidate="$2" parent name resolved
  name="${candidate##*/}"
  [ -n "$name" ] && [ "$name" != . ] && [ "$name" != .. ] || return 1
  parent="$(cn_real_dir "${candidate%/*}")" || return 1
  [ "$parent" = "$fixture" ] || return 1
  if cn_path_present "$candidate"; then
    [ -d "$candidate" ] && [ ! -L "$candidate" ] || return 1
    resolved="$(cn_real_dir "$candidate")" || return 1
    [ "$resolved" = "$fixture/$name" ] || return 1
  else
    resolved="$fixture/$name"
  fi
  printf '%s\n' "$resolved"
}

cn_hermetic_fixture_valid() {
  local repo control fixture remote origin code gh code_dir gh_dir home work_root code_home common
  [ "${CN_HERMETIC_FIXTURE:-0}" = 1 ] || return 1
  [ "$CN_GH_REPO" = fixture/repo ] || return 1
  repo="$(cn_real_dir "$CN_REPO")" || return 1
  control="$(cn_real_dir "$CN_CONTROL_REPO")" || return 1
  [ "$repo" = "$control" ] || return 1
  case "$repo" in
    /private/var/folders/*/repo|/var/folders/*/repo|/tmp/*/repo) ;;
    *) return 1 ;;
  esac
  fixture="$(cn_real_dir "${repo%/repo}")" || return 1
  [ -n "${CN_TEST_REMOTE:-}" ] || return 1
  remote="$(cn_real_dir "$CN_TEST_REMOTE")" || return 1
  [ "$remote" = "$fixture/remote.git" ] || return 1
  origin="$(git -C "$repo" remote get-url origin)" || return 1
  origin="$(cn_real_dir "$origin")" || return 1
  [ "$origin" = "$remote" ] || return 1
  code="$CN_CODEX_BIN"; gh="$CN_GH_BIN"
  [ -f "$code" ] && [ ! -L "$code" ] && [ -x "$code" ] || return 1
  [ -f "$gh" ] && [ ! -L "$gh" ] && [ -x "$gh" ] || return 1
  code_dir="$(cn_real_dir "${code%/*}")" || return 1
  gh_dir="$(cn_real_dir "${gh%/*}")" || return 1
  [ "$code_dir/${code##*/}" = "$fixture/codex" ] || return 1
  [ "$gh_dir/${gh##*/}" = "$fixture/gh" ] || return 1
  home="$(cn_fixture_child_dir "$fixture" "$CN_HOME")" || return 1
  work_root="$(cn_fixture_child_dir "$fixture" "$CN_WORK_ROOT")" || return 1
  code_home="$(cn_fixture_child_dir "$fixture" "$CN_CODEX_HOME")" || return 1
  [ "$home" != "$work_root" ] && [ "$home" != "$code_home" ] && [ "$work_root" != "$code_home" ] || return 1
  common="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)" || return 1
  common="$(cn_real_dir "$common")" || return 1
  [ "$common" = "$repo/.git" ] || return 1
}

cn_agent_secret_boundary_valid() {
  cn_hermetic_fixture_valid
}

cn_agent_permissions_arg() {
  local wt runtime access="$3" common home tmp pointer deps_path trusted_deps tools_root
  local brew_bin brew_cellar brew_opt brew_node_modules brew_openssl_config path
  cn_agent_toolchain_valid || return 1
  wt="$(cn_real_dir "$1")" || return 1
  runtime="$(cn_real_dir "$2")" || return 1
  case "$access" in read|write) ;; *) return 1 ;; esac
  common="$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir)" || return 1
  common="$(cn_real_dir "$common")" || return 1
  home="$(cn_real_dir "$runtime/home")" || return 1
  tmp="$(cn_real_dir "$runtime/tmp")" || return 1
  pointer="$wt/.git"
  deps_path="$wt/ui/node_modules"
  trusted_deps="$(cn_real_dir "$CN_TRUSTED_UI_DEPS")" || return 1
  tools_root="$(cn_real_dir "$SELF/agent-bin")" || return 1
  brew_bin="$(cn_real_dir "$CN_BREW_ROOT/bin")" || return 1
  brew_cellar="$(cn_real_dir "$CN_BREW_ROOT/Cellar")" || return 1
  brew_opt="$(cn_real_dir "$CN_BREW_ROOT/opt")" || return 1
  brew_node_modules="$(cn_real_dir "$CN_BREW_ROOT/lib/node_modules")" || return 1
  brew_openssl_config="$(cn_real_dir "$CN_BREW_ROOT/etc/openssl@3")" || return 1
  for path in "$wt" "$runtime" "$common" "$home" "$tmp" "$pointer" "$deps_path" \
    "$trusted_deps" "$tools_root" "$brew_bin" "$brew_cellar" "$brew_opt" "$brew_node_modules" "$brew_openssl_config"; do
    cn_toml_path_ok "$path" || return 1
  done
  printf 'permissions.cn_lane.filesystem={":minimal"="read","%s"="%s","%s"="read","%s"="write","%s"="write","%s"="read","%s"="read","%s"="read","%s"="read","%s"="read","%s"="read","%s"="read","%s"="read","%s"="read","%s"="read"}\n' \
    "$wt" "$access" "$runtime" "$home" "$tmp" "$common" "$pointer" "$deps_path" \
    "$trusted_deps" "$tools_root" "$brew_bin" "$brew_cellar" "$brew_opt" "$brew_node_modules" "$brew_openssl_config"
}

cn_gate_profile_valid() {
  local worktree probe_home probe_tmp deps brew_bin brew_cellar brew_opt brew_node_modules brew_openssl_config
  [ -r "$CN_GATE_PROFILE" ] || return 1
  cn_command_exists "$CN_SANDBOX_BIN" || return 1
  worktree="$(cd "$CN_REPO" && pwd -P)" || return 1
  cn_trusted_deps_match "$worktree" "$CN_TRUSTED_UI_DEPS" || return 1
  probe_home="$worktree"
  probe_tmp="$worktree"
  deps="$(cn_real_dir "$CN_TRUSTED_UI_DEPS")" || return 1
  brew_bin="$(cn_real_dir "$CN_BREW_ROOT/bin")" || return 1
  brew_cellar="$(cn_real_dir "$CN_BREW_ROOT/Cellar")" || return 1
  brew_opt="$(cn_real_dir "$CN_BREW_ROOT/opt")" || return 1
  brew_node_modules="$(cn_real_dir "$CN_BREW_ROOT/lib/node_modules")" || return 1
  brew_openssl_config="$(cn_real_dir "$CN_BREW_ROOT/etc/openssl@3")" || return 1
  [ -d "$CN_PLAYWRIGHT_CACHE" ] || return 1
  "$CN_SANDBOX_BIN" -D "WORKTREE=$worktree" -D "GATE_HOME=$probe_home" \
    -D "TEMP_ROOT=$probe_tmp" -D "GIT_POINTER=$worktree/.git" -D "DEPS_ROOT=$deps" \
    -D "LANE_DEPS=$worktree/ui/node_modules" -D "LANE_UI=$worktree/ui" \
    -D "PLAYWRIGHT_CACHE=$CN_PLAYWRIGHT_CACHE" -D "BREW_BIN=$brew_bin" \
    -D "BREW_CELLAR=$brew_cellar" -D "BREW_OPT=$brew_opt" -D "BREW_NODE_MODULES=$brew_node_modules" \
    -D "BREW_OPENSSL_CONFIG=$brew_openssl_config" \
    -D "TOOLS_ROOT=$SELF/agent-bin" \
    -f "$CN_GATE_PROFILE" /usr/bin/true >/dev/null 2>&1
}

cn_before_mutation() {
  local tree="${1:-}" rc
  if cn_stop_requested "$CN_REPO" "$CN_CONTROL_REPO" "$CN_WORK_ROOT" "$tree"; then
    cn_die "STOP is present; refusing state-changing action"
  else
    rc=$?
  fi
  [ "$rc" -eq 1 ] || cn_die "could not evaluate STOP sources; refusing state-changing action"
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

cn_agent_runtime_path() {
  printf '%s/agent-runtime/%s/worker\n' "$CN_HOME" "$(cn_slug "$1")"
}

cn_prepare_private_subdir() {
  local wt="$1" root="$2" relative="$3" root_real current current_real candidate candidate_real part rest
  [ -d "$root" ] && [ ! -L "$root" ] || return 1
  root_real="$(cn_real_dir "$root")" || return 1
  [ -n "$relative" ] || return 1
  case "$relative" in /*|*'//'*) return 1 ;; esac
  current="$root_real"
  rest="$relative"
  while [ -n "$rest" ]; do
    case "$rest" in
      */*) part="${rest%%/*}"; rest="${rest#*/}" ;;
      *) part="$rest"; rest="" ;;
    esac
    case "$part" in ''|.|..) return 1 ;; esac
    current_real="$(cn_real_dir "$current")" || return 1
    candidate="$current/$part"
    if cn_path_present "$candidate"; then
      [ -d "$candidate" ] && [ ! -L "$candidate" ] || return 1
    else
      cn_before_mutation "$wt"
      mkdir "$candidate" || return 1
    fi
    candidate_real="$(cn_real_dir "$candidate")" || return 1
    [ "$candidate_real" = "$current_real/$part" ] || return 1
    current="$candidate_real"
  done
  printf '%s\n' "$current"
}

cn_prepare_agent_runtime() {
  local wt="$1" runtime="$2" runtime_real child child_real relative home_real
  home_real="$(cn_real_dir "$CN_HOME")" || cn_die "CN_HOME is not a real directory"
  case "$runtime" in
    "$CN_HOME"/agent-runtime/*) relative="${runtime#"$CN_HOME"/}" ;;
    "$home_real"/agent-runtime/*) relative="${runtime#"$home_real"/}" ;;
    *) cn_die "agent runtime root escapes CN_HOME" ;;
  esac
  runtime_real="$(cn_prepare_private_subdir "$wt" "$CN_HOME" "$relative")" \
    || cn_die "agent runtime root or ancestor is not a real private directory"
  for child in home tmp; do
    child_real="$(cn_prepare_private_subdir "$wt" "$CN_HOME" "$relative/$child")" \
      || cn_die "agent runtime $child is not a real directory"
    [ "$child_real" = "$runtime_real/$child" ] || cn_die "agent runtime $child escapes its root"
  done
  cn_before_mutation "$wt"
  chmod 700 "$runtime" "$runtime/home" "$runtime/tmp"
}

cn_purge_ignored() {
  local wt="$1"
  cn_before_mutation "$wt"
  git -C "$wt" clean -ffdX >/dev/null
}

cn_purge_all_untracked() {
  local wt="$1"
  cn_before_mutation "$wt"
  git -C "$wt" clean -ffdx >/dev/null
  cn_no_ignored_state "$wt" || cn_die "ignored worktree state survived deterministic cleanup"
}

cn_bind_trusted_ui_deps() {
  local wt="$1" deps real_deps entry name
  cn_trusted_deps_match "$wt" "$CN_TRUSTED_UI_DEPS" || return 1
  deps="$wt/ui/node_modules"
  cn_before_mutation "$wt"
  ! cn_path_present "$deps" || return 1
  real_deps="$(cn_real_dir "$CN_TRUSTED_UI_DEPS")" || return 1
  cn_before_mutation "$wt"
  mkdir "$deps"
  for entry in "$real_deps"/* "$real_deps"/.[!.]* "$real_deps"/..?*; do
    cn_path_present "$entry" || continue
    name="${entry##*/}"
    case "$name" in .vite|.cache|.mosh-deps-stamp) continue ;; esac
    cn_before_mutation "$wt"
    ln -s "$entry" "$deps/$name"
  done
  cn_before_mutation "$wt"
  cp "$real_deps/.mosh-deps-stamp" "$deps/.mosh-deps-stamp"
  [ -f "$deps/.mosh-deps-stamp" ] && [ ! -L "$deps/.mosh-deps-stamp" ]
}

cn_assert_git_binding() {
  local wt="$1" expected="$2" actual
  actual="$(cn_git_binding "$wt")" || return 1
  [ "$actual" = "$expected" ]
}

cn_fresh_review_runtime() {
  local lane="$1" wt="$2" parent runtime relative
  relative="agent-runtime/$(cn_slug "$lane")/review"
  parent="$(cn_prepare_private_subdir "$wt" "$CN_HOME" "$relative")" \
    || cn_die "$lane review runtime root or ancestor is invalid"
  cn_before_mutation "$wt"
  chmod 700 "$parent"
  cn_before_mutation "$wt"
  runtime="$(mktemp -d "$parent/session.XXXXXX")"
  cn_prepare_agent_runtime "$wt" "$runtime"
  printf '%s\n' "$runtime"
}

cn_branch() {
  printf 'codex/stranger-%s\n' "$(cn_slug "$1")"
}

cn_check() {
  local ok=true stopped armed base_ok backlog_ok schemas_ok=true gate_profile_ok agent_toolchain_profile_ok agent_secret_boundary_ok gate_execution_enabled dep stop_report
  for dep in git jq lsof rg "$CN_CODEX_BIN" "$CN_GH_BIN" "$CN_SANDBOX_BIN"; do
    cn_command_exists "$dep" || ok=false
  done
  if git -C "$CN_REPO" rev-parse --verify "$CN_BASE_REF^{commit}" >/dev/null 2>&1; then base_ok=true; else base_ok=false; fi
  if [ -r "$CN_BACKLOG" ]; then backlog_ok=true; else backlog_ok=false; fi
  if cn_gate_profile_valid; then gate_profile_ok=true; else gate_profile_ok=false; fi
  if cn_agent_toolchain_valid; then agent_toolchain_profile_ok=true; else agent_toolchain_profile_ok=false; fi
  if cn_agent_secret_boundary_valid; then agent_secret_boundary_ok=true; else agent_secret_boundary_ok=false; fi
  if [ "${CN_ENABLE_EXPERIMENTAL_SEATBELT_GATE:-0}" = 1 ]; then gate_execution_enabled=true; else gate_execution_enabled=false; fi
  for schema in "$CN_SCHEMAS"/*.json; do jq -e . "$schema" >/dev/null || schemas_ok=false; done
  stop_report="$(cn_stop_sources_json "$CN_REPO" "$CN_CONTROL_REPO" "$CN_WORK_ROOT")"
  stopped="$(jq -r '.stop_sources | [.[]] | any' <<<"$stop_report")"
  armed="$(cn_bool cn_require_armed)"
  jq -nc --argjson ok "$ok" --argjson armed "$armed" --argjson stopped "$stopped" \
    --argjson base_ok "$base_ok" --argjson backlog_ok "$backlog_ok" \
    --argjson schemas_ok "$schemas_ok" --argjson gate_profile_ok "$gate_profile_ok" \
    --argjson agent_toolchain_profile_ok "$agent_toolchain_profile_ok" \
    --argjson agent_secret_boundary_ok "$agent_secret_boundary_ok" \
    --argjson gate_execution_enabled "$gate_execution_enabled" --arg base_ref "$CN_BASE_REF" \
    --arg pr_base "$CN_PR_BASE" --arg model "$CN_MODEL" --arg control_repo "$CN_CONTROL_REPO" \
    --argjson stop_report "$stop_report" \
    '{ok:($ok and $base_ok and $backlog_ok and $schemas_ok and $gate_profile_ok and $agent_toolchain_profile_ok and $agent_secret_boundary_ok),armed:$armed,stopped:$stopped,base_ref:$base_ref,pr_base:$pr_base,model:$model,control_repo:$control_repo,stop_sources:$stop_report.stop_sources,lane_stop_sources:$stop_report.lane_stop_sources,checks:{base_ref:$base_ok,backlog:$backlog_ok,schemas:$schemas_ok,gate_profile:$gate_profile_ok,agent_toolchain_profile:$agent_toolchain_profile_ok,agent_secret_boundary:$agent_secret_boundary_ok,gate_execution_enabled:$gate_execution_enabled}}'
  [ "$ok" = true ] && [ "$base_ok" = true ] && [ "$backlog_ok" = true ] && [ "$schemas_ok" = true ] && \
    [ "$gate_profile_ok" = true ] && [ "$agent_toolchain_profile_ok" = true ] && [ "$agent_secret_boundary_ok" = true ]
}

cn_status() {
  local armed stopped files="[]" stop_report agent_toolchain_profile_ok agent_secret_boundary_ok
  armed="$(cn_bool cn_require_armed)"
  stop_report="$(cn_stop_sources_json "$CN_REPO" "$CN_CONTROL_REPO" "$CN_WORK_ROOT")"
  stopped="$(jq -r '.stop_sources | [.[]] | any' <<<"$stop_report")"
  if cn_agent_toolchain_valid; then agent_toolchain_profile_ok=true; else agent_toolchain_profile_ok=false; fi
  if cn_agent_secret_boundary_valid; then agent_secret_boundary_ok=true; else agent_secret_boundary_ok=false; fi
  if [ -d "$CN_HOME/state" ]; then
    files="$(for f in "$CN_HOME/state"/*.json; do [ -f "$f" ] && jq -c . "$f" 2>/dev/null || true; done | jq -sc '.')"
  fi
  jq -nc --argjson armed "$armed" --argjson stopped "$stopped" --argjson lanes "$files" \
    --arg base_ref "$CN_BASE_REF" --arg control_repo "$CN_CONTROL_REPO" --argjson stop_report "$stop_report" \
    --argjson agent_toolchain_profile_ok "$agent_toolchain_profile_ok" \
    --argjson agent_secret_boundary_ok "$agent_secret_boundary_ok" \
    '{armed:$armed,stopped:$stopped,base_ref:$base_ref,control_repo:$control_repo,stop_sources:$stop_report.stop_sources,lane_stop_sources:$stop_report.lane_stop_sources,checks:{agent_toolchain_profile:$agent_toolchain_profile_ok,agent_secret_boundary:$agent_secret_boundary_ok},lanes:$lanes}'
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
  local phase="$1" access="$2" wt="$3" prompt="$4" out="$5" events="$6" err="$7" runtime="$8" permissions
  permissions="$(cn_agent_permissions_arg "$wt" "$runtime" "$access")" \
    || cn_die "$phase could not build a restricted Codex permission profile"
  /usr/bin/env -i \
    CODEX_HOME="$CN_CODEX_HOME" HOME="$runtime/home" TMPDIR="$runtime/tmp" \
    PATH="$CN_AGENT_PATH" LANG="${LANG:-C}" "$CN_CODEX_BIN" exec --ignore-user-config --ignore-rules --json --color never \
    --output-schema "$CN_SCHEMAS/$phase.json" -o "$out" \
    -m "$CN_MODEL" -c "model_reasoning_effort=\"$CN_REASONING\"" \
    -c 'approval_policy="never"' -c 'shell_environment_policy.inherit="core"' \
    -c 'shell_environment_policy.ignore_default_excludes=false' -c "$permissions" \
    -c 'permissions.cn_lane.network.enabled=false' -c 'default_permissions="cn_lane"' \
    -C "$wt" "$prompt" >"$events" 2>"$err"
}

cn_exec_resume() {
  local phase="$1" session="$2" prompt="$3" out="$4" events="$5" err="$6" wt="$7" runtime="$8" permissions
  permissions="$(cn_agent_permissions_arg "$wt" "$runtime" write)" \
    || cn_die "$phase could not build a restricted Codex permission profile"
  /usr/bin/env -i \
    CODEX_HOME="$CN_CODEX_HOME" HOME="$runtime/home" TMPDIR="$runtime/tmp" \
    PATH="$CN_AGENT_PATH" LANG="${LANG:-C}" "$CN_CODEX_BIN" exec resume --ignore-user-config --ignore-rules --json \
    --output-schema "$CN_SCHEMAS/$phase.json" -o "$out" \
    -m "$CN_MODEL" -c "model_reasoning_effort=\"$CN_REASONING\"" \
    -c 'approval_policy="never"' -c 'shell_environment_policy.inherit="core"' \
    -c 'shell_environment_policy.ignore_default_excludes=false' -c "$permissions" \
    -c 'permissions.cn_lane.network.enabled=false' -c 'default_permissions="cn_lane"' \
    "$session" "$prompt" >"$events" 2>"$err"
}

cn_thread_from_events() {
  jq -r 'select(.type == "thread.started") | .thread_id // .thread.id // .id // empty' "$1" | head -1
}

cn_write_state() {
  local wt="$1" file="$2" lane="$3" base="$4" head="$5" phase="$6" thread="$7" binding
  binding="$(cn_git_binding "$wt")" || cn_die "$lane worktree Git binding is invalid while writing state"
  cn_before_mutation "$wt"
  cn_state_write "$file" "$lane" "$base" "$head" "$phase" "$thread" "$binding"
}

cn_prepare_lane() {
  local lane="$1" wt="$2" branch="$3" base="$4" state="$5"
  local duplicate
  [ ! -e "$wt" ] || cn_die "$lane worktree already exists; use resume $lane"
  ! git -C "$CN_REPO" show-ref --verify --quiet "refs/heads/$branch" || cn_die "$branch already exists; use resume $lane"
  duplicate="$("$CN_GH_BIN" pr list --state open --limit 200 --json title,headRefName --repo "$CN_GH_REPO" 2>/dev/null \
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
  local lane="$1" lane_json="$2" wt="$3" base="$4" state="$5" logs="$6" runtime="$7"
  local prompt out events err thread result route planned gap outcome binding
  prompt="$(cn_plan_prompt "$lane" "$lane_json")"
  out="$logs/plan.result.json"; events="$logs/plan.events.jsonl"; err="$logs/plan.stderr.log"
  cn_purge_ignored "$wt"
  if ! cn_bind_trusted_ui_deps "$wt"; then
    cn_write_state "$wt" "$state" "$lane" "$base" "$base" needs-human ""
    cn_die "$lane cannot bind owner-trusted UI dependencies matching its lockfile"
  fi
  binding="$(cn_git_binding "$wt")" || cn_die "$lane worktree Git binding is invalid before planning"
  cn_before_mutation "$wt"
  cn_exec_start plan write "$wt" "$prompt" "$out" "$events" "$err" "$runtime" || cn_die "$lane planning session failed; see $err"
  thread="$(cn_thread_from_events "$events")"
  [ -n "$thread" ] || cn_die "$lane planning session emitted no thread.started id"
  result="$(cn_schema_result plan "$out" "$lane")" || cn_die "$lane returned invalid planning JSON"
  cn_assert_git_binding "$wt" "$binding" || cn_die "$lane agent changed its Git binding during planning"
  cn_assert_no_agent_commit "$wt" "$base" || cn_die "$lane agent created a commit during planning"
  cn_assert_plan_only "$wt" "$lane" || cn_die "$lane planning changed files outside its lane plan: $(cn_changed_paths "$wt" | tr '\n' ' ')"
  route="$(jq -r .route <<<"$result")"
  [ "$route" != never ] || { cn_write_state "$wt" "$state" "$lane" "$base" "$base" needs-human "$thread"; cn_die "$lane plan requires a never-touch path"; }
  planned="$(jq -r .planned <<<"$result")"
  gap="$(jq -r .gap_exists <<<"$result")"
  outcome="$(cn_plan_outcome "$planned" "$gap")" || {
    cn_write_state "$wt" "$state" "$lane" "$base" "$base" needs-human "$thread"
    cn_die "$lane plan returned an invalid execution outcome"
  }
  case "$outcome" in
    proceed)
      cn_write_state "$wt" "$state" "$lane" "$base" "$base" planned "$thread"
      ;;
    gap-closed)
      cn_write_state "$wt" "$state" "$lane" "$base" "$base" needs-human "$thread"
      cn_die "$lane gap is already closed; refusing implementation or publication"
      ;;
    needs-human)
      cn_write_state "$wt" "$state" "$lane" "$base" "$base" needs-human "$thread"
      cn_die "$lane planning did not produce an executable lane plan"
      ;;
    *)
      cn_write_state "$wt" "$state" "$lane" "$base" "$base" needs-human "$thread"
      cn_die "$lane plan returned an unknown execution outcome"
      ;;
  esac
}

cn_implement_phase() {
  local lane="$1" lane_json="$2" wt="$3" base="$4" state="$5" logs="$6" thread="$7" runtime="$8"
  local prompt out events err result ready blockers binding
  prompt="$(cn_implement_prompt "$lane" "$lane_json")"
  out="$logs/implement.result.json"; events="$logs/implement.events.jsonl"; err="$logs/implement.stderr.log"
  cn_purge_ignored "$wt"
  if ! cn_bind_trusted_ui_deps "$wt"; then
    cn_write_state "$wt" "$state" "$lane" "$base" "$base" needs-human "$thread"
    cn_die "$lane cannot bind owner-trusted UI dependencies matching its lockfile"
  fi
  binding="$(cn_git_binding "$wt")" || cn_die "$lane worktree Git binding is invalid before implementation"
  cn_before_mutation "$wt"
  cn_exec_resume implement "$thread" "$prompt" "$out" "$events" "$err" "$wt" "$runtime" || cn_die "$lane implementation session failed; see $err"
  result="$(cn_schema_result implement "$out" "$lane")" || cn_die "$lane returned invalid implementation JSON"
  cn_assert_git_binding "$wt" "$binding" || cn_die "$lane agent changed its Git binding during implementation"
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
  local changed route title head path staged_paths
  changed="$(cn_changed_paths "$wt")"
  [ -n "$changed" ] || cn_die "$lane produced an empty diff"
  route="$(printf '%s\n' "$changed" | "$SELF/route-paths.sh")"
  [ "$route" != never ] || { cn_write_state "$wt" "$state" "$lane" "$base" "$base" needs-human "$thread"; cn_die "$lane touched a never path"; }
  if cn_diff_has_cmake_pin "$wt"; then
    cn_write_state "$wt" "$state" "$lane" "$base" "$base" needs-human "$thread"
    cn_die "$lane introduced or changed a CMake dependency pin"
  fi
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
  local classification class gate_result gate_parent gate_home gate_home_real gate_tmp gate_wt auto_home changed gate_exec
  local deps_real brew_bin brew_cellar brew_opt brew_node_modules brew_openssl_config gate_rc
  classification="$("$CN_CLASSIFY" "$base" "$wt")" || cn_die "$lane classifier failed"
  class="$(jq -er .class <<<"$classification")" || cn_die "$lane classifier returned invalid JSON"
  changed="$(git -C "$wt" diff --name-only "$base...$head")"
  if ! cn_gate_sandbox_supported "$class" "$changed"; then
    cn_write_state "$wt" "$state" "$lane" "$base" "$head" needs-human "$thread"
    cn_die "$lane requires a gate isolation backend that is not production-enabled for these paths"
  fi
  if lsof -nP -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1; then
    cn_write_state "$wt" "$state" "$lane" "$base" "$head" needs-human "$thread"
    cn_die "$lane cannot reserve Playwright loopback port 5173"
  fi
  if [ "$class" = native ] && [ -z "${MOSH_SELFTEST_BASELINE:-}" ]; then
    cn_die "$lane is native but MOSH_SELFTEST_BASELINE is unset"
  fi
  cn_purge_all_untracked "$wt"
  if ! cn_bind_trusted_ui_deps "$wt"; then
    cn_write_state "$wt" "$state" "$lane" "$base" "$head" needs-human "$thread"
    cn_die "$lane cannot bind owner-trusted UI dependencies matching its lockfile"
  fi
  gate_parent="$CN_HOME/gate-home/$(cn_slug "$lane")"
  cn_before_mutation "$wt"
  mkdir -p "$gate_parent"
  cn_before_mutation "$wt"
  chmod 700 "$gate_parent"
  cn_before_mutation "$wt"
  gate_home="$(mktemp -d "$gate_parent/session.XXXXXX")"
  cn_before_mutation "$wt"
  mkdir "$gate_home/tmp"
  cn_before_mutation "$wt"
  chmod 700 "$gate_home" "$gate_home/tmp"
  gate_tmp="$(cn_real_dir "$gate_home/tmp")" || cn_die "$lane cannot resolve private gate TMPDIR"
  gate_wt="$(cn_real_dir "$wt")" || cn_die "$lane cannot resolve worktree for sandboxed gate"
  gate_exec="$gate_wt/scripts/auto-loop/gate.sh"
  [ -x "$gate_exec" ] && cmp -s "$CN_GATE" "$gate_exec" \
    || cn_die "$lane worktree gate differs from the configured authoritative gate"
  gate_home_real="$(cn_real_dir "$gate_home")" || cn_die "$lane cannot resolve private gate home"
  auto_home="$gate_home_real/auto-loop"
  cn_before_mutation "$wt"
  mkdir "$auto_home"
  deps_real="$(cn_real_dir "$CN_TRUSTED_UI_DEPS")" || cn_die "$lane cannot resolve trusted UI dependencies"
  brew_bin="$(cn_real_dir "$CN_BREW_ROOT/bin")" || cn_die "$lane cannot resolve Homebrew bin"
  brew_cellar="$(cn_real_dir "$CN_BREW_ROOT/Cellar")" || cn_die "$lane cannot resolve Homebrew Cellar"
  brew_opt="$(cn_real_dir "$CN_BREW_ROOT/opt")" || cn_die "$lane cannot resolve Homebrew opt"
  brew_node_modules="$(cn_real_dir "$CN_BREW_ROOT/lib/node_modules")" || cn_die "$lane cannot resolve Homebrew Node modules"
  brew_openssl_config="$(cn_real_dir "$CN_BREW_ROOT/etc/openssl@3")" || cn_die "$lane cannot resolve Homebrew OpenSSL configuration"
  [ -d "$CN_PLAYWRIGHT_CACHE" ] || cn_die "$lane Playwright browser cache is unavailable"
  cn_worktree_clean "$wt" || cn_die "$lane worktree is dirty before the authoritative gate"
  cn_before_mutation "$wt"
  gate_result="$logs/gate.json"
  set +e
  ( cd "$gate_wt" && env -i PATH="$CN_GATE_PATH" HOME="$gate_home_real" TMPDIR="$gate_tmp" CI=1 \
      LANG="${LANG:-C}" MOSH_AUTOLOOP_HOME="$auto_home" \
      MOSH_SELFTEST_BASELINE="${MOSH_SELFTEST_BASELINE:-}" \
      PLAYWRIGHT_BROWSERS_PATH="$CN_PLAYWRIGHT_CACHE" CN_REAL_NPM="$CN_REAL_NPM" \
      "$CN_SANDBOX_BIN" -D "WORKTREE=$gate_wt" -D "GATE_HOME=$gate_home_real" \
      -D "TEMP_ROOT=$gate_tmp" -D "GIT_POINTER=$gate_wt/.git" -D "DEPS_ROOT=$deps_real" \
      -D "LANE_DEPS=$gate_wt/ui/node_modules" -D "LANE_UI=$gate_wt/ui" \
      -D "PLAYWRIGHT_CACHE=$CN_PLAYWRIGHT_CACHE" -D "BREW_BIN=$brew_bin" \
      -D "BREW_CELLAR=$brew_cellar" -D "BREW_OPT=$brew_opt" -D "BREW_NODE_MODULES=$brew_node_modules" \
      -D "BREW_OPENSSL_CONFIG=$brew_openssl_config" \
      -D "TOOLS_ROOT=$SELF/agent-bin" \
      -f "$CN_GATE_PROFILE" "$gate_exec" "$class" "$wt" "$base" ) >"$gate_result"
  gate_rc=$?
  set -e
  cn_purge_all_untracked "$wt"
  if [ "$gate_rc" -ne 0 ]; then
    cn_write_state "$wt" "$state" "$lane" "$base" "$head" needs-human "$thread"
    cn_die "$lane authoritative gate exited nonzero; see $gate_result"
  fi
  cn_validate_gate_result "$gate_result" "$class" || cn_die "$lane authoritative gate returned an invalid verdict; see $gate_result"
  [ "$(git -C "$wt" rev-parse HEAD)" = "$head" ] || cn_die "$lane HEAD changed during the gate"
  cn_worktree_clean "$wt" || cn_die "$lane authoritative gate modified tracked or untracked files"
  cn_write_state "$wt" "$state" "$lane" "$base" "$head" gated "$thread"
}

cn_review_phase() {
  local lane="$1" wt="$2" base="$3" route="$4" state="$5" logs="$6" thread="$7" head="$8"
  local prompt out events err result runtime binding
  prompt="$(cn_review_prompt "$lane" "$base" "$route")"
  out="$logs/review.result.json"; events="$logs/review.events.jsonl"; err="$logs/review.stderr.log"
  [ "$(git -C "$wt" rev-parse HEAD)" = "$head" ] || cn_die "$lane HEAD changed before review"
  cn_worktree_clean "$wt" || cn_die "$lane worktree is dirty before hostile review"
  cn_no_ignored_state "$wt" || cn_die "$lane has ignored state before hostile review"
  binding="$(cn_git_binding "$wt")" || cn_die "$lane worktree Git binding is invalid before review"
  runtime="$(cn_fresh_review_runtime "$lane" "$wt")" || cn_die "$lane could not create a fresh hostile-review runtime"
  cn_before_mutation "$wt"
  cn_exec_start review read "$wt" "$prompt" "$out" "$events" "$err" "$runtime" || cn_die "$lane hostile review session failed; see $err"
  result="$(cn_schema_result review "$out")" || cn_die "$lane returned invalid review JSON"
  cn_assert_git_binding "$wt" "$binding" || cn_die "$lane reviewer changed its Git binding"
  [ "$(git -C "$wt" rev-parse HEAD)" = "$head" ] || cn_die "$lane HEAD changed during review"
  cn_worktree_clean "$wt" || cn_die "$lane hostile review modified the worktree"
  if [ "$(jq -r .verdict <<<"$result")" != APPROVE ] || [ "$(jq -r .blockers <<<"$result")" -ne 0 ]; then
    cn_write_state "$wt" "$state" "$lane" "$base" "$head" needs-human "$thread"
    cn_die "$lane hostile review rejected the change"
  fi
  cn_write_state "$wt" "$state" "$lane" "$base" "$head" reviewed "$thread"
}

cn_ensure_label() {
  local wt="$1" name="$2" color="$3"
  if "$CN_GH_BIN" label list --limit 500 --json name \
      --repo "$CN_GH_REPO" \
      | jq -e --arg name "$name" 'map(.name) | index($name) != null' >/dev/null 2>&1; then
    return 0
  fi
  cn_before_mutation "$wt"
  "$CN_GH_BIN" label create "$name" --color "$color" --repo "$CN_GH_REPO" >/dev/null
}

cn_remote_base_matches() {
  local wt="$1" base="$2" remote
  remote="$(git -C "$wt" ls-remote origin "refs/heads/$CN_PR_BASE" | awk '{print $1}')"
  [ "$remote" = "$base" ]
}

cn_verify_published_pr() {
  local wt="$1" pr_url="$2" branch="$3" head="$4" base="$5" remote meta
  cn_remote_base_matches "$wt" "$base" || return 1
  remote="$(git -C "$wt" ls-remote origin "refs/heads/$branch" | awk '{print $1}')"
  cn_remote_head_matches "$head" "$remote" || return 1
  meta="$("$CN_GH_BIN" pr view "$pr_url" --repo "$CN_GH_REPO" \
    --json isDraft,state,baseRefName,baseRefOid,headRefName,headRefOid,url)" || return 1
  jq -e --arg base_name "$CN_PR_BASE" --arg base "$base" --arg branch "$branch" --arg head "$head" \
    '.isDraft == true and .state == "OPEN" and .baseRefName == $base_name and .baseRefOid == $base and .headRefName == $branch and .headRefOid == $head' \
    <<<"$meta" >/dev/null
}

cn_publish_phase() {
  local lane="$1" lane_json="$2" wt="$3" base="$4" route="$5" branch="$6" state="$7" logs="$8" thread="$9" head="${10}"
  local remote body pr_url program_label existing_pr classification class review binding changed
  [ "$(git -C "$wt" rev-parse HEAD)" = "$head" ] || cn_die "$lane HEAD changed before publication"
  cn_worktree_clean "$wt" || cn_die "$lane worktree is dirty before publication"
  cn_no_ignored_state "$wt" || cn_die "$lane has ignored state before publication"
  binding="$(cn_git_binding "$wt")" || cn_die "$lane worktree Git binding is invalid before publication"
  cn_state_validate "$state" "$base" "$head" "$binding" \
    || cn_die "$lane persisted SHA or Git binding is stale before publication"
  classification="$("$CN_CLASSIFY" "$base" "$wt")" || cn_die "$lane classifier failed before publication"
  class="$(jq -er .class <<<"$classification")" || cn_die "$lane classifier returned invalid JSON before publication"
  changed="$(git -C "$wt" diff --name-only "$base...$head")"
  cn_gate_sandbox_supported "$class" "$changed" \
    || cn_die "$lane gate isolation is no longer enabled for publication"
  cn_validate_gate_result "$logs/gate.json" "$class" \
    || cn_die "$lane gate evidence is missing or invalid before publication"
  review="$(cn_schema_result review "$logs/review.result.json")" \
    || cn_die "$lane hostile-review evidence is missing or invalid before publication"
  [ "$(jq -r .verdict <<<"$review")" = APPROVE ] && [ "$(jq -r .blockers <<<"$review")" -eq 0 ] \
    || cn_die "$lane hostile-review evidence rejects publication"
  if ! cn_remote_base_matches "$wt" "$base"; then
    cn_write_state "$wt" "$state" "$lane" "$base" "$head" needs-human "$thread"
    cn_die "$lane remote PR base differs from the gated base SHA"
  fi
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
    printf -- '- Authoritative gate: `%s`\n' "$(jq -c '{pass,class}' "$logs/gate.json")"
    printf -- '- Hostile review: `%s`\n\n' "$(jq -c '{verdict,blockers}' "$logs/review.result.json")"
    printf 'The deterministic supervisor, not the agent, committed and pushed this exact SHA. This draft requires owner action.\n'
  } >"$body"
  program_label="program:$(jq -r '.lane // "X"' <<<"$lane_json")"
  cn_ensure_label "$wt" "$program_label" 5319E7
  cn_ensure_label "$wt" "codex-route:$route" D4C5F9
  if [ "$route" = owner ]; then
    cn_ensure_label "$wt" needs-owner-merge B60205
  fi
  if ! cn_remote_base_matches "$wt" "$base"; then
    cn_write_state "$wt" "$state" "$lane" "$base" "$head" needs-human "$thread"
    cn_die "$lane remote PR base advanced after the gated head was pushed"
  fi
  existing_pr="$("$CN_GH_BIN" pr list --state open --head "$branch" --base "$CN_PR_BASE" --json url --jq '.[0].url // empty' --repo "$CN_GH_REPO")" \
    || cn_die "$lane could not check for an already-created PR"
  if [ -n "$existing_pr" ]; then
    if ! cn_verify_published_pr "$wt" "$existing_pr" "$branch" "$head" "$base"; then
      cn_write_state "$wt" "$state" "$lane" "$base" "$head" needs-human "$thread"
      cn_die "$lane existing draft PR does not match the exact gated head/base"
    fi
    cn_write_state "$wt" "$state" "$lane" "$base" "$head" pr-opened "$thread"
    printf '%s %s\n' "$lane" "$existing_pr"
    return 0
  fi
  remote="$(git -C "$wt" ls-remote origin "refs/heads/$branch" | awk '{print $1}')"
  cn_remote_head_matches "$head" "$remote" \
    || cn_die "$lane remote head advanced before draft creation"
  if ! cn_remote_base_matches "$wt" "$base"; then
    cn_write_state "$wt" "$state" "$lane" "$base" "$head" needs-human "$thread"
    cn_die "$lane remote PR base advanced before draft creation"
  fi
  cn_before_mutation "$wt"
  if [ "$route" = owner ]; then
    pr_url="$("$CN_GH_BIN" pr create --draft --base "$CN_PR_BASE" --head "$branch" --title "$lane: $(jq -r .title <<<"$lane_json")" --body-file "$body" --label "$program_label" --label "codex-route:$route" --label needs-owner-merge --repo "$CN_GH_REPO")"
  else
    pr_url="$("$CN_GH_BIN" pr create --draft --base "$CN_PR_BASE" --head "$branch" --title "$lane: $(jq -r .title <<<"$lane_json")" --body-file "$body" --label "$program_label" --label "codex-route:$route" --repo "$CN_GH_REPO")"
  fi
  if ! cn_verify_published_pr "$wt" "$pr_url" "$branch" "$head" "$base"; then
    cn_before_mutation "$wt"
    if ! "$CN_GH_BIN" pr close "$pr_url" --comment \
      "Codex-native supervisor closed this draft because its published head/base did not match the exact gated SHA." \
      --repo "$CN_GH_REPO" >/dev/null 2>&1; then
      cn_write_state "$wt" "$state" "$lane" "$base" "$head" needs-human "$thread"
      cn_die "$lane created a mismatched draft PR and could not close it; owner cleanup is required"
    fi
    cn_write_state "$wt" "$state" "$lane" "$base" "$head" needs-human "$thread"
    cn_die "$lane created draft PR did not match the gated head/base and was closed"
  fi
  cn_write_state "$wt" "$state" "$lane" "$base" "$head" pr-opened "$thread"
  printf '%s %s\n' "$lane" "$pr_url"
}

cn_run_lane() {
  local lane="$1" resume_mode="${2:-false}" lane_json slug wt branch state logs runtime base phase thread result route head changed_paths binding
  lane_json="$(cn_lane_json "$lane")"
  [ -n "$lane_json" ] || cn_die "unknown lane: $lane"
  slug="$(cn_slug "$lane")"; wt="$(cn_worktree_path "$lane")"; branch="$(cn_branch "$lane")"
  state="$(cn_state_path "$lane")"; logs="$(cn_log_dir "$lane")"; runtime="$(cn_agent_runtime_path "$lane")"
  if [ "$resume_mode" = true ]; then
    [ -f "$state" ] || cn_die "$lane has no resumable state"
    [ -d "$wt/.git" ] || [ -f "$wt/.git" ] || cn_die "$lane worktree is missing"
    base="$(cn_state_field "$state" base_sha)"; head="$(cn_state_field "$state" head_sha)"
    [ "$base" = "$(git -C "$CN_REPO" rev-parse "$CN_BASE_REF^{commit}")" ] || cn_die "$lane base SHA is stale relative to $CN_BASE_REF"
    [ "$(git -C "$wt" symbolic-ref --short HEAD)" = "$branch" ] || cn_die "$lane worktree is on an unexpected branch"
    binding="$(cn_git_binding "$wt")" || cn_die "$lane worktree Git binding is invalid while resuming"
    cn_state_validate "$state" "$base" "$(git -C "$wt" rev-parse HEAD)" "$binding" || cn_die "$lane state is stale relative to its worktree"
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
  cn_prepare_agent_runtime "$wt" "$runtime"

  if [ "$phase" = initialized ]; then
    cn_plan_phase "$lane" "$lane_json" "$wt" "$base" "$state" "$logs" "$runtime"
    phase=planned; thread="$(cn_state_field "$state" thread_id)"
  fi
  if [ "$phase" = planned ]; then
    cn_implement_phase "$lane" "$lane_json" "$wt" "$base" "$state" "$logs" "$thread" "$runtime"
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
  route="$(cn_effective_route "$route" "$lane_json")" || cn_die "$lane has invalid owner-routing metadata"
  if [ "$route" = never ]; then
    cn_write_state "$wt" "$state" "$lane" "$base" "$head" needs-human "$thread"
    cn_die "$lane currently routes to a never-touch path"
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
  cn_home_is_external "$CN_REPO" && cn_home_is_external "$CN_CONTROL_REPO" \
    || cn_die "CN_HOME must resolve outside the runner and canonical control checkouts"
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
  cn_before_mutation
  cn_agent_secret_boundary_valid \
    || cn_die "agent secret boundary is unavailable; real Codex execution requires a separately isolated agent backend"
  cn_acquire_lock
  cn_worktree_clean "$CN_REPO" || cn_die "runner checkout is dirty or unreadable; use a dedicated clean worktree"
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
  cn_home_is_external "$CN_REPO" && cn_home_is_external "$CN_CONTROL_REPO" \
    || cn_die "CN_HOME must resolve outside the runner and canonical control checkouts"
  cn_before_mutation
  cn_agent_secret_boundary_valid \
    || cn_die "agent secret boundary is unavailable; real Codex execution requires a separately isolated agent backend"
  cn_acquire_lock
  cn_worktree_clean "$CN_REPO" || cn_die "runner checkout is dirty or unreadable; use a dedicated clean worktree"
  case "$CN_BASE_REF" in
    origin/*)
      cn_before_mutation
      git -C "$CN_REPO" fetch --no-tags origin "${CN_BASE_REF#origin/}:refs/remotes/$CN_BASE_REF"
      ;;
  esac
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
