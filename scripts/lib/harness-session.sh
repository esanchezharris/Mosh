#!/usr/bin/env bash

# True (0) when a tree may hold model, adapter, checkpoint or evaluation evidence, or
# could not be inspected. Kept in step with harness_session.py / SessionOwnershipPosix.h.
# Empty directories do not count: every selftest session carries an empty training/adapters.
mosh_harness_tree_has_evidence() {
  local tree="$1" leaf="$2" models dirs words
  # Word lists go through here-strings, not `| grep -q`: an early grep exit would
  # SIGPIPE the producer and, under a caller's pipefail, read as "no evidence".
  local evidence='^(adapters?|checkpoints?|loras?|evals?|evaluations?)$'
  words="$(printf '%s\n' "$leaf" | tr '[:upper:]' '[:lower:]' | tr -- '-_. ' '\n\n\n\n')"
  /usr/bin/grep -Eq "$evidence" <<< "$words" && return 0
  models="$(/usr/bin/find -P "$tree" -xdev \( -iname '*.safetensors' -o -iname '*.ckpt' \
    -o -iname '*.pt' -o -iname '*.pth' -o -iname '*.gguf' -o -iname '*.onnx' \
    -o -iname '*.npz' -o -iname '*.h5' -o -iname '*.tflite' -o -iname '*.mlmodel' \
    -o -iname '*.mlpackage' -o -iname '*.mlmodelc' \) -print 2>/dev/null)" || return 0
  [ -z "$models" ] || return 0
  dirs="$(/usr/bin/find -P "$tree" -xdev -mindepth 1 -type d ! -empty -print 2>/dev/null)" || return 0
  words="$(printf '%s\n' "$dirs" | /usr/bin/sed 's#.*/##' | tr '[:upper:]' '[:lower:]' \
    | tr -- '-_. ' '\n\n\n\n')"
  /usr/bin/grep -Eq "$evidence" <<< "$words" && return 0
  return 1
}

mosh_reset_owned_harness_session() {
  local session="${1:-}"
  local app_data="${MOSH_APP_DATA_DIR:-$HOME/Library/Mosh}"
  local relative marker expected marker_size quarantine quarantined_target
  expected='Mosh isolated harness session v1'
  # Where a successful reset moved the session; empty when there was nothing to move.
  MOSH_HARNESS_RESET_QUARANTINE=''

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

  quarantine="$(mktemp -d "$app_data/_harness/.mosh-reset.XXXXXX")" || return 2
  quarantined_target="$quarantine/session"
  if ! /bin/mv -- "$target" "$quarantined_target"; then
    /bin/rmdir -- "$quarantine"
    return 2
  fi
  marker="$quarantined_target/.mosh-harness-owned-v1"
  if [ -L "$quarantined_target" ] || [ ! -f "$marker" ] || [ -L "$marker" ]; then
    [ -e "$target" ] || /bin/mv -- "$quarantined_target" "$target"
    /bin/rmdir -- "$quarantine" 2>/dev/null || true
    printf 'harness ownership changed during reset: %s\n' "$session" >&2
    return 2
  fi
  marker_size="$(wc -c < "$marker" | tr -d '[:space:]')"
  if [ "$marker_size" != "${#expected}" ] || [ "$(/bin/cat "$marker")" != "$expected" ]; then
    [ -e "$target" ] || /bin/mv -- "$quarantined_target" "$target"
    /bin/rmdir -- "$quarantine" 2>/dev/null || true
    printf 'harness ownership changed during reset: %s\n' "$session" >&2
    return 2
  fi

  # The path is free. Delete the quarantine this call created unless it holds evidence.
  # rm never follows symlinks and -x / --one-file-system keeps it on this volume; a
  # failure only leaves the quarantine for harness_session.py's manifest sweep.
  if ! mosh_harness_tree_has_evidence "$quarantine" "${relative##*/}"; then
    if [ "$(uname -s)" = Darwin ]; then
      /bin/rm -rfx -- "$quarantine" 2>/dev/null || true
    else
      /bin/rm -rf --one-file-system -- "$quarantine" 2>/dev/null || true
    fi
  fi
  # Report the quarantine only while it still exists (it held evidence, or the rm failed):
  # mosh_remove_owned_harness_session acts on it, and an already-deleted one is "removed".
  if [ -e "$quarantine" ] || [ -L "$quarantine" ]; then
    MOSH_HARNESS_RESET_QUARANTINE="$quarantine"
  fi
  return 0
}

# Deletes a session a harness run generated, once nothing reads it any more. Stricter
# than a reset: the session must sit directly under _harness (one visible path
# component), and the reset's ownership checks and atomic move run first, so only the
# marker-owned directory that was verified is deleted. A tree that may hold evidence is
# put back where it was. Returns 0 when the session is gone or was never there, 1 when
# evidence kept it, and 2 when it was refused or could not be deleted.
mosh_remove_owned_harness_session() {
  local session="${1:-}" leaf quarantine target
  leaf="${session#_harness/}"
  case "$session" in
    _harness/*) ;;
    *) printf 'refusing non-harness session removal: %s\n' "$session" >&2; return 2 ;;
  esac
  case "$leaf" in
    ''|*/*|.*) printf 'refusing removal below the _harness top level: %s\n' "$session" >&2; return 2 ;;
  esac
  target="${MOSH_APP_DATA_DIR:-$HOME/Library/Mosh}/_harness/$leaf"

  mosh_reset_owned_harness_session "$session" || return 2
  quarantine="$MOSH_HARNESS_RESET_QUARANTINE"
  [ -n "$quarantine" ] || return 0

  if mosh_harness_tree_has_evidence "$quarantine/session" "$leaf"; then
    if [ ! -e "$target" ] && [ ! -L "$target" ] \
        && /bin/mv -- "$quarantine/session" "$target"; then
      /bin/rmdir -- "$quarantine" 2>/dev/null || true
      printf 'keeping %s: it may hold model, adapter, checkpoint or evaluation evidence\n' \
        "$session" >&2
    else
      printf 'keeping %s in %s: it may hold evidence\n' "$session" "$quarantine" >&2
    fi
    return 1
  fi

  # rm never follows symlinks, and -x / --one-file-system keeps it on this volume.
  if [ "$(uname -s)" = Darwin ]; then
    /bin/rm -rfx -- "$quarantine" || { printf 'could not delete %s\n' "$quarantine" >&2; return 2; }
  else
    /bin/rm -rf --one-file-system -- "$quarantine" \
      || { printf 'could not delete %s\n' "$quarantine" >&2; return 2; }
  fi
  return 0
}

# The gates' end-of-run cleanup for the sessions a run generated. passed=true removes
# each one with mosh_remove_owned_harness_session; anything else keeps them all, since a
# failing run's sessions are its diagnostics. Prints one "removed", "absent" or "kept"
# line per session and always succeeds: reclaiming disk never decides a verdict.
mosh_reclaim_harness_sessions() {
  local passed="${1:-}" session why
  shift || true
  for session in "$@"; do
    if [ "$passed" != true ]; then
      printf 'kept %s: the run did not pass\n' "$session"
    elif [ ! -e "${MOSH_APP_DATA_DIR:-$HOME/Library/Mosh}/$session" ] \
        && [ ! -L "${MOSH_APP_DATA_DIR:-$HOME/Library/Mosh}/$session" ]; then
      printf 'absent %s\n' "$session"
    elif why="$(mosh_remove_owned_harness_session "$session" 2>&1)"; then
      printf 'removed %s\n' "$session"
    else
      printf 'kept %s: %s\n' "$session" "$(printf '%s' "$why" | tr '\n' ' ')"
    fi
  done
  return 0
}
