#!/usr/bin/env bash
# preflight.sh — run this right before a live playtest. All-green = go.
# Bundles the checks that prove the build is sound: command-surface selftest,
# UI unit tests, the multiplayer relay round-trip, and a real render-to-WAV
# (incl. SA3 if it's set up). Prints one PASS/FAIL summary; exits nonzero on any fail.
#
# Usage:  bash scripts/playtest/preflight.sh
#   MOSH_BIN  override the Mosh binary (default: newest release build, else /Applications)
#   PP_SKIP_VITEST=1   skip the UI unit tests (faster)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

BIN="${MOSH_BIN:-$(find "$ROOT/build-macos-arm64-release" -name Mosh -path '*Mosh.app/Contents/MacOS/*' -type f 2>/dev/null | head -1)}"
[ -x "$BIN" ] && [ -n "$BIN" ] || BIN="/Applications/Mosh.app/Contents/MacOS/Mosh"
[ -x "$BIN" ] || { echo "✗ No Mosh binary. Build first: ./run-mosh.sh deploy"; exit 2; }

PASS=(); FAIL=()
note_pass() { PASS+=("$1"); printf '  \033[32m✓\033[0m %s\n' "$1"; }
note_fail() { FAIL+=("$1"); printf '  \033[31m✗\033[0m %s\n' "$1"; }

echo "Mosh preflight — binary: $BIN"
echo "time: $(date '+%H:%M:%S %Z')"
echo

# 1) Command-surface selftest (isolated session, headless).
echo "[1/4] command-surface selftest…"
S="session-preflight-$$"; rm -rf "$HOME/Library/Mosh/$S" "$HOME/Library/Mosh/${S}-undo" 2>/dev/null
ST_LOG="$(mktemp -t pp-pf-selftest.XXXX.log)"
if MOSH_NO_AUDIO=1 MOSH_SELFTEST_SESSION="$S" "$BIN" --selftest >"$ST_LOG" 2>&1; then
  note_pass "selftest — $(grep -oE '[0-9]+/[0-9]+ checks passed' "$ST_LOG" | tail -1)"
else
  note_fail "selftest — $(grep -oE '[0-9]+/[0-9]+ checks passed|[0-9]+ failed' "$ST_LOG" | tail -1) (see $ST_LOG)"
fi

# 2) UI unit tests (vitest).
if [ "${PP_SKIP_VITEST:-0}" = "1" ]; then
  echo "[2/4] vitest… skipped (PP_SKIP_VITEST=1)"
else
  echo "[2/4] UI unit tests (vitest)…"
  VT_LOG="$(mktemp -t pp-pf-vitest.XXXX.log)"
  if ( cd ui && npm test ) >"$VT_LOG" 2>&1; then
    note_pass "vitest — $(grep -oE 'Tests +[0-9]+ passed[^)]*' "$VT_LOG" | tail -1)"
  else
    note_fail "vitest (see $VT_LOG)"
  fi
fi

# 3) Multiplayer relay round-trip (local stdlib relay).
echo "[3/4] multiplayer relay selftest…"
MP_LOG="$(mktemp -t pp-pf-mp.XXXX.log)"
if MOSH_BIN="$BIN" bash relay/run-mp-selftest.sh >"$MP_LOG" 2>&1; then
  note_pass "MP selftest — $(grep -oE '[0-9]+/[0-9]+ checks passed' "$MP_LOG" | tail -1)"
else
  note_fail "MP selftest (see $MP_LOG)"
fi

# 4) Real render-to-WAV (offline). Add SA3 iff it's wired (service/.sa3.env present).
echo "[4/4] render-to-WAV…"
SA3_FLAG=""; [ -f "$ROOT/service/.sa3.env" ] && SA3_FLAG="--sa3"
VR_LOG="$(mktemp -t pp-pf-verify.XXXX.log)"
if python3 scripts/verify-hardware/verify.py $SA3_FLAG --bin "$BIN" >"$VR_LOG" 2>&1; then
  note_pass "render-to-WAV ${SA3_FLAG:+(incl SA3) }— $(grep -oE '[0-9]+/[0-9]+ checks passed' "$VR_LOG" | tail -1)"
else
  note_fail "render-to-WAV ${SA3_FLAG:+(incl SA3) }(see $VR_LOG)"
fi

echo
echo "──────── preflight summary ────────"
printf 'PASS: %d   FAIL: %d\n' "${#PASS[@]}" "${#FAIL[@]}"
if [ "${#FAIL[@]}" -eq 0 ]; then
  echo "🟢 GO — all preflight checks green."
  exit 0
else
  printf '🔴 NO-GO — failing:\n'; printf '   - %s\n' "${FAIL[@]}"
  exit 1
fi
