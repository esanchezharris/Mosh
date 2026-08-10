#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <Mosh app binary> <evidence prefix>" >&2
  exit 2
fi

repo="$(cd "$(dirname "$0")/.." && pwd)"
app="$1"
prefix="$2"
source "$repo/scripts/auto-loop/lib.sh"

test -x "$app"
trash_root="${MOSH_TEST_TRASH_ROOT:-${HOME:?HOME is required}/.Trash}"
mkdir -p "$(dirname "$prefix")" "$trash_root"
test_root="$(mktemp -d /private/tmp/mosh-c012-root.XXXXXX)"
cf_root="$(mktemp -d /private/tmp/mosh-c012-cf.XXXXXX)"
chmod 700 "$test_root" "$cf_root"
port="$(unique_port)"
test -n "$port"
relay_pid=""

cleanup() {
  local rc=$? test_trash cf_trash
  trap - EXIT INT TERM
  if [ -n "$relay_pid" ] && kill -0 "$relay_pid" 2>/dev/null; then
    kill "$relay_pid" 2>/dev/null || true
    wait "$relay_pid" 2>/dev/null || true
  fi
  al_release_port "$port"
  test_trash="$trash_root/$(basename "$test_root")-$$"
  cf_trash="$trash_root/$(basename "$cf_root")-$$"
  [ ! -e "$test_trash" ] && mv "$test_root" "$test_trash"
  [ ! -e "$cf_trash" ] && mv "$cf_root" "$cf_trash"
  {
    echo "relay_pid=$relay_pid"
    echo "port=$port"
    echo "test_root=$test_root -> $test_trash"
    echo "cf_root=$cf_root -> $cf_trash"
    if lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null; then
      echo "cleanup_error=listener remains"
      rc=1
    else
      echo "listener=absent"
    fi
    echo "exit=$rc"
  } > "$prefix.cleanup.log"
  exit "$rc"
}
trap cleanup EXIT INT TERM

export MOSH_RELAY_BLOB_CORRUPT=corrupttest
export MOSH_RELAY_BLOB_FAIL=failtest
PORT="$port" python3 "$repo/relay/server.py" > "$prefix.relay.log" 2>&1 &
relay_pid=$!
printf 'relay_pid=%s port=%s test_root=%s cf_root=%s\n' \
  "$relay_pid" "$port" "$test_root" "$cf_root" > "$prefix.resources.log"

python3 - "$port" <<'PY'
import sys
import time
import urllib.request

for _ in range(100):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/health", timeout=0.5) as response:
            if response.status == 200:
                break
    except Exception:
        time.sleep(0.05)
else:
    raise SystemExit("relay did not become healthy")
PY

env -u MOSH_SELFTEST_SESSION \
  MOSH_ENABLE_TEST_MOSH_DIR=1 \
  MOSH_TEST_MOSH_DIR="$test_root" \
  CFFIXED_USER_HOME="$cf_root" \
  MOSH_NO_AUDIO=1 \
  MOSH_SELFTEST_MP=1 \
  MOSH_RELAY_URL="http://127.0.0.1:$port" \
  "$app" --selftest -ApplePersistenceIgnoreState YES > "$prefix.app.log" 2>&1

if rg -n 'JUCE Assertion failure|Leaked objects detected' "$prefix.app.log" > "$prefix.binary-errors.log"; then
  exit 1
fi
rg -n 'C012|checks passed, [0-9]+ failed' "$prefix.app.log" > "$prefix.log"
