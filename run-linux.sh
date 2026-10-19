#!/usr/bin/env bash
# run-linux.sh — Linux (x86_64) counterpart to the macOS run-mosh.sh, for the
# exploratory Linux build spike (FIT-011). run-mosh.sh stays macOS-only (codesign,
# Info.plist, .app bundles, BSD `stat -f`); this script is the portable Linux path.
#
# Usage:
#   ./run-linux.sh tests     configure + build the headless MoshTests target and run
#                            it via ctest. Needs only build-essential + cmake + ninja
#                            (no WebKitGTK / ALSA / node) — the "smallest real build".
#   ./run-linux.sh app       build the full GUI app. Needs the WebKitGTK/ALSA/node
#                            system deps (see `./run-linux.sh deps`). Required in linux-ci.
#   ./run-linux.sh selftest  run the built app's --selftest ×3 + --selftest-undo (under
#                            xvfb-run when there is no DISPLAY) against the Linux floors.
#                            Debug by default (what linux-ci runs). linux-x64-release is
#                            the gate's flavour, but GCC -O3 on SelfTest.cpp takes >80 min.
#   ./run-linux.sh service   start the cross-platform Python generative service
#                            (FakeAdapter, stdlib only — forces MOSH_ENABLE_SA3=0).
#   ./run-linux.sh deps      print the apt-get line for the full-app system deps.
#
# Env knobs: MOSH_LINUX_PRESET (default linux-x64-debug — set linux-x64-release for
#            an optimized build), MOSH_ENABLE_JACK (0/1, adds the JACK audio backend).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-tests}"
PRESET="${MOSH_LINUX_PRESET:-linux-x64-debug}"
BUILD_DIR="$ROOT/build-linux-x64"
[[ "$PRESET" == *release* ]] && BUILD_DIR="$ROOT/build-linux-x64-release"

# Full-app system deps (Debian/Ubuntu names). The headless `tests` path needs NONE
# of the GUI/audio ones — only build-essential + cmake + ninja-build.
APT_DEPS="build-essential cmake ninja-build pkg-config \
libwebkit2gtk-4.1-dev libgtk-3-dev libasound2-dev libfreetype6-dev \
libx11-dev libxext-dev libxinerama-dev libxrandr-dev libxcursor-dev \
libxcomposite-dev libcurl4-openssl-dev nodejs npm"

# tracktion_engine pulls JUCE as a recursive submodule whose URL is SSH
# (git@github.com:…). Rewrite to HTTPS so the FetchContent clone works without SSH
# keys — this is the exact rewrite cmake/Dependencies.cmake documents.
ensure_git_https() {
  git config --global url."https://github.com/".insteadOf "git@github.com:" 2>/dev/null || true
}

case "$MODE" in
  deps)
    echo "sudo apt-get update && sudo apt-get install -y \\"
    echo "  $APT_DEPS"
    ;;

  tests)
    ensure_git_https
    echo "configuring headless (MoshTests only — no GUI/audio system deps needed)…"
    # Override the full-parity preset to APP/UI OFF so this configures on a bare box
    # with no WebKitGTK/ALSA/node (JUCE only runs its webkit pkg-config check when a
    # target links juce_gui_extra, i.e. the app — which we are not building here).
    cmake --preset "$PRESET" \
      -DMOSH_BUILD_APP=OFF -DMOSH_BUILD_UI=OFF -DMOSH_BUILD_PLUGIN_FIXTURES=OFF
    echo "building MoshTests…"
    cmake --build "$BUILD_DIR" --target MoshTests
    echo "running MoshTests (via ctest — sets the repo-root working dir)…"
    exec ctest --test-dir "$BUILD_DIR" -R MoshTests --output-on-failure
    ;;

  app)
    ensure_git_https
    echo "configuring full app (needs WebKitGTK + ALSA + node — see './run-linux.sh deps')…"
    # MoshSkillIdentityGate runs tsx from ui/node_modules before the build installs ui deps.
    if [ ! -d "$ROOT/ui/node_modules" ]; then
      echo "installing ui deps (npm ci)…"
      (cd "$ROOT/ui" && npm ci --no-audit --no-fund)
    fi
    cmake --preset "$PRESET"
    echo "building Mosh…"
    cmake --build "$BUILD_DIR" --target Mosh
    echo "built Mosh → $BUILD_DIR. Launch it under an X11/Wayland session:"
    echo "  \$(find '$BUILD_DIR' -name Mosh -type f -perm -u+x -print -quit)"
    echo "or run its headless self-tests: ./run-linux.sh selftest"
    ;;

  selftest)
    # Linux counterpart of the native gate's run_selftest_x3 (scripts/auto-loop/gate.sh):
    # --selftest ×N (default 3) then --selftest-undo once, against an already-built app
    # (run `./run-linux.sh app` first). A run fails on a non-zero exit, any failed check, a
    # missing summary (crash), a check count below the Linux floor, or counts that differ
    # between runs. JUCE assertions are fatal only for a Release build, mirroring the gate's
    # strict rule (jassert compiles out there, so it should never see one); in Debug they
    # are live, reported but not fatal — see docs/2026-07-07-linux-build-spike.md.
    # shellcheck source=scripts/auto-loop/lib.sh
    source "$ROOT/scripts/auto-loop/lib.sh"   # parse_selftest_tally, count_juce_asserts
    FLAVOR=Debug; [[ "$PRESET" == *release* ]] && FLAVOR=Release
    BIN="${MOSH_LINUX_BIN:-$BUILD_DIR/Mosh_artefacts/$FLAVOR/Mosh}"
    [ -x "$BIN" ] || { echo "no built app at $BIN — run './run-linux.sh app' first" >&2; exit 1; }
    RUNS="${MOSH_SELFTEST_RUNS:-3}"
    # Floors: the Linux check counts recorded on 2026-10-15 (see the spike doc). The mac
    # gate's MOSH_SELFTEST_BASELINE is a separate number for a separate platform.
    FLOOR="${MOSH_LINUX_SELFTEST_FLOOR:-5004}"
    UNDO_FLOOR="${MOSH_LINUX_SELFTEST_UNDO_FLOOR:-92}"
    WRAP=()
    if [ -z "${DISPLAY:-}" ]; then
      command -v xvfb-run >/dev/null || { echo "no DISPLAY and no xvfb-run (apt install xvfb)" >&2; exit 1; }
      WRAP=(xvfb-run -a)
    fi
    LOG_DIR="${MOSH_SELFTEST_LOG_DIR:-$(mktemp -d)}"; mkdir -p "$LOG_DIR"
    SESS_PREFIX="_harness/session-linux-selftest-$$"
    STATUS=0; FIRST_N=""

    # run_one <label> <flag> <full|undo> <floor>
    run_one() {
      local label="$1" flag="$2" what="$3" floor="$4" log rc n f a
      log="$LOG_DIR/$label.log"
      echo "── $label: $flag"
      set +e
      MOSH_ENABLE_SA3=0 MOSH_ENABLE_TRANSFORM=0 MOSH_SELFTEST_SESSION="$SESS_PREFIX-$label" \
        timeout "${MOSH_SELFTEST_TIMEOUT:-1800}" ${WRAP[@]+"${WRAP[@]}"} "$BIN" "$flag" >"$log" 2>&1
      rc=$?
      set -e
      if [ "$what" = undo ]; then
        # "===== P/T focused undo checks passed, F failed =====" — parse_selftest_tally's
        # regex wants "N checks passed", so normalise the undo summary into that shape.
        read -r n f < <(sed -E 's/ focused undo checks passed/ checks passed/' "$log" \
                          | parse_selftest_tally /dev/stdin)
      else
        read -r n f < <(parse_selftest_tally "$log")
      fi
      a="$(count_juce_asserts "$log")"
      local bad=""
      [ "$rc" -ne 0 ] && bad="$bad rc=$rc"
      [ "$n" = "-1" ] && bad="$bad no-summary"
      [ "$f" != "0" ] && bad="$bad failed=$f"
      [ "$n" != "-1" ] && [ "$n" -lt "$floor" ] && bad="$bad below-floor($n<$floor)"
      [ "$FLAVOR" = Release ] && [ "$a" != "0" ] && bad="$bad asserts=$a"
      echo "   checks=$n failed=$f asserts=$a rc=$rc floor=$floor log=$log"
      if [ -n "$bad" ]; then
        echo "   FAIL:$bad"
        grep -E '^  FAIL ' "$log" | head -40 || true
        grep 'JUCE Assertion' "$log" | sort | uniq -c | sort -rn | head -20 || true
        tail -20 "$log"
        STATUS=1
      fi
      LAST_N="$n"
    }

    for i in $(seq 1 "$RUNS"); do
      run_one "r$i" --selftest full "$FLOOR"
      if [ -z "$FIRST_N" ]; then FIRST_N="$LAST_N"
      elif [ "$LAST_N" != "$FIRST_N" ]; then echo "   FAIL: non-deterministic check count ($LAST_N vs $FIRST_N)"; STATUS=1; fi
    done
    run_one undo --selftest-undo undo "$UNDO_FLOOR"

    # Reclaim only the sessions this invocation created (the gate does the same after a
    # pass); a failing run keeps them for inspection.
    if [ "$STATUS" -eq 0 ]; then
      rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/Mosh/$SESS_PREFIX"-*
      echo "selftest: PASS ($RUNS× --selftest at $FIRST_N checks, --selftest-undo at $LAST_N; $FLAVOR)"
    else
      echo "selftest: FAIL — logs in $LOG_DIR" >&2
    fi
    exit "$STATUS"
    ;;

  service)
    echo "starting Mosh generative service (FakeAdapter, stdlib — MOSH_ENABLE_SA3=0)…"
    MOSH_ENABLE_SA3=0 exec bash "$ROOT/service/run.sh"
    ;;

  *)
    echo "usage: $0 [tests|app|selftest|service|deps]" >&2
    exit 2
    ;;
esac
