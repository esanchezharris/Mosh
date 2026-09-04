#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUBJECT="$REPO/scripts/auto-loop/memory-preflight.sh"
GATE="$REPO/scripts/auto-loop/gate.sh"
HOST_PATH="$PATH"
FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/private/tmp}/mosh-memory-preflight.XXXXXX")"
BIN="$FIXTURE_ROOT/bin"
mkdir -p "$BIN"
trap 'rm -rf -- "$FIXTURE_ROOT"' EXIT

cat > "$BIN/memory_pressure" <<'SH'
#!/usr/bin/env sh
printf 'System-wide memory free percentage: %s%%\n' "${FAKE_MEMORY_FREE_PERCENT:-90}"
SH

cat > "$BIN/sysctl" <<'SH'
#!/usr/bin/env sh
printf 'vm.swapusage: total = 8192.00M  used = %sM  free = 8192.00M  (encrypted)\n' "${FAKE_SWAP_USED_MB:-0}"
SH

cat > "$BIN/df" <<'SH'
#!/usr/bin/env sh
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf '/dev/fake 999999999 1 %s 1%% /System/Volumes/Data\n' "${FAKE_DATA_FREE_KB:-104857600}"
SH

chmod +x "$BIN/memory_pressure" "$BIN/sysctl" "$BIN/df"

run_subject() {
  local expected_rc="$1" expected_text="$2"
  shift 2
  local output rc
  set +e
  output="$(env \
    -u MOSH_MIN_MEMORY_FREE_PERCENT \
    -u MOSH_MAX_SWAP_USED_MIB \
    -u MOSH_MIN_DATA_FREE_GIB \
    PATH="$BIN:$HOST_PATH" "$@" "$SUBJECT" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne "$expected_rc" ]; then
    printf 'expected rc=%s, got rc=%s\n%s\n' "$expected_rc" "$rc" "$output" >&2
    exit 1
  fi
  if ! grep -Fq "$expected_text" <<< "$output"; then
    printf 'expected output containing %s\n%s\n' "$expected_text" "$output" >&2
    exit 1
  fi
}

# Given healthy memory, swap and disk.
# When the preflight runs.
# Then it allows the heavyweight command.
run_subject 0 '[memory-preflight] PASS' \
  env FAKE_MEMORY_FREE_PERCENT=80 FAKE_SWAP_USED_MB=0 \
  FAKE_DATA_FREE_KB=104857600

# Given the machine is running many agent processes.
# When the preflight runs.
# Then it does NOT care: the process-count ceiling was removed 2026-09-01 (it was a
# proxy for lingering Mosh instances, and it blocked every gate on a busy agent host).
run_subject 0 '[memory-preflight] PASS' env MOSH_MAX_CODEX_CHILDREN=1

# Given each resource limit is unsafe.
# When the preflight runs.
# Then it fails closed with the specific limiting resource.
run_subject 1 'free memory 20% is below 25%' env FAKE_MEMORY_FREE_PERCENT=20
run_subject 1 'swap used 5000 MiB exceeds 4096 MiB' env FAKE_SWAP_USED_MB=5000
run_subject 1 'Data volume free 20 GiB is below 32 GiB' env FAKE_DATA_FREE_KB=20971520

# Given the canonical gate sees unsafe memory.
# When the cheap gate starts.
# Then memory preflight is its only recorded step and no suite begins.
set +e
gate_output="$(env PATH="$BIN:$HOST_PATH" \
  FAKE_MEMORY_FREE_PERCENT=20 "$GATE" cheap "$REPO" HEAD 2>&1)"
gate_rc=$?
set -e
if [ "$gate_rc" -ne 1 ]; then
  printf 'expected gate rc=1, got rc=%s\n%s\n' "$gate_rc" "$gate_output" >&2
  exit 1
fi
printf '%s' "$gate_output" | jq -e \
  '.pass == false and (.steps | length) == 1 and .steps[0].name == "memory_preflight"' \
  >/dev/null

printf 'memory preflight: 9/9 scenarios passed\n'
