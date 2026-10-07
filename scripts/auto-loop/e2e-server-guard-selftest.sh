#!/usr/bin/env bash
# e2e-server-guard-selftest.sh — the e2e suite must never run against a server that is not
# this tree's Mosh UI.
#
# 2026-10-06: an unrelated project's Vite server was listening on 127.0.0.1:5173 (Playwright's
# default port) and the gate's e2e step reused it: all 542 specs ran against a game page and
# failed, on a tree that passes. Asserted here, on a private loopback port with a throwaway
# HTTP server (no Vite, no browser: the identity project only uses Playwright's `request`):
#
#   1. a foreign page on the e2e port is refused by the "mosh-server-identity" setup
#      project, which names the page (ui/e2e/server-identity.setup.ts);
#   2. a page carrying the Mosh marker passes it;
#   3. with MOSH_E2E_OWN_SERVER=1 (what the gate sets) Playwright refuses to reuse the busy
#      port at all, instead of running against whatever answers there;
#   4. gate.sh's e2e step runs on a reserved port with MOSH_E2E_OWN_SERVER=1.
#
# Needs ui/node_modules (the cheap lane installs it). Exits non-zero on the first failure.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SELF_DIR/../.." && pwd)"
UI="$ROOT/ui"
SANDBOX="$(mktemp -d)"
SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$SANDBOX"; }
trap cleanup EXIT

fail() { printf 'e2e-server-guard-selftest: FAIL: %s\n' "$1" >&2; exit 1; }

[ -x "$UI/node_modules/.bin/playwright" ] || fail "ui/node_modules/.bin/playwright missing (run npm ci in ui/)"

# A free loopback port, chosen by the OS.
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
mkdir -p "$SANDBOX/site"
( cd "$SANDBOX/site" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 ) &
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null || true   # no "Terminated" notice when cleanup stops it
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break
  sleep 0.1
done

identity() {   # extra env assignments, then runs only the identity setup project
  ( cd "$UI" && env -u CI MOSH_E2E_PORT="$PORT" "$@" ./node_modules/.bin/playwright test \
      --project=mosh-server-identity --reporter=line --output="$SANDBOX/out" ) >"$SANDBOX/run.log" 2>&1
}

# 1. A foreign app on the port: refused, by name.
cat >"$SANDBOX/site/index.html" <<'EOF'
<!doctype html><html><head><title>SPIRIT of the WEST HOLLOW RIDGE</title></head>
<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
EOF
identity && fail "a foreign page on the e2e port was accepted"
grep -q "not Mosh's dev server" "$SANDBOX/run.log" || { cat "$SANDBOX/run.log" >&2; fail "the refusal did not say why"; }
grep -q 'SPIRIT of the WEST HOLLOW RIDGE' "$SANDBOX/run.log" || { cat "$SANDBOX/run.log" >&2; fail "the refusal did not name the foreign page"; }

# 2. Mosh's marker on the port: accepted.
cat >"$SANDBOX/site/index.html" <<'EOF'
<!doctype html><html><head><title>Mosh</title><meta name="mosh-app" content="ui" /></head>
<body><div id="root"></div></body></html>
EOF
identity || { cat "$SANDBOX/run.log" >&2; fail "a page carrying the Mosh marker was refused"; }

# 3. The gate's mode: a busy port is refused outright, never reused.
identity MOSH_E2E_OWN_SERVER=1 && fail "MOSH_E2E_OWN_SERVER=1 reused a server already on the port"
grep -qi "already used" "$SANDBOX/run.log" || { cat "$SANDBOX/run.log" >&2; fail "MOSH_E2E_OWN_SERVER=1 did not refuse the busy port"; }

# 4. gate.sh wires the e2e step to a reserved port, in own-server mode.
grep -q 'unique_port "${AL_E2E_PORT_LO' "$ROOT/scripts/auto-loop/gate.sh" \
  || fail "gate.sh does not reserve a port for the e2e step"
grep -q 'MOSH_E2E_PORT="$e2e_port" MOSH_E2E_OWN_SERVER=1' "$ROOT/scripts/auto-loop/gate.sh" \
  || fail "gate.sh does not run e2e on its reserved port with MOSH_E2E_OWN_SERVER=1"

printf 'e2e-server-guard-selftest: PASS\n'
