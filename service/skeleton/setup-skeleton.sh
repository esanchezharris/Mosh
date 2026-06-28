#!/usr/bin/env bash
# One-command setup for the Phase-2 mumble->skeleton F0 contour (FCPE, MIT).
#
# FCPE is kept in a DEDICATED venv (like transcribe/whisper/sketch) so its deps (torch /
# torchfcpe) never collide with the service interpreter or the other venvs. This creates
# service/skeleton/.venv, installs torch + torchfcpe, validates the import, and writes
# service/skeleton/.skeleton.env (SKELETON_PY) which run.sh sources — so /skeleton_spec
# uses the F0 upgrade with no per-launch exports.
#
# The skeleton path degrades gracefully WITHOUT this: /skeleton_spec still builds a sheet
# from Basic-Pitch note onsets (one note = one syllable). FCPE only UPGRADES accuracy by
# splitting a re-articulated sustained note into multiple syllable nuclei.
#
# Idempotent: re-running re-validates and tops up the venv.
set -euo pipefail
cd "$(dirname "$0")"          # service/skeleton/
HERE="$(pwd)"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

printf '— Mosh mumble->skeleton setup (FCPE F0) —\n'

# 1. Pick a Python (prefer 3.11 for arm64-mac torch wheels), else fall back.
PY=""
for cand in python3.11 python3.12 python3; do
  if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
done
[[ -n "$PY" ]] || fail "no python3 found on PATH"
say "python = $PY ($($PY --version 2>&1))"

# 2. Create / reuse the venv (uv when present — much faster — else stdlib venv).
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

# 3. Install torch + torchfcpe. `setuptools<81` for the pkg_resources trap (numba et al.),
#    same as the transcribe/whisper venvs. FCPE bundles its model weights (no separate fetch).
say "installing torch + torchfcpe (may take a few minutes — pulls torch) …"
if command -v uv >/dev/null 2>&1; then
  VIRTUAL_ENV="$VENV" uv pip install --python "$PYBIN" --quiet torch torchaudio torchfcpe "setuptools<81"
else
  "$PYBIN" -m pip install --quiet --upgrade pip "setuptools<81"
  "$PYBIN" -m pip install --quiet torch torchaudio torchfcpe
fi

# 4. Sanity: the venv must import torchfcpe and expose the bundled-model spawner.
"$PYBIN" - <<'PY' || fail "the venv cannot import torchfcpe — install failed; inspect service/skeleton/.venv"
import importlib.util, sys
ok = importlib.util.find_spec("torchfcpe") is not None and importlib.util.find_spec("torch") is not None
if ok:
    from torchfcpe import spawn_bundled_infer_model  # noqa: F401
sys.exit(0 if ok else 1)
PY
say "venv ✓ (torchfcpe importable)"

# 5. Persist the resolved interpreter so run.sh / the service find it with no exports.
ENVFILE="$HERE/.skeleton.env"
cat > "$ENVFILE" <<EOF
# Written by service/skeleton/setup-skeleton.sh — sourced by run.sh. Safe to delete (the
# skeleton path falls back to Basic-Pitch note onsets; one note = one syllable).
export SKELETON_PY="$PYBIN"
EOF
say "wrote $ENVFILE"

printf '\n✓ Mumble->skeleton F0 ready. Right-click a hummed take → Build flow from this take.\n'
