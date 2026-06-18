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
#   ./run-mosh.sh deploy    (re)build, then install ONE canonical /Applications/Mosh.app
#
# Env knobs: MOSH_BRAIN_ENV (override the dotenv path), MOSH_ENABLE_SA3 (default 0),
#            MOSH_BRAIN_SMOKE_PROMPT (custom prompt for `smoke`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${MOSH_BRAIN_ENV:-$ROOT/ui/.env.local}"

# Resolve the newest built Mosh.app. The documented build is the
# `macos-arm64-debug` preset (-> build-macos-arm64/); we also check the legacy
# build/ dir. (The old hardcoded build/.../Release/Mosh.app path was stale —
# the preset never produced it.)
resolve_app() {
  # Newest Mosh.app by mtime. Pure-bash loop (no head/sort pipe) so it is safe
  # under `set -o pipefail` — a truncating pipe would SIGPIPE and abort the script.
  local p t best=0 newest=""
  while IFS= read -r p; do
    t="$(stat -f '%m' "$p" 2>/dev/null || echo 0)"
    if [ "$t" -ge "$best" ]; then best="$t"; newest="$p"; fi
  done < <(find "$ROOT/build-macos-arm64" "$ROOT/build" -maxdepth 3 -name 'Mosh.app' -type d 2>/dev/null)
  printf '%s\n' "$newest"
}

build_app() {
  echo "building Mosh (macos-arm64-debug preset)…"
  cmake --preset macos-arm64-debug
  cmake --build --preset macos-arm64-app
}

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
case "$MODE" in
  build)  build_app; MODE="gui" ;;
  deploy) build_app ;;
esac

APP="$(resolve_app)"
BIN="$APP/Contents/MacOS/Mosh"
if [ -z "$APP" ] || [ ! -x "$BIN" ]; then
  echo "Mosh.app not built. Build it first:  ./run-mosh.sh build" >&2
  exit 1
fi

case "$MODE" in
  smoke) exec "$BIN" --brain-smoke ;;
  gui)   echo "launching Mosh ($APP)…"; exec "$BIN" ;;
  deploy)
    DEST="/Applications/Mosh.app"
    echo "deploying $APP -> $DEST"
    rm -rf "$DEST"
    cp -R "$APP" "$DEST"
    # Nudge the macOS icon cache so a changed icon refreshes.
    touch "$DEST"
    killall Finder 2>/dev/null || true
    killall Dock   2>/dev/null || true
    echo "deployed one canonical /Applications/Mosh.app."
    echo "If macOS still shows an old icon, log out and back in (icon cache)."
    ;;
  *)     echo "usage: $0 [gui|smoke|build|deploy]" >&2; exit 2 ;;
esac
