#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${MOSH_APP_BIN:-$REPO/build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh}"
DEVICE="${MOSH_AUDIO_OUTPUT_DEVICE:-BlackHole 2ch}"
FFMPEG="${FFMPEG:-ffmpeg}"
EVID="${MOSH_EVID:-$REPO/_preserved_artifacts/live-instrument-$(date +%Y%m%d-%H%M%S)}"
ONLY="${MOSH_LIVE_INSTRUMENT_ONLY:-}"

[[ -x "$APP" ]] || { echo "missing app binary: $APP" >&2; exit 2; }
command -v "$FFMPEG" >/dev/null 2>&1 || { echo "ffmpeg not found" >&2; exit 2; }
mkdir -p "$EVID"

if pgrep -f '/Mosh\.app/Contents/MacOS/Mosh' >/dev/null 2>&1; then
  echo "another Mosh app process is active; refusing an ambiguous capture" >&2
  pgrep -fal '/Mosh\.app/Contents/MacOS/Mosh' >&2 || true
  exit 2
fi

"$FFMPEG" -hide_banner -f avfoundation -list_devices true -i "" \
  > "$EVID/ffmpeg-devices.log" 2>&1 || true
INDEX="$(sed -n "/] $DEVICE$/s/.*\[\([0-9][0-9]*\)\].*/\1/p" \
  "$EVID/ffmpeg-devices.log" | head -1)"
[[ -n "$INDEX" ]] || { echo "AVFoundation input not found: $DEVICE" >&2; exit 2; }

CASES=(
  "4OSC|hot-swap|4osc"
  "Serum|hot-swap|serum-1"
  "Serum 2|hot-swap|serum-2"
  "Vital|hot-swap|vital"
  "Serum 2|save-reload|serum-2-save-reload"
  "Serum 2|undo-redo|serum-2-undo-redo"
)

failures=0
for entry in "${CASES[@]}"; do
  IFS='|' read -r instrument scenario label <<< "$entry"
  if [[ -n "$ONLY" && "$label" != $ONLY ]]; then
    continue
  fi
  wav="$EVID/$label.wav"
  app_log="$EVID/$label.app.log"
  capture_log="$EVID/$label.capture.log"
  analysis="$EVID/$label.analysis.json"

  "$FFMPEG" -hide_banner -y -f avfoundation -i ":$INDEX" \
    -ac 2 -ar 48000 -c:a pcm_s16le "$wav" > "$capture_log" 2>&1 &
  capture_pid=$!
  sleep 1

  set +e
  env -u CI \
    MOSH_AUDIO_OUTPUT_DEVICE="$DEVICE" \
    MOSH_LIVE_INSTRUMENT="$instrument" \
    MOSH_LIVE_INSTRUMENT_CASE="$scenario" \
    MOSH_LIVE_INSTRUMENT_MS=5000 \
    "$APP" --live-instrument-smoke > "$app_log" 2>&1
  app_status=$?
  set -e

  kill -INT "$capture_pid" 2>/dev/null || true
  wait "$capture_pid" 2>/dev/null || true

  python3 - "$wav" "$instrument" "$scenario" > "$analysis" <<'PY'
import json
import math
import struct
import sys
import wave

path, instrument, scenario = sys.argv[1:]
try:
    with wave.open(path, "rb") as source:
        frames = source.readframes(source.getnframes())
        channels = source.getnchannels()
        width = source.getsampwidth()
        rate = source.getframerate()
    if width != 2:
        raise ValueError(f"expected 16-bit PCM, got width={width}")
    samples = struct.unpack(f"<{len(frames) // 2}h", frames)
    normalized = [sample / 32768.0 for sample in samples]
    peak = max((abs(sample) for sample in normalized), default=0.0)
    rms = math.sqrt(sum(sample * sample for sample in normalized) / max(1, len(normalized)))
    block = max(1, rate * channels // 20)
    active_blocks = sum(
        1 for start in range(0, len(normalized), block)
        if max((abs(sample) for sample in normalized[start:start + block]), default=0.0) > 0.01
    )
    result = {
        "instrument": instrument,
        "scenario": scenario,
        "peak": peak,
        "rms": rms,
        "activeBlocks": active_blocks,
        "pass": peak > 0.01 and rms > 0.001 and active_blocks >= 2,
    }
except Exception as error:
    result = {"instrument": instrument, "scenario": scenario, "pass": False, "error": str(error)}
print(json.dumps(result, sort_keys=True))
PY

  if [[ "$app_status" -ne 0 ]] || ! python3 -c \
    'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["pass"] else 1)' \
    "$analysis"; then
    failures=$((failures + 1))
    echo "[live-instrument] FAIL $instrument / $scenario" >&2
    tail -80 "$app_log" >&2 || true
    cat "$analysis" >&2
  else
    echo "[live-instrument] PASS $instrument / $scenario $(cat "$analysis")"
  fi
done

python3 - "$EVID" "$failures" > "$EVID/summary.json" <<'PY'
import glob
import json
import os
import sys

root, failures = sys.argv[1], int(sys.argv[2])
cases = []
for path in sorted(glob.glob(os.path.join(root, "*.analysis.json"))):
    with open(path, encoding="utf-8") as source:
        cases.append(json.load(source))
print(json.dumps({"pass": failures == 0, "failures": failures, "cases": cases}, indent=2, sort_keys=True))
PY

echo "[live-instrument] evidence: $EVID"
exit "$failures"
