#!/usr/bin/env bash
# port-ownership-selftest.sh — unit test for the service port/process OWNERSHIP rules in
# lib.sh (unique_port / kill_stray_services / al_release_*). This is the regression guard
# for the cross-worktree teardown bug: several agent worktrees gate concurrently on this
# machine, and a gate run must only ever kill a service it owns.
#
# What went wrong before (both halves are asserted below):
#
#   1. unique_port() returned the first port in 8800-8899 with no LISTENER — a check-then-act
#      race. The generative service does not bind until the selftest reaches its first
#      generative check, seconds to minutes after the port was chosen, so two concurrent
#      worktrees both saw the port free and both took it. The teardown then ran
#      `lsof -ti tcp:$port | kill -9`, killing the OTHER worktree's live service mid-run.
#      (Observed: three sequential runs in one worktree all chose 8800.)
#
#   2. kill_stray_services() ran three UNSCOPED machine-wide pkills. Two of them
#      (service/server.py, service/run.sh) matched nothing at all — service/run.sh does
#      `cd "$(dirname "$0")"` and `exec "$PY" server.py`, so the live process argv is
#      "<python> server.py" with no path in it. The third (relay/server.py) DID match, and
#      the gate never starts a relay, so it could only ever kill someone else's.
#
# Pure filesystem + loopback sockets on a private high port band; no npm, no git, no
# network, no Mosh binary. Exits non-zero on the first failed assertion.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SANDBOX="$(mktemp -d)"
# Hermetic: point the port-lock registry at the sandbox so a real concurrent gate on this
# machine neither sees our locks nor we theirs. The BAND is also private (19xxx) so we
# never bind, probe, or kill anything in the 8800-8899 band a real gate uses.
export MOSH_AUTOLOOP_HOME="$SANDBOX/auto-loop-home"
export AL_PORT_SPAN=10
# A PRIVATE 100-port window per test process. The lock registry above is sandboxed, but the
# fixtures bind REAL OS ports — and this repo's normal state is several worktrees gating at
# once, so two copies of this test sharing a window would reap each other's fixtures and
# flake. Seed from $$, then step until a window with no listeners is found.
_pick_window() {
  local base i
  for i in $(seq 0 9); do
    base=$(( 19000 + ((($$ % 90) + i) % 90) * 100 ))
    lsof -ti tcp:"$base"-$((base + 99)) -sTCP:LISTEN >/dev/null 2>&1 || { printf '%s\n' "$base"; return 0; }
  done
  printf '19000\n'
}
AL_PORT_LO="$(_pick_window)"
AL_PORT_HI=$((AL_PORT_LO + 99))
export AL_PORT_LO AL_PORT_HI
printf 'port band for this run: %s-%s (pid %s)\n' "$AL_PORT_LO" "$AL_PORT_HI" "$$"

# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"
set +e -uo pipefail   # lib.sh turns on errexit; we assert on failures instead

# Fixture pids are recorded in a FILE, not a variable: the helpers below run inside `$( )`
# command substitutions (subshells), so an assignment there never reaches this shell.
KIDS_FILE="$SANDBOX/kids"
: > "$KIDS_FILE"
cleanup() {
  local k
  for k in $(cat "$KIDS_FILE" 2>/dev/null); do kill -9 "$k" 2>/dev/null; done
  type al_release_all_ports >/dev/null 2>&1 && al_release_all_ports 2>/dev/null
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

FAILED=0
ok()   { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; FAILED=1; }

# ── fixtures ─────────────────────────────────────────────────────────────────────
# A listener whose argv looks like the real generative service. run.sh execs
# `"$PY" server.py` from inside service/, so the real argv is "<python> server.py" — we
# reproduce that shape exactly, since matching it is the whole question.
start_fake_service() {
  local port="$1" dir="$SANDBOX/svc"
  mkdir -p "$dir"
  cat > "$dir/server.py" <<'PY'
import socket, sys, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(8)
time.sleep(300)
PY
  # stdout/stderr MUST be redirected: a background child that inherits the command
  # substitution's pipe keeps it open, so `$(start_fake_service …)` would block until the
  # child exits rather than until the function returns.
  ( cd "$dir" && exec python3 server.py "$port" ) >/dev/null 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" >> "$KIDS_FILE"
  _await_listen "$port" && printf '%s\n' "$pid"
}

# A listener that is NOT a Mosh service (an unrelated dev server that happens to sit on a
# port inside our band). The teardown must never kill this, owned port or not.
start_foreign_listener() {
  local port="$1" dir="$SANDBOX/foreign"
  mkdir -p "$dir"
  cat > "$dir/notmosh.py" <<'PY'
import socket, sys, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(8)
time.sleep(300)
PY
  ( cd "$dir" && exec python3 notmosh.py "$port" ) >/dev/null 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" >> "$KIDS_FILE"
  _await_listen "$port" && printf '%s\n' "$pid"
}

_await_listen() {
  local port="$1" i
  for i in $(seq 1 60); do
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  return 1
}

alive() { kill -0 "$1" 2>/dev/null; }

# ── 1. concurrent allocation hands out DISJOINT blocks ───────────────────────────
# The check-then-act version returned the same base port to every concurrent caller.
printf '\n[1] concurrent unique_port callers get disjoint blocks\n'
CONC=6
: > "$SANDBOX/alloc.txt"
for i in $(seq 1 "$CONC"); do
  (
    # A separate PROCESS per caller: ownership is stamped with $$, so this is the real
    # shape of N concurrent gate runs on one machine.
    p="$(unique_port "$AL_PORT_LO" "$AL_PORT_HI" 2>/dev/null)"
    printf '%s\n' "$p" >> "$SANDBOX/alloc.txt"
    sleep 2          # hold the reservation, exactly as a gate holds it across a selftest
  ) &
done
wait
GOT="$(grep -c . "$SANDBOX/alloc.txt")"
UNIQ="$(sort -u "$SANDBOX/alloc.txt" | grep -c .)"
if [ "$GOT" = "$CONC" ] && [ "$UNIQ" = "$CONC" ]; then
  ok "$CONC concurrent callers got $UNIQ distinct ports: $(sort -n "$SANDBOX/alloc.txt" | tr '\n' ' ')"
else
  fail "expected $CONC distinct ports, got $GOT allocations / $UNIQ distinct: $(sort -n "$SANDBOX/alloc.txt" | tr '\n' ' ')"
fi
# Blocks must not overlap either — a base 10 apart is disjoint, 1 apart is not.
OVERLAP=false
PREV=""
for b in $(sort -n "$SANDBOX/alloc.txt"); do
  [ -n "$PREV" ] && [ $((b - PREV)) -lt "$AL_PORT_SPAN" ] && OVERLAP=true
  PREV="$b"
done
[ "$OVERLAP" = false ] && ok "allocated blocks are disjoint (>= $AL_PORT_SPAN apart)" \
                       || fail "allocated blocks OVERLAP — a service may drift onto a rival's port"
# The holders have exited, so their locks are stale; reclaim happens lazily below.
rm -rf "$MOSH_AUTOLOOP_HOME/ports"

# ── 2. a port we do NOT own is never killed ──────────────────────────────────────
# This is the cross-worktree bug itself: worktree B tearing down "its" port killed the
# service worktree A was mid-run against.
printf '\n[2] a service on a port owned by ANOTHER run survives our teardown\n'
RIVAL_PORT=$((AL_PORT_LO + 50))
mkdir -p "$MOSH_AUTOLOOP_HOME/ports/$RIVAL_PORT.lock"
# Stamp it with a LIVE pid that is not us (this shell's parent will do).
printf '%s\n' "$PPID" > "$MOSH_AUTOLOOP_HOME/ports/$RIVAL_PORT.lock/owner"
RIVAL_PID="$(start_fake_service "$RIVAL_PORT")"
if [ -z "$RIVAL_PID" ]; then
  fail "could not start the rival fake service on $RIVAL_PORT"
else
  kill_stray_services "$RIVAL_PORT"
  sleep 0.5
  alive "$RIVAL_PID" && ok "rival service (pid $RIVAL_PID, port $RIVAL_PORT) survived" \
                     || fail "rival service on $RIVAL_PORT was KILLED — teardown is not scoped to owned ports"
  kill -9 "$RIVAL_PID" 2>/dev/null
fi
rm -rf "$MOSH_AUTOLOOP_HOME/ports"

# ── 3. an unrelated `relay/server.py` process survives ───────────────────────────
# The old machine-wide `pkill -f 'relay/server\.py'` killed the owner's hand-started relay
# (docs/MULTIPLAYER.md: `PORT=8771 python3 relay/server.py`) on every gate run. A gate
# never starts a relay, so it owns none and must never kill one.
printf '\n[3] an unrelated relay/server.py process survives a gate teardown\n'
mkdir -p "$SANDBOX/relay"
cat > "$SANDBOX/relay/server.py" <<'PY'
import time
time.sleep(300)
PY
( cd "$SANDBOX" && exec python3 relay/server.py ) >/dev/null 2>&1 &
RELAY_PID=$!
printf '%s\n' "$RELAY_PID" >> "$KIDS_FILE"
sleep 1
if ! alive "$RELAY_PID"; then
  fail "fixture relay never started"
else
  kill_stray_services
  MYPORT="$(unique_port "$AL_PORT_LO" "$AL_PORT_HI")"
  kill_stray_services "$MYPORT"
  al_release_port "$MYPORT"
  sleep 0.5
  alive "$RELAY_PID" && ok "unrelated relay/server.py (pid $RELAY_PID) survived" \
                     || fail "unrelated relay/server.py was KILLED — teardown is still machine-wide"
  kill -9 "$RELAY_PID" 2>/dev/null
fi
rm -rf "$MOSH_AUTOLOOP_HOME/ports"

# ── 4. our OWN stray service on an owned port IS still killed ────────────────────
# The fix must not weaken cleanup: the whole point of the teardown is that a wedged or
# orphaned service of ours never survives into the next run.
printf '\n[4] our own stray service on an owned port is still reaped\n'
MINE="$(unique_port "$AL_PORT_LO" "$AL_PORT_HI")"
if [ -z "$MINE" ]; then
  fail "unique_port returned nothing"
else
  MINE_PID="$(start_fake_service "$MINE")"
  if [ -z "$MINE_PID" ]; then
    fail "could not start the fake service on our own port $MINE"
  else
    kill_stray_services "$MINE"
    sleep 0.5
    alive "$MINE_PID" && fail "our own stray service on owned port $MINE SURVIVED — teardown is inert" \
                      || ok "own stray service (pid $MINE_PID, port $MINE) reaped"
  fi
  # …and across the whole owned block, since server.py's _bind_with_fallback walks up to
  # 10 ports on collision, so a drifted service is still ours.
  DRIFT=$((MINE + 3))
  DRIFT_PID="$(start_fake_service "$DRIFT")"
  if [ -z "$DRIFT_PID" ]; then
    fail "could not start the drifted fake service on $DRIFT"
  else
    kill_stray_services "$MINE"
    sleep 0.5
    alive "$DRIFT_PID" && fail "drifted service on $DRIFT (inside our block) survived" \
                       || ok "drifted service inside the owned block (port $DRIFT) reaped"
  fi
  al_release_port "$MINE"
fi

# ── 5. a NON-Mosh listener on a port we own is left alone ────────────────────────
# Owning the reservation is not a licence to kill: a foreign process that bound a port in
# our block is not ours to -9. (The old code used `lsof -ti tcp:$port`, which also matches
# CLIENTS connected to the port — it could kill the very Mosh binary under test.)
printf '\n[5] a non-Mosh listener on an owned port is left alone\n'
MINE2="$(unique_port "$AL_PORT_LO" "$AL_PORT_HI")"
FOREIGN_PID="$(start_foreign_listener "$((MINE2 + 1))")"
if [ -z "$FOREIGN_PID" ]; then
  fail "could not start the foreign listener"
else
  kill_stray_services "$MINE2" 2>/dev/null
  sleep 0.5
  alive "$FOREIGN_PID" && ok "foreign listener (pid $FOREIGN_PID) on owned port survived" \
                       || fail "a non-Mosh listener was KILLED just for sitting in our block"
  kill -9 "$FOREIGN_PID" 2>/dev/null
fi
al_release_port "$MINE2"

# ── 6. a lock whose owner is dead is reclaimed ───────────────────────────────────
# Otherwise a crashed gate would permanently burn a block out of the band.
printf '\n[6] a lock left by a dead run is reclaimable\n'
DEAD_PORT="$AL_PORT_LO"
mkdir -p "$MOSH_AUTOLOOP_HOME/ports/$DEAD_PORT.lock"
# A pid that cannot be alive: spawn true and reap it, then reuse its (now free) pid.
( exit 0 ) & DEADPID=$!; wait "$DEADPID" 2>/dev/null
printf '%s\n' "$DEADPID" > "$MOSH_AUTOLOOP_HOME/ports/$DEAD_PORT.lock/owner"
RECLAIMED="$(unique_port "$AL_PORT_LO" "$AL_PORT_HI")"
[ "$RECLAIMED" = "$DEAD_PORT" ] && ok "stale lock on $DEAD_PORT reclaimed" \
                                || fail "stale lock on $DEAD_PORT not reclaimed (got '$RECLAIMED')"
al_release_all_ports

# ── 7. release makes the block available again ───────────────────────────────────
printf '\n[7] releasing a block returns it to the band\n'
A="$(unique_port "$AL_PORT_LO" "$AL_PORT_HI")"; al_release_port "$A"
B="$(unique_port "$AL_PORT_LO" "$AL_PORT_HI")"
[ -n "$A" ] && [ "$A" = "$B" ] && ok "block $A released and re-acquired" \
                              || fail "released block not reusable (first=$A second=$B)"
al_release_all_ports

# ── 8. the block span still covers server.py's bind fallback ─────────────────────
# The whole "a drifting service stays on ports we own" guarantee rests on
# AL_PORT_SPAN >= service/server.py's _bind_with_fallback(tries=…). If someone widens the
# fallback, a service can land on a rival's reserved port and we are back to worktrees
# killing each other — silently, because nothing else would notice.
printf '\n[8] AL_PORT_SPAN still covers server.py _bind_with_fallback\n'
SERVER_PY="$SELF_DIR/../../service/server.py"
DEFAULT_SPAN=10          # lib.sh's AL_PORT_SPAN default (this test overrides it)
if [ ! -f "$SERVER_PY" ]; then
  fail "service/server.py not found at $SERVER_PY — cannot check the fallback range"
else
  TRIES="$(grep -Eo '_bind_with_fallback\(host[^)]*tries: *int *= *[0-9]+' "$SERVER_PY" \
           | grep -Eo '[0-9]+$' | head -1)"
  if [ -z "$TRIES" ]; then
    fail "could not parse the tries= default out of _bind_with_fallback — check service/server.py"
  elif [ "$TRIES" -le "$DEFAULT_SPAN" ]; then
    ok "server.py falls back over $TRIES ports, AL_PORT_SPAN default is $DEFAULT_SPAN"
  else
    fail "server.py falls back over $TRIES ports but AL_PORT_SPAN default is only $DEFAULT_SPAN — a service can drift onto another run's reserved port"
  fi
fi

if [ "$FAILED" = 0 ]; then printf '\nport-ownership-selftest: PASS\n'; else printf '\nport-ownership-selftest: FAIL\n'; exit 1; fi
