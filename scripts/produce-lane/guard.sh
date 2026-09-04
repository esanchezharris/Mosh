#!/usr/bin/env bash
# guard.sh — three-state resource gate for the overnight produce-lane batch.
#
#   exit 0 = ok   — proceed with the next run
#   exit 1 = wait — transient pressure (retry after a short sleep; the caller's
#                   policy, e.g. overnight.sh, decides how many times)
#   exit 2 = stop — a hard floor breached; stop the batch, don't retry
#
# Reuses the SAME metrics as scripts/auto-loop/memory-preflight.sh (free
# memory %, swap used MiB, Data volume free GiB) so the produce-lane's numbers
# match every other gate in the repo, but SPLITS a shortfall into wait vs
# stop — memory-preflight.sh's binary pass/fail doesn't distinguish "the
# render pool is between takes, try again in a minute" from "the Data volume
# is nearly full, stop before you make it worse."
#
# Usage: scripts/produce-lane/guard.sh
# Prints one status line to stdout (machine-parseable prefix `[guard] <ok|wait|stop>`)
# and exits 0/1/2. Never touches processes, files under the session, or the
# app — this is read-only measurement, safe to run any time, no app required.
#
# Env (all optional; same names/defaults as memory-preflight.sh where shared):
#   MOSH_MIN_MEMORY_FREE_PERCENT (default 25)   — below this: wait
#   MOSH_MAX_SWAP_USED_MIB       (default 4096) — above this: wait
#   MOSH_MIN_DATA_FREE_GIB       (default 32)   — below this: wait
#   MOSH_STOP_DATA_FREE_GIB      (default 10)   — below this: stop (hard floor)

set -euo pipefail

MIN_MEMORY_FREE_PERCENT="${MOSH_MIN_MEMORY_FREE_PERCENT:-25}"
MAX_SWAP_USED_MIB="${MOSH_MAX_SWAP_USED_MIB:-4096}"
MIN_DATA_FREE_GIB="${MOSH_MIN_DATA_FREE_GIB:-32}"
STOP_DATA_FREE_GIB="${MOSH_STOP_DATA_FREE_GIB:-10}"

require_unsigned_integer() {
  local name="$1" value="$2"
  case "$value" in
    ''|*[!0-9]*)
      printf '[guard] FAIL %s must be an unsigned integer, got %s\n' "$name" "$value" >&2
      exit 2
      ;;
  esac
}
require_unsigned_integer MOSH_MIN_MEMORY_FREE_PERCENT "$MIN_MEMORY_FREE_PERCENT"
require_unsigned_integer MOSH_MAX_SWAP_USED_MIB "$MAX_SWAP_USED_MIB"
require_unsigned_integer MOSH_MIN_DATA_FREE_GIB "$MIN_DATA_FREE_GIB"
require_unsigned_integer MOSH_STOP_DATA_FREE_GIB "$STOP_DATA_FREE_GIB"
if [ "$STOP_DATA_FREE_GIB" -gt "$MIN_DATA_FREE_GIB" ]; then
  printf '[guard] FAIL MOSH_STOP_DATA_FREE_GIB (%s) must be <= MOSH_MIN_DATA_FREE_GIB (%s)\n' \
    "$STOP_DATA_FREE_GIB" "$MIN_DATA_FREE_GIB" >&2
  exit 2
fi

require_metric() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    printf '[guard] FAIL could not read %s\n' "$name" >&2
    exit 2
  fi
}

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

status=0
reasons=""
add_reason() { reasons="${reasons:+$reasons; }$1"; }

if [ "$data_free_gib" -lt "$STOP_DATA_FREE_GIB" ]; then
  status=2
  add_reason "Data volume free ${data_free_gib}GiB is below the HARD floor ${STOP_DATA_FREE_GIB}GiB"
elif [ "$data_free_gib" -lt "$MIN_DATA_FREE_GIB" ]; then
  if [ "$status" -lt 1 ]; then status=1; fi
  add_reason "Data volume free ${data_free_gib}GiB is below ${MIN_DATA_FREE_GIB}GiB"
fi

if [ "$memory_free_percent" -lt "$MIN_MEMORY_FREE_PERCENT" ]; then
  if [ "$status" -lt 1 ]; then status=1; fi
  add_reason "free memory ${memory_free_percent}% is below ${MIN_MEMORY_FREE_PERCENT}%"
fi

if [ "$swap_used_mib" -gt "$MAX_SWAP_USED_MIB" ]; then
  if [ "$status" -lt 1 ]; then status=1; fi
  add_reason "swap used ${swap_used_mib}MiB exceeds ${MAX_SWAP_USED_MIB}MiB"
fi

label="ok"
if [ "$status" -eq 1 ]; then label="wait"; fi
if [ "$status" -eq 2 ]; then label="stop"; fi

printf '[guard] %s free=%s%% swap=%sMiB data_free=%sGiB' "$label" "$memory_free_percent" "$swap_used_mib" "$data_free_gib"
if [ -n "$reasons" ]; then printf ' reason="%s"' "$reasons"; fi
printf '\n'
exit "$status"
