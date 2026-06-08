#!/usr/bin/env bash
# Dev launcher for the Mosh generative service (06 §5). Stdlib-only — no venv
# needed for the FakeAdapter. The StableAudio3Adapter (Stage 5) points at external
# deps via env vars (SA3_MLX_DIR, COLORRACK_DATA) and is launched the same way.
set -euo pipefail
cd "$(dirname "$0")"
exec python3 server.py "$@"
