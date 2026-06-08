#!/usr/bin/env bash
# Dev launcher for the Mosh generative service (macOS / Linux).
#
# Zero external dependencies — runs against any stdlib Python 3.11+.
# Usage:
#   ./run.sh                       # 127.0.0.1:8765
#   ./run.sh --port 9000           # custom port
#   ./run.sh --host 0.0.0.0 --port 9000
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec python3 "${SCRIPT_DIR}/server.py" "$@"
