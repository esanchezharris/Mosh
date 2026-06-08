#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${MOSH_APP_BIN:-$REPO/build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh}"
DEVICE="${MOSH_AUDIO_OUTPUT_DEVICE:-BlackHole 2ch}"
FFMPEG="${FFMPEG:-ffmpeg}"
EVID="${MOSH_EVID:-$REPO/_preserved_artifacts/2026-06-08-consolidation/claudemosh/blackhole-live-audio-$(date +%Y%m%d-%H%M%S)}"

mkdir -p "$EVID"

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

CAPTURE="$EVID/blackhole-capture.wav"
"$FFMPEG" -hide_banner -y -f avfoundation -i ":$INDEX" -t 5 -ac 2 -ar 48000 "$CAPTURE" > "$EVID/ffmpeg-capture.log" 2>&1 &
FFMPEG_PID=$!
sleep 1

set +e
MOSH_AUDIO_OUTPUT_DEVICE="$DEVICE" "$APP" --live-audio-smoke > "$EVID/live-audio-smoke.log" 2>&1
MOSH_STATUS=$?
wait "$FFMPEG_PID"
FFMPEG_STATUS=$?
set -e

if [[ "$MOSH_STATUS" -ne 0 ]]; then
  echo "[blackhole-live-audio] FAIL: Mosh live audio smoke failed" >&2
  tail -80 "$EVID/live-audio-smoke.log" >&2
  exit 1
fi

if [[ "$FFMPEG_STATUS" -ne 0 ]]; then
  echo "[blackhole-live-audio] FAIL: ffmpeg capture failed" >&2
  tail -80 "$EVID/ffmpeg-capture.log" >&2
  exit 1
fi

python3 - "$CAPTURE" "$EVID/analysis.json" <<'PY'
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

cat > "$EVID/REPORT.md" <<EOF
# ClaudeMosh BlackHole Live Audio Gate

Result: PASS
Device: $DEVICE
Capture: $CAPTURE
Analysis: $EVID/analysis.json

This is a CoreAudio HAL virtual-loopback proof. It verifies playback through a
real CoreAudio device path into BlackHole capture, not physical speaker or
microphone behavior.
EOF

echo "[blackhole-live-audio] PASS evidence=$EVID"
