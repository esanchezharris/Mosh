#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${MOSH_APP_BIN:-$REPO/build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh}"
DEVICE="${MOSH_AUDIO_OUTPUT_DEVICE:-BlackHole 2ch}"
FFMPEG="${FFMPEG:-ffmpeg}"
EVID="${MOSH_EVID:-$REPO/_preserved_artifacts/2026-06-08-consolidation/claudemosh/blackhole-live-audio-$(date +%Y%m%d-%H%M%S)}"
MAX_ATTEMPTS="${MOSH_BLACKHOLE_ATTEMPTS:-3}"
CAPTURE_SECONDS="${MOSH_BLACKHOLE_CAPTURE_SECONDS:-8}"

mkdir -p "$EVID"

if ! [[ "$MAX_ATTEMPTS" =~ ^[0-9]+$ ]] || [[ "$MAX_ATTEMPTS" -lt 1 ]]; then
  MAX_ATTEMPTS=1
fi

if ! [[ "$CAPTURE_SECONDS" =~ ^[0-9]+$ ]] || [[ "$CAPTURE_SECONDS" -lt 5 ]]; then
  CAPTURE_SECONDS=8
fi

if [[ ! -x "$APP" ]]; then
  echo "[blackhole-live-audio] FAIL: missing app binary: $APP" >&2
  exit 2
fi

if ! system_profiler SPAudioDataType | rg -q "$DEVICE"; then
  echo "[blackhole-live-audio] FAIL: CoreAudio device not found: $DEVICE" >&2
  exit 2
fi

if ! command -v "$FFMPEG" >/dev/null 2>&1; then
  echo "[blackhole-live-audio] FAIL: ffmpeg not found" >&2
  exit 2
fi

"$FFMPEG" -hide_banner -f avfoundation -list_devices true -i "" > "$EVID/ffmpeg-devices.log" 2>&1 || true
INDEX=""
while IFS= read -r line; do
  if [[ "$line" == *"] $DEVICE" ]]; then
    INDEX="$(printf '%s\n' "$line" | sed -n 's/.*\[\([0-9][0-9]*\)\].*/\1/p')"
    break
  fi
done < "$EVID/ffmpeg-devices.log"

if [[ -z "$INDEX" ]]; then
  echo "[blackhole-live-audio] FAIL: ffmpeg AVFoundation input not found: $DEVICE" >&2
  cat "$EVID/ffmpeg-devices.log" >&2
  exit 2
fi

# GitHub Actions exports CI=true; on this macOS runner the JUCE/Tracktion live
# smoke opens output-only under that env. Keep CI for the workflow, but not for
# the app subprocess whose purpose is to prove real CoreAudio input loopback.
set +e
env -u CI \
MOSH_AUDIO_OUTPUT_DEVICE="$DEVICE" \
MOSH_AUDIO_INPUT_DEVICE="$DEVICE" \
  "$APP" --live-audio-smoke > "$EVID/live-audio-loopback-smoke.log" 2>&1
LOOPBACK_STATUS=$?
set -e

if [[ "$LOOPBACK_STATUS" -ne 0 ]]; then
  cat > "$EVID/REPORT.md" <<EOF
# ClaudeMosh BlackHole Live Audio Gate

Result: FAIL
Device: $DEVICE
Reason: Mosh could open and write to BlackHole, but BlackHole input did not receive non-silent loopback audio
Evidence: $EVID

The app-side output callback is not enough for this gate. This failure means the
local CoreAudio HAL/BlackHole loopback path is currently not delivering output
audio back to the BlackHole input, so the independent ffmpeg capture proof would
also be expected to fail or capture silence.
EOF
  echo "[blackhole-live-audio] FAIL: BlackHole input did not receive Mosh output" >&2
  tail -100 "$EVID/live-audio-loopback-smoke.log" >&2
  exit 1
fi

copy_attempt_logs() {
  local attempt="$1"
  cp "$EVID/blackhole-capture-attempt-${attempt}.wav" "$EVID/blackhole-capture.wav" 2>/dev/null || true
  cp "$EVID/ffmpeg-capture-attempt-${attempt}.log" "$EVID/ffmpeg-capture.log" 2>/dev/null || true
  cp "$EVID/live-audio-smoke-attempt-${attempt}.log" "$EVID/live-audio-smoke.log" 2>/dev/null || true
  cp "$EVID/analysis-attempt-${attempt}.json" "$EVID/analysis.json" 2>/dev/null || true
}

LAST_ATTEMPT=0
LAST_REASON=""

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  LAST_ATTEMPT="$attempt"
  echo "[blackhole-live-audio] attempt ${attempt}/${MAX_ATTEMPTS}"

  CAPTURE="$EVID/blackhole-capture-attempt-${attempt}.wav"
  "$FFMPEG" -hide_banner -y -f avfoundation -i ":$INDEX" -t "$CAPTURE_SECONDS" -ac 2 -ar 48000 "$CAPTURE" > "$EVID/ffmpeg-capture-attempt-${attempt}.log" 2>&1 &
  FFMPEG_PID=$!
  sleep 1

  set +e
  env -u CI \
    MOSH_AUDIO_OUTPUT_DEVICE="$DEVICE" \
    "$APP" --live-audio-smoke > "$EVID/live-audio-smoke-attempt-${attempt}.log" 2>&1
  MOSH_STATUS=$?
  wait "$FFMPEG_PID"
  FFMPEG_STATUS=$?
  set -e

  if [[ "$MOSH_STATUS" -ne 0 ]]; then
    copy_attempt_logs "$attempt"
    cat > "$EVID/REPORT.md" <<EOF
# ClaudeMosh BlackHole Live Audio Gate

Result: FAIL
Device: $DEVICE
Attempts: $attempt/$MAX_ATTEMPTS
Capture seconds: $CAPTURE_SECONDS
Reason: Mosh live audio smoke failed
Evidence: $EVID
EOF
    echo "[blackhole-live-audio] FAIL: Mosh live audio smoke failed" >&2
    tail -80 "$EVID/live-audio-smoke-attempt-${attempt}.log" >&2
    exit 1
  fi

  if [[ "$FFMPEG_STATUS" -ne 0 ]]; then
    LAST_REASON="ffmpeg capture failed"
    echo "[blackhole-live-audio] WARN: $LAST_REASON on attempt ${attempt}" >&2
    tail -40 "$EVID/ffmpeg-capture-attempt-${attempt}.log" >&2
    sleep 2
    continue
  fi

  set +e
  python3 - "$CAPTURE" "$EVID/analysis-attempt-${attempt}.json" <<'PY' > "$EVID/analysis-attempt-${attempt}.log" 2>&1
import json
import math
import struct
import sys
import wave
from pathlib import Path

path = Path(sys.argv[1])
out = Path(sys.argv[2])

with wave.open(str(path), "rb") as wav:
    channels = wav.getnchannels()
    frames = wav.getnframes()
    rate = wav.getframerate()
    width = wav.getsampwidth()
    raw = wav.readframes(frames)

if width == 1:
    vals = [(b - 128) / 128.0 for b in raw]
elif width == 2:
    vals = [x / 32768.0 for x in struct.unpack("<" + "h" * (len(raw) // 2), raw)]
elif width == 4:
    vals = [x / 2147483648.0 for x in struct.unpack("<" + "i" * (len(raw) // 4), raw)]
else:
    raise SystemExit(f"unsupported WAV sample width: {width}")

duration = frames / float(rate or 1)
rms = math.sqrt(sum(v * v for v in vals) / max(1, len(vals)))
peak = max((abs(v) for v in vals), default=0.0)

result = {
    "channels": channels,
    "frames": frames,
    "sample_rate": rate,
    "sample_width": width,
    "duration_seconds": duration,
    "rms": rms,
    "peak": peak,
}
out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

if duration < 1.0:
    raise SystemExit(f"FAIL: capture too short: {duration:.3f}s")
if rms < 0.001 or peak < 0.01:
    raise SystemExit(f"FAIL: capture appears silent: rms={rms:.6f} peak={peak:.6f}")

print(f"PASS: duration={duration:.3f}s rms={rms:.6f} peak={peak:.6f}")
PY
  ANALYSIS_STATUS=$?
  set -e

  if [[ "$ANALYSIS_STATUS" -eq 0 ]]; then
    cat "$EVID/analysis-attempt-${attempt}.log"
    copy_attempt_logs "$attempt"

    cat > "$EVID/REPORT.md" <<EOF
# ClaudeMosh BlackHole Live Audio Gate

Result: PASS
Device: $DEVICE
Attempts: $attempt/$MAX_ATTEMPTS
Capture seconds: $CAPTURE_SECONDS
Internal loopback smoke: $EVID/live-audio-loopback-smoke.log
Capture: $CAPTURE
Analysis: $EVID/analysis.json

This is a CoreAudio HAL virtual-loopback proof. It verifies playback through a
real CoreAudio device path into BlackHole capture, not physical speaker or
microphone behavior.
EOF

    echo "[blackhole-live-audio] PASS evidence=$EVID"
    exit 0
  fi

  LAST_REASON="$(tail -1 "$EVID/analysis-attempt-${attempt}.log" 2>/dev/null || true)"
  echo "[blackhole-live-audio] WARN: attempt ${attempt} did not capture live audio: ${LAST_REASON}" >&2
  sleep 2
done

copy_attempt_logs "$LAST_ATTEMPT"
cat > "$EVID/REPORT.md" <<EOF
# ClaudeMosh BlackHole Live Audio Gate

Result: FAIL
Device: $DEVICE
Attempts: $LAST_ATTEMPT/$MAX_ATTEMPTS
Capture seconds: $CAPTURE_SECONDS
Reason: ${LAST_REASON:-capture did not pass analyzer}
Capture: $EVID/blackhole-capture.wav
Analysis: $EVID/analysis.json

Mosh's live-audio smoke may still report writable CoreAudio output callbacks.
This gate requires the virtual BlackHole input capture to contain non-silent
audio, proving the CoreAudio HAL loopback path rather than only app-side output.
EOF

echo "[blackhole-live-audio] FAIL: no attempt produced non-silent BlackHole capture" >&2
if [[ -n "$LAST_REASON" ]]; then
  echo "[blackhole-live-audio] last reason: $LAST_REASON" >&2
fi
exit 1
