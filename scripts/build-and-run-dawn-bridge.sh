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
APP_IDENTITY=""
APP_COMMAND=""
OWNED_TEMP_ROOT=""
LAUNCH_SECRET=""
CLEANUP_ARMED=0
TEMP_BASE="${TMPDIR:-/tmp}"
TEMP_BASE="${TEMP_BASE%/}"

stop_launched_app() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    local current_identity
    current_identity="$(ps -p "$APP_PID" -o lstart=,command= 2>/dev/null || true)"
    if [[ -n "$APP_IDENTITY" && "$current_identity" != "$APP_IDENTITY" ]] \
      || [[ -z "$APP_IDENTITY" && "$current_identity" != *"$APP_COMMAND"* ]]; then
      echo "refusing to signal PID $APP_PID after identity changed" >&2
      return 1
    fi
    kill -TERM "$APP_PID"
    for _ in {1..50}; do
      kill -0 "$APP_PID" 2>/dev/null || return 0
      sleep 0.1
    done
    echo "MoshDawnBridge PID $APP_PID did not stop" >&2
    return 1
  fi
}

clean_owned_root() {
  if [[ -z "$OWNED_TEMP_ROOT" ]]; then
    return 0
  fi
  case "$OWNED_TEMP_ROOT" in
    "$TEMP_BASE"/mosh-dawn-verify.*)
      find "$OWNED_TEMP_ROOT" -depth -delete 2>/dev/null || true
      ;;
    *)
      echo "refusing cleanup of unowned root: $OWNED_TEMP_ROOT" >&2
      return 1
      ;;
  esac
  OWNED_TEMP_ROOT=""
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  stop_launched_app || status=$?
  clean_owned_root || status=$?
  exit "$status"
}

arm_cleanup() {
  if [[ "$CLEANUP_ARMED" -eq 0 ]]; then
    trap cleanup EXIT INT TERM
    CLEANUP_ARMED=1
  fi
}

disarm_cleanup() {
  trap - EXIT INT TERM
  CLEANUP_ARMED=0
}

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

descriptor_ready() {
  local pid="$1"
  local path="$2"
  local expected_secret="$3"
  [[ -f "$path" && ! -L "$path" ]] || return 1
  [[ "$(stat -f '%Lp' "$path")" = "600" ]] || return 1
  local port
  port="$(/usr/bin/python3 - "$path" "$expected_secret" <<'PY'
import json, re, sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    value = json.load(handle)
secret = value.get("secret")
valid = (set(value) == {"protocol", "host", "port", "secret"}
         and value["protocol"] == 1 and value["host"] == "127.0.0.1"
         and isinstance(value["port"], int) and 0 < value["port"] < 65536
         and secret == sys.argv[2] and re.fullmatch(r"[0-9a-f]{64}", secret))
if not valid:
    raise SystemExit(1)
print(value["port"])
PY
)" || return 1
  /usr/sbin/lsof -nP -a -p "$pid" -iTCP:"$port" -sTCP:LISTEN 2>/dev/null \
    | grep -q LISTEN
}

launch_app() {
  ensure_no_active_bridge
  if [[ -e "$DESCRIPTOR" || -L "$DESCRIPTOR" ]]; then
    echo "refusing pre-existing descriptor: $DESCRIPTOR" >&2
    return 1
  fi
  LAUNCH_SECRET="$(/usr/bin/openssl rand -hex 32)"
  MOSH_DAWN_DESCRIPTOR="$DESCRIPTOR" MOSH_DAWN_SECRET="$LAUNCH_SECRET" \
    "$BINARY" >/dev/null 2>&1 &
  APP_PID=$!
  APP_COMMAND="$BINARY"
  arm_cleanup
  APP_IDENTITY="$(ps -p "$APP_PID" -o lstart=,command= 2>/dev/null || true)"
  [[ -n "$APP_IDENTITY" ]] || return 1
  for _ in {1..50}; do
    kill -0 "$APP_PID" 2>/dev/null || {
      echo "launched MoshDawnBridge exited before becoming ready" >&2
      APP_PID=""
      return 1
    }
    descriptor_ready "$APP_PID" "$DESCRIPTOR" "$LAUNCH_SECRET" && return 0
    sleep 0.1
  done
  echo "MoshDawnBridge PID $APP_PID did not publish its owned descriptor" >&2
  return 1
}

main() {
 configure_and_build
 case "$MODE" in
  run|--run)
    launch_app
    disarm_cleanup
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
    ctest --test-dir "$BUILD_DIR" -R '^MoshDawnBridge' --output-on-failure
    test "$(/usr/libexec/PlistBuddy -c 'Print :LSUIElement' "$APP/Contents/Info.plist")" = true
    test -f "$APP/Contents/Resources/companion/index.html"
    test -f "$APP/Contents/Resources/MoshDawnController/__init__.py"
    VERIFY_ROOT="$(mktemp -d "$TEMP_BASE/mosh-dawn-verify.XXXXXX")"
    chmod 700 "$VERIFY_ROOT"
    OWNED_TEMP_ROOT="$VERIFY_ROOT"
    arm_cleanup
    DESCRIPTOR="$VERIFY_ROOT/remote-script.json"
    launch_app
    test -f "$DESCRIPTOR"
    stop_launched_app
    APP_PID=""
    test ! -e "$DESCRIPTOR"
    rmdir "$VERIFY_ROOT"
    OWNED_TEMP_ROOT=""
    disarm_cleanup
    ;;
  *)
    echo "usage: $0 [run|debug|logs|telemetry|verify]" >&2
    exit 2
    ;;
 esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
