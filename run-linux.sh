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
#                            system deps (see `./run-linux.sh deps`). EXPLORATORY —
#                            the full app is CI-tracked but not yet a supported target.
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
    cmake --preset "$PRESET"
    echo "building Mosh (exploratory — may not fully link on Linux yet)…"
    cmake --build "$BUILD_DIR" --target Mosh
    echo "built Mosh → $BUILD_DIR. Launch it under an X11/Wayland session:"
    echo "  \$(find '$BUILD_DIR' -name Mosh -type f -perm -u+x -print -quit) --selftest"
    ;;

  service)
    echo "starting Mosh generative service (FakeAdapter, stdlib — MOSH_ENABLE_SA3=0)…"
    MOSH_ENABLE_SA3=0 exec bash "$ROOT/service/run.sh"
    ;;

  *)
    echo "usage: $0 [tests|app|service|deps]" >&2
    exit 2
    ;;
esac
