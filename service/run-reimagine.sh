#!/usr/bin/env bash
# Narrow owner-local launcher for the Ableton/Mosh shared Re-Imagine helper.
# It intentionally sources only the non-secret SA3 pointer and the owner release
# policy. In particular it never reads ~/.config/mosh/env or feature dotenvs.
set -euo pipefail
cd "$(dirname "$0")"

export PYTHONDONTWRITEBYTECODE="${PYTHONDONTWRITEBYTECODE:-1}"
[[ -f .sa3.env ]] && source ./.sa3.env
[[ -f "$HOME/.config/mosh/owner-sa3.env" ]] && source "$HOME/.config/mosh/owner-sa3.env"

export SA3_MLX_DIR="${SA3_MLX_DIR:-$HOME/AI/stable-audio-3/optimized/mlx}"
export COLORRACK_DATA="${COLORRACK_DATA:-$(pwd)/colors/COLORRACK_DATA}"
export MOSH_LORA_DIR="${MOSH_LORA_DIR:-$HOME/Library/Mosh/loras}"
export MOSH_SERVICE_LOG="${MOSH_SERVICE_LOG:-$HOME/Library/Mosh/logs/reimagine-service.log}"
mkdir -p "$(dirname "$MOSH_SERVICE_LOG")"
exec >> "$MOSH_SERVICE_LOG" 2>&1

PY="${MOSH_SERVICE_PYTHON:-python3}"
if [[ -z "${MOSH_SERVICE_PYTHON:-}" && "${MOSH_ENABLE_SA3:-1}" == "1" && -x "$SA3_MLX_DIR/.venv/bin/python" ]]; then
  PY="$SA3_MLX_DIR/.venv/bin/python"
fi
exec "$PY" server.py "$@"
