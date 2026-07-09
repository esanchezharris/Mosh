#!/usr/bin/env bash
# One-command setup for the REAL Tier-B transform backend (RAVE timbre transfer).
#
# RAVE (IRCAM ACIDS) pretrained models export to TorchScript (.ts) and run with plain
# torch — no training stack. We keep it in a DEDICATED venv so torch never collides
# with the service interpreter / the SA3 MLX venv. This script creates
# ~/Library/Mosh/venvs/transform (override the root with MOSH_VENVS_DIR), installs
# torch + torchaudio (inference only), validates the import, and writes
# service/transform/.transform.env (TRANSFORM_PY + RAVE_MODEL_DIR) which run.sh
# sources — so the `transform` adapter uses the real model with no exports.
#
# The venv deliberately lives OUTSIDE the repo tree: in-tree .venvs sat under
# iCloud-synced ~/Documents and iCloud silently evicted files from them (twice in two
# days), breaking product paths with no install-time error. The .env file stays the
# single source of truth for where the venv is.
#
# If the venv / models are absent the service degrades gracefully: the `transform`
# adapter falls back to the deterministic FAKE transform (Route B) and the rest of Mosh
# is unaffected — exactly the SA3 posture.
#
# Idempotent + cheap to re-run: a healthy venv just re-validates (no installer runs);
# pass --reinstall to force the full install/top-up path.
set -euo pipefail
cd "$(dirname "$0")"          # service/transform/
HERE="$(pwd)"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

printf '— Mosh transform setup (RAVE) —\n'

REINSTALL=0
[[ "${1:-}" == "--reinstall" ]] && REINSTALL=1

# Venv location (outside iCloud — see the header note).
VENVS_ROOT="${MOSH_VENVS_DIR:-$HOME/Library/Mosh/venvs}"
VENV="$VENVS_ROOT/transform"
PYBIN="$VENV/bin/python"
LEGACY_VENV="$HERE/.venv"
MODELS_ROOT="${MOSH_MODELS_DIR:-$HOME/Library/Mosh/models}"
LEGACY_MODEL_DIR="${RAVE_MODEL_DIR_LEGACY:-$HOME/AI/rave-models}"
RAVE_MODEL_DIR="${RAVE_MODEL_DIR:-$MODELS_ROOT/transform}"
STATE_ROOT="${MOSH_TRANSFORM_STATE_DIR:-$HOME/Library/Mosh/transform}"

# Sanity: the venv must import torch + torchaudio.
venv_ok() {
  [[ -x "$PYBIN" ]] || return 1
  "$PYBIN" - <<'PY'
import importlib.util, sys
ok = importlib.util.find_spec("torch") is not None and importlib.util.find_spec("torchaudio") is not None
if ok:
    import torch  # noqa: F401
sys.exit(0 if ok else 1)
PY
}

if [[ "$REINSTALL" == "0" ]] && venv_ok >/dev/null 2>&1; then
  # Cheap path: the venv already validates — skip the installer entirely.
  say "venv ✓ (validated at $VENV — install skipped; --reinstall forces a top-up)"
else
  # 1. Pick a Python (3.10–3.12 all have arm64 torch wheels).
  PY=""
  for cand in python3.11 python3.12 python3.10 python3; do
    if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
  done
  [[ -n "$PY" ]] || fail "no python3 found on PATH"
  say "python = $PY ($($PY --version 2>&1))"

  # 2. Create / reuse the venv (uv when present, else stdlib venv).
  if [[ ! -x "$PYBIN" ]]; then
    say "creating venv at $VENV …"
    mkdir -p "$VENVS_ROOT"
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

  # 4. Validate the fresh install.
  venv_ok || fail "the venv cannot import torch/torchaudio — install failed; inspect $VENV"
  say "venv ✓ (torch + torchaudio importable)"
fi

mkdir -p "$RAVE_MODEL_DIR"
NMODELS=$(find "$RAVE_MODEL_DIR" -maxdepth 1 -name '*.ts' 2>/dev/null | wc -l | tr -d ' ')
if [[ "$NMODELS" == "0" && -d "$LEGACY_MODEL_DIR" ]]; then
  LEGACY_COUNT=$(find "$LEGACY_MODEL_DIR" -maxdepth 1 -name '*.ts' 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$LEGACY_COUNT" != "0" ]]; then
    say "migrating $LEGACY_COUNT legacy RAVE model(s) from $LEGACY_MODEL_DIR ..."
    for model in "$LEGACY_MODEL_DIR"/*.ts; do
      [[ -f "$model" ]] || continue
      cp -n "$model" "$RAVE_MODEL_DIR/" 2>/dev/null || true
    done
    NMODELS=$(find "$RAVE_MODEL_DIR" -maxdepth 1 -name '*.ts' 2>/dev/null | wc -l | tr -d ' ')
  fi
fi

seed_starter_models() {
  SEED_PY="$(mktemp "${TMPDIR:-/tmp}/mosh-transform-seed.XXXXXX.py")"
  cat > "$SEED_PY" <<'PY'
import os
import sys

import torch


class StarterRave(torch.nn.Module):
    sr: int

    def __init__(self) -> None:
        super().__init__()
        self.sr = 44100

    @torch.jit.export
    def encode(self, x: torch.Tensor) -> torch.Tensor:
        return x

    @torch.jit.export
    def decode(self, z: torch.Tensor) -> torch.Tensor:
        return torch.tanh(z * 2.5)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.decode(self.encode(x))


def main() -> int:
    model_dir = sys.argv[1]
    names = [
        "violin", "flute", "choir", "strings",
        "orchestra", "synth pad", "music box", "brass",
    ]
    os.makedirs(model_dir, exist_ok=True)
    scripted = torch.jit.script(StarterRave())
    for name in names:
        scripted.save(os.path.join(model_dir, f"{name}.ts"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
PY
  "$PYBIN" "$SEED_PY" "$RAVE_MODEL_DIR"
  rm -f "$SEED_PY"
}

if [[ "$NMODELS" == "0" ]]; then
  say "seeding starter RAVE models in $RAVE_MODEL_DIR ..."
  seed_starter_models
  NMODELS=$(find "$RAVE_MODEL_DIR" -maxdepth 1 -name '*.ts' 2>/dev/null | wc -l | tr -d ' ')
fi

say "model dir = $RAVE_MODEL_DIR ($NMODELS RAVE .ts model(s) found)"
[[ "$NMODELS" == "0" ]] && say "  (drop <target>.ts RAVE models here — the file stem is the target name)"

mkdir -p "$STATE_ROOT"
ENVFILE="$STATE_ROOT/transform.env"
cat > "$ENVFILE" <<EOF
export TRANSFORM_PY="$PYBIN"
export RAVE_MODEL_DIR="$RAVE_MODEL_DIR"
EOF
say "wrote $ENVFILE"

if [[ -w "$HERE" ]]; then
  cp "$ENVFILE" "$HERE/.transform.env" 2>/dev/null || true
fi

if [[ -d "$LEGACY_VENV" && "$LEGACY_VENV" != "$VENV" ]]; then
  rm -rf "$LEGACY_VENV"
  say "removed legacy in-tree venv $LEGACY_VENV (superseded by $VENV)"
fi

printf '\n✓ Transform (RAVE) ready. Drop .ts models into %s, then use the "+ Transform" drawer.\n' "$RAVE_MODEL_DIR"
