#!/usr/bin/env bash
# One-command setup for the Stage-0 phoneme-template probe (EXPERIMENT, not product).
#
# Creates a DEDICATED venv (~/Library/Mosh/venvs/phonoprobe — override root with
# MOSH_VENVS_DIR) so transformers/panphon never touch a product venv's pins. Installs
# torch + transformers + panphon + the g2p stack, pre-downloads the wav2vec2 CTC phoneme
# model (facebook/wav2vec2-xlsr-53-espeak-cv-ft, ~1.2 GB — the HF cache here holds only
# the tokenizer), validates with a real 1-second forward pass, and writes .probe.env
# (PROBE_PY) next to this script.
#
# Idempotent: a healthy venv + cached model just re-validates. --reinstall forces the
# installer. Nothing in the product (service/, run.sh) reads .probe.env.
set -euo pipefail
cd "$(dirname "$0")"          # scripts/fms-phoneme-probe/
HERE="$(pwd)"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

printf '— FMS phoneme-probe setup (wav2vec2 CTC + panphon) —\n'

REINSTALL=0
[[ "${1:-}" == "--reinstall" ]] && REINSTALL=1

VENVS_ROOT="${MOSH_VENVS_DIR:-$HOME/Library/Mosh/venvs}"
VENV="$VENVS_ROOT/phonoprobe"
PYBIN="$VENV/bin/python"
MODEL="facebook/wav2vec2-xlsr-53-espeak-cv-ft"

# The venv must import the whole probe stack.
venv_ok() {
  [[ -x "$PYBIN" ]] || return 1
  "$PYBIN" - <<'PY'
import importlib.util, sys
mods = ["torch", "torchaudio", "transformers", "panphon", "g2p_en", "pronouncing"]
sys.exit(0 if all(importlib.util.find_spec(m) for m in mods) else 1)
PY
}

if [[ "$REINSTALL" == "0" ]] && venv_ok >/dev/null 2>&1; then
  say "venv ✓ (validated at $VENV — install skipped; --reinstall forces a top-up)"
else
  PY=""
  for cand in python3.11 python3.12 python3; do
    if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
  done
  [[ -n "$PY" ]] || fail "no python3 found on PATH"
  say "python = $PY ($($PY --version 2>&1))"

  if [[ ! -x "$PYBIN" ]]; then
    say "creating venv at $VENV …"
    mkdir -p "$VENVS_ROOT"
    if command -v uv >/dev/null 2>&1; then
      uv venv --python "$PY" "$VENV" >/dev/null
    else
      "$PY" -m venv "$VENV"
    fi
  fi

  say "installing torch + transformers + panphon + g2p stack (a few minutes) …"
  if command -v uv >/dev/null 2>&1; then
    VIRTUAL_ENV="$VENV" uv pip install --python "$PYBIN" --quiet \
      torch torchaudio transformers panphon g2p-en pronouncing "setuptools<81"
  else
    "$PYBIN" -m pip install --quiet --upgrade pip "setuptools<81"
    "$PYBIN" -m pip install --quiet torch torchaudio transformers panphon g2p-en pronouncing
  fi
  "$PYBIN" -m nltk.downloader -q averaged_perceptron_tagger averaged_perceptron_tagger_eng cmudict >/dev/null 2>&1 || true

  venv_ok || fail "the venv cannot import the probe stack — inspect $VENV"
  say "venv ✓ (torch/transformers/panphon importable)"
fi

# Pre-download the model weights (the cache in this home holds only the tokenizer), then
# prove a real forward pass. Downloads only on cache miss; later runs can go fully
# offline (HF_HUB_OFFLINE=1).
say "validating $MODEL (downloads ~1.2 GB on first run) …"
"$PYBIN" - <<PY || fail "wav2vec2 phoneme model validation failed"
import json, torch
from huggingface_hub import hf_hub_download
from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2ForCTC
# NOT Wav2Vec2Processor: its phoneme tokenizer imports phonemizer/espeak-ng, which this
# probe avoids — we decode CTC ids against vocab.json ourselves (frame spans need a
# hand-rolled collapse anyway).
name = "$MODEL"
vocab = json.load(open(hf_hub_download(name, "vocab.json"), encoding="utf-8"))
fe = Wav2Vec2FeatureExtractor.from_pretrained(name)
model = Wav2Vec2ForCTC.from_pretrained(name)
model.eval()
wave = torch.zeros(1, 16000)
with torch.no_grad():
    logits = model(wave).logits
assert logits.shape[0] == 1 and logits.shape[-1] == len(vocab), (logits.shape, len(vocab))
print(f"  model ✓ (vocab={len(vocab)}, frames/s≈{logits.shape[1]})")
PY

ENVFILE="$HERE/.probe.env"
cat > "$ENVFILE" <<EOF
# Written by scripts/fms-phoneme-probe/setup-probe.sh. Experiment-only — nothing in the
# product reads this. Safe to delete and re-run setup.
export PROBE_PY="$PYBIN"
EOF
say "wrote $ENVFILE"

printf '\n✓ Phoneme probe ready. See RUNBOOK.md for the run order.\n'
