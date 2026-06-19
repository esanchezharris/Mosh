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
# Env knobs: MOSH_BRAIN_ENV (override the dotenv path), MOSH_ENABLE_SA3 (default 1;
#            set 0 to force FakeAdapter), MOSH_BRAIN_SMOKE_PROMPT (prompt for `smoke`).
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
  done < <(find "$ROOT/build-macos-arm64-release" "$ROOT/build-macos-arm64" "$ROOT/build" -maxdepth 3 -name 'Mosh.app' -type d 2>/dev/null)
  printf '%s\n' "$newest"
}

# build_app [configurePreset] [buildPreset] — defaults to the Debug app preset for
# fast iteration; `deploy` passes the Release presets so the installed app is optimized.
build_app() {
  local cfg="${1:-macos-arm64-debug}" bld="${2:-macos-arm64-app}"
  echo "building Mosh ($cfg → $bld)…"
  cmake --preset "$cfg"
  cmake --build --preset "$bld"
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

# SA3 "imagine" is on by default (the service auto-selects the MLX venv when the
# model is installed, and falls back to FakeAdapter when it isn't). Set
# MOSH_ENABLE_SA3=0 to force FakeAdapter even when the model is present.
export MOSH_ENABLE_SA3="${MOSH_ENABLE_SA3:-1}"

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
  deploy) build_app macos-arm64-release macos-arm64-release-app ;;
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

    # Bundle the Python service INTO the app so a Finder/Dock double-click (whose
    # cwd is not the repo) can still find + spawn it — GenerativeJobManager looks for
    # Contents/Resources/service/server.py. The model venvs (SA3 MLX + Basic Pitch,
    # 100s of MB, machine-local) stay OUTSIDE: the bundled run.sh defaults SA3_MLX_DIR
    # to ~/AI/... and reads BASIC_PITCH_PY from the machine-local .transcribe.env we
    # copy in (so transcription + re-imagine work from the Dock, not just run-mosh.sh).
    SVC="$DEST/Contents/Resources/service"
    echo "bundling service → ${SVC#$ROOT/}"
    rm -rf "$SVC"; mkdir -p "$SVC/transcribe"
    cp "$ROOT/service/server.py" "$ROOT/service/run.sh" "$ROOT/service/run.ps1" \
       "$ROOT/service/quality_readout.py" "$ROOT/service/setup-sa3.sh" "$SVC/" 2>/dev/null || true
    for d in adapters colors sa3 scripts training; do
      [ -d "$ROOT/service/$d" ] && cp -R "$ROOT/service/$d" "$SVC/$d"
    done
    cp "$ROOT/service/transcribe/transcribe_cli.py" \
       "$ROOT/service/transcribe/setup-transcribe.sh" "$SVC/transcribe/"
    # Machine-local venv pointers (gitignored) — let the bundled service reach the
    # external venvs. Absent ones just fall back to run.sh's defaults.
    [ -f "$ROOT/service/.sa3.env" ] && cp "$ROOT/service/.sa3.env" "$SVC/.sa3.env"
    [ -f "$ROOT/service/transcribe/.transcribe.env" ] && cp "$ROOT/service/transcribe/.transcribe.env" "$SVC/transcribe/.transcribe.env"
    # Keep the bundle lean (drop staged __pycache__).
    find "$SVC" -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true

    # Nudge the macOS icon cache so a changed icon refreshes.
    touch "$DEST"
    killall Finder 2>/dev/null || true
    killall Dock   2>/dev/null || true
    echo "deployed one canonical /Applications/Mosh.app (service bundled)."
    echo "If macOS still shows an old icon, log out and back in (icon cache)."
    ;;
  *)     echo "usage: $0 [gui|smoke|build|deploy]" >&2; exit 2 ;;
esac
