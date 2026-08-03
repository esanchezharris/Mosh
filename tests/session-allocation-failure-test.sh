#!/usr/bin/env bash
set -euo pipefail

app_input=${1:?Mosh executable required}
app_dir=$(cd "$(dirname "$app_input")" && pwd -P)
app="$app_dir/$(basename "$app_input")"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/mosh-session-allocation.XXXXXX")
readonly scratch

cleanup() {
  chmod 700 "$scratch/denied" 2>/dev/null || true
  rm -rf "$scratch"
}
trap cleanup EXIT

mkdir -p "$scratch/outside" "$scratch/cwd" "$scratch/denied"
ln -s "$scratch/outside" "$scratch/linked-root"
printf 'owner bytes' > "$scratch/cwd/owner-project"
before=$(find "$scratch/cwd" -type f -print0 | sort -z | xargs -0 shasum -a 256)

run_failure() {
  local root=$1
  local log=$2
  set +e
  (
    cd "$scratch/cwd"
    MOSH_ENABLE_TEST_MOSH_DIR=1 \
    MOSH_TEST_MOSH_DIR="$root" \
    MOSH_SELFTEST_SESSION="_harness/allocation-failure" \
    MOSH_NO_AUDIO=1 \
      "$app" --selftest
  ) > "$log" 2>&1
  local status=$?
  set -e
  test "$status" -ne 0
  grep -q 'Mosh startup failed: Unable to allocate isolated' "$log"
}

run_failure "$scratch/linked-root" "$scratch/symlink.log"
test -z "$(find "$scratch/outside" -mindepth 1 -print -quit)"

chmod 500 "$scratch/denied"
run_failure "$scratch/denied" "$scratch/denied.log"
chmod 700 "$scratch/denied"
test -z "$(find "$scratch/denied" -mindepth 1 -print -quit)"

after=$(find "$scratch/cwd" -type f -print0 | sort -z | xargs -0 shasum -a 256)
test "$before" = "$after"
test "$(find "$scratch/cwd" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = "1"

echo "session allocation failures stop startup without cwd or target writes"
