#!/usr/bin/env bash
# One-command setup for audio->MIDI transcription (Spotify Basic Pitch, Apache-2.0).
#
# Basic Pitch is small and rights-clean, but we keep it in a DEDICATED venv so its
# deps (CoreML / numpy / librosa) never collide with the service interpreter or the
# SA3 MLX venv. This script creates ~/Library/Mosh/venvs/transcribe (override the
# root with MOSH_VENVS_DIR), installs basic-pitch, validates the import, and writes
# service/transcribe/.transcribe.env (BASIC_PITCH_PY) which run.sh sources — so
# /transcribe just works with no per-launch exports.
#
# The venv deliberately lives OUTSIDE the repo tree: in-tree .venvs sat under
# iCloud-synced ~/Documents and iCloud silently evicted files from them (onnxruntime,
# then basic_pitch — twice in two days), breaking /transcribe with no install-time
# error. The .env file stays the single source of truth for where the venv is.
#
# On macOS, `pip install basic-pitch` pulls the lightweight CoreML runtime (NOT the
# heavyweight TensorFlow). If the venv is absent the service degrades gracefully:
# /transcribe returns 503 transcription_unavailable and the rest of Mosh is unaffected.
#
# Idempotent + cheap to re-run: a healthy venv just re-validates (no installer runs);
# pass --reinstall to force the full install/top-up path.
#
# The app's "Add AI tools" install (docs/AI-TOOLS-OPTIONAL-BRIEF-2026-11-02.md) runs this
# from inside the signed bundle on a Mac that may have no developer tools:
#   --python <path>  build the venv from this interpreter; never search PATH for python3
#                    (on such a Mac /usr/bin/python3 is the stub that opens the "install
#                    developer tools" dialog).
#   --env-dir <dir>  write transcribe.env there instead of .transcribe.env next to this script, which in an
#                    installed app is inside Mosh.app. run.sh sources that directory.
set -euo pipefail
CALLER_PWD="$(pwd)"
cd "$(dirname "$0")"          # service/transcribe/
HERE="$(pwd)"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

printf '— Mosh transcription setup (Basic Pitch) —\n'

REINSTALL=0
PY_FLAG=""
ENV_DIR=""
abspath() { [[ "$1" == /* ]] && printf '%s' "$1" || printf '%s/%s' "$CALLER_PWD" "$1"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reinstall) REINSTALL=1 ;;
    --python)  [[ $# -ge 2 ]] || fail "--python needs a path"; PY_FLAG="$(abspath "$2")"; shift ;;
    --env-dir) [[ $# -ge 2 ]] || fail "--env-dir needs a directory"; ENV_DIR="$(abspath "$2")"; shift ;;
    *) fail "unknown argument: $1 (expected --reinstall, --python <path>, --env-dir <dir>)" ;;
  esac
  shift
done
# Checked up front, not only on the install path, so a bad flag never passes silently.
[[ -z "$PY_FLAG" || -x "$PY_FLAG" ]] || fail "--python $PY_FLAG is not an executable file"

# Venv location (outside iCloud — see the header note).
VENVS_ROOT="${MOSH_VENVS_DIR:-$HOME/Library/Mosh/venvs}"
VENV="$VENVS_ROOT/transcribe"
PYBIN="$VENV/bin/python"
LEGACY_VENV="$HERE/.venv"

# Sanity: the venv must import basic_pitch AND load the predict entrypoint.
venv_ok() {
  [[ -x "$PYBIN" ]] || return 1
  "$PYBIN" - <<'PY'
import importlib.util, sys
ok = importlib.util.find_spec("basic_pitch") is not None
if ok:
    from basic_pitch.inference import predict  # noqa: F401
    from basic_pitch import ICASSP_2022_MODEL_PATH  # noqa: F401
sys.exit(0 if ok else 1)
PY
}

if [[ "$REINSTALL" == "0" ]] && venv_ok >/dev/null 2>&1; then
  # Cheap path: the venv already validates — skip the installer entirely.
  say "venv ✓ (validated at $VENV — install skipped; --reinstall forces a top-up)"
else
  # 1. Pick a Python. Prefer 3.11 (best coremltools/basic-pitch compatibility), then
  #    fall back to whatever python3 resolves to.
  PY="$PY_FLAG"
  if [[ -z "$PY" ]]; then
    for cand in python3.11 python3.12 python3; do
      if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
    done
  fi
  [[ -n "$PY" ]] || fail "no python3 found on PATH"
  say "python = $PY ($($PY --version 2>&1))"

  # 2. Create / reuse the venv. Use uv when present (much faster), else stdlib venv.
  if [[ ! -x "$PYBIN" ]]; then
    say "creating venv at $VENV …"
    mkdir -p "$VENVS_ROOT"
    if command -v uv >/dev/null 2>&1; then
      uv venv --python "$PY" "$VENV" >/dev/null
    else
      "$PY" -m venv "$VENV"
    fi
  fi

  # 3. Install basic-pitch + a model runtime (the only install step). We pin the ONNX
  #    runtime (`[onnx]`): `pip install basic-pitch` alone ships NO inference backend,
  #    and ONNX has the most reliable arm64-mac wheels + is Python-version-tolerant
  #    (CoreML's coremltools lags new Python). `setuptools<81` is required because a dep
  #    (resampy) imports pkg_resources, which setuptools 81+ removed (and uv venvs omit).
  say "installing basic-pitch[onnx] (may take a minute) …"
  if command -v uv >/dev/null 2>&1; then
    VIRTUAL_ENV="$VENV" uv pip install --python "$PYBIN" --quiet "basic-pitch[onnx]" "setuptools<81"
  else
    "$PYBIN" -m pip install --quiet --upgrade pip "setuptools<81"
    "$PYBIN" -m pip install --quiet "basic-pitch[onnx]"
  fi

  # 4. Validate the fresh install.
  venv_ok || fail "the venv cannot import basic-pitch — install failed; inspect $VENV"
  say "venv ✓ (basic_pitch importable)"
fi

# 5. Persist the resolved interpreter so run.sh / the service find it with no exports.
if [[ -n "$ENV_DIR" ]]; then
  mkdir -p "$ENV_DIR"
  ENVFILE="$ENV_DIR/transcribe.env"
else
  ENVFILE="$HERE/.transcribe.env"
fi
cat > "$ENVFILE" <<EOF
# Written by service/transcribe/setup-transcribe.sh — sourced by run.sh. Safe to
# delete (the service falls back to /transcribe -> 503 transcription_unavailable).
export BASIC_PITCH_PY="$PYBIN"
EOF
say "wrote $ENVFILE"

# 6. Drop a legacy in-tree venv once the new location validates — it was the
#    iCloud-corruption vector and only wastes sync bandwidth now.
if [[ -d "$LEGACY_VENV" && "$LEGACY_VENV" != "$VENV" ]]; then
  rm -rf "$LEGACY_VENV"
  say "removed legacy in-tree venv $LEGACY_VENV (superseded by $VENV)"
fi

printf '\n✓ Transcription ready. Right-click a wave clip → Convert to MIDI.\n'
