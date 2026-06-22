#!/usr/bin/env bash
# One-command setup for the Phase-4 command-emission SFT lane (local mlx-lm LoRA).
#
# The trainer (sft_cli.py) shells out to mlx-lm (mlx_lm.lora / .fuse / .server),
# which is Apple-Silicon + Metal only. We keep it in a DEDICATED venv
# (service/sft/.venv) so MLX never collides with the service interpreter or the
# SA3 / transcribe / sketch venvs. This creates the venv, installs mlx-lm, validates
# the import, and writes service/sft/.sft.env (SFT_PY) used by sft_cli.py + the
# eval/serve commands.
#
# Idempotent: re-running re-validates and tops up the venv.
set -euo pipefail
cd "$(dirname "$0")"          # service/sft/
HERE="$(pwd)"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

printf '— Mosh SFT setup (mlx-lm LoRA, Apple Silicon) —\n'

# 0. MLX is arm64-Metal only — fail clearly anywhere else (the RunPod/CUDA path is
#    a separate, deferred rung; do not pretend to train here).
[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || \
  fail "mlx-lm requires Apple Silicon (arm64 macOS). For non-Mac training use the deferred RunPod path."

# 1. Pick a Python. Prefer 3.11 (best MLX wheel coverage), then fall back.
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
    uv venv --python 3.11 "$VENV" >/dev/null
  else
    "$PY" -m venv "$VENV"
  fi
fi

# 3. Install mlx-lm (pulls mlx + transformers + huggingface_hub). Pin >=0.26.2 —
#    the version that built mlx-community/Qwen3-4B-Instruct-2507-4bit (train + serve
#    must use the same mlx-lm so the chat template matches).
say "installing mlx-lm (may take a minute) …"
if command -v uv >/dev/null 2>&1; then
  VIRTUAL_ENV="$VENV" uv pip install --python "$PYBIN" --quiet "mlx-lm>=0.26.2" "huggingface_hub"
else
  "$PYBIN" -m pip install --quiet --upgrade pip
  "$PYBIN" -m pip install --quiet "mlx-lm>=0.26.2" "huggingface_hub"
fi

# 4. Sanity: the venv must import mlx_lm and expose the lora entry point.
"$PYBIN" - <<'PY' || fail "the venv cannot import mlx_lm — install failed; inspect service/sft/.venv"
import importlib.util, sys
ok = importlib.util.find_spec("mlx_lm") is not None and importlib.util.find_spec("mlx_lm.lora") is not None
sys.exit(0 if ok else 1)
PY
say "venv ✓ (mlx_lm importable)  version: $("$PYBIN" -c 'import mlx_lm; print(getattr(mlx_lm,"__version__","?"))' 2>/dev/null || echo '?')"

# 5. Persist the resolved interpreter for sft_cli.py + the serve/eval commands.
ENVFILE="$HERE/.sft.env"
cat > "$ENVFILE" <<EOF
# Written by service/sft/setup-sft.sh. Safe to delete (re-run setup to recreate).
export SFT_PY="$PYBIN"
EOF
say "wrote $ENVFILE"

printf '\n✓ SFT ready. Next:\n'
printf '    source service/sft/.sft.env\n'
printf '    cd ui && npm run build-sft -- --corpus <DAW-projects-dir> --out ../service/sft/.sft-data/sft-v1 && cd ..\n'
printf '    "$SFT_PY" service/sft/sft_cli.py train --data service/sft/.sft-data/sft-v1 --out service/sft/.adapters/sft-v1\n'
