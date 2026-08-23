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
APP_PID=""

stop_launched_app() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM "$APP_PID"
    for _ in {1..50}; do
      kill -0 "$APP_PID" 2>/dev/null || return 0
      sleep 0.1
    done
    echo "MoshDawnBridge PID $APP_PID did not stop" >&2
    return 1
  fi
}

trap stop_launched_app INT TERM

configure_and_build() {
  cmake -S "$ROOT_DIR" -B "$BUILD_DIR" -G Ninja \
    -DCMAKE_BUILD_TYPE=Debug \
    -DMOSH_BUILD_APP=OFF \
    -DMOSH_BUILD_UI=OFF \
    -DMOSH_BUILD_TESTS=ON \
    -DMOSH_BUILD_DAWN_BRIDGE=ON
  cmake --build "$BUILD_DIR" --target MoshDawnBridgeResources MoshDawnBridgeTests
}

ensure_no_active_bridge() {
  local active
  active="$(pgrep -x MoshDawnBridge || true)"
  if [[ -n "$active" ]]; then
    echo "MoshDawnBridge already active (PID(s): $active); refusing to interfere" >&2
    return 1
  fi
}

launch_app() {
  ensure_no_active_bridge
  MOSH_DAWN_DESCRIPTOR="$DESCRIPTOR" "$BINARY" >/dev/null 2>&1 &
  APP_PID=$!
  for _ in {1..50}; do
    kill -0 "$APP_PID" 2>/dev/null || {
      echo "launched MoshDawnBridge exited before becoming ready" >&2
      APP_PID=""
      return 1
    }
    [[ -f "$DESCRIPTOR" ]] && break
    sleep 0.1
  done
  if [[ ! -f "$DESCRIPTOR" ]]; then
    echo "MoshDawnBridge PID $APP_PID did not publish its descriptor" >&2
    return 1
  fi
}

configure_and_build

case "$MODE" in
  run|--run)
    launch_app
    ;;
  debug|--debug)
    ensure_no_active_bridge
    env MOSH_DAWN_DESCRIPTOR="$DESCRIPTOR" lldb -- "$BINARY"
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
    VERIFY_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mosh-dawn-verify.XXXXXX")"
    DESCRIPTOR="$VERIFY_ROOT/remote-script.json"
    launch_app
    test -f "$DESCRIPTOR"
    stop_launched_app
    APP_PID=""
    test ! -e "$DESCRIPTOR"
    rmdir "$VERIFY_ROOT"
    ;;
  *)
    echo "usage: $0 [run|debug|logs|telemetry|verify]" >&2
    exit 2
    ;;
esac
