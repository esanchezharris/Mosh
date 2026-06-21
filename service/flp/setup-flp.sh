#!/usr/bin/env bash
# One-command setup for FL Studio .flp import (PyFLP, MIT).
#
# .flp is a binary format; PyFLP (demberto/PyFLP, pure-Python) parses it. We keep
# it in a DEDICATED venv so its deps never collide with the service interpreter or
# the SA3/transcribe venvs. This script creates service/flp/.venv, installs pyflp,
# validates the import, and writes service/flp/.flp.env (FLP_PY) which the importer
# frontend (ui/src/import/parseFlp.ts) reads to locate the interpreter.
#
# Unlike SA3/transcribe this is NOT used by the runtime service — only by the
# offline project-file importer CLI (`npm run import -- foo.flp`). If the venv is
# absent the importer degrades gracefully: .flp returns an empty IR that logs
# "FLP import unavailable (run service/flp/setup-flp.sh)".
#
# Idempotent: re-running re-validates and tops up the venv.
#
# IMPORTANT — Python version: PyFLP 2.2.1 (latest) relies on the pre-3.11 enum
# behaviour where `EventEnum(value)` cascades into subclass members. Python 3.11
# reworked enums and that lookup now raises "EventEnum has no members", so parsing
# FAILS on 3.11/3.12/3.13. We therefore pin the venv to Python 3.10. `uv` (preferred)
# auto-downloads a standalone 3.10; otherwise we look for a python3.10/3.9 on PATH.
set -euo pipefail
cd "$(dirname "$0")"          # service/flp/
HERE="$(pwd)"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

printf '— Mosh FLP-import setup (PyFLP) —\n'

VENV="$HERE/.venv"
PYBIN="$VENV/bin/python"

# 1. Create / reuse a Python-3.10 venv (see the version note above).
if [[ ! -x "$PYBIN" ]]; then
  say "creating venv at $VENV (Python 3.10 — PyFLP needs <3.11) …"
  if command -v uv >/dev/null 2>&1; then
    uv venv --python 3.10 "$VENV" >/dev/null   # uv fetches a standalone 3.10 if absent
  else
    PY=""
    for cand in python3.10 python3.9; do
      if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
    done
    [[ -n "$PY" ]] || fail "need uv (preferred) or a python3.10/3.9 on PATH — PyFLP 2.2.1 breaks on Python ≥3.11"
    "$PY" -m venv "$VENV"
  fi
fi
# Hard-stop if somehow on ≥3.11 (e.g. a stale venv) — the enum bug is silent until parse.
"$PYBIN" -c 'import sys; sys.exit(0 if sys.version_info < (3,11) else 1)' \
  || fail "venv is Python $("$PYBIN" -c 'import sys;print("%d.%d"%sys.version_info[:2])') but PyFLP needs <3.11 — delete service/flp/.venv and re-run"

# 3. Install pyflp (the only install step — pure Python, fast).
say "installing pyflp …"
if command -v uv >/dev/null 2>&1; then
  VIRTUAL_ENV="$VENV" uv pip install --python "$PYBIN" --quiet pyflp
else
  "$PYBIN" -m pip install --quiet --upgrade pip
  "$PYBIN" -m pip install --quiet pyflp
fi

# 4. Sanity: the venv must import pyflp and expose parse().
"$PYBIN" - <<'PY' || fail "the venv cannot import pyflp — install failed; inspect service/flp/.venv"
import importlib.util, sys
if importlib.util.find_spec("pyflp") is None:
    sys.exit(1)
import pyflp  # noqa: F401
assert hasattr(pyflp, "parse")
sys.exit(0)
PY
say "venv ✓ (pyflp importable)"

# 5. Persist the resolved interpreter so the importer frontend finds it with no exports.
ENVFILE="$HERE/.flp.env"
cat > "$ENVFILE" <<EOF
# Written by service/flp/setup-flp.sh — read by ui/src/import/parseFlp.ts. Safe to
# delete (the importer falls back to an empty IR + "FLP import unavailable").
export FLP_PY="$PYBIN"
EOF
say "wrote $ENVFILE"

printf '\n✓ FLP import ready. Run: cd ui && npm run import -- your-project.flp\n'
