#!/usr/bin/env bash
# One-command setup for the PC-NSF-HiFiGAN resynthesis SPIKE lane.
#
# Vocoder that rebuilds a vocal from (mel + explicit F0): hand it a corrected pitch curve and
# it re-sings at the new pitch, formant-preserving, no autotune smear (the @KRTK_12 / HachiTune
# technique). We keep it in a DEDICATED venv so torch never collides with the service
# interpreter / other feature venvs. Creates ~/Library/Mosh/venvs/nsf (override root with
# MOSH_VENVS_DIR), installs torch+librosa+soundfile+numpy, and downloads the OpenVPI checkpoint
# to ~/AI/pc-nsf-hifigan (override with NSF_MODEL_DIR).
#
# LICENCE: the checkpoint WEIGHTS are CC BY-NC-SA 4.0 (NON-commercial). This is a spike /
# owner-only lane — NEVER shipped in the product. To ship, self-train a checkpoint from the
# MIT-licensed openvpi/SingingVocoders trainer. See
# docs/superpowers/specs/2026-07-12-pc-nsf-hifigan-spike-design.md.
#
# The venv lives OUTSIDE the repo tree (in-tree .venvs sat under iCloud and were silently
# evicted — see the transform/skeleton setup notes). Idempotent: a healthy venv re-validates
# without reinstalling; --reinstall forces a top-up.
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
printf '— Mosh PC-NSF-HiFiGAN spike setup —\n'

REINSTALL=0
[[ "${1:-}" == "--reinstall" ]] && REINSTALL=1

VENVS_ROOT="${MOSH_VENVS_DIR:-$HOME/Library/Mosh/venvs}"
VENV="$VENVS_ROOT/nsf"
PYBIN="$VENV/bin/python3"
MODEL_DIR="${NSF_MODEL_DIR:-$HOME/AI/pc-nsf-hifigan}"
REL="pc-nsf-hifigan-44.1k-hop512-128bin-2025.02"
ASSET="pc_nsf_hifigan_44.1k_hop512_128bin_2025.02"
CKPT="$MODEL_DIR/$ASSET/model.ckpt"

venv_ok() {
  [[ -x "$PYBIN" ]] || return 1
  "$PYBIN" - <<'PY' >/dev/null 2>&1
import importlib.util as u, sys
sys.exit(0 if all(u.find_spec(m) for m in ("torch","librosa","soundfile","numpy")) else 1)
PY
}

if [[ "$REINSTALL" == "0" ]] && venv_ok; then
  say "venv ✓ ($VENV — install skipped; --reinstall forces a top-up)"
else
  BASE=$(command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3) \
    || fail "no python3 found"
  say "creating venv at $VENV ($("$BASE" --version))"
  "$BASE" -m venv "$VENV"
  say "installing torch + librosa + soundfile + numpy (torch is large; cached after the first run)…"
  "$PYBIN" -m pip install -q --disable-pip-version-check torch numpy librosa soundfile \
    || fail "pip install failed"
  venv_ok || fail "venv validation failed after install"
  say "venv ✓"
fi

if [[ -f "$CKPT" ]]; then
  say "checkpoint ✓ ($CKPT)"
else
  URL="https://github.com/openvpi/vocoders/releases/download/$REL/$ASSET.zip"
  say "downloading checkpoint (CC BY-NC-SA, ~50MB) from $URL"
  mkdir -p "$MODEL_DIR"
  curl -fsSL -o "$MODEL_DIR/model.zip" "$URL" || fail "download failed"
  ( cd "$MODEL_DIR" && unzip -oq model.zip && rm -f model.zip )
  [[ -f "$CKPT" ]] || fail "checkpoint missing after unzip: $CKPT"
  say "checkpoint ✓ ($CKPT)"
fi

printf '\n✓ NSF spike ready. Round-trip golden:\n'
printf '    %s service/nsf/nsf_roundtrip_test.py\n' "$PYBIN"
printf '  Resynth a render (spike):\n'
printf '    %s scripts/fms-killshot/backhalf_nsf.py render && python3 scripts/fms-killshot/backhalf_nsf.py page\n' "$PYBIN"
