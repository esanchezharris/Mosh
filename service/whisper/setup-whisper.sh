#!/usr/bin/env bash
# One-command setup for word-level speech transcription (OpenAI Whisper, MIT).
#
# Whisper is kept in a DEDICATED venv (like transcribe/sketch) so its deps (torch /
# numba / tiktoken) never collide with the service interpreter or the other venvs. This
# creates ~/Library/Mosh/venvs/whisper (override the root with MOSH_VENVS_DIR), installs
# openai-whisper, validates the import, and writes service/whisper/.whisper.env
# (WHISPER_PY) which run.sh sources — so /transcribe_words just works with no
# per-launch exports.
#
# The venv deliberately lives OUTSIDE the repo tree: in-tree .venvs sat under
# iCloud-synced ~/Documents and iCloud silently evicted files from them (twice in two
# days), breaking product paths with no install-time error. The .env file stays the
# single source of truth for where the venv is.
#
# Used by the "mumble take" flow: a sung take → confidence-gated words placed as lyric
# anchors. If the venv is absent the service degrades gracefully — /transcribe_words
# returns EMPTY words (everything becomes a gap; the rhythm sheet still builds), never a
# 503 and never invented words.
#
# Idempotent + cheap to re-run: a healthy venv just re-validates (no installer runs);
# pass --reinstall to force the full install/top-up path.
set -euo pipefail
cd "$(dirname "$0")"          # service/whisper/
HERE="$(pwd)"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

printf '— Mosh word-transcription setup (Whisper) —\n'

REINSTALL=0
[[ "${1:-}" == "--reinstall" ]] && REINSTALL=1

# Venv location (outside iCloud — see the header note).
VENVS_ROOT="${MOSH_VENVS_DIR:-$HOME/Library/Mosh/venvs}"
VENV="$VENVS_ROOT/whisper"
PYBIN="$VENV/bin/python"
LEGACY_VENV="$HERE/.venv"

# Sanity: the venv must import whisper AND expose load_model (the entrypoint the CLI
# uses). Don't load weights here — just confirm the API is resolvable.
venv_ok() {
  [[ -x "$PYBIN" ]] || return 1
  "$PYBIN" - <<'PY'
import importlib.util, sys
ok = importlib.util.find_spec("whisper") is not None
if ok:
    import whisper  # noqa: F401
    assert hasattr(whisper, "load_model")
sys.exit(0 if ok else 1)
PY
}

if [[ "$REINSTALL" == "0" ]] && venv_ok >/dev/null 2>&1; then
  # Cheap path: the venv already validates — skip the installer entirely.
  say "venv ✓ (validated at $VENV — install skipped; --reinstall forces a top-up)"
else
  # 1. Pick a Python. Prefer 3.11 (best torch/whisper wheel compatibility on arm64-mac),
  #    then fall back to whatever python3 resolves to.
  PY=""
  for cand in python3.11 python3.12 python3; do
    if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
  done
  [[ -n "$PY" ]] || fail "no python3 found on PATH"
  say "python = $PY ($($PY --version 2>&1))"

  # 2. Create / reuse the venv. Use uv when present (much faster), else stdlib venv.
  if [[ ! -x "$PYBIN" ]]; then
    say "creating venv at $VENV …"
    mkdir -p "$VENVS_ROOT"
    if command -v uv >/dev/null 2>&1; then
      uv venv --python "$PY" "$VENV" >/dev/null
    else
      "$PY" -m venv "$VENV"
    fi
  fi

  # 3. Install openai-whisper. `setuptools<81` is required because the dependency stack
  #    (numba / whisper itself) imports pkg_resources, which setuptools 81+ removed (and uv
  #    venvs omit) — the same trap the transcribe venv hit. We do NOT download model weights
  #    here; Whisper lazy-downloads the `base` model on the first transcription.
  say "installing openai-whisper (may take a few minutes — pulls torch) …"
  if command -v uv >/dev/null 2>&1; then
    VIRTUAL_ENV="$VENV" uv pip install --python "$PYBIN" --quiet "openai-whisper" "setuptools<81"
  else
    "$PYBIN" -m pip install --quiet --upgrade pip "setuptools<81"
    "$PYBIN" -m pip install --quiet "openai-whisper"
  fi

  # 4. Validate the fresh install.
  venv_ok || fail "the venv cannot import whisper — install failed; inspect $VENV"
  say "venv ✓ (whisper importable)"
fi

# 5. Persist the resolved interpreter so run.sh / the service find it with no exports.
ENVFILE="$HERE/.whisper.env"
cat > "$ENVFILE" <<EOF
# Written by service/whisper/setup-whisper.sh — sourced by run.sh. Safe to delete (the
# service falls back to /transcribe_words -> empty words; the rhythm sheet still builds).
export WHISPER_PY="$PYBIN"
EOF
say "wrote $ENVFILE"

# 6. Drop a legacy in-tree venv once the new location validates — it was the
#    iCloud-corruption vector and only wastes sync bandwidth now.
if [[ -d "$LEGACY_VENV" && "$LEGACY_VENV" != "$VENV" ]]; then
  rm -rf "$LEGACY_VENV"
  say "removed legacy in-tree venv $LEGACY_VENV (superseded by $VENV)"
fi

printf '\n✓ Word transcription ready. Right-click a vocal take → Build lyrics from this take.\n'
