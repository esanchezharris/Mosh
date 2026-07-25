#!/usr/bin/env bash
# One-command setup for the FMS lyrics-bench ingestion venv (I1).
#
# The bench CORE (segment/mask/metrics/runner + all *_test.py) is stdlib-only and
# runs under system python3 — this venv exists ONLY for the heavy ingestion deps
# (HF `datasets` for the Genius pull; later increments add sentence-transformers /
# mlx-lm here). The venv lives OUTSIDE the repo tree (iCloud eviction precedent);
# service/lyrics/bench/.lyrics-bench.env (LYRICS_BENCH_PY) is the single source of
# truth for where it is.
#
# Idempotent: a healthy venv just re-validates; --reinstall forces the installer.
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd)"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

printf '— Mosh lyrics-bench setup (HF ingestion deps) —\n'

REINSTALL=0
[[ "${1:-}" == "--reinstall" ]] && REINSTALL=1

VENVS_ROOT="${MOSH_VENVS_DIR:-$HOME/Library/Mosh/venvs}"
VENV="$VENVS_ROOT/lyrics-bench"
PYBIN="$VENV/bin/python"

venv_ok() {
  [[ -x "$PYBIN" ]] || return 1
  "$PYBIN" - <<'PY'
import importlib.util, sys
ok = all(importlib.util.find_spec(m) is not None for m in ("datasets", "huggingface_hub"))
sys.exit(0 if ok else 1)
PY
}

if [[ "$REINSTALL" == "0" ]] && venv_ok >/dev/null 2>&1; then
  say "venv ✓ (validated at $VENV — install skipped; --reinstall forces a top-up)"
else
  PY=""
  for cand in python3.12 python3.11 python3; do
    if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
  done
  [[ -n "$PY" ]] || fail "no python3 found on PATH"
  mkdir -p "$VENVS_ROOT"
  [[ -x "$PYBIN" ]] || "$PY" -m venv "$VENV"
  if command -v uv >/dev/null 2>&1; then
    uv pip install --python "$PYBIN" -q "datasets>=2.19" "huggingface_hub" "pyarrow"
  else
    "$PYBIN" -m pip install -q --upgrade pip
    "$PYBIN" -m pip install -q "datasets>=2.19" "huggingface_hub" "pyarrow"
  fi
  venv_ok || fail "venv failed to validate after install"
  say "venv ✓ installed at $VENV"
fi

cat > "$HERE/.lyrics-bench.env" <<EOF
# Written by setup-lyrics-bench.sh — single source of truth for the bench venv.
export LYRICS_BENCH_PY="$PYBIN"
EOF
say ".lyrics-bench.env ✓ (LYRICS_BENCH_PY=$PYBIN)"
say "done."
