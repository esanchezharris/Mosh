#!/usr/bin/env bash
# setup-guest.sh — one-command guest setup for a Mosh playtest.
#
# Turns a fresh, unsigned Mosh.app (received via AirDrop/Dropbox/zip, see
# docs/PLAYTEST_SETUP.md) into a machine that runs the SAME real models the host runs,
# instead of silently falling back to the deterministic FakeAdapter / graceful-degrade
# paths everywhere. Shipped INSIDE the app bundle at Contents/Resources/setup-guest.sh
# (see scripts/playtest/package-guest-zip.sh), so it resolves its own bundle root from
# $0 — no repo checkout needed on the guest's machine.
#
# Usage (from the installed app):
#   bash /Applications/Mosh.app/Contents/Resources/setup-guest.sh --status
#   bash /Applications/Mosh.app/Contents/Resources/setup-guest.sh --all [--skip-weights]
#   bash /Applications/Mosh.app/Contents/Resources/setup-guest.sh --sa3 [--skip-weights]
#   bash /Applications/Mosh.app/Contents/Resources/setup-guest.sh --features "phonology transcribe"
#
# What --all installs:
#   • the 5 light per-feature venvs: phonology transcribe whisper skeleton sketch
#     (lyric rhyme/stress, audio→MIDI, word transcription, mumble→skeleton, beatbox→drums)
#   • the real Stable Audio 3 model (source + ~6.4 GB weights) via --sa3
#   `transform` (RAVE timbre transfer) is DELIBERATELY EXCLUDED even from --all: it pulls
#   a multi-GB torch install and a guest machine has no RAVE `.ts` models to host anyway
#   (Route C is a bring-your-own-model feature) — installing it would just burn time and
#   disk for a lane that has nothing to do once installed. Ask the host if you actually
#   need it; it's the same `service/transform/setup-transform.sh` any dev checkout uses.
#
# Env overrides (all optional):
#   MOSH_VENVS_DIR         root for the 5 light per-feature venvs (default ~/Library/Mosh/venvs)
#   SA3_SRC_DIR            where the SA3 model source lands (default ~/AI/stable-audio-3)
#   SA3_MLX_DIR            overrides the derived $SA3_SRC_DIR/optimized/mlx directly
#                          (this is the exact var service/sa3/engine.py reads at runtime)
#   MOSH_SA3_SRC_TARBALL   override the upstream tarball URL (default: the pinned
#                          Stability-AI/stable-audio-3 GitHub archive at 636f906)
#   HF_TOKEN               HuggingFace token for faster/higher-limit weight downloads
#                          (optional; anonymous downloads work, just rate-limited)
set -uo pipefail

# ── resolve our own location: Contents/Resources/{setup-guest.sh,service/} ────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESOURCES_DIR="$SCRIPT_DIR"
SERVICE_DIR="$RESOURCES_DIR/service"
GUEST_VENDOR_DIR="$SERVICE_DIR/sa3/guest"

# The .app root, if we're actually running from inside one (Resources/../.. = the .app).
CONTENTS_DIR="$(dirname "$RESOURCES_DIR")"
APP_ROOT="$(dirname "$CONTENTS_DIR")"

PIN_URL_DEFAULT="https://github.com/Stability-AI/stable-audio-3/archive/636f906.tar.gz"
TARBALL_URL="${MOSH_SA3_SRC_TARBALL:-$PIN_URL_DEFAULT}"
# Derive a short pin label from the tarball ref (e.g. ".../archive/636f906.tar.gz" -> "636f906").
SA3_PIN="$(basename "$TARBALL_URL")"; SA3_PIN="${SA3_PIN%.tar.gz}"

SA3_SRC_DIR="${SA3_SRC_DIR:-$HOME/AI/stable-audio-3}"
SA3_MLX_DIR="${SA3_MLX_DIR:-$SA3_SRC_DIR/optimized/mlx}"
export SA3_MLX_DIR
VENVS_ROOT="${MOSH_VENVS_DIR:-$HOME/Library/Mosh/venvs}"
export MOSH_VENVS_DIR="$VENVS_ROOT"

ALL_FEATURES=(phonology transcribe whisper skeleton sketch)
WEIGHT_FILES=(
  "models/mlx/dit_medium_f16.npz"
  "models/mlx/same_l_decoder_f32.npz"
  "models/mlx/same_l_encoder_f32.npz"
  "models/mlx/t5gemma_f16.npz"
)

bold()  { printf '\033[1m%s\033[0m' "$*"; }
dim()   { printf '\033[2m%s\033[0m' "$*"; }
green() { printf '\033[32m%s\033[0m' "$*"; }
yellow(){ printf '\033[33m%s\033[0m' "$*"; }
red()   { printf '\033[31m%s\033[0m' "$*"; }
header(){ printf '\n%s\n' "$(bold "── $* ──")"; }
say()   { printf '  %s\n' "$*"; }
hsize() { # human-readable size of a path (file or dir), best-effort
  du -sh "$1" 2>/dev/null | awk '{print $1}' || echo "?"
}

usage() {
  cat <<EOF
usage: $(basename "$0") [--all|--sa3|--features "name…"|--status] [--skip-weights]

  --status              report real-vs-fake for every lane; installs nothing
  --all                 install the 5 light feature venvs + real SA3 (excludes transform)
  --sa3                 install only the real Stable Audio 3 model
  --features "a b c"    install only the named feature venvs (from: ${ALL_FEATURES[*]})
  --skip-weights        with --all/--sa3: set up SA3 source + venv but skip the
                         ~6.4 GB weight download (use when you'll fetch them later,
                         or already warmed the HuggingFace cache another way)
EOF
}

# ─────────────────────────── argument parsing ───────────────────────────────────
MODE=""
FEATURES=()
SKIP_WEIGHTS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)          MODE="all"; shift ;;
    --sa3)          MODE="sa3"; shift ;;
    --status)       MODE="status"; shift ;;
    --features)     MODE="features"; IFS=' ' read -r -a FEATURES <<< "${2:-}"; shift 2 ;;
    --skip-weights) SKIP_WEIGHTS=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ -z "$MODE" ]] && { usage >&2; exit 2; }

# ───────────────────────────── step 0: xcode CLT ────────────────────────────────
if ! xcode-select -p >/dev/null 2>&1; then
  cat <<EOF >&2

$(red "✗") Xcode Command Line Tools are not installed — stock macOS ships no python3,
  and every setup step below needs one.

  Install them once (a system dialog will appear — click Install, then wait a few
  minutes for it to finish):

    xcode-select --install

  Then re-run this script.
EOF
  exit 1
fi

# ───────────────────────────── status helpers ───────────────────────────────────
sa3_status() {
  local marker="$SA3_MLX_DIR/scripts/sa3_mlx.py"     # == engine.py's engine_available() gate
  local venv_py="$SA3_MLX_DIR/.venv/bin/python"
  local marker_ok="no"; [[ -f "$marker" ]] && marker_ok="yes"
  local venv_ok="no"; [[ -x "$venv_py" ]] && venv_ok="yes"
  local present=0
  local f
  for f in "${WEIGHT_FILES[@]}"; do
    [[ -f "$SA3_MLX_DIR/$f" || -L "$SA3_MLX_DIR/$f" ]] && present=$((present + 1))
  done
  printf '%s\t%s\t%s\t%s/%s\n' "$marker_ok" "$venv_ok" "$SA3_MLX_DIR" "$present" "${#WEIGHT_FILES[@]}"
}

feature_status() {   # $1 = feature name -> prints "yes|no  <path>"
  local name="$1" py
  py="$VENVS_ROOT/$name/bin/python"
  if [[ -x "$py" ]]; then printf 'yes\t%s\n' "$py"; else printf 'no\t%s\n' "$py"; fi
}

live_service_health() {
  local portfile="$HOME/Library/Mosh/service.port"
  [[ -f "$portfile" ]] || return 1
  local port; port="$(tr -d '[:space:]' < "$portfile" 2>/dev/null)"
  [[ -n "$port" ]] || return 1
  curl -s --max-time 2 "http://127.0.0.1:${port}/health" 2>/dev/null
}

print_status() {
  header "SA3 (real re-imagine / colour rack)"
  IFS=$'\t' read -r m_ok v_ok dir present_total <<< "$(sa3_status)"
  say "model source marker : $([[ "$m_ok" == yes ]] && green "present" || red "absent")  ($dir/scripts/sa3_mlx.py)"
  say "MLX venv            : $([[ "$v_ok" == yes ]] && green "present" || red "absent")  ($dir/.venv/bin/python)"
  say "weight files         : $present_total present  (under $dir/models/mlx/)"
  if [[ "$m_ok" == yes && "$v_ok" == yes ]]; then
    say "$(green "→ real SA3 will serve") (FakeAdapter unless MOSH_ENABLE_SA3=0)"
  else
    say "$(yellow "→ FakeAdapter only") (re-imagine/colours will be deterministic placeholders)"
  fi

  header "per-feature venvs (light lanes)"
  local name status py
  for name in "${ALL_FEATURES[@]}"; do
    IFS=$'\t' read -r status py <<< "$(feature_status "$name")"
    if [[ "$status" == yes ]]; then
      printf '  %-11s %s  %s\n' "$name" "$(green "real")" "$(dim "$py")"
    else
      printf '  %-11s %s  %s\n' "$name" "$(yellow "degraded/off")" "$(dim "$py")"
    fi
  done
  say "$(dim "transform (RAVE transfer) intentionally not installed by this script — see --help")"

  header "running service"
  local health
  if health="$(live_service_health)"; then
    if [[ -n "$health" ]]; then
      local adapters
      adapters="$(printf '%s' "$health" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    print(",".join(d.get("adapters",[])))
except Exception:
    print("?")' 2>/dev/null)"
      say "service        : $(green "up")  adapters=[$adapters]"
    else
      say "service        : $(yellow "port file present but no response")"
    fi
  else
    say "service        : $(dim "not running (will spawn on demand — quit and reopen Mosh, or use/create a render)")"
  fi
}

if [[ "$MODE" == "status" ]]; then
  print_status
  exit 0
fi

# ───────────────────────────── feature venv installs ────────────────────────────
install_feature() {   # $1 = feature name
  local name="$1"
  local script="$SERVICE_DIR/$name/setup-$name.sh"
  header "feature: $name"
  if [[ ! -f "$script" ]]; then
    say "$(red "✗") not shipped in this bundle: $script"
    return 1
  fi
  say "running $script (MOSH_VENVS_DIR=$VENVS_ROOT) …"
  if bash "$script"; then
    say "$(green "✓") $name ready"
    return 0
  else
    say "$(red "✗") $name setup failed (see output above) — the app still degrades gracefully without it"
    return 1
  fi
}

FEATURE_FAILS=0
if [[ "$MODE" == "all" ]]; then
  FEATURES=("${ALL_FEATURES[@]}")
fi
if [[ "$MODE" == "all" || "$MODE" == "features" ]]; then
  for f in "${FEATURES[@]}"; do
    [[ -z "$f" ]] && continue
    if ! printf '%s\n' "${ALL_FEATURES[@]}" | grep -qx "$f"; then
      echo "  skipping unknown feature '$f' (known: ${ALL_FEATURES[*]})" >&2
      continue
    fi
    install_feature "$f" || FEATURE_FAILS=$((FEATURE_FAILS + 1))
  done
fi

# ───────────────────────────────── SA3 lane ─────────────────────────────────────
SA3_FAILED=0
if [[ "$MODE" == "all" || "$MODE" == "sa3" ]]; then
  header "SA3 model source"
  PIN_FILE="$SA3_SRC_DIR/.mosh_guest_setup_pin"
  MARKER="$SA3_MLX_DIR/scripts/sa3_mlx.py"
  if [[ -f "$MARKER" && -f "$PIN_FILE" && "$(cat "$PIN_FILE" 2>/dev/null)" == "$SA3_PIN" ]]; then
    say "$(green "✓") already at pin $SA3_PIN ($SA3_SRC_DIR) — skipping download"
  else
    say "downloading upstream source (pin $SA3_PIN) …"
    say "  url:  $TARBALL_URL"
    say "  dest: $SA3_SRC_DIR"
    mkdir -p "$SA3_SRC_DIR"
    TMP_TARBALL="$(mktemp -t mosh-sa3-src.XXXXXX.tar.gz)"
    if curl -fL --retry 5 -C - -o "$TMP_TARBALL" "$TARBALL_URL"; then
      say "  downloaded $(hsize "$TMP_TARBALL")"
      if tar xzf "$TMP_TARBALL" --strip-components=1 -C "$SA3_SRC_DIR"; then
        say "$(green "✓") extracted to $SA3_SRC_DIR"
      else
        say "$(red "✗") extraction failed"
        SA3_FAILED=1
      fi
    else
      say "$(red "✗") download failed — check your internet connection and try again"
      SA3_FAILED=1
    fi
    rm -f "$TMP_TARBALL"

    if [[ "$SA3_FAILED" == 0 ]]; then
      say "overlaying the 2 owner-modified files (see $GUEST_VENDOR_DIR/UPSTREAM_PIN) …"
      if [[ -f "$GUEST_VENDOR_DIR/dit_mlx_medium.py" && -f "$GUEST_VENDOR_DIR/sa3_mlx.py" ]]; then
        mkdir -p "$SA3_SRC_DIR/optimized/mlx/models/defs" "$SA3_SRC_DIR/optimized/mlx/scripts"
        cp "$GUEST_VENDOR_DIR/dit_mlx_medium.py" "$SA3_SRC_DIR/optimized/mlx/models/defs/dit_mlx_medium.py"
        cp "$GUEST_VENDOR_DIR/sa3_mlx.py" "$SA3_SRC_DIR/optimized/mlx/scripts/sa3_mlx.py"
        say "$(green "✓") overlay applied"
        echo "$SA3_PIN" > "$PIN_FILE"
      else
        say "$(red "✗") vendored overlay files missing from the bundle at $GUEST_VENDOR_DIR — the colour rack will silently no-op"
        SA3_FAILED=1
      fi
    fi
  fi

  if [[ "$SA3_FAILED" == 0 ]]; then
    header "SA3 venv + colour rack"
    SA3_SETUP="$SERVICE_DIR/setup-sa3.sh"
    if [[ -f "$SA3_SETUP" ]]; then
      say "running $SA3_SETUP (SA3_MLX_DIR=$SA3_MLX_DIR) …"
      if SA3_MLX_DIR="$SA3_MLX_DIR" bash "$SA3_SETUP"; then
        say "$(green "✓") SA3 venv ready"
      else
        say "$(red "✗") SA3 venv setup failed"
        SA3_FAILED=1
      fi
    else
      say "$(red "✗") service/setup-sa3.sh not shipped in this bundle"
      SA3_FAILED=1
    fi
  fi

  if [[ "$SA3_FAILED" == 0 && "$SKIP_WEIGHTS" == 0 ]]; then
    header "SA3 weights (~6.4 GB total — resumable)"
    VENV_PY="$SA3_MLX_DIR/.venv/bin/python"
    if [[ -x "$VENV_PY" ]]; then
      [[ -n "${HF_TOKEN:-}" ]] && say "using HF_TOKEN from the environment (faster, higher-limit downloads)"
      say "fetching the 'medium' DiT bundle + shared T5Gemma weights …"
      if ( cd "$SA3_MLX_DIR" && "$VENV_PY" -c 'import sys; sys.path.insert(0,"scripts"); import weights; [weights.ensure_local(r) for r,_ in weights.DIT_BUNDLES["medium"]+weights.SHARED]' ); then
        say "$(green "✓") weights present"
      else
        say "$(red "✗") weight download failed — re-run with the same command to resume (HuggingFace downloads are resumable)"
        SA3_FAILED=1
      fi
    else
      say "$(red "✗") no venv python at $VENV_PY — skipping weight download"
      SA3_FAILED=1
    fi
  elif [[ "$SKIP_WEIGHTS" == 1 ]]; then
    say "$(dim "--skip-weights: leaving weight download for later (or another warm HF cache)")"
  fi
fi

# ───────────────────────── bundle-seal hygiene ──────────────────────────────────
# The setup-<name>.sh scripts above write .{name}.env pointer files INSIDE the app
# bundle (Contents/Resources/service/**/.{name}.env) as their single source of truth
# for a DEV checkout. That's harmless here because our venvs land at the CONVENTIONAL
# path (${MOSH_VENVS_DIR:-~/Library/Mosh/venvs}/<name>) that server.py's _venv_py()
# already falls back to without any .env — but the new files DO invalidate the app's
# codesign seal (content changed after signing). Strip them and re-verify.
header "bundle-seal hygiene"
if [[ -d "$SERVICE_DIR" ]]; then
  ENV_COUNT=0
  while IFS= read -r -d '' f; do
    rm -f "$f"
    ENV_COUNT=$((ENV_COUNT + 1))
  done < <(find "$SERVICE_DIR" -type f -name '.*.env' -print0 2>/dev/null)
  say "removed $ENV_COUNT machine-local .*.env pointer file(s) from the bundle"
else
  say "$(dim "no service/ dir next to this script — skipping")"
fi

if [[ -f "$CONTENTS_DIR/Info.plist" && "$APP_ROOT" == *.app ]]; then
  say "re-signing $APP_ROOT (ad-hoc) …"
  xattr -cr "$APP_ROOT" 2>/dev/null || true
  if codesign --force --deep --sign - "$APP_ROOT" 2>/dev/null \
     && codesign --verify --deep --strict "$APP_ROOT" 2>/dev/null; then
    say "$(green "✓") signature valid after re-seal"
  else
    say "$(yellow "⚠") codesign re-verify did not come back clean — the app still runs (ad-hoc/unsigned), but report this if you hit odd Gatekeeper prompts"
  fi
else
  say "$(dim "not running from inside an .app bundle — skipping codesign re-verify")"
fi

# ─────────────────────────────────── finish ─────────────────────────────────────
header "finish"
PIDFILE="$HOME/Library/Mosh/service.pid"
if [[ -f "$PIDFILE" ]]; then
  read -r LIVE_PID LIVE_PORT < "$PIDFILE" 2>/dev/null || true
  if [[ -n "${LIVE_PID:-}" ]] && kill -0 "$LIVE_PID" 2>/dev/null; then
    say "stopping the running generative service (pid $LIVE_PID, port ${LIVE_PORT:-?}) so it restarts with what you just installed …"
    kill "$LIVE_PID" 2>/dev/null || true
    say "$(green "✓") stopped — it respawns on demand next time Mosh needs it"
  else
    say "no live service found at pid file $PIDFILE — nothing to restart"
  fi
else
  say "quit and reopen Mosh so the generative service restarts with what you just installed."
fi

print_status

if [[ "${SA3_FAILED:-0}" != 0 || "${FEATURE_FAILS:-0}" != 0 ]]; then
  echo
  echo "$(yellow "⚠  finished with some lanes not fully set up (see above) — the app still works, just with graceful fallbacks for those.")"
  exit 1
fi
echo
echo "$(green "✓ guest setup complete.")"
