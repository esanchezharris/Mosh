#!/usr/bin/env bash
# One-command setup for real Stable Audio 3 in the Mosh generative service.
#
# Real SA3 needs three things the bundled FakeAdapter doesn't:
#   1. SA3_MLX_DIR  — the external MLX Stable-Audio-3 port (model weights + scripts).
#                     User-provided; this script VALIDATES but does NOT download it
#                     (multi-GB, licensed). Default: ~/AI/stable-audio-3/optimized/mlx.
#   2. a Python venv at $SA3_MLX_DIR/.venv with mlx + the port's deps.
#   3. COLORRACK_DATA — already built + checked in at service/colors/COLORRACK_DATA.
#
# It writes the resolved paths to service/.sa3.env, which run.sh sources, so you set
# nothing per launch. Idempotent: re-running re-validates and tops up the venv.
#
# On success real SA3 serves. If the model port is absent it fails loud (exit 1) and
# the app keeps working on the deterministic FakeAdapter.
set -euo pipefail
cd "$(dirname "$0")"        # service/
HERE="$(pwd)"

SA3_MLX_DIR="${SA3_MLX_DIR:-$HOME/AI/stable-audio-3/optimized/mlx}"
COLORRACK_DATA="${COLORRACK_DATA:-$HERE/colors/COLORRACK_DATA}"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

printf '— Mosh SA3 setup —\n'
say "SA3_MLX_DIR    = $SA3_MLX_DIR"
say "COLORRACK_DATA = $COLORRACK_DATA"

# 1. Validate the external model port — the EXACT check engine.py:engine_available()
#    gates on, so "setup says ready" matches "the service will enable SA3".
MARKER="$SA3_MLX_DIR/scripts/sa3_mlx.py"
if [[ ! -f "$MARKER" ]]; then
  cat >&2 <<EOF

✗ SA3 model port not found.
  Expected: $MARKER
  Mosh does not download the model (multi-GB, licensed). Obtain the MLX
  Stable-Audio-3 port, then either:
    • place it at $SA3_MLX_DIR, or
    • re-run as:  SA3_MLX_DIR=/path/to/port ./setup-sa3.sh
  Until then Mosh runs on the FakeAdapter (deterministic, not real music).
EOF
  exit 1
fi
say "model port ✓"

# 2. Validate the bundled colour rack (drives the ASTD colour controls).
[[ -f "$COLORRACK_DATA/colors.json" ]] \
  || fail "colour rack missing at $COLORRACK_DATA (expected colors.json). Build it with: python3 colors/build_colorrack.py"
say "colour rack ✓"

# 3. Create / top up the MLX venv (the only install step).
VENV="$SA3_MLX_DIR/.venv"
PYBIN="$VENV/bin/python"
if [[ ! -x "$PYBIN" ]]; then
  say "creating venv at $VENV …"
  python3 -m venv "$VENV"
fi
say "installing deps (may take a minute) …"
"$PYBIN" -m pip install --quiet --upgrade pip
if [[ -f "$SA3_MLX_DIR/requirements.txt" ]]; then
  "$PYBIN" -m pip install --quiet -r "$SA3_MLX_DIR/requirements.txt"
else
  # The port ships no requirements.txt — install the runtime baseline. mlx is the
  # load-bearing dep (Apple-silicon inference); numpy backs the engine glue. If the
  # model code needs more, the import check below will surface it.
  "$PYBIN" -m pip install --quiet mlx numpy
fi

# 4. Sanity: the venv must be able to import mlx (else SA3 can't load).
"$PYBIN" - <<'PY' || fail "the venv cannot import mlx — install failed; inspect $SA3_MLX_DIR/.venv"
import importlib.util, sys
sys.exit(0 if importlib.util.find_spec("mlx") else 1)
PY
say "venv ✓ (mlx importable)"

# 5. Persist the resolved env so run.sh needs no per-launch exports.
ENVFILE="$HERE/.sa3.env"
cat > "$ENVFILE" <<EOF
# Written by service/setup-sa3.sh — sourced by run.sh. Safe to delete (the service
# falls back to the FakeAdapter). Not committed (see .gitignore).
export MOSH_ENABLE_SA3=1
export SA3_MLX_DIR="$SA3_MLX_DIR"
export COLORRACK_DATA="$COLORRACK_DATA"
EOF
say "wrote $ENVFILE"

printf '\n✓ SA3 ready. Launch Mosh and the service will load Stable Audio 3.\n'
printf '  (Set MOSH_ENABLE_SA3=0 to force the FakeAdapter even with SA3 installed.)\n'
