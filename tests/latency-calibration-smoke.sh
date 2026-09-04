#!/usr/bin/env bash
# LAT-001 - measured latency calibration, end to end through a digital loopback.
#
# Needs the BlackHole 2ch virtual device so the calibration sweep Mosh plays comes
# straight back as its input, and so a click played at 1.0 s records back and must land
# within 1 ms. Nobody at the mic, nothing to listen to.
#
# Usage: tests/latency-calibration-smoke.sh /path/to/Mosh.app/Contents/MacOS/Mosh [device]
set -euo pipefail
app="${1:?usage: latency-calibration-smoke.sh /path/to/Mosh [device-name]}"
device="${2:-BlackHole 2ch}"
if ! system_profiler SPAudioDataType 2>/dev/null | grep -Fq "$device"; then
  printf 'latency-calibration-smoke: audio device "%s" not present (install BlackHole)\n' "$device" >&2
  exit 2
fi
session="_harness/latency-calibration-$$-$RANDOM"
log="$(mktemp /private/tmp/mosh-latency-smoke.XXXXXX)"
trap '/bin/rm -f -- "$log"' EXIT
set +e
MOSH_SELFTEST_SESSION="$session" \
  MOSH_AUDIO_OUTPUT_DEVICE="$device" MOSH_AUDIO_INPUT_DEVICE="$device" \
  "$app" --latency-calibration-smoke -ApplePersistenceIgnoreState YES > "$log" 2>&1
rc=$?
set -e
cat "$log"
exit "$rc"
