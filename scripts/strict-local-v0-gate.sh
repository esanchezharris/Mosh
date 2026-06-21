#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEBUG_BUILD_DIR="${MOSH_DEBUG_BUILD_DIR:-$REPO/build-macos-arm64}"
RELEASE_BUILD_DIR="${MOSH_RELEASE_BUILD_DIR:-$REPO/build-macos-arm64-release}"
APP="${MOSH_APP_BIN:-$DEBUG_BUILD_DIR/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh}"
EVID="${MOSH_EVID:-$REPO/_preserved_artifacts/2026-06-08-consolidation/claudemosh/strict-local-v0-$(date +%Y%m%d-%H%M%S)}"
LOCKDIR="${MOSH_STRICT_LOCK:-$REPO/.mosh-strict-local-v0.lock}"

if ! mkdir "$LOCKDIR" 2>/dev/null; then
  echo "[strict-local-v0] FAIL: another strict gate appears to be running: $LOCKDIR" >&2
  exit 2
fi
trap 'rm -rf "$LOCKDIR"' EXIT

mkdir -p "$EVID"

run_log() {
  local name="$1"
  shift
  echo "[strict-local-v0] RUN $name" >&2
  "$@" > "$EVID/$name.log" 2>&1
}

run_log ui-build npm --prefix "$REPO/ui" run build
run_log cmake-build-debug cmake --build "$DEBUG_BUILD_DIR" --target Mosh MoshTests --config Debug --parallel 6
if [[ -d "$RELEASE_BUILD_DIR" ]]; then
  run_log cmake-build-release cmake --build "$RELEASE_BUILD_DIR" --target Mosh --config Release --parallel 6
fi
run_log ctest ctest --test-dir "$DEBUG_BUILD_DIR" --output-on-failure
run_log undo-selftest env MOSH_NO_AUDIO=1 "$APP" --selftest-undo
run_log default-selftest env MOSH_NO_AUDIO=1 "$APP" --selftest
run_log sa3-selftest env MOSH_SELFTEST_SA3=1 "$APP" --selftest
run_log plugin-host-strict env MOSH_APP_BIN="$APP" MOSH_STRICT_ASSERTIONS=1 "$REPO/scripts/plugin-host-evidence-gate.sh"
run_log command-log "$REPO/scripts/validate-command-log-contract.sh"
run_log preservation "$REPO/scripts/verify-preservation-manifest.sh"
run_log sa3-colors "$REPO/scripts/compare-sa3-colors.sh"

ASSERTIONS="$(rg -n 'JUCE Assertion failure|Leaked objects detected' "$EVID" || true)"
if [[ -n "$ASSERTIONS" ]]; then
  printf '%s\n' "$ASSERTIONS" > "$EVID/assertions.txt"
  echo "[strict-local-v0] FAIL: assertion/leak detector output found" >&2
  cat "$EVID/assertions.txt" >&2
  exit 1
fi

cat > "$EVID/REPORT.md" <<EOF
# ClaudeMosh Strict Local V0 Gate

Result: PASS
App: $APP
Evidence: $EVID
Debug build dir: $DEBUG_BUILD_DIR
Release build dir: $RELEASE_BUILD_DIR

Checks:
- ui-build
- cmake-build-debug
- cmake-build-release (when $RELEASE_BUILD_DIR exists)
- ctest
- undo-selftest
- default-selftest
- sa3-selftest
- plugin-host-strict
- command-log
- preservation
- sa3-colors
EOF

echo "[strict-local-v0] PASS evidence=$EVID"
