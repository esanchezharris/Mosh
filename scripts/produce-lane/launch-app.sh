#!/usr/bin/env bash
# launch-app.sh — start ONE headless-ish Mosh GUI instance with the design-lab
# feed (companion HTTP server, port 47873 by default) and the produce-lane
# brain env wired in, for the overnight driver to talk to over HTTP
# (ui/scripts/produceLiveRun.mts). This launches a real Mosh.app process — the
# owner's `/Applications/Mosh.app` instance (if any) is a SEPARATE process and
# is never touched here.
#
# Usage:
#   scripts/produce-lane/launch-app.sh [--bin <path>] [--model sonnet|opus] [--wait-health-s N]
#
# Prints exactly one line on success: `pid=<PID> port=<PORT> token_file=<PATH>`.
# Also writes:
#   $PRODUCE_AB_DIR/runs/app.pid    — the launched PID (for watchdog.sh/overnight.sh)
#   $PRODUCE_AB_DIR/runs/app.log    — stdout+stderr of the app process
#   $PRODUCE_AB_DIR/.lab-token      — the random lab token, mode 600
#
# Refuses to launch (exit 1) if a Mosh.app process is already running — SIGTERM
# it yourself first (`kill <pid>`, then wait) if that's YOUR worktree launch;
# never touch a PID you didn't start. Never uses kill -9 here — see
# scripts/produce-lane/README.md's run-safety section.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

BIN_OVERRIDE=""
MODEL="${MODEL:-sonnet}"
WAIT_HEALTH_S=180
while [ $# -gt 0 ]; do
  case "$1" in
    --bin) BIN_OVERRIDE="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --wait-health-s) WAIT_HEALTH_S="$2"; shift 2 ;;
    *) echo "launch-app.sh: unknown arg $1" >&2; exit 2 ;;
  esac
done

PRODUCE_AB_DIR="${MOSH_PRODUCE_AB_DIR:-$HOME/Library/Mosh/produce-ab/$(date +%Y-%m-%d)}"
RUNS_DIR="$PRODUCE_AB_DIR/runs"
mkdir -p "$RUNS_DIR"
APP_LOG="$RUNS_DIR/app.log"
PID_FILE="$RUNS_DIR/app.pid"
TOKEN_FILE="$PRODUCE_AB_DIR/.lab-token"

# ── refuse if an instance is already running ────────────────────────────────
# Matches ANY Mosh.app (this worktree's build or /Applications') on purpose —
# the lab feed binds a LAN-wide HTTP port, and two instances racing for it is
# a worse failure mode than a loud refusal here.
existing="$(pgrep -f 'Mosh\.app/Contents/MacOS/Mosh' || true)"
if [ -n "$existing" ]; then
  echo "launch-app.sh: refusing to launch — Mosh.app already running (pid(s): $(echo "$existing" | tr '\n' ' '))" >&2
  echo "  If this is YOUR earlier worktree launch: kill <pid> (SIGTERM), wait for it to exit, then retry." >&2
  echo "  If this is the owner's /Applications/Mosh.app: leave it running and do not launch a second instance." >&2
  exit 1
fi

# ── resolve the binary ──────────────────────────────────────────────────────
if [ -n "$BIN_OVERRIDE" ]; then
  BIN="$BIN_OVERRIDE"
elif [ -x "$ROOT/build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh" ]; then
  BIN="$ROOT/build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh"
elif [ -x "$ROOT/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh" ]; then
  BIN="$ROOT/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh"
else
  echo "launch-app.sh: no built Release Mosh binary found at either" >&2
  echo "  $ROOT/build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh" >&2
  echo "  $ROOT/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh" >&2
  echo "  (pass --bin <path> to override; this script never builds)" >&2
  exit 1
fi

# ── token ────────────────────────────────────────────────────────────────────
TOKEN="$(uuidgen)"
umask 077
printf '%s' "$TOKEN" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"

# ── env ──────────────────────────────────────────────────────────────────────
# Owner brain-env first (API keys etc — OPENROUTER_API_KEY lives here), so the
# produce-lane overrides below win on anything they both set.
if [ -f "$HOME/.config/mosh/env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HOME/.config/mosh/env"
  set +a
fi

export MOSH_LAB_FEED=1
export MOSH_LAB_TOKEN="$TOKEN"
export MOSH_ENABLE_SA3=1
# Owner-runtime autospawn off: no local mlx_lm.server child, no 8091 port
# collision with the owner's launchd Qwen agent (owner-runtime-port-orphan
# incident) — OwnerRuntime.cpp:31-37 reads `enabled=false` for a nonexistent
# config path.
export MOSH_OWNER_RUNTIME_CONFIG=/nonexistent
export MOSH_IGNORE_BUNDLED_BRAIN_CONFIG=1
unset MOSH_BRAIN_PROXY_URL || true
# The `openai` provider slot IS the shim for this lane. The owner's profile
# exports a real OPENAI_BASE_URL/OPENAI_API_KEY, so these are unconditional —
# MOSH_SHIM_BASE_URL is the only override.
export OPENAI_BASE_URL="${MOSH_SHIM_BASE_URL:-http://127.0.0.1:8788/v1}"
export OPENAI_API_KEY="shim"
export OPENAI_MODEL="$MODEL"
export OPENROUTER_BASE_URL="${OPENROUTER_BASE_URL:-https://openrouter.ai/api/v1}"
export OPENROUTER_MODEL="${OPENROUTER_MODEL:-anthropic/claude-sonnet-5}"
export MOSHI_BRAIN_PROVIDER=deepseek
# Deliberately NOT set: MOSH_SELFTEST_SESSION would isolate Settings.xml and
# hide the real Vital preset scan from this run.

# ── launch ───────────────────────────────────────────────────────────────────
nohup "$BIN" >>"$APP_LOG" 2>>"$APP_LOG" &
PID=$!
echo "$PID" > "$PID_FILE"
disown "$PID" 2>/dev/null || true

PORT="${MOSH_LAB_PORT:-47873}"
elapsed=0
healthy=0
while [ "$elapsed" -lt "$WAIT_HEALTH_S" ]; do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "launch-app.sh: Mosh (pid $PID) exited during startup — see $APP_LOG" >&2
    exit 1
  fi
  if body="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null)"; then
    case "$body" in
      *'"running":true'*) healthy=1; break ;;
    esac
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

if [ "$healthy" -ne 1 ]; then
  echo "launch-app.sh: pid $PID started but /health never reported running within ${WAIT_HEALTH_S}s — see $APP_LOG" >&2
  exit 1
fi

echo "pid=$PID port=$PORT token_file=$TOKEN_FILE"
