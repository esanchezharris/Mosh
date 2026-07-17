#!/usr/bin/env bash
# One-command setup for the SingMOS-Pro singing-MOS naturalness metric (FMS-Bench).
#
# SingMOS-Pro is an SSL-based singing MOS predictor (CC-BY 4.0) — the singing-specific
# "sounds human" score in the benchmark's naturalness axis. Dedicated venv so torch/librosa
# never collide with the service interpreter or other feature venvs; lives OUTSIDE the repo
# tree (in-tree .venvs sat under iCloud and were silently evicted — the whisper/skeleton
# setup lesson). Writes .singmos.env (SINGMOS_PY) next to this script.
#
# Idempotent: a healthy venv re-validates without reinstalling; --reinstall forces a top-up.
# Absent this venv, bench_naturalness.singmos_score() degrades to None (never a crash).
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
printf '— Mosh SingMOS-Pro venv setup —\n'

VENV_ROOT="${MOSH_VENVS_DIR:-$HOME/Library/Mosh/venvs}"
VENV="$VENV_ROOT/singmos"
PY="$VENV/bin/python3"
REINSTALL=0
[[ "${1:-}" == "--reinstall" ]] && REINSTALL=1

need_install=1
if [[ -x "$PY" && "$REINSTALL" -eq 0 ]]; then
  if "$PY" - <<'PYEOF' 2>/dev/null
import torch, librosa  # noqa: F401
PYEOF
  then need_install=0; say "healthy venv at $VENV — revalidated, skipping install"; fi
fi

if [[ "$need_install" -eq 1 ]]; then
  say "creating venv at $VENV"
  mkdir -p "$VENV_ROOT"
  python3 -m venv "$VENV" || fail "python -m venv failed"
  "$PY" -m pip install -q --upgrade pip >/dev/null
  # torch + torchaudio drive the SSL front-end; librosa loads/rese amples audio; setuptools<81
  # keeps numba/pkg_resources import-clean on arm64 (the whisper lesson).
  "$PY" -m pip install -q torch torchaudio librosa "setuptools<81" || fail "pip install failed"
  "$PY" - <<'PYEOF' || fail "import validation failed after install"
import torch, librosa  # noqa: F401
print("  imports ok")
PYEOF
fi

# remove a stale in-tree venv if one exists (the iCloud-eviction lesson)
[[ -d ".venv" ]] && rm -rf .venv && say "removed legacy in-tree .venv"

printf 'SINGMOS_PY=%s\n' "$PY" > .singmos.env
say "wrote .singmos.env (SINGMOS_PY=$PY)"
say "smoke: \$SINGMOS_PY service/singmos/singmos_cli.py <wav>"
printf '✓ singmos venv ready\n'
