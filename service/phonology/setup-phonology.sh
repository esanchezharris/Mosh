#!/usr/bin/env bash
# One-command setup for the phonology core (CMUdict + pronouncing + g2p) — the
# deterministic IP behind syllable/stress/rhyme for lyric completion.
#
# These are small pure-Python deps, but we keep them in a DEDICATED venv so they
# never collide with the service interpreter or the SA3 MLX venv. This creates
# service/phonology/.venv, installs pronouncing + cmudict (+ optional g2p-en for
# OOV words), validates the import, and writes service/phonology/.phonology.env
# (PHONOLOGY_PY) which run.sh sources.
#
# If the venv is absent the service degrades gracefully: /get_rhymes runs the core
# IN-PROCESS (precise when the service interpreter happens to have cmudict, else a
# stdlib vowel-group heuristic). Idempotent: re-running re-validates / tops up.
set -euo pipefail
cd "$(dirname "$0")"          # service/phonology/
HERE="$(pwd)"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

printf '— Mosh phonology setup (CMUdict + pronouncing + g2p) —\n'

# 1. Pick a Python (3.11/3.12 preferred for g2p-en wheels, else whatever resolves).
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
    uv venv --python "$PY" "$VENV" >/dev/null
  else
    "$PY" -m venv "$VENV"
  fi
fi

# 3. Install. pronouncing + cmudict are the core (the rhyme/stress dictionary).
#    g2p-en is the Bar-IQ OOV engine (slang/coined/NSFW words → real ARPAbet phonemes so
#    they RHYME, not just scan) — verified light (numpy/nltk/inflect, no TensorFlow).
#    `setuptools<81` is required (g2p-en's stack imports pkg_resources, removed in 81+, and
#    uv venvs omit it). A failed g2p-en install degrades to the stdlib heuristic.
say "installing pronouncing + cmudict …"
if command -v uv >/dev/null 2>&1; then
  VIRTUAL_ENV="$VENV" uv pip install --python "$PYBIN" --quiet pronouncing cmudict "setuptools<81" || fail "pip install failed"
  VIRTUAL_ENV="$VENV" uv pip install --python "$PYBIN" --quiet g2p-en >/dev/null 2>&1 \
    && say "g2p-en ✓ (OOV/slang words get real phonemes)" || say "g2p-en skipped (OOV uses the stdlib heuristic)"
else
  "$PYBIN" -m pip install --quiet --upgrade pip "setuptools<81"
  "$PYBIN" -m pip install --quiet pronouncing cmudict || fail "pip install failed"
  "$PYBIN" -m pip install --quiet g2p-en >/dev/null 2>&1 \
    && say "g2p-en ✓ (OOV/slang words get real phonemes)" || say "g2p-en skipped (OOV uses the stdlib heuristic)"
fi

# 3b. g2p-en needs nltk's POS-tagger data at RUNTIME (it tags words before g2p). Download
#     it into the venv's nltk_data now (best-effort: failure → g2p falls back to heuristic
#     per word). nltk 3.9 renamed the tagger, so fetch both names.
"$PYBIN" - <<'PY' >/dev/null 2>&1 || say "nltk data skipped (g2p OOV uses the stdlib heuristic)"
import importlib.util
if importlib.util.find_spec("nltk") is not None:
    import nltk
    for pkg in ("averaged_perceptron_tagger", "averaged_perceptron_tagger_eng", "cmudict"):
        try: nltk.download(pkg, quiet=True)
        except Exception: pass
PY

# 4. Sanity: the venv must import the core dictionary packages.
"$PYBIN" - <<'PY' || fail "the venv cannot import pronouncing/cmudict — install failed; inspect service/phonology/.venv"
import importlib.util, sys
ok = (importlib.util.find_spec("pronouncing") is not None
      and importlib.util.find_spec("cmudict") is not None)
sys.exit(0 if ok else 1)
PY
say "venv ✓ (pronouncing + cmudict importable)"

# 5. Persist the resolved interpreter for run.sh / the service.
ENVFILE="$HERE/.phonology.env"
cat > "$ENVFILE" <<EOF
# Written by service/phonology/setup-phonology.sh — sourced by run.sh. Safe to delete
# (the service falls back to in-process phonology: precise if cmudict is importable,
# else a stdlib heuristic).
export PHONOLOGY_PY="$PYBIN"
EOF
say "wrote $ENVFILE"

printf '\n✓ Phonology ready. Rhyme tool + precise syllable/stress online.\n'
