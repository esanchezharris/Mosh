#!/usr/bin/env bash

mosh_reset_owned_harness_session() {
  local session="${1:-}"
  local app_data="${MOSH_APP_DATA_DIR:-$HOME/Library/Mosh}"
  local relative marker expected marker_size quarantine
  expected='Mosh isolated harness session v1'

  case "$session" in
    _harness/*) relative="${session#_harness/}" ;;
    *) printf 'refusing non-harness session reset: %s\n' "$session" >&2; return 2 ;;
  esac
  case "/$relative/" in
    *//*|*/../*|*/./*) printf 'refusing unsafe harness session reset: %s\n' "$session" >&2; return 2 ;;
  esac
  if [ -z "$relative" ] || [ -L "$app_data" ] || [ -L "$app_data/_harness" ]; then
    printf 'refusing unsafe harness root for: %s\n' "$session" >&2
    return 2
  fi

  local target="$app_data/_harness/$relative"
  local current="$app_data/_harness"
  local component
  local old_ifs="$IFS"
  IFS='/'
  for component in $relative; do
    current="$current/$component"
    if [ -L "$current" ]; then
      IFS="$old_ifs"
      printf 'refusing symlinked harness session reset: %s\n' "$session" >&2
      return 2
    fi
  done
  IFS="$old_ifs"

  [ -e "$target" ] || return 0
  [ -d "$target" ] || { printf 'refusing non-directory harness reset: %s\n' "$session" >&2; return 2; }
  marker="$target/.mosh-harness-owned-v1"
  [ -f "$marker" ] && [ ! -L "$marker" ] \
    || { printf 'refusing unowned harness reset: %s\n' "$session" >&2; return 2; }
  marker_size="$(wc -c < "$marker" | tr -d '[:space:]')"
  [ "$marker_size" = "${#expected}" ] && [ "$(/bin/cat "$marker")" = "$expected" ] \
    || { printf 'refusing marker-mismatched harness reset: %s\n' "$session" >&2; return 2; }

  quarantine="$app_data/_harness/.mosh-reset-${relative//\//-}-$$-$RANDOM"
  /bin/mv -- "$target" "$quarantine"
  marker="$quarantine/.mosh-harness-owned-v1"
  if [ -L "$quarantine" ] || [ ! -f "$marker" ] || [ -L "$marker" ]; then
    [ -e "$target" ] || /bin/mv -- "$quarantine" "$target"
    printf 'harness ownership changed during reset: %s\n' "$session" >&2
    return 2
  fi
  marker_size="$(wc -c < "$marker" | tr -d '[:space:]')"
  if [ "$marker_size" != "${#expected}" ] || [ "$(/bin/cat "$marker")" != "$expected" ]; then
    [ -e "$target" ] || /bin/mv -- "$quarantine" "$target"
    printf 'harness ownership changed during reset: %s\n' "$session" >&2
    return 2
  fi
  /bin/rm -rf -- "$quarantine"
}
