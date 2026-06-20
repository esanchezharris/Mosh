#!/usr/bin/env bash
# voice-loopback.sh — verify the live voice (speech-to-text) path with NO human and
# NO room noise, by routing macOS `say` straight into the mic input via BlackHole.
#
# How it works: set the default INPUT and OUTPUT to "BlackHole 2ch" (a virtual
# passthrough), then run `Mosh --voice-smoke` in MIC mode. The smoke speaks the phrase
# with `say` (→ BlackHole output → BlackHole input), and Mosh's SFSpeechRecognizer
# (reading the default input) transcribes it and asserts the text. Devices are restored
# on exit no matter what.
#
# Prereqs (one-time):
#   • BlackHole 2ch:       brew install blackhole-2ch
#   • SwitchAudioSource:   brew install switchaudio-osx
#   • Grant Mosh **Microphone** + **Speech Recognition** once (the first run prompts).
#
# Usage:  scripts/verify-hardware/voice-loopback.sh [path-to-Mosh-binary]
#   FILE mode (no mic, no BlackHole, only a Speech grant) is simpler — just run:
#     <Mosh> --voice-smoke
set -euo pipefail

BIN="${1:-}"
if [ -z "$BIN" ]; then
  for c in \
    "$(dirname "$0")/../../build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh" \
    "$(dirname "$0")/../../build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh" \
    "/Applications/Mosh.app/Contents/MacOS/Mosh"; do
    [ -x "$c" ] && BIN="$c" && break
  done
fi
[ -x "${BIN:-}" ] || { echo "Mosh binary not found — pass it as the first arg." >&2; exit 1; }

command -v SwitchAudioSource >/dev/null || { echo "need SwitchAudioSource: brew install switchaudio-osx" >&2; exit 1; }
SwitchAudioSource -a -t input | grep -q "BlackHole 2ch" || { echo "need BlackHole: brew install blackhole-2ch" >&2; exit 1; }

ORIG_IN="$(SwitchAudioSource -c -t input)"
ORIG_OUT="$(SwitchAudioSource -c -t output)"
restore() {
  SwitchAudioSource -s "$ORIG_IN"  -t input  >/dev/null 2>&1 || true
  SwitchAudioSource -s "$ORIG_OUT" -t output >/dev/null 2>&1 || true
  echo "restored audio devices (input → $ORIG_IN, output → $ORIG_OUT)"
}
trap restore EXIT

echo "routing input + output → BlackHole 2ch (was: $ORIG_IN / $ORIG_OUT)"
SwitchAudioSource -s "BlackHole 2ch" -t input  >/dev/null
SwitchAudioSource -s "BlackHole 2ch" -t output >/dev/null

echo "running: $BIN --voice-smoke (MIC mode)"
MOSH_VOICE_SMOKE_MIC=1 "$BIN" --voice-smoke
rc=$?
echo "voice-smoke exit: $rc"
exit $rc
