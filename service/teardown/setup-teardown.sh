#!/usr/bin/env bash
# One-command setup for the teardown lane (§1 drum matcher first; §4/§5/§7 deps grow here).
#
# Kept in a DEDICATED venv so its deps never collide with the service interpreter or the
# SA3 MLX venv. Creates service/teardown/.venv, installs the always-on baseline
# (numpy/scipy/soundfile/librosa + pydantic for the §0 Recipe), and writes
# service/teardown/.teardown.env (TEARDOWN_PY [+ TEARDOWN_INDEX_DIR]) which run.sh sources
# — so /teardown/* just work with no per-launch exports.
#
# The CLAP audio-tower embedder + faiss ANN are OPTIONAL (heavy: pulls torch). Pass
# --with-clap to add them; without it the matcher uses the engineered-feature baseline
# (competitive on one-shots) and brute-force numpy NN. If the venv is absent the service
# degrades gracefully: /teardown/* return 503 teardown_unavailable.
#
# Idempotent: re-running re-validates and tops up the venv.
set -euo pipefail
cd "$(dirname "$0")"          # service/teardown/
HERE="$(pwd)"

WITH_CLAP=0
WITH_SOURCING=0
WITH_VIDEO=0
for a in "$@"; do
  [[ "$a" == "--with-clap" ]] && WITH_CLAP=1
  [[ "$a" == "--with-sourcing" ]] && WITH_SOURCING=1
  [[ "$a" == "--with-video" ]] && WITH_VIDEO=1
done

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

printf '— Mosh teardown setup (drum matcher) —\n'

# 1. Pick a Python (3.11/3.12 preferred for the audio stack).
PY=""
for cand in python3.11 python3.12 python3; do
  if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
done
[[ -n "$PY" ]] || fail "no python3 found on PATH"
say "python = $PY ($($PY --version 2>&1))"

# 2. Create / reuse the venv (uv when present, else stdlib venv).
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

# 3. Install the always-on baseline.
BASE_PKGS=(numpy scipy soundfile librosa pydantic)
say "installing baseline: ${BASE_PKGS[*]} …"
if command -v uv >/dev/null 2>&1; then
  VIRTUAL_ENV="$VENV" uv pip install --python "$PYBIN" --quiet "${BASE_PKGS[@]}"
else
  "$PYBIN" -m pip install --quiet --upgrade pip
  "$PYBIN" -m pip install --quiet "${BASE_PKGS[@]}"
fi

# 4. Optional CLAP + faiss (heavy — pulls torch). Gated behind --with-clap; absent →
#    the engineered baseline + brute-force NN are used (still fully functional).
if [[ "$WITH_CLAP" == "1" ]]; then
  say "installing CLAP + faiss (heavy; pulls torch) …"
  if command -v uv >/dev/null 2>&1; then
    VIRTUAL_ENV="$VENV" uv pip install --python "$PYBIN" --quiet laion-clap faiss-cpu
  else
    "$PYBIN" -m pip install --quiet laion-clap faiss-cpu
  fi
fi

# 4b. Optional sourcing (§3): yt-dlp for search-based discovery + the transient media
#     cache (no Data API key needed). Light, pure-Python.
if [[ "$WITH_SOURCING" == "1" ]]; then
  say "installing yt-dlp (sourcing §3) …"
  if command -v uv >/dev/null 2>&1; then
    VIRTUAL_ENV="$VENV" uv pip install --python "$PYBIN" --quiet yt-dlp
  else
    "$PYBIN" -m pip install --quiet yt-dlp
  fi
fi

# 4c. Optional video→recipe (§2/§4): CV + OCR + STT + scene detection. Needs the system
#     binaries ffmpeg + tesseract (brew install ffmpeg tesseract) for frame I/O + OCR.
if [[ "$WITH_VIDEO" == "1" ]]; then
  say "installing video stack (opencv/pytesseract/scenedetect/faster-whisper/Pillow) …"
  VID_PKGS=(opencv-python-headless pytesseract scenedetect faster-whisper Pillow)
  if command -v uv >/dev/null 2>&1; then
    VIRTUAL_ENV="$VENV" uv pip install --python "$PYBIN" --quiet "${VID_PKGS[@]}"
  else
    "$PYBIN" -m pip install --quiet "${VID_PKGS[@]}"
  fi
  command -v ffmpeg   >/dev/null 2>&1 || say "  ⚠ ffmpeg not on PATH — brew install ffmpeg"
  command -v tesseract >/dev/null 2>&1 || say "  ⚠ tesseract not on PATH — brew install tesseract"
fi

# 5. Sanity: the venv must import the baseline stack.
"$PYBIN" - <<'PY' || fail "the venv cannot import the baseline stack — inspect service/teardown/.venv"
import importlib, sys
for m in ("numpy", "scipy", "soundfile", "librosa", "pydantic"):
    importlib.import_module(m)
sys.exit(0)
PY
say "venv ✓ (baseline importable)"
[[ "$WITH_CLAP" == "1" ]] && "$PYBIN" -c "import laion_clap, faiss" 2>/dev/null && say "CLAP + faiss ✓"

# 6. Persist the resolved interpreter + a default index location.
ENVFILE="$HERE/.teardown.env"
cat > "$ENVFILE" <<EOF
# Written by service/teardown/setup-teardown.sh — sourced by run.sh. Safe to delete
# (the service falls back to /teardown/* -> 503 teardown_unavailable).
export TEARDOWN_PY="$PYBIN"
export TEARDOWN_INDEX_DIR="$HERE/.index"
EOF
say "wrote $ENVFILE"

printf '\n✓ Teardown ready. Build a sample index: POST /teardown/index {"library": "<dir>"}\n'
[[ "$WITH_CLAP" == "1" ]] || printf '  (engineered baseline; re-run with --with-clap for the CLAP embedder)\n'
