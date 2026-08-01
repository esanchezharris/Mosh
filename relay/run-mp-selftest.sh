#!/usr/bin/env bash
# Run the gated multiplayer relay integration selftest end-to-end:
#   start the relay -> wait for /health -> run `Mosh --selftest` with
#   MOSH_SELFTEST_MP=1 against it -> tear the relay down.
#
# Usage:  bash relay/run-mp-selftest.sh
#   MOSH_BIN  override the Mosh binary (default: the debug build under build-macos-arm64)
#   PORT      relay port (default 8799)
#   MOSH_RELAY_BLOB_CORRUPT  ext-scoped corruption hook for the "downloadBlob rejects
#             a corrupted transfer" selftest section (PR-1 should-fix). Defaults to
#             the reserved "corrupttest" ext, which no real stem ever uses (all real
#             stems are ext="wav") -- so it's safe to leave armed for the WHOLE run,
#             unlike MOSH_RELAY_BLOB_DELAY_MS. Set to "" to disable entirely.
#   MOSH_RELAY_BLOB_FAIL     ext-scoped upload-rejection hook for the "uploadBlob
#             checks the PUT status" selftest section (PR-2 BLOCKER). Defaults to
#             the reserved "failtest" ext -- same safety property as above. Set to
#             "" to disable entirely.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"   # repo root
PORT="${PORT:-8799}"
APP="${MOSH_BIN:-$(find "$HERE/build-macos-arm64" -name Mosh -path '*Mosh.app/Contents/MacOS/*' -type f 2>/dev/null | head -1)}"
SESSION="${MOSH_SELFTEST_SESSION:-_harness/session-mp-selftest-$(date +%Y%m%d%H%M%S)-$$}"
export MOSH_RELAY_BLOB_CORRUPT="${MOSH_RELAY_BLOB_CORRUPT-corrupttest}"
export MOSH_RELAY_BLOB_FAIL="${MOSH_RELAY_BLOB_FAIL-failtest}"

if [ -z "${APP:-}" ] || [ ! -x "$APP" ]; then
  echo "Mosh binary not found. Build the app or set MOSH_BIN=/path/to/Mosh" >&2
  exit 1
fi

PORT="$PORT" python3 "$HERE/relay/server.py" >/tmp/mosh-relay.log 2>&1 &
RELAY_PID=$!
trap 'kill "$RELAY_PID" 2>/dev/null || true; pkill -f "relay/server.py" 2>/dev/null || true' EXIT

# Wait for the relay to bind (bash foreground `sleep` is unavailable here, so poll
# in Python, which may use time.sleep).
python3 - "$PORT" <<'PY'
import sys, urllib.request, time
for _ in range(100):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/health", timeout=0.5)
        break
    except Exception:
        time.sleep(0.05)
else:
    sys.exit("relay did not start")
PY

rm -rf "$HOME/Library/Mosh/$SESSION"
LOG="$(mktemp -t mosh-mp-selftest.XXXXXX.log)"
MOSH_NO_AUDIO=1 MOSH_SELFTEST_SESSION="$SESSION" MOSH_SELFTEST_MP=1 MOSH_RELAY_URL="http://127.0.0.1:$PORT" "$APP" --selftest 2>&1 | tee "$LOG"
status=${PIPESTATUS[0]}
if rg -n 'JUCE Assertion failure|Leaked objects detected' "$LOG" >/dev/null; then
  rg -n 'JUCE Assertion failure|Leaked objects detected' "$LOG" >&2
  exit 1
fi
exit "$status"
