#!/usr/bin/env bash
# One-command setup for Sketch Phase 0 (beatbox -> drum MoshOps).
#
# The transduction CLI (beatbox_cli.py) needs librosa + numpy for onset detection and
# spectral classification. We keep them in a DEDICATED venv (service/sketch/.venv) so
# librosa's heavy deps (numba / llvmlite / soundfile / scipy) never collide with the
# service interpreter or the SA3 MLX venv. This script creates the venv, installs the
# deps, validates the import, and writes service/sketch/.sketch.env (SKETCH_PY) which
# run.sh sources — so /sketch just works with no per-launch exports.
#
# If the venv is absent the service degrades gracefully: /sketch returns 503
# sketch_unavailable and the rest of Mosh is unaffected.
#
# Idempotent: re-running re-validates and tops up the venv.
set -euo pipefail
cd "$(dirname "$0")"          # service/sketch/
HERE="$(pwd)"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

printf '— Mosh Sketch setup (librosa beatbox transduction) —\n'

# 1. Pick a Python. Prefer 3.11 (best numba/librosa wheel coverage), then fall back.
PY=""
for cand in python3.11 python3.12 python3; do
  if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
done
[[ -n "$PY" ]] || fail "no python3 found on PATH"
say "python = $PY ($($PY --version 2>&1))"

# 2. Create / reuse the venv. Use uv when present (much faster), else stdlib venv.
VENV="$HERE/.venv"
PYBIN="$VENV/bin/python"
if [[ ! -x "$PYBIN" ]]; then
  say "creating venv at $VENV …"
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

# 4. Sanity: the venv must import librosa + numpy and expose onset_detect.
"$PYBIN" - <<'PY' || fail "the venv cannot import librosa — install failed; inspect service/sketch/.venv"
import importlib.util, sys
ok = importlib.util.find_spec("librosa") is not None and importlib.util.find_spec("numpy") is not None
if ok:
    import librosa  # noqa: F401
    librosa.onset.onset_detect  # noqa: B018
sys.exit(0 if ok else 1)
PY
say "venv ✓ (librosa importable)"

# 5. Persist the resolved interpreter so run.sh / the service find it with no exports.
ENVFILE="$HERE/.sketch.env"
cat > "$ENVFILE" <<EOF
# Written by service/sketch/setup-sketch.sh — sourced by run.sh. Safe to delete (the
# service falls back to /sketch -> 503 sketch_unavailable).
export SKETCH_PY="$PYBIN"
EOF
say "wrote $ENVFILE"

printf '\n✓ Sketch ready. Upload a beatbox WAV + set the BPM to box it into a drum clip.\n'
