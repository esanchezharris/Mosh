#!/usr/bin/env bash
# Dev launcher for the Mosh generative service (06 §5).
#
# Interpreter selection: when MOSH_ENABLE_SA3=1 and the SA3 MLX venv exists, run
# under $SA3_MLX_DIR/.venv/bin/python so the carved in-process SA3 engine can import
# mlx + the model code. Otherwise system python3 (FakeAdapter only — it is stdlib).
# FakeAdapter works under either interpreter, so the choice is invisible over HTTP.
#
# External deps stay external, pointed at by env vars (App. B):
#   SA3_MLX_DIR    — the MLX Stable-Audio-3 port (model + scripts)
#   COLORRACK_DATA — the built colour rack (service/colors/build_colorrack.py)
set -euo pipefail
cd "$(dirname "$0")"

# Persisted setup from setup-sa3.sh (resolved paths + MOSH_ENABLE_SA3). Optional —
# absent means the defaults below apply and SA3 stays off unless the venv happens to
# exist. Sourced first so its exports seed the ${:-default} fallbacks.
[[ -f .sa3.env ]] && source ./.sa3.env
# Audio->MIDI (Basic Pitch) lives in its own venv; .transcribe.env (written by
# transcribe/setup-transcribe.sh) exports BASIC_PITCH_PY. Absent → /transcribe
# degrades gracefully to 503 transcription_unavailable.
[[ -f transcribe/.transcribe.env ]] && source ./transcribe/.transcribe.env

export SA3_MLX_DIR="${SA3_MLX_DIR:-$HOME/AI/stable-audio-3/optimized/mlx}"
export COLORRACK_DATA="${COLORRACK_DATA:-$(pwd)/colors/COLORRACK_DATA}"

# SA3 is on by default; the carve runs under the MLX venv when present, else this
# silently falls back to system python3 (FakeAdapter only). Set MOSH_ENABLE_SA3=0
# to force FakeAdapter even when the venv exists.
PY="python3"
if [[ "${MOSH_ENABLE_SA3:-1}" == "1" && -x "$SA3_MLX_DIR/.venv/bin/python" ]]; then
  PY="$SA3_MLX_DIR/.venv/bin/python"
fi

exec "$PY" server.py "$@"
