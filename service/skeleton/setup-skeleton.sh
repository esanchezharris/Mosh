#!/usr/bin/env bash
# One-command setup for the Phase-2 mumble->skeleton F0 contour (FCPE, MIT).
#
# FCPE is kept in a DEDICATED venv (like transcribe/whisper/sketch) so its deps (torch /
# torchfcpe) never collide with the service interpreter or the other venvs. This creates
# ~/Library/Mosh/venvs/skeleton (override the root with MOSH_VENVS_DIR), installs
# torch + torchfcpe, validates the import, and writes service/skeleton/.skeleton.env
# (SKELETON_PY) which run.sh sources — so /skeleton_spec uses the F0 upgrade with no
# per-launch exports.
#
# The venv deliberately lives OUTSIDE the repo tree: in-tree .venvs sat under
# iCloud-synced ~/Documents and iCloud silently evicted files from them (twice in two
# days), breaking product paths with no install-time error. The .env file stays the
# single source of truth for where the venv is.
#
# The skeleton path degrades gracefully WITHOUT this: /skeleton_spec still builds a sheet
# from Basic-Pitch note onsets (one note = one syllable). FCPE only UPGRADES accuracy by
# splitting a re-articulated sustained note into multiple syllable nuclei.
#
# Idempotent + cheap to re-run: a healthy venv just re-validates (no installer runs);
# pass --reinstall to force the full install/top-up path.
set -euo pipefail
cd "$(dirname "$0")"          # service/skeleton/
HERE="$(pwd)"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

printf '— Mosh mumble->skeleton setup (FCPE F0) —\n'

REINSTALL=0
[[ "${1:-}" == "--reinstall" ]] && REINSTALL=1

# Venv location (outside iCloud — see the header note).
VENVS_ROOT="${MOSH_VENVS_DIR:-$HOME/Library/Mosh/venvs}"
VENV="$VENVS_ROOT/skeleton"
PYBIN="$VENV/bin/python"
LEGACY_VENV="$HERE/.venv"

# Sanity: the venv must import torchfcpe and expose the bundled-model spawner.
venv_ok() {
  [[ -x "$PYBIN" ]] || return 1
  "$PYBIN" - <<'PY'
import importlib.util, sys
ok = importlib.util.find_spec("torchfcpe") is not None and importlib.util.find_spec("torch") is not None
if ok:
    from torchfcpe import spawn_bundled_infer_model  # noqa: F401
sys.exit(0 if ok else 1)
PY
}

if [[ "$REINSTALL" == "0" ]] && venv_ok >/dev/null 2>&1; then
  # Cheap path: the venv already validates — skip the installer entirely.
  say "venv ✓ (validated at $VENV — install skipped; --reinstall forces a top-up)"
else
  # 1. Pick a Python (prefer 3.11 for arm64-mac torch wheels), else fall back.
  PY=""
  for cand in python3.11 python3.12 python3; do
    if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
  done
  [[ -n "$PY" ]] || fail "no python3 found on PATH"
  say "python = $PY ($($PY --version 2>&1))"

  # 2. Create / reuse the venv (uv when present — much faster — else stdlib venv).
  if [[ ! -x "$PYBIN" ]]; then
    say "creating venv at $VENV …"
    mkdir -p "$VENVS_ROOT"
    if command -v uv >/dev/null 2>&1; then
      uv venv --python "$PY" "$VENV" >/dev/null
    else
      "$PY" -m venv "$VENV"
    fi
  fi

  # 3. Install torch + torchfcpe. `setuptools<81` for the pkg_resources trap (numba et al.),
  #    same as the transcribe/whisper venvs. FCPE bundles its model weights (no separate fetch).
  #    Also: pronouncing (cmudict) + g2p-en (OOV/slang pronunciation) + uroman (romanizer for
  #    MMS_FA forced alignment) — the FMS sung-render chain (align.py + soulx score author)
  #    needs real phonemes on this venv, or OOV words fall back to "ah-ah" and align can't romanize.
  say "installing torch + torchfcpe + phoneme/alignment deps (may take a few minutes) …"
  if command -v uv >/dev/null 2>&1; then
    VIRTUAL_ENV="$VENV" uv pip install --python "$PYBIN" --quiet torch torchaudio torchfcpe pronouncing g2p-en uroman "setuptools<81"
  else
    "$PYBIN" -m pip install --quiet --upgrade pip "setuptools<81"
    "$PYBIN" -m pip install --quiet torch torchaudio torchfcpe pronouncing g2p-en uroman
  fi
  # g2p-en needs the nltk POS-tagger + cmudict data at runtime (same as the phonology venv).
  "$PYBIN" -m nltk.downloader -q averaged_perceptron_tagger averaged_perceptron_tagger_eng cmudict >/dev/null 2>&1 || true

  # 4. Validate the fresh install.
  venv_ok || fail "the venv cannot import torchfcpe — install failed; inspect $VENV"
  say "venv ✓ (torchfcpe importable)"
fi

# 5. Persist the resolved interpreter so run.sh / the service find it with no exports.
ENVFILE="$HERE/.skeleton.env"
cat > "$ENVFILE" <<EOF
# Written by service/skeleton/setup-skeleton.sh — sourced by run.sh. Safe to delete (the
# skeleton path falls back to Basic-Pitch note onsets; one note = one syllable).
export SKELETON_PY="$PYBIN"
EOF
say "wrote $ENVFILE"

# 6. Drop a legacy in-tree venv once the new location validates — it was the
#    iCloud-corruption vector and only wastes sync bandwidth now.
if [[ -d "$LEGACY_VENV" && "$LEGACY_VENV" != "$VENV" ]]; then
  rm -rf "$LEGACY_VENV"
  say "removed legacy in-tree venv $LEGACY_VENV (superseded by $VENV)"
fi

printf '\n✓ Mumble->skeleton F0 ready. Right-click a hummed take → Build flow from this take.\n'
