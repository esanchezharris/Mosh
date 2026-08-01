#!/usr/bin/env bash
set -euo pipefail

app="${1:?usage: audio-recovery-isolation-test.sh /path/to/Mosh}"
app_data="$HOME/Library/Mosh"
owner_settings="$app_data/Settings.xml"
session="_harness/ctest-audio-recovery-isolation-$$-$RANDOM"
session_dir="$app_data/$session"
scratch="$(mktemp -d)"
output="$scratch/audio-recovery.log"
trap '/bin/rm -rf -- "$scratch"' EXIT

snapshot_owner_settings() {
  python3 - "$owner_settings" <<'PY'
import hashlib
import os
import sys

path = sys.argv[1]
if not os.path.isfile(path):
    print("missing")
    raise SystemExit(0)

digest = hashlib.sha256()
with open(path, "rb") as source:
    for block in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(block)
metadata = os.stat(path, follow_symlinks=False)
print(f"{digest.hexdigest()}:{metadata.st_mtime_ns}")
PY
}

before="$(snapshot_owner_settings)"
MOSH_AUDIO_OPEN_STALL_MS=60000 \
MOSH_AUDIO_OPEN_TIMEOUT_MS=250 \
MOSH_SELFTEST_SESSION="$session" \
  "$app" --audio-recovery-smoke > "$output" 2>&1
after="$(snapshot_owner_settings)"

if [ "$before" != "$after" ]; then
  printf 'owner Settings.xml changed: before=%s after=%s\n' "$before" "$after" >&2
  exit 1
fi

grep -F "Settings file: $session_dir/_settings/run-" "$output" >/dev/null
grep -F '"pass": true' "$output" >/dev/null
test ! -e "$session_dir/session.running"
test "$(find "$session_dir/_settings" -type f -name Settings.xml | wc -l | tr -d '[:space:]')" = "1"

helper="$(cd "$(dirname "$0")/../scripts/lib" && pwd)/harness-session.sh"
bash -c 'source "$1"; mosh_reset_owned_harness_session "$2"' _ "$helper" "$session"
printf 'audio recovery isolation lifecycle passed; owner hash and mtime unchanged\n'
