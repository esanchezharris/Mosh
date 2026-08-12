#!/usr/bin/env bash
# Fail closed before heavyweight local builds and test suites can exhaust macOS
# memory, swap, or the Data volume. Thresholds are integer environment values so
# constrained machines can tighten them without editing the repository.
set -euo pipefail

MIN_MEMORY_FREE_PERCENT="${MOSH_MIN_MEMORY_FREE_PERCENT:-25}"
MAX_SWAP_USED_MIB="${MOSH_MAX_SWAP_USED_MIB:-4096}"
MIN_DATA_FREE_GIB="${MOSH_MIN_DATA_FREE_GIB:-32}"
MAX_CODEX_CHILDREN="${MOSH_MAX_CODEX_CHILDREN:-64}"

require_unsigned_integer() {
  local name="$1" value="$2"
  case "$value" in
    ''|*[!0-9]*)
      printf '[memory-preflight] FAIL %s must be an unsigned integer, got %s\n' "$name" "$value" >&2
      exit 2
      ;;
  esac
}

require_metric() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    printf '[memory-preflight] FAIL could not read %s\n' "$name" >&2
    exit 2
  fi
}

require_unsigned_integer MOSH_MIN_MEMORY_FREE_PERCENT "$MIN_MEMORY_FREE_PERCENT"
require_unsigned_integer MOSH_MAX_SWAP_USED_MIB "$MAX_SWAP_USED_MIB"
require_unsigned_integer MOSH_MIN_DATA_FREE_GIB "$MIN_DATA_FREE_GIB"
require_unsigned_integer MOSH_MAX_CODEX_CHILDREN "$MAX_CODEX_CHILDREN"

memory_free_percent="$(memory_pressure -Q 2>/dev/null | awk -F': ' '
  /System-wide memory free percentage/ {
    gsub(/%/, "", $2)
    print int($2)
    exit
  }
')"
require_metric 'free memory percentage' "$memory_free_percent"

swap_used_mib="$(sysctl vm.swapusage 2>/dev/null | awk '
  {
    for (i = 1; i <= NF; i++) {
      if ($i == "used") {
        value = $(i + 2)
        unit = substr(value, length(value), 1)
        sub(/[MGT]$/, "", value)
        if (unit == "G") value *= 1024
        if (unit == "T") value *= 1048576
        printf "%.0f\n", value
        exit
      }
    }
  }
')"
require_metric 'swap usage' "$swap_used_mib"

data_free_gib="$(df -Pk /System/Volumes/Data 2>/dev/null | awk '
  NR == 2 { printf "%d\n", $4 / 1048576; exit }
')"
require_metric 'Data volume free space' "$data_free_gib"

process_snapshot="$(ps -axo pid=,ppid=,command= 2>/dev/null)"
codex_app_server_pid="$(printf '%s\n' "$process_snapshot" | awk '
  /\/Applications\/ChatGPT.app\/Contents\/Resources\/codex .* app-server / {
    if (found == "") found = $1
  }
  END { if (found != "") print found }
')"
codex_children=0
if [ -n "$codex_app_server_pid" ]; then
  codex_children="$(printf '%s\n' "$process_snapshot" | awk -v parent="$codex_app_server_pid" '
    $2 == parent { count++ }
    END { print count + 0 }
  ')"
fi

failed=0
if [ "$memory_free_percent" -lt "$MIN_MEMORY_FREE_PERCENT" ]; then
  printf '[memory-preflight] FAIL free memory %s%% is below %s%%\n' \
    "$memory_free_percent" "$MIN_MEMORY_FREE_PERCENT" >&2
  failed=1
fi
if [ "$swap_used_mib" -gt "$MAX_SWAP_USED_MIB" ]; then
  printf '[memory-preflight] FAIL swap used %s MiB exceeds %s MiB\n' \
    "$swap_used_mib" "$MAX_SWAP_USED_MIB" >&2
  failed=1
fi
if [ "$data_free_gib" -lt "$MIN_DATA_FREE_GIB" ]; then
  printf '[memory-preflight] FAIL Data volume free %s GiB is below %s GiB\n' \
    "$data_free_gib" "$MIN_DATA_FREE_GIB" >&2
  failed=1
fi
if [ "$codex_children" -gt "$MAX_CODEX_CHILDREN" ]; then
  printf '[memory-preflight] FAIL Codex child process count %s exceeds %s\n' \
    "$codex_children" "$MAX_CODEX_CHILDREN" >&2
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi

printf '[memory-preflight] PASS free=%s%% swap=%sMiB data_free=%sGiB codex_children=%s\n' \
  "$memory_free_percent" "$swap_used_mib" "$data_free_gib" "$codex_children"
