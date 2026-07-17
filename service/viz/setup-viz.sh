#!/usr/bin/env bash
# One-command setup for the take-vs-render waveform/spectrogram QA instrument.
#
# Builds the "true-to-the-mumble" visual: stacks the mumble take's waveform + spectrogram
# against the render's on a shared clock, so alignment (and artifacts like the HF-imaging
# "squeak") are READ, not inferred from a scalar. Pure numpy for the peaks/mel/stats
# (golden-tested); Pillow for the panel (no matplotlib — headless-hostile on Mac).
#
# Dedicated venv so numpy/scipy/Pillow never collide with the service interpreter or the
# torch-heavy feature venvs. Creates ~/Library/Mosh/venvs/viz (override root with
# MOSH_VENVS_DIR), installs numpy + scipy + Pillow + soundfile, writes .viz.env next to
# this script (VIZ_PY). Idempotent: a healthy venv re-validates without reinstalling;
# --reinstall forces a top-up. The venv lives OUTSIDE the repo tree (in-tree .venvs sat
# under iCloud and were silently evicted — see the nsf/skeleton setup notes).
#
# The adapter's MOSH_SING_VIZ=1 QA hook uses VIZ_PY; absent it, it falls back to the
# teardown dev venv, then degrades to no panel. Nothing here ships or affects a render.
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
printf '— Mosh waveform/spectrogram QA venv setup —\n'

VENV_ROOT="${MOSH_VENVS_DIR:-$HOME/Library/Mosh/venvs}"
VENV="$VENV_ROOT/viz"
PY="$VENV/bin/python3"
REINSTALL=0
[[ "${1:-}" == "--reinstall" ]] && REINSTALL=1

need_install=1
if [[ -x "$PY" && "$REINSTALL" -eq 0 ]]; then
  if "$PY" - <<'PYEOF' 2>/dev/null
import numpy, scipy, soundfile          # noqa: F401
from scipy.signal import resample_poly  # noqa: F401
from PIL import Image, ImageDraw        # noqa: F401
PYEOF
  then need_install=0; say "healthy venv at $VENV — revalidated, skipping install"; fi
fi

if [[ "$need_install" -eq 1 ]]; then
  say "creating venv at $VENV"
  mkdir -p "$VENV_ROOT"
  if command -v uv >/dev/null 2>&1; then
    uv venv "$VENV" >/dev/null || fail "uv venv failed"
    VIRTUAL_ENV="$VENV" uv pip install --python "$PY" numpy scipy Pillow soundfile >/dev/null \
      || fail "uv pip install failed"
  else
    python3 -m venv "$VENV" || fail "python -m venv failed"
    "$PY" -m pip install -q --upgrade pip >/dev/null
    "$PY" -m pip install -q numpy scipy Pillow soundfile || fail "pip install failed"
  fi
  "$PY" - <<'PYEOF' || fail "import validation failed after install"
import numpy, scipy, soundfile          # noqa: F401
from scipy.signal import resample_poly  # noqa: F401
from PIL import Image, ImageDraw        # noqa: F401
print("  imports ok")
PYEOF
fi

# remove a stale in-tree venv if one exists (the iCloud-eviction lesson)
[[ -d ".venv" ]] && rm -rf .venv && say "removed legacy in-tree .venv"

printf 'VIZ_PY=%s\n' "$PY" > .viz.env
say "wrote .viz.env (VIZ_PY=$PY)"
say "smoke: $PY service/viz/waveform_compare_test.py"
printf '✓ viz venv ready\n'
