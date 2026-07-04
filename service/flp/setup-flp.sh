#!/usr/bin/env bash
# One-command setup for FL Studio .flp import (PyFLP, MIT).
#
# .flp is a binary format; PyFLP (demberto/PyFLP, pure-Python) parses it. We keep
# it in a DEDICATED venv so its deps never collide with the service interpreter or
# the SA3/transcribe venvs. This script creates ~/Library/Mosh/venvs/flp (override
# the root with MOSH_VENVS_DIR), installs pyflp, validates the import, and writes
# service/flp/.flp.env (FLP_PY) which the importer frontend
# (ui/src/import/parseFlp.ts) reads to locate the interpreter.
#
# The venv deliberately lives OUTSIDE the repo tree: in-tree .venvs sat under
# iCloud-synced ~/Documents and iCloud silently evicted files from them (twice in two
# days), breaking product paths with no install-time error. The .env file stays the
# single source of truth for where the venv is.
#
# Unlike SA3/transcribe this is NOT used by the runtime service — only by the
# offline project-file importer CLI (`npm run import -- foo.flp`). If the venv is
# absent the importer degrades gracefully: .flp returns an empty IR that logs
# "FLP import unavailable (run service/flp/setup-flp.sh)".
#
# Idempotent + cheap to re-run: a healthy venv just re-validates (no installer runs);
# pass --reinstall to force the full install/top-up path.
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

REINSTALL=0
[[ "${1:-}" == "--reinstall" ]] && REINSTALL=1

# Venv location (outside iCloud — see the header note).
VENVS_ROOT="${MOSH_VENVS_DIR:-$HOME/Library/Mosh/venvs}"
VENV="$VENVS_ROOT/flp"
PYBIN="$VENV/bin/python"
LEGACY_VENV="$HERE/.venv"

# Sanity: Python <3.11 (the PyFLP enum bug is silent until parse) AND pyflp imports
# with the parse() entrypoint.
venv_ok() {
  [[ -x "$PYBIN" ]] || return 1
  "$PYBIN" - <<'PY'
import importlib.util, sys
if sys.version_info >= (3, 11):
    sys.exit(1)
if importlib.util.find_spec("pyflp") is None:
    sys.exit(1)
import pyflp  # noqa: F401
assert hasattr(pyflp, "parse")
sys.exit(0)
PY
}

if [[ "$REINSTALL" == "0" ]] && venv_ok >/dev/null 2>&1; then
  # Cheap path: the venv already validates — skip the installer entirely.
  say "venv ✓ (validated at $VENV — install skipped; --reinstall forces a top-up)"
else
  # 1. Create / reuse a Python-3.10 venv (see the version note above).
  if [[ ! -x "$PYBIN" ]]; then
    say "creating venv at $VENV (Python 3.10 — PyFLP needs <3.11) …"
    mkdir -p "$VENVS_ROOT"
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
    || fail "venv is Python $("$PYBIN" -c 'import sys;print("%d.%d"%sys.version_info[:2])') but PyFLP needs <3.11 — delete $VENV and re-run"

  # 2. Install pyflp (the only install step — pure Python, fast).
  say "installing pyflp …"
  if command -v uv >/dev/null 2>&1; then
    VIRTUAL_ENV="$VENV" uv pip install --python "$PYBIN" --quiet pyflp
  else
    "$PYBIN" -m pip install --quiet --upgrade pip
    "$PYBIN" -m pip install --quiet pyflp
  fi

  # 3. Validate the fresh install.
  venv_ok || fail "the venv cannot import pyflp — install failed; inspect $VENV"
  say "venv ✓ (pyflp importable)"
fi

# 4. Persist the resolved interpreter so the importer frontend finds it with no exports.
ENVFILE="$HERE/.flp.env"
cat > "$ENVFILE" <<EOF
# Written by service/flp/setup-flp.sh — read by ui/src/import/parseFlp.ts. Safe to
# delete (the importer falls back to an empty IR + "FLP import unavailable").
export FLP_PY="$PYBIN"
EOF
say "wrote $ENVFILE"

# 5. Drop a legacy in-tree venv once the new location validates — it was the
#    iCloud-corruption vector and only wastes sync bandwidth now.
if [[ -d "$LEGACY_VENV" && "$LEGACY_VENV" != "$VENV" ]]; then
  rm -rf "$LEGACY_VENV"
  say "removed legacy in-tree venv $LEGACY_VENV (superseded by $VENV)"
fi

printf '\n✓ FLP import ready. Run: cd ui && npm run import -- your-project.flp\n'
