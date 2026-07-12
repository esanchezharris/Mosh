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

cn_stop_requested() {
  local repo="$1"
  [ -e "$CN_HOME/STOP" ] ||
    [ -e "$repo/docs/auto-loop/STOP" ] ||
    [ -e "$repo/docs/first-stranger-program/STOP" ]
}

cn_state_write() {
  local file="$1" lane="$2" base="$3" head="$4" phase="$5" thread_id="$6"
  local dir tmp
  dir="$(dirname "$file")"
  mkdir -p "$dir"
  chmod 700 "$CN_HOME" "$dir" 2>/dev/null || true
  tmp="$(mktemp "$dir/.state.XXXXXX")"
  jq -nc \
    --arg lane "$lane" --arg base "$base" --arg head "$head" \
    --arg phase "$phase" --arg thread "$thread_id" \
    '{lane:$lane,base_sha:$base,head_sha:$head,phase:$phase,thread_id:$thread}' >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

cn_state_validate() {
  local file="$1" base="$2" head="$3"
  [ -f "$file" ] || return 1
  jq -e --arg base "$base" --arg head "$head" \
    '.base_sha == $base and .head_sha == $head' "$file" >/dev/null
}

cn_state_field() {
  local file="$1" field="$2"
  jq -er --arg field "$field" '.[$field]' "$file"
}

cn_remote_head_matches() {
  [ "$1" = "$2" ]
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
