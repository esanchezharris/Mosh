#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVICE="${MOSH_AUDIO_OUTPUT_DEVICE:-BlackHole 2ch}"
SERVICE_HOST="${MOSH_SERVICE_HOST:-127.0.0.1}"
SERVICE_PORT="${MOSH_SERVICE_PORT:-8770}"
SA3_DIR="${SA3_MLX_DIR:-$HOME/AI/stable-audio-3/optimized/mlx}"
COLOR_DIR="${COLORRACK_DATA:-$REPO/service/colors/COLORRACK_DATA}"
LEGACY_SA3_BUNDLE="${MOSH_LEGACY_SA3_BUNDLE:-$REPO/_preserved_artifacts/2026-06-08-consolidation/mosh/sa3-colors-steering-data-20260608}"
EVID="${MOSH_EVID:-$REPO/_preserved_artifacts/2026-06-08-consolidation/claudemosh/macos-local-preflight-$(date +%Y%m%d-%H%M%S)}"

mkdir -p "$EVID"
REPORT="$EVID/REPORT.md"
LOG="$EVID/preflight.log"

failures=0
warnings=0

exec > >(tee "$LOG") 2>&1

pass() { printf '[macos-local-preflight] PASS %s\n' "$*"; }
warn() { warnings=$((warnings + 1)); printf '[macos-local-preflight] WARN %s\n' "$*"; }
fail() { failures=$((failures + 1)); printf '[macos-local-preflight] FAIL %s\n' "$*"; }

require_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    pass "command '$1' is available"
  else
    fail "command '$1' is missing"
  fi
}

check_dir() {
  if [[ -d "$1" ]]; then
    pass "$2 exists: $1"
  else
    fail "$2 missing: $1"
  fi
}

check_file_nonempty() {
  if [[ -s "$1" ]]; then
    pass "$2 wrote non-empty file: $1"
  else
    fail "$2 did not write a non-empty file: $1"
  fi
}

echo "[macos-local-preflight] evidence=$EVID"

if [[ "$(uname -s)" == "Darwin" ]]; then
  pass "host OS is macOS"
else
  fail "host OS is not macOS: $(uname -s)"
fi

if [[ "$(uname -m)" == "arm64" ]]; then
  pass "host architecture is arm64"
else
  fail "host architecture is not arm64: $(uname -m)"
fi

for cmd in cmake npm rg python3 swift osascript screencapture ffmpeg system_profiler git; do
  require_cmd "$cmd"
done

PYTHON_BIN="${MOSH_PYTHON:-$(command -v python3)}"
if ! "$PYTHON_BIN" - <<'PY' >/dev/null 2>&1
import PIL
import Quartz
print("python-ui-deps-ok")
PY
then
  for candidate in /opt/homebrew/bin/python3 /usr/local/bin/python3; do
    if [[ -x "$candidate" ]] && "$candidate" - <<'PY' >/dev/null 2>&1
import PIL
import Quartz
print("python-ui-deps-ok")
PY
    then
      PYTHON_BIN="$candidate"
      break
    fi
  done
fi

if "$PYTHON_BIN" - <<'PY'
import PIL
import Quartz
print("python-ui-deps-ok")
PY
then
  pass "Python can import PIL and Quartz: $PYTHON_BIN"
else
  fail "Python cannot import PIL and Quartz"
fi

if osascript -e 'tell application "System Events" to get UI elements enabled' > "$EVID/accessibility.txt" 2>&1; then
  if rg -qi '^true$' "$EVID/accessibility.txt"; then
    pass "Accessibility UI scripting is enabled"
  else
    fail "Accessibility UI scripting is disabled"
  fi
else
  fail "Accessibility UI scripting check failed"
fi

if screencapture -x "$EVID/screencapture-preflight.png" >/dev/null 2>&1; then
  check_file_nonempty "$EVID/screencapture-preflight.png" "screencapture"
else
  fail "screencapture failed; Screen Recording may be missing"
fi

if system_profiler SPAudioDataType > "$EVID/audio-devices.txt" 2>&1; then
  if rg -Fq "$DEVICE" "$EVID/audio-devices.txt"; then
    pass "CoreAudio device is present: $DEVICE"
  else
    fail "CoreAudio device is missing: $DEVICE"
  fi
else
  fail "could not list CoreAudio devices"
fi

if command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg -hide_banner -f avfoundation -list_devices true -i "" > "$EVID/ffmpeg-devices.log" 2>&1 || true
  if rg -Fq "$DEVICE" "$EVID/ffmpeg-devices.log"; then
    pass "ffmpeg AVFoundation can see input device: $DEVICE"
  else
    fail "ffmpeg AVFoundation cannot see input device: $DEVICE"
  fi
fi

set +e
"$PYTHON_BIN" - "$SERVICE_HOST" "$SERVICE_PORT" "$EVID/service-health.json" <<'PY'
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

host, port, out = sys.argv[1], sys.argv[2], Path(sys.argv[3])
url = f"http://{host}:{port}/health"
result = {"url": url, "state": "absent"}
try:
    with urllib.request.urlopen(url, timeout=1.0) as response:
        raw = response.read().decode("utf-8", errors="replace")
        result = {"url": url, "state": "present", "status": response.status, "raw": raw}
        try:
            result["json"] = json.loads(raw)
        except json.JSONDecodeError:
            pass
except urllib.error.URLError as exc:
    result["error"] = str(exc)
out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
payload = result.get("json", {})
if result["state"] == "absent":
    print("service-port-ok: no existing service")
elif result.get("status") == 200 and payload.get("service") == "mosh-generative":
    print("service-port-ok: existing Mosh service")
else:
    print("service-port-conflict")
    raise SystemExit(2)
PY
service_status=$?
set -e
case "$service_status" in
  0) pass "service port ${SERVICE_HOST}:${SERVICE_PORT} is clear or Mosh-owned" ;;
  *) fail "service port ${SERVICE_HOST}:${SERVICE_PORT} is occupied by an unexpected service" ;;
esac

check_dir "$SA3_DIR" "SA3_MLX_DIR"
check_dir "$COLOR_DIR" "COLORRACK_DATA"
if [[ -d "$LEGACY_SA3_BUNDLE" ]]; then
  pass "MOSH_LEGACY_SA3_BUNDLE exists: $LEGACY_SA3_BUNDLE"
else
  warn "MOSH_LEGACY_SA3_BUNDLE absent: $LEGACY_SA3_BUNDLE (legacy SA3 color comparison will be skipped; current SA3/COLORRACK_DATA checks remain required)"
fi

if [[ -d "/Library/Audio/Plug-Ins/VST3" || -d "$HOME/Library/Audio/Plug-Ins/VST3" ]]; then
  pass "at least one VST3 plugin directory exists"
else
  fail "no VST3 plugin directory exists"
fi

if [[ -e "$REPO/.mosh-strict-local-v0.lock" ]]; then
  fail "strict local gate lock already exists: $REPO/.mosh-strict-local-v0.lock"
else
  pass "strict local gate lock is clear"
fi

if git -C "$REPO" ls-files --error-unmatch assets/grit_demo >/dev/null 2>&1; then
  fail "assets/grit_demo is tracked"
else
  pass "assets/grit_demo is untracked"
fi

if git -C "$REPO" check-ignore -q assets/grit_demo/; then
  pass "assets/grit_demo is ignored"
else
  fail "assets/grit_demo is not ignored"
fi

if [[ -d "$REPO/assets/grit_demo" ]]; then
  pass "assets/grit_demo still exists locally"
else
  warn "assets/grit_demo is absent locally; preservation manifest still owns archived proof"
fi

cat > "$REPORT" <<EOF
# ClaudeMosh macOS Local Preflight

Result: $([[ "$failures" -eq 0 ]] && echo PASS || echo FAIL)
Evidence: \`$EVID\`

Failures: $failures
Warnings: $warnings

Checked:
- macOS arm64 host
- Required build/test commands
- Python PIL/Quartz imports
- Accessibility UI scripting
- Screen capture
- BlackHole CoreAudio and ffmpeg AVFoundation visibility
- Mosh service port ownership
- SA3 and color-rack local assets
- Current SA3 and Color Rack local assets
- Legacy SA3 color bundle for optional historical comparison
- VST3 plugin directory presence
- Strict gate lock contention
- Local preservation state for \`assets/grit_demo\`
EOF

if [[ "$failures" -ne 0 ]]; then
  echo "[macos-local-preflight] FAIL evidence=$EVID"
  exit 1
fi

echo "[macos-local-preflight] PASS evidence=$EVID"
