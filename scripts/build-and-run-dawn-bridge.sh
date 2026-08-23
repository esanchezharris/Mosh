#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_ROOT="${MOSH_DAWN_WORK_DIR:-$HOME/Library/Mosh/work}"
SOURCE_KEY="$(printf '%s' "$ROOT_DIR" | shasum -a 256 | cut -c1-12)"
BUILD_DIR="${MOSH_DAWN_BUILD_DIR:-$WORK_ROOT/build-dawn-bridge-$SOURCE_KEY}"
APP="$BUILD_DIR/src/dawn_bridge/MoshDawnBridge.app"
BINARY="$APP/Contents/MacOS/MoshDawnBridge"
DESCRIPTOR="${MOSH_DAWN_DESCRIPTOR:-$HOME/Library/Application Support/Mosh/DAWN Bridge/remote-script.json}"

configure_and_build() {
  cmake -S "$ROOT_DIR" -B "$BUILD_DIR" -G Ninja \
    -DCMAKE_BUILD_TYPE=Debug \
    -DMOSH_BUILD_APP=OFF \
    -DMOSH_BUILD_UI=OFF \
    -DMOSH_BUILD_TESTS=ON \
    -DMOSH_BUILD_DAWN_BRIDGE=ON
  cmake --build "$BUILD_DIR" --target MoshDawnBridgeResources MoshDawnBridgeTests
}

launch_app() {
  pkill -x MoshDawnBridge >/dev/null 2>&1 || true
  /usr/bin/open -n "$APP"
}

configure_and_build

case "$MODE" in
  run|--run)
    launch_app
    ;;
  debug|--debug)
    lldb -- "$BINARY"
    ;;
  logs|--logs)
    launch_app
    /usr/bin/log stream --info --style compact --predicate 'process == "MoshDawnBridge"'
    ;;
  telemetry|--telemetry)
    launch_app
    /usr/bin/log stream --info --style compact --predicate 'subsystem == "studio.mosh.dawn-bridge"'
    ;;
  verify|--verify)
    ctest --test-dir "$BUILD_DIR" -R '^MoshDawnBridgeTests$' --output-on-failure
    test "$(/usr/libexec/PlistBuddy -c 'Print :LSUIElement' "$APP/Contents/Info.plist")" = true
    test -f "$APP/Contents/Resources/companion/index.html"
    test -f "$APP/Contents/Resources/MoshDawnController/__init__.py"
    launch_app
    sleep 1
    pgrep -x MoshDawnBridge >/dev/null
    /usr/bin/osascript -e 'tell application id "studio.mosh.dawn-bridge" to quit' >/dev/null 2>&1 \
      || pkill -x MoshDawnBridge >/dev/null 2>&1 \
      || true
    for _ in {1..20}; do
      pgrep -x MoshDawnBridge >/dev/null || break
      sleep 0.1
    done
    if [[ -f "$DESCRIPTOR" ]]; then
      rm -f -- "$DESCRIPTOR"
    fi
    ;;
  *)
    echo "usage: $0 [run|debug|logs|telemetry|verify]" >&2
    exit 2
    ;;
esac
