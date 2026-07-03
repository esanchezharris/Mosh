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
set -euo pipefail
cd "$(dirname "$0")"          # service/sketch/
HERE="$(pwd)"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

printf '— Mosh Sketch setup (librosa beatbox transduction) —\n'

REINSTALL=0
[[ "${1:-}" == "--reinstall" ]] && REINSTALL=1

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
  PY=""
  for cand in python3.11 python3.12 python3; do
    if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
  done
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
ENVFILE="$HERE/.sketch.env"
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
