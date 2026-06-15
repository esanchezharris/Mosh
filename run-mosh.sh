#!/usr/bin/env bash
# run-mosh.sh — launch the built Mosh.app with brain keys + native voice, for a live
# smoke test of the packaged-app pieces (LLM brain + macOS speech-to-text).
#
# THIS SCRIPT CONTAINS NO KEYS. It loads them from, in order:
#   1. ui/.env.local   — the gitignored dotenv you paste keys into (see ui/.env.example)
#   2. whatever is already exported in your current shell
#
# It launches the app's inner binary directly (NOT `open`) so the app inherits the
# exported environment — `open(1)` would drop it. The mic/speech permission prompts
# still appear on first use (they key off the bundle, not the launch method).
#
# Usage:
#   ./run-mosh.sh           launch the GUI (talk/type to Moshi — tests voice + brain)
#   ./run-mosh.sh smoke     non-interactive native brain round-trip; prints the reply
#   ./run-mosh.sh build     (re)build the app, then launch the GUI
#
# Env knobs: MOSH_BRAIN_ENV (override the dotenv path), MOSH_ENABLE_SA3 (default 0),
#            MOSH_BRAIN_SMOKE_PROMPT (custom prompt for `smoke`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/build/Mosh_artefacts/Release/Mosh.app"
BIN="$APP/Contents/MacOS/Mosh"
ENV_FILE="${MOSH_BRAIN_ENV:-$ROOT/ui/.env.local}"

# --- load a dotenv file WITHOUT printing any values -------------------------------
load_dotenv() {
  local f="$1"; [ -f "$f" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"             # left-trim
    case "$line" in ''|'#'*) continue;; *=*) ;; *) continue;; esac
    key="${line%%=*}"; val="${line#*=}"
    case "$val" in
      \"*\") val="${val%\"}"; val="${val#\"}";;          # "quoted"
      \'*\') val="${val%\'}"; val="${val#\'}";;          # 'quoted'
      *) val="${val%% #*}";;                              # strip " # inline comment"
    esac
    val="${val%"${val##*[![:space:]]}"}"                 # right-trim
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    [ -n "$key" ] && export "$key=$val"
  done < "$f"
}
load_dotenv "$ENV_FILE"

# A brain+voice smoke needs neither the generative service nor SA3.
export MOSH_ENABLE_SA3="${MOSH_ENABLE_SA3:-0}"

# --- report which providers are configured (names only, never values) -------------
if [ -f "$ENV_FILE" ]; then echo "env: ${ENV_FILE#$ROOT/}"; else echo "env: shell only (no $ENV_FILE)"; fi
have_any=0
for p in DEEPSEEK OPENAI XAI; do
  k="${p}_API_KEY"
  if [ -n "${!k:-}" ]; then echo "  • $p: key present"; have_any=1; fi
done
if [ "$have_any" = 0 ]; then
  echo "  • no brain key found — paste one into ui/.env.local (voice still works;"
  echo "    the brain falls back to the offline mock without a key)"
fi

MODE="${1:-gui}"
if [ "$MODE" = "build" ]; then
  echo "building…"; cmake --build "$ROOT/build" -j8; MODE="gui"
fi

if [ ! -x "$BIN" ]; then
  echo "Mosh.app not built at: $BIN" >&2
  echo "Build it first:  ./run-mosh.sh build   (or: cmake -B build && cmake --build build -j8)" >&2
  exit 1
fi

case "$MODE" in
  smoke) exec "$BIN" --brain-smoke ;;
  gui)   echo "launching Mosh…"; exec "$BIN" ;;
  *)     echo "usage: $0 [gui|smoke|build]" >&2; exit 2 ;;
esac
