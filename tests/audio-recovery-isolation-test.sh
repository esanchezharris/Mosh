#!/usr/bin/env bash
set -euo pipefail

app="${1:?usage: audio-recovery-isolation-test.sh /path/to/Mosh}"
session="_harness/ctest-audio-recovery-isolation-$$-$RANDOM"
umask 077
scratch="$(mktemp -d /private/tmp/mosh-audio-recovery.XXXXXX)"
trap '/bin/rm -rf -- "$scratch"' EXIT
chmod 700 "$scratch"
mosh_dir="$scratch/mosh"
cf_dir="$scratch/cf"
tmp_dir="$scratch/tmp"
mkdir -m 700 "$mosh_dir" "$cf_dir" "$tmp_dir"
sentinel="$mosh_dir/Settings.xml"
output="$scratch/audio-recovery.log"
session_dir="$mosh_dir/$session"

printf '%s\n' 'C012 AudioRecoverySmoke sentinel' > "$sentinel"

snapshot_sentinel() {
  if [ ! -f "$sentinel" ] || [ -L "$sentinel" ]; then
    printf 'missing\n'
    return 0
  fi

  python3 - "$sentinel" <<'PY'
import hashlib
import os
import sys

path = sys.argv[1]
digest = hashlib.sha256()
with open(path, "rb") as source:
    for block in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(block)
metadata = os.stat(path, follow_symlinks=False)
print(f"{digest.hexdigest()}:{metadata.st_mtime_ns}")
PY
}

fail() {
  local stage="$1"
  local app_rc="$2"
  printf 'AudioRecoverySmoke failure: stage=%s app_rc=%s\n' "$stage" "$app_rc" >&2
  printf '%s\n' '--- full app output ---' >&2
  if [ -f "$output" ]; then
    /bin/cat "$output" >&2
  else
    printf '%s\n' '<app output unavailable>' >&2
  fi
  exit 1
}

before="$(snapshot_sentinel)"
set +e
env -u MOSH_NO_AUDIO \
    -u MOSH_SELFTEST_SESSION \
    -u MOSH_TEST_MOSH_DIR \
    -u MOSH_ENABLE_TEST_MOSH_DIR \
    -u CFFIXED_USER_HOME \
    -u TMPDIR \
    -u TMP \
    -u TEMP \
    -u MOSH_AUDIO_OPEN_STALL_MS \
    -u MOSH_AUDIO_OPEN_TIMEOUT_MS \
    -u MOSH_AUDIO_OUTPUT_DEVICE \
    -u MOSH_AUDIO_INPUT_DEVICE \
    -u MOSH_TELEMETRY_DIR \
    -u MOSH_TELEMETRY_URL \
    -u MOSH_SENTRY_DSN \
    -u MOSH_SENTRY_INDUCE_CRASH \
    MOSH_ENABLE_TEST_MOSH_DIR=1 \
    MOSH_TEST_MOSH_DIR="$mosh_dir" \
    MOSH_SELFTEST_SESSION="$session" \
    MOSH_TELEMETRY_DIR="$mosh_dir" \
    CFFIXED_USER_HOME="$cf_dir" \
    TMPDIR="$tmp_dir" \
    TMP="$tmp_dir" \
    TEMP="$tmp_dir" \
    MOSH_AUDIO_OPEN_STALL_MS=60000 \
    MOSH_AUDIO_OPEN_TIMEOUT_MS=250 \
    "$app" --audio-recovery-smoke > "$output" 2>&1
app_rc=$?
set -e
after="$(snapshot_sentinel)"

settings_path_ok=0
if grep -F "Settings file: $session_dir/_settings/run-" "$output" >/dev/null; then
  settings_path_ok=1
fi
owner_path_leak=0
if grep -F "$HOME/Library/Mosh" "$output" >/dev/null; then
  owner_path_leak=1
fi
pass_evidence_ok=0
if grep -F '"pass": true' "$output" >/dev/null; then
  pass_evidence_ok=1
fi
session_running_absent=0
if [ ! -e "$session_dir/session.running" ]; then
  session_running_absent=1
fi
settings_file_count="missing"
if [ -d "$session_dir/_settings" ]; then
  settings_file_count="$(find "$session_dir/_settings" -type f -name Settings.xml | wc -l | tr -d '[:space:]')" \
    || settings_file_count="error"
fi

helper="$(cd "$(dirname "$0")/../scripts/lib" && pwd)/harness-session.sh"
set +e
MOSH_APP_DATA_DIR="$mosh_dir" \
  bash -c 'source "$1"; mosh_reset_owned_harness_session "$2"' _ "$helper" "$session"
reset_rc=$?
set -e

if [ "$before" != "$after" ]; then
  printf 'synthetic Settings.xml changed: before=%s after=%s\n' "$before" "$after" >&2
  fail "synthetic-settings-integrity" "$app_rc"
fi
if [ "$reset_rc" -ne 0 ]; then
  fail "owned-harness-reset" "$app_rc"
fi
if [ "$app_rc" -ne 0 ]; then
  fail "app-exit" "$app_rc"
fi
if [ "$settings_path_ok" -ne 1 ]; then
  fail "isolated-settings-path" "$app_rc"
fi
if [ "$owner_path_leak" -ne 0 ]; then
  fail "owner-path-leak" "$app_rc"
fi
if [ "$pass_evidence_ok" -ne 1 ]; then
  fail "pass-evidence" "$app_rc"
fi
if [ "$session_running_absent" -ne 1 ]; then
  fail "session-running-cleanup" "$app_rc"
fi
if [ "$settings_file_count" != "1" ]; then
  fail "isolated-settings-count" "$app_rc"
fi
if [ -e "$session_dir" ]; then
  fail "owned-harness-cleanup" "$app_rc"
fi

printf 'audio recovery isolation lifecycle passed; synthetic sentinel hash and mtime unchanged\n'
