#!/usr/bin/env bash
# setup-taste.sh — validate (and optionally pre-fetch weights for) the taste-eval lane.
#
# Unlike the other feature setups this creates NO new venv: the embedding deps
# (torch / transformers / librosa / laion_clap) already live in the judges venv the
# Audiobox QA sidecar uses (~/AI/judges_venv — external, owner-managed, like the SA3
# weights). Duplicating ~4GB of torch under ~/Library/Mosh/venvs for week 1 would be
# waste; if the lane ever needs its own pins, move it then.
#
#   ./setup-taste.sh                  validate imports, write .taste.env
#   ./setup-taste.sh --fetch-weights  ALSO pre-download LAION-CLAP larger_clap_music
#                                     (Apache-2.0) + MERT-v0-public (the commercially
#                                     clean MERT) + the TuneJury head if published.
#
# LICENSE (charter Q4): MERT-330M / MuQ are CC-BY-NC — internal eval only; they are
# deliberately not wired. service/taste is NOT in the deploy bundle whitelist.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TASTE_PY="${MOSH_TASTE_PY:-${MOSH_JUDGES_PY:-$HOME/AI/judges_venv/bin/python}}"

if [ ! -x "$TASTE_PY" ]; then
  echo "ERROR: eval python not found at $TASTE_PY" >&2
  echo "Point MOSH_TASTE_PY at an interpreter with torch+transformers+librosa" >&2
  exit 1
fi

echo "== validating imports under $TASTE_PY"
"$TASTE_PY" - <<'PY'
import importlib, sys
missing = []
for m in ("torch", "transformers", "librosa", "numpy"):
    try:
        importlib.import_module(m)
    except Exception as e:
        missing.append(f"{m}: {e}")
if missing:
    sys.stderr.write("MISSING: " + "; ".join(missing) + "\n")
    sys.exit(1)
print("imports ok")
PY

if [ "${1:-}" = "--tunejury" ]; then
  # TuneJury needs its own pins (torchaudio<2.8 — >=2.8 routes load() through
  # torchcodec, the documented gotcha) — an ISOLATED venv under the standard venvs
  # root, NEVER the judges venv (breaking that would break render QA). The repo is
  # NOT pip-installable (no pyproject despite the README) — clone + core deps +
  # a .pth link is the working recipe. CC-BY-NC primary head: internal eval only.
  ROOT="${MOSH_VENVS_DIR:-$HOME/Library/Mosh/venvs}"
  VENV="$ROOT/tunejury"
  REPO="$ROOT/tunejury-repo"
  echo "== creating $VENV"
  mkdir -p "$ROOT"
  [ -d "$REPO/.git" ] || git clone --depth 1 https://github.com/yonghyunk1m/TuneJury "$REPO"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip >/dev/null
  "$VENV/bin/pip" install "torch>=2.0,<2.8" "torchaudio>=2.0,<2.8" "torchvision<0.23" \
    "numpy" "librosa" "soundfile" "transformers" "huggingface_hub" "laion_clap" "nnAudio"
  SITE="$("$VENV/bin/python" -c 'import site; print(site.getsitepackages()[0])')"
  echo "$REPO" > "$SITE/tunejury_repo.pth"
  "$VENV/bin/python" -c "from tunejury.score import Scorer; print('tunejury import ok')"
  echo "TUNEJURY_PY=$VENV/bin/python" >> "$HERE/.taste.env"
  echo "tunejury venv ready — export MOSH_TUNEJURY_PY=$VENV/bin/python (or let the default path resolve)"
  exit 0
fi

if [ "${1:-}" = "--fetch-weights" ]; then
  echo "== pre-fetching weights (HF cache)"
  "$TASTE_PY" - <<'PY'
from transformers import ClapModel, ClapProcessor, AutoModel, Wav2Vec2FeatureExtractor
ClapProcessor.from_pretrained("laion/larger_clap_music")
ClapModel.from_pretrained("laion/larger_clap_music")
print("clap: laion/larger_clap_music cached")
AutoModel.from_pretrained("m-a-p/MERT-v0-public", trust_remote_code=True)
Wav2Vec2FeatureExtractor.from_pretrained("m-a-p/MERT-v0-public", trust_remote_code=True)
print("mert: m-a-p/MERT-v0-public cached")
try:
    from huggingface_hub import snapshot_download
    snapshot_download("TuneJury/tunejury")
    print("tunejury: head cached")
except Exception as e:  # noqa: BLE001
    print(f"tunejury: not fetched ({e}) — wire-up is gated on a two-class label archive anyway")
PY
fi

cat > "$HERE/.taste.env" <<EOF
TASTE_PY=$TASTE_PY
EOF
echo "wrote $HERE/.taste.env (TASTE_PY=$TASTE_PY)"
echo "smoke: python3 $HERE/build_table.py --families audiobox,fake"
