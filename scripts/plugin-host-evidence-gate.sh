#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${MOSH_APP_BIN:-$REPO/build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh}"
EVID="${MOSH_EVID:-$REPO/_preserved_artifacts/2026-06-08-consolidation/claudemosh/plugin-host-evidence-$(date +%Y%m%d-%H%M%S)}"
STRICT_ASSERTIONS="${MOSH_STRICT_ASSERTIONS:-0}"

if [[ ! -x "$APP" ]]; then
  echo "missing Mosh app binary: $APP" >&2
  exit 2
fi

mkdir -p "$EVID"
LOG="$EVID/selftest.log"
EXPECTED_SELFTEST_COUNT=89
if [[ -e /Library/Audio/Plug-Ins/VST3/Serum2.vst3 ]]; then
  EXPECTED_SELFTEST_COUNT=98
fi

echo "[plugin-host-evidence-gate] app=$APP" >&2
MOSH_NO_AUDIO=1 "$APP" --selftest > "$LOG" 2>&1

if ! rg -q "===== $EXPECTED_SELFTEST_COUNT/$EXPECTED_SELFTEST_COUNT checks passed, 0 failed =====" "$LOG"; then
  echo "[plugin-host-evidence-gate] FAIL: selftest did not report $EXPECTED_SELFTEST_COUNT/$EXPECTED_SELFTEST_COUNT checks" >&2
  tail -80 "$LOG" >&2
  exit 1
fi

ASSERTIONS="$(rg -n 'JUCE Assertion failure|Leaked objects detected' "$LOG" || true)"
if [[ -n "$ASSERTIONS" ]]; then
  printf '%s\n' "$ASSERTIONS" > "$EVID/assertions.txt"
  if [[ "$STRICT_ASSERTIONS" == "1" ]]; then
    echo "[plugin-host-evidence-gate] FAIL: assertions present under strict mode" >&2
    cat "$EVID/assertions.txt" >&2
    exit 1
  fi
fi

cat > "$EVID/REPORT.md" <<EOF
# ClaudeMosh Plugin Host Evidence Gate

App: $APP
Mode: MOSH_NO_AUDIO=1 --selftest
Log: $LOG
Result: PASS command-surface selftest reported $EXPECTED_SELFTEST_COUNT/$EXPECTED_SELFTEST_COUNT.

Notes:
- Assertions/leak detector lines, if present, are copied to assertions.txt.
- Set MOSH_STRICT_ASSERTIONS=1 to make those lines fail the gate once the repo is ready for a strict assertion policy.
EOF

echo "[plugin-host-evidence-gate] PASS evidence=$EVID"
