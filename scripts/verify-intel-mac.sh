#!/usr/bin/env bash
# verify-intel-mac.sh — the scripted half of the Intel Mac acceptance pass.
#
# Intel is a SUPPORTED target but is NOT CI-gated, so this script plus the manual
# checklist it prints at the end is the only thing keeping the claim honest. Run it on
# real Intel hardware before shipping a release that touched the build, the bundle, or
# the generative tier. It is READ-ONLY: it builds nothing and installs nothing.
#
# Usage:  scripts/verify-intel-mac.sh [path/to/Mosh.app]
#         (default: newest universal release build, else /Applications/Mosh.app)
# Env:    MOSH_BIN — override the binary outright
#
# Deliberately NOT proven here (needs eyes/ears/hardware — see the checklist at the end):
# audible playback, plugin scan + editor, the full producer loop, the reactive lane.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=(); FAIL=(); SKIP=()
ok()   { PASS+=("$1"); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL+=("$1"); printf '  \033[31m✗\033[0m %s\n' "$1"; }
skip() { SKIP+=("$1"); printf '  \033[33m–\033[0m %s\n' "$1"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

APP="${1:-}"
if [ -z "$APP" ]; then
  APP="$(find "$ROOT/build-macos-universal-release" -maxdepth 4 -name 'Mosh.app' -type d 2>/dev/null | sort | tail -n 1)"
  [ -n "$APP" ] || APP="/Applications/Mosh.app"
fi
BIN="${MOSH_BIN:-$APP/Contents/MacOS/Mosh}"
[ -x "$BIN" ] || { echo "✗ no Mosh binary at $BIN"; exit 2; }

echo "verify-intel-mac: app=$APP"
echo "                  host=$(uname -m)  macOS=$(sw_vers -productVersion 2>/dev/null || echo '?')"

hdr "1. host"
HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  x86_64) ok "running on real Intel hardware (x86_64) — this is the pass that counts" ;;
  arm64)  skip "running on Apple Silicon: the x86_64 slice can only be exercised under Rosetta below.
      Rosetta catches build/link/startup breakage but NOT real-Intel CoreAudio, plugin
      or performance behaviour. A green run here is NOT an Intel hardware pass." ;;
  *)      bad "unexpected host arch: $HOST_ARCH" ;;
esac

hdr "2. bundle is shippable to both architectures"
if "$ROOT/scripts/release/assert-universal.sh" "$APP"; then
  ok "assert-universal (both slices + minimum macOS)"
else
  bad "assert-universal FAILED — this bundle is not shippable to Intel"
fi

hdr "3. the x86_64 slice actually runs"
# On Apple Silicon this goes through Rosetta; on Intel it is simply native.
SESS="verify-intel-$$"; PORT=$((13000 + RANDOM % 3000))
LOG="$(mktemp)"
if [ "$HOST_ARCH" = "arm64" ]; then RUN=(/usr/bin/arch -x86_64 "$BIN"); else RUN=("$BIN"); fi
MOSH_SELFTEST_SESSION="$SESS" MOSH_SERVICE_PORT="$PORT" \
  "${RUN[@]}" --selftest -ApplePersistenceIgnoreState YES > "$LOG" 2>&1
rc=$?
RESULT="$(grep -oE '[0-9]+/[0-9]+ checks passed, [0-9]+ failed' "$LOG" | tail -1)"
if [ "$rc" -eq 0 ] && [ -n "$RESULT" ]; then
  ok "x86_64 --selftest: $RESULT"
else
  bad "x86_64 --selftest failed (exit $rc). Tail:"; tail -n 15 "$LOG" | sed 's/^/      /'
fi
rm -f "$LOG"

hdr "4. generative tier reports itself honestly"
# On Intel there is no MLX, so SA3 must NOT be advertised. This is the check that stops
# the UI showing a green "SA3" badge for renders the preview engine actually produced.
PYOUT="$(cd "$ROOT/service" && python3 - <<'PY' 2>&1
import sys
sys.path.insert(0, ".")
from sa3 import engine
print(f"mlx_importable={engine.mlx_importable()} model_dir_present={engine.model_dir_present()} "
      f"engine_available={engine.engine_available()}")
PY
)"
echo "      $PYOUT"
case "$HOST_ARCH:$PYOUT" in
  x86_64:*mlx_importable=False*engine_available=False*)
    ok "Intel: MLX absent and SA3 correctly reported unavailable (UI will show 'preview')" ;;
  x86_64:*engine_available=True*)
    bad "Intel host is advertising SA3 as available — the drawer will show a green SA3 badge and lie" ;;
  arm64:*)
    skip "Apple Silicon host: MLX present, so this check cannot exercise the Intel path" ;;
  *) bad "could not evaluate SA3 availability: $PYOUT" ;;
esac

hdr "5. python service imports cleanly"
if (cd "$ROOT/service" && python3 -c "import server" >/dev/null 2>&1); then
  ok "service/server.py imports"
else
  bad "service/server.py failed to import"
fi

printf '\n\033[1m── summary ──\033[0m\n'
printf '  passed %d   failed %d   skipped %d\n' "${#PASS[@]}" "${#FAIL[@]}" "${#SKIP[@]}"

cat <<'EOF'

  STILL REQUIRED BY HAND (this script cannot prove any of it):
    □ App launches; WebView UI renders cold.
    □ Transport plays AUDIBLE audio; track + master meters move.
    □ Plugin browser scans; a VST3 and an AU load; a native editor opens.
      First confirm the plugin is loadable at all by an x86_64 host:
        lipo -archs "/path/to/Plugin.vst3/Contents/MacOS/Plugin"
    □ Producer loop: import → move/trim → host a plugin → mix → export a WAV that plays back.
    □ Generative drawer shows the amber "preview" badge; a render completes and auditions.
    □ ./verify.py  — run FROM THE REPO ROOT (it resolves service/server.py CWD-relative,
      and --selftest structurally cannot see the reactive lane).

  Then append the result to the verification log in docs/MACOS_INTEL.md.
EOF

[ "${#FAIL[@]}" -eq 0 ] || exit 1
