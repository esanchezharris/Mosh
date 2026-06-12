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
MIN_SELFTEST_COUNT="${MOSH_MIN_SELFTEST_COUNT:-650}"

echo "[plugin-host-evidence-gate] app=$APP" >&2
MOSH_NO_AUDIO=1 "$APP" --selftest > "$LOG" 2>&1

if ! SUMMARY="$(python3 - "$LOG" "$MIN_SELFTEST_COUNT" <<'PY'
import re
import sys
from pathlib import Path

log = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
minimum = int(sys.argv[2])
matches = re.findall(r"===== (\d+)/(\d+) checks passed, (\d+) failed =====", log)
if not matches:
    print("missing selftest summary")
    raise SystemExit(1)
passed, total, failed = map(int, matches[-1])
if failed != 0 or passed != total:
    print(f"selftest reported {passed}/{total}, failed={failed}")
    raise SystemExit(1)
if total < minimum:
    print(f"selftest reported {total} checks; expected at least {minimum}")
    raise SystemExit(1)
print(f"{passed}/{total}, failed={failed}")
PY
)"; then
  echo "[plugin-host-evidence-gate] FAIL: $SUMMARY" >&2
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
Result: PASS command-surface selftest reported $SUMMARY.

Notes:
- Assertions/leak detector lines, if present, are copied to assertions.txt.
- Set MOSH_STRICT_ASSERTIONS=1 to make those lines fail the gate once the repo is ready for a strict assertion policy.
EOF

echo "[plugin-host-evidence-gate] PASS evidence=$EVID"
