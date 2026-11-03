#!/usr/bin/env bash
# One-command setup for Sketch Phase 0 (beatbox -> drum MoshOps).
#
# The transduction CLI (beatbox_cli.py) needs librosa + numpy for onset detection and
# spectral classification. We keep them in a DEDICATED venv so librosa's heavy deps
# (numba / llvmlite / soundfile / scipy) never collide with the service interpreter or
# the SA3 MLX venv. This creates ~/Library/Mosh/venvs/sketch (override the root with
# MOSH_VENVS_DIR), installs the deps, validates the import, and writes
# service/sketch/.sketch.env (SKETCH_PY) which run.sh sources — so /sketch just works
# with no per-launch exports.
#
# The venv deliberately lives OUTSIDE the repo tree: in-tree .venvs sat under
# iCloud-synced ~/Documents and iCloud silently evicted files from them (twice in two
# days), breaking product paths with no install-time error. The .env file stays the
# single source of truth for where the venv is.
#
# If the venv is absent the service degrades gracefully: /sketch returns 503
# sketch_unavailable and the rest of Mosh is unaffected.
#
# Idempotent + cheap to re-run: a healthy venv just re-validates (no installer runs);
# pass --reinstall to force the full install/top-up path.
#
# The app's "Add AI tools" install (docs/AI-TOOLS-OPTIONAL-BRIEF-2026-11-02.md) runs this
# from inside the signed bundle on a Mac that may have no developer tools:
#   --python <path>  build the venv from this interpreter; never search PATH for python3
#                    (on such a Mac /usr/bin/python3 is the stub that opens the "install
#                    developer tools" dialog).
#   --env-dir <dir>  write sketch.env there instead of .sketch.env next to this script, which in an
#                    installed app is inside Mosh.app. run.sh sources that directory.
set -euo pipefail
CALLER_PWD="$(pwd)"
cd "$(dirname "$0")"          # service/sketch/
HERE="$(pwd)"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

printf '— Mosh Sketch setup (librosa beatbox transduction) —\n'

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
VENV="$VENVS_ROOT/sketch"
PYBIN="$VENV/bin/python"
LEGACY_VENV="$HERE/.venv"

# Sanity: the venv must import librosa + numpy and expose onset_detect.
venv_ok() {
  [[ -x "$PYBIN" ]] || return 1
  "$PYBIN" - <<'PY'
import importlib.util, sys
ok = importlib.util.find_spec("librosa") is not None and importlib.util.find_spec("numpy") is not None
if ok:
    import librosa  # noqa: F401
    librosa.onset.onset_detect  # noqa: B018
sys.exit(0 if ok else 1)
PY
}

if [[ "$REINSTALL" == "0" ]] && venv_ok >/dev/null 2>&1; then
  # Cheap path: the venv already validates — skip the installer entirely.
  say "venv ✓ (validated at $VENV — install skipped; --reinstall forces a top-up)"
else
  # 1. Pick a Python. Prefer 3.11 (best numba/librosa wheel coverage), then fall back.
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

  # 3. Install librosa (pulls numpy / scipy / soundfile / numba). librosa.load reads the
  #    fixture WAVs via soundfile (libsndfile), bundled in the soundfile wheel on arm64-mac.
  say "installing librosa + numpy (may take a minute) …"
  if command -v uv >/dev/null 2>&1; then
    VIRTUAL_ENV="$VENV" uv pip install --python "$PYBIN" --quiet "librosa>=0.10" "numpy"
  else
    "$PYBIN" -m pip install --quiet --upgrade pip
    "$PYBIN" -m pip install --quiet "librosa>=0.10" "numpy"
  fi

  if [[ "$(uname -s)" == "Darwin" ]]; then
    say "repairing macOS signatures for native wheels …"
    while IFS= read -r -d '' lib; do
      xattr -d com.apple.quarantine "$lib" 2>/dev/null || true
      codesign --force --sign - "$lib" >/dev/null 2>&1 || true
    done < <(find "$VENV" \( -name '*.so' -o -name '*.dylib' \) -print0)
  fi

  # 4. Validate the fresh install.
  venv_ok || fail "the venv cannot import librosa — install failed; inspect $VENV"
  say "venv ✓ (librosa importable)"
fi

# 5. Persist the resolved interpreter so run.sh / the service find it with no exports.
if [[ -n "$ENV_DIR" ]]; then
  mkdir -p "$ENV_DIR"
  ENVFILE="$ENV_DIR/sketch.env"
else
  ENVFILE="$HERE/.sketch.env"
fi
cat > "$ENVFILE" <<EOF
# Written by service/sketch/setup-sketch.sh — sourced by run.sh. Safe to delete (the
# service falls back to /sketch -> 503 sketch_unavailable).
export SKETCH_PY="$PYBIN"
EOF
say "wrote $ENVFILE"

# 6. Drop a legacy in-tree venv once the new location validates — it was the
#    iCloud-corruption vector and only wastes sync bandwidth now.
if [[ -d "$LEGACY_VENV" && "$LEGACY_VENV" != "$VENV" ]]; then
  rm -rf "$LEGACY_VENV"
  say "removed legacy in-tree venv $LEGACY_VENV (superseded by $VENV)"
fi

printf '\n✓ Sketch ready. Upload a beatbox WAV + set the BPM to box it into a drum clip.\n'
