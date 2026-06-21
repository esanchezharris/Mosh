#!/usr/bin/env bash
# One-command setup for the REAL Tier-B transform backend (RAVE timbre transfer).
#
# RAVE (IRCAM ACIDS) pretrained models export to TorchScript (.ts) and run with plain
# torch — no training stack. We keep it in a DEDICATED venv so torch never collides
# with the service interpreter / the SA3 MLX venv. This script creates
# service/transform/.venv, installs torch + torchaudio (inference only), validates the
# import, and writes service/transform/.transform.env (TRANSFORM_PY + RAVE_MODEL_DIR)
# which run.sh sources — so the `transform` adapter uses the real model with no exports.
#
# If the venv / models are absent the service degrades gracefully: the `transform`
# adapter falls back to the deterministic FAKE transform (Route B) and the rest of Mosh
# is unaffected — exactly the SA3 posture.
#
# Bring your own RAVE models: drop <target>.ts files into RAVE_MODEL_DIR (default
# ~/AI/rave-models). Pretrained models live on the ACIDS releases / HuggingFace
# (e.g. vintage.ts, percussion.ts, darbouka.ts). The file stem is the `target` name.
#
# Idempotent: re-running re-validates and tops up the venv.
set -euo pipefail
cd "$(dirname "$0")"          # service/transform/
HERE="$(pwd)"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

printf '— Mosh transform setup (RAVE) —\n'

# 1. Pick a Python (3.10–3.12 all have arm64 torch wheels).
PY=""
for cand in python3.11 python3.12 python3.10 python3; do
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

# 3. Install torch + torchaudio (the only install step). arm64-mac wheels are MPS-
#    capable; CPU inference is fine for offline file-based renders.
say "installing torch + torchaudio (large download, may take several minutes) …"
if command -v uv >/dev/null 2>&1; then
  VIRTUAL_ENV="$VENV" uv pip install --python "$PYBIN" --quiet torch torchaudio numpy
else
  "$PYBIN" -m pip install --quiet --upgrade pip
  "$PYBIN" -m pip install --quiet torch torchaudio numpy
fi

# 4. Sanity: the venv must import torch + torchaudio.
"$PYBIN" - <<'PY' || fail "the venv cannot import torch/torchaudio — install failed; inspect service/transform/.venv"
import importlib.util, sys
ok = importlib.util.find_spec("torch") is not None and importlib.util.find_spec("torchaudio") is not None
if ok:
    import torch  # noqa: F401
sys.exit(0 if ok else 1)
PY
say "venv ✓ (torch + torchaudio importable)"

# 5. Model dir (bring your own .ts RAVE models).
RAVE_MODEL_DIR="${RAVE_MODEL_DIR:-$HOME/AI/rave-models}"
mkdir -p "$RAVE_MODEL_DIR"
NMODELS=$(find "$RAVE_MODEL_DIR" -maxdepth 1 -name '*.ts' 2>/dev/null | wc -l | tr -d ' ')
say "model dir = $RAVE_MODEL_DIR ($NMODELS RAVE .ts model(s) found)"
[[ "$NMODELS" == "0" ]] && say "  (drop <target>.ts RAVE models here — the file stem is the target name)"

# 6. Persist the resolved paths so run.sh / the service find them with no exports.
ENVFILE="$HERE/.transform.env"
cat > "$ENVFILE" <<EOF
# Written by service/transform/setup-transform.sh — sourced by run.sh. Safe to delete
# (the transform adapter falls back to the deterministic fake transform, Route B).
export TRANSFORM_PY="$PYBIN"
export RAVE_MODEL_DIR="$RAVE_MODEL_DIR"
EOF
say "wrote $ENVFILE"

printf '\n✓ Transform (RAVE) ready. Drop .ts models into %s, then use the "+ Transform" drawer.\n' "$RAVE_MODEL_DIR"
