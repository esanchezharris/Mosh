#!/usr/bin/env bash
# Swappability gate (00 §0, Stage 2 prime directive): rebuild the web frontend and
# re-stage it into Mosh.app, proving the C++ backend binary is BYTE-IDENTICAL across
# the swap. The frontend couples to the backend only via execute_command + the
# snapshot/events feed, so a UI rebuild must not change a single backend byte.
#
# Usage: scripts/stage-ui-swappability-gate.sh
# Env:   MOSH_APP_BUNDLE (default build-macos-arm64/Mosh_artefacts/Debug/Mosh.app)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="${MOSH_APP_BUNDLE:-$REPO/build-macos-arm64/Mosh_artefacts/Debug/Mosh.app}"
BIN="$APP/Contents/MacOS/Mosh"
STAGE="$APP/Contents/Resources/ui"

[ -x "$BIN" ] || { echo "❌ backend binary not found: $BIN (build first: cmake --build build)"; exit 1; }

echo "==> building the web frontend (tsc + vite single-file)"
( cd "$REPO/ui" && npm run build >/dev/null )
[ -f "$REPO/ui/dist/index.html" ] || { echo "❌ ui/dist/index.html missing after build"; exit 1; }

BEFORE="$(shasum -a 256 "$BIN" | awk '{print $1}')"
OLD_UI="$( [ -f "$STAGE/index.html" ] && shasum -a 256 "$STAGE/index.html" | awk '{print $1}' || echo none )"

echo "==> staging ui/dist -> $STAGE"
mkdir -p "$STAGE"
rm -rf "${STAGE:?}/"* && cp -R "$REPO/ui/dist/." "$STAGE/"

AFTER="$(shasum -a 256 "$BIN" | awk '{print $1}')"
NEW_UI="$(shasum -a 256 "$STAGE/index.html" | awk '{print $1}')"

echo
echo "frontend  old=$OLD_UI"
echo "frontend  new=$NEW_UI"
echo "backend   before=$BEFORE"
echo "backend   after =$AFTER"
echo

if [ "$BEFORE" = "$AFTER" ]; then
  echo "✅ SWAPPABILITY PASS — backend binary byte-identical across the UI swap"
  [ "$OLD_UI" != "$NEW_UI" ] && echo "   (frontend genuinely changed: $OLD_UI -> $NEW_UI)"
  exit 0
else
  echo "❌ SWAPPABILITY FAIL — backend binary changed ($BEFORE -> $AFTER)"
  exit 1
fi
