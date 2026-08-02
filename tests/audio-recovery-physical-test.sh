#!/usr/bin/env bash
set -euo pipefail

app="${1:?usage: audio-recovery-physical-test.sh /path/to/Mosh [evidence-log]}"
evidence_log="${2:-}"
app_data="$HOME/Library/Mosh"
owner_settings="$app_data/Settings.xml"
session="_harness/physical-audio-recovery-$$-$RANDOM"
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
MOSH_LIVE_AUDIO_SMOKE_MS=750 \
MOSH_SELFTEST_SESSION="$session" \
  "$app" --audio-recovery-smoke > "$output" 2>&1
after="$(snapshot_owner_settings)"

if [ "$before" != "$after" ]; then
  printf 'owner Settings.xml changed: before=%s after=%s\n' "$before" "$after" >&2
  exit 1
fi

grep -F "Settings file: $session_dir/_settings/run-" "$output" >/dev/null
python3 - "$output" <<'PY'
import json
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(encoding="utf-8")
decoder = json.JSONDecoder()
evidence = None
for offset, character in enumerate(text):
    if character != "{":
        continue
    try:
        candidate, _ = decoder.raw_decode(text[offset:])
    except json.JSONDecodeError:
        continue
    if isinstance(candidate, dict) and "defaultArgvRoundTrip" in candidate:
        evidence = candidate
        break

if evidence is None:
    raise SystemExit("physical audio recovery evidence JSON was not emitted")

problems = []
if evidence.get("mode") != "physical_recovery":
    problems.append("mode was not physical_recovery")
if evidence.get("pass") is not True:
    problems.append("pass was not true")
if evidence.get("retryOk") is not True:
    problems.append("retry did not reacquire the device")
if evidence.get("audioEnabled") is not True:
    problems.append("audio was not enabled after retry")
if evidence.get("deviceTypeCount", 0) <= 0:
    problems.append("no physical audio device type was enumerated")
if evidence.get("liveAudioFailures") != 0:
    problems.append("CoreAudio callback smoke failed")
if "did not open within" not in evidence.get("startupAudioDeviceError", ""):
    problems.append("startup timeout was not reproduced")
if evidence.get("audioDeviceError"):
    problems.append("audio device error remained after retry")

if problems:
    print(json.dumps(evidence, indent=2), file=sys.stderr)
    raise SystemExit("; ".join(problems))

print(json.dumps(evidence, indent=2, sort_keys=True))
PY
test ! -e "$session_dir/session.running"
test "$(find "$session_dir/_settings" -type f -name Settings.xml | wc -l | tr -d '[:space:]')" = "1"

if [ -n "$evidence_log" ]; then
  mkdir -p "$(dirname "$evidence_log")"
  cp "$output" "$evidence_log"
fi

helper="$(cd "$(dirname "$0")/../scripts/lib" && pwd)/harness-session.sh"
bash -c 'source "$1"; mosh_reset_owned_harness_session "$2"' _ "$helper" "$session"
printf 'physical audio recovery passed; owner hash and mtime unchanged\n'
