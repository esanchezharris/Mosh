#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="${MOSH_APP_BUNDLE:-$REPO/build/Mosh_artefacts/Debug/Mosh.app}"
APP_BIN="${MOSH_APP_BIN:-$APP_BUNDLE/Contents/MacOS/Mosh}"
EVID="${MOSH_EVID:-$REPO/_preserved_artifacts/2026-06-08-consolidation/claudemosh/cua-demo-$(date +%Y%m%d-%H%M%S)}"

if [[ ! -d "$APP_BUNDLE" || ! -x "$APP_BIN" ]]; then
  echo "[launch-cua-demo] missing app bundle or binary: $APP_BUNDLE" >&2
  exit 2
fi

mkdir -p "$EVID"
if [[ "$#" -eq 0 ]]; then
  set -- --demo6
fi

open -n "$APP_BUNDLE" --args "$@"
sleep 2
PID="$(pgrep -n -f "$APP_BIN" || true)"
printf '%s\n' "$PID" > "$EVID/pid"

cat > "$EVID/REPORT.md" <<EOF
# ClaudeMosh CUA Demo Launch

App: $APP_BUNDLE
Bundle ID: studio.mosh.app
PID: $PID
Args: $*
EOF

echo "[launch-cua-demo] pid=$PID evidence=$EVID"
